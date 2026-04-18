const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')

const CONFIG_FILE = path.resolve(process.cwd(), 'nerv-printer-config', '_configs', 'nerv-printer-config.json')

function toNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseVersion(value) {
  const configured = String(value || 'auto').trim().toLowerCase()
  return configured === 'auto' ? false : value
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getArg(name, fallback = null) {
  const prefix = `--${name}=`
  const entry = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : fallback
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
}

function getEnabledAccount(config) {
  const users = Array.isArray(config?.bot?.usernames) ? config.bot.usernames : []
  return users.find((entry) => entry?.enabled !== false) || users[0] || null
}

function getConnectionBotConfig(config) {
  const selected = getArg('connection', config?.connection?.active || 'local')
  const rootBot = config?.bot || {}
  const profileBot = config?.connection?.profiles?.[selected]?.bot || {}
  return {
    selected,
    bot: {
      ...rootBot,
      ...profileBot,
      reconnect: {
        ...(rootBot.reconnect || {}),
        ...(profileBot.reconnect || {})
      },
      chatLogin: {
        ...(rootBot.chatLogin || {}),
        ...(profileBot.chatLogin || {})
      }
    }
  }
}

function normalizeDirection(value) {
  const text = String(value || 'east').trim().toLowerCase()
  if (text === 'west') return { name: 'west', dx: -5, dz: 0 }
  if (text === 'north') return { name: 'north', dx: 0, dz: -5 }
  if (text === 'south') return { name: 'south', dx: 0, dz: 5 }
  return { name: 'east', dx: 5, dz: 0 }
}

function roundPosition(pos) {
  if (!pos) return null
  return {
    x: Math.round(Number(pos.x) * 100) / 100,
    y: Math.round(Number(pos.y) * 100) / 100,
    z: Math.round(Number(pos.z) * 100) / 100
  }
}

function isPositionUsable(pos) {
  return pos && Number.isFinite(pos.x) && Number.isFinite(pos.z) && (Math.abs(pos.x) > 1 || Math.abs(pos.z) > 1)
}

function formatBotPosition(bot) {
  const pos = bot?.entity?.position
  if (!pos) return 'x=null y=null z=null'
  const fmt = (value) => Number.isFinite(value) ? Number(value).toFixed(2) : 'null'
  return `x=${fmt(pos.x)} y=${fmt(pos.y)} z=${fmt(pos.z)}`
}

async function waitForUsablePosition(bot, maxMs) {
  const deadline = Date.now() + Math.max(1000, toNumber(maxMs, 30000))
  while (Date.now() < deadline) {
    if (isPositionUsable(bot?.entity?.position)) return bot.entity.position
    await delay(500)
  }
  return null
}

function horizontalDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY
  const dx = Number(a.x) - Number(b.x)
  const dz = Number(a.z) - Number(b.z)
  return Math.sqrt((dx * dx) + (dz * dz))
}

async function main() {
  const config = readConfig()
  const account = getEnabledAccount(config)
  if (!account?.name) {
    throw new Error('No enabled bot account found in nerv-printer-config.json')
  }

  const { selected, bot: botConfig } = getConnectionBotConfig(config)
  const direction = normalizeDirection(getArg('direction', 'east'))
  const settleMs = Math.max(2000, toNumber(getArg('settle-ms', 6000), 6000))
  const timeoutMs = Math.max(5000, toNumber(getArg('timeout-ms', 20000), 20000))
  const positionWaitMs = Math.max(5000, toNumber(getArg('position-wait-ms', 45000), 45000))

  const options = {
    host: botConfig.host,
    port: toNumber(botConfig.port, 25565),
    username: String(account.name),
    auth: String(account.auth || botConfig.auth || 'offline'),
    version: parseVersion(botConfig.version),
    profilesFolder: botConfig.profilesFolder || './auth-cache',
    viewDistance: botConfig.viewDistance || 'tiny',
    checkTimeoutInterval: toNumber(botConfig.checkTimeoutInterval, 60000)
  }

  console.log(`[MOVE-TEST] Connection=${selected} account=${options.username} auth=${options.auth}`)
  console.log(`[MOVE-TEST] Target=${options.host}:${options.port} direction=${direction.name} blocks=5`)

  const bot = mineflayer.createBot(options)
  bot.loadPlugin(pathfinder)

  let settled = false

  const promptPatterns = Array.isArray(botConfig?.chatLogin?.promptPatterns) ? botConfig.chatLogin.promptPatterns : []
  const loginCommand = String(botConfig?.chatLogin?.command || '/login').trim() || '/login'
  const loginPassword = String(account?.loginPassword || '').trim()

  bot.on('messagestr', async (message) => {
    const text = String(message || '')
    console.log(`[MOVE-TEST-CHAT] ${text}`)
    if (!loginPassword || botConfig?.chatLogin?.enabled === false) return
    const lower = text.toLowerCase()
    if (!promptPatterns.some((pattern) => lower.includes(String(pattern).toLowerCase()))) return
    await delay(Math.max(250, toNumber(botConfig?.chatLogin?.minDelayMs, 750)))
    try {
      bot.chat(`${loginCommand} ${loginPassword}`)
      console.log('[MOVE-TEST] Sent chat login command.')
    } catch (err) {
      console.log(`[MOVE-TEST-WARN] Could not send chat login command: ${err?.message || err}`)
    }
  })

  bot.once('spawn', async () => {
    try {
      console.log(`[MOVE-TEST] Spawned at ${JSON.stringify(roundPosition(bot.entity.position))}`)
      const readyPos = await waitForUsablePosition(bot, positionWaitMs)
      if (!readyPos) {
        throw new Error(`Position never became usable within ${positionWaitMs}ms. current=${formatBotPosition(bot)}`)
      }
      console.log(`[MOVE-TEST] Position ready at ${formatBotPosition(bot)}`)
      await delay(settleMs)

      const start = roundPosition(bot.entity.position)
      const target = {
        x: Math.floor(bot.entity.position.x + direction.dx),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z + direction.dz)
      }

      console.log(`[MOVE-TEST] Start=${JSON.stringify(start)} target=${JSON.stringify(target)}`)

      const movements = new Movements(bot)
      bot.pathfinder.setMovements(movements)

      const startedAt = Date.now()
      await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 1), timeoutMs)
      const elapsedMs = Date.now() - startedAt
      const end = roundPosition(bot.entity.position)
      const moved = horizontalDistance(start, end)

      console.log(`[MOVE-TEST] End=${JSON.stringify(end)} moved=${moved.toFixed(2)} elapsedMs=${elapsedMs}`)
      console.log(`[MOVE-TEST] Result=${moved >= 2 ? 'MOVED' : 'STUCK'}`)
      settled = true
      bot.quit('move-test-complete')
    } catch (err) {
      console.log(`[MOVE-TEST-FAIL] ${err?.message || err}`)
      settled = true
      try { bot.quit('move-test-failed') } catch { }
      process.exitCode = 1
    }
  })

  bot.on('kicked', (reason) => {
    console.log(`[MOVE-TEST-KICKED] ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`)
    if (!settled) process.exitCode = 1
  })

  bot.on('error', (err) => {
    console.log(`[MOVE-TEST-ERROR] ${err?.message || err}`)
    if (!settled) process.exitCode = 1
  })

  bot.on('end', (reason) => {
    console.log(`[MOVE-TEST-END] ${reason || 'disconnected'}`)
  })
}

main().catch((err) => {
  console.error(`[MOVE-TEST-FATAL] ${err?.message || err}`)
  process.exitCode = 1
})