'use strict'

const { Vec3 } = require('vec3')

const BLOCK_FACE_DIRECTIONS = [
  new Vec3(0, -1, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0)
]

const FACE_SAMPLE_OFFSETS = [0.5, 0.25, 0.75]
const HORIZONTAL_INTERACTION_BLOCKS = new Set([
  'barrel',
  'chest',
  'trapped_chest',
  'cartography_table',
  'anvil',
  'chipped_anvil',
  'damaged_anvil'
])

function getFaceSampleCursor(face, first, second) {
  if (face === 0) return new Vec3(first, 0.001, second)
  if (face === 1) return new Vec3(first, 0.999, second)
  if (face === 2) return new Vec3(first, second, 0.001)
  if (face === 3) return new Vec3(first, second, 0.999)
  if (face === 4) return new Vec3(0.001, first, second)
  return new Vec3(0.999, first, second)
}

function isFaceNeighbourOpen(bot, blockPosition, face) {
  if (typeof bot?.blockAt !== 'function') return true
  try {
    const neighbour = bot.blockAt(blockPosition.plus(BLOCK_FACE_DIRECTIONS[face]))
    return !neighbour || neighbour.boundingBox === 'empty'
  } catch {
    return true
  }
}

function getReferenceBlockInteraction(bot, block) {
  const entityPosition = bot?.entity?.position
  const blockPosition = block?.position
  if (!entityPosition?.offset || !blockPosition?.offset) return null

  const eyeHeight = Number(bot?.entity?.eyeHeight)
  const eye = entityPosition.offset(0, Number.isFinite(eyeHeight) ? eyeHeight : 1.62, 0)
  let bestFace = 1
  let bestDistance = Number.POSITIVE_INFINITY

  // Nerv's reference client chooses the face whose neighbouring block centre
  // is closest to the player's eyes. This remains valid when the target's own
  // centre is behind the lip of a floor block, which is common at the compact
  // stock and cartography stations.
  for (let face = 0; face < BLOCK_FACE_DIRECTIONS.length; face += 1) {
    const neighbourCenter = blockPosition.plus(BLOCK_FACE_DIRECTIONS[face]).offset(0.5, 0.5, 0.5)
    const distance = eye.distanceTo(neighbourCenter)
    if (distance < bestDistance) {
      bestDistance = distance
      bestFace = face
    }
  }

  return {
    face: bestFace,
    direction: BLOCK_FACE_DIRECTIONS[bestFace],
    // Keep the reference addon's nearest-face selection, but encode a hit on
    // that face. The protocol cursor is block-relative: pairing UP with y=.5
    // claims a point inside the block. Compact-station validation rejects that
    // contradictory hit even though the same face with y=.999 is accepted.
    cursorPos: getFaceSampleCursor(bestFace, 0.5, 0.5)
  }
}

function getVisibleBlockInteraction(bot, block) {
  const entityPosition = bot?.entity?.position
  const blockPosition = block?.position
  if (!entityPosition?.offset || !blockPosition?.plus || !bot?.world?.raycast) {
    return getReferenceBlockInteraction(bot, block)
  }

  const eyeHeight = Number(bot?.entity?.eyeHeight)
  const eye = entityPosition.offset(0, Number.isFinite(eyeHeight) ? eyeHeight : 1.62, 0)
  const candidates = []
  for (let face = 0; face < BLOCK_FACE_DIRECTIONS.length; face += 1) {
    for (const first of FACE_SAMPLE_OFFSETS) {
      for (const second of FACE_SAMPLE_OFFSETS) {
        const cursorPos = getFaceSampleCursor(face, first, second)
        const aimPos = blockPosition.plus(cursorPos)
        candidates.push({
          face,
          cursorPos,
          aimPos,
          exposed: isFaceNeighbourOpen(bot, blockPosition, face),
          distance: eye.distanceTo(aimPos)
        })
      }
    }
  }
  const preferHorizontal = HORIZONTAL_INTERACTION_BLOCKS.has(String(block?.name || '').replace(/^minecraft:/, ''))
  candidates.sort((a, b) => (
    Number(b.exposed) - Number(a.exposed) ||
    (preferHorizontal ? Number(a.face < 2) - Number(b.face < 2) : 0) ||
    a.distance - b.distance
  ))

  for (const candidate of candidates) {
    const delta = candidate.aimPos.minus(eye)
    const range = delta.norm()
    if (!Number.isFinite(range) || range <= 0) continue
    const hit = bot.world.raycast(eye, delta.normalize(), range + 0.15)
    if (!hit?.position?.equals?.(blockPosition)) continue

    const face = candidate.face
    // Use the exact cursor that passed the ray test. Returning the centre of
    // the same face can put the actual packet behind a compact-station lip even
    // though a sampled point on that face was visible.
    const cursorPos = candidate.cursorPos
    return {
      face,
      direction: BLOCK_FACE_DIRECTIONS[face],
      cursorPos,
      aimPos: candidate.aimPos,
      visible: true
    }
  }

  const fallback = getReferenceBlockInteraction(bot, block)
  if (!fallback) return null
  return {
    ...fallback,
    aimPos: blockPosition.plus(fallback.cursorPos),
    visible: false
  }
}

function vectorToDirection(direction) {
  if (direction.y < 0) return 0
  if (direction.y > 0) return 1
  if (direction.z < 0) return 2
  if (direction.z > 0) return 3
  if (direction.x < 0) return 4
  if (direction.x > 0) return 5
  throw new Error(`Invalid block interaction direction ${direction}`)
}

function writeBlockInteractionPacket(bot, block, direction, cursorPos) {
  const directionNum = vectorToDirection(direction)
  if (bot.supportFeature?.('blockPlaceHasHeldItem')) {
    const Item = require('prismarine-item')(bot.registry)
    bot._client.write('block_place', {
      location: block.position,
      direction: directionNum,
      heldItem: Item.toNotch(bot.heldItem),
      cursorX: cursorPos.scaled(16).x,
      cursorY: cursorPos.scaled(16).y,
      cursorZ: cursorPos.scaled(16).z
    })
    return true
  }
  if (bot.supportFeature?.('blockPlaceHasHandAndIntCursor')) {
    bot._client.write('block_place', {
      location: block.position,
      direction: directionNum,
      hand: 0,
      cursorX: cursorPos.scaled(16).x,
      cursorY: cursorPos.scaled(16).y,
      cursorZ: cursorPos.scaled(16).z
    })
    return true
  }
  if (bot.supportFeature?.('blockPlaceHasHandAndFloatCursor')) {
    bot._client.write('block_place', {
      location: block.position,
      direction: directionNum,
      hand: 0,
      cursorX: cursorPos.x,
      cursorY: cursorPos.y,
      cursorZ: cursorPos.z
    })
    return true
  }
  if (bot.supportFeature?.('blockPlaceHasInsideBlock')) {
    bot._client.write('block_place', {
      location: block.position,
      direction: directionNum,
      hand: 0,
      cursorX: cursorPos.x,
      cursorY: cursorPos.y,
      cursorZ: cursorPos.z,
      insideBlock: false,
      sequence: 0,
      worldBorderHit: false
    })
    return true
  }
  return false
}

function sendSneakRelease(bot) {
  if (!bot?._client || !bot?.entity) return
  try {
    if (bot.getControlState?.('sneak') === true) {
      bot.setControlState('sneak', false)
    }
  } catch { }

  // setControlState(false) only updates Mineflayer's local transition state.
  // Always follow it with one explicit release packet before block use. This
  // keeps a stale server-side crouch from turning a chest/table interaction
  // into held-item use when the bot arrived while sneaking over carpet.
  if (bot.supportFeature?.('newPlayerInputPacket')) {
    bot._client.write('player_input', { inputs: { shift: false } })
  } else {
    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: bot.supportFeature?.('entityActionUsesStringMapper') ? 'stop_sneaking' : 1,
      jumpBoost: 0
    })
  }
}

function installBlockInteractionGuard(bot) {
  const client = bot?._client
  if (!client || typeof client.write !== 'function' || typeof bot?.activateBlock !== 'function') return null
  if (bot.__nervBlockInteractionGuard) return bot.__nervBlockInteractionGuard

  const state = {
    // Match the reference addon's fresh-session interaction high-water mark.
    nextSequence: 2,
    sentInteractions: 0,
    lastSequence: null
  }
  const previousWrite = client.write.bind(client)
  const sequencedWrite = (packetName, packet = {}) => {
    const name = String(packetName || '')
    if ((name === 'block_place' || name === 'use_item') && Number.isFinite(Number(packet.sequence))) {
      const supplied = Math.max(0, Math.trunc(Number(packet.sequence)))
      const sequence = Math.max(state.nextSequence, supplied)
      state.nextSequence = sequence + 1
      state.sentInteractions += 1
      state.lastSequence = sequence
      return previousWrite(packetName, { ...packet, sequence })
    }
    return previousWrite(packetName, packet)
  }
  client.write = sequencedWrite

  const previousActivateBlock = bot.activateBlock.bind(bot)
  const activateBlock = async (block, direction, cursorPos) => {
    sendSneakRelease(bot)
    // Prefer a ray-confirmed exposed face and fall back to the reference
    // addon's nearest-face choice. In both cases the cursor lies on that face.
    const resolved = getVisibleBlockInteraction(bot, block)
    const resolvedDirection = direction ?? resolved?.direction
    const resolvedCursor = cursorPos ?? resolved?.cursorPos
    if (!resolvedDirection || !resolvedCursor) {
      return await previousActivateBlock(block, direction, cursorPos)
    }

    const aimPos = block.position.plus(resolvedCursor)
    await bot.lookAt(aimPos, false)
    state.lastFace = vectorToDirection(resolvedDirection)
    state.lastCursor = resolvedCursor
    state.lastAim = aimPos
    state.lastVisible = resolved?.visible === true
    if (!writeBlockInteractionPacket(bot, block, resolvedDirection, resolvedCursor)) {
      return await previousActivateBlock(block, resolvedDirection, resolvedCursor)
    }
    bot.swingArm?.()
  }
  activateBlock.__nervBlockInteractionWrapped = true
  bot.activateBlock = activateBlock

  const guard = { state, previousWrite, previousActivateBlock }
  bot.__nervBlockInteractionGuard = guard
  return guard
}

module.exports = {
  BLOCK_FACE_DIRECTIONS,
  getReferenceBlockInteraction,
  getVisibleBlockInteraction,
  installBlockInteractionGuard,
  sendSneakRelease,
  writeBlockInteractionPacket
}
