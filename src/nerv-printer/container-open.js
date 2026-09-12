'use strict'

const {
  getReferenceBlockInteraction,
  getVisibleBlockInteraction
} = require('./block-interaction')

const CONTAINER_PROTOCOL_READ_ERROR_CODE = 'CONTAINER_PROTOCOL_READ_ERROR'
const CONTAINER_OPEN_TIMEOUT_CODE = 'CONTAINER_OPEN_TIMEOUT'

const CONTAINER_WINDOW_PREFIXES = [
  'minecraft:generic',
  'minecraft:chest',
  'minecraft:dispenser',
  'minecraft:ender_chest',
  'minecraft:shulker_box',
  'minecraft:hopper',
  'minecraft:container',
  'minecraft:dropper',
  'minecraft:trapped_chest',
  'minecraft:barrel'
]

function isContainerBlockName(name) {
  const normalized = String(name || '').replace(/^minecraft:/, '')
  return normalized === 'chest' ||
    normalized === 'trapped_chest' ||
    normalized === 'barrel' ||
    normalized === 'hopper' ||
    normalized === 'dispenser' ||
    normalized === 'dropper' ||
    normalized.endsWith('shulker_box')
}

function assertLoadedBlockTarget(block, position, expectedNames = []) {
  if (!block) return null
  const name = String(block.name || '').replace(/^minecraft:/, '')
  const expected = Array.isArray(expectedNames)
    ? expectedNames.map((entry) => String(entry || '').replace(/^minecraft:/, '')).filter(Boolean)
    : []
  if (expected.includes(name)) return block

  const coordinates = position
    ? `${position.x},${position.y},${position.z}`
    : `${block.position?.x ?? '?'},${block.position?.y ?? '?'},${block.position?.z ?? '?'}`
  const error = new Error(
    `configured-block-missing position=${coordinates} ` +
    `expected=${expected.join('|') || 'configured-block'} found=${name || 'unknown'}`
  )
  error.code = 'CONFIGURED_BLOCK_MISSING'
  throw error
}

/**
 * Reject a loaded station coordinate that is already known not to contain a
 * container. A null block is inconclusive because its chunk may be unloaded.
 */
function assertLoadedContainerTarget(block, position, expectedNames = []) {
  if (!block) return null
  const name = String(block.name || '').replace(/^minecraft:/, '')
  const expected = Array.isArray(expectedNames)
    ? expectedNames.map((entry) => String(entry || '').replace(/^minecraft:/, '')).filter(Boolean)
    : []
  const matches = expected.length > 0 ? expected.includes(name) : isContainerBlockName(name)
  if (matches) return block

  const coordinates = position
    ? `${position.x},${position.y},${position.z}`
    : `${block.position?.x ?? '?'},${block.position?.y ?? '?'},${block.position?.z ?? '?'}`
  const error = new Error(
    `configured-container-missing position=${coordinates} ` +
    `expected=${expected.length > 0 ? expected.join('|') : 'container'} found=${name || 'unknown'}`
  )
  error.code = 'CONFIGURED_CONTAINER_MISSING'
  throw error
}

function isContainerProtocolReadError(error) {
  if (!error) return false
  if (error.code === CONTAINER_PROTOCOL_READ_ERROR_CODE ||
    error.isContainerProtocolReadError === true ||
    error.partialReadError === true) {
    return true
  }

  const text = [
    error.name,
    error.constructor?.name,
    error.message,
    error.field,
    error.stack
  ].filter(Boolean).join(' ').toLowerCase()

  if (text.includes('partialreaderror')) return true
  const slotDecodeContext = text.includes('slotcomponent') ||
    text.includes('slot_component') ||
    text.includes('anonymousnbt') ||
    text.includes('container_set_content') ||
    text.includes('window_items')
  const malformedPayload = text.includes('missing characters in string') ||
    text.includes('partial read') ||
    text.includes('unexpected end of buffer')
  return slotDecodeContext && malformedPayload
}

/**
 * Strict machine access normally permits the loaded-floor planner to stop at
 * a safe block-reach cell when the captured standing point is separated by a
 * trench. Callers that know the captured point itself is the authoritative
 * station checkpoint can opt out and require that exact approach instead.
 */
function shouldAllowContainerBlockReach(options = {}) {
  return options.strictAccess === true && options.allowBlockReach !== false
}

/**
 * Every support chest may be approached from a verified supported cell. Food
 * and XP are separately capped to a tight interaction radius so the planner
 * cannot choose the distant platform-edge positions that caused live falls.
 */
function shouldAllowSupportStockBlockReach(stockRole) {
  const role = String(stockRole || '').trim().toLowerCase()
  return role === 'map' || role === 'pane' || role === 'food' || role === 'xp'
}

function getSupportStockBlockReachLimit(stockRole) {
  const role = String(stockRole || '').trim().toLowerCase()
  return role === 'food' || role === 'xp' ? 2.25 : null
}

function toContainerProtocolReadError(error) {
  if (error?.code === CONTAINER_PROTOCOL_READ_ERROR_CODE) return error
  const detail = error?.message || String(error || 'unknown protocol read failure')
  const wrapped = new Error(`container-protocol-read-error: ${detail}`)
  wrapped.code = CONTAINER_PROTOCOL_READ_ERROR_CODE
  wrapped.isContainerProtocolReadError = true
  wrapped.cause = error
  return wrapped
}

function isContainerWindow(window) {
  const type = String(window?.type || '')
  return CONTAINER_WINDOW_PREFIXES.some((prefix) => type.startsWith(prefix))
}

/**
 * Opens a block container without Mineflayer's internal 20-second windowOpen
 * listener. The caller owns the shorter timeout, and a malformed slot/NBT
 * packet rejects the attempt as soon as minecraft-protocol reports it.
 */
function openBlockContainerFast(bot, block, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 2500)

  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
      bot?.removeListener?.('windowOpen', onWindowOpen)
      bot?.removeListener?.('error', onBotError)
      bot?.removeListener?.('end', onBotEnd)
    }
    const finishResolve = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const finishReject = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onWindowOpen = (window) => {
      if (!isContainerWindow(window)) {
        const error = new Error(`Non-container window used as a container: ${window?.type || 'unknown'}`)
        error.code = 'NON_CONTAINER_WINDOW'
        finishReject(error)
        return
      }
      finishResolve(window)
    }
    const onBotError = (error) => {
      if (isContainerProtocolReadError(error)) {
        finishReject(toContainerProtocolReadError(error))
      }
    }
    const onBotEnd = (reason) => {
      const error = new Error(`container-open-session-ended: ${reason || 'disconnected'}`)
      error.code = 'CONTAINER_OPEN_SESSION_ENDED'
      finishReject(error)
    }

    bot?.on?.('windowOpen', onWindowOpen)
    bot?.on?.('error', onBotError)
    bot?.on?.('end', onBotEnd)
    timer = setTimeout(() => {
      const error = new Error(`open-container-timeout-${timeoutMs}ms`)
      error.code = CONTAINER_OPEN_TIMEOUT_CODE
      finishReject(error)
    }, timeoutMs)

    try {
      const interaction = getVisibleBlockInteraction(bot, block)
      Promise.resolve(bot.activateBlock(block, interaction?.direction, interaction?.cursorPos)).catch(finishReject)
    } catch (error) {
      finishReject(error)
    }
  })
}

module.exports = {
  CONTAINER_PROTOCOL_READ_ERROR_CODE,
  CONTAINER_OPEN_TIMEOUT_CODE,
  assertLoadedBlockTarget,
  assertLoadedContainerTarget,
  getSupportStockBlockReachLimit,
  isContainerProtocolReadError,
  isContainerBlockName,
  shouldAllowContainerBlockReach,
  shouldAllowSupportStockBlockReach,
  getReferenceBlockInteraction,
  getVisibleBlockInteraction,
  openBlockContainerFast
}
