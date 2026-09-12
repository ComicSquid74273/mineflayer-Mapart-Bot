'use strict'

const { repairWindowItemsPacket } = require('./window-items-compat')

// Velocity can return a connected client from PLAY to CONFIGURATION while it
// switches backend servers. Mineflayer currently keeps its physics loop alive
// during that transition, which can send PLAY-only packets to Velocity and make
// the proxy close the connection with its generic "internal error" message.
//
// These are the packets a 26.1.2 client is allowed to send while negotiating the
// CONFIGURATION state, plus configuration_acknowledged, which is sent from PLAY
// immediately before minecraft-protocol changes its local state.
const CONFIGURATION_PACKET_ALLOWLIST = new Set([
  'configuration_acknowledged',
  'settings',
  'cookie_response',
  'custom_payload',
  'finish_configuration',
  'keep_alive',
  'pong',
  'resource_pack_receive',
  'select_known_packs',
  'custom_click_action',
  'accept_code_of_conduct'
])

function readPacketId (buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  let value = 0
  let shift = 0
  for (let index = 0; index < Math.min(buffer.length, 5); index += 1) {
    const byte = buffer[index]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return value >>> 0
    shift += 7
  }
  return null
}

function installPostTransferParseGuard (client, state, logger) {
  const wrappedParsers = new Map()

  const wrapCurrentDeserializer = () => {
    const parser = client.deserializer
    if (!parser || typeof parser.parsePacketBuffer !== 'function' || wrappedParsers.has(parser)) return

    const originalParsePacketBuffer = parser.parsePacketBuffer.bind(parser)
    const guardedParsePacketBuffer = (buffer) => {
      const packetId = readPacketId(buffer)
      const tryInventoryRepair = () => {
        if (packetId !== 0x12) return null
        const repaired = repairWindowItemsPacket(parser, buffer)
        if (!repaired) return null
        const elapsedMs = state.lastPlayResumeAt > 0
          ? Math.max(0, Date.now() - state.lastPlayResumeAt)
          : null
        logger(
          `[PROTOCOL-COMPAT] Repaired window_items with ${repaired.stats.containerComponents} ` +
          `container component(s) and ${repaired.stats.embeddedItems} embedded item(s)` +
          `${elapsedMs == null ? '' : ` ${elapsedMs}ms after PLAY resume`}; continuing the same connection.`
        )
        return repaired.packet
      }

      try {
        const parsed = originalParsePacketBuffer(buffer)
        if (packetId === 0x12 && parsed?.metadata?.size !== buffer?.length) {
          return tryInventoryRepair() || parsed
        }
        return parsed
      } catch (error) {
        if (packetId === 0x12) {
          try {
            const repaired = tryInventoryRepair()
            if (repaired) return repaired
          } catch (repairError) {
            error.nervRepairError = repairError?.message || String(repairError)
          }
        }

        if (error && !error.buffer && Buffer.isBuffer(buffer)) error.buffer = Buffer.from(buffer)
        if (error && error.nervPacketId == null) error.nervPacketId = packetId
        throw error
      }
    }

    parser.parsePacketBuffer = guardedParsePacketBuffer
    wrappedParsers.set(parser, originalParsePacketBuffer)
  }

  client.on('state', wrapCurrentDeserializer)
  wrapCurrentDeserializer()

  return () => {
    client.removeListener('state', wrapCurrentDeserializer)
    for (const [parser, originalParsePacketBuffer] of wrappedParsers) {
      if (parser.parsePacketBuffer !== originalParsePacketBuffer) {
        parser.parsePacketBuffer = originalParsePacketBuffer
      }
    }
    wrappedParsers.clear()
  }
}

function stopBotMovement (bot) {
  try { bot.pathfinder?.stop?.() } catch { }
  try { bot.pathfinder?.setGoal(null) } catch { }
  try {
    if (typeof bot.clearControlStates === 'function') {
      bot.clearControlStates()
      return
    }
  } catch { }
  for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
    try { bot.setControlState?.(control, false) } catch { }
  }
}

/**
 * Velocity can release the destination PLAY position before the backend has
 * finished attaching the player to its worker. Keep machine navigation idle
 * through that short handoff window so the first interaction is sent only
 * after the destination world has remained authoritative on this connection.
 */
async function waitForConfigurationTransferWorldSettle (bot, options = {}) {
  const settleMs = Math.max(0, Number(options.settleMs) || 0)
  if (settleMs <= 0) return { waitedMs: 0, resumedAt: null }
  const pollMs = Math.max(20, Number(options.pollMs) || 100)
  const wait = typeof options.wait === 'function'
    ? options.wait
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const now = typeof options.now === 'function' ? options.now : Date.now
  const assertContinue = typeof options.assertContinue === 'function' ? options.assertContinue : null
  const onWait = typeof options.onWait === 'function' ? options.onWait : null
  let waitedMs = 0
  let waitReported = false

  while (true) {
    assertContinue?.()
    const active = bot?.__nervConfigurationTransferActive === true
    const resumedAt = Number(bot?.__nervConfigurationTransferPlayResumedAt)
    const remainingMs = active
      ? pollMs
      : (Number.isFinite(resumedAt) && resumedAt > 0
          ? Math.max(0, settleMs - Math.max(0, now() - resumedAt))
          : 0)
    if (!active && remainingMs <= 0) {
      return {
        waitedMs,
        resumedAt: Number.isFinite(resumedAt) && resumedAt > 0 ? resumedAt : null
      }
    }
    if (!waitReported) {
      waitReported = true
      onWait?.({ active, remainingMs })
    }
    const stepMs = active ? pollMs : Math.min(pollMs, remainingMs)
    await wait(stepMs)
    waitedMs += stepMs
  }
}

function installConfigurationTransferGuard (bot, options = {}) {
  const client = bot?._client
  if (!client || typeof client.on !== 'function' || typeof client.write !== 'function') return null
  if (client.__nervConfigurationTransferGuard) return client.__nervConfigurationTransferGuard

  const logger = typeof options.logger === 'function' ? options.logger : () => {}
  const state = {
    active: false,
    finishSeen: false,
    blockedPackets: 0,
    blockedNames: new Set(),
    previousPhysicsEnabled: true,
    transferTarget: null,
    lastPlayResumeAt: 0
  }
  const originalWrite = client.write.bind(client)
  const cleanupPostTransferParseGuard = installPostTransferParseGuard(
    client,
    state,
    logger
  )

  const guardedWrite = (packetName, packet) => {
    const name = String(packetName || '')
    if (state.active && !CONFIGURATION_PACKET_ALLOWLIST.has(name)) {
      state.blockedPackets += 1
      state.blockedNames.add(name || 'unknown')
      return undefined
    }
    return originalWrite(packetName, packet)
  }

  const beginConfiguration = () => {
    if (!state.active) {
      state.previousPhysicsEnabled = bot.physicsEnabled !== false
      state.blockedPackets = 0
      state.blockedNames.clear()
      const previousGeneration = Number(bot.__nervRuntimeWorldGeneration)
      bot.__nervRuntimeWorldGeneration = Number.isFinite(previousGeneration)
        ? Math.max(0, Math.floor(previousGeneration)) + 1
        : 1
      const previousAbortGeneration = Number(bot.__nervPathfinderAbortGeneration)
      bot.__nervPathfinderAbortGeneration = Number.isFinite(previousAbortGeneration)
        ? Math.max(0, Math.floor(previousAbortGeneration)) + 1
        : 1
      bot.__nervRuntimeWorldChangePending = true
      bot.__nervRuntimeWorldChangePendingAt = Date.now()
    }
    state.active = true
    state.finishSeen = false
    bot.__nervConfigurationTransferActive = true
    bot.physicsEnabled = false
    stopBotMovement(bot)
    logger('[CONFIG-TRANSFER] Velocity entered configuration; paused physics and guarded play packets.')
  }

  const finishConfiguration = () => {
    if (!state.active) return
    state.finishSeen = true
    logger('[CONFIG-TRANSFER] Configuration negotiation finished; waiting for the destination position packet.')
  }

  const resumePlay = () => {
    if (!state.active) return
    const blockedNames = [...state.blockedNames].sort().join(',') || 'none'
    state.active = false
    state.finishSeen = false
    state.lastPlayResumeAt = Date.now()
    bot.__nervConfigurationTransferActive = false
    bot.__nervConfigurationTransferPlayResumedAt = state.lastPlayResumeAt
    bot.physicsEnabled = state.previousPhysicsEnabled
    logger(`[CONFIG-TRANSFER] Destination play resumed; blockedPackets=${state.blockedPackets} names=${blockedNames}.`)
  }

  const onPacket = (_packet, metadata = {}) => {
    const name = String(metadata.name || '')
    if (name === 'start_configuration') {
      beginConfiguration()
      return
    }
    if (!state.active) {
      if (name === 'transfer') {
        // The named transfer event records the packet payload below.
        logger('[CONFIG-TRANSFER] Server sent a transfer packet; waiting for reconnect handling.')
      }
      return
    }
    if (name === 'finish_configuration') {
      finishConfiguration()
      return
    }
    if (name === 'position' && String(metadata.state || client.state || '').toLowerCase() === 'play') {
      // Release before Mineflayer handles this packet so its required position
      // acknowledgement is allowed through to the destination server.
      resumePlay()
    }
  }

  const onTransfer = (packet = {}) => {
    const host = String(packet.host || '').trim()
    const port = Number(packet.port)
    state.transferTarget = host && Number.isInteger(port) && port > 0 && port <= 65535
      ? { host, port }
      : null
    bot.__nervServerTransferTarget = state.transferTarget
    if (state.transferTarget) {
      logger(`[CONFIG-TRANSFER] Server requested reconnect to ${state.transferTarget.host}:${state.transferTarget.port}.`)
    }
  }

  const cleanup = () => {
    client.removeListener('packet', onPacket)
    client.removeListener('transfer', onTransfer)
    cleanupPostTransferParseGuard()
    if (client.write === guardedWrite) client.write = originalWrite
    delete client.__nervConfigurationTransferGuard
  }

  client.write = guardedWrite
  client.on('packet', onPacket)
  client.on('transfer', onTransfer)
  bot.once?.('end', cleanup)

  const guard = { state, cleanup }
  client.__nervConfigurationTransferGuard = guard
  return guard
}

module.exports = {
  CONFIGURATION_PACKET_ALLOWLIST,
  installConfigurationTransferGuard,
  waitForConfigurationTransferWorldSettle
}
