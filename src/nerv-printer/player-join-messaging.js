const DEFAULT_PLAYER_JOIN_MESSAGES = [
  'Get 300 free maparts, Join Vulcan Today | https://discord.gg/yzNbSgWc7n',
  'Need Help with mapart, Vulcan can help you out | https://discord.gg/yzNbSgWc7n'
]

function validUsername(value) {
  return /^[A-Za-z0-9_]{1,16}$/.test(String(value || ''))
}

function validMessage(value) {
  const message = String(value || '').trim()
  return message.length > 0 && message.length <= 220 && !/[\u0000-\u001f\u007f]/.test(message)
}

function normalizeMessages(values, fallback = DEFAULT_PLAYER_JOIN_MESSAGES) {
  const messages = (Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(validMessage)
  return messages.length ? messages : [...fallback]
}

function getPlayerJoinMessagingSettings(config) {
  const raw = config?.playerJoinMessaging || {}
  const masterOnly = raw.masterOnly !== false
  const role = String(config?.multiUser?.runtime?.role || 'single').trim().toLowerCase()
  const canEnable = !masterOnly || role !== 'slave'
  return {
    enabled: raw.enabled === true && canEnable,
    canEnable,
    masterOnly,
    joinDelayMs: Math.max(1000, Number(raw.joinDelayMs || 1000)),
    intervalMs: Math.max(1000, Number(raw.intervalMs || 3000)),
    messageListPollMs: Math.max(5000, Number(raw.messageListPollMs || 30000)),
    worldSettleMs: Math.max(1000, Number(raw.worldSettleMs || 2000)),
    defaultMessages: normalizeMessages(raw.defaultMessages)
  }
}

function createPlayerJoinMessenger(options) {
  const bot = options?.bot
  const settings = options?.settings || {}
  if (!bot) return null

  const isPrinting = typeof options.isPrinting === 'function' ? options.isPrinting : () => false
  const requestMessages = typeof options.requestMessages === 'function' ? options.requestMessages : null
  const now = typeof options.now === 'function' ? options.now : Date.now
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout
  const logger = options.logger || console
  let messages = normalizeMessages(settings.defaultMessages)
  let messageIndex = 0
  let version = 0
  let started = false
  let enabled = settings.enabled === true && settings.canEnable !== false
  let armed = false
  let pendingPlayer = null
  let lastSentAt = null
  let sendTimer = null
  let pollTimer = null
  let rearmTimer = null
  let baselinePlayers = new Set()

  function playerKey(username) {
    return String(username || '').toLowerCase()
  }

  function currentPlayers() {
    return new Set(Object.keys(bot.players || {}).map(playerKey).filter(Boolean))
  }

  function playerIsOnline(username) {
    const wanted = playerKey(username)
    return Object.keys(bot.players || {}).some((name) => playerKey(name) === wanted)
  }

  function clearSendTimer() {
    if (sendTimer) clearTimer(sendTimer)
    sendTimer = null
  }

  function disarm() {
    armed = false
    pendingPlayer = null
    baselinePlayers = new Set()
    clearSendTimer()
  }

  function arm() {
    if (!started || !enabled) return
    pendingPlayer = null
    baselinePlayers = currentPlayers()
    armed = true
    clearSendTimer()
  }

  function schedulePendingSend() {
    clearSendTimer()
    if (!enabled || !pendingPlayer) return
    const dueAt = Math.max(
      pendingPlayer.joinedAt + Number(settings.joinDelayMs || 1000),
      lastSentAt == null ? 0 : lastSentAt + Number(settings.intervalMs || 3000)
    )
    sendTimer = setTimer(() => {
      sendTimer = null
      const target = pendingPlayer
      pendingPlayer = null
      if (!target || !enabled || !armed || !isPrinting() || !playerIsOnline(target.username)) return
      const message = messages[messageIndex % messages.length]
      try {
        bot.chat(`/msg ${target.username} ${message}`)
        messageIndex += 1
        lastSentAt = now()
      } catch (error) {
        logger.warn?.(`[PLAYER-JOIN-MSG-WARN] ${error?.message || error}`)
      }
    }, Math.max(0, dueAt - now()))
    sendTimer?.unref?.()
  }

  function onPlayerJoined(player) {
    const username = String(player?.username || '').trim()
    const key = playerKey(username)
    if (!validUsername(username) || key === playerKey(bot.username)) return
    if (!enabled || !armed || !isPrinting() || baselinePlayers.has(key)) return
    baselinePlayers.add(key)
    pendingPlayer = { username, joinedAt: now() }
    schedulePendingSend()
  }

  function onPlayerLeft(player) {
    const username = String(player?.username || '').trim()
    const key = playerKey(username)
    baselinePlayers.delete(key)
    if (pendingPlayer && playerKey(pendingPlayer.username) === key) {
      pendingPlayer = null
      clearSendTimer()
    }
  }

  function onSpawn() {
    disarm()
    if (!enabled) return
    if (rearmTimer) clearTimer(rearmTimer)
    rearmTimer = setTimer(() => {
      rearmTimer = null
      arm()
    }, Number(settings.worldSettleMs || 2000))
    rearmTimer?.unref?.()
  }

  async function pollMessages() {
    if (!started || !enabled || !requestMessages) return
    try {
      const response = await requestMessages(version)
      if (response?.statusCode === 304) return
      const nextVersion = Number(response?.body?.version || 0)
      if (response?.statusCode >= 200 && response.statusCode < 300 && nextVersion !== version) {
        const nextMessages = (Array.isArray(response.body?.messages) ? response.body.messages : []).filter(validMessage)
        if (nextMessages.length) {
          messages = nextMessages
          messageIndex = 0
        }
        version = nextVersion
      }
    } catch (error) {
      logger.warn?.(`[PLAYER-JOIN-MSG-WARN] dashboard list refresh failed: ${error?.message || error}`)
    } finally {
      if (started && enabled && requestMessages) {
        pollTimer = setTimer(pollMessages, Number(settings.messageListPollMs || 30000))
        pollTimer?.unref?.()
      }
    }
  }

  function start() {
    if (started) return
    started = true
    bot.on('playerJoined', onPlayerJoined)
    bot.on('playerLeft', onPlayerLeft)
    bot.on('spawn', onSpawn)
    if (enabled) void pollMessages()
  }

  function stop() {
    started = false
    disarm()
    if (pollTimer) clearTimer(pollTimer)
    if (rearmTimer) clearTimer(rearmTimer)
    pollTimer = null
    rearmTimer = null
    bot.off?.('playerJoined', onPlayerJoined)
    bot.off?.('playerLeft', onPlayerLeft)
    bot.off?.('spawn', onSpawn)
  }

  return {
    arm,
    disarm,
    isEnabled() {
      return enabled
    },
    setEnabled(nextEnabled) {
      const next = nextEnabled === true && settings.canEnable !== false
      if (enabled === next) return enabled
      enabled = next
      if (!enabled) {
        disarm()
        if (pollTimer) clearTimer(pollTimer)
        pollTimer = null
        return false
      }
      arm()
      void pollMessages()
      return true
    },
    start,
    stop,
    updateMessages(nextMessages) {
      messages = normalizeMessages(nextMessages, messages)
      messageIndex = 0
    }
  }
}

module.exports = {
  DEFAULT_PLAYER_JOIN_MESSAGES,
  createPlayerJoinMessenger,
  getPlayerJoinMessagingSettings,
  normalizeMessages,
  validMessage,
  validUsername
}
