'use strict'

const { redactLogText } = require('./log-redaction')

function installMovementDiagnostics(bot, options = {}) {
  if (!bot || bot.__nervMovementDiagnosticsInstalled) return
  bot.__nervMovementDiagnosticsInstalled = true

  const logIntervalMs = Math.max(1000, Number(options.logIntervalMs) || 5000)
  const stallThresholdMs = Math.max(1000, Number(options.stallThresholdMs) || 3000)
  const username = String(bot.username || options.botName || 'bot')

  let lastX = null
  let lastZ = null
  let windowStartX = null
  let windowStartZ = null
  let windowStartY = null
  let windowStartTime = Date.now()
  let windowDistanceXZ = 0
  let yTransitions = 0
  let lastGroundedY = null

  let movementIntentActive = false
  let stallStartTime = null
  let stallLogged = false
  let lastStallLogTime = 0

  function getActiveController() {
    if (bot.__nervCurrentMovementController) return bot.__nervCurrentMovementController
    if (bot.pathfinder?.isMoving?.()) return 'pathfinder'
    const cs = bot.controlState || {}
    if (cs.forward || cs.back || cs.left || cs.right || cs.jump) return 'manual'
    return 'idle'
  }

  function getActiveControls() {
    const cs = bot.controlState || {}
    const active = []
    if (cs.forward) active.push('forward')
    if (cs.sprint) active.push('sprint')
    if (cs.back) active.push('back')
    if (cs.left) active.push('left')
    if (cs.right) active.push('right')
    if (cs.jump) active.push('jump')
    if (cs.sneak) active.push('sneak')
    return active.join(',') || 'none'
  }

  function getPingMs() {
    const ping = bot.player?.ping ?? bot.players?.[bot.username]?.ping
    return typeof ping === 'number' && ping > 0 ? Math.round(ping) : null
  }

  bot.on('physicsTick', () => {
    const pos = bot.entity?.position
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return

    const now = Date.now()
    if (lastX == null || lastZ == null) {
      lastX = pos.x
      lastZ = pos.z
      windowStartX = pos.x
      windowStartZ = pos.z
      windowStartY = pos.y
      windowStartTime = now
      lastGroundedY = bot.entity.onGround ? Math.round(pos.y * 16) / 16 : null
      return
    }

    const dx = pos.x - lastX
    const dz = pos.z - lastZ
    lastX = pos.x
    lastZ = pos.z

    const tickDist = Math.hypot(dx, dz)
    // Ignore server teleports / respawns (>8 blocks in a single tick)
    if (tickDist < 8.0) {
      windowDistanceXZ += tickDist
    }

    if (bot.entity.onGround) {
      const currentGY = Math.round(pos.y * 16) / 16
      if (lastGroundedY != null && Math.abs(currentGY - lastGroundedY) >= 0.05) {
        yTransitions += 1
      }
      lastGroundedY = currentGY
    }

    const controller = getActiveController()
    const controls = getActiveControls()
    const hasIntent = controller !== 'idle' || controls !== 'none'

    // Stall tracking
    if (hasIntent) {
      if (!movementIntentActive) {
        movementIntentActive = true
        stallStartTime = now
      }
      if (tickDist > 0.01) {
        if (stallLogged) {
          const stalledDuration = Math.round((now - stallStartTime) / 1000)
          console.log(redactLogText(`[MOVE-RECOVER] bot=${username} controller=${controller} stalledSec=${stalledDuration} recovered=true`))
          stallLogged = false
        }
        stallStartTime = now
      } else if (now - stallStartTime >= stallThresholdMs) {
        if (!stallLogged || (now - lastStallLogTime >= 30000)) {
          const stalledMs = now - stallStartTime
          console.log(redactLogText(`[MOVE-STALL] bot=${username} controller=${controller} controls=${controls} stalledMs=${stalledMs} y=${pos.y.toFixed(3)} onGround=${bot.entity.onGround}`))
          stallLogged = true
          lastStallLogTime = now
        }
      }
    } else {
      movementIntentActive = false
      stallStartTime = null
      stallLogged = false
    }

    // Window log (every logIntervalMs)
    const windowElapsed = now - windowStartTime
    if (windowElapsed >= logIntervalMs) {
      const bps = (windowDistanceXZ / (windowElapsed / 1000))
      const netXZ = Math.hypot(pos.x - windowStartX, pos.z - windowStartZ)
      const ping = getPingMs()
      const pingText = ping != null ? ` ping=${ping}ms` : ''

      if (windowDistanceXZ > 0.1 || hasIntent) {
        console.log(redactLogText(
          `[MOVE] bot=${username} controller=${controller} controls=${controls} ` +
          `bps=${bps.toFixed(2)} distXZ=${windowDistanceXZ.toFixed(1)} netXZ=${netXZ.toFixed(1)} ` +
          `y=${pos.y.toFixed(3)} yTrans=${yTransitions} onGround=${bot.entity.onGround}${pingText}`
        ))
      }

      windowStartX = pos.x
      windowStartZ = pos.z
      windowStartY = pos.y
      windowStartTime = now
      windowDistanceXZ = 0
      yTransitions = 0
    }
  })

  bot._client?.on('position', () => {
    // Reset positions on server repositioning packet
    lastX = null
    lastZ = null
  })
}

module.exports = {
  installMovementDiagnostics
}
