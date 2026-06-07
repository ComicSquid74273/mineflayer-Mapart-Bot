const mineflayer = require('mineflayer')
const { randomInt } = require('crypto')
const { applyProxyToOptions, formatProxyForLog } = require('../shared/proxy-connect')

function loadAppConfig () {
  const candidates = ['../../config.test.json', '../../config.json']

  for (const candidate of candidates) {
    try {
      const config = require(candidate)
      console.log(`[CONFIG] Loaded ${candidate}.`)
      return config
    } catch (err) {
      if (err?.code !== 'MODULE_NOT_FOUND') {
        console.log(`[CONFIG] Failed to load ${candidate}: ${err.message || err}`)
      }
    }
  }

  console.log('[CONFIG] No config file found. Using built-in defaults.')
  return {}
}

const appConfig = loadAppConfig()

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'

const state = {
  offline: 'offline',
  online: 'online',
  reconnecting: 'reconnecting'
}

function toNumber (value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseVersion (value, fallback = '1.21.8') {
  const configuredVersion = value || fallback
  return configuredVersion === 'auto' ? false : configuredVersion
}

function randomString (length) {
  let value = ''

  for (let index = 0; index < length; index++) {
    value += RANDOM_ALPHABET[randomInt(0, RANDOM_ALPHABET.length)]
  }

  return value
}

function stringifyReason (reason) {
  if (!reason) return 'unknown'
  return typeof reason === 'string' ? reason : JSON.stringify(reason)
}

function normalizeAdvertisingConfig (advertising) {
  return {
    enabled: Boolean(advertising?.enabled),
    usernameBlacklist: Array.isArray(advertising?.usernameBlacklist) ? advertising.usernameBlacklist : [],
    targetUsers: Array.isArray(advertising?.targetUsers)
      ? advertising.targetUsers.filter((username) => typeof username === 'string' && username.trim()).map((username) => username.trim())
      : [],
    messages: Array.isArray(advertising?.messages) ? advertising.messages : [],
    messagePattern: String(advertising?.messagePattern || '.msg'),
    randomStringLength: toNumber(advertising?.randomStringLength, 0),
    sendMessagesInRandomOrder: Boolean(advertising?.sendMessagesInRandomOrder),
    randomQuotePerTarget: Boolean(advertising?.randomQuotePerTarget),
    messageDelay: toNumber(advertising?.messageDelay, 4000),
    randomMessageDelay: Boolean(advertising?.randomMessageDelay),
    maxRandomMessageDelay: toNumber(advertising?.maxRandomMessageDelay, 9000),
    whisperMessages: Boolean(advertising?.whisperMessages),
    sendMessagesInChat: Boolean(advertising?.sendMessagesInChat),
    randomPlayerOrder: Boolean(advertising?.randomPlayerOrder)
  }
}

function normalizeBotConfig (rawBotConfig, globalConfig) {
  return {
    label: rawBotConfig.label || rawBotConfig.username || 'bot',
    host: rawBotConfig.host || '127.0.0.1',
    port: toNumber(rawBotConfig.port, 54321),
    username: rawBotConfig.username || 'MapartBot',
    auth: rawBotConfig.auth || 'offline',
    version: parseVersion(rawBotConfig.version, '1.21.11'),
    profilesFolder: rawBotConfig.profilesFolder || './auth-cache',
    viewDistance: rawBotConfig.viewDistance || 'tiny',
    checkTimeoutInterval: toNumber(rawBotConfig.checkTimeoutInterval, 60000),
    proxy: rawBotConfig.proxy,
    proxyId: rawBotConfig.proxyId,
    proxyType: rawBotConfig.proxyType,
    proxyHost: rawBotConfig.proxyHost,
    proxyPort: rawBotConfig.proxyPort,
    proxyUsername: rawBotConfig.proxyUsername,
    proxyPassword: rawBotConfig.proxyPassword,
    proxyConnectTimeoutMs: toNumber(rawBotConfig.proxyConnectTimeoutMs, 30000),
    proxyEnabled: rawBotConfig.proxyEnabled,
    reconnectDelay: toNumber(rawBotConfig.reconnectDelay, 5500),
    enableReconnect: rawBotConfig.enableReconnect !== false,
    skipReconnectOnModdedKick: rawBotConfig.skipReconnectOnModdedKick !== false,
    requiredSpawnCountBeforeStartup: toNumber(rawBotConfig.requiredSpawnCountBeforeStartup, 2),
    startupDelay: toNumber(rawBotConfig.startupDelay, 18000),
    startupMessageSpacing: toNumber(rawBotConfig.startupMessageSpacing, 4000),
    startupMessages: Array.isArray(rawBotConfig.startupMessages) ? rawBotConfig.startupMessages : [],
    sendChatMessagesInConsole: rawBotConfig.sendChatMessagesInConsole ?? globalConfig.sendChatMessagesInConsole ?? true
  }
}

class ConfiguredBot {
  constructor (rawBotConfig, globalConfig) {
    this.globalConfig = {
      ...globalConfig,
      advertising: normalizeAdvertisingConfig(globalConfig?.advertising)
    }
    this.botConfig = normalizeBotConfig(rawBotConfig, this.globalConfig)
    this.bot = null
    this.messageIndex = 0
    this.playerIndex = 0
    this.flaggedCount = 0
    this.spawned = 0
    this.currentState = state.offline
    this.reconnecting = false
    this.timers = new Set()
    this.advertisingTimer = null

    this.connect()
  }

  createOptions () {
    const options = {
      host: this.botConfig.host,
      port: this.botConfig.port,
      username: this.botConfig.username,
      auth: this.botConfig.auth,
      version: this.botConfig.version,
      profilesFolder: this.botConfig.profilesFolder,
      viewDistance: this.botConfig.viewDistance,
      checkTimeoutInterval: this.botConfig.checkTimeoutInterval
    }

    applyProxyToOptions(options, this.botConfig, {
      timeoutMs: this.botConfig.proxyConnectTimeoutMs
    })
    return options
  }

  connect () {
    const options = this.createOptions()

    console.log(`[BOOT] Starting ${this.botConfig.label}...`)
    console.log(`[BOOT] Target: ${options.host}:${options.port} | Version: ${options.version || 'auto'}`)
    console.log(`[BOOT] Account: ${options.username}`)
    if (options.connect) console.log(`[BOOT] Proxy: ${formatProxyForLog(this.botConfig)}`)

    this.bot = mineflayer.createBot(options)
    this.registerEvents()
  }

  registerEvents () {
    this.bot.once('login', () => this.onLogin())
    this.bot.on('spawn', () => this.onSpawn())
    this.bot.on('messagestr', (message) => this.onMessage(message))
    this.bot.on('kicked', (reason) => this.onKicked(reason))
    this.bot.on('error', (err) => this.onError(err))
    this.bot.on('end', (reason) => this.onEnd(reason))
  }

  onLogin () {
    console.log(`[LOGIN] ${this.botConfig.label} authenticated successfully.`)
  }

  onSpawn () {
    this.spawned += 1
    this.currentState = state.online
    this.reconnecting = false

    console.log(`[SPAWN] ${this.botConfig.label} spawned (${this.spawned}).`)

    if (this.spawned === this.botConfig.requiredSpawnCountBeforeStartup) {
      this.scheduleStartupMessages()
      this.scheduleAdvertising()
    }
  }

  onMessage (message) {
    if (this.botConfig.sendChatMessagesInConsole) {
      console.log(`[CHAT] ${message}`)
    }

    if (message.toLowerCase().startsWith('message was treated as spam')) {
      this.flaggedCount += 1
      console.log(`[WARN] Previous message was flagged as spam (${this.flaggedCount}).`)
    }
  }

  onKicked (reason) {
    const reasonText = stringifyReason(reason)
    console.log(`[KICKED] ${reasonText}`)

    if (this.botConfig.skipReconnectOnModdedKick && this.isModdedRequirementKick(reasonText)) {
      console.log('[RECONNECT] Skipped reconnect because server requires unsupported client mods.')
      return
    }

    this.beginReconnect('kicked')
  }

  isModdedRequirementKick (reasonText) {
    const value = String(reasonText || '').toLowerCase()
    return value.includes('fabric') || value.includes('registry entry namespaces')
  }

  onError (err) {
    console.log('[ERROR]', err?.message || err)
    this.beginReconnect('error')
  }

  onEnd (reason) {
    console.log(`[END] Disconnected${reason ? `: ${reason}` : ''}`)
    if (!this.reconnecting) {
      this.beginReconnect('end')
    }
  }

  schedule (callback, delayMs) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      callback()
    }, delayMs)

    this.timers.add(timer)
    return timer
  }

  clearTimers () {
    for (const timer of this.timers) {
      clearTimeout(timer)
    }

    this.timers.clear()

    if (this.advertisingTimer) {
      clearTimeout(this.advertisingTimer)
      this.advertisingTimer = null
    }
  }

  scheduleStartupMessages () {
    if (!this.botConfig.startupMessages.length) return

    console.log(`[STARTUP] Spawn threshold met. Startup messages are scheduled after ${this.botConfig.startupDelay}ms (send disabled in test mode).`)

    this.botConfig.startupMessages.forEach((message, index) => {
      this.schedule(() => {
        if (!this.isBotReady()) return
        console.log(`[SEND-SKIPPED] ${message}`)
      }, this.botConfig.startupDelay + index * this.botConfig.startupMessageSpacing)
    })
  }

  scheduleAdvertising () {
    if (!this.globalConfig.advertising?.enabled) return

    const firstDelay = this.botConfig.startupDelay + this.botConfig.startupMessages.length * this.botConfig.startupMessageSpacing + 3000
    console.log('[BROADCAST] Advertising loop enabled from config.json (send disabled in test mode).')

    this.advertisingTimer = this.schedule(() => {
      this.runAdvertisingLoop()
    }, firstDelay)
  }

  runAdvertisingLoop () {
    if (!this.isBotReady()) return

    const advertising = this.globalConfig.advertising
    const finalMessage = this.buildAdvertisingMessage(advertising)

    if (advertising.whisperMessages) {
      const players = this.getEligiblePlayers(advertising)
      const targetPlayer = this.pickPlayer(players, advertising.randomPlayerOrder)

      if (targetPlayer) {
        const whisper = `/w ${targetPlayer.username} ${finalMessage}`
        console.log(`[BROADCAST-MSG-SKIPPED] ${whisper}`)
      }
    }

    if (advertising.sendMessagesInChat) {
      console.log(`[BROADCAST-CHAT-SKIPPED] ${finalMessage}`)
    }

    const delayMs = advertising.randomMessageDelay
      ? randomInt(3500, Number(advertising.maxRandomMessageDelay || 9000))
      : Number(advertising.messageDelay || 4000)

    this.advertisingTimer = this.schedule(() => {
      this.runAdvertisingLoop()
    }, delayMs)
  }

  buildAdvertisingMessage (advertising) {
    const messages = advertising.messages
    if (!messages.length) return ''

    let selectedMessage

    if (advertising.randomQuotePerTarget || advertising.sendMessagesInRandomOrder) {
      selectedMessage = messages[randomInt(0, messages.length)]
    } else {
      selectedMessage = messages[this.messageIndex % messages.length]
      this.messageIndex += 1
    }

    return String(advertising.messagePattern || '.msg')
      .replace('.msg', selectedMessage)
      .replace('.rand', randomString(Number(advertising.randomStringLength || 0)))
  }

  getEligiblePlayers (advertising) {
    if (advertising.targetUsers.length) {
      return advertising.targetUsers
        .filter((username) => username !== this.bot.username && !advertising.usernameBlacklist.includes(username))
        .map((username) => ({ username }))
    }

    return Object.values(this.bot.players).filter((player) => {
      return player.username !== this.bot.username && !advertising.usernameBlacklist.includes(player.username)
    })
  }

  pickPlayer (players, randomOrder) {
    if (!players.length) return null

    if (randomOrder) {
      return players[randomInt(0, players.length)]
    }

    const player = players[this.playerIndex % players.length]
    this.playerIndex += 1
    return player
  }

  isBotReady () {
    return Boolean(this.bot && this.bot._client && !this.bot._client.ended && this.currentState === state.online)
  }

  beginReconnect (source) {
    if (!this.botConfig.enableReconnect || this.reconnecting) return

    this.reconnecting = true
    this.currentState = state.reconnecting
    this.clearTimers()

    console.log(`[RECONNECT] ${this.botConfig.label} reconnecting after ${source} in ${this.botConfig.reconnectDelay}ms.`)

    this.schedule(() => {
      this.spawned = 0
      this.currentState = state.offline
      this.connect()
    }, this.botConfig.reconnectDelay)
  }
}

const botConfigs = Array.isArray(appConfig.bots) && appConfig.bots.length
  ? appConfig.bots
  : [
      {
        label: 'test-local',
        host: '127.0.0.1',
        port: 54321,
        username: 'MapartBot',
        auth: 'offline',
        version: false,
        enableReconnect: false,
        skipReconnectOnModdedKick: true,
        sendChatMessagesInConsole: true,
        startupMessages: []
      }
    ]

botConfigs.forEach((botConfig) => {
  new ConfiguredBot(botConfig, appConfig)
})
