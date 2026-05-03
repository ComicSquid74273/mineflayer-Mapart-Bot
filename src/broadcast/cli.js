const mineflayer = require('mineflayer')
const { randomInt } = require('crypto')
const appConfig = require('../../config.json')

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'

function installTimestampedConsole () {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error
  }
  const withTimestamp = (args) => [`[${new Date().toISOString()}]`, ...args]
  console.log = (...args) => original.log(...withTimestamp(args))
  console.warn = (...args) => original.warn(...withTimestamp(args))
  console.error = (...args) => original.error(...withTimestamp(args))
}

installTimestampedConsole()

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
    host: rawBotConfig.host || 'alt.6b6t.org',
    port: toNumber(rawBotConfig.port, 25565),
    username: rawBotConfig.username,
    auth: rawBotConfig.auth || 'microsoft',
    version: parseVersion(rawBotConfig.version),
    profilesFolder: rawBotConfig.profilesFolder || './auth-cache',
    viewDistance: rawBotConfig.viewDistance || 'tiny',
    checkTimeoutInterval: toNumber(rawBotConfig.checkTimeoutInterval, 60000),
    reconnectDelay: toNumber(rawBotConfig.reconnectDelay, 5500),
    enableReconnect: rawBotConfig.enableReconnect !== false,
    requiredSpawnCountBeforeStartup: toNumber(rawBotConfig.requiredSpawnCountBeforeStartup, 2),
    startupDelay: toNumber(rawBotConfig.startupDelay, 18000),
    startupMessageSpacing: toNumber(rawBotConfig.startupMessageSpacing, 4000),
    startupMessages: Array.isArray(rawBotConfig.startupMessages) ? rawBotConfig.startupMessages : [],
    sendChatMessagesInConsole: rawBotConfig.sendChatMessagesInConsole ?? globalConfig.sendChatMessagesInConsole ?? true
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor !== 20) {
  console.warn(`[BOOT] Warning: expected Node 20, current Node is ${process.versions.node}`)
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
    return {
      host: this.botConfig.host,
      port: this.botConfig.port,
      username: this.botConfig.username,
      auth: this.botConfig.auth,
      version: this.botConfig.version,
      profilesFolder: this.botConfig.profilesFolder,
      viewDistance: this.botConfig.viewDistance,
      checkTimeoutInterval: this.botConfig.checkTimeoutInterval
    }
  }

  connect () {
    const options = this.createOptions()

    console.log(`[BOOT] Starting ${this.botConfig.label}...`)
    console.log(`[BOOT] Target: ${options.host}:${options.port} | Version: ${options.version || 'auto'}`)
    console.log(`[BOOT] Account: ${options.username}`)

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
    console.log(`[KICKED] ${stringifyReason(reason)}`)
    this.beginReconnect('kicked')
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

    console.log(`[STARTUP] Spawn threshold met. Sending configured startup messages after ${this.botConfig.startupDelay}ms...`)

    this.botConfig.startupMessages.forEach((message, index) => {
      this.schedule(() => {
        if (!this.isBotReady()) return
        console.log(`[SEND] ${message}`)
        this.bot.chat(message)
      }, this.botConfig.startupDelay + index * this.botConfig.startupMessageSpacing)
    })
  }

  scheduleAdvertising () {
    if (!this.globalConfig.advertising?.enabled) return

    const firstDelay = this.botConfig.startupDelay + this.botConfig.startupMessages.length * this.botConfig.startupMessageSpacing + 3000
    console.log('[BROADCAST] Advertising loop enabled from config.json.')

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
        console.log(`[BROADCAST-MSG] ${whisper}`)
        this.bot.chat(whisper)
      }
    }

    if (advertising.sendMessagesInChat) {
      console.log(`[BROADCAST-CHAT] ${finalMessage}`)
      this.bot.chat(finalMessage)
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

const botConfigs = Array.isArray(appConfig.bots) ? appConfig.bots : []

if (!botConfigs.length) {
  throw new Error('config.json must define at least one bot in the bots array.')
}

botConfigs.forEach((botConfig) => {
  new ConfiguredBot(botConfig, appConfig)
})
