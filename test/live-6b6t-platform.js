'use strict'

const mineflayer = require('mineflayer')
const {
  pathfinder,
  Movements,
  goals: { GoalNear }
} = require('mineflayer-pathfinder')
const { SocksClient } = require('socks')
const { installConfigurationTransferGuard } = require('../src/nerv-printer/connection/configuration-transfer-guard')

const LOGIN_CENTER = { x: -999.5, y: 100, z: -999.5 }
const LOGIN_PORTAL_FALLBACK = { x: -999.5, y: 101, z: -987.5 }
const OBSERVED_LOBBY = {
  center: { x: 319, y: 163, z: 425 },
  approach: { x: 313, y: 163, z: 424 },
  portal: { x: 311, y: 163, z: 424 }
}
const SPAWN_LOBBY = {
  center: { x: 0, y: 20, z: 4 },
  approach: { x: 0, y: 20, z: -16 },
  portal: { x: 0, y: 20, z: -16 }
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function envNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function timestamp() {
  return new Date().toISOString()
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`)
}

function roundPosition(pos) {
  if (!pos) return null
  const round = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null
  return { x: round(pos.x), y: round(pos.y), z: round(pos.z) }
}

function formatPosition(pos) {
  const value = roundPosition(pos)
  return value ? `${value.x},${value.y},${value.z}` : 'missing'
}

function horizontalDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.z) - Number(b.z))
}

function distance3d(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z))
}

function isFinitePosition(pos) {
  return Boolean(pos) && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y)) && Number.isFinite(Number(pos.z))
}

function classifyPosition(pos, target) {
  if (!isFinitePosition(pos)) return 'missing'
  if (horizontalDistance(pos, target) <= 384 && Math.abs(Number(pos.y) - Number(target.y)) <= 128) return 'platform'
  if (horizontalDistance(pos, LOGIN_CENTER) <= 24 && Math.abs(Number(pos.y) - LOGIN_CENTER.y) <= 16) return 'login-portal'
  if (distance3d(pos, OBSERVED_LOBBY.center) <= 48) return 'observed-lobby'
  if (horizontalDistance(pos, SPAWN_LOBBY.center) <= 128 && Math.abs(Number(pos.y) - SPAWN_LOBBY.center.y) <= 80) return 'spawn-lobby'
  if (horizontalDistance(pos, { x: 500, z: 500 }) <= 50) return 'transfer-lobby-500'
  if (horizontalDistance(pos, { x: 1000, z: 1000 }) <= 50) return 'transfer-lobby-1000'
  if (Math.abs(Number(pos.x)) > 100000 || Math.abs(Number(pos.z)) > 100000) return 'final-world'
  return 'unknown'
}

function stopMovement(bot) {
  for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
    try { bot.setControlState(control, false) } catch { }
  }
  try { bot.pathfinder?.setGoal(null) } catch { }
}

function nearestPortal(bot, radius = 24, verticalRadius = 6) {
  const pos = bot?.entity?.position
  if (!isFinitePosition(pos)) return null
  const origin = pos.floored()
  let nearest = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let y = origin.y - verticalRadius; y <= origin.y + verticalRadius; y += 1) {
    for (let x = origin.x - radius; x <= origin.x + radius; x += 1) {
      for (let z = origin.z - radius; z <= origin.z + radius; z += 1) {
        const block = bot.blockAt(new pos.constructor(x, y, z), false)
        if (block?.name !== 'nether_portal') continue
        const candidate = { x: block.position.x + 0.5, y: block.position.y + 0.5, z: block.position.z + 0.5 }
        const candidateDistance = distance3d(pos, candidate)
        if (candidateDistance >= nearestDistance) continue
        nearest = candidate
        nearestDistance = candidateDistance
      }
    }
  }
  return nearest ? { ...nearest, distance: nearestDistance } : null
}

function describeCollision(bot, target) {
  const pos = bot?.entity?.position
  if (!isFinitePosition(pos)) return 'position-missing'
  const dx = Number(target.x) - Number(pos.x)
  const dz = Number(target.z) - Number(pos.z)
  const length = Math.max(0.001, Math.hypot(dx, dz))
  const stepX = dx / length
  const stepZ = dz / length
  const samples = []
  for (const distance of [0, 0.75, 1.5, 2.5]) {
    const x = Math.floor(Number(pos.x) + (stepX * distance))
    const z = Math.floor(Number(pos.z) + (stepZ * distance))
    const feet = bot.blockAt(new pos.constructor(x, Math.floor(pos.y), z), false)?.name || 'unloaded'
    const head = bot.blockAt(new pos.constructor(x, Math.floor(pos.y) + 1, z), false)?.name || 'unloaded'
    const floor = bot.blockAt(new pos.constructor(x, Math.floor(pos.y) - 1, z), false)?.name || 'unloaded'
    samples.push(`${distance.toFixed(2)}m=${floor}/${feet}/${head}`)
  }
  return samples.join(' ')
}

async function lookAtPoint(bot, point) {
  const Vec3 = bot.entity.position.constructor
  await bot.lookAt(new Vec3(Number(point.x), Number(point.y), Number(point.z)), true)
}

async function controlledDrive(bot, point, options = {}) {
  const durationMs = Math.max(250, Number(options.durationMs || 2500))
  const jump = options.jump === true
  const sprint = options.sprint === true
  const stopOnPortal = options.stopOnPortal === true
  const label = options.label || 'drive'
  const start = bot.entity.position.clone()
  let peakDistance = 0
  let lastSampleAt = 0

  await lookAtPoint(bot, point)
  log(`[DRIVE] ${label} start=${formatPosition(start)} target=${formatPosition(point)} yaw=${Number(bot.entity.yaw).toFixed(3)} jump=${jump} sprint=${sprint}`)
  bot.setControlState('sprint', sprint)
  bot.setControlState('jump', jump)
  bot.setControlState('forward', true)
  const deadline = Date.now() + durationMs
  try {
    while (Date.now() < deadline && bot?._client?.state === 'play') {
      const moved = horizontalDistance(start, bot.entity.position)
      peakDistance = Math.max(peakDistance, moved)
      const feetBlock = bot.blockAt(bot.entity.position)?.name || 'unloaded'
      if (stopOnPortal && feetBlock === 'nether_portal') {
        log(`[DRIVE-PORTAL] ${label} entered portal at=${formatPosition(bot.entity.position)}; stopping inside block`)
        break
      }
      if (Date.now() - lastSampleAt >= 500) {
        lastSampleAt = Date.now()
        log(`[DRIVE-SAMPLE] ${label} pos=${formatPosition(bot.entity.position)} moved=${moved.toFixed(2)} peak=${peakDistance.toFixed(2)} feet=${feetBlock}`)
      }
      await delay(100)
    }
  } finally {
    stopMovement(bot)
  }
  await delay(350)
  const end = bot.entity.position.clone()
  log(`[DRIVE-END] ${label} end=${formatPosition(end)} net=${horizontalDistance(start, end).toFixed(2)} peak=${peakDistance.toFixed(2)}`)
  return { start: roundPosition(start), end: roundPosition(end), netDistance: horizontalDistance(start, end), peakDistance }
}

async function gotoPoint(bot, point, label, timeoutMs = 30000) {
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = false
  bot.pathfinder.setMovements(movements)
  log(`[PATH] ${label} from=${formatPosition(bot.entity.position)} target=${formatPosition(point)}`)
  let timer
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(Number(point.x), Number(point.y), Number(point.z), 2)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])
    log(`[PATH-END] ${label} pos=${formatPosition(bot.entity.position)}`)
    return true
  } catch (err) {
    log(`[PATH-WARN] ${label}: ${err?.message || err}`)
    return false
  } finally {
    clearTimeout(timer)
    stopMovement(bot)
  }
}

async function enterKnownLobbyPortal(bot, route, label) {
  const portal = nearestPortal(bot, 32, 8)
  const target = route.portal || portal
  log(`[PORTAL] ${label} detected=${portal ? formatPosition(portal) : 'none'} configured=${formatPosition(route.portal)}`)
  const pathTarget = route.approach || portal
  const pathWorked = await gotoPoint(bot, pathTarget, `${label}-approach`, 30000)
  if (!pathWorked) {
    await controlledDrive(bot, pathTarget, { durationMs: 5000, jump: true, label: `${label}-direct-approach` })
  }
  await controlledDrive(bot, target, { durationMs: 3500, jump: false, stopOnPortal: true, label: `${label}-portal-entry` })
  await delay(8000)
}

async function diagnoseLoginPortal(bot, state) {
  const before = bot.entity.position.clone()
  const portal = nearestPortal(bot, 24, 8)
  const target = portal || LOGIN_PORTAL_FALLBACK
  log(`[LOGIN-PROBE] cycle=${state.loginProbeCycles + 1} pos=${formatPosition(before)} yaw=${Number(bot.entity.yaw).toFixed(3)} dim=${bot.game?.dimension || 'unknown'} portal=${portal ? `${formatPosition(portal)} distance=${portal.distance.toFixed(2)}` : 'not-loaded'} collision=${describeCollision(bot, target)}`)

  state.loginProbeCycles += 1
  const packetStart = state.correctionPackets
  const normal = await controlledDrive(bot, target, {
    durationMs: 3500,
    jump: false,
    sprint: false,
    label: `login-normal-${state.loginProbeCycles}`
  })
  await delay(1200)

  if (classifyPosition(bot.entity.position, state.target) !== 'login-portal') return

  const assisted = await controlledDrive(bot, target, {
    durationMs: 5000,
    jump: true,
    sprint: false,
    label: `login-jump-${state.loginProbeCycles}`
  })
  await delay(6000)

  const corrections = state.correctionPackets - packetStart
  log(`[LOGIN-PROBE-RESULT] cycle=${state.loginProbeCycles} final=${formatPosition(bot.entity.position)} normalNet=${normal.netDistance.toFixed(2)} normalPeak=${normal.peakDistance.toFixed(2)} jumpNet=${assisted.netDistance.toFixed(2)} jumpPeak=${assisted.peakDistance.toFixed(2)} correctionPackets=${corrections}`)
}

function createSession(settings, host, sessionNo) {
  return new Promise((resolve) => {
    const options = {
      host,
      port: settings.serverPort,
      username: settings.username,
      auth: 'offline',
      version: settings.version,
      viewDistance: 'tiny',
      checkTimeoutInterval: 60000
    }
    options.connect = (client) => {
      SocksClient.createConnection({
        command: 'connect',
        timeout: 30000,
        proxy: {
          host: settings.proxyHost,
          port: settings.proxyPort,
          type: 5,
          userId: settings.proxyUsername,
          password: settings.proxyPassword
        },
        destination: { host, port: settings.serverPort }
      }).then((info) => {
        client.setSocket(info.socket)
        client.emit('connect')
      }).catch((err) => {
        const code = String(err?.code || err?.options?.code || 'SOCKS_CONNECT_FAILED')
        client.emit('error', new Error(`${code}: proxy ${settings.proxyHost}:${settings.proxyPort} could not connect to ${host}:${settings.serverPort}`))
      })
    }

    log(`[SESSION] no=${sessionNo} account=${settings.username} server=${host}:${settings.serverPort} version=${settings.version} proxy=SOCKS5 ${settings.proxyHost}:${settings.proxyPort} user=${settings.proxyUsername}`)
    const bot = mineflayer.createBot(options)
    installConfigurationTransferGuard(bot, { logger: log })

    // Keep this test's wire trace deliberately limited to movement packets so
    // chat commands and credentials can never be written to the diagnostic log.
    const clientWrite = bot._client.write.bind(bot._client)
    bot._client.write = (packetName, packet) => {
      if (packetName === 'teleport_confirm') {
        log(`[CLIENT-TELEPORT-CONFIRM] teleportId=${String(packet?.teleportId)}`)
      } else if (process.env.TEST_WIRE_MOVEMENT === '1' && ['position', 'position_look', 'look', 'flying'].includes(packetName)) {
        const position = Number.isFinite(Number(packet?.x)) && Number.isFinite(Number(packet?.y)) && Number.isFinite(Number(packet?.z))
          ? formatPosition(packet)
          : 'unchanged'
        log(`[CLIENT-MOVE] packet=${packetName} pos=${position} yaw=${Number.isFinite(Number(packet?.yaw)) ? Number(packet.yaw).toFixed(3) : 'unchanged'} pitch=${Number.isFinite(Number(packet?.pitch)) ? Number(packet.pitch).toFixed(3) : 'unchanged'} flags=${JSON.stringify(packet?.flags || null)}`)
      }
      return clientWrite(packetName, packet)
    }
    bot.loadPlugin(pathfinder)

    const state = {
      target: settings.target,
      settled: false,
      busy: false,
      loggedIn: false,
      loginSentAt: 0,
      loginProbeCycles: 0,
      correctionPackets: 0,
      correctionDistance: 0,
      lastCorrection: null,
      lastClassification: '',
      homeSentAt: 0,
      spawned: 0,
      startedAt: Date.now()
    }

    const finish = (result) => {
      if (state.settled) return
      state.settled = true
      clearInterval(loopTimer)
      clearTimeout(timeoutTimer)
      stopMovement(bot)
      const outcome = {
        ...result,
        host,
        sessionNo,
        finalPosition: roundPosition(bot?.entity?.position),
        correctionPackets: state.correctionPackets,
        correctionDistance: Math.round(state.correctionDistance * 100) / 100,
        loginProbeCycles: state.loginProbeCycles,
        spawned: state.spawned
      }
      log(`[RESULT] ${JSON.stringify(outcome)}`)
      resolve(outcome)
      try { bot.quit(result.reason || 'live-platform-test-complete') } catch { }
    }

    const sendLogin = (reason) => {
      if (Date.now() - state.loginSentAt < 4000 || bot?._client?.state !== 'play') return
      state.loginSentAt = Date.now()
      bot.chat(`/login ${settings.loginPassword}`)
      log(`[LOGIN] command sent reason=${reason}; password not logged`)
    }

    for (const packetName of ['position', 'position_look']) {
      bot._client.on(packetName, (packet) => {
        if (!Number.isFinite(Number(packet?.x)) || !Number.isFinite(Number(packet?.y)) || !Number.isFinite(Number(packet?.z))) return
        const packetPos = { x: Number(packet.x), y: Number(packet.y), z: Number(packet.z) }
        const entityPos = bot?.entity?.position
        const correctionDistance = isFinitePosition(entityPos) ? distance3d(packetPos, entityPos) : 0
        state.correctionPackets += 1
        state.correctionDistance += correctionDistance
        state.lastCorrection = { packetName, position: packetPos, correctionDistance, at: Date.now() }
        log(`[SERVER-POSITION] packet=${packetName} teleportId=${String(packet?.teleportId)} packetPos=${formatPosition(packetPos)} entityBefore=${formatPosition(entityPos)} delta=${correctionDistance.toFixed(2)} flags=${JSON.stringify(packet.flags || null)} keys=${Object.keys(packet || {}).join(',')}`)
      })
    }

    bot.on('spawn', () => {
      state.spawned += 1
      log(`[SPAWN] count=${state.spawned} pos=${formatPosition(bot.entity.position)} dim=${bot.game?.dimension || 'unknown'} yaw=${Number(bot.entity.yaw).toFixed(3)}`)
    })

    bot.on('messagestr', (message) => {
      const text = String(message || '').replace(/\s+/g, ' ').trim()
      if (text) log(`[CHAT] ${text}`)
      const lower = text.toLowerCase()
      if (lower.includes('please login with the command') || lower.includes('/login <password>')) sendLogin('prompt')
      if (lower.includes('you are now logged in') || lower.includes('successfully logged in')) {
        state.loggedIn = true
        log('[LOGIN] success confirmed')
      }
      if (lower.includes('welcome to 6b6t.org')) log('[WORLD] final-server welcome detected')
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      log(`[KICKED] ${text}`)
    })

    bot.on('error', (err) => {
      log(`[ERROR] ${err?.stack || err?.message || err}`)
      if (state.spawned === 0) finish({ success: false, reason: 'proxy-or-server-connect-error' })
    })

    bot.on('end', (reason) => {
      log(`[END] ${reason || 'disconnected'}`)
      if (!state.settled) finish({ success: false, reason: reason || 'disconnected' })
    })

    const loopTimer = setInterval(() => {
      void (async () => {
        if (state.settled || state.busy || bot?._client?.state !== 'play' || !isFinitePosition(bot?.entity?.position)) return
        const classification = classifyPosition(bot.entity.position, settings.target)
        if (classification !== state.lastClassification) {
          state.lastClassification = classification
          log(`[STATE] classification=${classification} pos=${formatPosition(bot.entity.position)} dim=${bot.game?.dimension || 'unknown'}`)
        }
        if (classification === 'platform') {
          finish({ success: true, reason: 'platform-reached' })
          return
        }
        if (!state.loggedIn) {
          if (Date.now() - state.startedAt > 3500) sendLogin('startup-fallback')
          return
        }

        state.busy = true
        try {
          if (classification === 'login-portal') {
            if (state.loginProbeCycles >= settings.maxLoginProbeCycles) {
              finish({ success: false, reason: 'login-movement-stuck' })
              return
            }
            await diagnoseLoginPortal(bot, state)
          } else if (classification === 'observed-lobby') {
            await enterKnownLobbyPortal(bot, OBSERVED_LOBBY, 'observed-lobby')
          } else if (classification === 'spawn-lobby') {
            await enterKnownLobbyPortal(bot, SPAWN_LOBBY, 'spawn-lobby')
          } else if (classification.startsWith('transfer-lobby')) {
            log(`[TRANSFER] waiting at ${formatPosition(bot.entity.position)}`)
            await delay(5000)
          } else if (classification === 'final-world') {
            if (Date.now() - state.homeSentAt >= 90000) {
              state.homeSentAt = Date.now()
              bot.chat('/home platform')
              log(`[HOME] sent /home platform from=${formatPosition(bot.entity.position)}`)
            }
            await delay(5000)
          } else {
            const portal = nearestPortal(bot, 32, 8)
            if (portal) {
              await enterKnownLobbyPortal(bot, { approach: portal, portal }, 'discovered-portal')
            } else {
              log(`[UNKNOWN] no portal detected at ${formatPosition(bot.entity.position)}; waiting`)
              await delay(3000)
            }
          }
        } catch (err) {
          log(`[LOOP-WARN] ${err?.stack || err?.message || err}`)
          stopMovement(bot)
        } finally {
          state.busy = false
        }
      })()
    }, 500)

    const timeoutTimer = setTimeout(() => {
      finish({ success: false, reason: 'session-timeout' })
    }, settings.sessionTimeoutMs)
  })
}

async function main() {
  const settings = {
    username: requiredEnv('TEST_BOT_USERNAME'),
    loginPassword: requiredEnv('TEST_BOT_PASSWORD'),
    proxyHost: requiredEnv('TEST_PROXY_HOST'),
    proxyPort: envNumber('TEST_PROXY_PORT', 1080),
    proxyUsername: requiredEnv('TEST_PROXY_USERNAME'),
    proxyPassword: requiredEnv('TEST_PROXY_PASSWORD'),
    serverPort: envNumber('TEST_SERVER_PORT', 25565),
    version: String(process.env.TEST_MC_VERSION || '26.1.2'),
    hosts: String(process.env.TEST_SERVER_HOSTS || 'alt3.6b6t.org,play.6b6t.org,alt.6b6t.org')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    target: {
      x: envNumber('TEST_TARGET_X', Number.NaN),
      y: envNumber('TEST_TARGET_Y', Number.NaN),
      z: envNumber('TEST_TARGET_Z', Number.NaN)
    },
    maxLoginProbeCycles: Math.max(1, envNumber('TEST_LOGIN_PROBE_CYCLES', 4)),
    sessionTimeoutMs: Math.max(60000, envNumber('TEST_SESSION_TIMEOUT_MS', 300000)),
    retryDelayMs: Math.max(31000, envNumber('TEST_RETRY_DELAY_MS', 35000))
  }
  if (!isFinitePosition(settings.target)) throw new Error('TEST_TARGET_X, TEST_TARGET_Y, and TEST_TARGET_Z must be finite numbers')

  log(`[START] isolated live test account=${settings.username} hosts=${settings.hosts.join(',')} target=${formatPosition(settings.target)} credentialsSource=environment`)
  const results = []
  for (let index = 0; index < settings.hosts.length; index += 1) {
    const result = await createSession(settings, settings.hosts[index], index + 1)
    results.push(result)
    if (result.success) {
      log(`[DONE] platform reached result=${JSON.stringify(result)}`)
      return
    }
    if (index < settings.hosts.length - 1) {
      log(`[RETRY] waiting ${settings.retryDelayMs}ms before next host; previous=${result.reason}`)
      await delay(settings.retryDelayMs)
    }
  }

  log(`[FAILED] all isolated sessions ended without reaching platform results=${JSON.stringify(results)}`)
  process.exitCode = 1
}

main().catch((err) => {
  console.error(`[${timestamp()}] [FATAL] ${err?.stack || err?.message || err}`)
  process.exitCode = 1
})
