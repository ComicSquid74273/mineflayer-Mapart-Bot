// Safety net: GoalChanged rejections from mineflayer-pathfinder can become unhandled
// when the watchdog fires setGoal(null) after a goto already resolved (race condition).
// These are always safe to swallow — navigation will retry at the call site.
process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason || '').toLowerCase()
  if (msg.includes('goal was changed') || msg.includes('goalchanged')) return
  throw reason
})

const restockFailureCache = new Map()
const unavailableMaterialCache = new Set()
const duperBrokenGroupStateCache = new Map()
const DEFAULT_DUPER_BROKEN_ALERT_AFTER_MS = 35 * 60 * 1000
const DEFAULT_DUPER_BROKEN_REPAIR_CHECK_MS = 15 * 60 * 1000
const PROCESS_STARTED_AT = new Date().toISOString()
const PROCESS_INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
const processMetricsState = {
  sampledAtMs: Date.now(),
  cpuUsage: process.cpuUsage()
}
// Persists across session reconnects within one process run.
// Set true by any 'start' command; false by any pause/stop or dashboard-disconnect.
let printingIntentActive = false
const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const os = require('os')
const path = require('path')
const { AsyncLocalStorage } = require('async_hooks')
const mineflayer = require('mineflayer')
const nbt = require('prismarine-nbt')
const { pathfinder, Movements, goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder')
const { createPlacementWorkload } = require('./placement/workload')

const placementWorkload = createPlacementWorkload({
  toNumber,
  delay,
  GoalNear,
  estimateNeededFromLookahead,
  ensureMaterialsForTargets,
  restockMaterial: waitForRequiredMaterialRestock,
  countInventoryItems,
  recoverMissingItemInventoryDesync,
  findNervScannerCandidate,
  placeNervScannerTarget,
  assertRuntimeContinue
})

const CONFIG_FILE = path.resolve(process.cwd(), 'nerv-printer-config', '_configs', 'nerv-printer-config.json')
const LEGACY_CONFIG_FILE = path.resolve(process.cwd(), 'nerv-printer-config.json')
const DEFAULT_IMPORTED_CONFIG_FILE = path.resolve(process.cwd(), 'nerv-printer-config', '_configs', 'carpet-printer-config.json')
const TEST_BOT_CONFIG_FILE = path.resolve(process.cwd(), 'config.test.json')
const DEFAULT_DUPER_GROUP_STATE_FILE = path.resolve(process.cwd(), 'nerv-printer-config', 'duper-group-state.json')
const EXPLICIT_CONFIG_FILE = getCliValue('--config') || getCliValue('--config-file') || process.env.NERV_CONFIG_FILE || null
const LOG_FILE = path.resolve(process.cwd(), 'logs', 'nerv-printer.log')
const logContext = new AsyncLocalStorage()
const botLogStreams = new Map()
const throttledLogState = new Map()
const stdinCommandState = {
  initialized: false,
  rl: null,
  status: null,
  verificationWaiter: null,
  runtimeControl: null,
  resetCurrentNbt: null
}

function getBootstrapLogConfig() {
  const defaults = { rotateHours: 12, retentionHours: 72 }
  const userConfigPath = getUserConfigPath()
  let fileLogging = null

  if (fs.existsSync(userConfigPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'))
      fileLogging = parsed?.logging && typeof parsed.logging === 'object' ? parsed.logging : null
    } catch {
      fileLogging = null
    }
  }

  const rotateHours = Math.max(0, toNumber(process.env.NERV_LOG_ROTATE_HOURS, toNumber(fileLogging?.rotateHours, defaults.rotateHours)))
  const retentionHours = Math.max(0, toNumber(process.env.NERV_LOG_RETENTION_HOURS, toNumber(fileLogging?.retentionHours, defaults.retentionHours)))

  return {
    rotateHours,
    retentionHours,
    rotateMs: rotateHours > 0 ? rotateHours * 60 * 60 * 1000 : 0,
    retentionMs: retentionHours > 0 ? retentionHours * 60 * 60 * 1000 : 0
  }
}

function formatLogArg(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function terminalLogsDisabledByCli() {
  const args = process.argv.slice(2)
  const disabledFlags = new Set([
    '--disable-logs',
    '--disableLogs',
    '--disable-terminal-logs',
    '--no-terminal-logs',
    '--log-to-file-only',
    '--silent',
    '--quiet'
  ])
  if (args.some((arg) => disabledFlags.has(arg))) return true
  const envValue = String(process.env.NERV_DISABLE_TERMINAL_LOGS || '').toLowerCase()
  return envValue === '1' || envValue === 'true' || envValue === 'yes'
}

function initLogger() {
  const logDir = path.dirname(LOG_FILE)
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }

  const terminalLogsEnabled = !terminalLogsDisabledByCli()
  const logConfig = getBootstrapLogConfig()
  const openLogState = (filePath) => ({ filePath, stream: fs.createWriteStream(filePath, { flags: 'a' }) })
  const streamState = openLogState(LOG_FILE)
  let rotationTimer = null
  let rotationInProgress = false
  const queuedWrites = []

  const buildLogArchivePath = (filePath) => {
    const parsed = path.parse(filePath)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-')
    return path.join(parsed.dir, `${parsed.name}-${stamp}${parsed.ext}`)
  }

  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const pruneArchivedLogs = (filePath) => {
    if (logConfig.retentionMs <= 0) return
    const parsed = path.parse(filePath)
    const now = Date.now()
    const archivePattern = new RegExp(`^${escapeRegExp(parsed.name)}-\\d{8}-\\d{6}Z${escapeRegExp(parsed.ext)}$`)
    for (const entry of fs.readdirSync(parsed.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !archivePattern.test(entry.name)) continue
      const archivePath = path.join(parsed.dir, entry.name)
      try {
        const stats = fs.statSync(archivePath)
        if (now - stats.mtimeMs >= logConfig.retentionMs) {
          fs.unlinkSync(archivePath)
        }
      } catch {
        // Ignore individual prune failures.
      }
    }
  }

  const flushQueuedWrites = () => {
    if (rotationInProgress || !queuedWrites.length) return
    const pending = queuedWrites.splice(0, queuedWrites.length)
    for (const entry of pending) {
      writeNow(entry.level, entry.args)
    }
  }

  const closeLogState = (state) => new Promise((resolve) => {
    if (!state?.stream) {
      resolve()
      return
    }
    state.stream.end(() => resolve())
  })

  const rotateLogState = async (state) => {
    if (!state?.filePath) return
    await closeLogState(state)
    try {
      if (fs.existsSync(state.filePath)) {
        const stats = fs.statSync(state.filePath)
        if (stats.size > 0) {
          fs.renameSync(state.filePath, buildLogArchivePath(state.filePath))
        }
      }
    } catch (error) {
      if (terminalLogsEnabled) {
        original.warn(`[${new Date().toISOString()}]`, `[LOG-WARN] log rotation failed for ${state.filePath}: ${error?.message || error}`)
      }
    }
    state.stream = fs.createWriteStream(state.filePath, { flags: 'a' })
    pruneArchivedLogs(state.filePath)
  }

  const scheduleRotation = () => {
    if (logConfig.rotateMs <= 0) return
    rotationTimer = setTimeout(() => {
      void rotateAllLogs()
    }, logConfig.rotateMs)
    rotationTimer.unref?.()
  }

  const rotateAllLogs = async () => {
    if (rotationInProgress) return
    rotationInProgress = true
    try {
      await rotateLogState(streamState)
      for (const state of botLogStreams.values()) {
        await rotateLogState(state)
      }
    } finally {
      rotationInProgress = false
      flushQueuedWrites()
      scheduleRotation()
    }
  }

  const getBotStream = (botName) => {
    const safeName = sanitizeSyncName(botName)
    if (!safeName) return null
    if (!botLogStreams.has(safeName)) {
      botLogStreams.set(safeName, openLogState(path.join(logDir, `nerv-printer-${safeName}.log`)))
    }
    return botLogStreams.get(safeName).stream
  }
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error
  }

  const writeNow = (level, args) => {
    const message = args.map(formatLogArg).join(' ')
    const context = logContext.getStore()
    const botName = context?.botName || null
    const prefix = botName ? ` [${botName}]` : ''
    const line = `[${new Date().toISOString()}] [${level}]${prefix} ${message}\n`
    streamState.stream.write(line)
    const botStream = botName ? getBotStream(botName) : null
    if (botStream) botStream.write(line)
  }

  const write = (level, args) => {
    if (rotationInProgress) {
      queuedWrites.push({ level, args })
      return
    }
    writeNow(level, args)
  }

  console.log = (...args) => {
    if (terminalLogsEnabled) original.log(`[${new Date().toISOString()}]`, ...args)
    write('INFO', args)
  }

  console.warn = (...args) => {
    if (terminalLogsEnabled) original.warn(`[${new Date().toISOString()}]`, ...args)
    write('WARN', args)
  }

  console.error = (...args) => {
    if (terminalLogsEnabled) original.error(`[${new Date().toISOString()}]`, ...args)
    write('ERROR', args)
  }

  process.on('exit', () => {
    if (rotationTimer) clearTimeout(rotationTimer)
    streamState.stream.end()
    for (const botState of botLogStreams.values()) {
      botState.stream.end()
    }
  })

  if (terminalLogsEnabled) original.log(`[${new Date().toISOString()}]`, `[LOG] Writing runtime logs to ${LOG_FILE}`)
  write('INFO', [`[LOG] Writing runtime logs to ${LOG_FILE}`])
  if (logConfig.rotateMs > 0) {
    write('INFO', [`[LOG] Rotation enabled every ${logConfig.rotateHours}h; archived logs kept for ${logConfig.retentionHours}h.`])
    scheduleRotation()
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function getUserConfigPath() {
  if (EXPLICIT_CONFIG_FILE) return path.resolve(process.cwd(), EXPLICIT_CONFIG_FILE)
  if (fs.existsSync(CONFIG_FILE)) return CONFIG_FILE
  if (fs.existsSync(LEGACY_CONFIG_FILE)) return LEGACY_CONFIG_FILE
  return CONFIG_FILE
}

function toNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function buildProcessRuntimeMetrics() {
  const nowMs = Date.now()
  const previousCpu = processMetricsState.cpuUsage
  const previousSampledAtMs = processMetricsState.sampledAtMs
  const currentCpu = process.cpuUsage()
  const memory = process.memoryUsage()
  const cpuDelta = {
    user: Math.max(0, currentCpu.user - toNumber(previousCpu?.user, currentCpu.user)),
    system: Math.max(0, currentCpu.system - toNumber(previousCpu?.system, currentCpu.system))
  }
  const wallMs = Math.max(1, nowMs - toNumber(previousSampledAtMs, nowMs))
  const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000
  const cpuPercent = Math.max(0, (cpuMs / wallMs) * 100)

  processMetricsState.sampledAtMs = nowMs
  processMetricsState.cpuUsage = currentCpu

  return {
    cpuPercent: Number(cpuPercent.toFixed(1)),
    rssBytes: Math.max(0, toNumber(memory.rss, 0)),
    heapUsedBytes: Math.max(0, toNumber(memory.heapUsed, 0)),
    heapTotalBytes: Math.max(0, toNumber(memory.heapTotal, 0)),
    uptimeSeconds: Math.max(0, Math.round(process.uptime()))
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveUniqueFilePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath
  const parsed = path.parse(targetPath)
  for (let index = 2; index < 10000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error(`could not resolve unique file path for ${targetPath}`)
}

function observeBackgroundTask(promise) {
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {})
  }
  return promise
}

class RuntimeStopRequestedError extends Error {
  constructor(detail = 'pausing-after-current-step') {
    super('runtime pause requested; returning to idle')
    this.name = 'RuntimeStopRequestedError'
    this.code = 'RUNTIME_STOP_REQUESTED'
    this.detail = detail
  }
}

function isRuntimeStopRequested(config) {
  return config?.__runtimeControl?.isStopRequested?.() === true ||
    config?.__dashboardRuntime?.isStopRequested?.() === true
}

function isRuntimeStopError(err) {
  return err?.code === 'RUNTIME_STOP_REQUESTED' || err instanceof RuntimeStopRequestedError
}

function isGoalChangedError(err) {
  return String(err?.message || err || '').toLowerCase().includes('goal was changed') ||
    String(err?.message || err || '').toLowerCase().includes('goalchanged')
}

function assertRuntimeContinue(bot, config, detail = 'pausing-after-current-step') {
  if (!isRuntimeStopRequested(config)) return
  const dashboardRuntime = config?.__dashboardRuntime
  dashboardRuntime?.setStatusDetail?.(detail)
  try {
    config?.__runtimeStopHandler?.(detail)
  } catch (err) {
    console.log(`[CONTROL-WARN] stop progress snapshot failed: ${err?.message || err}`)
  }
  stopBotMovement(bot)
  throw new RuntimeStopRequestedError(detail)
}

function placementNoiseLogsEnabled(config) {
  return config?.advanced?.placementNoiseLogs !== false
}

function getBotLatencyMs(bot) {
  const playerPing = bot?.players?.[bot?.username]?.ping
  if (typeof playerPing === 'number' && playerPing > 0) return Math.round(playerPing)
  const namedPlayer = bot?.username ? Object.values(bot?.players || {}).find((player) => player?.username === bot.username) : null
  if (typeof namedPlayer?.ping === 'number' && namedPlayer.ping > 0) return Math.round(namedPlayer.ping)
  const clientLatency = bot?._client?.latency
  if (typeof clientLatency === 'number' && clientLatency > 0) return Math.round(clientLatency)
  return null
}

function logPingDiagnostic(bot, config, reason, details = {}, options = {}) {
  const advanced = config?.advanced || {}
  if (advanced.pingDiagnosticsEnabled === false) return

  const pingMs = getBotLatencyMs(bot)
  const thresholdMs = Math.max(0, toNumber(advanced.pingDiagnosticsThresholdMs, 30))
  const force = options.force === true
  if (!force && (pingMs == null || pingMs <= thresholdMs)) return

  const fields = [
    options.tag || (pingMs != null && pingMs > thresholdMs ? '[PING-WARN]' : '[PING]'),
    `reason=${reason}`,
    `ping=${pingMs == null ? 'unknown' : `${pingMs}ms`}`,
    `threshold=${thresholdMs}ms`
  ]

  for (const [key, value] of Object.entries(details || {})) {
    if (value == null || value === '') continue
    fields.push(`${key}=${String(value).replace(/\s+/g, '_')}`)
  }

  if (force) {
    console.log(fields.join(' '))
    return
  }

  logThrottled(options.throttleKey || `ping-${reason}`, fields.join(' '), {
    intervalMs: toNumber(advanced.pingDiagnosticsLogEveryMs, 5000)
  })
}

function getLatencyBackoffSettings(config) {
  const advanced = config?.advanced || {}
  return {
    enabled: advanced.latencyAdaptiveBackoffEnabled !== false,
    normalMs: Math.max(1, toNumber(advanced.latencyNormalThresholdMs, 120)),
    highMs: Math.max(1, toNumber(advanced.latencyHighThresholdMs, 90)),
    severeMs: Math.max(1, toNumber(advanced.latencySevereThresholdMs, 290)),
    criticalMs: Math.max(1, toNumber(advanced.latencyCriticalThresholdMs, 490)),
    resumeMs: Math.max(1, toNumber(advanced.latencyResumeThresholdMs, 85)),
    minDelayMs: Math.max(0, toNumber(advanced.latencyActionMinDelayMs, 100)),
    maxDelayMs: Math.max(0, toNumber(advanced.latencyActionMaxDelayMs, 1500)),
    criticalWaitMs: Math.max(0, toNumber(advanced.latencyCriticalWaitMs, 15000)),
    pollMs: Math.max(50, toNumber(advanced.latencyBackoffPollMs, 500)),
    logEveryMs: Math.max(1000, toNumber(advanced.latencyBackoffLogEveryMs, 5000)),
    timeoutMultiplier: Math.max(1, toNumber(advanced.latencyTimeoutMultiplier, 3)),
    timeoutMaxMs: Math.max(1000, toNumber(advanced.latencyTimeoutMaxMs, 12000)),
    disableSprintAboveMs: Math.max(1, toNumber(advanced.latencyDisableSprintAboveMs, 90)),
    movementPauseMaxMs: Math.max(0, toNumber(advanced.latencyMovementPauseMaxMs, 450))
  }
}

function getLatencyBackoffState(bot, config = null) {
  const settings = getLatencyBackoffSettings(config || bot?.__nervConfig)
  const pingMs = getBotLatencyMs(bot)
  if (!settings.enabled || pingMs == null) {
    return { settings, pingMs, level: 'normal', delayMs: 0, shouldPause: false, shouldDisableSprint: false }
  }

  const shouldDisableSprint = pingMs >= settings.disableSprintAboveMs
  if (pingMs < settings.highMs) {
    return { settings, pingMs, level: 'normal', delayMs: 0, shouldPause: false, shouldDisableSprint }
  }

  const overHigh = Math.max(0, pingMs - settings.highMs)
  const scaledDelay = settings.minDelayMs + Math.round(overHigh * 2)
  const delayMs = Math.min(settings.maxDelayMs, Math.max(settings.minDelayMs, scaledDelay))
  const level = pingMs >= settings.criticalMs ? 'critical' : (pingMs >= settings.severeMs ? 'severe' : 'high')
  return {
    settings,
    pingMs,
    level,
    delayMs,
    shouldPause: pingMs >= settings.criticalMs,
    shouldDisableSprint
  }
}

function shouldUseLatencySafeMode(bot, config = null, label = 'action') {
  const resolvedConfig = config || bot?.__nervConfig || {}
  const state = getLatencyBackoffState(bot, resolvedConfig)
  const advanced = resolvedConfig.advanced || {}
  const enterMs = Math.max(1, toNumber(advanced.latencySafeModeEnterMs, state.settings.highMs))
  const resumeMs = Math.max(1, toNumber(advanced.latencySafeModeResumeMs, state.settings.resumeMs))
  const modes = resolvedConfig.__latencySafeModeState || (resolvedConfig.__latencySafeModeState = {})
  const key = String(label || 'action')
  const wasActive = modes[key] === true

  let active = wasActive
  if (state.settings.enabled === false || state.pingMs == null) {
    active = false
  } else if (wasActive) {
    active = state.pingMs > resumeMs
  } else {
    active = state.pingMs > enterMs
  }

  if (active !== wasActive) {
    modes[key] = active
    const status = active ? 'enabled' : 'recovered'
    const threshold = active ? enterMs : resumeMs
    logThrottled(`latency-safe-${key}-${status}`, `[LATENCY-SAFE] ${key}: ${status} ping=${state.pingMs == null ? 'unknown' : `${state.pingMs}ms`} threshold=${threshold}ms.`, {
      intervalMs: state.settings.logEveryMs
    })
  } else {
    modes[key] = active
  }

  return { active, state, enterMs, resumeMs }
}

function getLatencyAdjustedTimeoutMs(bot, config, timeoutMs, minimumMs = 0) {
  const base = Math.max(0, toNumber(timeoutMs, 0))
  const min = Math.max(0, toNumber(minimumMs, 0))
  const state = getLatencyBackoffState(bot, config)
  const pingMs = state.pingMs
  if (pingMs == null || state.level === 'normal') return Math.max(base, min)
  const adjusted = Math.max(base, min, Math.ceil(pingMs * state.settings.timeoutMultiplier) + state.delayMs)
  return Math.min(state.settings.timeoutMaxMs, adjusted)
}

function stopLagSensitiveMovement(bot) {
  if (!bot || typeof bot.setControlState !== 'function') return
  for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
    try { bot.setControlState(control, false) } catch { }
  }
}

async function applyAdaptiveLatencyBackoff(bot, config, reason = 'action', options = {}) {
  const state = getLatencyBackoffState(bot, config)
  if (!state.settings.enabled || state.pingMs == null || state.level === 'normal') return state

  const allowCriticalWait = options.allowCriticalWait !== false
  const pauseMovement = options.pauseMovement !== false
  const maxWaitMs = Math.max(0, toNumber(options.maxWaitMs, state.settings.criticalWaitMs))

  if (state.shouldPause && allowCriticalWait && maxWaitMs > 0) {
    const startedAt = Date.now()
    logThrottled(`latency-critical-${reason}`, `[LATENCY-BACKOFF] ${reason}: ping=${state.pingMs}ms level=${state.level}; pausing actions until <=${state.settings.resumeMs}ms or ${maxWaitMs}ms.`, {
      intervalMs: state.settings.logEveryMs
    })
    while (Date.now() - startedAt < maxWaitMs) {
      if (pauseMovement) stopLagSensitiveMovement(bot)
      await delay(state.settings.pollMs)
      const next = getLatencyBackoffState(bot, config)
      if (next.pingMs == null || next.pingMs <= state.settings.resumeMs) return next
    }
  }

  const latest = getLatencyBackoffState(bot, config)
  if (latest.delayMs > 0) {
    logThrottled(`latency-backoff-${reason}`, `[LATENCY-BACKOFF] ${reason}: ping=${latest.pingMs}ms level=${latest.level} delay=${latest.delayMs}ms sprintDisabled=${latest.shouldDisableSprint === true}`, {
      intervalMs: latest.settings.logEveryMs
    })
    await delay(latest.delayMs)
  }
  return latest
}

function installAdaptiveLatencyGuard(bot, config) {
  if (!bot || bot.__nervLatencyGuardInstalled) return
  bot.__nervLatencyGuardInstalled = true
  bot.__nervConfig = config

  const originalSetControlState = typeof bot.setControlState === 'function' ? bot.setControlState.bind(bot) : null
  if (originalSetControlState) {
    bot.setControlState = (control, state) => {
      if (control === 'sprint' && state === true && getLatencyBackoffState(bot, config).shouldDisableSprint) {
        return originalSetControlState(control, false)
      }
      return originalSetControlState(control, state)
    }
  }

  const wrapAsyncAction = (name, reason, options = {}) => {
    if (typeof bot[name] !== 'function' || bot[name].__nervLatencyWrapped) return
    const original = bot[name].bind(bot)
    const wrapped = async (...args) => {
      await applyAdaptiveLatencyBackoff(bot, config, `${reason}-before`, options)
      const result = await original(...args)
      await applyAdaptiveLatencyBackoff(bot, config, `${reason}-after`, {
        ...options,
        allowCriticalWait: false,
        maxWaitMs: Math.min(options.maxWaitMs || 1000, 1000)
      })
      return result
    }
    wrapped.__nervLatencyWrapped = true
    bot[name] = wrapped
  }

  wrapAsyncAction('clickWindow', 'window-click')
  wrapAsyncAction('openContainer', 'open-container', { pauseMovement: true })
  wrapAsyncAction('openBlock', 'open-block', { pauseMovement: true })
  wrapAsyncAction('openAnvil', 'open-anvil', { pauseMovement: true })
  wrapAsyncAction('activateBlock', 'activate-block', { pauseMovement: true })
  wrapAsyncAction('activateItem', 'activate-item', { pauseMovement: true })
  wrapAsyncAction('placeBlock', 'place-block', { pauseMovement: true })
  wrapAsyncAction('_genericPlace', 'generic-place', { pauseMovement: true })
  wrapAsyncAction('equip', 'equip')
  wrapAsyncAction('dig', 'dig', { pauseMovement: true })
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return readJson(filePath)
  } catch {
    return null
  }
}

function writeJson(filePath, data) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function toTimestampMs(value, fallback = 0) {
  if (Number.isFinite(Number(value))) return Number(value)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function getDuperGroupStateFilePath(config) {
  const configured = config?.advanced?.duperGroupStateFile || config?.advanced?.duperBrokenStateFile
  if (configured) return path.resolve(process.cwd(), String(configured))
  return DEFAULT_DUPER_GROUP_STATE_FILE
}

function normalizeDuperGroupState(raw) {
  const groups = raw && typeof raw.groups === 'object' && raw.groups ? raw.groups : {}
  return {
    version: 1,
    updatedAt: raw?.updatedAt || new Date().toISOString(),
    groups
  }
}

function loadDuperGroupStateFile(config) {
  const filePath = getDuperGroupStateFilePath(config)
  const raw = readOptionalJson(filePath)
  return normalizeDuperGroupState(raw)
}

function saveDuperGroupStateFile(config, state) {
  const filePath = getDuperGroupStateFilePath(config)
  writeJson(filePath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    groups: state && typeof state.groups === 'object' && state.groups ? state.groups : {}
  })
}

function getDuperGroupStateKey(blockName, spots) {
  const chestKeys = (Array.isArray(spots) ? spots : [])
    .map((spot) => materialChestPositionKey(spot))
    .filter(Boolean)
    .sort()
  return `${String(blockName || '')}|${chestKeys.join(';')}`
}

function hasPersistedBrokenDuperGroups(config) {
  const state = loadDuperGroupStateFile(config)
  return Object.values(state.groups).some((entry) => entry && (entry.status === 'broken' || entry.alertActive === true))
}

function logThrottled(key, message, options = {}) {
  const intervalMs = Math.max(1000, toNumber(options.intervalMs, 30000))
  const level = options.level === 'warn' ? 'warn' : (options.level === 'error' ? 'error' : 'log')
  const now = Date.now()
  const current = throttledLogState.get(key)

  if (!current || now >= current.nextAllowedAt || current.lastMessage !== message) {
    if (current && current.suppressed > 0) {
      console[level](`[LOG-THROTTLE] ${key}: suppressed ${current.suppressed} repeated message(s) over ${Math.max(1, Math.round((now - current.windowStartedAt) / 1000))}s.`)
    }
    throttledLogState.set(key, {
      lastMessage: message,
      nextAllowedAt: now + intervalMs,
      suppressed: 0,
      windowStartedAt: now
    })
    console[level](message)
    return
  }

  current.suppressed += 1
  throttledLogState.set(key, current)
}

function reportDashboardWarning(config, category, message, details = {}) {
  const runtime = config?.__dashboardRuntime
  if (runtime && typeof runtime.reportWarning === 'function') {
    runtime.reportWarning(category, message, details)
  }
}

function setDashboardAlert(config, category, message, details = {}, level = 'warn') {
  const runtime = config?.__dashboardRuntime
  if (runtime && typeof runtime.setAlert === 'function') {
    runtime.setAlert(category, message, details, level)
  }
}

function clearDashboardAlert(config, category) {
  const runtime = config?.__dashboardRuntime
  if (runtime && typeof runtime.clearAlert === 'function') {
    runtime.clearAlert(category)
  }
}

function reportSupportStockWarning(config, message, details = {}) {
  console.log(`[SUPPORT-STOCK-WARN] ${message}`)
  reportDashboardWarning(config, 'support-stock', message, details)
}

function getDashboardConfig(config) {
  const raw = config?.dashboard
  const envEnabled = String(process.env.NERV_DASHBOARD_ENABLED || '').toLowerCase()
  const enabled = raw?.enabled === true || envEnabled === '1' || envEnabled === 'true' || envEnabled === 'yes'
  return {
    enabled,
    serviceUrl: String(raw?.serviceUrl || process.env.NERV_DASHBOARD_URL || 'http://127.0.0.1:4080').trim().replace(/\/$/, ''),
    hostLabel: String(raw?.hostLabel || process.env.NERV_DASHBOARD_HOST_LABEL || process.env.COMPUTERNAME || os.hostname() || 'unknown-host').trim(),
    heartbeatMs: Math.max(1000, toNumber(raw?.heartbeatMs, 5000)),
    commandPollMs: Math.max(1000, toNumber(raw?.commandPollMs, 3000)),
    queuePrefetchHighWater: Math.max(1, Math.floor(toNumber(raw?.queuePrefetchHighWater, 10))),
    queuePrefetchLowWater: Math.max(0, Math.floor(toNumber(raw?.queuePrefetchLowWater, 3))),
    nodeInventoryScanMs: Math.max(5000, toNumber(raw?.nodeInventoryScanMs, 60000)),
    idleWindowMs: Math.max(3000, toNumber(raw?.idleWindowMs, 15000)),
    staleMs: Math.max(5000, toNumber(raw?.staleMs, 20000))
  }
}

function isDashboardEnabled(config) {
  const dashboard = getDashboardConfig(config)
  return dashboard.enabled && Boolean(dashboard.serviceUrl)
}

function isWaitForCommandEnabled() {
  if (hasCliFlag('--wait-for-command') || hasCliFlag('--wait')) return true
  const envValue = String(process.env.NERV_WAIT_FOR_COMMAND || '').toLowerCase()
  return envValue === '1' || envValue === 'true' || envValue === 'yes'
}

function createRuntimeControl(config = null) {
  const state = {
    lastSource: '',
    runActive: false,
    startRequested: false,
    stopRequested: false,
    updatedAt: Date.now()
  }

  function syncStatus() {
    setRuntimeCommandStatus({
      controlState: state.runActive
        ? 'running'
        : (state.stopRequested ? 'paused' : (state.startRequested ? 'start-requested' : 'idle-ready')),
      controlSource: state.lastSource || '',
      controlUpdatedAt: state.updatedAt
    })
  }

  return {
    attach() {
      stdinCommandState.runtimeControl = this
      syncStatus()
    },
    detach() {
      if (stdinCommandState.runtimeControl === this) {
        stdinCommandState.runtimeControl = null
      }
    },
    requestStart(source = 'terminal') {
      if (config) setOperatorPaused(config, false, source)
      state.startRequested = true
      state.stopRequested = false
      state.lastSource = source
      state.updatedAt = Date.now()
      syncStatus()
      return `start requested via ${source}`
    },
    requestStop(source = 'terminal') {
      if (config) setOperatorPaused(config, true, source)
      state.startRequested = false
      state.stopRequested = true
      state.lastSource = source
      state.updatedAt = Date.now()
      syncStatus()
      return 'pause requested; bot will remain connected and go idle after the current run'
    },
    consumeStartRequest() {
      if (!state.startRequested) return false
      state.startRequested = false
      state.stopRequested = false
      state.updatedAt = Date.now()
      syncStatus()
      return true
    },
    isStopRequested() {
      return state.stopRequested === true
    },
    isRunActive() {
      return state.runActive === true
    },
    markRunStarted(source = 'runtime') {
      state.runActive = true
      state.lastSource = source
      state.updatedAt = Date.now()
      syncStatus()
    },
    markRunCompleted() {
      state.runActive = false
      state.updatedAt = Date.now()
      syncStatus()
    }
  }
}

function normalizeDashboardPhase(phase) {
  const value = String(phase || '').trim().toLowerCase()
  if (!value) return 'idle'
  if (value === 'post_print') return 'post-print'
  if (value === 'waiting_master' || value === 'waiting_slaves_ready' || value === 'waiting_slaves_finished' || value === 'ready') return 'idle'
  if (value === 'connected' || value === 'starting') return 'starting'
  if (value === 'repair' || value.startsWith('repair')) return 'repair'
  if (value === 'post-print') return 'post-print'
  if (value.startsWith('post_print')) return 'post-print'
  if (value === 'printing' || value.startsWith('printing')) return 'printing'
  if (value === 'rescan' || value.startsWith('rescan')) return 'rescan'
  if (value === 'cleanup' || value.startsWith('cleanup')) return 'cleanup'
  if (value === 'waiting-spawn' || value === 'waiting_spawn') return 'waiting-spawn'
  if (value === 'stopped' || value === 'crashed' || value === 'idle') return value
  return value
}

function mapDashboardLocation(runtime) {
  const state = String(runtime?.classification?.state || '').toLowerCase()
  if (runtime?.classification?.platform === true || state === 'platform') return 'platform'
  if (state.includes('lobby') || state.includes('portal')) return state.includes('spawn') ? 'spawn' : 'lobby'
  if (state.includes('platform')) return 'platform'
  if (state.includes('spawn')) return 'spawn'
  if (state.includes('printer')) return 'printer-area'
  if (state === 'off-platform' && isPositionUsable(runtime?.position)) return 'printer-area'
  return 'unknown'
}

function mapDashboardLocationDetail(runtime) {
  const classification = runtime?.classification || {}
  const state = String(classification.state || '').toLowerCase()
  const regionName = String(classification.region?.name || '').trim().toLowerCase()
  if (classification.platform === true || state === 'platform') return 'platform'
  if (regionName) return regionName
  if (state) return state
  if (isPositionUsable(runtime?.position)) return 'printer-area'
  return 'unknown'
}

function stripMinecraftChatFormatting(text) {
  return String(text || '').replace(/§[0-9A-FK-OR]/gi, '').trim()
}

function extractBotDeathMessage(text, botName) {
  const clean = stripMinecraftChatFormatting(text).replace(/\s+/g, ' ').trim()
  const name = String(botName || '').trim()
  if (!clean || !name) return ''
  const lower = clean.toLowerCase()
  if (!lower.includes(name.toLowerCase())) return ''

  const deathPatterns = [
    /\bwas slain by\b/i,
    /\bwas shot by\b/i,
    /\bwas killed by\b/i,
    /\bwas blown up by\b/i,
    /\bwas fireballed by\b/i,
    /\bwas impaled by\b/i,
    /\bwas squashed by\b/i,
    /\bwas doomed to fall\b/i,
    /\bwas pricked to death\b/i,
    /\bwas squashed too much\b/i,
    /\bwas poked to death\b/i,
    /\bwas stung to death\b/i,
    /\bwas obliterated by\b/i,
    /\bfell from a high place\b/i,
    /\bfell out of the world\b/i,
    /\bhit the ground too hard\b/i,
    /\bwent up in flames\b/i,
    /\bburned to death\b/i,
    /\bdrowned\b/i,
    /\bsuffocated in a wall\b/i,
    /\bstarved to death\b/i,
    /\bwithered away\b/i,
    /\bblew up\b/i,
    /\bexperienced kinetic energy\b/i,
    /\bwalked into danger zone\b/i,
    /\bdidn't want to live in the same world as\b/i
  ]
  return deathPatterns.some((pattern) => pattern.test(clean)) ? clean : ''
}

function mapPostPrintStatusDetail(step) {
  const value = String(step || '').trim().toLowerCase()
  if (value.startsWith('blocked-')) return `blocked-${mapPostPrintStatusDetail(value.slice('blocked-'.length))}`
  switch (value) {
    case 'withdraw':
      return 'preparing-map'
    case 'fill_map':
    case 'fill-map':
      return 'filling-map'
    case 'cartography':
      return 'locking-map'
    case 'rename_store':
    case 'rename-store':
      return 'naming'
    case 'reset':
      return 'resetting'
    case 'center':
      return 'centering'
    case 'done':
      return 'post-print-done'
    default:
      return 'post-print'
  }
}

function createDashboardRequest(urlValue, method, body = null, options = {}) {
  const target = new URL(urlValue)
  const transport = target.protocol === 'https:' ? https : http
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const timeoutMs = Math.max(1000, toNumber(options.timeoutMs, 10000))
  const headers = {
    accept: 'application/json'
  }
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.length)
  }

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      timeout: timeoutMs
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = null
        }
        resolve({
          statusCode: toNumber(res.statusCode, 0),
          body: json,
          text
        })
      })
    })

    req.on('timeout', () => req.destroy(new Error(`dashboard request timeout: ${method} ${urlValue}`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function downloadDashboardFile(urlValue, filePath) {
  const target = new URL(urlValue)
  const transport = target.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      timeout: 15000
    }, (res) => {
      if (toNumber(res.statusCode, 0) < 200 || toNumber(res.statusCode, 0) >= 300) {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => reject(new Error(`dashboard file download failed: ${res.statusCode} ${Buffer.concat(chunks).toString('utf8')}`)))
        return
      }
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const stream = fs.createWriteStream(filePath)
      res.pipe(stream)
      stream.on('finish', () => {
        stream.close(() => resolve(filePath))
      })
      stream.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`dashboard download timeout: ${urlValue}`)))
    req.on('error', reject)
    req.end()
  })
}

function getTpaTarget(config) {
  const activeProfile = config?.connection?.active
  const profileBot = activeProfile ? config?.connection?.profiles?.[activeProfile]?.bot : null
  const tpa = profileBot?.platformRecoveryTpa || config?.bot?.platformRecoveryTpa
  if (!tpa?.enabled || !tpa?.command) return null
  const match = String(tpa.command || '').match(/\/tpa\s+(.+)/i)
  return match ? String(match[1]).trim() : null
}

function createDashboardRuntime(bot, config, sessionNumber, runtimeControl) {
  const dashboard = getDashboardConfig(config)
  if (!dashboard.enabled || !dashboard.serviceUrl) return null

  const botName = String(config?.bot?.username || bot?.username || 'MapartBot').trim() || 'MapartBot'
  const chatBuffer = []
  const maxChatBuffer = 50
  const state = {
    phase: 'starting',
    statusDetail: 'starting',
    recoveryState: 'none',
    reconnectState: sessionNumber > 1 ? 'reconnecting' : 'idle',
    currentNbt: null,
    currentNbtStartedAt: null,
    activeQueueFile: null,
    lastError: '',
    lastErrorAt: null,
    deathMessage: '',
    deathMessageAt: null,
    deathClearAfterAt: 0,
    warnings: [],
    alerts: [],
    nodeInventoryCache: {
      nextScanAt: 0,
      scannedAt: null,
      reportPending: true,
      nodeFiles: [],
      nodeLogs: [],
      finishedMapFiles: []
    },
    lastActivityAt: Date.now(),
    startRequested: false,
    stopRequested: false,
    platformCleanupRequested: false,
    commandBusy: false,
    queueBatchLimited: false,
    heartbeatTimer: null,
    commandTimer: null,
    pauseParkingTask: null,
    stopped: false
  }

  function recordDeathMessage(message, source = 'runtime') {
    const text = stripMinecraftChatFormatting(message).replace(/\s+/g, ' ').trim() || `${botName} died`
    state.deathMessage = text
    state.deathMessageAt = new Date().toISOString()
    state.deathClearAfterAt = Date.now() + 15000
    state.statusDetail = 'death-detected'
    noteActivity()
    console.log(`[DEATH-ALERT] ${botName}: ${text} source=${source}`)
    void postStatus()
  }

  function clearDeathMessageIfOnPlatform(runtimeLocation = null) {
    if (!state.deathMessage) return
    const resolved = runtimeLocation || currentRuntimeLocation()
    if (resolved?.classification?.platform !== true) return
    if (Date.now() < Math.max(0, toNumber(state.deathClearAfterAt, 0))) return
    if (Number.isFinite(Number(bot?.health)) && Number(bot.health) <= 0) return
    console.log(`[DEATH-ALERT] ${botName}: cleared because bot is back on platform.`)
    state.deathMessage = ''
    state.deathMessageAt = null
    state.deathClearAfterAt = 0
    noteActivity()
  }

  // Buffer incoming in-game chat for the dashboard to read
  bot.on('message', (jsonMsg) => {
    const text = jsonMsg?.toString?.() || String(jsonMsg || '')
    if (!text) return
    chatBuffer.push({ ts: new Date().toISOString(), text })
    if (chatBuffer.length > maxChatBuffer) chatBuffer.shift()
    const deathMessage = extractBotDeathMessage(text, botName)
    if (deathMessage) recordDeathMessage(deathMessage, 'chat')
  })

  bot.on('death', () => {
    const recentDeathChat = [...chatBuffer].reverse()
      .find((entry) => Date.now() - new Date(entry?.ts || 0).getTime() <= 5000 && extractBotDeathMessage(entry?.text, botName))
    recordDeathMessage(recentDeathChat?.text || `${botName} died`, 'death-event')
  })

  function noteActivity() {
    state.lastActivityAt = Date.now()
  }

  function currentRole() {
    return String(config?.multiUser?.runtime?.role || 'single').toLowerCase() || 'single'
  }

  function currentAssignment() {
    return config?.multiUser?.runtime?.assignment || null
  }

  function currentProgress() {
    const filePath = path.resolve(process.cwd(), config.files?.progressFile || './logs/nerv-printer-progress.json')
    return readProgressState(filePath)
  }

  function isFinishedDashboardProgress(progress) {
    const rawPhase = String(progress?.phase || '').trim().toLowerCase()
    return rawPhase === 'finished' || rawPhase === 'done' || rawPhase === 'completed' || rawPhase === 'complete'
  }

  function progressSourceExists(progress) {
    if (!progress || typeof progress !== 'object') return false
    const sourcePath = String(progress.sourcePath || '').trim()
    if (sourcePath && fs.existsSync(path.resolve(process.cwd(), sourcePath))) return true
    const sourceName = path.basename(String(progress.sourceName || '').trim())
    if (!sourceName) return false
    const folder = path.resolve(process.cwd(), config.files?.nbtFolder || './nerv-printer-config')
    return fs.existsSync(path.join(folder, sourceName))
  }

  function progressBlocksQueue(progress) {
    if (!progress || isFinishedDashboardProgress(progress)) return false
    const phase = normalizeResumePhase(progress.phase)
    if (phase === 'post_print') return true
    if (phase === 'printing' || phase === 'repair') return progressSourceExists(progress)
    return false
  }

  function currentProgressSourceName() {
    const progress = currentProgress()
    if (!progressBlocksQueue(progress)) return null
    return String(progress.sourceName || '').trim() || null
  }

  function currentAssignmentSourceName() {
    if (runtimeControl?.isRunActive?.() !== true) return null
    return String(currentAssignment()?.sourceName || '').trim() || null
  }

  function isDashboardBotOnline() {
    if (bot.__nervSessionActive === false) return false
    const clientState = String(bot?._client?.state || '').trim().toLowerCase()
    if (!bot?._client) return false
    if (clientState === 'disconnected' || clientState === 'ended' || clientState === 'end') return false
    if (clientState === 'play') return true
    if (bot?.entity || bot?.player) return true
    return Boolean(clientState)
  }

  function currentSourceName() {
    return String(state.currentNbt || currentProgressSourceName() || currentAssignmentSourceName() || '').trim() || null
  }

  function currentRuntimeLocation() {
    const runtime = classifyRuntimePosition(bot, config, 'dashboard-status')
    return { ...runtime, position: bot?.entity?.position }
  }

  function currentLocation() {
    return mapDashboardLocation(currentRuntimeLocation())
  }

  function currentLocationDetail() {
    return mapDashboardLocationDetail(currentRuntimeLocation())
  }

  function buildBotInventorySnapshot() {
    const stacks = bot?.inventory?.items?.() || []
    const items = stacks
      .map((stack) => ({
        slot: Number.isFinite(Number(stack?.slot)) ? Number(stack.slot) : null,
        type: Number.isFinite(Number(stack?.type)) ? Number(stack.type) : null,
        name: String(stack?.name || 'unknown'),
        displayName: String(stack?.displayName || stack?.name || 'Unknown'),
        count: Math.max(0, toNumber(stack?.count, 0))
      }))
      .filter((item) => item.count > 0)
      .sort((left, right) => {
        const leftSlot = Number.isFinite(Number(left.slot)) ? Number(left.slot) : 9999
        const rightSlot = Number.isFinite(Number(right.slot)) ? Number(right.slot) : 9999
        return leftSlot - rightSlot
      })
    const totalCount = items.reduce((sum, item) => sum + toNumber(item.count, 0), 0)
    return {
      items,
      stackCount: items.length,
      totalCount,
      updatedAt: new Date().toISOString()
    }
  }

  function listNbtFilesInFolder(folder, warningKey, warningLabel) {
    if (!fs.existsSync(folder)) return []
    try {
      return fs.readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.nbt'))
        .map((entry) => {
          const filePath = path.join(folder, entry.name)
          const stats = fs.statSync(filePath)
          return {
            fileName: entry.name,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString()
          }
        })
        .sort((left, right) => String(left.fileName).localeCompare(String(right.fileName), undefined, { numeric: true, sensitivity: 'base' }))
    } catch (error) {
      logThrottled(`${warningKey}-${botName}`, `[DASHBOARD-WARN] ${warningLabel} failed for ${botName}: ${error?.message || error}`, {
        intervalMs: 30000,
        level: 'warn'
      })
      return []
    }
  }

  function listNodeNbtFiles() {
    const folder = path.resolve(process.cwd(), config.files?.nbtFolder || './nerv-printer-config')
    return listNbtFilesInFolder(folder, 'dashboard-node-files', 'node file listing')
  }

  function listFinishedMapFiles() {
    const folder = path.resolve(process.cwd(), config.files?.finishedFolder || './finished-maps')
    return listNbtFilesInFolder(folder, 'dashboard-finished-map-files', 'finished map listing')
  }

  function listNodeLogFiles() {
    const folder = path.dirname(LOG_FILE)
    if (!fs.existsSync(folder)) return []
    try {
      return fs.readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.log'))
        .map((entry) => {
          const filePath = path.join(folder, entry.name)
          const stats = fs.statSync(filePath)
          return {
            fileName: entry.name,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            reportedByBotName: botName
          }
        })
        .sort((left, right) => String(left.fileName).localeCompare(String(right.fileName), undefined, { numeric: true, sensitivity: 'base' }))
    } catch (error) {
      logThrottled(`dashboard-node-logs-${botName}`, `[DASHBOARD-WARN] node log listing failed for ${botName}: ${error?.message || error}`, {
        intervalMs: 30000,
        level: 'warn'
      })
      return []
    }
  }

  function getCachedNodeInventory() {
    const now = Date.now()
    if (state.nodeInventoryCache.nextScanAt > now) return state.nodeInventoryCache
    const nodeFiles = listNodeNbtFiles()
    const finishedMapFiles = listFinishedMapFiles()
    const nodeLogs = listNodeLogFiles()
    state.nodeInventoryCache = {
      nextScanAt: now + dashboard.nodeInventoryScanMs,
      scannedAt: new Date().toISOString(),
      reportPending: true,
      nodeFiles,
      nodeLogs,
      finishedMapFiles
    }
    return state.nodeInventoryCache
  }

  function invalidateNodeInventoryCache() {
    state.nodeInventoryCache.nextScanAt = 0
    state.nodeInventoryCache.reportPending = true
  }

  function requestPauseParking(reason = 'operator-pause') {
    if (!isOperatorPaused(config)) return
    if (state.pauseParkingTask) return
    state.pauseParkingTask = (async () => {
      const retryMs = Math.max(1000, toNumber(config.advanced?.pauseParkRetryMs, 10000))
      const forceAfterMs = Math.max(0, toNumber(config.advanced?.pauseParkForceAfterMs, 10000))
      const requestedAt = Date.now()
      while (isBotSessionLive(bot) && bot.__nervSessionActive !== false && isOperatorPaused(config)) {
        if (!isBotOnOrAroundPlatform(bot, config, 'pause-pending-platform')) {
          state.phase = 'paused'
          state.statusDetail = 'waiting-platform-to-pause'
          noteActivity()
          bot.__nervPauseParkingInProgress = true
          try {
            console.log(`[CONTROL] Pause requested; waiting for platform before parking. current=${formatBotPosition(bot)}`)
            await waitForPlatformReady(bot, config, 'pause-wait-platform')
          } finally {
            bot.__nervPauseParkingInProgress = false
          }
          if (!isBotOnOrAroundPlatform(bot, config, 'pause-pending-platform-after-wait')) {
            await delay(retryMs)
            continue
          }
        }
        const runActive = runtimeControl?.isRunActive?.() === true
        if (runActive && Date.now() - requestedAt < forceAfterMs) {
          state.phase = 'paused'
          state.statusDetail = 'parking-at-cartography'
          noteActivity()
          await delay(500)
          continue
        }
        const parked = await parkAtCartographyAccessForPause(bot, config, dashboardRuntimeApi, reason)
        if (parked || !isOperatorPaused(config)) return
        await delay(retryMs)
      }
    })().catch((err) => {
      console.log(`[CONTROL-WARN] Pause parking task failed: ${err?.message || err}`)
    }).finally(() => {
      state.pauseParkingTask = null
    })
    observeBackgroundTask(state.pauseParkingTask)
  }

  function buildStatusPayload(onlineOverride = null) {
    const now = Date.now()
    const progress = currentProgress()
    const operatorPaused = isOperatorPaused(config)
    const rawPhase = state.phase || progress?.phase || 'idle'
    const progressPhase = normalizeDashboardPhase(progress?.phase)
    let phase = operatorPaused ? 'paused' : normalizeDashboardPhase(rawPhase)
    const runActive = runtimeControl?.isRunActive?.() === true
    const hasActiveNbtRun = runActive && state.currentNbtStartedAt && currentSourceName()
    if (phase === 'waiting-spawn' && hasActiveNbtRun) {
      phase = ['printing', 'repair', 'rescan', 'post-print', 'cleanup'].includes(progressPhase)
        ? progressPhase
        : 'printing'
    }
    const health = Number.isFinite(Number(bot?.health)) ? Number(bot.health) : 20
    const hunger = Number.isFinite(Number(bot?.food)) ? Number(bot.food) : 20
    const idle = operatorPaused || phase === 'idle' || (now - state.lastActivityAt >= dashboard.idleWindowMs && !['printing', 'repair', 'rescan', 'post-print', 'cleanup', 'starting', 'waiting-spawn'].includes(phase))
    const progressUpdatedAt = new Date(progress?.updatedAt || 0).getTime()
    const recentProgressAt = Number.isFinite(progressUpdatedAt) && progressBlocksQueue(progress) ? progressUpdatedAt : 0
    const lastWorkActivityAt = Math.max(state.lastActivityAt, recentProgressAt)
    const activeState = operatorPaused ? 'paused' : (!idle && now - lastWorkActivityAt >= dashboard.staleMs ? 'stale' : 'active')
    const role = currentRole()
    const assignedInterval = currentAssignment()?.interval ? {
      start: toNumber(currentAssignment().interval.start, 0),
      end: toNumber(currentAssignment().interval.end, 127)
    } : null
    const clientState = String(bot?._client?.state || '').toLowerCase()
    const isOnline = onlineOverride == null
      ? isDashboardBotOnline()
      : onlineOverride
    const runtimeLocation = currentRuntimeLocation()
    clearDeathMessageIfOnPlatform(runtimeLocation)
    const location = mapDashboardLocation(runtimeLocation)
    const locationDetail = mapDashboardLocationDetail(runtimeLocation)
    const rawStatusDetail = state.statusDetail || (phase === 'idle' ? 'idle' : phase)
    let statusDetail = operatorPaused
      ? (['parking-at-cartography', 'waiting-platform-to-pause'].includes(String(rawStatusDetail || '').trim()) ? String(rawStatusDetail).trim() : 'paused')
      : rawStatusDetail
    if (hasActiveNbtRun && phase !== 'waiting-spawn' && /^spawn-\d+$/i.test(String(statusDetail || '').trim())) {
      statusDetail = phase
    }
    const progressPayload = progress && Number.isFinite(Number(progress.totalTargets)) && ['printing', 'repair', 'rescan', 'post-print', 'cleanup'].includes(phase)
      ? {
          processed: toNumber(progress.processedTargets, 0),
          total: toNumber(progress.totalTargets, 0),
          percent: toNumber(progress.totalTargets, 0) > 0 ? Number(((toNumber(progress.processedTargets, 0) / toNumber(progress.totalTargets, 1)) * 100).toFixed(2)) : 0
        }
      : undefined

    const inventory = getCachedNodeInventory()
    const includeInventory = inventory.reportPending === true
    const nodeFiles = includeInventory ? inventory.nodeFiles : undefined
    const finishedMapFiles = includeInventory ? inventory.finishedMapFiles : undefined

    const payload = {
      botName,
      runtime: 'nerv-printer',
      runtimeInstanceId: PROCESS_INSTANCE_ID,
      runtimeStartedAt: PROCESS_STARTED_AT,
      hostLabel: dashboard.hostLabel,
      configFileName: path.basename(getUserConfigPath()),
      online: isOnline,
      phase,
      health,
      hunger,
      activeState,
      statusDetail,
      location,
      locationDetail,
      idle,
      heartbeatAt: new Date().toISOString(),
      role,
      recoveryState: phase === 'repair' ? 'recovering' : state.recoveryState,
      reconnectState: state.reconnectState,
      reconnectCount: Math.max(0, toNumber(sessionNumber, 1) - 1),
      reconnectStreak: state.reconnectState === 'reconnecting' ? Math.max(0, toNumber(sessionNumber, 1) - 1) : 0,
      currentNbt: currentSourceName(),
      lastStatusAt: new Date().toISOString(),
      progress: progressPayload,
      lastError: state.lastError || null,
      lastErrorAt: state.lastError ? state.lastErrorAt : null,
      deathMessage: state.deathMessage || null,
      deathMessageAt: state.deathMessage ? state.deathMessageAt : null,
      warnings: state.warnings.slice(-5),
      alerts: state.alerts.filter((item) => item.active === true).slice(-8),
      assignedInterval,
      staleReason: activeState === 'stale' ? (progress ? 'progress-frozen' : 'heartbeat-missed') : undefined,
      verificationCode: stdinCommandState.status?.verificationCode || null,
      tokenWaiting: stdinCommandState.status?.tokenWaiting === true,
      currentNbtStartedAt: state.currentNbtStartedAt || null,
      recentChat: chatBuffer.slice(),
      latencyMs: getBotLatencyMs(bot),
      runtimeMetrics: buildProcessRuntimeMetrics(),
      tpaTarget: getTpaTarget(config)
    }
    if (clientState) payload.clientState = clientState
    if (includeInventory) {
      payload.nodeFiles = nodeFiles
      payload.nodeLogs = inventory.nodeLogs
      payload.finishedMapCount = finishedMapFiles.length
      payload.finishedMapFiles = finishedMapFiles
      payload.nodeInventoryAt = inventory.scannedAt || new Date().toISOString()
    }
    return { payload, inventoryReported: includeInventory }
  }

  async function postStatus(onlineOverride = null) {
    try {
      const status = buildStatusPayload(onlineOverride)
      await createDashboardRequest(`${dashboard.serviceUrl}/api/bots/status`, 'POST', status.payload)
      if (status.inventoryReported) state.nodeInventoryCache.reportPending = false
      await flushQueueResultOutbox()
    } catch (err) {
      logThrottled(`dashboard-status-${botName}`, `[DASHBOARD-WARN] status post failed for ${botName}: ${err?.message || err}`, {
        intervalMs: 30000,
        level: 'warn'
      })
    }
  }

  function scheduleLoop(key, intervalMs, work) {
    const run = async () => {
      if (state.stopped) return
      try {
        await work()
      } catch (err) {
        logThrottled(`dashboard-loop-${botName}-${key}`, `[DASHBOARD-WARN] ${botName} loop=${key} failed: ${err?.message || err}`, {
          intervalMs: 30000,
          level: 'warn'
        })
      }
      if (state.stopped) return
      state[key] = setTimeout(run, intervalMs)
      state[key].unref?.()
    }
    state[key] = setTimeout(run, intervalMs)
    state[key].unref?.()
  }

  async function reportCommandResult(commandId, status, resultMessage, extraPayload = {}) {
    await createDashboardRequest(`${dashboard.serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(commandId)}/result`, 'POST', {
      status,
      resultMessage,
      ...(extraPayload && typeof extraPayload === 'object' ? extraPayload : {})
    })
  }

  async function requestCurrentNbtReset(source = 'dashboard', commandId = null) {
    const reason = 'dashboard-reset-current-nbt'
    let resetProgress = null
    try {
      resetProgress = markCurrentNbtResetRequested(config, reason, sessionNumber)
    } catch (error) {
      const message = `reset-current-nbt failed: ${error?.message || error}`
      if (commandId) await reportCommandResult(commandId, 'failed', message)
      return message
    }

    printingIntentActive = true
    state.startRequested = true
    state.stopRequested = false
    state.phase = 'cleanup'
    state.statusDetail = 'reset-current-nbt'
    state.currentNbt = path.basename(String(resetProgress.sourceName || resetProgress.sourcePath || state.currentNbt || '').trim()) || state.currentNbt
    noteActivity()

    const message = `reset requested for ${resetProgress.sourceName || resetProgress.sourcePath || 'current NBT'}; reconnecting before restart`
    if (commandId) {
      try {
        await reportCommandResult(commandId, 'succeeded', message)
      } catch (error) {
        console.log(`[RESET-CURRENT-NBT-WARN] Could not report reset command result before reconnect: ${error?.message || error}`)
      }
      try {
        resetProgress = markCurrentNbtResetRequested(config, reason, sessionNumber)
      } catch (error) {
        console.log(`[RESET-CURRENT-NBT-WARN] Could not refresh reset checkpoint after reporting command result: ${error?.message || error}`)
      }
    }

    console.log(`[RESET-CURRENT-NBT] ${source}: ${message}`)
    stopBotMovement(bot)
    closeCurrentWindowIfOpen(bot, reason)
    bot.__nervForcedEndReason = reason
    try { bot.quit(reason) } catch {}
    return message
  }

  async function requestPlatformCleanup(source = 'dashboard', commandId = null) {
    printingIntentActive = false
    state.platformCleanupRequested = true
    state.startRequested = false
    state.stopRequested = runtimeControl?.isRunActive?.() === true
    state.phase = 'cleanup'
    state.statusDetail = 'platform-cleanup-pending'
    if (state.stopRequested) {
      runtimeControl?.requestStop(source)
      state.statusDetail = 'cleanup-after-current-step'
    }
    noteActivity()

    const message = state.stopRequested
      ? 'platform cleanup queued; bot will stop current work first'
      : 'platform cleanup queued'
    if (commandId) {
      try {
        await reportCommandResult(commandId, 'succeeded', message)
      } catch (error) {
        console.log(`[PLATFORM-CLEANUP-WARN] Could not report cleanup command result: ${error?.message || error}`)
      }
    }
    console.log(`[PLATFORM-CLEANUP] ${source}: ${message}`)
    return message
  }

  async function reportFileResult(fileId, deliveryStatus, failedReason = null) {
    await createDashboardRequest(`${dashboard.serviceUrl}/api/bots/${encodeURIComponent(botName)}/files/${encodeURIComponent(fileId)}/result`, 'POST', {
      deliveryStatus,
      failedReason
    })
  }

  async function reportNodeFileResult(fileId, deliveryStatus, failedReason = null) {
    await createDashboardRequest(`${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/files/${encodeURIComponent(fileId)}/result`, 'POST', {
      deliveryStatus,
      failedReason,
      botName
    })
  }

  async function reportQueueFileResult(fileId, deliveryStatus, failedReason = null, fileInfo = null) {
    const active = fileInfo || (state.activeQueueFile?.fileId === fileId ? state.activeQueueFile : null)
    await createDashboardRequest(`${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/queue/${encodeURIComponent(fileId)}/result`, 'POST', {
      deliveryStatus,
      failedReason,
      botName,
      localFileName: active?.fileName || null,
      localPath: active?.localPath || null
    })
  }

  function shouldHoldQueueFileAfterRuntimeError(errorText) {
    const text = String(errorText || '').toLowerCase()
    if (!text) return false
    return (
      text.includes('nerv-workload-checkpoint-timeout') ||
      text.includes('checkpoint-timeout') ||
      text.includes('goal was changed') ||
      text.includes('goalchanged') ||
      text.includes('path was interrupted') ||
      text.includes('pathfinder') ||
      text.includes('platform-hold') ||
      text.includes('platform-stall') ||
      text.includes('latency') ||
      text.includes('timed out') ||
      text.includes('timeout')
    )
  }

  async function claimNextNodeFile() {
    const response = await createDashboardRequest(`${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/files/claim-next`, 'POST', {
      botName
    })
    return response.body?.item || null
  }

  async function claimNextQueueFile() {
    const response = await createDashboardRequest(`${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/queue/claim-next`, 'POST', {
      botName
    })
    return response.body?.item || null
  }

  async function claimNextQueueFiles(limit = 1) {
    const response = await createDashboardRequest(`${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/queue/claim-next`, 'POST', {
      botName,
      limit
    })
    const items = Array.isArray(response.body?.items)
      ? response.body.items.filter(Boolean)
      : (response.body?.item ? [response.body.item] : [])
    return {
      items,
      batchPolicy: response.body?.batchPolicy || null
    }
  }

  async function claimNextNodeCommand() {
    const response = await createDashboardRequest(`${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/commands/claim-next`, 'POST', {
      botName
    })
    return response.body?.command || null
  }

  async function reportNodeCommandResult(commandId, status, resultMessage) {
    await createDashboardRequest(`${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/commands/${encodeURIComponent(commandId)}/result`, 'POST', {
      status,
      resultMessage,
      botName
    })
  }

  async function reportNodeLogDownload(commandId, fileName, contentBase64) {
    const response = await createDashboardRequest(`${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/logs/${encodeURIComponent(commandId)}/result`, 'POST', {
      botName,
      fileName,
      contentBase64
    }, { timeoutMs: 120000 })
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(response.body?.error || response.text || `dashboard log upload failed with HTTP ${response.statusCode}`)
    }
  }

  async function reportNodeConfigDownload(commandId, fileName, contentBase64) {
    const response = await createDashboardRequest(`${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/config/${encodeURIComponent(commandId)}/result`, 'POST', {
      botName,
      fileName,
      contentBase64
    }, { timeoutMs: 120000 })
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(response.body?.error || response.text || `dashboard config upload failed with HTTP ${response.statusCode}`)
    }
  }

  function resolveNodeNbtPath(fileName) {
    const folder = path.resolve(process.cwd(), config.files?.nbtFolder || './nerv-printer-config')
    const safeName = path.basename(String(fileName || '').trim())
    if (!safeName) throw new Error('file name is required')
    return path.join(folder, safeName)
  }

  function resolveTeleportWhitelistPath(fileName = 'whitelisted-users.json') {
    const configuredFile = String(config.advanced?.teleportRequestWhitelistFile || '').trim()
    if (configuredFile) return path.resolve(process.cwd(), configuredFile)
    const safeName = path.basename(String(fileName || '').trim()) || 'whitelisted-users.json'
    return path.resolve(process.cwd(), 'nerv-printer-config', safeName)
  }

  function queueStatePath() {
    const folder = path.resolve(process.cwd(), config.files?.nbtFolder || './nerv-printer-config')
    return path.join(folder, '.dashboard-queue.json')
  }

  function queueResultOutboxPath() {
    const folder = path.resolve(process.cwd(), config.files?.nbtFolder || './nerv-printer-config')
    return path.join(folder, '.dashboard-queue-results.json')
  }

  function readQueueState() {
    return readOptionalJson(queueStatePath()) || {}
  }

  function writeQueueState(next) {
    writeJson(queueStatePath(), next && typeof next === 'object' ? next : {})
  }

  function readQueueResultOutbox() {
    const items = readOptionalJson(queueResultOutboxPath())
    return Array.isArray(items) ? items.filter((item) => item?.fileId) : []
  }

  function writeQueueResultOutbox(items) {
    writeJson(queueResultOutboxPath(), Array.isArray(items) ? items : [])
  }

  function removeQueueResultOutboxItem(fileId) {
    const wanted = String(fileId || '').trim()
    if (!wanted) return
    const next = readQueueResultOutbox().filter((item) => String(item.fileId || '') !== wanted)
    writeQueueResultOutbox(next)
  }

  function hasPendingQueueResults() {
    return readQueueResultOutbox().length > 0
  }

  function enqueueQueueResult(fileInfo, deliveryStatus, failedReason = null, reportError = null) {
    const fileId = String(fileInfo?.fileId || '').trim()
    if (!fileId) return
    const now = new Date().toISOString()
    const items = readQueueResultOutbox()
    const index = items.findIndex((item) => String(item.fileId || '') === fileId)
    const previous = index >= 0 ? items[index] : {}
    const attemptCount = Math.max(0, toNumber(previous.reportAttemptCount, 0))
    const next = {
      ...previous,
      fileId,
      fileName: path.basename(String(fileInfo.fileName || fileInfo.originalName || `${fileId}.nbt`)),
      originalName: path.basename(String(fileInfo.originalName || fileInfo.fileName || `${fileId}.nbt`)),
      deliveryStatus,
      failedReason,
      queuedAt: previous.queuedAt || now,
      updatedAt: now,
      reportAttemptCount: attemptCount,
      nextReportAt: previous.nextReportAt || now,
      lastReportError: reportError ? String(reportError?.message || reportError) : previous.lastReportError || null
    }
    if (index >= 0) {
      items[index] = next
    } else {
      items.push(next)
    }
    writeQueueResultOutbox(items)
  }

  async function flushQueueResultOutbox() {
    const now = Date.now()
    const items = readQueueResultOutbox()
    if (!items.length) return false
    const remaining = []
    let reportedAny = false
    let changed = false
    for (const item of items) {
      const nextReportMs = new Date(item.nextReportAt || 0).getTime()
      if (Number.isFinite(nextReportMs) && nextReportMs > now) {
        remaining.push(item)
        continue
      }
      try {
        await reportQueueFileResult(item.fileId, item.deliveryStatus || 'placed', item.failedReason || null)
        const terminal = ['placed', 'completed', 'succeeded', 'failed'].includes(String(item.deliveryStatus || 'placed').trim().toLowerCase())
        if (terminal) forgetQueueFile(item.fileName || item.originalName)
        if (terminal && state.activeQueueFile?.fileId === item.fileId) state.activeQueueFile = null
        reportedAny = true
        changed = true
      } catch (error) {
        const attemptCount = Math.max(0, toNumber(item.reportAttemptCount, 0)) + 1
        const retryDelayMs = Math.min(60000, 5000 * Math.pow(2, Math.min(5, attemptCount - 1)))
        changed = true
        remaining.push({
          ...item,
          reportAttemptCount: attemptCount,
          updatedAt: new Date().toISOString(),
          nextReportAt: new Date(Date.now() + retryDelayMs).toISOString(),
          lastReportError: error?.message || String(error)
        })
        logThrottled(`dashboard-queue-result-${botName}`, `[DASHBOARD-WARN] queue result report pending for ${botName}: ${error?.message || error}`, {
          intervalMs: 30000,
          level: 'warn'
        })
        for (const later of items.slice(items.indexOf(item) + 1)) remaining.push(later)
        break
      }
    }
    if (changed) writeQueueResultOutbox(remaining)
    return reportedAny
  }

  function normalizeQueueFileInfo(fileName, item = {}) {
    const safeName = path.basename(String(fileName || '').trim())
    if (!safeName || !item?.fileId) return null
    const localPath = item.localPath
      ? path.resolve(process.cwd(), String(item.localPath))
      : resolveNodeNbtPath(safeName)
    return {
      fileId: item.fileId,
      fileName: safeName,
      originalName: path.basename(String(item.originalName || item.storedName || safeName)),
      localName: safeName,
      localPath,
      claimedByBotName: botName,
      claimedByHostLabel: dashboard.hostLabel,
      queueOrderAt: item.queueOrderAt || item.rememberedAt || item.claimedAt || item.uploadedAt || new Date().toISOString(),
      rememberedAt: item.rememberedAt || new Date().toISOString()
    }
  }

  function rememberQueueFile(fileName, item, options = {}) {
    const entry = normalizeQueueFileInfo(fileName, item)
    if (!entry) return
    const stateFile = readQueueState()
    stateFile[entry.fileName] = entry
    if (options.active !== false) stateFile.__activeQueueFile = entry
    writeQueueState(stateFile)
  }

  function listRememberedQueueFiles() {
    const stateFile = readQueueState()
    return Object.entries(stateFile)
      .filter(([fileName, entry]) => !fileName.startsWith('__') && entry?.fileId)
      .map(([fileName, entry]) => normalizeQueueFileInfo(fileName, entry))
      .filter(Boolean)
      .sort((left, right) => {
        const byOrder = String(left.queueOrderAt || '').localeCompare(String(right.queueOrderAt || ''))
        if (byOrder !== 0) return byOrder
        return String(left.fileName || '').localeCompare(String(right.fileName || ''), undefined, { numeric: true, sensitivity: 'base' })
      })
  }

  function findRememberedQueueFileById(fileId) {
    const wanted = String(fileId || '').trim()
    if (!wanted) return null
    return listRememberedQueueFiles().find((entry) => String(entry.fileId || '') === wanted) || null
  }

  function queueFileExists(entry) {
    if (!entry?.fileName) return false
    const localPath = entry.localPath ? path.resolve(process.cwd(), entry.localPath) : resolveNodeNbtPath(entry.fileName)
    return fs.existsSync(localPath)
  }

  function countLocalQueueFiles() {
    return listRememberedQueueFiles().filter((entry) => queueFileExists(entry)).length
  }

  function hasNonDashboardLocalNbtWork() {
    const remembered = new Set(listRememberedQueueFiles().map((entry) => entry.fileName))
    return listNodeNbtFiles().some((item) => !remembered.has(item.fileName))
  }

  function restoreQueueFileForNbt(filePathOrName) {
    const safeName = path.basename(String(filePathOrName || '').trim())
    if (!safeName) return null
    const entry = readQueueState()[safeName] || null
    if (entry?.fileId) {
      state.activeQueueFile = normalizeQueueFileInfo(safeName, entry)
      const stateFile = readQueueState()
      stateFile.__activeQueueFile = state.activeQueueFile
      writeQueueState(stateFile)
      return state.activeQueueFile
    }
    return null
  }

  function restoreActiveQueueFile() {
    if (state.activeQueueFile?.fileId) return state.activeQueueFile
    const stateFile = readQueueState()
    const active = stateFile.__activeQueueFile
    if (active?.fileId && active.fileName) {
      state.activeQueueFile = normalizeQueueFileInfo(active.fileName, active)
      return state.activeQueueFile
    }
    const nextQueued = listRememberedQueueFiles().find((entry) => queueFileExists(entry))
    if (nextQueued?.fileId) {
      state.activeQueueFile = nextQueued
      stateFile.__activeQueueFile = state.activeQueueFile
      writeQueueState(stateFile)
      return state.activeQueueFile
    }
    return null
  }

  function getActiveQueueNbtPath() {
    const active = restoreActiveQueueFile()
    if (!active?.fileId) return null
    const localPath = active.localPath ? path.resolve(process.cwd(), active.localPath) : resolveNodeNbtPath(active.fileName)
    if (!fs.existsSync(localPath)) return null
    state.activeQueueFile = {
      ...active,
      fileName: path.basename(localPath),
      localName: path.basename(localPath),
      localPath
    }
    return localPath
  }

  function forgetQueueFile(fileName) {
    const safeName = path.basename(String(fileName || '').trim())
    if (!safeName) return
    const stateFile = readQueueState()
    if (!stateFile[safeName]) return
    const active = stateFile.__activeQueueFile
    delete stateFile[safeName]
    if (active?.fileName === safeName) delete stateFile.__activeQueueFile
    writeQueueState(stateFile)
  }

  function resolveFinishedMapPath(fileName) {
    const folder = path.resolve(process.cwd(), config.files?.finishedFolder || './finished-maps')
    const safeName = path.basename(String(fileName || '').trim())
    if (!safeName) throw new Error('file name is required')
    return path.join(folder, safeName)
  }

  async function executeNodeCommand(command) {
    if (!command) return false
    switch (command.commandType) {
      case 'upload-node-file': {
        const fileName = path.basename(String(command.fileName || '').trim())
        if (!fileName || !fileName.toLowerCase().endsWith('.nbt')) {
          await reportNodeCommandResult(command.commandId, 'failed', `invalid file name: ${command.fileName || 'unknown'}`)
          return true
        }
        const targetPath = resolveNodeNbtPath(fileName)
        const contentBase64 = String(command.contentBase64 || '')
        if (!contentBase64) {
          await reportNodeCommandResult(command.commandId, 'failed', `missing file content for ${fileName}`)
          return true
        }
        try {
          const buffer = Buffer.from(contentBase64, 'base64')
          fs.mkdirSync(path.dirname(targetPath), { recursive: true })
          fs.writeFileSync(targetPath, buffer)
          invalidateNodeInventoryCache()
          noteActivity()
          await reportNodeCommandResult(command.commandId, 'succeeded', `uploaded ${fileName}`)
        } catch (error) {
          await reportNodeCommandResult(command.commandId, 'failed', error?.message || String(error))
        }
        return true
      }
      case 'sync-teleport-whitelist': {
        const fileName = path.basename(String(command.fileName || '').trim()) || 'whitelisted-users.json'
        if (!fileName.toLowerCase().endsWith('.json')) {
          await reportNodeCommandResult(command.commandId, 'failed', `invalid whitelist file name: ${command.fileName || 'unknown'}`)
          return true
        }
        const targetPath = resolveTeleportWhitelistPath(fileName)
        const contentBase64 = String(command.contentBase64 || '')
        if (!contentBase64) {
          await reportNodeCommandResult(command.commandId, 'failed', `missing whitelist content for ${fileName}`)
          return true
        }
        try {
          const content = Buffer.from(contentBase64, 'base64').toString('utf8')
          const parsed = JSON.parse(content)
          const users = Array.isArray(parsed?.users)
            ? parsed.users
            : (Array.isArray(parsed?.whitelist) ? parsed.whitelist : [])
          const validUsers = users.map(normalizeMinecraftUsername).filter(Boolean)
          fs.mkdirSync(path.dirname(targetPath), { recursive: true })
          fs.writeFileSync(targetPath, `${JSON.stringify({ users: validUsers, updatedAt: parsed?.updatedAt || new Date().toISOString() }, null, 2)}\n`, 'utf8')
          noteActivity()
          await reportNodeCommandResult(command.commandId, 'succeeded', `synced teleport whitelist ${path.basename(targetPath)} users=${validUsers.length}`)
        } catch (error) {
          await reportNodeCommandResult(command.commandId, 'failed', error?.message || String(error))
        }
        return true
      }
      case 'download-node-log': {
        const fileName = path.basename(String(command.fileName || '').trim())
        if (!fileName || !fileName.toLowerCase().endsWith('.log')) {
          await reportNodeCommandResult(command.commandId, 'failed', `invalid log file name: ${command.fileName || 'unknown'}`)
          return true
        }
        const logPath = path.join(path.dirname(LOG_FILE), fileName)
        if (!fs.existsSync(logPath)) {
          await reportNodeCommandResult(command.commandId, 'failed', `log file not found: ${fileName}`)
          return true
        }
        try {
          const contentBase64 = fs.readFileSync(logPath).toString('base64')
          await reportNodeLogDownload(command.commandId, fileName, contentBase64)
          await reportNodeCommandResult(command.commandId, 'succeeded', `downloaded ${fileName}`)
        } catch (error) {
          await reportNodeCommandResult(command.commandId, 'failed', error?.message || String(error))
        }
        return true
      }
      case 'download-node-config': {
        const requestedName = path.basename(String(command.fileName || '').trim())
        const configPath = getUserConfigPath()
        const configName = path.basename(configPath)
        if (!requestedName || requestedName !== configName) {
          await reportNodeCommandResult(command.commandId, 'failed', `config file not available on this node: ${requestedName || 'unknown'}`)
          return true
        }
        if (!fs.existsSync(configPath)) {
          await reportNodeCommandResult(command.commandId, 'failed', `config file not found: ${configName}`)
          return true
        }
        try {
          const contentBase64 = fs.readFileSync(configPath).toString('base64')
          await reportNodeConfigDownload(command.commandId, configName, contentBase64)
          await reportNodeCommandResult(command.commandId, 'succeeded', `downloaded ${configName}`)
        } catch (error) {
          await reportNodeCommandResult(command.commandId, 'failed', error?.message || String(error))
        }
        return true
      }
      case 'delete-node-file': {
        const targetPath = resolveNodeNbtPath(command.fileName)
        if (!fs.existsSync(targetPath)) {
          await reportNodeCommandResult(command.commandId, 'failed', `file not found: ${command.fileName}`)
          return true
        }
        fs.unlinkSync(targetPath)
        invalidateNodeInventoryCache()
        if (path.basename(String(state.currentNbt || '')) === path.basename(String(command.fileName || ''))) {
          state.currentNbt = null
        }
        noteActivity()
        await reportNodeCommandResult(command.commandId, 'succeeded', `deleted ${command.fileName}`)
        return true
      }
      case 'delete-finished-map': {
        const targetPath = resolveFinishedMapPath(command.fileName)
        if (!fs.existsSync(targetPath)) {
          await reportNodeCommandResult(command.commandId, 'failed', `finished map not found: ${command.fileName}`)
          return true
        }
        fs.unlinkSync(targetPath)
        noteActivity()
        await reportNodeCommandResult(command.commandId, 'succeeded', `deleted finished map ${command.fileName}`)
        return true
      }
      case 'fresh-start-clean-node': {
        try {
          setOperatorPaused(config, false, command.reason || 'dashboard-reset-everything')
          if (runtimeControl?.isRunActive?.() === true) {
            printingIntentActive = false
            state.platformCleanupRequested = true
            state.startRequested = false
            state.stopRequested = true
            runtimeControl?.requestStop('dashboard-reset-everything')
            noteActivity()
            await reportNodeCommandResult(command.commandId, 'succeeded', 'fresh-start cleanup deferred until current work stops')
            return true
          }
          const cleanup = cleanLocalFreshStartFiles(config, command.reason || 'dashboard-reset-everything')
          invalidateNodeInventoryCache()
          state.currentNbt = null
          state.activeQueueFile = null
          noteActivity()
          const message = `fresh-start cleanup deleted node=${cleanup.nodeNbtDeleted.length} finished=${cleanup.finishedNbtDeleted.length} state=${cleanup.stateDeleted.length} sync=${cleanup.syncDeleted.length} errors=${cleanup.errors.length}`
          await reportNodeCommandResult(command.commandId, cleanup.errors.length ? 'failed' : 'succeeded', message)
        } catch (error) {
          await reportNodeCommandResult(command.commandId, 'failed', error?.message || String(error))
        }
        return true
      }
      case 'reprint-finished-map': {
        const fileName = path.basename(String(command.fileName || '').trim())
        if (!fileName || !fileName.toLowerCase().endsWith('.nbt')) {
          await reportNodeCommandResult(command.commandId, 'failed', `invalid finished map file name: ${command.fileName || 'unknown'}`)
          return true
        }
        const fromPath = resolveFinishedMapPath(fileName)
        if (!fs.existsSync(fromPath)) {
          await reportNodeCommandResult(command.commandId, 'failed', `finished map not found: ${fileName}`)
          return true
        }
        try {
          const targetPath = resolveUniqueFilePath(resolveNodeNbtPath(fileName))
          fs.mkdirSync(path.dirname(targetPath), { recursive: true })
          fs.copyFileSync(fromPath, targetPath)
          invalidateNodeInventoryCache()
          state.currentNbt = path.basename(targetPath)
          printingIntentActive = true
          setOperatorPaused(config, false, command.reason || 'dashboard-reprint')
          runtimeControl?.requestStart('dashboard-reprint')
          state.startRequested = true
          state.stopRequested = false
          noteActivity()
          await reportNodeCommandResult(command.commandId, 'succeeded', `queued reprint ${path.basename(targetPath)} and requested start`)
        } catch (error) {
          await reportNodeCommandResult(command.commandId, 'failed', error?.message || String(error))
        }
        return true
      }
      default: {
        await reportNodeCommandResult(command.commandId, 'failed', `unsupported node command type: ${command.commandType}`)
        return true
      }
    }
  }

  async function handleNodeFileAssignment() {
    if (hasLocalNbtWorkPending()) return false
    const item = await claimNextNodeFile()
    if (!item) return false
    const folder = path.resolve(process.cwd(), config.files?.nbtFolder || './nerv-printer-config')
    const fileName = path.basename(String(item.originalName || item.storedName || `${item.fileId}.nbt`))
    const targetPath = path.join(folder, fileName)
    try {
      await downloadDashboardFile(`${dashboard.serviceUrl}/api/files/${encodeURIComponent(item.fileId)}/download`, targetPath)
      await reportNodeFileResult(item.fileId, 'placed')
      state.currentNbt = fileName
      invalidateNodeInventoryCache()
      noteActivity()
      return true
    } catch (error) {
      await reportNodeFileResult(item.fileId, 'failed', error?.message || String(error))
      throw error
    }
  }

  function hasLocalNbtWorkPending() {
    if (runtimeControl?.isRunActive?.() === true) return true
    if (state.currentNbt) return true
    if (progressBlocksQueue(currentProgress())) return true
    return listNodeNbtFiles().length > 0
  }

  async function downloadQueueFile(item) {
    const existing = findRememberedQueueFileById(item?.fileId)
    if (existing && queueFileExists(existing)) {
      return { ...existing, downloaded: false }
    }

    const folder = path.resolve(process.cwd(), config.files?.nbtFolder || './nerv-printer-config')
    const fileName = path.basename(String(item.originalName || item.storedName || `${item.fileId}.nbt`))
    const targetPath = resolveUniqueFilePath(path.join(folder, fileName))
    try {
      await downloadDashboardFile(`${dashboard.serviceUrl}/api/files/${encodeURIComponent(item.fileId)}/download`, targetPath)
    } catch (error) {
      try {
        await reportQueueFileResult(item.fileId, 'failed', error?.message || String(error))
      } catch (reportError) {
        enqueueQueueResult({
          fileId: item.fileId,
          fileName,
          originalName: fileName
        }, 'failed', error?.message || String(error), reportError)
      }
      throw error
    }

    const localName = path.basename(targetPath)
    const localInfo = {
      fileId: item.fileId,
      fileName: localName,
      originalName: fileName,
      localName,
      localPath: targetPath,
      claimedByBotName: botName,
      claimedByHostLabel: dashboard.hostLabel
    }
    rememberQueueFile(localName, { ...item, ...localInfo }, { active: false })
    try {
      await reportQueueFileResult(item.fileId, 'downloaded', null, localInfo)
    } catch (error) {
      logThrottled(`dashboard-queue-progress-${botName}`, `[DASHBOARD-WARN] queue progress report will catch up on final result: ${error?.message || error}`, {
        intervalMs: 30000,
        level: 'warn'
      })
    }
    return { ...localInfo, downloaded: true }
  }

  async function handleQueueFileAssignment() {
    if (isOperatorPaused(config)) return false
    await flushQueueResultOutbox()
    if (hasPendingQueueResults()) return false
    if (hasNonDashboardLocalNbtWork()) return false

    const highWater = Math.max(1, dashboard.queuePrefetchHighWater)
    const lowWater = Math.min(highWater, Math.max(0, dashboard.queuePrefetchLowWater))
    const localQueueCount = countLocalQueueFiles()
    if (localQueueCount <= 0) state.queueBatchLimited = false
    if (state.queueBatchLimited && localQueueCount > 0) return false
    if (localQueueCount >= lowWater && localQueueCount > 0) return false

    const claimLimit = Math.max(1, highWater - localQueueCount)
    const claim = await claimNextQueueFiles(claimLimit)
    const items = claim.items
    if (!items.length) return false
    state.queueBatchLimited = claim.batchPolicy?.batchLimited === true

    let downloadedCount = 0
    for (const item of items) {
      const result = await downloadQueueFile(item)
      if (result?.downloaded) downloadedCount += 1
    }

    const canStartBufferedQueue = !isOperatorPaused(config) && runtimeControl?.isRunActive?.() !== true && !state.currentNbt && !progressBlocksQueue(currentProgress())
    if (canStartBufferedQueue && countLocalQueueFiles() > 0) {
      printingIntentActive = true
      runtimeControl?.requestStart('dashboard-queue')
      state.startRequested = true
      state.stopRequested = false
    }
    invalidateNodeInventoryCache()
    noteActivity()
    if (downloadedCount > 0) {
      console.log(`[DASHBOARD] Prefetched ${downloadedCount} dashboard queue NBT${downloadedCount === 1 ? '' : 's'}; local buffer=${countLocalQueueFiles()}/${highWater}`)
    }
    return true
  }

  async function handleAssignNbt(command) {
    const metadataResponse = await createDashboardRequest(`${dashboard.serviceUrl}/api/bots/${encodeURIComponent(botName)}/files/next`, 'GET')
    const item = metadataResponse.body?.item || null
    if (!item || item.fileId !== command.nbtFileId) {
      throw new Error(`assigned file ${command.nbtFileId || 'unknown'} is not ready for ${botName}`)
    }
    const folder = path.resolve(process.cwd(), config.files?.nbtFolder || './nerv-printer-config')
    const fileName = path.basename(String(item.originalName || item.storedName || `${item.fileId}.nbt`))
    const targetPath = path.join(folder, fileName)
    await downloadDashboardFile(`${dashboard.serviceUrl}/api/files/${encodeURIComponent(item.fileId)}/download`, targetPath)
    await reportFileResult(item.fileId, 'placed')
    state.currentNbt = fileName
    noteActivity()
    return `downloaded ${fileName}`
  }

  async function executeCommand(command) {
    const claimResponse = command.status === 'pending'
      ? await createDashboardRequest(`${dashboard.serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(command.commandId)}/claim`, 'POST', {})
      : { body: { command } }
    const claimed = claimResponse.body?.command || command

    if (claimed.status !== 'claimed' && claimed.status !== 'pending') {
      return
    }

    switch (claimed.commandType) {
      case 'start': {
        printingIntentActive = true
        setOperatorPaused(config, false, claimed.reason || 'dashboard-start')
        runtimeControl?.requestStart('dashboard')
        state.startRequested = true
        state.stopRequested = false
        noteActivity()
        await reportCommandResult(claimed.commandId, 'succeeded', 'start requested; bot will begin work when idle')
        break
      }
      case 'stop': {
        printingIntentActive = false
        setOperatorPaused(config, true, claimed.reason || 'dashboard-pause')
        runtimeControl?.requestStop('dashboard')
        state.stopRequested = true
        state.startRequested = false
        state.statusDetail = 'pausing-after-current-step'
        requestPauseParking('dashboard-pause-command')
        noteActivity()
        await reportCommandResult(claimed.commandId, 'succeeded', claimed.reason || 'pause requested; bot will remain connected idle')
        break
      }
      case 'assign-nbt': {
        try {
          const message = await handleAssignNbt(claimed)
          await reportCommandResult(claimed.commandId, 'succeeded', message)
        } catch (err) {
          await reportCommandResult(claimed.commandId, 'failed', err?.message || String(err))
        }
        break
      }
      case 'verify': {
        const verifyAction = String(claimed.reason || '').toLowerCase() === 'verified' ? 'verified' : 'refresh'
        if (stdinCommandState.verificationWaiter) {
          const waiter = stdinCommandState.verificationWaiter
          stdinCommandState.verificationWaiter = null
          waiter(verifyAction)
          await reportCommandResult(claimed.commandId, 'succeeded', `verification action=${verifyAction} applied`)
        } else {
          await reportCommandResult(claimed.commandId, 'failed', 'no active verification prompt')
        }
        break
      }
      case 'chat': {
        const msg = String(claimed.message || '').trim()
        if (!msg) {
          await reportCommandResult(claimed.commandId, 'failed', 'chat message is empty')
          break
        }
        try {
          bot.chat(msg)
          noteActivity()
          await reportCommandResult(claimed.commandId, 'succeeded', `sent: ${msg}`)
        } catch (err) {
          await reportCommandResult(claimed.commandId, 'failed', `chat failed: ${err?.message || err}`)
        }
        break
      }
      case 'inventory-snapshot': {
        try {
          const snapshot = buildBotInventorySnapshot()
          await reportCommandResult(
            claimed.commandId,
            'succeeded',
            `inventory: ${snapshot.stackCount} stack(s), ${snapshot.totalCount} item(s)`,
            { inventory: snapshot }
          )
        } catch (err) {
          await reportCommandResult(claimed.commandId, 'failed', `inventory snapshot failed: ${err?.message || err}`)
        }
        break
      }
      case 'dump-inventory': {
        try {
          const materialNames = getKnownBuildMaterials(config, [])
          const stacks = (bot?.inventory?.items?.() || [])
            .filter((stack) => isDumpableInventoryItem(config, stack?.name, materialNames))
          if (!stacks.length) {
            await reportCommandResult(claimed.commandId, 'succeeded', 'no non-essential inventory stacks to dump')
            break
          }
          state.statusDetail = 'dumping-inventory'
          noteActivity()
          const dumped = await dumpCarpetStacks(bot, config, stacks, 'dashboardDumpInventory')
          noteActivity()
          await postStatus()
          if (dumped > 0) {
            await reportCommandResult(claimed.commandId, 'succeeded', `dumped ${dumped} non-essential inventory stack(s)`)
          } else {
            await reportCommandResult(claimed.commandId, 'failed', 'no non-essential inventory stacks were dumped; check dump station config')
          }
        } catch (err) {
          await reportCommandResult(claimed.commandId, 'failed', `dump inventory failed: ${err?.message || err}`)
        }
        break
      }
      case 'disconnect': {
        await reportCommandResult(claimed.commandId, 'succeeded', 'disconnecting bot; auto-reconnect suppressed')
        noteActivity()
        try { bot.quit('dashboard-disconnect') } catch { }
        break
      }
      case 'reconnect': {
        await reportCommandResult(claimed.commandId, 'succeeded', 'force-reconnecting bot')
        noteActivity()
        try { bot.quit('dashboard-reconnect') } catch { }
        break
      }
      case 'reset-current-nbt': {
        setOperatorPaused(config, false, claimed.reason || 'dashboard-reset-current-nbt')
        await requestCurrentNbtReset('dashboard', claimed.commandId)
        break
      }
      case 'platform-cleanup': {
        setOperatorPaused(config, false, claimed.reason || 'dashboard-platform-cleanup')
        await requestPlatformCleanup('dashboard', claimed.commandId)
        break
      }
      case 'restart': {
        await reportCommandResult(claimed.commandId, 'failed', 'restart is not implemented in direct bot mode')
        break
      }
      default: {
        await reportCommandResult(claimed.commandId, 'failed', `unsupported command type: ${claimed.commandType}`)
      }
    }
  }

  async function pollCommands() {
    if (state.commandBusy || state.stopped) return
    state.commandBusy = true
    try {
      await flushQueueResultOutbox()
      if (hasPendingQueueResults()) return
      const handledNodeFile = await handleNodeFileAssignment()
      if (handledNodeFile) return
      const nodeCommand = await claimNextNodeCommand()
      if (nodeCommand) {
        await executeNodeCommand(nodeCommand)
        return
      }
      const response = await createDashboardRequest(`${dashboard.serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands`, 'GET')
      const items = Array.isArray(response.body?.items) ? response.body.items : []
      if (items.length) {
        await executeCommand(items[0])
        return
      }
      const handledQueueFile = await handleQueueFileAssignment()
      if (handledQueueFile) {
        return
      }
    } finally {
      state.commandBusy = false
    }
  }

  const dashboardRuntimeApi = {
    start() {
      stdinCommandState.resetCurrentNbt = async (source = 'terminal') => requestCurrentNbtReset(source)
      void postStatus(false)
      scheduleLoop('heartbeatTimer', dashboard.heartbeatMs, async () => {
        await postStatus()
      })
      scheduleLoop('commandTimer', dashboard.commandPollMs, async () => {
        await pollCommands()
      })
    },
    stop(finalPhase = 'stopped', online = false) {
      state.stopped = true
      if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer)
      if (state.commandTimer) clearTimeout(state.commandTimer)
      if (stdinCommandState.resetCurrentNbt) stdinCommandState.resetCurrentNbt = null
      state.phase = normalizeDashboardPhase(finalPhase)
      state.statusDetail = state.phase
      void postStatus(online)
    },
    noteActivity,
    setPhase(nextPhase, detail = null) {
      state.phase = normalizeDashboardPhase(nextPhase)
      state.statusDetail = detail ? String(detail).trim() : state.phase
      const queueStatus = ['printing', 'repair', 'post-print', 'cleanup'].includes(state.phase) ? state.phase : null
      if (queueStatus && state.activeQueueFile?.fileId && state.activeQueueFile.lastReportedQueueStatus !== queueStatus) {
        state.activeQueueFile.lastReportedQueueStatus = queueStatus
        void reportQueueFileResult(state.activeQueueFile.fileId, queueStatus).catch((error) => {
          logThrottled(`dashboard-queue-phase-${botName}`, `[DASHBOARD-WARN] queue phase report failed for ${botName}: ${error?.message || error}`, {
            intervalMs: 30000,
            level: 'warn'
          })
        })
      }
      noteActivity()
    },
    setStatusDetail(detail) {
      state.statusDetail = String(detail || state.phase || 'idle').trim() || state.phase || 'idle'
      noteActivity()
    },
    setCurrentNbt(sourceName) {
      const next = sourceName ? path.basename(String(sourceName)) : null
      if (next !== state.currentNbt) {
        state.currentNbt = next
        state.currentNbtStartedAt = next ? new Date().toISOString() : null
      }
      noteActivity()
    },
    setRecoveryState(nextState) {
      state.recoveryState = String(nextState || 'none')
      noteActivity()
    },
    setReconnectState(nextState) {
      state.reconnectState = String(nextState || 'idle')
    },
    setLastError(message) {
      const text = String(message || '').trim()
      state.lastError = text
      state.lastErrorAt = text ? new Date().toISOString() : null
      noteActivity()
    },
    clearLastError() {
      state.lastError = ''
      state.lastErrorAt = null
      noteActivity()
    },
    reportWarning(category, message, details = {}) {
      const text = String(message || '').trim()
      if (!text) return
      const key = String(category || 'runtime-warning').trim() || 'runtime-warning'
      const now = new Date().toISOString()
      const previous = state.warnings.find((entry) => entry.category === key && entry.message === text)
      if (previous) {
        previous.lastSeenAt = now
        previous.count = toNumber(previous.count, 1) + 1
        previous.details = details && typeof details === 'object' ? details : {}
      } else {
        state.warnings.push({
          category: key,
          message: text,
          details: details && typeof details === 'object' ? details : {},
          firstSeenAt: now,
          lastSeenAt: now,
          count: 1
        })
      }
      if (state.warnings.length > 20) state.warnings = state.warnings.slice(-20)
      state.statusDetail = text
      noteActivity()
      void postStatus()
    },
    setAlert(category, message, details = {}, level = 'warn') {
      const key = String(category || 'runtime-alert').trim() || 'runtime-alert'
      const text = String(message || '').trim()
      if (!text) return
      const now = new Date().toISOString()
      const existing = state.alerts.find((entry) => entry.category === key)
      if (existing) {
        existing.message = text
        existing.details = details && typeof details === 'object' ? details : {}
        existing.level = String(level || existing.level || 'warn')
        existing.active = true
        existing.lastSeenAt = now
      } else {
        state.alerts.push({
          category: key,
          message: text,
          details: details && typeof details === 'object' ? details : {},
          level: String(level || 'warn'),
          active: true,
          firstSeenAt: now,
          lastSeenAt: now
        })
      }
      if (state.alerts.length > 20) state.alerts = state.alerts.slice(-20)
      state.statusDetail = text
      noteActivity()
      void postStatus()
    },
    clearAlert(category) {
      const key = String(category || '').trim()
      if (!key) return
      const now = new Date().toISOString()
      state.alerts = state.alerts.map((entry) => entry.category === key
        ? { ...entry, active: false, resolvedAt: now }
        : entry)
      noteActivity()
      void postStatus()
    },
    requestPauseParking,
    async completeActiveQueueFile(status = 'placed', reason = null) {
      const active = state.activeQueueFile
      if (!active?.fileId) return false
      try {
        await reportQueueFileResult(active.fileId, status, reason)
        removeQueueResultOutboxItem(active.fileId)
        const terminal = ['placed', 'completed', 'succeeded', 'failed'].includes(String(status || '').trim().toLowerCase())
        if (terminal) {
          forgetQueueFile(active.fileName || active.originalName)
          state.activeQueueFile = null
        }
        return true
      } catch (error) {
        enqueueQueueResult(active, status, reason, error)
        logThrottled(`dashboard-queue-complete-${botName}`, `[DASHBOARD-WARN] queued dashboard result for retry: ${error?.message || error}`, {
          intervalMs: 30000,
          level: 'warn'
        })
        return false
      }
    },
    restoreQueueFileForNbt(filePathOrName) {
      return restoreQueueFileForNbt(filePathOrName)
    },
    getActiveQueueFile() {
      return restoreActiveQueueFile()
    },
    getActiveQueueNbtPath() {
      return getActiveQueueNbtPath()
    },
    consumePlatformCleanupRequest() {
      if (state.platformCleanupRequested !== true) return false
      state.platformCleanupRequested = false
      state.stopRequested = false
      state.startRequested = false
      noteActivity()
      return true
    },
    consumeStartRequest() {
      if (!state.startRequested) return false
      state.startRequested = false
      noteActivity()
      return true
    },
    isStopRequested() {
      return state.stopRequested === true
    },
    markRunStopped(detail = 'idle') {
      state.stopRequested = false
      state.phase = 'idle'
      state.statusDetail = String(detail || 'idle').trim() || 'idle'
      noteActivity()
    }
  }
  return dashboardRuntimeApi
}

async function runDashboardManagedPrintLoop(bot, config, runtimeControl, dashboardRuntime, initialStartRequested = false) {
  let pendingStart = initialStartRequested
  let pauseParked = false
  let lastPauseParkAttemptAt = 0
  const pauseParkRetryMs = Math.max(1000, toNumber(config.advanced?.pauseParkRetryMs, 10000))
  const tryPausePark = async (reason) => {
    if (!isOperatorPaused(config)) return false
    const now = Date.now()
    if (pauseParked) {
      dashboardRuntime?.setPhase?.('paused', 'paused')
      return true
    }
    if (lastPauseParkAttemptAt && now - lastPauseParkAttemptAt < pauseParkRetryMs) {
      dashboardRuntime?.setPhase?.('paused', 'paused')
      return false
    }
    lastPauseParkAttemptAt = now
    pauseParked = await parkAtCartographyAccessForPause(bot, config, dashboardRuntime, reason)
    return pauseParked
  }
  while (isBotSessionLive(bot) && bot.__nervSessionActive !== false) {
    if (dashboardRuntime?.consumePlatformCleanupRequest?.() === true) {
      printingIntentActive = false
      dashboardRuntime?.setCurrentNbt(null)
      dashboardRuntime?.setPhase('cleanup', 'reset-everything-platform-cleanup')
      const cleanup = cleanLocalFreshStartFiles(config, 'dashboard-reset-everything')
      console.log(`[RESET-EVERYTHING] Local cleanup deleted node=${cleanup.nodeNbtDeleted.length} finished=${cleanup.finishedNbtDeleted.length} state=${cleanup.stateDeleted.length} sync=${cleanup.syncDeleted.length} errors=${cleanup.errors.length}.`)
      try {
        await runPlatformResetPreflight(bot, config, 'reset-everything')
        dashboardRuntime?.markRunStopped?.('reset-everything-complete')
      } catch (err) {
        dashboardRuntime?.setLastError?.(`reset-everything platform cleanup failed: ${err?.message || err}`)
        dashboardRuntime?.markRunStopped?.('reset-everything-platform-cleanup-failed')
      }
      await delay(1000)
      continue
    }

    if (runtimeControl?.isStopRequested()) {
      dashboardRuntime?.markRunStopped?.(isOperatorPaused(config) ? 'paused' : 'stopped')
      await tryPausePark('operator-pause-idle')
      await delay(1000)
      continue
    }

    const shouldStart = pendingStart || runtimeControl?.consumeStartRequest() === true || dashboardRuntime?.consumeStartRequest() === true
    pendingStart = false
    if (shouldStart) {
      pauseParked = false
      lastPauseParkAttemptAt = 0
    }

    const activeQueueFile = dashboardRuntime?.getActiveQueueFile?.()
    const activeQueuePath = dashboardRuntime?.getActiveQueueNbtPath?.()
    if (activeQueueFile?.fileId && !activeQueuePath) {
      const message = `claimed dashboard queue NBT is missing locally: ${activeQueueFile.fileName || activeQueueFile.originalName || activeQueueFile.fileId}`
      console.warn(`[DASHBOARD-WARN] ${message}`)
      await dashboardRuntime?.completeActiveQueueFile?.('failed', message)
      dashboardRuntime?.setCurrentNbt(null)
      dashboardRuntime?.setPhase('idle')
      await delay(1000)
      continue
    }

    if (!shouldStart) {
      if (isOperatorPaused(config)) {
        await tryPausePark('operator-pause-idle')
        await delay(1000)
        continue
      }
      const localQueuedNbt = activeQueuePath || getNextNbtFile(config)
      if (localQueuedNbt) {
        console.log(`[DASHBOARD] Auto-starting queued local NBT: ${path.basename(localQueuedNbt)}`)
        pendingStart = true
        await delay(250)
        continue
      }
      dashboardRuntime?.setPhase('idle')
      await delay(1000)
      continue
    }

    const claimedQueueNbt = activeQueuePath
    const nextNbt = claimedQueueNbt || getNextNbtFile(config)
    runtimeControl?.markRunStarted('runtime')
    dashboardRuntime?.restoreQueueFileForNbt?.(nextNbt)
    dashboardRuntime?.setCurrentNbt(nextNbt ? path.basename(nextNbt) : null)
    dashboardRuntime?.setPhase('printing')
    try {
      config.__runtimeControl = runtimeControl || null
      config.__dashboardQueueNbtPath = claimedQueueNbt || null
      const runInfo = await runPrint(bot, config, dashboardRuntime)
      dashboardRuntime?.clearLastError?.()
      dashboardRuntime?.setCurrentNbt(runInfo?.sourceName || null)

      if (runInfo?.sourceType !== 'nbt') {
        dashboardRuntime?.setCurrentNbt(null)
        dashboardRuntime?.setPhase('idle')
        await delay(1000)
        continue
      }

      if (runInfo?.didWork === false) {
        dashboardRuntime?.setCurrentNbt(null)
        dashboardRuntime?.setPhase('idle')
        await delay(1000)
        continue
      }

      if (!runInfo?.postPrintPending) {
        if (claimedQueueNbt && runInfo?.sourceType === 'nbt') {
          retireDashboardQueueNbt(runInfo.sourcePath || claimedQueueNbt, config)
        }
        await dashboardRuntime?.completeActiveQueueFile?.('placed', 'printed and post-print workflow completed')
      }

      const nextQueuedNbt = config.files?.moveToFinishedFolder === true && !claimedQueueNbt ? getNextNbtFile(config) : null
      if (nextQueuedNbt && !runInfo?.postPrintPending && !isRuntimeStopRequested(config)) {
        console.log(`[STATE] Continuing with next map: ${path.basename(nextQueuedNbt)}`)
        dashboardRuntime?.setCurrentNbt(path.basename(nextQueuedNbt))
        pendingStart = true
        await delay(250)
        continue
      }

      if (!runInfo?.postPrintPending) {
        dashboardRuntime?.setCurrentNbt(null)
      }
      dashboardRuntime?.setPhase('idle')
      if (config.files?.moveToFinishedFolder === true) {
        console.log('[STATE] No queued NBT files found. Waiting idle.')
      } else {
        await delay(1000)
      }
    } catch (err) {
      if (isRuntimeStopError(err)) {
        console.log('[CONTROL] Pause requested; paused current work and returned to dashboard idle.')
        dashboardRuntime?.markRunStopped?.('paused')
        pauseParked = false
        lastPauseParkAttemptAt = 0
        await tryPausePark('operator-pause-after-work')
        await delay(1000)
        continue
      }
      const text = String(err?.message || err)
      dashboardRuntime?.setLastError(text)
      const noMoreInput = text.includes('No NBT files found in folder:') || text.includes('No input found.')
      if (noMoreInput) {
        console.log('[STATE] No more map files found. Waiting idle.')
        await dashboardRuntime?.completeActiveQueueFile?.('failed', text)
        dashboardRuntime?.setCurrentNbt(null)
        dashboardRuntime?.setPhase('idle')
        await delay(1000)
        continue
      }
      if (claimedQueueNbt && shouldHoldQueueFileAfterRuntimeError(text)) {
        console.log(`[DASHBOARD-WARN] Holding active queue NBT for local resume after transient runtime error: ${text}`)
        await dashboardRuntime?.completeActiveQueueFile?.('held', text)
        dashboardRuntime?.setPhase('idle')
        await delay(1000)
        continue
      }
      await dashboardRuntime?.completeActiveQueueFile?.('failed', text)
      throw err
    } finally {
      runtimeControl?.markRunCompleted()
      config.__runtimeControl = null
      config.__runtimeStopHandler = null
      config.__dashboardQueueNbtPath = null
    }
  }
}

function getMeteorSceneConfig(config) {
  const raw = config?.advanced?.meteorSceneAwareness
  if (raw === false) {
    return {
      enabled: false,
      platformEnabled: false,
      file: null,
      minScore: 0.72,
      labelHints: {}
    }
  }

  return {
    enabled: raw?.enabled !== false,
    platformEnabled: raw?.platformEnabled !== false,
    file: raw?.file || path.resolve(process.cwd(), 'spatial-awareness', 'meteor-scene-signatures.json'),
    minScore: Math.max(0.45, Math.min(0.98, toNumber(raw?.minScore, 0.72))),
    labelHints: raw?.labelHints && typeof raw.labelHints === 'object' ? raw.labelHints : {}
  }
}

function isPlatformPositionCacheEnabled(config) {
  return config?.bot?.platformPositionCacheEnabled !== false
}

function getMeteorSceneNonAirBlocks(scene) {
  return Math.max(0, toNumber(scene?.playerFingerprint?.nonAirBlocks, 0))
}

function isUsableMeteorScene(scene) {
  if (!scene || typeof scene !== 'object') return false
  const label = String(scene.label || '').trim().toLowerCase()
  if (!label || label === 'scenes') return false
  const nonAirBlocks = getMeteorSceneNonAirBlocks(scene)
  const topBlocks = Array.isArray(scene?.playerFingerprint?.topBlocks) ? scene.playerFingerprint.topBlocks.length : 0
  const hasPortalTarget = scene?.portalTarget?.found === true
  const insidePortal = scene?.insidePortalBlock === true
  return nonAirBlocks >= 24 || topBlocks > 0 || hasPortalTarget || insidePortal
}

function readMeteorSceneSnapshot(config) {
  const meteor = getMeteorSceneConfig(config)
  if (!meteor.enabled || !meteor.file) return null
  const data = readOptionalJson(meteor.file)
  if (!data || data.format !== 'comic-auto-portal-spatial-scenes-v1') return null
  const scenes = Array.isArray(data.scenes) ? data.scenes.filter(isUsableMeteorScene) : []
  if (!scenes.length) return null
  return { ...data, scenes }
}

function countMapFromEntries(entries) {
  const map = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name || '').trim()
    if (!name) continue
    map[name] = toNumber(entry?.count, 0)
  }
  return map
}

function sumCounts(map) {
  return Object.values(map || {}).reduce((sum, value) => sum + Math.max(0, toNumber(value, 0)), 0)
}

function normalizeCountMap(map) {
  const total = sumCounts(map)
  if (total <= 0) return { total: 0, ratios: {} }
  const ratios = {}
  for (const [name, count] of Object.entries(map || {})) {
    const ratio = Math.max(0, toNumber(count, 0)) / total
    if (ratio > 0) ratios[name] = ratio
  }
  return { total, ratios }
}

function computeFingerprintOverlap(actualMap, expectedMap) {
  const actual = normalizeCountMap(actualMap)
  const expected = normalizeCountMap(expectedMap)
  if (actual.total <= 0 || expected.total <= 0) return 0
  const names = new Set([...Object.keys(actual.ratios), ...Object.keys(expected.ratios)])
  let overlap = 0
  for (const name of names) {
    overlap += Math.min(actual.ratios[name] || 0, expected.ratios[name] || 0)
  }
  return Math.max(0, Math.min(1, overlap))
}

function extractRelevantChatMessages(scene) {
  return (Array.isArray(scene?.recentServerMessages) ? scene.recentServerMessages : [])
    .map((entry) => String(entry?.text || '').trim())
    .filter(Boolean)
}

function topCountEntries(counts, limit = 14) {
  return Object.entries(counts || {})
    .filter(([name]) => name && name !== 'air' && name !== 'cave_air' && name !== 'void_air' && name !== 'unloaded')
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit))
    .map(([name, count]) => ({ name, count }))
}

function buildMeteorSignatureEntries(counts) {
  const names = [
    'nether_portal',
    'obsidian',
    'crying_obsidian',
    'bedrock',
    'end_stone',
    'end_stone_bricks',
    'stone_bricks',
    'deepslate_tiles',
    'sea_lantern',
    'glowstone',
    'glass',
    'iron_bars',
    'barrier',
    'snow_block',
    'blue_ice',
    'smooth_stone',
    'water',
    'dispenser',
    'repeater',
    'redstone_wire'
  ]
  return names.map((name) => ({ name, count: toNumber(counts?.[name], 0) }))
}

function canReadBotWorld(bot) {
  return Boolean(bot?.world && typeof bot.world.getBlock === 'function' && typeof bot?.blockAt === 'function')
}

function rememberRecentServerMessage(bot, message, source = 'chat') {
  const text = String(message || '').trim()
  if (!text) return
  if (!Array.isArray(bot.__nervRecentServerMessages)) {
    bot.__nervRecentServerMessages = []
  }
  bot.__nervRecentServerMessages.push({ text, source, at: Date.now() })
  const max = 8
  if (bot.__nervRecentServerMessages.length > max) {
    bot.__nervRecentServerMessages.splice(0, bot.__nervRecentServerMessages.length - max)
  }
}

function detectMeteorSceneAction(scene, config) {
  const label = String(scene?.label || '').toLowerCase()
  const loginSceneAwarenessEnabled = config?.advanced?.meteorSceneAwareness?.loginPortalEnabled === true
  const platformSceneAwarenessEnabled = getMeteorSceneConfig(config).platformEnabled !== false
  const explicit = String(getMeteorSceneConfig(config).labelHints?.[label] || '').trim().toLowerCase()
  if (explicit) {
    if (explicit === 'platform' && !platformSceneAwarenessEnabled) return 'unknown'
    if (explicit === 'login-portal' && !loginSceneAwarenessEnabled) return 'unknown'
    return explicit
  }

  const dimension = String(scene?.dimension || '').toLowerCase()
  const portalFound = scene?.portalTarget?.found === true
  const topBlocks = countMapFromEntries(scene?.playerFingerprint?.topBlocks)
  const signatureBlocks = countMapFromEntries(scene?.playerFingerprint?.signatureBlocks)
  const recentMessages = extractRelevantChatMessages(scene).join(' ').toLowerCase()
  const looksLikeLoginPortal = recentMessages.includes('enter the server through the portal') || (dimension.includes('the_end') && portalFound)

  if (label.includes('platform')) return platformSceneAwarenessEnabled ? 'platform' : 'unknown'
  if (looksLikeLoginPortal) return loginSceneAwarenessEnabled ? 'login-portal' : 'unknown'
  if ((signatureBlocks.nether_portal || 0) >= 20 && (topBlocks.snow_block || 0) >= 100) return 'spawn-portal'
  if (label.includes('spawn') && portalFound) return 'spawn-portal'
  return portalFound ? 'spawn-portal' : 'unknown'
}

function buildMeteorScenePortalPoint(scene) {
  const target = scene?.portalTarget
  if (target?.found !== true || !target?.position) return null
  if (!Number.isFinite(Number(target.position.x)) || !Number.isFinite(Number(target.position.y)) || !Number.isFinite(Number(target.position.z))) return null
  return {
    x: Number(target.position.x),
    y: Number(target.position.y),
    z: Number(target.position.z),
    range: 2
  }
}

function buildMeteorScenePlayerPoint(scene) {
  const pos = scene?.playerPosition
  if (!pos) return null
  if (!Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y)) || !Number.isFinite(Number(pos.z))) return null
  return {
    x: Number(pos.x),
    y: Number(pos.y),
    z: Number(pos.z)
  }
}

function buildMeteorSceneMovementHint(scene) {
  const hint = scene?.movementHint
  if (!hint || hint.enabled === false) return null
  return {
    enabled: hint.enabled !== false,
    lookAtPortal: hint.lookAtPortal !== false,
    forwardMs: Math.max(0, toNumber(hint.forwardMs, 0)),
    strafe: String(hint.strafe || 'none').trim().toLowerCase(),
    jump: hint.jump === true,
    sprint: hint.sprint === true,
    capturedYaw: Number.isFinite(Number(hint.capturedYaw)) ? Number(hint.capturedYaw) : null,
    capturedPitch: Number.isFinite(Number(hint.capturedPitch)) ? Number(hint.capturedPitch) : null
  }
}

function getMeteorSceneCapturedAtMs(scene) {
  const value = Date.parse(String(scene?.capturedAt || ''))
  return Number.isFinite(value) ? value : 0
}

function getMeteorSceneFlowStage(label) {
  const text = String(label || '').toLowerCase()
  if (text.includes('portal-enter')) return 3
  if (text.includes('dimension-change') || text.includes('post-portal')) return 2
  if (text.includes('teleport')) return 1
  if (text.includes('start')) return 0
  return -1
}

function getMeteorSceneFlowFamily(label) {
  const text = String(label || '').trim().toLowerCase()
  if (!text) return ''
  const match = text.match(/^(.*?)-\d+-(start|teleport|portal-enter|dimension-change|post-portal)$/)
  return match ? match[1] : text
}

function captureMeteorSceneFingerprint(bot, config) {
  if (!canReadBotWorld(bot)) {
    return {
      topBlocks: {},
      signatureBlocks: {},
      insidePortalBlock: false,
      recentMessages: Array.isArray(bot?.__nervRecentServerMessages)
        ? bot.__nervRecentServerMessages.slice(-5).map((entry) => String(entry?.text || '').trim()).filter(Boolean)
        : [],
      worldReady: false
    }
  }

  const radius = Math.max(4, Math.min(32, toNumber(config?.advanced?.meteorSceneAwareness?.scanRadius, 20)))
  const verticalRadius = Math.max(2, Math.min(8, toNumber(config?.advanced?.meteorSceneAwareness?.verticalRadius, 5)))
  const scan = scanSpatialBlocks(bot, {
    ...config,
    advanced: {
      ...(config.advanced || {}),
      spatialAwareness: {
        ...(config.advanced?.spatialAwareness || {}),
        scanRadius: radius,
        verticalRadius
      }
    }
  })

  return {
    topBlocks: countMapFromEntries(topCountEntries(scan.counts, 14)),
    signatureBlocks: countMapFromEntries(buildMeteorSignatureEntries(scan.counts)),
    insidePortalBlock: getBlockNameAt(bot, bot?.entity?.position) === 'nether_portal',
    recentMessages: Array.isArray(bot.__nervRecentServerMessages)
      ? bot.__nervRecentServerMessages.slice(-5).map((entry) => String(entry?.text || '').trim()).filter(Boolean)
      : [],
    worldReady: true
  }
}

function scoreMeteorScene(scene, actualFingerprint, bot, config) {
  const expectedTop = countMapFromEntries(scene?.playerFingerprint?.topBlocks)
  const expectedSignature = countMapFromEntries(scene?.playerFingerprint?.signatureBlocks)
  const topScore = computeFingerprintOverlap(actualFingerprint.topBlocks, expectedTop)
  const signatureScore = computeFingerprintOverlap(actualFingerprint.signatureBlocks, expectedSignature)
  const actualDimension = String(bot?.game?.dimension || '').toLowerCase()
  const expectedDimension = String(scene?.dimension || '').toLowerCase()
  const dimensionScore = actualDimension && expectedDimension ? (actualDimension === expectedDimension ? 1 : 0) : 0.5
  const actualInsidePortal = actualFingerprint.insidePortalBlock === true
  const expectedInsidePortal = scene?.insidePortalBlock === true
  const portalStateScore = actualInsidePortal === expectedInsidePortal ? 1 : 0

  const chatText = actualFingerprint.recentMessages.join(' ').toLowerCase()
  const expectedChats = extractRelevantChatMessages(scene).map((value) => value.toLowerCase())
  const chatScore = !expectedChats.length ? 0.5 : (expectedChats.some((value) => chatText.includes(value)) ? 1 : 0)
  const score = (signatureScore * 0.4) + (topScore * 0.3) + (dimensionScore * 0.1) + (chatScore * 0.1) + (portalStateScore * 0.1)

  return {
    label: String(scene?.label || 'unknown'),
    action: detectMeteorSceneAction(scene, config),
    score,
    topScore,
    signatureScore,
    dimensionScore,
    chatScore,
    portalStateScore,
    capturedAtMs: getMeteorSceneCapturedAtMs(scene),
    flowStage: getMeteorSceneFlowStage(scene?.label),
    portalPoint: buildMeteorScenePortalPoint(scene),
    playerPoint: buildMeteorScenePlayerPoint(scene),
    movementHint: buildMeteorSceneMovementHint(scene),
    scene
  }
}

function isTrustedMeteorSceneMatch(match, positionMissing = false) {
  if (!match?.best) return false
  if (match.matched) return true

  const best = match.best
  if (!positionMissing) return false

  if (best.action === 'spawn-portal' && best.score >= 0.55 && best.portalPoint && best.playerPoint) {
    return true
  }

  if (best.action === 'platform' && best.score >= 0.82 && best.playerPoint) {
    return true
  }

  return false
}

function matchMeteorScene(bot, config) {
  const snapshot = readMeteorSceneSnapshot(config)
  if (!snapshot?.scenes?.length) return null
  if (!isBotSessionLive(bot)) return null
  if (!canReadBotWorld(bot)) return null

  const actualFingerprint = captureMeteorSceneFingerprint(bot, config)
  const candidates = snapshot.scenes
    .map((scene) => scoreMeteorScene(scene, actualFingerprint, bot, config))
    .sort((a, b) => {
      const scoreDelta = b.score - a.score
      if (Math.abs(scoreDelta) > 0.0001) return scoreDelta
      const stageDelta = b.flowStage - a.flowStage
      if (stageDelta !== 0) return stageDelta
      return b.capturedAtMs - a.capturedAtMs
    })

  if (!candidates.length) return null
  const minScore = getMeteorSceneConfig(config).minScore
  return {
    matched: candidates[0].score >= minScore,
    minScore,
    best: candidates[0],
    candidates: candidates.slice(0, 3)
  }
}

function getMostRecentMeteorSceneByAction(config, action) {
  const snapshot = readMeteorSceneSnapshot(config)
  const wantedAction = String(action || '').trim().toLowerCase()
  if (!snapshot?.scenes?.length || !wantedAction) return null

  const candidates = snapshot.scenes
    .map((scene) => ({
      label: String(scene?.label || 'unknown'),
      action: detectMeteorSceneAction(scene, config),
      score: 1,
      topScore: 1,
      signatureScore: 1,
      dimensionScore: 1,
      chatScore: 1,
      portalStateScore: scene?.insidePortalBlock === true ? 1 : 0,
      capturedAtMs: getMeteorSceneCapturedAtMs(scene),
      flowStage: getMeteorSceneFlowStage(scene?.label),
      portalPoint: buildMeteorScenePortalPoint(scene),
      playerPoint: buildMeteorScenePlayerPoint(scene),
      movementHint: buildMeteorSceneMovementHint(scene),
      scene
    }))
    .filter((entry) => entry.action === wantedAction)
    .sort((a, b) => b.capturedAtMs - a.capturedAtMs)

  if (!candidates.length) return null

  return {
    matched: true,
    minScore: getMeteorSceneConfig(config).minScore,
    best: candidates[0],
    candidates: candidates.slice(0, 3)
  }
}

function getHighestScoredMeteorSceneByAction(bot, config, action) {
  const snapshot = readMeteorSceneSnapshot(config)
  const wantedAction = String(action || '').trim().toLowerCase()
  if (!snapshot?.scenes?.length || !wantedAction || !isBotSessionLive(bot)) return null
  if (!canReadBotWorld(bot)) return null

  const actualFingerprint = captureMeteorSceneFingerprint(bot, config)
  const candidates = snapshot.scenes
    .map((scene) => scoreMeteorScene(scene, actualFingerprint, bot, config))
    .filter((entry) => entry.action === wantedAction)
    .sort((a, b) => {
      const scoreDelta = b.score - a.score
      if (Math.abs(scoreDelta) > 0.0001) return scoreDelta
      const stageDelta = b.flowStage - a.flowStage
      if (stageDelta !== 0) return stageDelta
      return b.capturedAtMs - a.capturedAtMs
    })

  if (!candidates.length) return null
  return {
    matched: candidates[0].score >= getMeteorSceneConfig(config).minScore,
    minScore: getMeteorSceneConfig(config).minScore,
    best: candidates[0],
    candidates: candidates.slice(0, 3)
  }
}

function summarizeCountMap(map, limit = 5) {
  const entries = Object.entries(map || {})
    .filter(([, count]) => toNumber(count, 0) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit))
  return entries.length ? entries.map(([name, count]) => `${name}:${count}`).join(', ') : 'none'
}

function collectMeteorSceneFlowEntries(match, config) {
  const best = match?.best
  if (!best?.scene) return []

  const snapshot = readMeteorSceneSnapshot(config)
  const bestFamily = getMeteorSceneFlowFamily(best.label)
  const bestDimension = String(best.scene?.dimension || '').toLowerCase()
  const bestPortalPoint = best.portalPoint || null
  const bestCapturedAt = toNumber(best.capturedAtMs, 0)
  const bestStage = toNumber(best.flowStage, -1)

  const entries = Array.isArray(snapshot?.scenes)
    ? snapshot.scenes
      .map((scene) => ({
        label: String(scene?.label || 'unknown'),
        action: detectMeteorSceneAction(scene, config),
        dimension: String(scene?.dimension || '').toLowerCase(),
        playerPoint: buildMeteorScenePlayerPoint(scene),
        portalPoint: buildMeteorScenePortalPoint(scene),
        movementHint: buildMeteorSceneMovementHint(scene),
        insidePortalBlock: scene?.insidePortalBlock === true,
        capturedAtMs: getMeteorSceneCapturedAtMs(scene),
        flowStage: getMeteorSceneFlowStage(scene?.label),
        scene
      }))
      .filter((entry) => entry.action === best.action)
      .filter((entry) => !bestDimension || !entry.dimension || entry.dimension === bestDimension)
      .filter((entry) => {
        const sameFamily = bestFamily && getMeteorSceneFlowFamily(entry.label) === bestFamily
        const samePortal = bestPortalPoint && entry.portalPoint && distanceToPoint(bestPortalPoint, entry.portalPoint) <= 3.5
        return sameFamily || samePortal || entry.label === best.label
      })
      .filter((entry) => entry.flowStage >= bestStage)
      .filter((entry) => entry.capturedAtMs >= Math.max(0, bestCapturedAt - 15000) && entry.capturedAtMs <= bestCapturedAt + 45000)
    : []

  if (!entries.length) return []

  const newestCapture = entries.reduce((maxValue, entry) => Math.max(maxValue, toNumber(entry.capturedAtMs, 0)), 0)
  const recentWindowStart = Math.max(0, newestCapture - 60000)

  return entries
    .filter((entry) => entry.capturedAtMs >= recentWindowStart)
    .sort((a, b) => {
      const stageDelta = a.flowStage - b.flowStage
      if (stageDelta !== 0) return stageDelta
      return a.capturedAtMs - b.capturedAtMs
    })
}

function buildMeteorSceneRoute(match, config) {
  const best = match?.best
  if (!best?.scene || !best.playerPoint) return []

  const scoredRoute = collectMeteorSceneFlowEntries(match, config)
    .filter((entry) => entry.playerPoint)

  const route = []
  for (const entry of scoredRoute) {
    const point = {
      ...entry.playerPoint,
      range: entry.insidePortalBlock ? 0 : 1.5,
      exact: entry.insidePortalBlock,
      label: entry.label,
      insidePortalBlock: entry.insidePortalBlock
    }
    const duplicate = route.some((existing) => distanceToPoint(existing, point) <= 1.25)
    if (!duplicate) route.push(point)
  }

  if (!route.length) {
    route.push({ ...best.playerPoint, range: 1.5, exact: false, label: best.label, insidePortalBlock: false })
  }

  return route
}

function buildMeteorSceneMovementSequence(match, config) {
  return collectMeteorSceneFlowEntries(match, config)
    .filter((entry) => entry.movementHint)
    .map((entry) => ({
      label: entry.label,
      action: entry.action,
      portalPoint: entry.portalPoint,
      movementHint: entry.movementHint,
      insidePortalBlock: entry.insidePortalBlock,
      flowStage: entry.flowStage,
      capturedAtMs: entry.capturedAtMs
    }))
}

function describeLobbyPortalSurroundings(bot, config) {
  const fingerprint = captureMeteorSceneFingerprint(bot, config)
  const match = matchMeteorScene(bot, config)
  const top = summarizeCountMap(fingerprint.topBlocks, 6)
  const signature = summarizeCountMap(fingerprint.signatureBlocks, 6)
  const sceneLabel = match?.best?.label || 'none'
  const sceneAction = match?.best?.action || 'unknown'
  const sceneScore = Number.isFinite(match?.best?.score) ? match.best.score.toFixed(3) : 'n/a'
  const sourceTop = top !== 'none'
    ? top
    : summarizeCountMap(countMapFromEntries(match?.best?.scene?.playerFingerprint?.topBlocks), 6)
  const sourceSignature = signature !== 'none'
    ? signature
    : summarizeCountMap(countMapFromEntries(match?.best?.scene?.playerFingerprint?.signatureBlocks), 6)
  const insidePortal = fingerprint.insidePortalBlock === true
  return `insidePortal=${insidePortal} top=${sourceTop} signature=${sourceSignature} scene=${sceneLabel} action=${sceneAction} score=${sceneScore}`
}

function logMeteorSceneMatch(match, reason = 'meteor-scene') {
  if (!match?.best) return
  const best = match.best
  const key = `${reason}|${match.matched ? 'matched' : 'weak'}|${best.label}|${best.action}`
  const now = Date.now()
  const previous = logMeteorSceneMatch._last || {}
  if (previous.key === key && now - toNumber(previous.at, 0) < 15000) return
  logMeteorSceneMatch._last = { key, at: now }
  const qualifier = match.matched ? 'matched' : (isTrustedMeteorSceneMatch(match, true) ? 'trusted-fallback' : 'weak-match')
  console.log(`[METEOR-SCENE] ${qualifier} reason=${reason} label=${best.label} action=${best.action} score=${best.score.toFixed(3)} top=${best.topScore.toFixed(3)} signature=${best.signatureScore.toFixed(3)} dimension=${best.dimensionScore.toFixed(3)} chat=${best.chatScore.toFixed(3)} threshold=${match.minScore.toFixed(3)}`)
}

function seedBotPositionFromMeteorScene(bot, match, reason = 'meteor-scene-seed') {
  if (!match?.best?.playerPoint) return false
  return seedBotPosition(bot, match.best.playerPoint, `${reason}: seeded from meteor scene '${match.best.label}' action=${match.best.action} score=${match.best.score.toFixed(3)}`)
}

function updateLobbyPortalConfigFromMeteorScene(config, match) {
  if ((!match?.matched && !isTrustedMeteorSceneMatch(match, true)) || !match.best?.portalPoint) return false
  const portalConfig = getLobbyPortalConfig(config)
  if (!portalConfig?.enabled) return false

  if (match.best.action === 'spawn-portal') {
    const spawn = portalConfig.spawnDisk || (portalConfig.spawnDisk = {})
    spawn.useConfiguredPortalTarget = true
    spawn.portal = {
      x: match.best.portalPoint.x,
      y: match.best.portalPoint.y,
      z: match.best.portalPoint.z
    }
    return true
  }

  if (match.best.action === 'login-portal') {
    const login = portalConfig.loginPortal || (portalConfig.loginPortal = {})
    login.enabled = true
    login.x = match.best.portalPoint.x
    login.y = match.best.portalPoint.y
    login.z = match.best.portalPoint.z
    return true
  }

  return false
}

function classifyRuntimePosition(bot, config, reason = 'runtime-classify') {
  const position = getSpatialReferencePosition(bot, config, reason)
  const classification = classifySpatialPosition(position, config)
  if (classification.state !== 'off-platform' && classification.state !== 'missing-position') {
    return { source: 'coords', classification, meteor: null }
  }

  const meteor = matchMeteorScene(bot, config)
  if (!meteor?.best) return { source: 'coords', classification, meteor: null }
  logMeteorSceneMatch(meteor, reason)
  if (!meteor.matched && !isTrustedMeteorSceneMatch(meteor, classification.state === 'missing-position')) {
    return { source: 'coords', classification, meteor }
  }

  if (meteor.best.action === 'platform') {
    return {
      source: 'meteor',
      classification: { state: 'platform', platform: true, meteorLabel: meteor.best.label },
      meteor
    }
  }

  if (meteor.best.action === 'login-portal') {
    return {
      source: 'meteor',
      classification: { state: 'login-portal-scene', platform: false, meteorLabel: meteor.best.label },
      meteor
    }
  }

  if (meteor.best.action === 'spawn-portal') {
    return {
      source: 'meteor',
      classification: { state: 'spawn-portal-scene', platform: false, meteorLabel: meteor.best.label },
      meteor
    }
  }

  return { source: 'coords', classification, meteor }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function readProgressState(filePath) {
  return readOptionalJson(filePath)
}

function writeProgressState(filePath, state) {
  writeJson(filePath, state)
}

function clearProgressState(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

function compactProgressDetails(details = {}) {
  const compacted = {}
  for (const [key, value] of Object.entries(details || {})) {
    if (value !== undefined) compacted[key] = value
  }
  return compacted
}

function createProgressState(input, totalTargets, processedTargets, phase, details = {}) {
  const progressDetails = compactProgressDetails(details)
  const state = {
    sourceType: input.sourceType,
    sourceName: input.sourceName,
    sourcePath: input.sourcePath,
    totalTargets,
    processedTargets: Math.max(0, Math.min(totalTargets, toNumber(processedTargets, 0))),
    phase,
    state: progressDetails.state || phase,
    updatedAt: new Date().toISOString()
  }

  for (const [key, value] of Object.entries(progressDetails)) {
    if (key !== 'state') state[key] = value
  }

  return state
}

function writeProgressSnapshot(filePath, input, totalTargets, processedTargets, phase, details = {}) {
  writeProgressState(filePath, createProgressState(input, totalTargets, processedTargets, phase, details))
}

function getProgressFilePath(config) {
  return path.resolve(process.cwd(), config.files?.progressFile || './logs/nerv-printer-progress.json')
}

function getOperatorPauseFilePath(config) {
  const progressFile = getProgressFilePath(config)
  const parsed = path.parse(progressFile)
  return path.join(parsed.dir, `${parsed.name}-control.json`)
}

function readOperatorPauseState(config) {
  const state = readOptionalJson(getOperatorPauseFilePath(config))
  return state && typeof state === 'object' ? state : {}
}

function isOperatorPaused(config) {
  return readOperatorPauseState(config).operatorPaused === true
}

function isOperatorPauseHoldActive(config) {
  if (isOperatorPaused(config)) return true
  if (config?.__runtimeControl?.isStopRequested?.() === true) return true
  if (config?.__dashboardRuntime?.isStopRequested?.() === true) return true
  return false
}

function setOperatorPaused(config, paused, reason = 'operator-command') {
  const filePath = getOperatorPauseFilePath(config)
  const previous = readOperatorPauseState(config)
  const next = {
    ...previous,
    operatorPaused: paused === true,
    reason: String(reason || 'operator-command'),
    updatedAt: new Date().toISOString()
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  writeJson(filePath, next)
  return next
}

function unlinkFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const stats = fs.statSync(filePath)
  if (!stats.isFile()) return false
  fs.unlinkSync(filePath)
  return true
}

function deleteFilesInFolder(folderPath, predicate) {
  const folder = path.resolve(process.cwd(), folderPath)
  const deleted = []
  const errors = []
  if (!fs.existsSync(folder)) return { deleted, errors }

  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (typeof predicate === 'function' && !predicate(entry.name)) continue
    const filePath = path.join(folder, entry.name)
    try {
      fs.unlinkSync(filePath)
      deleted.push(entry.name)
    } catch (err) {
      errors.push({ fileName: entry.name, error: err?.message || String(err) })
    }
  }

  return { deleted, errors }
}

function cleanLocalFreshStartFiles(config, reason = 'reset-everything') {
  const nbtFolder = path.resolve(process.cwd(), config.files?.nbtFolder || './nerv-printer-config')
  const finishedFolder = path.resolve(process.cwd(), config.files?.finishedFolder || './finished-maps')
  const syncFolder = resolveMultiSyncFolder(config)
  const result = {
    reason,
    nodeNbtDeleted: [],
    finishedNbtDeleted: [],
    stateDeleted: [],
    syncDeleted: [],
    errors: []
  }

  const nodeDelete = deleteFilesInFolder(nbtFolder, (name) => String(name || '').toLowerCase().endsWith('.nbt'))
  result.nodeNbtDeleted.push(...nodeDelete.deleted)
  result.errors.push(...nodeDelete.errors.map((entry) => ({ ...entry, scope: 'node-nbt' })))

  const finishedDelete = deleteFilesInFolder(finishedFolder, (name) => String(name || '').toLowerCase().endsWith('.nbt'))
  result.finishedNbtDeleted.push(...finishedDelete.deleted)
  result.errors.push(...finishedDelete.errors.map((entry) => ({ ...entry, scope: 'finished-nbt' })))

  const stateFiles = [
    getProgressFilePath(config),
    getOperatorPauseFilePath(config),
    path.join(nbtFolder, '.dashboard-queue.json'),
    path.join(nbtFolder, '.dashboard-queue-results.json')
  ]
  for (const filePath of stateFiles) {
    try {
      if (unlinkFileIfExists(filePath)) result.stateDeleted.push(path.basename(filePath))
    } catch (err) {
      result.errors.push({ scope: 'state', fileName: path.basename(filePath), error: err?.message || String(err) })
    }
  }

  if (syncFolder && fs.existsSync(syncFolder)) {
    const syncDelete = deleteFilesInFolder(syncFolder, (name) => String(name || '').toLowerCase().endsWith('.json'))
    result.syncDeleted.push(...syncDelete.deleted)
    result.errors.push(...syncDelete.errors.map((entry) => ({ ...entry, scope: 'multi-sync' })))
  }

  return result
}

function normalizeResumePhase(phase) {
  const value = String(phase || 'printing').toLowerCase()
  if (value === 'repair' || value.startsWith('repair_')) return 'repair'
  if (value === 'post_print' || value.startsWith('post_print')) return 'post_print'
  if (value === 'finished') return 'finished'
  return 'printing'
}

function markCurrentNbtResetRequested(config, reason = 'dashboard-reset-current-nbt', sessionNumber = null) {
  const files = config.files || {}
  if (files.resumeProgress === false) {
    throw new Error('progress resume is disabled; cannot reset current NBT safely')
  }

  const progressFile = getProgressFilePath(config)
  const previous = readProgressState(progressFile)
  if (!previous) {
    throw new Error('no active progress checkpoint found for current NBT')
  }

  const phase = normalizeResumePhase(previous.phase)
  if (phase === 'finished') {
    throw new Error('current NBT progress is already finished')
  }

  const sourceName = String(previous.sourceName || '').trim()
  const sourcePath = String(previous.sourcePath || '').trim()
  if (!sourceName && !sourcePath) {
    throw new Error('current progress checkpoint has no source NBT')
  }

  const {
    postPrintStep,
    postPrintCartographyComplete,
    cartographyComplete,
    pass,
    maxPasses,
    errorCount,
    ...base
  } = previous

  const now = new Date().toISOString()
  const next = {
    ...base,
    processedTargets: 0,
    phase: 'printing',
    state: 'dashboard_reset_requested',
    action: 'reset-current-nbt',
    resetBeforeResume: true,
    resetRequestedAt: now,
    resetReason: reason,
    interrupted: true,
    lastEndReason: reason,
    lastDisconnectAt: now,
    updatedAt: now
  }
  if (sessionNumber != null) next.lastSession = sessionNumber
  writeJson(progressFile, next)
  return next
}

function markProgressInterrupted(config, reason, sessionNumber) {
  const files = config.files || {}
  if (files.resumeProgress === false) return

  const progressFile = getProgressFilePath(config)
  const previous = readProgressState(progressFile)
  if (!previous || previous.phase === 'finished') return

  writeJson(progressFile, {
    ...previous,
    interrupted: true,
    lastSession: sessionNumber,
    lastEndReason: reason || 'disconnected',
    lastDisconnectAt: new Date().toISOString()
  })
}

function hasUnfinishedProgressIntent(config) {
  if (isOperatorPaused(config)) return false

  const files = config.files || {}
  if (files.resumeProgress === false) return false

  const progressFile = getProgressFilePath(config)
  const previous = readProgressState(progressFile)
  if (!previous) return false

  const phase = normalizeResumePhase(previous.phase)
  if (phase === 'finished') return false
  return phase === 'printing' || phase === 'repair' || phase === 'post_print'
}

function getPlatformStallReconnectConfig(config) {
  const advanced = config?.advanced || {}
  return {
    enabled: advanced.platformStallReconnectEnabled !== false,
    pollMs: Math.max(1000, toNumber(advanced.platformStallReconnectPollMs, 5000)),
    timeoutMs: Math.max(30000, toNumber(advanced.platformStallReconnectTimeoutMs, 120000)),
    movementThreshold: Math.max(0.01, toNumber(advanced.platformStallReconnectMovementThreshold, 0.35)),
    logMs: Math.max(1000, toNumber(advanced.platformStallReconnectLogMs, 30000))
  }
}

function isPlatformStallReconnectPhase(phase) {
  const normalized = normalizeResumePhase(phase)
  return normalized === 'printing' || normalized === 'repair' || normalized === 'post_print'
}

function getProgressStallToken(progress) {
  if (!progress) return ''
  return [
    progress.phase || '',
    progress.state || '',
    progress.action || '',
    toNumber(progress.processedTargets, 0),
    progress.postPrintStep || '',
    progress.pass || '',
    progress.errorCount || '',
    progress.updatedAt || ''
  ].join('|')
}

function startPlatformStallReconnectWatchdog(bot, config) {
  const settings = getPlatformStallReconnectConfig(config)
  if (!settings.enabled || !bot || bot.__nervPlatformStallReconnectTimer) {
    return () => {}
  }

  const progressFile = path.resolve(process.cwd(), config.files?.progressFile || './logs/nerv-printer-progress.json')
  let baselinePos = cloneFinitePosition(bot?.entity?.position)
  let baselineAt = Date.now()
  let lastProgressToken = ''
  let lastLogAt = 0
  let reconnecting = false

  const resetBaseline = (pos, progressToken) => {
    baselinePos = cloneFinitePosition(pos)
    baselineAt = Date.now()
    lastProgressToken = progressToken
  }

  const timer = setInterval(() => {
    if (reconnecting) return
    if (bot.__nervSessionActive === false || bot?._client?.state === 'disconnected') return
    if (isOperatorPauseHoldActive(config)) {
      resetBaseline(bot?.entity?.position, lastProgressToken)
      return
    }
    if (!bot.__nervPlatformWatchdogActive) return
    if (bot.__nervAllowOffPlatformNavigation) {
      resetBaseline(bot?.entity?.position, lastProgressToken)
      return
    }
    if (bot.__nervPlatformWaterHoldActive || bot.__nervPlatformWaterHoldPromise) {
      resetBaseline(bot?.entity?.position, lastProgressToken)
      return
    }
    const latencyState = getLatencyBackoffState(bot, config)
    if (latencyState.level !== 'normal') {
      resetBaseline(bot?.entity?.position, lastProgressToken)
      logThrottled('platform-stall-latency-hold', `[PLATFORM-STALL] ping=${latencyState.pingMs}ms level=${latencyState.level}; pausing stall reconnect timer until latency recovers.`, {
        intervalMs: settings.logMs
      })
      return
    }

    const progress = readProgressState(progressFile)
    if (!progress || !isPlatformStallReconnectPhase(progress.phase)) {
      resetBaseline(bot?.entity?.position, '')
      return
    }

    const runtime = classifyRuntimePosition(bot, config, 'platform-stall-reconnect')
    const pos = bot?.entity?.position
    const onPlatform = runtime?.classification?.platform === true ||
      (isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config))
    if (!onPlatform) {
      resetBaseline(pos, getProgressStallToken(progress))
      return
    }

    const progressToken = getProgressStallToken(progress)
    const moved = distanceToPoint(pos, baselinePos)
    if (!baselinePos || progressToken !== lastProgressToken || moved > settings.movementThreshold) {
      resetBaseline(pos, progressToken)
      return
    }

    const stalledMs = Date.now() - baselineAt
    if (stalledMs < settings.timeoutMs) {
      const now = Date.now()
      if (now - lastLogAt >= settings.logMs) {
        console.log(`[PLATFORM-STALL] phase=${progress.phase} state=${progress.state || 'n/a'} action=${progress.action || 'n/a'} same-position=${Math.round(stalledMs / 1000)}s/${Math.round(settings.timeoutMs / 1000)}s pos=${formatBotPosition(bot)}`)
        lastLogAt = now
      }
      return
    }

    reconnecting = true
    const reason = `platform-stall-${normalizeResumePhase(progress.phase)}`
    console.log(`[PLATFORM-STALL-RECONNECT] No progress or movement for ${Math.round(stalledMs / 1000)}s while on platform; reconnecting and resuming from saved phase=${progress.phase} state=${progress.state || 'n/a'} action=${progress.action || 'n/a'}.`)
    try {
      writeJson(progressFile, {
        ...progress,
        interrupted: true,
        lastEndReason: reason,
        lastDisconnectAt: new Date().toISOString()
      })
    } catch (err) {
      console.log(`[PLATFORM-STALL-WARN] Failed to update progress checkpoint before reconnect: ${err?.message || err}`)
    }
    stopBotMovement(bot)
    closeCurrentWindowIfOpen(bot, reason)
    bot.__nervForcedEndReason = reason
    try { bot.quit(reason) } catch {}
  }, settings.pollMs)

  timer.unref?.()
  bot.__nervPlatformStallReconnectTimer = timer
  const stop = () => {
    if (bot.__nervPlatformStallReconnectTimer === timer) {
      bot.__nervPlatformStallReconnectTimer = null
    }
    clearInterval(timer)
  }
  bot.once('end', stop)
  return stop
}

function createDefaultConfig() {
  return {
    bot: {
      host: '127.0.0.1',
      port: 25565,
      username: 'MapartBot',
      usernames: ['MapartBot'],
      auth: 'offline',
      version: '1.20',
      profilesFolder: './auth-cache',
      viewDistance: 'tiny',
      checkTimeoutInterval: 60000,
      reconnect: {
        enabled: false,
        delayMs: 9500,
        maxAttempts: 5
      }
    },
    connection: {
      active: 'local',
      profiles: {
        local: {
          bot: {
            host: '127.0.0.1',
            port: 54321,
            auth: 'offline',
            profilesFolder: './auth-cache',
            viewDistance: 'short',
            checkTimeoutInterval: 90000,
            reconnect: {
              enabled: true,
              delayMs: 15000,
              maxAttempts: 25
            }
          }
        },
        '6b6t': {
          bot: {
            host: 'alt.6b6t.org',
            hosts: [
              'alt.6b6t.org',
              'alt3.6b6t.org',
              'play.6b6t.org',
              'alt2.6b6t.org'
            ],
            port: 25565,
            auth: 'microsoft',
            profilesFolder: './auth-cache',
            viewDistance: 'short',
            checkTimeoutInterval: 90000,
            requiredSpawnCountBeforeStartup: 3,
            requiredSpawnFallbackSeconds: 90,
            spawnPositionTimeoutSeconds: 240,
            spawnMissingPositionReconnectSeconds: 75,
            waitForPlatformPositionOnSpawn: true,
            seedPositionFromPlatformOnSpawn: true,
            platformRecoveryTpa: {
              enabled: true,
              command: '/tpa ComicSquid74273',
              retryMs: 300000
            },
            chatLogin: {
              enabled: true,
              offlineOnly: true,
              command: '/login',
              autoSendOnSpawn: true,
              autoSendInitialDelayMs: 2500,
              holdStartupUntilLoggedIn: true,
              waitTimeoutMs: 30000,
              promptPatterns: [
                'please login with the command',
                '/login <password>',
                'please login',
                'use /login',
                'log in with /login'
              ],
              successPatterns: [
                'you are now logged in',
                'successfully logged in',
                'logged in successfully',
                'you have been logged in'
              ],
              minDelayMs: 750,
              retryMs: 5000,
              maxAttempts: 5
            },
            lobbyPortal: {
              enabled: true,
              accountMode: 'auto',
              maxAttempts: 3,
              pathTimeoutMs: 60000,
              portalEntryMs: 3000,
              waitAfterPortalMs: 12000,
              portalSearchRadius: 96,
              lobbyRegions: [
                { name: 'lobby-1', type: 'disk', action: 'wait-transfer', centerX: 500, centerZ: 500, radius: 192 },
                { name: 'lobby-2', type: 'disk', action: 'portal', centerX: 1000, centerZ: 1000, radius: 192 },
                { name: 'login-portal-999', type: 'box', action: 'login-portal', x: 1000, y: 100, z: 1000, radius: 16 }
              ],
              spawnDisk: {
                enabled: false,
                centerX: 1000,
                centerZ: 1000,
                radius: 192,
                waitBeforeMoveMs: 2500,
                twoStepRoute: false,
                useConfiguredPortalTarget: false,
                waypoint: { x: 7, y: 18, z: 61 },
                portal: { x: 0, y: 20, z: -16 },
                goalRange: 2
              },
              loginPortal: {
                enabled: true,
                x: 1000,
                y: 100,
                z: 1000,
                radius: 16,
                waitBeforeMoveMs: 5000,
                portalTargetZ: -989,
                goalRange: 2
              }
            },
            reconnect: {
              enabled: true,
              delayMs: 30000,
              maxAttempts: 50
            }
          }
        }
      }
    },
    files: {
      inputMode: 'auto',
      planFile: './mapart-plan.json',
      nbtFolder: './nerv-printer-config',
      resumeProgress: true,
      progressFile: './logs/nerv-printer-progress.json',
      progressSaveEvery: 64,
      moveToFinishedFolder: false,
      finishedFolder: './nerv-printer-config/_finished_maps',
      disableOnFinished: true
    },
    printer: {
      startOnSpawn: true,
      startDelayMs: 1500,
      startCornerMode: 'mapCorner',
      allowJump: true,
      placeWhileSprinting: false,
      postPrintTestOnly: false,
      printOffset: { x: 0, y: 0, z: -1 },
      linesPerRun: 3,
      placeRange: 4,
      minPlaceDistance: 0.8,
      ignoredBlocks: [],
      placeDelayMs: 50,
      rotate: true,
      northToSouth: true,
      mapFillSquareSize: 1,
      sprintMode: 'notPlacing',
      fastTraversalEnabled: false,
      fastTraversalTickMs: 50,
      fastTraversalCheckpointEveryRows: 8,
      fastTraversalCatchupPasses: 3,
      fastTraversalCatchupStallMs: 6000,
      maxPlacementsPerTick: 1
    },
    advanced: {
      antiHunger: {
        enabled: true,
        sprint: true,
        onGround: true
      },
      platformWatchdogEnabled: true,
      platformWatchdogPollMs: 1000,
      platformHoldLogMs: 5000,
      platformStallReconnectEnabled: true,
      platformStallReconnectPollMs: 5000,
      platformStallReconnectTimeoutMs: 120000,
      platformStallReconnectMovementThreshold: 0.35,
      platformStallReconnectLogMs: 30000,
      startupSupportProbeEnabled: true,
      startupSupportMinRatio: 0.5,
      startupSupportPollMs: 5000,
      startupSupportLogMs: 15000,
      restockSyncStrategy: 'nerv-window',
      preRestockDelayMs: 500,
      inventoryActionDelayMs: 100,
      postRestockDelayMs: 500,
      inventoryExtraStateSyncMs: 0,
      restockFastSettleMs: 0,
      restockPostCloseInventorySyncMs: 2000,
      restockFailureCooldownMs: 8000,
      cleanAssignedMaterialChests: true,
      cleanAssignedMaterialChestAction: 'dump',
      cleanAssignedMaterialChestMaxStacksPerOpen: 8,
      autoAcceptTeleportRequests: true,
      teleportRequestWhitelist: [],
      teleportRequestAcceptCommand: '/tpy',
      teleportRequestAcceptCooldownMs: 30000,
      waitForRequiredMaterialRestockEnabled: true,
      waitForRequiredMaterialRetryMs: 5000,
      waitForRequiredMaterialLogEveryMs: 30000,
      waitForRequiredMaterialTimeoutMs: 0,
      predictiveRestock: true,
      dumpUnneededBeforeRefill: true,
      inventoryRefillRows: 2,
      inventoryMaxMaterialTypes: 16,
      inventoryPlanUseWorldState: false,
      autoEatEnabled: true,
      autoEatMinHunger: 12,
      autoEatFoodItem: 'cooked_beef',
      anvilPillarMinCount: 3,
      anvilPillarScanLimit: 16,
      resetChestWaitMs: 2000,
      resetChestCloseSettleMs: 0,
      sneakOnDispenserOnly: true,
      postPrintWorkflowEnabled: true,
      postPrintFillMapEnabled: true,
      postPrintUseCartographyEnabled: true,
      postPrintStoreFinishedMapEnabled: true,
      postPrintResetEnabled: true,
      postPrintXpRefillEnabled: true,
      postPrintRenameMapEnabled: true,
      postPrintRequireRenameBeforeStore: false,
      postPrintRenameAttempts: 3,
      postPrintMinXpLevel: 2,
      postPrintTargetXpLevel: 5,
      postPrintXpButtonMaxPresses: 40,
      postPrintSkipResetInteraction: false,
      postPrintWalkToCenter: true,
      postPrintCenterWaitMs: 15000,
      postPrintInteractionDelayMs: 100,
      postPrintMapSettleDelayMs: 100,
      postPrintCartographyAccessRange: 0.85,
      dumpAimSettleMs: 0,
      dumpYawInvert: false,
      dumpPitchInvert: false,
      dumpTestStationWaitMs: 5000,
      dumpTestTossAtEachStation: true,
      movingPlaceTestTargetCount: 64,
      movingPlaceTestCheckpointEveryRows: 8,
      movingPlaceTestWaitAfterMs: 5000,
      nervScannerTestLineGroups: 2,
      nervScannerTestWaitAfterMs: 5000,
      nervWorkloadTestLineGroups: 2,
      nervWorkloadTestWaitAfterMs: 5000,
      scannerPlaceDelayMs: 10,
      scannerMaxCatchupPlacements: 12,
      scannerWorkloadPollMs: 5,
      scannerWorkloadLogEveryMs: 1000,
      scannerLineEndSettleMs: 2500,
      scannerAdaptiveSlowdown: true,
      scannerAdaptiveMissingThreshold: 32,
      scannerAdaptiveRecoverThreshold: 6,
      scannerAdaptiveSettleStepMs: 1000,
      scannerAdaptiveMaxSettleMs: 7000,
      scannerAdaptiveMinSettleMs: 1500,
      scannerAdaptivePlaceDelayStepMs: 2,
      scannerAdaptiveMaxPlaceDelayMs: 16,
      scannerAdaptiveMinPlaceDelayMs: 6,
      scannerRetryCooldownMs: 30,
      scannerPlaceConfirmMs: 80,
      scannerPlaceConfirmPollMs: 15,
      workloadCheckpointMoveTimeoutMs: 30000,
      workloadCheckpointTimeoutAcceptExtraRange: 0.35,
      workloadStraightCheckpointMovement: true,
      workloadStraightCheckpointTickMs: 50,
      placementStallTimeoutMs: 5000,
      placementStallRecoveryMs: 2000,
      placementStallRecoveryAttempts: 3,
      placementStallRecoveryConfirmMs: 180,
      placementStallRecoverySettleMs: 120,
      placementStallRecoveryCooldownMs: 750,
      placementStallEmergencyRestock: true,
      emergencyRestockReturnRange: 3,
      placementStallSkipRadiusBlocks: 5,
      litematicRowSettleMs: 150,
      litematicRowVerifyEveryRows: 2,
      litematicRowRepairThreshold: 2,
      scannerPreSwapDelayMs: 0,
      scannerPostSwapDelayMs: 50,
      placementNoiseLogs: true,
      pingDiagnosticsEnabled: true,
      pingDiagnosticsThresholdMs: 30,
      pingDiagnosticsLogEveryMs: 5000,
      mcStatusHostSelectionEnabled: true,
      mcStatusHostSelectionTimeoutMs: 5000,
      mcStatusHostSelectionProtocolVersion: 763,
      latencyAdaptiveBackoffEnabled: true,
      latencyNormalThresholdMs: 120,
      latencyHighThresholdMs: 90,
      latencySevereThresholdMs: 290,
      latencyCriticalThresholdMs: 490,
      latencyResumeThresholdMs: 85,
      latencyDisableSprintAboveMs: 90,
      latencyActionMinDelayMs: 100,
      latencyActionMaxDelayMs: 1500,
      latencyCriticalWaitMs: 15000,
      latencyBackoffPollMs: 500,
      latencyBackoffLogEveryMs: 5000,
      latencyTimeoutMultiplier: 3,
      latencyTimeoutMaxMs: 12000,
      latencyMovementPauseMaxMs: 450,
      latencySafeModeEnterMs: 90,
      latencySafeModeResumeMs: 85,
      latencySafePlacementSettleMs: 50,
      latencySafePlacementMoveTimeoutMs: 12000,
      supportStockChestOpenTimeoutMs: 8000,
      supportStockChestSyncWaitMs: 8000,
      supportStockChestStableMs: 800,
      supportStockChestOpenAttempts: 5,
      supportStockChestPollMs: 100,
      scannerWorkloadMode: 'litematic',
      inventoryCycleTestWaitAfterMs: 5000,
      inventoryCycleTestRows: 2,
      dumpPathThinkTimeoutMs: 3000,
      dumpAlreadyNearRange: 4,
      dumpGoalRange: 4,
      multiDumpLockStaleMs: 30000,
      dumpReaimEveryStacks: 0,
      repairTestWaitAfterMs: 5000,
      repairTestMaxPasses: 3,
      repairSprintMode: 'always',
      repairGoalRange: 3.25,
      repairTargetSettleMs: 0,
      repairMoveTimeoutMs: 30000,
      repairProgressLogMs: 5000,
      repairFallbackToStopPlace: true,
      repairStallEmergencyRestock: true,
      repairEmergencyRestockTransientHits: 3,
      repairConfirmFastPlacements: true,
      repairFastConfirmMs: 180,
      repairFastConfirmPollMs: 15,
      repairVerifySettleMs: 120,
      repairMaxMismatchRatio: 0.25,
      repairMaxMismatchCount: 512,
      useMapCornerYForNbtCarpets: true,
      repairBatchSize: 256,
      repairRestockMode: 'fast',
      postBuildDelayMs: 0,
      preSwapDelayMs: 100,
      postSwapDelayMs: 100,
      retryInteractTimeoutMs: 4000,
      checkpointBuffer: 0.2,
      breakCarpetAboveReset: false,
      debugPrints: false
    },
    errorHandling: {
      logErrors: true,
      errorAction: 'repair'
    },
    anchorTranslation: {
      enabled: true,
      sourceAnchor: { x: -450, y: 0, z: -962 },
      targetAnchor: { x: -450, y: 0, z: -962 }
    },
    machine: {
      mapCorner: { x: 0, y: 64, z: 0 },
      mapSize: { width: 128, height: 128 },
      dumpStation: { enabled: false, position: { x: 0, y: 0, z: 0 }, yaw: null, pitch: null },
      dumpStations: [],
      cartographyTable: { enabled: false, position: { x: 0, y: 0, z: 0 }, accessPosition: null },
      finishedMapChest: { enabled: false, position: { x: 0, y: 0, z: 0 }, accessPosition: null },
      resetBlock: { enabled: false, position: { x: 0, y: 0, z: 0 }, accessPosition: null },
      xpBottleChest: { enabled: false, position: { x: 0, y: 0, z: 0 }, accessPosition: null },
      xpBottleChests: [],
      xpButton: { enabled: false, position: { x: 0, y: 0, z: 0 }, accessPosition: null },
      anvil: { enabled: false, position: { x: 0, y: 0, z: 0 }, accessPosition: null },
      foodChest: { enabled: false, position: { x: 0, y: 0, z: 0 }, accessPosition: null },
      mapMaterialChests: [],
      materialDict: {}
    },
    multiUser: {
      enabled: false,
      mode: 'file',
      syncFolder: './logs/nerv-printer-sync',
      requireAllReady: true,
      recoveryMarginBlocks: 20,
      recoveryDelayMs: 2000,
      staleStateMs: 15000,
      heartbeatMs: 5000,
      resumeExistingJob: true,
      startAllOnMasterReady: true,
      joinStaggerMs: 8000,
      startStaggerMs: 3000,
      launchFromSingleProcess: true,
      bots: [
        { name: 'MapartBot', role: 'master', enabled: true, joinDelayMs: 0, startDelayMs: 0 },
        { name: 'MapartBot_1', role: 'slave', enabled: false, joinDelayMs: 8000, startDelayMs: 3000 },
        { name: 'MapartBot_2', role: 'slave', enabled: false, joinDelayMs: 16000, startDelayMs: 6000 }
      ]
    },
    dashboard: {
      enabled: false,
      serviceUrl: 'http://127.0.0.1:4080',
      hostLabel: '',
      heartbeatMs: 5000,
      commandPollMs: 3000,
      queuePrefetchHighWater: 10,
      queuePrefetchLowWater: 3,
      idleWindowMs: 15000,
      staleMs: 20000
    },
    logging: {
      rotateHours: 12,
      retentionHours: 72
    }
  }
}

function toBlockPos(entry) {
  const blockPos = entry?.blockPos || entry
  if (!Number.isFinite(blockPos?.x) || !Number.isFinite(blockPos?.y) || !Number.isFinite(blockPos?.z)) {
    return null
  }

  return {
    x: Number(blockPos.x),
    y: Number(blockPos.y),
    z: Number(blockPos.z)
  }
}

function toOpenPos(entry) {
  const openPos = entry?.openPos || entry?.accessPosition || null
  if (!Number.isFinite(openPos?.x) || !Number.isFinite(openPos?.y) || !Number.isFinite(openPos?.z)) {
    return null
  }

  return {
    x: Number(openPos.x),
    y: Number(openPos.y),
    z: Number(openPos.z)
  }
}

function toMaterialSpot(entry) {
  const blockPos = toBlockPos(entry)
  if (!blockPos) return null
  const accessPosition = toOpenPos(entry)
  return accessPosition ? { ...blockPos, accessPosition } : blockPos
}

function toPoint3(value) {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y) || !Number.isFinite(value?.z)) {
    return null
  }

  return {
    x: Number(value.x),
    y: Number(value.y),
    z: Number(value.z)
  }
}

function translatePoint(point, delta) {
  if (!point || !delta) return point
  return {
    x: Number(point.x) + delta.x,
    y: Number(point.y) + delta.y,
    z: Number(point.z) + delta.z
  }
}

function applyAnchorTranslation(config) {
  const translation = config?.anchorTranslation || {}
  const enabled = translation.enabled !== false
  const source = toPoint3(translation.sourceAnchor)
  const target = toPoint3(translation.targetAnchor)

  if (!enabled || !source || !target) {
    return { applied: false, reason: 'disabled-or-missing-anchor' }
  }

  const delta = {
    x: target.x - source.x,
    y: target.y - source.y,
    z: target.z - source.z
  }

  if (delta.x === 0 && delta.y === 0 && delta.z === 0) {
    config.anchorTranslation = {
      ...translation,
      sourceAnchor: source,
      targetAnchor: target,
      appliedDelta: delta
    }
    return { applied: true, source, target, delta }
  }

  const machine = config.machine || {}

  machine.mapCorner = translatePoint(machine.mapCorner, delta)

  if (machine.dumpStation && machine.dumpStation.position) {
    machine.dumpStation.position = translatePoint(machine.dumpStation.position, delta)
  }

  if (Array.isArray(machine.dumpStations)) {
    machine.dumpStations = machine.dumpStations.map((station) => ({
      ...station,
      position: translatePoint(station.position, delta)
    }))
  }

  for (const key of ['cartographyTable', 'finishedMapChest', 'resetBlock', 'xpBottleChest', 'xpButton', 'anvil', 'foodChest']) {
    const node = machine[key]
    if (!node) continue
    node.position = translatePoint(node.position, delta)
    node.accessPosition = translatePoint(node.accessPosition, delta)
  }

  if (Array.isArray(machine.xpBottleChests)) {
    machine.xpBottleChests = machine.xpBottleChests.map((node) => ({
      ...node,
      position: translatePoint(node.position, delta),
      accessPosition: translatePoint(node.accessPosition, delta)
    }))
  }

  if (Array.isArray(machine.mapMaterialChests)) {
    machine.mapMaterialChests = machine.mapMaterialChests.map((pos) => translatePoint(pos, delta))
  }

  if (machine.materialDict && typeof machine.materialDict === 'object') {
    for (const material of Object.keys(machine.materialDict)) {
      const spots = Array.isArray(machine.materialDict[material]) ? machine.materialDict[material] : []
      machine.materialDict[material] = spots.map((pos) => ({
        ...translatePoint(pos, delta),
        accessPosition: translatePoint(pos.accessPosition, delta)
      }))
    }
  }

  config.machine = machine
  config.anchorTranslation = {
    ...translation,
    sourceAnchor: source,
    targetAnchor: target,
    appliedDelta: delta
  }

  return { applied: true, source, target, delta }
}

function importNervFolderConfig(imported, baseConfig) {
  const merged = {
    ...baseConfig,
    machine: { ...baseConfig.machine },
    bot: { ...baseConfig.bot },
    files: { ...baseConfig.files },
    printer: { ...baseConfig.printer },
    advanced: { ...baseConfig.advanced },
    errorHandling: { ...baseConfig.errorHandling },
    multiUser: { enabled: false }
  }

  const testConfig = readOptionalJson(TEST_BOT_CONFIG_FILE)
  const testBot = Array.isArray(testConfig?.bots) && testConfig.bots.length ? testConfig.bots[0] : null
  if (testBot) {
    merged.bot.host = testBot.host || merged.bot.host
    merged.bot.port = toNumber(testBot.port, merged.bot.port)
    merged.bot.username = testBot.username || merged.bot.username
    merged.bot.auth = testBot.auth || merged.bot.auth
    merged.bot.version = testBot.version || merged.bot.version
    merged.bot.profilesFolder = testBot.profilesFolder || merged.bot.profilesFolder
    merged.bot.viewDistance = testBot.viewDistance || merged.bot.viewDistance
    merged.bot.checkTimeoutInterval = toNumber(testBot.checkTimeoutInterval, merged.bot.checkTimeoutInterval)
  }

  const corner = toBlockPos(imported?.mapCorner)
  if (corner) {
    merged.machine.mapCorner = corner
  }

  const dumpPos = imported?.dumpStation?.pos
  if (Number.isFinite(dumpPos?.x) && Number.isFinite(dumpPos?.y) && Number.isFinite(dumpPos?.z)) {
    merged.machine.dumpStation = {
      enabled: true,
      position: {
        x: Number(dumpPos.x),
        y: Number(dumpPos.y),
        z: Number(dumpPos.z)
      },

      yaw: Number.isFinite(imported?.dumpStation?.yaw) ? Number(imported.dumpStation.yaw) : null,
      pitch: Number.isFinite(imported?.dumpStation?.pitch) ? Number(imported.dumpStation.pitch) : null
    }
  }

  const dumpStations = Array.isArray(imported?.dumpStations)
    ? imported.dumpStations
      .map((entry) => {
        const pos = entry?.pos
        if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y) || !Number.isFinite(pos?.z)) return null
        return {
          position: {
            x: Number(pos.x),
            y: Number(pos.y),
            z: Number(pos.z)
          },

          yaw: Number.isFinite(entry?.yaw) ? Number(entry.yaw) : null,
          pitch: Number.isFinite(entry?.pitch) ? Number(entry.pitch) : null
        }
      })
      .filter(Boolean)
    : []
  merged.machine.dumpStations = dumpStations

  const finishedChestPos = toBlockPos(imported?.finishedMapChest)
  if (finishedChestPos) {
    merged.machine.finishedMapChest = {
      enabled: true,
      position: finishedChestPos,
      accessPosition: toOpenPos(imported?.finishedMapChest)
    }
  }

  const cartographyPos = toBlockPos(imported?.cartographyTable)
  if (cartographyPos) {
    merged.machine.cartographyTable = {
      enabled: true,
      position: cartographyPos,
      accessPosition: toOpenPos(imported?.cartographyTable)
    }
  }

  const resetPos = toBlockPos(imported?.reset)
  if (resetPos) {
    merged.machine.resetBlock = {
      enabled: true,
      position: resetPos,
      accessPosition: toOpenPos(imported?.reset)
    }
  }

  const importedXpBottleChest = imported?.xpBottleChest || imported?.xpChest
  const xpBottleChestPos = toBlockPos(importedXpBottleChest)
  if (xpBottleChestPos) {
    merged.machine.xpBottleChest = {
      enabled: true,
      position: xpBottleChestPos,
      accessPosition: toOpenPos(importedXpBottleChest)
    }
  }
  const xpBottleChests = Array.isArray(imported?.xpBottleChests)
    ? imported.xpBottleChests
      .map((entry) => {
        const position = toBlockPos(entry)
        if (!position) return null
        return {
          enabled: true,
          position,
          accessPosition: toOpenPos(entry)
        }
      })
      .filter(Boolean)
    : []
  if (xpBottleChests.length) {
    merged.machine.xpBottleChests = xpBottleChests
    if (!xpBottleChestPos) {
      merged.machine.xpBottleChest = xpBottleChests[0]
    }
  }

  const xpButtonPos = toBlockPos(imported?.xpButton)
  if (xpButtonPos) {
    merged.machine.xpButton = {
      enabled: true,
      position: xpButtonPos,
      accessPosition: toOpenPos(imported?.xpButton)
    }
  }

  const anvilPos = toBlockPos(imported?.anvil)
  if (anvilPos) {
    merged.machine.anvil = {
      enabled: true,
      position: anvilPos,
      accessPosition: toOpenPos(imported?.anvil)
    }
  }

  const foodChestPos = toBlockPos(imported?.foodChest)
  if (foodChestPos) {
    merged.machine.foodChest = {
      enabled: true,
      position: foodChestPos,
      accessPosition: toOpenPos(imported?.foodChest)
    }
  }

  const mapMaterial = Array.isArray(imported?.mapMaterialChests)
    ? imported.mapMaterialChests.map(toMaterialSpot).filter(Boolean)
    : []
  merged.machine.mapMaterialChests = mapMaterial

  const materialDict = {}
  const sourceDict = imported?.materialDict || {}

  for (const key of Object.keys(sourceDict)) {
    const normalizedName = String(key).replace(/^minecraft:/, '')
    const spots = Array.isArray(sourceDict[key]) ? sourceDict[key].map(toMaterialSpot).filter(Boolean) : []
    if (spots.length) {
      materialDict[normalizedName] = spots
    }
  }

  merged.machine.materialDict = materialDict
  return merged
}

function mergeUserConfig(base, loaded, options = {}) {
  const applyMachine = options.applyMachine !== false
  const allowMapCornerOnly = options.allowMapCornerOnly === true
  const allowMachineNodeOverrides = options.allowMachineNodeOverrides === true

  const merged = {
    ...base,
    ...loaded,
    bot: { ...base.bot, ...(loaded.bot || {}) },
    connection: {
      ...base.connection,
      ...(loaded.connection || {}),
      profiles: {
        ...(base.connection?.profiles || {}),
        ...(loaded.connection?.profiles || {})
      }
    },
    files: { ...base.files, ...(loaded.files || {}) },
    printer: { ...base.printer, ...(loaded.printer || {}) },
    advanced: { ...base.advanced, ...(loaded.advanced || {}) },
    errorHandling: { ...base.errorHandling, ...(loaded.errorHandling || {}) },
    anchorTranslation: { ...base.anchorTranslation, ...(loaded.anchorTranslation || {}) },
    logging: { ...(base.logging || {}), ...(loaded.logging || {}) },
    machine: { ...base.machine },
    multiUser: { ...base.multiUser, ...(loaded.multiUser || {}) }
  }

  if (applyMachine) {
    merged.machine = {
      ...base.machine,
      ...(loaded.machine || {}),
      mapCorner: { ...base.machine.mapCorner, ...(loaded.machine?.mapCorner || {}) },
      mapSize: { ...base.machine.mapSize, ...(loaded.machine?.mapSize || {}) },
      dumpStation: { ...base.machine.dumpStation, ...(loaded.machine?.dumpStation || {}) },
      dumpStations: Array.isArray(loaded.machine?.dumpStations)
        ? loaded.machine.dumpStations
        : (base.machine.dumpStations || []),
      cartographyTable: { ...base.machine.cartographyTable, ...(loaded.machine?.cartographyTable || {}) },
      finishedMapChest: { ...base.machine.finishedMapChest, ...(loaded.machine?.finishedMapChest || {}) },
      resetBlock: { ...base.machine.resetBlock, ...(loaded.machine?.resetBlock || {}) },
      xpBottleChest: { ...base.machine.xpBottleChest, ...(loaded.machine?.xpBottleChest || {}) },
      xpBottleChests: Array.isArray(loaded.machine?.xpBottleChests)
        ? loaded.machine.xpBottleChests
        : (base.machine.xpBottleChests || []),
      xpButton: { ...base.machine.xpButton, ...(loaded.machine?.xpButton || {}) },
      anvil: { ...base.machine.anvil, ...(loaded.machine?.anvil || {}) },
      foodChest: { ...base.machine.foodChest, ...(loaded.machine?.foodChest || {}) }
    }
  } else if (allowMachineNodeOverrides) {
    merged.machine = {
      ...base.machine,
      dumpStation: { ...base.machine.dumpStation, ...(loaded.machine?.dumpStation || {}) },
      cartographyTable: { ...base.machine.cartographyTable, ...(loaded.machine?.cartographyTable || {}) },
      finishedMapChest: { ...base.machine.finishedMapChest, ...(loaded.machine?.finishedMapChest || {}) },
      resetBlock: { ...base.machine.resetBlock, ...(loaded.machine?.resetBlock || {}) },
      xpBottleChest: { ...base.machine.xpBottleChest, ...(loaded.machine?.xpBottleChest || {}) },
      xpBottleChests: Array.isArray(loaded.machine?.xpBottleChests)
        ? loaded.machine.xpBottleChests
        : (base.machine.xpBottleChests || []),
      xpButton: { ...base.machine.xpButton, ...(loaded.machine?.xpButton || {}) },
      anvil: { ...base.machine.anvil, ...(loaded.machine?.anvil || {}) },
      foodChest: { ...base.machine.foodChest, ...(loaded.machine?.foodChest || {}) }
    }
  } else if (allowMapCornerOnly) {
    const mc = loaded.machine?.mapCorner
    if (Number.isFinite(mc?.x) && Number.isFinite(mc?.y) && Number.isFinite(mc?.z)) {
      merged.machine.mapCorner = {
        x: Number(mc.x),
        y: Number(mc.y),
        z: Number(mc.z)
      }
    }
  }

  return merged
}

function getSelectedConnectionProfileName(config) {
  return (
    getCliValue('--connection') ||
    getCliValue('--server') ||
    process.env.NERV_CONNECTION ||
    config.connection?.active ||
    config.connectionProfile ||
    'local'
  )
}

function mergeConnectionProfileConfig(config, profile) {
  if (profile.bot) {
    config.bot = {
      ...(config.bot || {}),
      ...profile.bot,
      reconnect: {
        ...(config.bot?.reconnect || {}),
        ...(profile.bot.reconnect || {})
      }
    }
  }

  if (profile.multiUser) {
    config.multiUser = {
      ...(config.multiUser || {}),
      ...profile.multiUser,
      bots: Array.isArray(profile.multiUser.bots)
        ? profile.multiUser.bots
        : (config.multiUser?.bots || [])
    }
  }

  if (profile.printer) {
    config.printer = {
      ...(config.printer || {}),
      ...profile.printer,
      printOffset: {
        ...(config.printer?.printOffset || {}),
        ...(profile.printer.printOffset || {})
      }
    }
  }

  if (profile.advanced) {
    config.advanced = {
      ...(config.advanced || {}),
      ...profile.advanced
    }
  }
}

function applyConnectionProfile(config) {
  const name = String(getSelectedConnectionProfileName(config) || '').trim()
  const profiles = config.connection?.profiles || {}
  const profile = profiles[name]

  if (!profile) {
    const available = Object.keys(profiles).join(', ') || 'none'
    throw new Error(`Unknown connection profile "${name}". Available profiles: ${available}`)
  }

  mergeConnectionProfileConfig(config, profile)
  config.connection = {
    ...(config.connection || {}),
    active: name,
    selected: name
  }
  console.log(`[CONFIG] Connection profile: ${name}`)
  return config
}

function loadConfig() {
  const base = createDefaultConfig()
  const userConfigPath = getUserConfigPath()
  const hasUserConfig = fs.existsSync(userConfigPath)

  // Try to get the machineConfigFile path from the main config
  let machineConfigFilePath = DEFAULT_IMPORTED_CONFIG_FILE
  if (hasUserConfig) {
    try {
      const mainConfig = readJson(userConfigPath)
      const customMachineConfigFile = mainConfig?.files?.machineConfigFile
      if (customMachineConfigFile) {
        machineConfigFilePath = path.resolve(process.cwd(), customMachineConfigFile)
      }
    } catch (err) {
      // If reading fails, use default
    }
  }

  if (fs.existsSync(machineConfigFilePath)) {
    const imported = readJson(machineConfigFilePath)
    console.log(`[CONFIG] Loaded ${path.relative(process.cwd(), machineConfigFilePath)}`)
    const importedConfig = importNervFolderConfig(imported, base)

    if (hasUserConfig) {
      const loaded = readJson(userConfigPath)
      const config = mergeUserConfig(importedConfig, loaded, { applyMachine: false, allowMapCornerOnly: false, allowMachineNodeOverrides: true })
      applyAnchorTranslation(config)
      applyConnectionProfile(config)
      console.log(`[CONFIG] Loaded ${path.relative(process.cwd(), userConfigPath)} (runtime overrides plus explicit machine node overrides).`)
      console.log('[CONFIG] Machine layout remains sourced from machine config file unless overridden in local machine nodes.')
      return config
    }

    const config = importedConfig
    applyAnchorTranslation(config)
    applyConnectionProfile(config)
    console.log('[CONFIG] Using machine config only (no local overrides found).')
    return config
  }

  if (hasUserConfig) {
    const loaded = readJson(userConfigPath)
    const config = mergeUserConfig(base, loaded)
    applyAnchorTranslation(config)
    applyConnectionProfile(config)

    if (!config?.bot) {
      throw new Error('Invalid config: missing bot section.')
    }

    console.log(`[CONFIG] Loaded ${path.relative(process.cwd(), userConfigPath)}`)
    return config
  }

  throw new Error(`Missing config. Expected ${path.relative(process.cwd(), CONFIG_FILE)} or the machineConfigFile path specified in files.machineConfigFile`)
}

function axisOffset(axis, amount) {
  switch (axis) {
    case 'x+': return { x: amount, y: 0, z: 0 }
    case 'x-': return { x: -amount, y: 0, z: 0 }
    case 'z+': return { x: 0, y: 0, z: amount }
    case 'z-': return { x: 0, y: 0, z: -amount }
    default: return { x: 0, y: 0, z: amount }
  }
}

function addPos(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

function getPrintOffsets(config) {
  const printer = config.printer || {}
  const po = printer.printOffset || {}
  return {
    x: toNumber(po.x, 0),
    y: toNumber(po.y, 0),
    z: toNumber(po.z, -1)
  }
}

function normalizePlan(rawPlan, config) {
  const plan = rawPlan || {}
  const machine = config.machine || {}

  const rows = Array.isArray(plan.rows) ? plan.rows : []
  if (!rows.length) {
    throw new Error('Plan rows are empty. Set rows in mapart-plan.json.')
  }

  const width = rows[0].length
  if (width === 0) {
    throw new Error('Plan rows must not be empty strings.')
  }

  for (const row of rows) {
    if (row.length !== width) {
      throw new Error('All plan rows must have the same length.')
    }
  }

  return {
    origin: {
      x: toNumber(plan.origin?.x, toNumber(machine.mapCorner?.x, 0)),
      y: toNumber(plan.origin?.y, toNumber(machine.mapCorner?.y, 64)),
      z: toNumber(plan.origin?.z, toNumber(machine.mapCorner?.z, 0))
    },
    rowAxis: String(plan.rowAxis || 'z+'),
    colAxis: String(plan.colAxis || 'x+'),
    ignoreChar: String(plan.ignoreChar || '.'),
    palette: typeof plan.palette === 'object' && plan.palette ? plan.palette : {},
    rows
  }
}

function parseNbtFile(filePath) {
  return new Promise((resolve, reject) => {
    const buffer = fs.readFileSync(filePath)
    nbt.parse(buffer, (err, parsed) => {
      if (err) {
        reject(err)
        return
      }

      resolve(nbt.simplify(parsed))
    })
  })
}

function getNextNbtFile(config) {
  const files = config.files || {}
  const folder = path.resolve(process.cwd(), files.nbtFolder || './nerv-printer-config')
  if (!fs.existsSync(folder)) return null

  const candidates = fs.readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.nbt'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))

  if (!candidates.length) return null
  return path.join(folder, candidates[0])
}

function retireDashboardQueueNbt(filePath, config) {
  const resolved = filePath ? path.resolve(process.cwd(), String(filePath)) : null
  if (!resolved || !fs.existsSync(resolved)) return null
  const finishedDir = path.resolve(process.cwd(), config.files?.finishedFolder || './finished-maps')
  if (!fs.existsSync(finishedDir)) {
    fs.mkdirSync(finishedDir, { recursive: true })
  }
  const toPath = resolveUniqueFilePath(path.join(finishedDir, path.basename(resolved)))
  fs.renameSync(resolved, toPath)
  console.log(`[FILES] Retired dashboard queue NBT ${path.basename(resolved)} to ${toPath}`)
  return toPath
}

function targetsFromNbt(nbtData, config) {
  const machine = config.machine || {}
  const offsets = getPrintOffsets(config)
  const corner = {
    x: toNumber(machine.mapCorner?.x, 0),
    y: toNumber(machine.mapCorner?.y, 64),
    z: toNumber(machine.mapCorner?.z, 0)
  }

  const palette = Array.isArray(nbtData.palette) ? nbtData.palette : []
  const blocks = Array.isArray(nbtData.blocks) ? nbtData.blocks : []
  const ignored = new Set((config.printer?.ignoredBlocks || []).map((value) => String(value).replace(/^minecraft:/, '')))
  const northToSouth = config.printer?.northToSouth !== false

  const rowMap = new Map()
  let minLocalX = Number.POSITIVE_INFINITY
  let minLocalY = Number.POSITIVE_INFINITY
  let minLocalZ = Number.POSITIVE_INFINITY

  for (const block of blocks) {
    const localPos = Array.isArray(block?.pos) ? block.pos : []
    if (localPos.length !== 3) continue
    const localX = toNumber(localPos[0], 0)
    const localY = toNumber(localPos[1], 0)
    const localZ = toNumber(localPos[2], 0)
    if (localX < minLocalX) minLocalX = localX
    if (localY < minLocalY) minLocalY = localY
    if (localZ < minLocalZ) minLocalZ = localZ
  }

  if (!Number.isFinite(minLocalX)) minLocalX = 0
  if (!Number.isFinite(minLocalZ)) minLocalZ = 0

  if (!Number.isFinite(minLocalY)) {
    minLocalY = 0
  }

  for (const block of blocks) {
    const localPos = Array.isArray(block?.pos) ? block.pos : []
    if (localPos.length !== 3) continue

    const stateIndex = toNumber(block?.state, -1)
    if (stateIndex < 0 || stateIndex >= palette.length) continue

    const blockNameFull = String(palette[stateIndex]?.Name || '')
    if (!blockNameFull.endsWith('_carpet')) continue

    const blockName = blockNameFull.replace(/^minecraft:/, '')
    if (ignored.has(blockName)) continue

    const normalizedLocalX = toNumber(localPos[0], 0) - minLocalX
    const normalizedLocalZ = toNumber(localPos[2], 0) - minLocalZ
    const x = corner.x + normalizedLocalX + offsets.x
    const y = config.advanced?.useMapCornerYForNbtCarpets !== false
      ? corner.y + offsets.y
      : corner.y + (toNumber(localPos[1], 0) - minLocalY) + offsets.y
    const z = corner.z + normalizedLocalZ + offsets.z
    const row = normalizedLocalZ
    const col = normalizedLocalX

    if (!rowMap.has(row)) rowMap.set(row, [])
    rowMap.get(row).push({ row, col, symbol: blockName, blockName, position: { x, y, z } })
  }

  const rows = Array.from(rowMap.keys()).sort((a, b) => a - b)
  if (!northToSouth) rows.reverse()

  const targets = []
  for (const row of rows) {
    const line = rowMap.get(row).sort((a, b) => a.col - b.col)
    targets.push(...line)
  }

  return targets
}

async function loadTargets(config) {
  const files = config.files || {}
  const mode = String(files.inputMode || 'auto').toLowerCase()
  const planPath = path.resolve(process.cwd(), files.planFile || './mapart-plan.json')

  const tryJson = mode === 'json' || mode === 'auto'
  const tryNbt = mode === 'nbt' || mode === 'auto'

  if (tryJson && fs.existsSync(planPath)) {
    const rawPlan = readJson(planPath)
    const plan = normalizePlan(rawPlan, config)
    const targets = buildTargets(plan, config)
    return {
      sourceType: 'json',
      sourcePath: planPath,
      sourceName: path.basename(planPath),
      targets
    }
  }

  if (tryNbt) {
    const claimedQueuePath = config.__dashboardQueueNbtPath
      ? path.resolve(process.cwd(), String(config.__dashboardQueueNbtPath))
      : null
    const nextNbt = claimedQueuePath || getNextNbtFile(config)
    if (nextNbt) {
      if (!fs.existsSync(nextNbt)) {
        throw new Error(`Claimed dashboard queue NBT not found: ${nextNbt}`)
      }
      const data = await parseNbtFile(nextNbt)
      const targets = targetsFromNbt(data, config)
      return {
        sourceType: 'nbt',
        sourcePath: nextNbt,
        sourceName: path.basename(nextNbt),
        targets
      }
    }
  }

  if (mode === 'json') {
    throw new Error(`Plan file not found: ${planPath}`)
  }

  if (mode === 'nbt') {
    const folder = path.resolve(process.cwd(), files.nbtFolder || './nerv-printer-config')
    throw new Error(`No NBT files found in folder: ${folder}`)
  }

  throw new Error(`No input found. Checked JSON plan at ${planPath} and NBT files in ${path.resolve(process.cwd(), files.nbtFolder || './nerv-printer-config')}`)
}

function buildTargets(plan, config) {
  const printer = config.printer || {}
  const offsets = getPrintOffsets(config)
  const ignoredBlocks = new Set(Array.isArray(printer.ignoredBlocks) ? printer.ignoredBlocks : [])
  const northToSouth = printer.northToSouth !== false

  const rowIndexes = plan.rows.map((_, index) => index)
  if (!northToSouth) {
    rowIndexes.reverse()
  }

  const targets = []

  for (const row of rowIndexes) {
    for (let col = 0; col < plan.rows[row].length; col++) {
      const symbol = plan.rows[row][col]
      if (symbol === plan.ignoreChar) continue

      const blockName = plan.palette[symbol]
      if (!blockName) {
        throw new Error(`Missing palette mapping for symbol "${symbol}".`)
      }

      if (ignoredBlocks.has(blockName)) {
        continue
      }

      const rowOffset = axisOffset(plan.rowAxis, row)
      const colOffset = axisOffset(plan.colAxis, col)
      const position = addPos(plan.origin, addPos(rowOffset, colOffset))
      position.x += offsets.x
      position.y += offsets.y
      position.z += offsets.z
      targets.push({ row, col, symbol, blockName, position })
    }
  }

  return targets
}

function chooseNextTarget(bot, pending, linesPerRun) {
  if (!pending.length) return null

  const px = bot.entity.position.x
  const pz = bot.entity.position.z

  const sortedRows = [...new Set(pending.map((target) => target.row))]
  const activeRows = new Set(sortedRows.slice(0, Math.max(1, linesPerRun)))

  let bestIndex = -1
  let bestDistance = Number.POSITIVE_INFINITY

  for (let index = 0; index < pending.length; index++) {
    const target = pending[index]
    if (!activeRows.has(target.row)) continue

    const dx = px - (target.position.x + 0.5)
    const dz = pz - (target.position.z + 0.5)
    const distance2 = dx * dx + dz * dz

    if (distance2 < bestDistance) {
      bestDistance = distance2
      bestIndex = index
    }
  }

  if (bestIndex === -1) {
    bestIndex = 0
  }

  return pending.splice(bestIndex, 1)[0]
}

function orderTargetsLineByLine(targets, linesPerRun, northToSouth) {
  if (!targets.length) return []

  const byColRow = new Map()
  const cols = new Set()
  const rows = new Set()

  for (const target of targets) {
    cols.add(target.col)
    rows.add(target.row)
    byColRow.set(`${target.col}:${target.row}`, target)
  }

  const sortedCols = [...cols].sort((a, b) => a - b)
  const sortedRowsAsc = [...rows].sort((a, b) => a - b)
  const sortedRowsDesc = [...sortedRowsAsc].reverse()

  const ordered = []
  let startOnNorthSide = northToSouth

  for (let i = 0; i < sortedCols.length; i += Math.max(1, linesPerRun)) {
    const colBatch = sortedCols.slice(i, i + Math.max(1, linesPerRun))
    const rowOrder = startOnNorthSide ? sortedRowsAsc : sortedRowsDesc

    for (const row of rowOrder) {
      for (const col of colBatch) {
        const target = byColRow.get(`${col}:${row}`)
        if (target) ordered.push(target)
      }
    }

    startOnNorthSide = !startOnNorthSide
  }

  return ordered
}

function calibrateTargetsForWorld(bot, targets, config) {
  if (!targets.length) return targets

  const Vec3 = bot.entity.position.constructor
  const debug = config.advanced?.debugPrints
  const sampleSize = Math.min(400, targets.length)
  const sample = targets.slice(0, sampleSize)
  const candidateOffsets = [-3, -2, -1, 0, 1]

  let bestOffset = 0
  let bestScore = -1

  for (const offset of candidateOffsets) {
    let score = 0

    for (const target of sample) {
      const targetPos = new Vec3(target.position.x, target.position.y + offset, target.position.z)
      const support = bot.blockAt(targetPos.offset(0, -1, 0))

      if (support && support.name !== 'air') {
        score += 1
      }
    }

    if (debug) {
      console.log(`[CALIBRATE] yOffset=${offset} supportScore=${score}/${sampleSize}`)
    }

    // Prefer higher support score; on ties, prefer offset closer to 0 to avoid bad far shifts.
    if (score > bestScore || (score === bestScore && Math.abs(offset) < Math.abs(bestOffset))) {
      bestScore = score
      bestOffset = offset
    }
  }

  // If confidence is very low (e.g., chunks not loaded yet), keep original Y.
  const minReliableScore = Math.max(5, Math.floor(sampleSize * 0.05))
  if (bestScore < minReliableScore) {
    console.log(`[CALIBRATE] Low confidence (${bestScore}/${sampleSize}); using default target Y.`)
    return targets
  }

  if (bestOffset === 0) {
    console.log(`[CALIBRATE] Using default target Y (score ${bestScore}/${sampleSize}).`)
    return targets
  }

  console.log(`[CALIBRATE] Applying Y offset ${bestOffset} (score ${bestScore}/${sampleSize}).`)
  return targets.map((target) => ({
    ...target,
    position: {
      x: target.position.x,
      y: target.position.y + bestOffset,
      z: target.position.z
    }
  }))
}

function getHotbarWindowSlot(index) {
  return 36 + Math.max(0, Math.min(8, Math.floor(toNumber(index, 0))))
}

function findHotbarIndexForItem(bot, blockName) {
  const slots = Array.isArray(bot.inventory?.slots) ? bot.inventory.slots : []
  for (let index = 0; index < 9; index += 1) {
    const stack = slots[getHotbarWindowSlot(index)]
    if (stack?.name === blockName && toNumber(stack.count, 0) > 0) return index
  }
  return -1
}

function findBestInventorySlotForItem(bot, blockName) {
  return bot.inventory.items()
    .filter((entry) => entry.name === blockName && Number.isFinite(entry.slot))
    .sort((a, b) => {
      const aHotbar = a.slot >= 36 && a.slot <= 44 ? 1 : 0
      const bHotbar = b.slot >= 36 && b.slot <= 44 ? 1 : 0
      if (aHotbar !== bHotbar) return aHotbar - bHotbar
      return toNumber(b.count, 0) - toNumber(a.count, 0)
    })[0] || null
}

function chooseMaterialHotbarIndex(bot, blockName) {
  const existing = findHotbarIndexForItem(bot, blockName)
  if (existing >= 0) return existing

  const slots = Array.isArray(bot.inventory?.slots) ? bot.inventory.slots : []
  for (let index = 0; index < 9; index += 1) {
    if (!slots[getHotbarWindowSlot(index)]) return index
  }

  const byName = new Map()
  for (let index = 0; index < 9; index += 1) {
    const stack = slots[getHotbarWindowSlot(index)]
    if (!stack?.name) continue
    const entry = byName.get(stack.name) || { name: stack.name, count: 0, index }
    entry.count += 1
    byName.set(stack.name, entry)
  }

  let replacement = null
  for (const entry of byName.values()) {
    if (!replacement || entry.count > replacement.count) replacement = entry
  }

  if (replacement) return Math.max(0, Math.min(8, replacement.index))
  const current = Number.isFinite(bot.quickBarSlot) ? bot.quickBarSlot : 0
  return Math.max(0, Math.min(8, current))
}

function findNeutralHotbarIndex(bot, blockedItemNames = []) {
  const blocked = new Set(blockedItemNames.map((name) => String(name || '').trim()).filter(Boolean))
  const slots = Array.isArray(bot.inventory?.slots) ? bot.inventory.slots : []
  for (let index = 0; index < 9; index += 1) {
    if (!slots[getHotbarWindowSlot(index)]) return index
  }
  for (let index = 0; index < 9; index += 1) {
    const stack = slots[getHotbarWindowSlot(index)]
    if (stack && !blocked.has(stack.name)) return index
  }
  return -1
}

async function waitForNeutralHeldItem(bot, blockedItemNames = [], timeoutMs = 1000, pollMs = 50) {
  const blocked = new Set(blockedItemNames.map((name) => String(name || '').trim()).filter(Boolean))
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() <= deadline) {
    const selectedIndex = Number.isFinite(bot.quickBarSlot) ? bot.quickBarSlot : -1
    const selectedStack = selectedIndex >= 0 ? bot.inventory?.slots?.[getHotbarWindowSlot(selectedIndex)] : null
    const heldName = String(bot.heldItem?.name || '')
    const selectedName = String(selectedStack?.name || '')
    if (!blocked.has(heldName) && !blocked.has(selectedName)) return true
    await delay(Math.max(25, pollMs))
  }
  const selectedIndex = Number.isFinite(bot.quickBarSlot) ? bot.quickBarSlot : -1
  const selectedStack = selectedIndex >= 0 ? bot.inventory?.slots?.[getHotbarWindowSlot(selectedIndex)] : null
  const heldName = String(bot.heldItem?.name || '')
  const selectedName = String(selectedStack?.name || '')
  return !blocked.has(heldName) && !blocked.has(selectedName)
}

async function selectNeutralHotbarForWindow(bot, blockedItemNames = [], reason = 'window-interaction') {
  const index = findNeutralHotbarIndex(bot, blockedItemNames)
  if (index < 0) return false
  if (typeof bot.setQuickBarSlot === 'function') bot.setQuickBarSlot(index)
  else bot.quickBarSlot = index
  const ok = await waitForNeutralHeldItem(bot, blockedItemNames, 1200, 50)
  const stack = bot.inventory?.slots?.[getHotbarWindowSlot(index)]
  console.log(`[WINDOW-HAND] ${reason}: selected hotbar=${index} stack=${formatWindowStack(stack)} held=${formatWindowStack(bot.heldItem)} neutral=${ok}`)
  return ok
}

async function waitForHotbarItem(bot, hotbarIndex, blockName, timeoutMs = 900, pollMs = 75) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const windowSlot = getHotbarWindowSlot(hotbarIndex)
  while (Date.now() <= deadline) {
    const stack = bot.inventory?.slots?.[windowSlot]
    if (stack?.name === blockName && toNumber(stack.count, 0) > 0) return true
    await delay(Math.max(25, pollMs))
  }
  const stack = bot.inventory?.slots?.[windowSlot]
  return stack?.name === blockName && toNumber(stack.count, 0) > 0
}

function getSelectedHotbarStack(bot) {
  const selectedIndex = Number.isFinite(bot.quickBarSlot) ? bot.quickBarSlot : -1
  return selectedIndex >= 0 ? bot.inventory?.slots?.[getHotbarWindowSlot(selectedIndex)] : null
}

function selectedMaterialMatches(bot, blockName) {
  const selectedStack = getSelectedHotbarStack(bot)
  const selectedMatches = selectedStack?.name === blockName && toNumber(selectedStack.count, 0) > 0
  const heldMatches = String(bot.heldItem?.name || '') === blockName && toNumber(bot.heldItem?.count, 0) > 0
  return selectedMatches && heldMatches
}

async function waitForSelectedMaterialReady(bot, blockName, timeoutMs = 900, pollMs = 75, stableMs = 0) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const requiredStableMs = Math.max(0, toNumber(stableMs, 0))
  let stableSince = 0
  while (Date.now() <= deadline) {
    if (selectedMaterialMatches(bot, blockName)) {
      if (requiredStableMs <= 0) return true
      if (!stableSince) stableSince = Date.now()
      if (Date.now() - stableSince >= requiredStableMs) return true
    } else {
      stableSince = 0
    }
    await delay(Math.max(25, pollMs))
  }
  return requiredStableMs <= 0 && selectedMaterialMatches(bot, blockName)
}

async function selectHotbarMaterial(bot, config, blockName, options = {}) {
  const advanced = config.advanced || {}
  const fastSwap = options.fastSwap === true
  const timeoutMs = Math.max(100, toNumber(advanced.inventoryDesyncEquipTimeoutMs, 900))
  const pollMs = Math.max(25, toNumber(advanced.inventoryDesyncEquipPollMs, 75))
  const setSelectedHotbar = (index) => {
    if (typeof bot.setQuickBarSlot === 'function') bot.setQuickBarSlot(index)
    else bot.quickBarSlot = index
  }
  const hotbarSelectStableMs = Math.max(0, toNumber(
    fastSwap ? advanced.scannerPostHotbarSelectDelayMs : advanced.postHotbarSelectDelayMs,
    0
  ))
  const inventorySwapStableMs = Math.max(0, toNumber(
    fastSwap ? advanced.scannerPostInventorySwapDelayMs : advanced.postInventorySwapDelayMs,
    fastSwap ? toNumber(advanced.scannerPostSwapDelayMs, 50) : toNumber(advanced.postSwapDelayMs, 100)
  ))

  const existingHotbar = findHotbarIndexForItem(bot, blockName)
  if (existingHotbar >= 0) {
    setSelectedHotbar(existingHotbar)
    return await waitForSelectedMaterialReady(bot, blockName, timeoutMs + hotbarSelectStableMs, pollMs, hotbarSelectStableMs)
  }

  const source = findBestInventorySlotForItem(bot, blockName)
  if (!source) return false

  if (source.slot >= 36 && source.slot <= 44) {
    setSelectedHotbar(source.slot - 36)
    return await waitForSelectedMaterialReady(bot, blockName, timeoutMs + hotbarSelectStableMs, pollMs, hotbarSelectStableMs)
  }

  const hotbarIndex = chooseMaterialHotbarIndex(bot, blockName)
  const preSwapDelayMs = Math.max(0, toNumber(fastSwap ? advanced.scannerPreSwapDelayMs : advanced.preSwapDelayMs, fastSwap ? 0 : 100))
  const wasMoving = {
    sprint: bot.controlState?.sprint === true,
    forward: bot.controlState?.forward === true,
    back: bot.controlState?.back === true,
    left: bot.controlState?.left === true,
    right: bot.controlState?.right === true
  }

  if (preSwapDelayMs > 0) await delay(preSwapDelayMs)

  try {
    for (const control of ['sprint', 'forward', 'back', 'left', 'right']) {
      bot.setControlState(control, false)
    }
    await bot.clickWindow(source.slot, hotbarIndex, 2)
    const swapped = await waitForHotbarItem(bot, hotbarIndex, blockName, timeoutMs, pollMs)
    if (!swapped) return false
    setSelectedHotbar(hotbarIndex)
    return await waitForSelectedMaterialReady(bot, blockName, timeoutMs + inventorySwapStableMs, pollMs, inventorySwapStableMs)
  } finally {
    for (const [control, value] of Object.entries(wasMoving)) {
      if (value) bot.setControlState(control, true)
    }
  }
}

async function equipMaterial(bot, config, blockName, options = {}) {
  const allowRestock = options.allowRestock !== false
  const inventoryItem = bot.inventory.items().find((entry) => entry.name === blockName)
  const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[blockName]?.stackSize, 64))

  if (inventoryItem) {
    const selected = await selectHotbarMaterial(bot, config, blockName, options)
    if (selected) {
      unavailableMaterialCache.delete(blockName)
      return true
    }
  }

  if (unavailableMaterialCache.has(blockName)) {
    return false
  }

  if (!allowRestock) {
    return false
  }

  return await waitForRequiredMaterialRestock(bot, config, blockName, 1, new Map([[blockName, stackSize]]), 'equip-material')
}

async function recoverMissingItemInventoryDesync(bot, config, blockName, label = 'inventory-desync') {
  const advanced = config.advanced || {}
  const have = countInventoryItems(bot, blockName)
  if (have <= 0) return false
  if (selectedMaterialMatches(bot, blockName)) return true

  const attempts = Math.max(1, toNumber(advanced.inventoryDesyncEquipAttempts, 2))
  const timeoutMs = Math.max(100, toNumber(advanced.inventoryDesyncEquipTimeoutMs, 900))
  const pollMs = Math.max(25, toNumber(advanced.inventoryDesyncEquipPollMs, 75))

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const selected = await selectHotbarMaterial(bot, config, blockName, { fastSwap: true })
      if (!selected) return false
    } catch (err) {
      if (config.errorHandling?.logErrors !== false) {
        console.log(`[INVENTORY-DESYNC-WARN] ${label}: hotbar swap ${blockName} attempt=${attempt}/${attempts} failed: ${err?.message || err}`)
      }
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (selectedMaterialMatches(bot, blockName)) {
        if (config.errorHandling?.logErrors !== false) {
          console.log(`[INVENTORY-DESYNC-RECOVER] ${label}: selected ${blockName}; inventory=${countInventoryItems(bot, blockName)}.`)
        }
        return true
      }
      await delay(pollMs)
    }
  }

  if (config.errorHandling?.logErrors !== false) {
    console.log(`[INVENTORY-DESYNC-WARN] ${label}: inventory has ${have} ${blockName}, but held item could not be verified.`)
  }
  return false
}

function normalizeRestockSyncStrategy(value) {
  const normalized = String(value || 'nerv-window').toLowerCase().trim()
  if (normalized === 'safe') return 'safe'
  if (normalized === 'nerv' || normalized === 'window' || normalized === 'nerv-window') return 'nerv-window'
  return 'nerv-window'
}

function getMaterialChestPositions(config, blockName) {
  const materialDict = config.machine?.materialDict || {}
  const value = materialDict[blockName]
  if (!Array.isArray(value)) return []

  return value
    .map((entry) => {
      const pos = toBlockPos(entry)
      if (!pos) return null
      const accessPosition = toOpenPos(entry)
      return accessPosition ? { ...pos, accessPosition } : pos
    })
    .filter(Boolean)
}

function chestTravelPoint(pos) {
  return pos?.accessPosition || pos
}

function horizontalDist2(bot, pos) {
  const travel = chestTravelPoint(pos)
  if (!Number.isFinite(travel?.x) || !Number.isFinite(travel?.z)) return Number.POSITIVE_INFINITY
  const dx = bot.entity.position.x - (Number(travel.x) + 0.5)
  const dz = bot.entity.position.z - (Number(travel.z) + 0.5)
  return dx * dx + dz * dz
}

function groupChestPositionsByRegion(spots) {
  const groups = []
  const attachDist2 = 20 * 20

  for (const spot of spots) {
    const spotTravel = chestTravelPoint(spot)
    let bestIndex = -1
    let bestDist = Number.POSITIVE_INFINITY

    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i]
      const dx = Number(spotTravel.x) - g.cx
      const dz = Number(spotTravel.z) - g.cz
      const dist2 = dx * dx + dz * dz
      if (dist2 < bestDist) {
        bestDist = dist2
        bestIndex = i
      }
    }

    if (bestIndex >= 0 && bestDist <= attachDist2) {
      const g = groups[bestIndex]
      g.spots.push(spot)
      const n = g.spots.length
      g.cx = ((g.cx * (n - 1)) + Number(spotTravel.x)) / n
      g.cz = ((g.cz * (n - 1)) + Number(spotTravel.z)) / n
    } else {
      groups.push({
        cx: Number(spotTravel.x),
        cz: Number(spotTravel.z),
        spots: [spot]
      })
    }
  }

  return groups
}

function getMaterialChestGroupsForRefill(bot, config, blockName) {
  const spots = getMaterialChestPositions(config, blockName)
  if (!spots.length) return []

  const groups = groupChestPositionsByRegion(spots)
  for (const group of groups) {
    group.spots.sort((a, b) => horizontalDist2(bot, a) - horizontalDist2(bot, b))
  }

  groups.sort((a, b) => {
    const da = horizontalDist2(bot, { x: a.cx, z: a.cz })
    const db = horizontalDist2(bot, { x: b.cx, z: b.cz })
    return da - db
  })

  return groups.map((group) => group.spots)
}

async function openContainerAt(bot, position, accessPosition, options = {}) {
  const Vec3 = bot.entity.position.constructor
  const blockPos = new Vec3(position.x, position.y, position.z)
  const accessRange = Math.max(0.35, toNumber(options.accessRange, accessPosition ? 1.25 : 2))
  const attempts = Math.max(1, Math.floor(toNumber(options.attempts, 3)))
  const timeoutMs = Math.max(500, toNumber(options.timeoutMs, 2500))
  const adjustedTimeoutMs = getLatencyAdjustedTimeoutMs(bot, options.config || bot.__nervConfig, timeoutMs, timeoutMs)
  const retryDelayMs = Math.max(50, toNumber(options.retryDelayMs, 250))
  const blockWaitMs = Math.max(500, toNumber(options.blockWaitMs, 5000))
  const blockPollMs = Math.max(50, toNumber(options.blockPollMs, 150))
  const strictAccess = options.strictAccess === true
  // Always navigate to accessPosition if provided — it is the configured standing spot for the chest.
  // Falling back to the chest block position when far away caused the bot to pathfind into walls/inaccessible spots.
  await gotoConfiguredAccess(bot, position, accessPosition, accessRange, options.config || null, options.reason || 'open-container', { strict: strictAccess })

  const block = await waitForBlockAt(bot, blockPos, {
    timeoutMs: blockWaitMs,
    pollMs: blockPollMs,
    expectedNames: options.expectedNames
  })

  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      closeCurrentWindowIfOpen(bot, `open-container-attempt-${attempt}`)
      await applyAdaptiveLatencyBackoff(bot, options.config || bot.__nervConfig, `open-container-attempt-${attempt}`, { pauseMovement: true })
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
      return await Promise.race([
        bot.openContainer(block),
        (async () => {
          await delay(adjustedTimeoutMs)
          throw new Error(`open-container-timeout-${adjustedTimeoutMs}ms`)
        })()
      ])
    } catch (err) {
      lastError = err
      if (attempt >= attempts) break
      try { bot.pathfinder?.stop?.() } catch { }
      await delay(retryDelayMs)
      await gotoConfiguredAccess(bot, position, accessPosition, Math.max(0.35, accessRange * 0.8), options.config || null, options.reason || 'open-container-retry', { strict: strictAccess })
    }
  }

  throw new Error(`Could not open container at ${position.x} ${position.y} ${position.z} from ${formatBotPosition(bot)}: ${lastError?.message || lastError}`)
}

async function restockMaterial(bot, config, blockName, requestedPulls = 1, neededByBlock = null, options = {}) {
  assertRuntimeContinue(bot, config, 'stopping-during-restock')
  const advanced = config.advanced || {}
  const restockSyncStrategy = normalizeRestockSyncStrategy(advanced.restockSyncStrategy)
  let forceSafeRestock = restockSyncStrategy === 'safe'
  const failureCooldownMs = Math.max(0, toNumber(advanced.restockFailureCooldownMs, 8000))
  const syncWaitMs = Math.max(200, toNumber(advanced.restockInventorySyncWaitMs, 2000))
  const lastFailedAt = restockFailureCache.get(blockName)
  if (options.ignoreFailureCooldown !== true && lastFailedAt && Date.now() - lastFailedAt < failureCooldownMs) {
    return false
  }

  const spotGroups = getMaterialChestGroupsForRefill(bot, config, blockName)
  const spots = spotGroups.flat()

  if (!spots.length) {
    unavailableMaterialCache.add(blockName)
    console.log(`[RESTOCK-WARN] Mapart material chest is not configured for ${blockName}.`)
    return false
  }

  const itemId = bot.registry.itemsByName[blockName]?.id
  if (!itemId) {
    unavailableMaterialCache.add(blockName)
    console.log(`[RESTOCK-WARN] Unknown mapart material ${blockName}.`)
    return false
  }

  const itemInfo = bot.registry.itemsByName[blockName] || {}
  const stackSize = Math.max(1, toNumber(itemInfo.stackSize, 64))
  const requestedStackCount = Math.max(1, toNumber(requestedPulls, 1))
  const sameChestSyncRetries = Math.max(restockSyncStrategy === 'nerv-window' ? 1 : 0, toNumber(advanced.restockSameChestSyncRetries, 2))
  const sameChestRetryDelayMs = Math.max(200, toNumber(advanced.restockSameChestRetryDelayMs, Math.max(syncWaitMs, 1200)))
  const sameChestRetryPollMs = Math.max(25, toNumber(advanced.restockSameChestRetryPollMs, 100))
  const sameChestRetrySettleMs = Math.max(0, toNumber(advanced.restockSameChestRetrySettleMs, 150))
  const fastBurstStacks = Math.max(1, toNumber(advanced.restockFastStacksPerBurst, 8))
  const fastBurstSettleMs = Math.max(0, toNumber(advanced.restockFastSettleMs, restockSyncStrategy === 'nerv-window' ? 0 : 300))
  const fastBurstMinItems = Math.max(stackSize * 2, toNumber(advanced.restockFastMinItems, stackSize * 2))
  const haveBeforeRestock = countInventoryItems(bot, blockName)
  const exactDesiredItemCount = neededByBlock instanceof Map && neededByBlock.has(blockName)
    ? Math.max(0, toNumber(neededByBlock.get(blockName), haveBeforeRestock + requestedStackCount * stackSize))
    : Math.max(stackSize, haveBeforeRestock + (requestedStackCount * stackSize))
  const initialRoundedDeficit = Math.max(0, exactDesiredItemCount - haveBeforeRestock)
  const capacityBeforeRestock = inventoryCapacityForItem(bot, blockName)
  const canTopUpExistingStack = neededByBlock instanceof Map &&
    initialRoundedDeficit > 0 &&
    initialRoundedDeficit <= capacityBeforeRestock &&
    capacityBeforeRestock < stackSize
  const desiredItemCount = initialRoundedDeficit > 0 && !canTopUpExistingStack
    ? haveBeforeRestock + Math.max(stackSize, Math.ceil(initialRoundedDeficit / stackSize) * stackSize)
    : exactDesiredItemCount
  const keepPlan = neededByBlock instanceof Map ? neededByBlock : new Map([[blockName, desiredItemCount]])

  if (neededByBlock instanceof Map && haveBeforeRestock >= exactDesiredItemCount) {
    restockFailureCache.delete(blockName)
    unavailableMaterialCache.delete(blockName)
    const inventoryItem = bot.inventory.items().find((entry) => entry.name === blockName)
    if (inventoryItem) { try { await bot.equip(inventoryItem, 'hand') } catch { } }
    return true
  }

  const needsStackPull = desiredItemCount > haveBeforeRestock
  const hasStackPullRoom = capacityBeforeRestock >= stackSize || canTopUpExistingStack
  if (!inventoryHasRoomForItem(bot, blockName) || (needsStackPull && !hasStackPullRoom)) {
    const dumped = await dumpUnneededCarpets(bot, config, keepPlan)
    const capacityAfterDump = inventoryCapacityForItem(bot, blockName)
    const canTopUpAfterDump = neededByBlock instanceof Map &&
      Math.max(0, exactDesiredItemCount - countInventoryItems(bot, blockName)) <= capacityAfterDump &&
      capacityAfterDump < stackSize
    if (!dumped && (!inventoryHasRoomForItem(bot, blockName) || (capacityAfterDump < stackSize && !canTopUpAfterDump))) {
      restockFailureCache.set(blockName, Date.now())
      if (config.errorHandling?.logErrors !== false) {
        console.log(`[RESTOCK-WARN] No full-stack inventory space for ${blockName} and nothing dumpable.`)
      }
      return false
    }
    if (needsStackPull && inventoryCapacityForItem(bot, blockName) < stackSize && !canTopUpAfterDump) {
      restockFailureCache.set(blockName, Date.now())
      if (config.errorHandling?.logErrors !== false) {
        console.log(`[RESTOCK-WARN] Could not free a full inventory slot for ${blockName}.`)
      }
      return false
    }
  }

  for (let groupIndex = 0; groupIndex < spotGroups.length; groupIndex += 1) {
    assertRuntimeContinue(bot, config, 'stopping-during-restock')
    const group = spotGroups[groupIndex]

    for (let spotIndex = 0; spotIndex < group.length; spotIndex += 1) {
      assertRuntimeContinue(bot, config, 'stopping-during-restock')
      const spot = group[spotIndex]
      let sameChestAttempt = 0

      while (sameChestAttempt <= sameChestSyncRetries) {
        assertRuntimeContinue(bot, config, 'stopping-during-restock')
        let container = null
        let retrySameChest = false
        let retryStartHave = 0
        let retryTargetCount = 0
        let skipRetryCatchupWait = false
        const attemptStrategy = forceSafeRestock ? 'safe' : restockSyncStrategy
        try {
          const travel = chestTravelPoint(spot)
          if (config.errorHandling?.logErrors !== false) {
            const retryLabel = sameChestAttempt > 0 ? ` retry=${sameChestAttempt}/${sameChestSyncRetries}` : ''
            console.log(`[RESTOCK-CHEST] ${blockName}: chest=${spot.x},${spot.y},${spot.z} open=${travel?.x ?? spot.x},${travel?.y ?? spot.y},${travel?.z ?? spot.z} dist=${Math.round(Math.sqrt(horizontalDist2(bot, spot)))} strategy=${attemptStrategy}${retryLabel}`)
          }
          try {
            container = await openContainerAt(bot, spot, spot.accessPosition, {
              config,
              reason: `restock-${blockName}`,
              strictAccess: Boolean(spot.accessPosition),
              accessRange: toNumber(advanced.restockChestAccessRange, 1.25),
              attempts: toNumber(advanced.restockChestOpenAttempts, 3),
              timeoutMs: toNumber(advanced.restockChestOpenTimeoutMs, 2500),
              retryDelayMs: toNumber(advanced.restockChestOpenRetryDelayMs, 250),
              blockWaitMs: toNumber(advanced.restockChestBlockWaitMs, 5000),
              blockPollMs: toNumber(advanced.restockChestBlockPollMs, 150),
              expectedNames: ['chest', 'trapped_chest', 'barrel']
            })
          } catch (navErr) {
            const navMsg = String(navErr?.message || navErr || '').toLowerCase()
            if (navMsg.includes('goal was changed') || navMsg.includes('goalchanged')) {
              console.log(`[RESTOCK-WARN] Navigation interrupted (GoalChanged) going to chest for ${blockName}; skipping this chest.`)
              logPingDiagnostic(bot, config, 'restock-navigation-goalchanged', {
                block: blockName,
                chest: `${spot.x},${spot.y},${spot.z}`,
                pos: formatBotPosition(bot)
              }, { force: true })
              break
            }
            throw navErr
          }
          await delay(toNumber(advanced.preRestockDelayMs, 200))

          const cleanup = await cleanAssignedMaterialChest(bot, config, container, spot, blockName, itemId)
          if (cleanup.reopen) {
            try { container.close() } catch { }
            container = null
            await delay(Math.max(0, toNumber(advanced.assignedMaterialChestCleanupPostCloseSyncMs, toNumber(advanced.restockPostCloseInventorySyncMs, 2000))))
            await dumpAssignedChestCleanupItems(bot, config, cleanup.removed, blockName)
            retrySameChest = true
            skipRetryCatchupWait = true
            continue
          }

        // Count ALL of the target item in this chest — including partial stacks.
        // BUG FIX: old code used Math.floor(total/64) which silently skipped chests
        // with partial stacks (e.g. 30 carpets -> 30/64=0 -> skipped entirely).
        let chestSlots = container.containerItems().filter((entry) => entry.type === itemId)
        let totalInChest = chestSlots.reduce((sum, entry) => sum + toNumber(entry.count, 0), 0)

        // On laggy servers the chest window may not have synced yet — retry once after a short wait
        if (totalInChest <= 0) {
          await delay(Math.max(200, toNumber(advanced.preRestockDelayMs, 200)))
          chestSlots = container.containerItems().filter((entry) => entry.type === itemId)
          totalInChest = chestSlots.reduce((sum, entry) => sum + toNumber(entry.count, 0), 0)
        }

        if (typeof options.onMaterialChestScanned === 'function') {
          try {
            options.onMaterialChestScanned({
              blockName,
              count: totalInChest,
              chest: { x: spot.x, y: spot.y, z: spot.z },
              groupIndex,
              groupSize: Array.isArray(spotGroups[groupIndex]) ? spotGroups[groupIndex].length : null,
              spotIndex
            })
          } catch { }
        }

        if (totalInChest <= 0) {
          if (config.errorHandling?.logErrors !== false) {
            console.log(`[RESTOCK-SKIP] Chest at ${spot.x} ${spot.y} ${spot.z} has 0 of ${blockName}, moving to next.`)
          }
          try { container.close() } catch { }
          container = null
          break
        }

        if (typeof options.onMaterialObserved === 'function') {
          try {
            options.onMaterialObserved({
              blockName,
              count: totalInChest,
              chest: { x: spot.x, y: spot.y, z: spot.z },
              groupIndex,
              spotIndex
            })
          } catch { }
        }

        // How much do we need vs what the chest has?
        const haveAtStart = countInventoryItems(bot, blockName)
        retryStartHave = haveAtStart
        const exactStillNeedTotal = Math.max(0, exactDesiredItemCount - haveAtStart)
        const roundedStillNeedTotal = exactStillNeedTotal > 0
          ? Math.ceil(exactStillNeedTotal / stackSize) * stackSize
          : 0
        const stillNeedTotal = Math.max(0, desiredItemCount - haveAtStart, roundedStillNeedTotal)
        // Match upstream Nerv behavior: restock by quick-moving complete stacks.
        // Avoid high-level withdrawal helpers because they can report stale inventory when
        // there are no empty slots even if a partial same-item stack exists —
        // the server may not merge partial stacks during shift-click withdrawal.
        // The next traversal gets its own dump/prepare cycle instead of saving leftovers.
        const emptySlotCapacity = countEmptyInventorySlots(bot) * stackSize
        const partialCapacity = inventoryCapacityForItem(bot, blockName) - emptySlotCapacity
        const capacityBeforePull = emptySlotCapacity + Math.max(0, partialCapacity)
        const fullStackCapacityBeforePull = Math.floor(capacityBeforePull / stackSize) * stackSize
        const canPartialTopUp = desiredItemCount === exactDesiredItemCount &&
          exactStillNeedTotal > 0 &&
          exactStillNeedTotal <= capacityBeforePull &&
          fullStackCapacityBeforePull < stackSize
        if (canPartialTopUp) {
          const moved = await topUpPartialInventoryStackFromChest(
            bot,
            container,
            itemId,
            blockName,
            exactStillNeedTotal,
            stackSize,
            syncWaitMs,
            sameChestRetryPollMs
          )
          const haveAfterTopUp = countInventoryItems(bot, blockName)
          const totalAfterTopUp = container.containerItems()
            .filter((entry) => entry.type === itemId)
            .reduce((sum, entry) => sum + toNumber(entry.count, 0), 0)
          const partialPulled = Math.max(0, Math.min(totalInChest, Math.max(moved, haveAfterTopUp - haveAtStart)))
          if (config.errorHandling?.logErrors !== false) {
            console.log(`[RESTOCK-PARTIAL] ${blockName}: have=${haveAtStart} needExact=${exactDesiredItemCount} moved=${moved} capacity=${capacityBeforePull}`)
          }
          if (partialPulled > 0 && typeof options.onMaterialPulled === 'function') {
            try {
              options.onMaterialPulled({
                blockName,
                pulledCount: partialPulled,
                beforeChestTotal: totalInChest,
                afterChestTotal: totalAfterTopUp,
                chest: { x: spot.x, y: spot.y, z: spot.z },
                groupIndex,
                groupSize: Array.isArray(spotGroups[groupIndex]) ? spotGroups[groupIndex].length : null,
                spotIndex
              })
            } catch { }
          }
          try { container.close() } catch { }
          container = null
          if (haveAfterTopUp >= exactDesiredItemCount) {
            restockFailureCache.delete(blockName)
            unavailableMaterialCache.delete(blockName)
            const inventoryItem = bot.inventory.items().find((entry) => entry.name === blockName)
            if (inventoryItem) { try { await bot.equip(inventoryItem, 'hand') } catch { } }
            return true
          }
          break
        }
        const fullStackChestTotal = chestSlots
          .filter((entry) => toNumber(entry.count, 0) >= stackSize)
          .reduce((sum, entry) => sum + stackSize, 0)
        const fullStackPullNeed = stillNeedTotal > 0 ? Math.ceil(stillNeedTotal / stackSize) * stackSize : 0
        const willPullTotal = Math.min(fullStackChestTotal, fullStackPullNeed, fullStackCapacityBeforePull)
        retryTargetCount = haveAtStart + willPullTotal

        if (willPullTotal <= 0) {
          try { container.close() } catch { }
          container = null
          if (haveAtStart >= desiredItemCount) {
            // Already have enough from a previous chest pull in this call
            restockFailureCache.delete(blockName)
            unavailableMaterialCache.delete(blockName)
            const inventoryItem = bot.inventory.items().find((entry) => entry.name === blockName)
            if (inventoryItem) { try { await bot.equip(inventoryItem, 'hand') } catch { } }
            return true
          }
          // No capacity; skip remaining spots in this group and fall through to return false
          break
        }

        if (config.errorHandling?.logErrors !== false) {
          console.log(`[RESTOCK-PULL] ${blockName}: have=${haveAtStart} needExact=${exactDesiredItemCount} needRounded=${desiredItemCount} chestHas=${totalInChest} pulling=${willPullTotal} empty=${Math.floor(emptySlotCapacity / stackSize)}slots`)
        }

        // Pull in full stack quick-move transactions, matching the upstream Nerv addon.
        // Avoid high-level withdraw helpers: on busy servers they can report stale inventory and make
        // us abandon a chest that already accepted the click.
        let observedHave = haveAtStart
        let maxWindowHave = haveAtStart
        const targetCount = haveAtStart + willPullTotal
        let stoppedForInventoryFull = false
        let stoppedForInventorySync = false
        while (observedHave < targetCount) {
          const haveBeforePull = countInventoryItems(bot, blockName)
          observedHave = Math.max(observedHave, haveBeforePull)
          const amountStillNeeded = targetCount - observedHave
          const currentCapacity = inventoryCapacityForItem(bot, blockName)
          if (currentCapacity < stackSize) {
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[RESTOCK-WARN] ${blockName} needs ${amountStillNeeded} more but full-stack capacity is ${currentCapacity}; stopping pull.`)
            }
            stoppedForInventoryFull = true
            break
          }

          try {
            const useNervWindow = attemptStrategy === 'nerv-window'
            const burstNeed = Math.min(amountStillNeeded, currentCapacity)
            const burstStacksRequested = Math.max(1, Math.min(fastBurstStacks, Math.floor(burstNeed / stackSize)))
            const windowBefore = countWindowInventoryItems(container, itemId, blockName)
            const burst = await quickMoveChestItemStacks(bot, container, itemId, burstNeed, stackSize, burstStacksRequested, {
              onlyFullStacks: true,
              timeoutMs: syncWaitMs,
              pollMs: sameChestRetryPollMs,
              waitForSlot: !useNervWindow,
              actionDelayMs: useNervWindow
                ? Math.max(0, toNumber(advanced.inventoryActionDelayMs, 10))
                : sameChestRetryPollMs
            })

            if (burst.stacksMoved <= 0) {
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[RESTOCK-WARN] ${blockName} found no full stack to quick-move in this chest; moving to next chest.`)
              }
              break
            }

            if (fastBurstSettleMs > 0) await delay(fastBurstSettleMs)
            const expectedWindowTarget = Math.min(targetCount, windowBefore + burst.movedEstimate)
            const windowHave = useNervWindow
              ? countWindowInventoryItems(container, itemId, blockName)
              : await waitForWindowInventoryCount(
                container,
                itemId,
                blockName,
                expectedWindowTarget,
                syncWaitMs,
                sameChestRetryPollMs
              )
            let haveAfterWait = useNervWindow
              ? countInventoryItems(bot, blockName)
              : await waitForInventoryCountChangeOrTarget(
                bot,
                blockName,
                haveBeforePull,
                Math.min(targetCount, expectedWindowTarget),
                syncWaitMs,
                sameChestRetryPollMs,
                sameChestRetrySettleMs
              )
            observedHave = Math.max(observedHave, haveAfterWait, windowHave)
            maxWindowHave = Math.max(maxWindowHave, windowHave)

            if (config.errorHandling?.logErrors !== false) {
              console.log(`[RESTOCK-BURST] ${blockName}: strategy=${attemptStrategy} quickMovedStacks=${burst.stacksMoved} durationMs=${burst.durationMs} windowHave=${windowHave} invHave=${haveAfterWait} target=${targetCount}`)
            }

            if (windowHave >= Math.min(targetCount, expectedWindowTarget)) {
              // The open container window is the authoritative view for this transaction.
              // bot.inventory can stay stale until the window closes, so do not classify a
              // confirmed window quick-move as a failed withdrawal.
              observedHave = Math.max(observedHave, windowHave)
              continue
            }

            if (!useNervWindow && windowHave > haveBeforePull && haveAfterWait < Math.min(targetCount, windowHave)) {
              haveAfterWait = await waitForInventoryCountChangeOrTarget(
                bot,
                blockName,
                haveBeforePull,
                Math.min(targetCount, windowHave),
                sameChestRetryDelayMs,
                sameChestRetryPollMs,
                sameChestRetrySettleMs
              )
              observedHave = Math.max(observedHave, haveAfterWait)
            }

            if (observedHave <= haveBeforePull) {
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[RESTOCK-WARN] ${blockName} quick-move did not reach inventory/window after sync wait: before=${haveBeforePull} target=${targetCount}`)
              }
              stoppedForInventorySync = true
              break
            }
          } catch (err) {
            const message = String(err?.message || err).toLowerCase()
            const inventoryFull = message.includes('no free') ||
              message.includes('inventory full') ||
              message.includes('inventory is full') ||
              message.includes('free room') ||
              message.includes('no space')

            if (inventoryFull) {
              // Check if we actually got some items despite the error
              const haveNowCheck = countInventoryItems(bot, blockName)
              if (haveNowCheck > haveAtStart) {
                observedHave = Math.max(observedHave, haveNowCheck)
              } else if (config.errorHandling?.logErrors !== false) {
                console.log(`[RESTOCK-WARN] Inventory full while pulling ${blockName}; stopping this chest.`)
              }
              stoppedForInventoryFull = true
              break
            }
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[RESTOCK-WARN] quick-move error for ${blockName}: ${err?.message || err}`)
            }
            break
          }
        }

        await delay(toNumber(advanced.postRestockDelayMs, 300))

        // If observedHave reached target via the open container window, the quick-move
        // transaction already succeeded. bot.inventory may remain stale until close, so
        // do not warn/retry based on that secondary cache.

        if (stoppedForInventoryFull) {
          const haveNow = countInventoryItems(bot, blockName)
          // Inventory is full but check if we actually have enough for what was planned.
          // desiredItemCount may exceed capacity (e.g. need=66 but max fits=64), so
          // success = got everything we could actually pull (haveAtStart + willPullTotal).
          if (haveNow >= haveAtStart + willPullTotal || haveNow >= desiredItemCount) {
            restockFailureCache.delete(blockName)
            unavailableMaterialCache.delete(blockName)
            if (container) {
              try { container.close() } catch { }
              container = null
            }
            const ready = await waitForRestockInventoryReady(
              bot,
              config,
              blockName,
              haveAtStart,
              Math.min(desiredItemCount, haveAtStart + willPullTotal),
              'inventory-full-success'
            )
            if (ready) return true
            if (attemptStrategy === 'nerv-window' && sameChestAttempt < sameChestSyncRetries) {
              forceSafeRestock = true
              retrySameChest = true
              skipRetryCatchupWait = true
              console.log(`[RESTOCK-FALLBACK] ${blockName} nerv-window final sync failed after inventory-full success; reopening same chest with safe strategy.`)
            } else {
              return false
            }
          }
          if (!retrySameChest) {
            restockFailureCache.set(blockName, Date.now())
            console.log(`[RESTOCK-WARN] Stopping ${blockName} restock because inventory is full: have=${haveNow} target=${desiredItemCount}.`)
            return false
          }
        }

        if (observedHave >= haveAtStart + willPullTotal || observedHave >= desiredItemCount ||
          countInventoryItems(bot, blockName) >= haveAtStart + willPullTotal ||
          countInventoryItems(bot, blockName) >= desiredItemCount) {
          restockFailureCache.delete(blockName)
          unavailableMaterialCache.delete(blockName)
          const totalAfterPull = container
            ? container.containerItems()
              .filter((entry) => entry.type === itemId)
              .reduce((sum, entry) => sum + toNumber(entry.count, 0), 0)
            : Math.max(0, totalInChest - willPullTotal)
          const pulledCount = Math.max(0, Math.min(
            willPullTotal,
            Math.max(maxWindowHave, observedHave, countInventoryItems(bot, blockName)) - haveAtStart
          ))
          if (pulledCount > 0 && typeof options.onMaterialPulled === 'function') {
            try {
              options.onMaterialPulled({
                blockName,
                pulledCount,
                beforeChestTotal: totalInChest,
                afterChestTotal: totalAfterPull,
                chest: { x: spot.x, y: spot.y, z: spot.z },
                groupIndex,
                groupSize: Array.isArray(spotGroups[groupIndex]) ? spotGroups[groupIndex].length : null,
                spotIndex
              })
            } catch { }
          }
          if (container) {
            try { container.close() } catch { }
            container = null
          }
          const expectedReadyCount = Math.min(
            desiredItemCount,
            haveAtStart + willPullTotal,
            Math.max(maxWindowHave, countInventoryItems(bot, blockName))
          )
          const ready = await waitForRestockInventoryReady(
            bot,
            config,
            blockName,
            haveAtStart,
            expectedReadyCount,
            maxWindowHave > countInventoryItems(bot, blockName) ? 'window-confirmed' : 'inventory-confirmed'
          )
          if (ready) return true
          if (attemptStrategy === 'nerv-window' && sameChestAttempt < sameChestSyncRetries) {
            forceSafeRestock = true
            retrySameChest = true
            skipRetryCatchupWait = true
            console.log(`[RESTOCK-FALLBACK] ${blockName} nerv-window final sync failed; reopening same chest with safe strategy.`)
          } else {
            return false
          }
        }

          if (stoppedForInventorySync) {
            retrySameChest = sameChestAttempt < sameChestSyncRetries
            if (config.errorHandling?.logErrors !== false) {
              const haveNow = countInventoryItems(bot, blockName)
              const nextAction = retrySameChest
                ? `Closing stale chest window and polling same chest retry for up to ${sameChestRetryDelayMs}ms.`
                : 'Trying next chest/replan.'
              console.log(`[RESTOCK-WARN] ${blockName} withdraws did not reach inventory after sync wait; have=${haveNow} target=${targetCount}. ${nextAction}`)
            }
          }
        } catch (err) {
          const message = String(err?.message || err)
          if (message.includes('Could not open container') || message.includes('open-container-timeout') || message.includes('No block at') || message.includes('Unexpected block at')) {
            console.log(`[RESTOCK-WARN] Could not open chest for ${blockName} at ${spot.x},${spot.y},${spot.z}: ${message}`)
          } else if (config.advanced?.debugPrints) {
            console.log(`[RESTOCK-DEBUG] ${blockName} @ ${spot.x},${spot.z}: ${message}`)
          }
        } finally {
          if (container) {
            try { container.close() } catch { }
          }
        }

        if (!retrySameChest) {
          break
        }

        if (skipRetryCatchupWait) {
          sameChestAttempt += 1
          continue
        }

        const haveAfterRetryWait = await waitForInventoryCountChangeOrTarget(
          bot,
          blockName,
          retryStartHave,
          Math.min(desiredItemCount, retryTargetCount || desiredItemCount),
          sameChestRetryDelayMs,
          sameChestRetryPollMs,
          sameChestRetrySettleMs
        )
        if (haveAfterRetryWait >= desiredItemCount || haveAfterRetryWait >= retryTargetCount) {
          restockFailureCache.delete(blockName)
          unavailableMaterialCache.delete(blockName)
          return await waitForRestockInventoryReady(
            bot,
            config,
            blockName,
            retryStartHave,
            Math.min(desiredItemCount, retryTargetCount || desiredItemCount),
            'same-chest-retry'
          )
        }
        if (haveAfterRetryWait > retryStartHave && config.errorHandling?.logErrors !== false) {
          console.log(`[RESTOCK-WARN] ${blockName} inventory caught up after chest retry wait: have=${haveAfterRetryWait} target=${desiredItemCount}. Reopening same chest to finish remaining deficit.`)
        }
        sameChestAttempt += 1
      }
    }
  }

  const haveAfterRestock = countInventoryItems(bot, blockName)
  if (haveAfterRestock > haveBeforeRestock) {
    console.log(`[RESTOCK-WARN] Partial restock for ${blockName}: have=${haveAfterRestock} target=${desiredItemCount}.`)
    return false
  }

  restockFailureCache.set(blockName, Date.now())
  if (options.markUnavailableOnFailure !== false) unavailableMaterialCache.add(blockName)
  return false
}

function shouldWaitForRequiredMaterialRestock(config) {
  return config?.advanced?.waitForRequiredMaterialRestockEnabled !== false
}

function getRequiredMaterialTargetCount(bot, blockName, requestedPulls = 1, neededByBlock = null) {
  const have = countInventoryItems(bot, blockName)
  if (neededByBlock instanceof Map && neededByBlock.has(blockName)) {
    return Math.max(0, toNumber(neededByBlock.get(blockName), have))
  }
  const stackSize = Math.max(1, toNumber(bot?.registry?.itemsByName?.[blockName]?.stackSize, 64))
  return have + (Math.max(1, toNumber(requestedPulls, 1)) * stackSize)
}

async function waitInterruptiblyForRequiredMaterial(bot, config, waitMs, detail = 'waiting-material-restock') {
  const deadline = Date.now() + Math.max(0, toNumber(waitMs, 0))
  while (Date.now() < deadline) {
    assertRuntimeContinue(bot, config, detail)
    await delay(Math.min(500, Math.max(1, deadline - Date.now())))
  }
}

async function scanDuperGroupForRepairCheck(bot, config, entry, reason = 'duper-repair-check') {
  const blockName = String(entry?.blockName || '').trim()
  const itemId = bot?.registry?.itemsByName?.[blockName]?.id
  const chests = Array.isArray(entry?.chests) ? entry.chests : []
  if (!blockName || !itemId || !chests.length) return null

  const advanced = config.advanced || {}
  const scanned = []
  let total = 0
  for (const chest of chests) {
    assertRuntimeContinue(bot, config, 'waiting-material-restock')
    let container = null
    try {
      container = await openContainerAt(bot, chest, chest.accessPosition, {
        config,
        reason: `${reason}-${blockName}`,
        strictAccess: Boolean(chest.accessPosition),
        accessRange: toNumber(advanced.restockChestAccessRange, 1.25),
        attempts: toNumber(advanced.restockChestOpenAttempts, 3),
        timeoutMs: toNumber(advanced.restockChestOpenTimeoutMs, 2500),
        retryDelayMs: toNumber(advanced.restockChestOpenRetryDelayMs, 250),
        blockWaitMs: toNumber(advanced.restockChestBlockWaitMs, 5000),
        blockPollMs: toNumber(advanced.restockChestBlockPollMs, 150),
        expectedNames: ['chest', 'trapped_chest', 'barrel']
      })
      await delay(toNumber(advanced.preRestockDelayMs, 200))
      const count = container.containerItems()
        .filter((item) => item.type === itemId)
        .reduce((sum, item) => sum + toNumber(item.count, 0), 0)
      total += count
      scanned.push({ x: chest.x, y: chest.y, z: chest.z, count })
    } catch (err) {
      console.log(`[DUPER-REPAIR-CHECK-WARN] ${blockName} chest=${chest.x},${chest.y},${chest.z} scan failed: ${err?.message || err}`)
      return null
    } finally {
      if (container) {
        try { container.close() } catch { }
      }
    }
  }
  return { blockName, total, scanned, fullGroupScanned: scanned.length === chests.length }
}

async function checkDuePersistedBrokenDuperGroup(bot, config, currentBlockName = null) {
  const advanced = config.advanced || {}
  const intervalMs = Math.max(60 * 1000, toNumber(advanced.duperBrokenRepairCheckMs, DEFAULT_DUPER_BROKEN_REPAIR_CHECK_MS))
  const alertAfterMs = Math.max(0, toNumber(advanced.duperBrokenAlertAfterMs, DEFAULT_DUPER_BROKEN_ALERT_AFTER_MS))
  if (alertAfterMs <= 0) return

  const state = loadDuperGroupStateFile(config)
  const now = Date.now()
  const entries = Object.entries(state.groups)
    .map(([key, entry]) => ({ key, entry }))
    .filter(({ entry }) => entry && (entry.status === 'broken' || entry.alertActive === true))
    .filter(({ entry }) => String(entry.blockName || '') !== String(currentBlockName || ''))
    .filter(({ entry }) => now - toTimestampMs(entry.lastCheckedAt, 0) >= intervalMs)
  if (!entries.length) return

  const { key, entry } = entries[0]
  const scan = await scanDuperGroupForRepairCheck(bot, config, entry)
  const latestState = loadDuperGroupStateFile(config)
  const latestEntry = latestState.groups[key] || entry
  const checkedAt = new Date().toISOString()
  if (!scan || !scan.fullGroupScanned) {
    latestState.groups[key] = {
      ...latestEntry,
      lastCheckedAt: checkedAt,
      lastCheckedBy: bot?.username || config?.bot?.username || null
    }
    saveDuperGroupStateFile(config, latestState)
    return
  }

  const blockName = scan.blockName
  const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[blockName]?.stackSize, 64))
  const capacity = Math.max(1, scan.scanned.length * 27 * stackSize)
  const fullRatio = Math.max(0, Math.min(1, toNumber(advanced.duperBrokenFullRatio, 0.9)))
  const fullEnough = fullRatio > 0 && scan.total >= Math.floor(capacity * fullRatio)
  const previousTotal = Number.isFinite(Number(latestEntry.lastObservedTotal)) ? Number(latestEntry.lastObservedTotal) : null
  const refilled = previousTotal == null || scan.total > previousTotal || fullEnough
  if (refilled) {
    latestState.groups[key] = {
      ...latestEntry,
      lastObservedTotal: scan.total,
      lastPreviousTotal: previousTotal,
      lastObservedAt: checkedAt,
      noIncreaseSinceAt: null,
      pendingBrokenSinceAt: null,
      lastUsefulActivityAt: checkedAt,
      lastPullAt: null,
      lastPulledCount: 0,
      lastCapacity: capacity,
      lastFullEnough: fullEnough,
      status: 'healthy',
      alertActive: false,
      lastCheckedAt: checkedAt,
      lastCheckedBy: bot?.username || config?.bot?.username || null,
      repairCheckedBy: bot?.username || config?.bot?.username || null,
      repairCheckedAt: checkedAt
    }
    saveDuperGroupStateFile(config, latestState)
    console.log(`[DUPER-FIXED] ${blockName} group=${toNumber(latestEntry.groupIndex, 0) + 1} refilled during repair check; total=${scan.total} previous=${previousTotal ?? 'none'}.`)
    reportDashboardWarning(config, 'duper-fixed', `Duper fixed: ${blockName} group ${toNumber(latestEntry.groupIndex, 0) + 1} refilled.`, {
      blockName,
      groupIndex: latestEntry.groupIndex,
      total: scan.total,
      previousTotal,
      checkedAt
    })
    if (!hasPersistedBrokenDuperGroups(config)) clearDashboardAlert(config, 'duper-broken')
    return
  }

  latestState.groups[key] = {
    ...latestEntry,
    lastObservedTotal: scan.total,
    lastPreviousTotal: previousTotal,
    lastObservedAt: checkedAt,
    lastCapacity: capacity,
    lastFullEnough: fullEnough,
    status: 'broken',
    alertActive: true,
    lastCheckedAt: checkedAt,
    lastCheckedBy: bot?.username || config?.bot?.username || null
  }
  saveDuperGroupStateFile(config, latestState)
  setDashboardAlert(config, 'duper-broken', `Duper may be broken: ${blockName} group ${toNumber(latestEntry.groupIndex, 0) + 1} still has no refill; repair needed.`, {
    blockName,
    groupIndex: latestEntry.groupIndex,
    currentTotal: scan.total,
    previousTotal,
    checkedAt,
    source: 'duper-repair-check'
  }, 'warn')
}

async function waitForRequiredMaterialRestock(bot, config, blockName, requestedPulls = 1, neededByBlock = null, reason = 'required-material', options = {}) {
  assertRuntimeContinue(bot, config, 'waiting-material-restock')
  const advanced = config.advanced || {}
  if (!shouldWaitForRequiredMaterialRestock(config)) {
    return await restockMaterial(bot, config, blockName, requestedPulls, neededByBlock)
  }

  const spotGroups = getMaterialChestGroupsForRefill(bot, config, blockName)
  const spots = spotGroups.flat()
  if (!spots.length || !bot?.registry?.itemsByName?.[blockName]?.id) {
    return await restockMaterial(bot, config, blockName, requestedPulls, neededByBlock)
  }

  const retryMs = Math.max(250, toNumber(advanced.waitForRequiredMaterialRetryMs, 5000))
  const logEveryMs = Math.max(1000, toNumber(advanced.waitForRequiredMaterialLogEveryMs, 30000))
  const timeoutMs = Math.max(0, toNumber(advanced.waitForRequiredMaterialTimeoutMs, 0))
  const duperBrokenAlertAfterMs = Math.max(0, toNumber(advanced.duperBrokenAlertAfterMs, DEFAULT_DUPER_BROKEN_ALERT_AFTER_MS))
  const duperBrokenFullRatio = Math.max(0, Math.min(1, toNumber(advanced.duperBrokenFullRatio, 0.9)))
  const startedAt = Date.now()
  const targetCount = getRequiredMaterialTargetCount(bot, blockName, requestedPulls, neededByBlock)
  const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[blockName]?.stackSize, 64))
  const materialIsCarpet = String(blockName || '').endsWith('_carpet')
  let attempt = 0
  const scanGroupByChestKey = new Map()
  for (let groupIndex = 0; groupIndex < spotGroups.length; groupIndex += 1) {
    for (const spot of spotGroups[groupIndex]) {
      const key = materialChestPositionKey(spot)
      if (key) scanGroupByChestKey.set(key, groupIndex)
    }
  }
  const groupSignature = spotGroups
    .map((group) => group.map((spot) => materialChestPositionKey(spot)).filter(Boolean).join(','))
    .join(';')
  const groupStateKeys = spotGroups.map((group) => getDuperGroupStateKey(blockName, group))
  const cacheKey = `${bot?.username || config?.bot?.username || 'bot'}|${blockName}|${groupSignature}`
  const cachedGroupState = duperBrokenGroupStateCache.get(cacheKey)
  const persistedDuperState = materialIsCarpet && duperBrokenAlertAfterMs > 0
    ? loadDuperGroupStateFile(config)
    : { version: 1, updatedAt: new Date().toISOString(), groups: {} }
  const groupStates = spotGroups.map((group, groupIndex) => {
    const persisted = persistedDuperState.groups[groupStateKeys[groupIndex]]
    const cached = cachedGroupState?.groupSignature === groupSignature ? cachedGroupState.groupStates?.[groupIndex] : null
    const source = persisted || cached || {}
    return {
      ...source,
      groupIndex,
      stateKey: groupStateKeys[groupIndex],
      chests: group.map((spot) => ({ x: spot.x, y: spot.y, z: spot.z, accessPosition: spot.accessPosition || null })),
      noIncreaseSinceAt: toTimestampMs(source.noIncreaseSinceAt, 0),
      pendingBrokenSinceAt: toTimestampMs(source.pendingBrokenSinceAt, 0),
      lastUsefulActivityAt: toTimestampMs(source.lastUsefulActivityAt, 0),
      lastPullAt: toTimestampMs(source.lastPullAt, 0),
      lastPulledCount: Math.max(0, toNumber(source.lastPulledCount, 0)),
      lastObservedAt: toTimestampMs(source.lastObservedAt, 0),
      lastObservedTotal: Number.isFinite(Number(source.lastObservedTotal)) ? Number(source.lastObservedTotal) : null,
      lastPreviousTotal: Number.isFinite(Number(source.lastPreviousTotal)) ? Number(source.lastPreviousTotal) : null,
      lastCapacity: Math.max(1, group.length) * 27 * stackSize,
      lastFullEnough: source.lastFullEnough === true,
      activeBroken: source.activeBroken === true || source.alertActive === true || source.status === 'broken',
      status: source.status || 'unknown',
      alertActive: source.alertActive === true
    }
  })
  const activeBrokenGroups = new Set(groupStates.filter((group) => group.activeBroken).map((group) => group.groupIndex))
  let duperBrokenAlertActive = activeBrokenGroups.size > 0

  const persistDuperBrokenGroupState = () => {
    if (!materialIsCarpet || duperBrokenAlertAfterMs <= 0) return
    const fileState = loadDuperGroupStateFile(config)
    duperBrokenGroupStateCache.set(cacheKey, {
      blockName,
      groupSignature,
      lastTouchedAt: Date.now(),
      groupStates: groupStates.map((group) => ({
        groupIndex: group.groupIndex,
        chests: group.chests,
        noIncreaseSinceAt: group.noIncreaseSinceAt,
        pendingBrokenSinceAt: group.pendingBrokenSinceAt,
        lastUsefulActivityAt: group.lastUsefulActivityAt,
        lastPullAt: group.lastPullAt,
        lastPulledCount: group.lastPulledCount,
        lastObservedAt: group.lastObservedAt,
        lastObservedTotal: group.lastObservedTotal,
        lastPreviousTotal: group.lastPreviousTotal,
        lastCapacity: group.lastCapacity,
        lastFullEnough: group.lastFullEnough,
        activeBroken: group.activeBroken
      }))
    })
    for (const group of groupStates) {
      if (!group.stateKey) continue
      const noIncreaseSinceAt = group.noIncreaseSinceAt ? new Date(group.noIncreaseSinceAt).toISOString() : null
      const pendingBrokenSinceAt = group.pendingBrokenSinceAt ? new Date(group.pendingBrokenSinceAt).toISOString() : null
      const lastUsefulActivityAt = group.lastUsefulActivityAt ? new Date(group.lastUsefulActivityAt).toISOString() : null
      const lastPullAt = group.lastPullAt ? new Date(group.lastPullAt).toISOString() : null
      const lastObservedAt = group.lastObservedAt ? new Date(group.lastObservedAt).toISOString() : null
      fileState.groups[group.stateKey] = {
        version: 1,
        blockName,
        groupIndex: group.groupIndex,
        stateKey: group.stateKey,
        chests: group.chests,
        lastObservedTotal: group.lastObservedTotal,
        lastPreviousTotal: group.lastPreviousTotal,
        lastObservedAt,
        noIncreaseSinceAt,
        pendingBrokenSinceAt,
        lastUsefulActivityAt,
        lastPullAt,
        lastPulledCount: Math.max(0, toNumber(group.lastPulledCount, 0)),
        lastCapacity: group.lastCapacity,
        lastFullEnough: group.lastFullEnough,
        status: group.activeBroken ? 'broken' : (group.pendingBrokenSinceAt ? 'confirming' : (group.noIncreaseSinceAt ? 'suspect' : 'healthy')),
        alertActive: group.activeBroken === true,
        lastCheckedBy: bot?.username || config?.bot?.username || null,
        lastCheckedAt: new Date().toISOString()
      }
    }
    saveDuperGroupStateFile(config, fileState)
  }

  const updateDuperBrokenAlert = (have, elapsedMs) => {
    const groups = [...activeBrokenGroups]
      .map((groupIndex) => groupStates[groupIndex])
      .filter(Boolean)
      .map((group) => ({
        blockName,
        groupIndex: group.groupIndex,
        chests: group.chests,
        noIncreaseSinceAt: group.noIncreaseSinceAt ? new Date(group.noIncreaseSinceAt).toISOString() : null,
        noIncreaseMs: group.noIncreaseSinceAt ? Date.now() - group.noIncreaseSinceAt : elapsedMs,
        lastUsefulActivityAt: group.lastUsefulActivityAt ? new Date(group.lastUsefulActivityAt).toISOString() : null,
        lastPullAt: group.lastPullAt ? new Date(group.lastPullAt).toISOString() : null,
        lastPulledCount: group.lastPulledCount || 0,
        currentTotal: group.lastObservedTotal,
        previousTotal: group.lastPreviousTotal,
        capacity: group.lastCapacity,
        fullEnough: group.lastFullEnough
      }))

    if (!groups.length) {
      clearDuperBrokenAlertIfNeeded()
      return
    }

    const groupLabel = groups.map((group) => `group ${group.groupIndex + 1}`).join(', ')
    const message = `Duper may be broken: ${blockName} ${groupLabel} saw no refill for ${Math.round(duperBrokenAlertAfterMs / 60000)}m; repair needed.`
    const details = {
      blockName,
      reason,
      elapsedMs,
      targetCount,
      have,
      chestCount: spots.length,
      groupCount: spotGroups.length,
      fullRatio: duperBrokenFullRatio,
      groups,
      attempt
    }
    setDashboardAlert(config, 'duper-broken', message, details, 'warn')
    duperBrokenAlertActive = true
    reportDashboardWarning(config, 'duper-broken', message, details)
  }

  const noteUsefulDuperActivity = (group, now, fields = {}) => {
    group.noIncreaseSinceAt = 0
    group.pendingBrokenSinceAt = 0
    group.lastUsefulActivityAt = now
    if (toNumber(fields.pullCount, 0) > 0) {
      group.lastPullAt = now
      group.lastPulledCount = Math.max(0, toNumber(fields.pullCount, 0))
    }
  }

  const clearDuperBrokenAlertIfNeeded = () => {
    if (activeBrokenGroups.size > 0) return
    if (hasPersistedBrokenDuperGroups(config)) return
    if (!duperBrokenAlertActive) return
    clearDashboardAlert(config, 'duper-broken')
    duperBrokenAlertActive = false
  }

  const markBrokenAfterConfirmation = (group, groupIndex, noIncreaseMs, currentTotal, previousTotal, haveAfter, groupSize) => {
    const now = Date.now()
    if (!group.pendingBrokenSinceAt) {
      group.pendingBrokenSinceAt = now
      if (config.advanced?.debugPrints) {
        console.log(`[DUPER-BROKEN-CONFIRM] ${blockName} group=${groupIndex + 1} needs one more full scan before alert; noIncrease=${Math.round(noIncreaseMs / 1000)}s total=${currentTotal} previous=${previousTotal ?? 'none'}.`)
      }
      return false
    }
    group.activeBroken = true
    activeBrokenGroups.add(groupIndex)
    console.log(`[DUPER-BROKEN-WARN] ${blockName} group=${groupIndex + 1} confirmed no refill after ${Math.round(noIncreaseMs / 1000)}s across ${groupSize} chest(s); total=${currentTotal} previous=${previousTotal ?? 'none'} have=${haveAfter} target=${targetCount} reason=${reason}.`)
    return true
  }

  const noteMaterialObserved = (observation = {}) => {
    const groupIndex = Number.isFinite(Number(observation.groupIndex)) ? Number(observation.groupIndex) : null
    if (config.advanced?.debugPrints) {
      const groupText = groupIndex == null ? '' : ` group=${groupIndex + 1}`
      console.log(`[REQUIRED-MATERIAL-WAIT-OBSERVED] ${blockName}${groupText} count=${observation.count ?? 'unknown'} chest=${observation.chest ? `${observation.chest.x},${observation.chest.y},${observation.chest.z}` : 'unknown'}`)
    }
  }

  while (true) {
    assertRuntimeContinue(bot, config, 'waiting-material-restock')
    attempt += 1
    if (materialIsCarpet && duperBrokenAlertAfterMs > 0) {
      await checkDuePersistedBrokenDuperGroup(bot, config, blockName)
    }
    const attemptGroupScans = spotGroups.map(() => ({ total: 0, scanned: new Set(), chests: [], pulledCount: 0, pulledChests: [] }))
    const haveBefore = countInventoryItems(bot, blockName)
    if (haveBefore >= targetCount) {
      activeBrokenGroups.clear()
      clearDuperBrokenAlertIfNeeded()
      return true
    }

    config.__dashboardRuntime?.setStatusDetail?.('waiting-material-restock')
    restockFailureCache.delete(blockName)
    unavailableMaterialCache.delete(blockName)
    const restocked = await restockMaterial(bot, config, blockName, requestedPulls, neededByBlock, {
      ignoreFailureCooldown: true,
      markUnavailableOnFailure: false,
      onMaterialChestScanned: (scan = {}) => {
        const chestKey = materialChestPositionKey(scan.chest)
        const groupIndex = chestKey && scanGroupByChestKey.has(chestKey)
          ? scanGroupByChestKey.get(chestKey)
          : (Number.isFinite(Number(scan.groupIndex)) ? Number(scan.groupIndex) : null)
        const groupScan = groupIndex == null ? null : attemptGroupScans[groupIndex]
        if (!groupScan) return
        if (chestKey) groupScan.scanned.add(chestKey)
        groupScan.total += Math.max(0, toNumber(scan.count, 0))
        if (scan.chest) groupScan.chests.push({ x: scan.chest.x, y: scan.chest.y, z: scan.chest.z, count: Math.max(0, toNumber(scan.count, 0)) })
      },
      onMaterialObserved: noteMaterialObserved,
      onMaterialPulled: (pull = {}) => {
        const chestKey = materialChestPositionKey(pull.chest)
        const groupIndex = chestKey && scanGroupByChestKey.has(chestKey)
          ? scanGroupByChestKey.get(chestKey)
          : (Number.isFinite(Number(pull.groupIndex)) ? Number(pull.groupIndex) : null)
        const groupScan = groupIndex == null ? null : attemptGroupScans[groupIndex]
        if (!groupScan) return
        const pulledCount = Math.max(0, toNumber(pull.pulledCount, 0))
        groupScan.pulledCount += pulledCount
        if (pull.chest) {
          groupScan.pulledChests.push({
            x: pull.chest.x,
            y: pull.chest.y,
            z: pull.chest.z,
            pulledCount,
            beforeChestTotal: Math.max(0, toNumber(pull.beforeChestTotal, 0)),
            afterChestTotal: Math.max(0, toNumber(pull.afterChestTotal, 0))
          })
        }
      }
    })
    const haveAfter = countInventoryItems(bot, blockName)
    if (haveAfter > haveBefore && config.advanced?.debugPrints) {
      console.log(`[REQUIRED-MATERIAL-WAIT-OBSERVED] ${blockName} inventoryIncrease=${haveAfter - haveBefore}`)
    }
    const elapsedMs = Date.now() - startedAt
    if (materialIsCarpet && duperBrokenAlertAfterMs > 0) {
      let changedBrokenGroups = false
      for (let groupIndex = 0; groupIndex < attemptGroupScans.length; groupIndex += 1) {
        const scan = attemptGroupScans[groupIndex]
        const groupSize = Array.isArray(spotGroups[groupIndex]) ? spotGroups[groupIndex].length : 0
        const fullGroupScanned = groupSize > 0 && scan.scanned.size >= groupSize
        const group = groupStates[groupIndex]
        const now = Date.now()
        if (Math.max(0, toNumber(scan.pulledCount, 0)) > 0) {
          noteUsefulDuperActivity(group, now, { pullCount: scan.pulledCount })
          group.lastObservedAt = now
          if (group.activeBroken) {
            group.activeBroken = false
            activeBrokenGroups.delete(groupIndex)
            changedBrokenGroups = true
          }
          if (config.advanced?.debugPrints) {
            console.log(`[DUPER-GROUP-PULL] ${blockName} group=${groupIndex + 1} pulled=${scan.pulledCount}; treating as useful activity.`)
          }
          if (!fullGroupScanned) continue
        }
        if (!fullGroupScanned) continue

        const currentTotal = Math.max(0, toNumber(scan.total, 0))
        const previousTotal = group.lastObservedTotal
        const capacity = Math.max(1, groupSize * 27 * stackSize)
        const fullEnough = duperBrokenFullRatio > 0 && currentTotal >= Math.floor(capacity * duperBrokenFullRatio)
        group.lastCapacity = capacity
        group.lastFullEnough = fullEnough

        if (previousTotal == null) {
          group.lastObservedTotal = currentTotal
          group.lastPreviousTotal = currentTotal
          group.lastObservedAt = now
          if (!fullEnough) group.noIncreaseSinceAt = startedAt
          if (config.advanced?.debugPrints) {
            console.log(`[DUPER-GROUP-SCAN] ${blockName} group=${groupIndex + 1} total=${currentTotal} last=none chests=${groupSize}`)
          }
        }

        if (Math.max(0, toNumber(scan.pulledCount, 0)) > 0) {
          noteUsefulDuperActivity(group, now, { pullCount: scan.pulledCount })
          group.lastObservedAt = now
          group.lastPreviousTotal = previousTotal == null ? currentTotal : previousTotal
          group.lastObservedTotal = currentTotal
          continue
        }

        if (fullEnough) {
          noteUsefulDuperActivity(group, now)
          group.lastObservedAt = Date.now()
          group.lastPreviousTotal = previousTotal
          group.lastObservedTotal = currentTotal
          if (group.activeBroken) {
            group.activeBroken = false
            activeBrokenGroups.delete(groupIndex)
            changedBrokenGroups = true
          }
          if (config.advanced?.debugPrints) {
            console.log(`[DUPER-GROUP-FULL] ${blockName} group=${groupIndex + 1} total=${currentTotal}/${capacity} ratio=${duperBrokenFullRatio}`)
          }
          continue
        }

        if (previousTotal != null && currentTotal > previousTotal) {
          noteUsefulDuperActivity(group, now)
          group.lastObservedAt = now
          group.lastPreviousTotal = previousTotal
          group.lastObservedTotal = currentTotal
          if (group.activeBroken) {
            group.activeBroken = false
            activeBrokenGroups.delete(groupIndex)
            changedBrokenGroups = true
          }
          if (config.advanced?.debugPrints) {
            console.log(`[DUPER-GROUP-REFILL] ${blockName} group=${groupIndex + 1} total=${currentTotal} last=${previousTotal} chests=${groupSize}`)
          }
          continue
        }

        if (previousTotal != null && currentTotal < previousTotal) {
          if (!group.noIncreaseSinceAt) group.noIncreaseSinceAt = now
          group.lastObservedAt = now
          group.lastPreviousTotal = previousTotal
          group.lastObservedTotal = currentTotal
          const noIncreaseMs = now - group.noIncreaseSinceAt
          if (config.advanced?.debugPrints) {
            console.log(`[DUPER-GROUP-DECREASE] ${blockName} group=${groupIndex + 1} total=${currentTotal} last=${previousTotal} noIncrease=${Math.round(noIncreaseMs / 1000)}s`)
          }
          if (noIncreaseMs >= duperBrokenAlertAfterMs && !group.activeBroken) {
            changedBrokenGroups = markBrokenAfterConfirmation(group, groupIndex, noIncreaseMs, currentTotal, previousTotal, haveAfter, groupSize) || changedBrokenGroups
          }
          continue
        }

        if (!group.noIncreaseSinceAt) group.noIncreaseSinceAt = now
        group.lastObservedAt = now
        group.lastPreviousTotal = previousTotal == null ? currentTotal : previousTotal
        group.lastObservedTotal = currentTotal
        const noIncreaseMs = now - group.noIncreaseSinceAt
        if (config.advanced?.debugPrints) {
          console.log(`[DUPER-GROUP-SCAN] ${blockName} group=${groupIndex + 1} total=${currentTotal} last=${previousTotal} noIncrease=${Math.round(noIncreaseMs / 1000)}s chests=${groupSize}`)
        }
        if (noIncreaseMs >= duperBrokenAlertAfterMs && !group.activeBroken) {
          changedBrokenGroups = markBrokenAfterConfirmation(group, groupIndex, noIncreaseMs, currentTotal, previousTotal, haveAfter, groupSize) || changedBrokenGroups
        }
      }
      persistDuperBrokenGroupState()
      if (changedBrokenGroups || activeBrokenGroups.size > 0) updateDuperBrokenAlert(haveAfter, elapsedMs)
    }

    if (restocked || haveAfter >= targetCount) {
      restockFailureCache.delete(blockName)
      unavailableMaterialCache.delete(blockName)
      if (activeBrokenGroups.size === 0) {
        clearDuperBrokenAlertIfNeeded()
      } else {
        persistDuperBrokenGroupState()
      }
      return true
    }

    const capacityAfter = inventoryCapacityForItem(bot, blockName)
    if (capacityAfter < stackSize) {
      if (options.logCapacityBlocked !== false) {
        console.log(`[REQUIRED-MATERIAL-WAIT-CAPACITY] ${blockName} blocked by inventory capacity; have=${haveAfter} target=${targetCount} capacity=${capacityAfter}/${stackSize} reason=${reason}.`)
      }
      persistDuperBrokenGroupState()
      return false
    }

    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      console.log(`[REQUIRED-MATERIAL-WAIT-WARN] ${blockName} timed out after ${Math.round((Date.now() - startedAt) / 1000)}s; have=${haveAfter} target=${targetCount} reason=${reason}.`)
      persistDuperBrokenGroupState()
      return false
    }

    logThrottled(
      `required-material-wait-${blockName}`,
      `[REQUIRED-MATERIAL-WAIT] ${blockName} unavailable after full chest scan attempt=${attempt}; have=${haveAfter} target=${targetCount}; retrying all ${spots.length} configured chest(s) in ${retryMs}ms. reason=${reason}`,
      { intervalMs: logEveryMs }
    )
    await waitInterruptiblyForRequiredMaterial(bot, config, retryMs, 'waiting-material-restock')
  }
}

function nearestPosition(bot, positions) {
  if (!Array.isArray(positions) || !positions.length) return null
  let best = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const pos of positions) {
    if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y) || !Number.isFinite(pos?.z)) continue
    const dx = bot.entity.position.x - (pos.x + 0.5)
    const dz = bot.entity.position.z - (pos.z + 0.5)
    const dist2 = dx * dx + dz * dz
    if (dist2 < bestDist) {
      bestDist = dist2
      best = pos
    }
  }
  return best
}

function nearestEntryByPosition(bot, entries, getPosition) {
  if (!Array.isArray(entries) || !entries.length) return null
  let best = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    const pos = getPosition(entry)
    if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y) || !Number.isFinite(pos?.z)) continue
    const dist2 = horizontalDist2(bot, pos)
    if (dist2 < bestDist) {
      bestDist = dist2
      best = entry
    }
  }
  return best
}

function normalizeAngleDegrees(deg) {
  let value = Number(deg)
  if (!Number.isFinite(value)) return null
  value = value % 360
  if (value > 180) value -= 360
  if (value < -180) value += 360
  return value
}

function minecraftYawPitchToMineflayerRadians(yawDeg, pitchDeg, advanced = {}) {
  const yaw = normalizeAngleDegrees(advanced.dumpYawInvert === true ? -yawDeg : yawDeg)
  const pitch = Number.isFinite(pitchDeg) ? Math.max(-90, Math.min(90, Number(pitchDeg))) : null
  if (yaw === null || pitch === null) return null

  const finalPitch = advanced.dumpPitchInvert === true ? -pitch : pitch
  return {
    yawRad: Math.PI - (yaw * Math.PI / 180),
    pitchRad: -(finalPitch * Math.PI / 180),
    yawDeg: yaw,
    pitchDeg: finalPitch
  }
}

function buildDumpStations(config) {
  const machine = config.machine || {}
  const stations = []

  const multi = Array.isArray(machine.dumpStations) ? machine.dumpStations : []
  for (const entry of multi) {
    const pos = entry?.position || entry?.pos
    if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y) || !Number.isFinite(pos?.z)) continue
    stations.push({
      position: {
        x: Number(pos.x),
        y: Number(pos.y),
        z: Number(pos.z)
      },
      yaw: Number.isFinite(entry?.yaw) ? Number(entry.yaw) : null,
      pitch: Number.isFinite(entry?.pitch) ? Number(entry.pitch) : null
    })
  }

  const single = machine.dumpStation
  const singlePos = single?.position
  if (single?.enabled && Number.isFinite(singlePos?.x) && Number.isFinite(singlePos?.y) && Number.isFinite(singlePos?.z)) {
    stations.push({
      position: {
        x: Number(singlePos.x),
        y: Number(singlePos.y),
        z: Number(singlePos.z)
      },
      yaw: Number.isFinite(single?.yaw) ? Number(single.yaw) : null,
      pitch: Number.isFinite(single?.pitch) ? Number(single.pitch) : null
    })
  }

  const unique = []
  const seen = new Set()
  for (const station of stations) {
    const key = `${station.position.x}|${station.position.y}|${station.position.z}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(station)
  }

  return unique
}

function stopMovementControls(bot) {
  const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint']
  for (const control of controls) {
    bot.setControlState(control, false)
  }
}

function getPrinterSprintMode(config) {
  return String(config?.printer?.sprintMode || 'notPlacing').toLowerCase()
}

function configurePathfinderMovements(bot, config, options = {}) {
  ensureUsableEntityState(bot, config, 'configure-pathfinder', { allowPlatformSeed: false, log: false })
  const printer = config.printer || {}
  const allowJump = printer.allowJump !== false
  const allowSprint = options.allowSprint != null
    ? options.allowSprint === true
    : getPrinterSprintMode(config) !== 'off'
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = allowJump
  movements.allowSprinting = allowSprint
  movements.canSprint = allowSprint
  bot.pathfinder.setMovements(movements)
  return movements
}

async function gotoWithTemporaryThinkTimeout(bot, goal, timeoutMs) {
  ensureUsableEntityState(bot, null, 'goto-think-timeout', { allowPlatformSeed: false, log: false })
  const pathfinderApi = bot.pathfinder || {}
  const previous = pathfinderApi.thinkTimeout
  if (Number.isFinite(timeoutMs)) {
    pathfinderApi.thinkTimeout = Number.isFinite(previous) ? Math.max(previous, timeoutMs) : timeoutMs
  }

  try {
    await pathfinderApi.goto(goal)
  } finally {
    if (Number.isFinite(previous)) {
      pathfinderApi.thinkTimeout = previous
    }
  }
}

async function gotoGoalWithHardTimeout(bot, goal, timeoutMs, label = 'path', options = {}) {
  const limitMs = Math.max(1000, toNumber(timeoutMs, 30000))
  const pollMs = Math.max(100, toNumber(options.pollMs, 250))
  const config = options.config || bot.__nervConfig || null
  const shouldPauseTimeout = typeof options.shouldPauseTimeout === 'function'
    ? options.shouldPauseTimeout
    : null
  const isGoalSatisfied = typeof options.isGoalSatisfied === 'function'
    ? options.isGoalSatisfied
    : null
  let timeoutId = null
  try {
    await applyAdaptiveLatencyBackoff(bot, config, `${label}-before-goto`, { pauseMovement: true })
    const gotoPromise = bot.pathfinder.goto(goal)
    gotoPromise.catch(() => {})
    await Promise.race([
      gotoPromise,
      new Promise((resolve, reject) => {
        let activeElapsedMs = 0
        let lastCheckAt = Date.now()
        timeoutId = setInterval(() => {
          const now = Date.now()
          const elapsed = now - lastCheckAt
          lastCheckAt = now

          let paused = false
          try {
            paused = shouldPauseTimeout ? shouldPauseTimeout() === true : false
          } catch {
            paused = false
          }

          if (isGoalSatisfied) {
            try {
              if (isGoalSatisfied()) {
                try { bot.pathfinder?.stop?.() } catch { }
                try { bot.pathfinder?.setGoal?.(null) } catch { }
                resolve()
                return
              }
            } catch { }
          }

          if (paused) return

          activeElapsedMs += elapsed
          if (activeElapsedMs < limitMs) return

          if (isGoalSatisfied) {
            try {
              if (isGoalSatisfied()) {
                try { bot.pathfinder?.stop?.() } catch { }
                try { bot.pathfinder?.setGoal?.(null) } catch { }
                resolve()
                return
              }
            } catch { }
          }

          try { bot.pathfinder?.stop?.() } catch { }
          try { bot.pathfinder?.setGoal?.(null) } catch { }
          reject(new Error(`${label}-timeout-${limitMs}ms`))
        }, pollMs)
      })
    ])
  } finally {
    if (timeoutId) clearInterval(timeoutId)
  }
}

async function walkStraightToPointWithHardTimeout(bot, point, range, timeoutMs, label = 'straight-walk', options = {}) {
  const limitMs = Math.max(1000, toNumber(timeoutMs, 30000))
  const tickMs = Math.max(25, toNumber(options.tickMs, 50))
  const targetRange = Math.max(0.1, toNumber(range, 0.8))
  const sprint = options.sprint === true
  const jump = options.jump === true
  const config = options.config || {}
  const shouldPauseTimeout = typeof options.shouldPauseTimeout === 'function'
    ? options.shouldPauseTimeout
    : null
  const isGoalSatisfied = typeof options.isGoalSatisfied === 'function'
    ? options.isGoalSatisfied
    : () => distanceToPoint(bot?.entity?.position, point) <= targetRange
  const Vec3 = bot?.entity?.position?.constructor
  let activeElapsedMs = 0
  let lastCheckAt = Date.now()

  try {
    try { bot.pathfinder?.stop?.() } catch { }
    try { bot.pathfinder?.setGoal?.(null) } catch { }
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    bot.setControlState('jump', jump)

    while (isBotSessionLive(bot)) {
      assertRuntimeContinue(bot, config, `${label}-runtime-stop`)
      if (isGoalSatisfied()) return

      const now = Date.now()
      const elapsed = now - lastCheckAt
      lastCheckAt = now

      let paused = false
      try {
        paused = shouldPauseTimeout ? shouldPauseTimeout() === true : false
      } catch {
        paused = false
      }

      if (paused) {
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        await delay(tickMs)
        continue
      }

      const latencyState = getLatencyBackoffState(bot, config)
      if (latencyState.shouldPause) {
        stopLagSensitiveMovement(bot)
        await applyAdaptiveLatencyBackoff(bot, config, `${label}-movement-pause`, { pauseMovement: true })
        continue
      }

      activeElapsedMs += elapsed
      if (activeElapsedMs >= limitMs) {
        throw new Error(`${label}-timeout-${limitMs}ms`)
      }

      const pos = bot?.entity?.position
      if (Vec3 && pos) {
        try {
          await bot.lookAt(new Vec3(Number(point.x), Number(pos.y) + 1.62, Number(point.z)), true)
        } catch { }
      }
      bot.setControlState('sprint', sprint && !latencyState.shouldDisableSprint)
      bot.setControlState('forward', true)
      await delay(tickMs)
      if (latencyState.delayMs > 0) {
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        await delay(Math.min(latencyState.settings.movementPauseMaxMs, latencyState.delayMs))
      }
    }

    throw new Error(`${label}-session-ended`)
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    bot.setControlState('jump', false)
  }
}

function currentMultiBotName(config) {
  return config.multiUser?.runtime?.assignment?.name || config.bot?.username || 'single-bot'
}

async function withMultiDumpLock(config, action) {
  if (config.multiUser?.runtime?.enabled !== true) {
    return await action()
  }

  const syncFolder = resolveMultiSyncFolder(config)
  fs.mkdirSync(syncFolder, { recursive: true })
  const lockFile = path.join(syncFolder, 'dump_lock.json')
  const owner = currentMultiBotName(config)
  const staleMs = Math.max(5000, toNumber(config.advanced?.multiDumpLockStaleMs, 30000))
  const pollMs = 250
  let lockHandle = null
  let lastLogAt = 0

  while (!lockHandle) {
    try {
      lockHandle = fs.openSync(lockFile, 'wx')
      fs.writeFileSync(lockHandle, JSON.stringify({ owner, timestampMs: Date.now() }), 'utf8')
      break
    } catch (err) {
      const state = readOptionalJson(lockFile)
      const age = Number.isFinite(state?.timestampMs) ? Date.now() - state.timestampMs : Number.POSITIVE_INFINITY
      if (age > staleMs) {
        try { fs.unlinkSync(lockFile) } catch { }
        continue
      }
      if (Date.now() - lastLogAt > 5000) {
        lastLogAt = Date.now()
        console.log(`[MULTI-DUMP] ${owner} waiting for dump lock held by ${state?.owner || 'unknown'}.`)
      }
      await delay(pollMs)
    }
  }

  try {
    return await action()
  } finally {
    if (lockHandle) {
      try { fs.closeSync(lockHandle) } catch { }
    }
    try {
      const state = readOptionalJson(lockFile)
      if (!state || state.owner === owner) fs.unlinkSync(lockFile)
    } catch { }
  }
}

async function maintainDumpAim(bot, config, station) {
  const aim = minecraftYawPitchToMineflayerRadians(station?.yaw, station?.pitch, config.advanced || {})
  if (!aim) return

  if (typeof bot.pathfinder?.stop === 'function') {
    bot.pathfinder.stop()
  }
  if (typeof bot.pathfinder?.setGoal === 'function') {
    bot.pathfinder.setGoal(null)
  }

  stopMovementControls(bot)

  const settleMs = toNumber(config.advanced?.dumpAimSettleMs, 180)

  await bot.look(aim.yawRad, aim.pitchRad, true)
  await delay(settleMs)
  await bot.look(aim.yawRad, aim.pitchRad, true)
}

async function reachDumpStation(bot, config, station, range = 0.5) {
  const stationPos = station?.position
  if (!stationPos) return false

  const dumpAlreadyNearRange = Math.max(range, toNumber(config.advanced?.dumpAlreadyNearRange, 4))
  const dumpGoalRange = Math.max(range, toNumber(config.advanced?.dumpGoalRange, dumpAlreadyNearRange))
  const dist = bot.entity.position.distanceTo(new bot.entity.position.constructor(Number(stationPos.x), Number(stationPos.y), Number(stationPos.z)))
  if (dist <= dumpAlreadyNearRange) {
    await maintainDumpAim(bot, config, station)
    return true
  }

  const dumpPathThinkTimeoutMs = Math.max(1000, toNumber(config.advanced?.dumpPathThinkTimeoutMs, 3000))
  await gotoWithTemporaryThinkTimeout(bot, new GoalNear(Number(stationPos.x), Number(stationPos.y), Number(stationPos.z), dumpGoalRange), dumpPathThinkTimeoutMs)
  await maintainDumpAim(bot, config, station)
  return true
}

async function withdrawFromChest(bot, config, chestPos, itemName, amount, accessPosition) {
  const itemId = bot.registry.itemsByName[itemName]?.id
  if (!itemId) return false

  const requested = Math.max(1, toNumber(amount, 1))
  const before = countInventoryByType(bot, itemName)
  const timeoutMs = getLatencyAdjustedTimeoutMs(bot, config, Math.max(500, toNumber(config.advanced?.postPrintChestSyncWaitMs, 2500)), 500)
  const pollMs = Math.max(50, toNumber(config.advanced?.postPrintChestPollMs, 100))
  const actionDelayMs = Math.max(50, toNumber(config.advanced?.inventoryActionDelayMs, 100))
  const interactionDelayMs = Math.max(50, toNumber(config.advanced?.postPrintInteractionDelayMs, 200))
  let container = null

  try {
    container = await openContainerAt(bot, chestPos, accessPosition)
    await delay(interactionDelayMs)

    let taken = 0
    while (taken < requested) {
      const ok = await takeOneChestItemToInventory(bot, container, itemId, itemName, timeoutMs, pollMs)
      if (!ok) break
      taken += 1
      await delay(actionDelayMs)
    }

    try { container.close() } catch { }
    container = null
    const after = await waitForInventoryCountChangeOrTarget(
      bot,
      itemName,
      before,
      before + requested,
      timeoutMs,
      pollMs,
      actionDelayMs
    )
    await delay(interactionDelayMs)
    return after >= before + requested
  } catch (err) {
    if (config.advanced?.debugPrints) {
      console.log(`[POSTPRINT-DEBUG] withdraw ${itemName} -> ${err?.message || err}`)
    }
    return false
  } finally {
    if (container) {
      try { container.close() } catch { }
    }
  }
}

async function withdrawItemStacksFromChests(bot, config, chests, itemName, desiredItems, options = {}) {
  const itemId = bot.registry.itemsByName[itemName]?.id
  if (!itemId) return 0

  const itemInfo = bot.registry.itemsByName[itemName] || {}
  const stackSize = Math.max(1, toNumber(itemInfo.stackSize, 64))
  const timeoutMs = getLatencyAdjustedTimeoutMs(bot, config, Math.max(500, toNumber(options.timeoutMs, toNumber(config.advanced?.postPrintChestSyncWaitMs, 2500))), 500)
  const pollMs = Math.max(50, toNumber(options.pollMs, toNumber(config.advanced?.postPrintChestPollMs, 100)))
  const interactionDelayMs = Math.max(50, toNumber(config.advanced?.postPrintInteractionDelayMs, 200))
  const sortedChests = [...chests].sort((a, b) => horizontalDist2(bot, a.position) - horizontalDist2(bot, b.position))
  const before = countInventoryByType(bot, itemName)
  const capacity = inventoryCapacityForItem(bot, itemName)
  let remaining = Math.min(Math.max(1, toNumber(desiredItems, stackSize)), capacity)

  if (remaining <= 0) return 0

  for (const chest of sortedChests) {
    assertRuntimeContinue(bot, config, 'stopping-during-xp-chest-withdraw')
    if (remaining <= 0) break
    let container = null
    try {
      container = await openContainerAt(bot, chest.position, chest.accessPosition)
      await delay(interactionDelayMs)
      const moved = await quickMoveChestItemStacks(bot, container, itemId, remaining, stackSize, Math.max(1, Math.ceil(remaining / stackSize)), {
        onlyFullStacks: false,
        timeoutMs,
        pollMs
      })
      remaining -= Math.max(0, toNumber(moved?.itemsMoved, moved?.movedEstimate || 0))
    } catch (err) {
      console.log(`[POSTPRINT-WARN] Could not withdraw ${itemName} from XP chest at ${chest.position.x} ${chest.position.y} ${chest.position.z}: ${err?.message || err}`)
    } finally {
      if (container) {
        try { container.close() } catch { }
      }
    }
  }

  const targetMin = before + 1
  const latest = await waitForInventoryCountChangeOrTarget(
    bot,
    itemName,
    before,
    targetMin,
    timeoutMs,
    pollMs,
    Math.max(50, toNumber(config.advanced?.inventoryActionDelayMs, 100))
  )
  return Math.max(0, latest - before)
}

async function depositToChest(bot, config, chestPos, itemName, amount, accessPosition) {
  const itemId = bot.registry.itemsByName[itemName]?.id
  if (!itemId) return false

  const requested = Math.max(1, toNumber(amount, 1))
  const before = countInventoryByType(bot, itemName)
  const timeoutMs = getLatencyAdjustedTimeoutMs(bot, config, Math.max(500, toNumber(config.advanced?.postPrintChestSyncWaitMs, 2500)), 500)
  const pollMs = Math.max(50, toNumber(config.advanced?.postPrintChestPollMs, 100))
  const actionDelayMs = Math.max(50, toNumber(config.advanced?.inventoryActionDelayMs, 100))
  const interactionDelayMs = Math.max(50, toNumber(config.advanced?.postPrintInteractionDelayMs, 200))
  let container = null

  try {
    container = await openContainerAt(bot, chestPos, accessPosition)
    await delay(interactionDelayMs)

    let moved = 0
    while (moved < requested) {
      const slot = findWindowInventorySlot(container, bot, itemName)
      if (slot < 0) break
      const stack = container.slots?.[slot]
      const count = Math.max(1, toNumber(stack?.count, 1))
      await bot.clickWindow(slot, 0, 1)
      await waitForWindowSlot(container, slot, (entry) => (
        !entry ||
        toNumber(entry.count, 0) <= 0 ||
        entry.type !== itemId ||
        toNumber(entry.count, 0) < count
      ), timeoutMs, pollMs)
      moved += count
      await delay(actionDelayMs)
    }

    try { container.close() } catch { }
    container = null

    const targetRemaining = Math.max(0, before - requested)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && countInventoryByType(bot, itemName) > targetRemaining) {
      await delay(pollMs)
    }
    await delay(interactionDelayMs)
    return moved > 0 && countInventoryByType(bot, itemName) <= targetRemaining
  } catch (err) {
    if (config.advanced?.debugPrints) {
      console.log(`[POSTPRINT-DEBUG] deposit ${itemName} -> ${err?.message || err}`)
    }
    return false
  } finally {
    if (container) {
      try { container.close() } catch { }
    }
  }
}

function getLivePlatformStatus(bot, config) {
  const pos = bot?.entity?.position
  const classification = classifySpatialPosition(pos, config)
  return {
    pos,
    classification,
    platform: classification?.platform === true || (isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config))
  }
}

function assertLivePlatformReady(bot, config, reason = 'platform-action') {
  if (!isBotSessionLive(bot)) {
    throw new Error(`${reason} blocked: bot session is not live`)
  }
  if (config?.advanced?.platformWatchdogEnabled === false || getPlatformBounds(config) == null) return
  const status = getLivePlatformStatus(bot, config)
  if (status.platform) return
  throw new Error(`${reason} blocked: live position is not on printer platform (state=${status.classification?.state || 'unknown'} p=${JSON.stringify(status.pos || null)})`)
}

function closeCurrentWindowIfOpen(bot, reason = 'window-reset') {
  const window = bot?.currentWindow
  if (!window || typeof window.close !== 'function') return
  try {
    window.close()
    console.log(`[WINDOW-RESET] Closed stale open window before ${reason}.`)
  } catch { }
}

function assertNearPoint(bot, point, maxDistance, reason = 'position-check') {
  const dist = distanceToPoint(bot?.entity?.position, point)
  if (dist <= maxDistance) return
  throw new Error(`${reason}: bot is ${dist.toFixed(2)} blocks from required access point ${JSON.stringify(point)} at ${formatBotPosition(bot)}`)
}

async function gotoConfiguredAccess(bot, position, accessPosition, range = 2, config = null, reason = 'configured-access', options = {}) {
  const goalPos = accessPosition || position
  if (!goalPos) throw new Error('Missing configured access position')
  if (config) assertLivePlatformReady(bot, config, `${reason}:pre-goto`)
  const strict = options.strict === true
  const goalRange = Math.max(0.1, Number(range))
  const readyDistance = strict ? Math.max(0.35, goalRange) : Math.max(2.25, goalRange)
  if (distanceToPoint(bot?.entity?.position, goalPos) <= readyDistance) {
    if (strict) assertNearPoint(bot, goalPos, readyDistance, `${reason}:access-ready`)
    return
  }
  const gotoPromise = bot.pathfinder.goto(new GoalNear(goalPos.x, goalPos.y, goalPos.z, goalRange))
  gotoPromise.catch(() => {})
  await gotoPromise
  if (config) assertLivePlatformReady(bot, config, `${reason}:post-goto`)
  if (strict) assertNearPoint(bot, goalPos, readyDistance, `${reason}:post-goto-access`)
}

async function waitForBlockAt(bot, position, options = {}) {
  const Vec3 = bot.entity.position.constructor
  const blockPos = new Vec3(position.x, position.y, position.z)
  const timeoutMs = Math.max(500, toNumber(options.timeoutMs, 10000))
  const pollMs = Math.max(50, toNumber(options.pollMs, 200))
  const expectedNames = Array.isArray(options.expectedNames) ? options.expectedNames.filter(Boolean) : []
  const deadline = Date.now() + timeoutMs
  let latest = null

  while (Date.now() <= deadline) {
    latest = bot.blockAt(blockPos)
    if (latest && (!expectedNames.length || expectedNames.includes(latest.name))) return latest
    if (typeof bot.waitForChunksToLoad === 'function') {
      try { await bot.waitForChunksToLoad() } catch { }
    }
    await delay(pollMs)
  }

  if (!latest) throw new Error(`No block at ${position.x} ${position.y} ${position.z}`)
  if (expectedNames.length) {
    throw new Error(`Unexpected block at ${position.x} ${position.y} ${position.z}: ${latest.name}, expected=${expectedNames.join('|')}`)
  }
  return latest
}

async function openBlockWindowAt(bot, position, accessPosition, options = {}) {
  const config = options.config || null
  const reason = options.reason || 'open-block-window'
  const accessRange = Math.max(0.1, toNumber(options.accessRange, 2))
  const strictAccess = options.strictAccess === true
  if (config) assertLivePlatformReady(bot, config, `${reason}:pre-open`)
  await gotoConfiguredAccess(bot, position, accessPosition, accessRange, config, reason, { strict: strictAccess })
  if (config) assertLivePlatformReady(bot, config, `${reason}:at-access`)
  if (strictAccess && (accessPosition || position)) {
    assertNearPoint(bot, accessPosition || position, Math.max(0.35, accessRange), `${reason}:strict-access`)
  }
  const block = await waitForBlockAt(bot, position, {
    timeoutMs: options.blockWaitMs,
    pollMs: options.blockPollMs,
    expectedNames: options.expectedNames
  })
  if (config) {
    await applyAdaptiveLatencyBackoff(bot, config, `${reason}-before-open-block`, { pauseMovement: true })
  }
  return await bot.openBlock(block)
}

async function openAnvilAt(bot, position, accessPosition, config = null) {
  const Vec3 = bot.entity.position.constructor
  const blockPos = new Vec3(position.x, position.y, position.z)
  await gotoConfiguredAccess(bot, position, accessPosition, 2, config, 'open-anvil')
  const block = bot.blockAt(blockPos)
  if (!block) throw new Error(`No anvil at ${position.x} ${position.y} ${position.z}`)
  if (config) await applyAdaptiveLatencyBackoff(bot, config, 'open-anvil-before-open', { pauseMovement: true })
  return await bot.openAnvil(block)
}

function isAnvilBlockName(name) {
  return name === 'anvil' || name === 'chipped_anvil' || name === 'damaged_anvil'
}

function countAnvilPillar(bot, position, maxCount = 16) {
  if (!position) return { count: 0, loaded: false }
  const Vec3 = bot.entity.position.constructor
  const limit = Math.max(1, Math.floor(toNumber(maxCount, 16)))
  let count = 0
  let loaded = true

  for (let offset = 0; offset < limit; offset += 1) {
    const block = bot.blockAt(new Vec3(position.x, position.y + offset, position.z))
    if (!block) {
      loaded = false
      break
    }
    if (!isAnvilBlockName(block.name)) break
    count += 1
  }

  return { count, loaded }
}

function warnIfAnvilPillarLow(bot, config, anvilConfig, reason = 'anvil-check') {
  const advanced = config.advanced || {}
  const required = Math.max(0, Math.floor(toNumber(advanced.anvilPillarMinCount, 3)))
  if (required <= 0 || !anvilConfig?.enabled || !anvilConfig?.position) return null

  const result = countAnvilPillar(bot, anvilConfig.position, advanced.anvilPillarScanLimit)
  if (result.count < required) {
    const message = result.loaded
      ? `Anvil pillar is low: ${result.count}/${required} anvil(s) available.`
      : `Anvil pillar could not be fully checked: ${result.count}/${required} anvil(s) visible.`
    console.log(`[ANVIL-WARN] ${reason}: ${message}`)
    reportDashboardWarning(config, 'anvil-supply', message, {
      reason,
      count: result.count,
      required,
      loaded: result.loaded,
      position: anvilConfig.position
    })
  }

  return result
}

function findWindowInventorySlot(window, bot, itemName) {
  const itemId = bot.registry.itemsByName[itemName]?.id
  const start = Number.isFinite(window.inventoryStart) ? window.inventoryStart : 0
  const end = Number.isFinite(window.inventoryEnd) ? window.inventoryEnd : window.slots.length - 1
  for (let i = start; i <= end; i++) {
    const stack = window.slots[i]
    if (!stack || stack.count <= 0) continue
    if (itemId && stack.type === itemId) return i
    if (stack.name === itemName) return i
  }
  return -1
}

async function moveWindowItem(bot, fromSlot, toSlot) {
  await bot.clickWindow(fromSlot, 0, 0)
  await bot.clickWindow(toSlot, 0, 0)
}

async function moveWindowItemConfirmed(bot, window, fromSlot, toSlot, predicate, timeoutMs = 3000, pollMs = 100) {
  await bot.clickWindow(fromSlot, 0, 0)
  await delay(pollMs)
  await bot.clickWindow(toSlot, 0, 0)
  return await waitForWindowSlot(window, toSlot, predicate, timeoutMs, pollMs)
}

async function waitBotTicks(bot, ticks = 4) {
  const count = Math.max(1, Math.floor(toNumber(ticks, 4)))
  if (typeof bot?.waitForTicks === 'function') {
    await bot.waitForTicks(count)
    return
  }
  await delay(count * 50)
}

function getWindowCursorItem(window) {
  return window?.selectedItem || null
}

async function waitForWindowCursorState(window, predicate, timeoutMs = 3000, pollMs = 100) {
  const timeout = Math.max(100, toNumber(timeoutMs, 3000))
  const poll = Math.max(25, toNumber(pollMs, 100))
  let elapsed = 0
  while (elapsed <= timeout) {
    const cursor = getWindowCursorItem(window)
    if (predicate(cursor)) return cursor
    await delay(poll)
    elapsed += poll
  }
  return getWindowCursorItem(window)
}

async function waitForWindowCursorEmpty(window, timeoutMs = 3000, pollMs = 100) {
  const cursor = await waitForWindowCursorState(window, (item) => !item || toNumber(item.count, 0) <= 0, timeoutMs, pollMs)
  return !cursor || toNumber(cursor.count, 0) <= 0
}

async function assertWindowCursorEmpty(window, reason = 'window-click') {
  if (await waitForWindowCursorEmpty(window, 1500, 50)) return
  const cursor = getWindowCursorItem(window)
  throw new Error(`${reason}: cursor not empty (${cursor?.name || cursor?.displayName || cursor?.type || 'unknown'}x${toNumber(cursor?.count, 0)})`)
}

async function safeWindowClick(bot, window, slot, mouseButton = 0, mode = 0, options = {}) {
  const precondition = options.precondition || 'empty'
  const ticks = Math.max(1, toNumber(options.ticks, 4))
  if (precondition === 'empty') {
    await assertWindowCursorEmpty(window, `before click slot=${slot}`)
  }
  await applyAdaptiveLatencyBackoff(bot, bot.__nervConfig, `window-click-slot-${slot}`)
  await bot.clickWindow(slot, mouseButton, mode)
  await waitBotTicks(bot, ticks)
}

async function moveOneWindowItemConfirmed(bot, window, fromSlot, toSlot, predicate, timeoutMs = 3000, pollMs = 100, clickTicks = 4) {
  const sourceStack = window?.slots?.[fromSlot]
  const sourceCount = toNumber(sourceStack?.count, 0)
  if (sourceCount <= 0) return false

  await assertWindowCursorEmpty(window, `before moving slot ${fromSlot} to ${toSlot}`)
  if (sourceCount <= 1) {
    await safeWindowClick(bot, window, fromSlot, 0, 0, { precondition: 'empty', ticks: clickTicks })
    await safeWindowClick(bot, window, toSlot, 0, 0, { precondition: 'any', ticks: clickTicks })
    await assertWindowCursorEmpty(window, `after moving slot ${fromSlot} to ${toSlot}`)
  } else {
    await safeWindowClick(bot, window, fromSlot, 0, 0, { precondition: 'empty', ticks: clickTicks })
    await safeWindowClick(bot, window, toSlot, 1, 0, { precondition: 'any', ticks: clickTicks })
    await safeWindowClick(bot, window, fromSlot, 0, 0, { precondition: 'any', ticks: clickTicks })
    await assertWindowCursorEmpty(window, `after moving one item from slot ${fromSlot} to ${toSlot}`)
  }

  return await waitForWindowSlot(window, toSlot, predicate, timeoutMs, pollMs)
}

async function quickMoveWindowSlotConfirmed(bot, window, fromSlot, targetSlot, predicate, timeoutMs = 3000, pollMs = 100, clickTicks = 2) {
  const adjustedTimeoutMs = getLatencyAdjustedTimeoutMs(bot, bot.__nervConfig, timeoutMs, timeoutMs)
  await assertWindowCursorEmpty(window, `before quick-moving slot ${fromSlot}`)
  await applyAdaptiveLatencyBackoff(bot, bot.__nervConfig, `quick-move-slot-${fromSlot}`)
  await bot.clickWindow(fromSlot, 0, 1)
  await waitBotTicks(bot, clickTicks)
  await assertWindowCursorEmpty(window, `after quick-moving slot ${fromSlot}`)
  return await waitForWindowSlot(window, targetSlot, predicate, adjustedTimeoutMs, pollMs)
}

async function quickMoveCartographyInputConfirmed(bot, window, sourceSlot, targetSlot, itemName, timeoutMs = 3000, pollMs = 100, clickTicks = 2) {
  const sourceStack = window?.slots?.[sourceSlot]
  const sourceBefore = toNumber(sourceStack?.count, 0)
  if (!sourceStack || sourceBefore <= 0) {
    throw new Error(`Cannot quick-move ${itemName}: source slot ${sourceSlot} is empty.`)
  }

  console.log(`[CARTO-NERV] quick-move-input item=${itemName} from=${sourceSlot} to=${targetSlot} before=${formatCartographyWindowState(window)}`)
  const targetReady = await quickMoveWindowSlotConfirmed(
    bot,
    window,
    sourceSlot,
    targetSlot,
    (stack) => stack?.name === itemName && toNumber(stack.count, 0) > 0,
    timeoutMs,
    pollMs,
    clickTicks
  )
  const sourceChanged = await waitForWindowSlot(window, sourceSlot, (stack) => (
    !stack ||
    stack.name !== sourceStack.name ||
    toNumber(stack.count, 0) < sourceBefore
  ), timeoutMs, pollMs)
  console.log(`[CARTO-NERV] quick-move-input-done item=${itemName} ready=${Boolean(targetReady)} sourceChanged=${Boolean(sourceChanged)} after=${formatCartographyWindowState(window)}`)
  return Boolean(targetReady)
}

async function quickMoveCartographyOutputConfirmed(bot, window, beforeCount, timeoutMs = 3000, pollMs = 100, clickTicks = 2) {
  const outputStack = window?.slots?.[2]
  if (!outputStack || outputStack.name !== 'filled_map' || toNumber(outputStack.count, 0) <= 0) {
    return false
  }
  const itemId = outputStack.type
  console.log(`[CARTO-NERV] quick-move-output from=2 beforeWindowFilled=${beforeCount} before=${formatCartographyWindowState(window)}`)
  await assertWindowCursorEmpty(window, 'before quick-moving cartography output')
  await bot.clickWindow(2, 0, 1)
  await waitBotTicks(bot, clickTicks)
  await assertWindowCursorEmpty(window, 'after quick-moving cartography output')

  const outputCleared = await waitForWindowSlotEmpty(window, 2, timeoutMs, pollMs)
  const afterCount = await waitForWindowInventoryCount(window, itemId, 'filled_map', beforeCount + 1, timeoutMs, pollMs)
  console.log(`[CARTO-NERV] quick-move-output-done outputCleared=${outputCleared} afterWindowFilled=${afterCount} target=${beforeCount + 1} after=${formatCartographyWindowState(window)}`)
  return outputCleared && afterCount > beforeCount
}

async function reclaimWindowSlotToInventory(bot, window, slot, timeoutMs = 2000, pollMs = 100) {
  const stack = window?.slots?.[slot]
  if (!stack || toNumber(stack.count, 0) <= 0) return true
  const targetSlot = findEmptyWindowInventorySlot(window)
  if (targetSlot < 0) return false
  await moveOneWindowItemConfirmed(bot, window, slot, targetSlot, (target) => target && target.name === stack.name, timeoutMs, pollMs)
  return await waitForWindowSlotEmpty(window, slot, timeoutMs, pollMs)
}

async function reclaimCartographyInputs(bot, window, timeoutMs = 2000, pollMs = 100) {
  const paneReclaimed = await reclaimWindowSlotToInventory(bot, window, 1, timeoutMs, pollMs)
  const mapReclaimed = await reclaimWindowSlotToInventory(bot, window, 0, timeoutMs, pollMs)
  return paneReclaimed && mapReclaimed
}

function getChestWindowSlots(window) {
  const inventoryStart = Number.isFinite(window?.inventoryStart) ? window.inventoryStart : 0
  const slots = []
  for (let i = 0; i < inventoryStart; i += 1) {
    const stack = window?.slots?.[i]
    if (!stack || toNumber(stack.count, 0) <= 0) continue
    slots.push({ slot: i, stack })
  }
  return slots
}

function materialChestPositionKey(pos) {
  const blockPos = toBlockPos(pos)
  if (!blockPos) return null
  return `${blockPos.x}:${blockPos.y}:${blockPos.z}`
}

function getAssignedMaterialChestAllowedNames(config, chestPos, fallbackName = null) {
  const targetKey = materialChestPositionKey(chestPos)
  const allowed = new Set()
  const materialDict = config.machine?.materialDict || {}

  if (targetKey) {
    for (const [materialName, entries] of Object.entries(materialDict)) {
      const normalizedName = String(materialName || '').replace(/^minecraft:/, '')
      if (!normalizedName || !Array.isArray(entries)) continue
      for (const entry of entries) {
        if (materialChestPositionKey(entry) === targetKey) {
          allowed.add(normalizedName)
          break
        }
      }
    }
  }

  const fallback = String(fallbackName || '').replace(/^minecraft:/, '')
  if (!allowed.size && fallback) allowed.add(fallback)
  return allowed
}

function summarizeStacks(stacks) {
  const counts = new Map()
  for (const stack of stacks) {
    const name = stack?.name || stack?.displayName || String(stack?.type || 'unknown')
    counts.set(name, (counts.get(name) || 0) + Math.max(0, toNumber(stack?.count, 0)))
  }
  return [...counts.entries()].map(([name, count]) => `${name}x${count}`).join(', ')
}

async function quickMoveChestSlotToInventory(bot, config, window, entry, timeoutMs = 3000, pollMs = 100) {
  const stack = entry?.stack
  const slot = entry?.slot
  const itemName = stack?.name || null
  const itemId = stack?.type
  const beforeCount = Math.max(0, toNumber(stack?.count, 0))
  if (!Number.isFinite(slot) || !stack || beforeCount <= 0 || !itemName) return 0
  if (inventoryCapacityForItem(bot, itemName) < beforeCount) return 0

  const beforeInventory = countWindowInventoryItems(window, itemId, itemName)
  await assertWindowCursorEmpty(window, `before assigned chest cleanup slot=${slot}`)
  await applyAdaptiveLatencyBackoff(bot, config, `assigned-chest-cleanup-slot-${slot}`)
  await bot.clickWindow(slot, 0, 1)
  await waitForWindowSlot(window, slot, (latest) => (
    !latest ||
    toNumber(latest.count, 0) <= 0 ||
    latest.type !== itemId ||
    toNumber(latest.count, 0) < beforeCount
  ), timeoutMs, pollMs)
  await assertWindowCursorEmpty(window, `after assigned chest cleanup slot=${slot}`)

  const afterStack = window?.slots?.[slot]
  const afterCount = afterStack?.type === itemId ? Math.max(0, toNumber(afterStack.count, 0)) : 0
  const movedFromSource = Math.max(0, beforeCount - afterCount)
  const afterInventory = await waitForWindowInventoryCount(
    window,
    itemId,
    itemName,
    beforeInventory + Math.max(1, movedFromSource),
    timeoutMs,
    pollMs
  )
  return Math.max(movedFromSource, Math.max(0, afterInventory - beforeInventory))
}

async function cleanAssignedMaterialChest(bot, config, window, chestPos, targetName, targetItemId) {
  const advanced = config.advanced || {}
  if (advanced.cleanAssignedMaterialChests === false) return { reopen: false, removed: [] }

  const allowedNames = getAssignedMaterialChestAllowedNames(config, chestPos, targetName)
  if (!allowedNames.size) return { reopen: false, removed: [] }

  const maxStacks = Math.max(0, Math.floor(toNumber(advanced.cleanAssignedMaterialChestMaxStacksPerOpen, 8)))
  if (maxStacks <= 0) return { reopen: false, removed: [] }

  const unwanted = getChestWindowSlots(window)
    .filter((entry) => {
      const stack = entry.stack
      if (!stack || toNumber(stack.count, 0) <= 0) return false
      if (targetItemId && stack.type === targetItemId) return false
      return !allowedNames.has(String(stack.name || '').replace(/^minecraft:/, ''))
    })
    .slice(0, maxStacks)

  if (!unwanted.length) return { reopen: false, removed: [] }

  const timeoutMs = getLatencyAdjustedTimeoutMs(
    bot,
    config,
    Math.max(500, toNumber(advanced.assignedMaterialChestCleanupSyncWaitMs, toNumber(advanced.restockInventorySyncWaitMs, 2000))),
    500
  )
  const pollMs = Math.max(25, toNumber(advanced.assignedMaterialChestCleanupPollMs, toNumber(advanced.restockSameChestRetryPollMs, 100)))
  const removed = []

  for (const entry of unwanted) {
    assertRuntimeContinue(bot, config, 'stopping-during-assigned-chest-cleanup')
    const stack = entry.stack
    const moved = await quickMoveChestSlotToInventory(bot, config, window, entry, timeoutMs, pollMs)
    if (moved <= 0) {
      console.log(`[CHEST-CLEANUP-WARN] ${targetName}: could not remove ${formatWindowStack(stack)} from assigned chest; inventory may be full.`)
      break
    }
    removed.push({ name: stack.name, type: stack.type, count: moved })
    await delay(Math.max(0, toNumber(advanced.inventoryActionDelayMs, 100)))
  }

  if (removed.length > 0) {
    console.log(`[CHEST-CLEANUP] ${targetName}: removed unwanted ${summarizeStacks(removed)} from assigned chest ${chestPos.x},${chestPos.y},${chestPos.z}; allowed=${[...allowedNames].join(',')}`)
  }

  return { reopen: removed.length > 0, removed }
}

function countChestWindowItems(window, itemId, itemName = null) {
  return getChestWindowSlots(window)
    .filter((entry) => (itemId && entry.stack?.type === itemId) || (itemName && entry.stack?.name === itemName))
    .reduce((sum, entry) => sum + toNumber(entry.stack?.count, 0), 0)
}

function getChestWindowSnapshotFingerprint(window) {
  const inventoryStart = Number.isFinite(window?.inventoryStart) ? window.inventoryStart : 0
  const slots = getChestWindowSlots(window)
  return `${window?.id ?? ''}:${inventoryStart}:` + slots
    .map((entry) => `${entry.slot}:${entry.stack?.type ?? ''}:${entry.stack?.name ?? ''}:${toNumber(entry.stack?.count, 0)}`)
    .join('|')
}

async function waitForChestWindowSnapshotConfirmed(bot, window, config, itemId, itemName, label) {
  const advanced = config.advanced || {}
  const baseTimeoutMs = Math.max(500, toNumber(advanced.supportStockChestSyncWaitMs, toNumber(advanced.postPrintChestSyncWaitMs, 2500)))
  const timeoutMs = getLatencyAdjustedTimeoutMs(bot, config, baseTimeoutMs, baseTimeoutMs)
  const pollMs = Math.max(25, toNumber(advanced.supportStockChestPollMs, toNumber(advanced.postPrintChestPollMs, 100)))
  const latencyState = getLatencyBackoffState(bot, config)
  const minStableMs = Math.max(100, toNumber(advanced.supportStockChestStableMs, 350), latencyState.level === 'normal' ? 0 : Math.min(1500, Math.max(350, latencyState.delayMs)))
  const openedAt = Date.now()
  const deadline = openedAt + timeoutMs
  let lastFingerprint = null
  let stableSince = 0
  let latestCount = 0
  let latestSlots = 0

  while (Date.now() <= deadline) {
    latestCount = countChestWindowItems(window, itemId, itemName)
    latestSlots = getChestWindowSlots(window).length
    const fingerprint = getChestWindowSnapshotFingerprint(window)
    if (fingerprint === lastFingerprint) {
      if (!stableSince) stableSince = Date.now()
    } else {
      lastFingerprint = fingerprint
      stableSince = Date.now()
    }

    if (Number.isFinite(window?.inventoryStart) && stableSince && Date.now() - stableSince >= minStableMs) {
      return {
        count: latestCount,
        slots: latestSlots,
        confirmed: true,
        durationMs: Date.now() - openedAt
      }
    }

    await delay(pollMs)
  }

  console.log(`[SUPPORT-STOCK-WARN] ${label} chest window did not produce a stable server snapshot within ${timeoutMs}ms; using latest window state. ping=${latencyState.pingMs == null ? 'unknown' : `${latencyState.pingMs}ms`}`)
  return {
    count: latestCount,
    slots: latestSlots,
    confirmed: false,
    durationMs: Date.now() - openedAt
  }
}

function normalizeMachineChestList(...sources) {
  const result = []
  const seen = new Set()
  for (const source of sources) {
    const entries = Array.isArray(source) ? source : [source]
    for (const entry of entries) {
      if (!entry) continue
      if (entry.enabled === false) continue
      const position = toBlockPos(entry.position || entry)
      if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y) || !Number.isFinite(position?.z)) continue
      const accessPosition = toOpenPos(entry) || toOpenPos(entry.position) || null
      const key = `${position.x}:${position.y}:${position.z}:${accessPosition?.x ?? ''}:${accessPosition?.y ?? ''}:${accessPosition?.z ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ position, accessPosition })
    }
  }
  return result
}

async function countItemAcrossChests(bot, config, itemName, chests, label) {
  const itemId = getItemId(bot, itemName)
  if (!itemId) {
    reportSupportStockWarning(config, `Unknown support stock item ${itemName}; cannot check ${label}.`, { item: itemName, label })
    return { count: 0, checked: 0, failed: chests.length }
  }

  let count = 0
  let checked = 0
  let failed = 0
  const failures = []
  for (const chest of chests) {
    assertRuntimeContinue(bot, config, 'stopping-during-stock-check')
    let container = null
    try {
      try {
        container = await openContainerAt(bot, chest.position, chest.accessPosition, {
          config,
          reason: `support-stock-${itemName}`,
          accessRange: toNumber(config.advanced?.supportStockChestAccessRange, chest.accessPosition ? 1.25 : 2),
          attempts: toNumber(config.advanced?.supportStockChestOpenAttempts, 3),
          timeoutMs: toNumber(config.advanced?.supportStockChestOpenTimeoutMs, 2500)
        })
      } catch (err) {
        if (!chest.accessPosition) throw err
        console.log(`[SUPPORT-STOCK-WARN] Could not check ${label} chest from configured access position; retrying chest block directly: ${err?.message || err}`)
        container = await openContainerAt(bot, chest.position, null, {
          config,
          reason: `support-stock-${itemName}-fallback`,
          accessRange: toNumber(config.advanced?.supportStockChestFallbackAccessRange, 2),
          attempts: toNumber(config.advanced?.supportStockChestOpenAttempts, 3),
          timeoutMs: toNumber(config.advanced?.supportStockChestOpenTimeoutMs, 2500)
        })
      }
      const snapshot = await waitForChestWindowSnapshotConfirmed(bot, container, config, itemId, itemName, label)
      count += snapshot.count
      checked += 1
      if (config.advanced?.debugPrints) {
        console.log(`[SUPPORT-STOCK-DEBUG] ${label} chest confirmed=${snapshot.confirmed} slots=${snapshot.slots} count=${snapshot.count} duration=${snapshot.durationMs}ms`)
      }
    } catch (err) {
      failed += 1
      failures.push({
        position: chest.position,
        message: String(err?.message || err)
      })
    } finally {
      if (container) {
        try { container.close() } catch { }
      }
    }
  }

  return { count, checked, failed, failures }
}

async function checkSupportStockWarningsOnce(bot, config, reason = 'map-run') {
  if (config.__supportStockWarningsCheckedForRun) return
  config.__supportStockWarningsCheckedForRun = true

  const advanced = config.advanced || {}
  if (advanced.supportStockDashboardWarningsEnabled === false) return

  const machine = config.machine || {}
  const foodItem = String(advanced.autoEatFoodItem || 'cooked_beef').replace(/^minecraft:/, '')
  const thresholds = {
    food: Math.max(1, toNumber(advanced.supportStockFoodMinStacks, 5)),
    xp: Math.max(1, toNumber(advanced.supportStockXpBottleMinStacks, 5)),
    map: Math.max(1, toNumber(advanced.supportStockEmptyMapMinStacks, 1)),
    pane: Math.max(1, toNumber(advanced.supportStockGlassPaneMinStacks, 1))
  }

  const checkStackThreshold = async (label, itemName, chests, minStacks) => {
    if (!chests.length) {
      reportSupportStockWarning(config, `${label} stock chest is not configured.`, { reason, item: itemName })
      return
    }
    const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[itemName]?.stackSize, 64))
    const minItems = minStacks * stackSize
    const result = await countItemAcrossChests(bot, config, itemName, chests, label)
    if (result.checked <= 0) {
      reportSupportStockWarning(config, `${label} stock could not be checked.`, { reason, item: itemName, checked: result.checked, failed: result.failed, failures: result.failures })
      return
    }
    if (result.count < minItems) {
      reportSupportStockWarning(config, `${label} stock is low: ${result.count}/${minItems} ${itemName} available.`, {
        reason,
        item: itemName,
        count: result.count,
        minItems,
        minStacks,
        checkedChests: result.checked,
        failedChests: result.failed,
        failures: result.failures
      })
    } else {
      const failedText = result.failed > 0 ? `; ${result.failed} configured location(s) skipped` : ''
      console.log(`[SUPPORT-STOCK] ${label} ok: ${result.count}/${minItems} ${itemName} across ${result.checked} chest(s)${failedText}.`)
      if (result.failed > 0 && advanced.debugPrints) {
        console.log(`[SUPPORT-STOCK-DEBUG] ${label} skipped locations: ${result.failures.map((entry) => `${entry.position.x},${entry.position.y},${entry.position.z} ${entry.message}`).join(' | ')}`)
      }
    }
  }

  const foodChests = normalizeMachineChestList(machine.foodChest?.enabled !== false ? machine.foodChest : null)
  const xpChests = normalizeMachineChestList(machine.xpBottleChests)
  const mapChests = normalizeMachineChestList(machine.mapMaterialChests)

  await checkStackThreshold('Food', foodItem, foodChests, thresholds.food)
  await checkStackThreshold('XP bottle', 'experience_bottle', xpChests, thresholds.xp)
  await checkStackThreshold('Empty map', 'map', mapChests, thresholds.map)
  await checkStackThreshold('Glass pane', 'glass_pane', mapChests, thresholds.pane)
}

function countWindowInventoryItems(window, itemId, itemName = null) {
  const slots = Array.isArray(window?.slots) ? window.slots : []
  const start = Number.isFinite(window?.inventoryStart) ? window.inventoryStart : 0
  const end = Number.isFinite(window?.inventoryEnd) ? window.inventoryEnd : slots.length - 1
  let count = 0
  for (let i = start; i <= end && i < slots.length; i += 1) {
    const stack = slots[i]
    if (!stack || toNumber(stack.count, 0) <= 0) continue
    if ((itemId && stack.type === itemId) || (itemName && stack.name === itemName)) {
      count += toNumber(stack.count, 0)
    }
  }
  return count
}

async function waitForWindowInventoryCount(window, itemId, itemName, targetCount, timeoutMs = 3000, pollMs = 100) {
  const timeout = Math.max(100, toNumber(timeoutMs, 3000))
  const poll = Math.max(25, toNumber(pollMs, 100))
  let elapsed = 0
  let latest = countWindowInventoryItems(window, itemId, itemName)
  while (elapsed <= timeout) {
    latest = countWindowInventoryItems(window, itemId, itemName)
    if (latest >= targetCount) return latest
    await delay(poll)
    elapsed += poll
  }
  return latest
}

function findEmptyWindowInventorySlot(window) {
  const slots = Array.isArray(window?.slots) ? window.slots : []
  const start = Number.isFinite(window?.inventoryStart) ? window.inventoryStart : 0
  const end = Number.isFinite(window?.inventoryEnd) ? window.inventoryEnd : slots.length - 1
  for (let i = start; i <= end && i < slots.length; i += 1) {
    const stack = slots[i]
    if (!stack || toNumber(stack.count, 0) <= 0) return i
  }
  return -1
}

function findPartialWindowInventorySlot(window, itemId, itemName, stackSize) {
  const slots = Array.isArray(window?.slots) ? window.slots : []
  const start = Number.isFinite(window?.inventoryStart) ? window.inventoryStart : 0
  const end = Number.isFinite(window?.inventoryEnd) ? window.inventoryEnd : slots.length - 1
  for (let i = start; i <= end && i < slots.length; i += 1) {
    const stack = slots[i]
    if (!stack || toNumber(stack.count, 0) <= 0) continue
    if ((itemId && stack.type === itemId) || (itemName && stack.name === itemName)) {
      if (toNumber(stack.count, 0) < stackSize) return i
    }
  }
  return -1
}

async function takeWindowOutputToInventoryConfirmed(bot, window, outputSlot, itemName, beforeCount, timeoutMs = 3000, pollMs = 100, clickTicks = 4) {
  const targetSlot = findEmptyWindowInventorySlot(window)
  if (targetSlot < 0) throw new Error(`No empty inventory slot available for cartography output ${itemName}.`)

  console.log(`[CARTO-OUTPUT] start outputSlot=${outputSlot} targetSlot=${targetSlot} beforeCount=${beforeCount} ${formatCartographyWindowState(window)}`)
  await assertWindowCursorEmpty(window, `before taking output slot ${outputSlot}`)
  await safeWindowClick(bot, window, outputSlot, 0, 0, { precondition: 'empty', ticks: clickTicks })
  console.log(`[CARTO-OUTPUT] after-output-click ${formatCartographyWindowState(window)}`)

  const cursor = await waitForWindowCursorState(
    window,
    (item) => item?.name === itemName || (!item || toNumber(item.count, 0) <= 0),
    timeoutMs,
    pollMs
  )
  console.log(`[CARTO-OUTPUT] cursor-after-wait=${formatWindowStack(cursor)}`)
  if (cursor?.name === itemName) {
    await safeWindowClick(bot, window, targetSlot, 0, 0, { precondition: 'any', ticks: clickTicks })
    console.log(`[CARTO-OUTPUT] after-target-click ${formatCartographyWindowState(window)}`)
  }

  await assertWindowCursorEmpty(window, `after taking output slot ${outputSlot}`)
  const itemId = getItemId(bot, itemName)
  const outputCleared = await waitForWindowSlotEmpty(window, outputSlot, timeoutMs, pollMs)
  const afterCount = await waitForWindowInventoryCount(window, itemId, itemName, beforeCount + 1, timeoutMs, pollMs)
  console.log(`[CARTO-OUTPUT] done outputCleared=${outputCleared} afterCount=${afterCount} target=${beforeCount + 1} ${formatCartographyWindowState(window)}`)
  return outputCleared && afterCount > beforeCount
}

async function callFirstAvailableMethod(target, names, args = []) {
  for (const name of names) {
    if (typeof target?.[name] !== 'function') continue
    return await target[name](...args)
  }
  throw new Error(`Missing cartography API method: ${names.join('|')}`)
}

function getCartographyApiWindow(table) {
  return table?.window || table
}

async function lockMapWithCartographyApi(bot, config, cartographyConfig, advanced, options = {}) {
  if (typeof bot?.openCartographyTable !== 'function') {
    console.log('[CARTO-API] unavailable openCartographyTable=false')
    return null
  }
  const clickTicks = Math.max(2, toNumber(options.clickTicks, toNumber(advanced?.postPrintCartographyClickWaitTicks, 4)))
  const outputSettleTicks = Math.max(10, toNumber(options.outputSettleTicks, toNumber(advanced?.postPrintCartographyOutputSettleTicks, 20)))
  const outputWaitMs = Math.max(1000, toNumber(options.outputWaitMs, toNumber(advanced?.postPrintCartographyOutputWaitMs, 4000)))
  const pollMs = Math.max(50, toNumber(options.pollMs, toNumber(advanced?.postPrintCartographyPollMs, 100)))
  const accessRange = Math.max(0.35, toNumber(advanced?.postPrintCartographyAccessRange, 0.85))
  let table = null

  try {
    console.log(`[CARTO-API] start ${formatCartographyBotState(bot, config)} target=${formatCoordTriplet(cartographyConfig.position)} access=${formatCoordTriplet(cartographyConfig.accessPosition)}`)
    assertLivePlatformReady(bot, config, 'postprint-cartography-api:pre-open')
    console.log('[CARTO-API] goto access')
    await gotoConfiguredAccess(bot, cartographyConfig.position, cartographyConfig.accessPosition, accessRange, config, 'postprint-cartography-api', { strict: true })
    console.log(`[CARTO-API] at access ${formatCartographyBotState(bot, config)}`)
    assertLivePlatformReady(bot, config, 'postprint-cartography-api:at-access')
    console.log('[CARTO-API] waiting for cartography_table block')
    const block = await waitForBlockAt(bot, cartographyConfig.position, {
      timeoutMs: Math.max(1000, toNumber(advanced?.postPrintMachineBlockWaitMs, 10000)),
      pollMs,
      expectedNames: ['cartography_table']
    })
    console.log(`[CARTO-API] block ready name=${block?.name || 'unknown'} pos=${formatCoordTriplet(block?.position || cartographyConfig.position)}`)
    table = await bot.openCartographyTable(block)
    console.log('[CARTO-API] opened table')
    await waitBotTicks(bot, clickTicks)
    assertLivePlatformReady(bot, config, 'postprint-cartography-api:after-open')

    const tableWindow = getCartographyApiWindow(table)
    if (tableWindow?.selectedItem !== undefined) {
      await assertWindowCursorEmpty(tableWindow, 'postprint-cartography-api:after-open')
    }
    console.log(`[CARTO-API] after-open ${formatCartographyWindowState(tableWindow)} ${formatCartographyBotState(bot, config)}`)

    const mapItem = findInventoryItemByType(bot, 'filled_map')
    const paneItem = findInventoryItemByType(bot, 'glass_pane')
    console.log(`[CARTO-API] selected materials map=${formatWindowStack(mapItem)} locked=${isFilledMapKnownLocked(mapItem)} pane=${formatWindowStack(paneItem)}`)
    if (!mapItem || !paneItem) throw new Error('Missing filled map or glass pane before cartography API lock.')
    if (isFilledMapKnownLocked(mapItem)) {
      console.log('[CARTO-API] map already appears locked; skipping lock inputs')
      return true
    }

    console.log('[CARTO-API] put map')
    await callFirstAvailableMethod(table, ['putMap', 'putInput', 'putInputItem'], [mapItem])
    await waitBotTicks(bot, clickTicks)
    assertLivePlatformReady(bot, config, 'postprint-cartography-api:after-map-input')
    if (tableWindow?.selectedItem !== undefined) {
      await assertWindowCursorEmpty(tableWindow, 'postprint-cartography-api:after-map-input')
    }
    console.log(`[CARTO-API] after-map-input ${formatCartographyWindowState(tableWindow)} ${formatCartographyBotState(bot, config)}`)

    const freshPane = findInventoryItemByType(bot, 'glass_pane')
    if (!freshPane) throw new Error('Glass pane disappeared before cartography API modifier input.')
    console.log(`[CARTO-API] put modifier pane=${formatWindowStack(freshPane)}`)
    await callFirstAvailableMethod(table, ['putModifier', 'putSecondItem', 'putAdditionalItem'], [freshPane])
    await waitBotTicks(bot, clickTicks)
    assertLivePlatformReady(bot, config, 'postprint-cartography-api:after-pane-input')
    if (tableWindow?.selectedItem !== undefined) {
      await assertWindowCursorEmpty(tableWindow, 'postprint-cartography-api:after-pane-input')
    }
    console.log(`[CARTO-API] after-pane-input ${formatCartographyWindowState(tableWindow)} ${formatCartographyBotState(bot, config)}`)

    console.log(`[CARTO-API] waiting output settle ticks=${outputSettleTicks}`)
    await waitBotTicks(bot, outputSettleTicks)
    const output = typeof table.outputItem === 'function'
      ? table.outputItem()
      : tableWindow?.slots?.[2]
    console.log(`[CARTO-API] output-read output=${formatWindowStack(output)} ${formatCartographyWindowState(tableWindow)}`)
    if (!output) {
      console.log('[POSTPRINT-WARN] Cartography API accepted inputs but produced no output; treating map as already locked/unlockable.')
      return true
    }

    const before = countInventoryByType(bot, 'filled_map')
    console.log(`[CARTO-API] take output beforeFilled=${before}`)
    await callFirstAvailableMethod(table, ['takeOutput', 'takeResult'], [])
    await waitBotTicks(bot, clickTicks)
    assertLivePlatformReady(bot, config, 'postprint-cartography-api:after-output')
    console.log(`[CARTO-API] after-output ${formatCartographyWindowState(tableWindow)} ${formatCartographyBotState(bot, config)}`)

    const deadline = Date.now() + outputWaitMs
    while (Date.now() <= deadline) {
      if (countInventoryByType(bot, 'filled_map') > before || findInventoryItemByType(bot, 'filled_map')) {
        console.log(`[CARTO-API] complete beforeFilled=${before} afterFilled=${countInventoryByType(bot, 'filled_map')}`)
        return true
      }
      await delay(pollMs)
    }
    throw new Error('Cartography API output was taken but filled_map was not visible in inventory.')
  } finally {
    if (table && typeof table.close === 'function') {
      try { table.close() } catch { }
    } else if (table?.window && typeof table.window.close === 'function') {
      try { table.window.close() } catch { }
    }
    console.log(`[CARTO-API] closed ${formatCartographyBotState(bot, config)}`)
  }
}

async function takeOneChestItemToInventory(bot, window, itemId, itemName, timeoutMs = 3000, pollMs = 100) {
  const source = getChestWindowSlots(window)
    .filter((entry) => entry.stack?.type === itemId || entry.stack?.name === itemName)
    .sort((a, b) => toNumber(b.stack?.count, 0) - toNumber(a.stack?.count, 0))[0]
  if (!source) return false

  const targetSlot = findEmptyWindowInventorySlot(window)
  if (targetSlot < 0) return false

  const adjustedTimeoutMs = getLatencyAdjustedTimeoutMs(bot, bot.__nervConfig, timeoutMs, timeoutMs)
  const beforeTarget = countWindowInventoryItems(window, itemId, itemName)
  await safeWindowClick(bot, window, source.slot, 0, 0, { precondition: 'empty' })
  await delay(pollMs)
  await safeWindowClick(bot, window, targetSlot, 1, 0, { precondition: 'any' })
  await delay(pollMs)
  await safeWindowClick(bot, window, source.slot, 0, 0, { precondition: 'any' })

  const targetReady = await waitForWindowSlot(window, targetSlot, (stack) => (
    stack &&
    toNumber(stack.count, 0) > 0 &&
    (stack.type === itemId || stack.name === itemName)
  ), adjustedTimeoutMs, pollMs)
  const invCount = await waitForWindowInventoryCount(window, itemId, itemName, beforeTarget + 1, adjustedTimeoutMs, pollMs)
  return Boolean(targetReady) || invCount > beforeTarget
}

async function topUpPartialInventoryStackFromChest(bot, window, itemId, itemName, amountNeeded, stackSize, timeoutMs = 3000, pollMs = 100) {
  const targetSlot = findPartialWindowInventorySlot(window, itemId, itemName, stackSize)
  if (targetSlot < 0) return 0

  const targetStack = window.slots?.[targetSlot]
  const targetRoom = Math.max(0, stackSize - toNumber(targetStack?.count, 0))
  const transferTarget = Math.min(Math.max(1, toNumber(amountNeeded, 1)), targetRoom)
  if (transferTarget <= 0) return 0

  const source = getChestWindowSlots(window)
    .filter((entry) => entry.stack?.type === itemId || entry.stack?.name === itemName)
    .filter((entry) => toNumber(entry.stack?.count, 0) >= transferTarget)
    .sort((a, b) => toNumber(a.stack?.count, 0) - toNumber(b.stack?.count, 0))[0]
  if (!source) return 0

  const adjustedTimeoutMs = getLatencyAdjustedTimeoutMs(bot, bot.__nervConfig, timeoutMs, timeoutMs)
  const beforeTarget = countWindowInventoryItems(window, itemId, itemName)
  await safeWindowClick(bot, window, source.slot, 0, 0, { precondition: 'any' })
  await delay(pollMs)
  await safeWindowClick(bot, window, targetSlot, 0, 0, { precondition: 'any' })
  await delay(pollMs)
  await safeWindowClick(bot, window, source.slot, 0, 0, { precondition: 'any' })

  const expected = beforeTarget + transferTarget
  const invCount = await waitForWindowInventoryCount(window, itemId, itemName, expected, adjustedTimeoutMs, pollMs)
  return Math.max(0, invCount - beforeTarget)
}

async function quickMoveChestItemStacks(bot, window, itemId, amountNeeded, stackSize, maxStacks = 8, options = {}) {
  const config = options.config || bot.__nervConfig
  const onlyFullStacks = options.onlyFullStacks !== false
  const timeoutMs = getLatencyAdjustedTimeoutMs(bot, config, Math.max(100, toNumber(options.timeoutMs, 3000)), 3000)
  const pollMs = Math.max(25, toNumber(options.pollMs, 100))
  const waitForSlot = options.waitForSlot !== false
  const latencyState = getLatencyBackoffState(bot, config)
  const actionDelayMs = Math.max(latencyState.delayMs, Math.max(0, toNumber(options.actionDelayMs, waitForSlot ? pollMs : 0)))
  const startedAt = Date.now()
  const slots = getChestWindowSlots(window)
    .filter((entry) => entry.stack?.type === itemId)
    .sort((a, b) => toNumber(b.stack?.count, 0) - toNumber(a.stack?.count, 0))

  let movedEstimate = 0
  let stacksMoved = 0
  for (const entry of slots) {
    if (stacksMoved >= maxStacks) break
    const count = Math.max(0, toNumber(entry.stack?.count, 0))
    if (count <= 0) continue
    if (onlyFullStacks && count < stackSize) continue
    const plannedCount = onlyFullStacks ? stackSize : count
    if (amountNeeded - movedEstimate < plannedCount) break
    await applyAdaptiveLatencyBackoff(bot, config, `quick-move-chest-slot-${entry.slot}`)
    await bot.clickWindow(entry.slot, 0, 1)
    if (waitForSlot) {
      await waitForWindowSlot(window, entry.slot, (stack) => (
        !stack ||
        toNumber(stack.count, 0) <= 0 ||
        stack.type !== itemId ||
        toNumber(stack.count, 0) < count
      ), timeoutMs, pollMs)
    }
    movedEstimate += count
    stacksMoved += 1
    if (actionDelayMs > 0) await delay(actionDelayMs)
  }

  return { movedEstimate, stacksMoved, durationMs: Date.now() - startedAt }
}

function formatWindowStack(stack) {
  if (!stack) return 'empty'
  return `${stack.name || stack.displayName || stack.type || 'unknown'}x${toNumber(stack.count, 0)}`
}

function formatCursorStack(window) {
  return formatWindowStack(getWindowCursorItem(window))
}

function formatCartographyWindowState(window) {
  if (!window) return 'window=null'
  return `in0=${formatWindowStack(window.slots?.[0])} in1=${formatWindowStack(window.slots?.[1])} out=${formatWindowStack(window.slots?.[2])} cursor=${formatCursorStack(window)} range=${window.inventoryStart ?? 'n/a'}-${window.inventoryEnd ?? 'n/a'}`
}

function formatCartographyBotState(bot, config) {
  const status = getLivePlatformStatus(bot, config)
  return `pos=${formatBotPosition(bot)} state=${status.classification?.state || 'unknown'} platform=${status.platform} held=${formatWindowStack(bot?.heldItem)} filled=${countInventoryByType(bot, 'filled_map')} pane=${countInventoryItems(bot, 'glass_pane')}`
}

async function waitForWindowSlot(window, slot, predicate, timeoutMs = 3000, pollMs = 100) {
  const timeout = Math.max(100, toNumber(timeoutMs, 3000))
  const poll = Math.max(25, toNumber(pollMs, 100))
  let elapsed = 0
  while (elapsed <= timeout) {
    const stack = window?.slots?.[slot]
    if (predicate(stack, window)) return stack
    await delay(poll)
    elapsed += poll
  }
  return null
}

async function waitForWindowSlotEmpty(window, slot, timeoutMs = 3000, pollMs = 100) {
  const timeout = Math.max(100, toNumber(timeoutMs, 3000))
  const poll = Math.max(25, toNumber(pollMs, 100))
  let elapsed = 0
  while (elapsed <= timeout) {
    const stack = window?.slots?.[slot]
    if (!stack || toNumber(stack.count, 0) <= 0) return true
    await delay(poll)
    elapsed += poll
  }
  return false
}

async function interactWithConfiguredBlock(bot, config, node, label = 'configured block') {
  const pos = node?.position
  if (!pos) throw new Error(`Missing ${label} position`)
  await waitForPlatformReady(bot, config, `postprint-${label}`)
  await gotoConfiguredAccess(bot, pos, node?.accessPosition, 2, config, `postprint-${label}`)
  const Vec3 = bot.entity.position.constructor
  const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
  if (!block) throw new Error(`No block found at ${pos.x} ${pos.y} ${pos.z}`)

  const name = String(block.name || '')
  const isContainer = name === 'chest' ||
    name === 'trapped_chest' ||
    name === 'barrel' ||
    name === 'hopper' ||
    name === 'dispenser' ||
    name === 'dropper' ||
    name.endsWith('shulker_box')

  if (isContainer) {
    const isResetBlock = label === 'reset-block'
    if (isResetBlock) {
      console.log(`[POSTPRINT-RESET] Opening reset container ${name} at ${pos.x},${pos.y},${pos.z}.`)
    }
    await applyAdaptiveLatencyBackoff(bot, config, `postprint-${label}-before-open`, { pauseMovement: true })
    const container = await bot.openContainer(block)
    const latencyHoldMs = shouldUseLatencySafeMode(bot, config, label).active
      ? getLatencyAdjustedTimeoutMs(bot, config, toNumber(config.advanced?.resetChestWaitMs, toNumber(config.advanced?.postPrintInteractionDelayMs, 200)), toNumber(config.advanced?.postPrintInteractionDelayMs, 200))
      : 0
    const openDelayMs = isResetBlock
      ? Math.max(toNumber(config.advanced?.resetChestWaitMs, toNumber(config.advanced?.postPrintInteractionDelayMs, 200)), latencyHoldMs)
      : toNumber(config.advanced?.postPrintInteractionDelayMs, 200)
    if (isResetBlock) {
      console.log(`[POSTPRINT-RESET] Reset container opened; holding open for ${openDelayMs}ms.`)
    }
    await delay(openDelayMs)
    try {
      await Promise.resolve(container.close())
      if (isResetBlock) {
        console.log('[POSTPRINT-RESET] Reset container close sent.')
      }
    } catch (err) {
      if (isResetBlock) {
        console.log(`[POSTPRINT-RESET-WARN] Reset container close failed: ${err?.message || err}`)
        throw err
      }
    }
    if (isResetBlock) {
      const closeSettleMs = Math.max(0, toNumber(config.advanced?.resetChestCloseSettleMs, 0))
      if (closeSettleMs > 0) {
        console.log(`[POSTPRINT-RESET] Waiting ${closeSettleMs}ms after reset container close.`)
        await delay(closeSettleMs)
      }
      console.log('[POSTPRINT-RESET] Reset container interaction complete.')
    }
    return name
  }

  await applyAdaptiveLatencyBackoff(bot, config, `postprint-${label}-before-activate`, { pauseMovement: true })
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
  await bot.activateBlock(block)
  await delay(getLatencyAdjustedTimeoutMs(bot, config, toNumber(config.advanced?.postPrintInteractionDelayMs, 200), toNumber(config.advanced?.postPrintInteractionDelayMs, 200)))
  return name
}

function getMapCenterPosition(config) {
  const corner = config.machine?.mapCorner || { x: 0, y: 64, z: 0 }
  const width = Math.max(1, toNumber(config.machine?.mapSize?.width, 128))
  const height = Math.max(1, toNumber(config.machine?.mapSize?.height, 128))
  return {
    x: corner.x + Math.floor((width - 1) / 2),
    y: corner.y,
    z: corner.z + Math.floor((height - 1) / 2)
  }
}

async function runPlatformResetPreflight(bot, config, reason = 'reset-current-nbt') {
  const advanced = config.advanced || {}
  const resetConfig = config.machine?.resetBlock?.enabled ? config.machine.resetBlock : null
  const center = getMapCenterPosition(config)

  console.log(`[RESET-PREFLIGHT] Starting platform reset before restarting current NBT. reason=${reason}`)
  await waitForPlatformReady(bot, config, `${reason}-platform-ready`)

  if (!resetConfig?.position) {
    throw new Error('reset block/chest is not configured; cannot reset platform before restarting current NBT')
  }

  await interactWithConfiguredBlock(bot, config, resetConfig, 'reset-block')
  await waitForPlatformReady(bot, config, `${reason}-after-reset`)
  await bot.pathfinder.goto(new GoalNear(center.x, center.y, center.z, 1))

  const centerWaitMs = Math.max(0, toNumber(advanced.resetPreflightCenterWaitMs, toNumber(advanced.postPrintCenterWaitMs, 3000)))
  if (centerWaitMs > 0) {
    console.log(`[RESET-PREFLIGHT] Waiting at center for ${centerWaitMs}ms before restarting print.`)
    await delay(centerWaitMs)
  }

  console.log('[RESET-PREFLIGHT] Platform reset preflight complete; restarting current NBT from target 0.')
}

async function parkAtCartographyAccessForPause(bot, config, dashboardRuntime = null, reason = 'operator-pause') {
  if (!bot?.pathfinder?.goto) return false
  const cartographyNode = config.machine?.cartographyTable || null
  const cartographyConfig = cartographyNode?.position ? cartographyNode : null
  if (!cartographyConfig?.position) {
    console.log('[CONTROL-WARN] Pause parking skipped: cartography table is not configured.')
    return false
  }
  const accessPosition = cartographyConfig.accessPosition || cartographyConfig.openPos || cartographyConfig.openPosition || null
  const accessRange = Math.max(0.35, toNumber(
    config.advanced?.pauseCartographyAccessRange,
    toNumber(config.advanced?.postPrintCartographyAccessRange, 0.85)
  ))
  const timeoutMs = Math.max(5000, toNumber(config.advanced?.pauseParkTimeoutMs, 60000))
  const pollMs = Math.max(100, toNumber(config.advanced?.pauseParkPollMs, 250))
  const xzDistance = (point) => {
    const pos = bot?.entity?.position
    if (!pos || !point) return Number.POSITIVE_INFINITY
    if (!Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.z))) return Number.POSITIVE_INFINITY
    if (!Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.z))) return Number.POSITIVE_INFINITY
    const dx = Number(pos.x) - Number(point.x)
    const dz = Number(pos.z) - Number(point.z)
    return Math.sqrt((dx * dx) + (dz * dz))
  }

  try {
    dashboardRuntime?.setPhase?.('paused', 'parking-at-cartography')
    closeCurrentWindowIfOpen(bot, reason)
    bot.__nervPauseParkingInProgress = true
    await waitForPlatformReady(bot, config, `${reason}-platform-ready`)
    const goalPos = accessPosition || cartographyConfig.position
    const readyDistance = Math.max(0.35, accessRange)
    assertLivePlatformReady(bot, config, `${reason}-cartography-access:pre-goal`)
    configurePathfinderMovements(bot, config)
    console.log(`[CONTROL] Parking paused bot at cartography access target=${formatCoordTriplet(goalPos)} range=${accessRange}.`)
    if (xzDistance(goalPos) > readyDistance) {
      const currentY = Number.isFinite(Number(bot?.entity?.position?.y)) ? Number(bot.entity.position.y) : Number(goalPos.y)
      bot.pathfinder.setGoal(new GoalNear(goalPos.x, currentY, goalPos.z, accessRange))
      const deadline = Date.now() + timeoutMs
      let lastLogAt = 0
      while (Date.now() <= deadline) {
        if (!isBotSessionLive(bot)) throw new Error('bot session ended while parking at cartography access')
        const distance = xzDistance(goalPos)
        if (distance <= readyDistance) break
        if (Date.now() - lastLogAt >= 5000) {
          console.log(`[CONTROL] Parking paused bot at cartography access; xzDistance=${distance.toFixed(2)} target=${formatCoordTriplet(goalPos)} current=${formatBotPosition(bot)}.`)
          lastLogAt = Date.now()
        }
        await delay(pollMs)
      }
      const finalDistance = xzDistance(goalPos)
      if (finalDistance > readyDistance) {
        throw new Error(`pause cartography parking timed out after ${timeoutMs}ms; xzDistance=${finalDistance.toFixed(2)} target=${formatCoordTriplet(goalPos)} current=${formatBotPosition(bot)}`)
      }
    }
    stopBotMovement(bot)
    dashboardRuntime?.setPhase?.('paused', 'paused')
    const standPos = accessPosition || cartographyConfig.position
    console.log(`[CONTROL] Paused at cartography access x=${Math.round(standPos.x)} y=${Math.round(standPos.y)} z=${Math.round(standPos.z)}.`)
    return true
  } catch (err) {
    stopBotMovement(bot)
    dashboardRuntime?.setPhase?.('paused', 'paused')
    console.log(`[CONTROL-WARN] Pause parking at cartography access failed: ${err?.message || err}`)
    return false
  } finally {
    bot.__nervPauseParkingInProgress = false
  }
}

function getItemId(bot, itemName) {
  return bot.registry.itemsByName[itemName]?.id || null
}

function findInventoryItemByType(bot, itemName) {
  const itemId = getItemId(bot, itemName)
  if (!itemId) return null
  return bot.inventory.items().find((entry) => entry.type === itemId)
}

function findInventoryItemsByType(bot, itemName) {
  const itemId = getItemId(bot, itemName)
  if (!itemId) return []
  return bot.inventory.items().filter((entry) => entry.type === itemId)
}

function countInventoryByType(bot, itemName) {
  const itemId = getItemId(bot, itemName)
  if (!itemId) return 0
  return bot.inventory.items()
    .filter((entry) => entry.type === itemId)
    .reduce((sum, entry) => sum + toNumber(entry.count, 0), 0)
}

function getBotHunger(bot) {
  const hunger = Number(bot?.food)
  return Number.isFinite(hunger) ? hunger : null
}

async function equipFoodItem(bot, foodItem) {
  const item = bot.inventory.items().find((entry) => entry.name === foodItem)
  if (!item) return false
  await bot.equip(item, 'hand')
  return true
}

async function eatConfiguredFoodUntilReady(bot, config, foodItem, minHunger, reason) {
  let hunger = getBotHunger(bot)
  if (hunger == null || hunger >= minHunger) return true

  const maxEats = Math.max(1, toNumber(config.advanced?.autoEatMaxConsumes, 8))
  const settleMs = Math.max(100, toNumber(config.advanced?.autoEatSettleMs, 500))
  let previousHunger = hunger

  for (let attempt = 1; attempt <= maxEats; attempt += 1) {
    if (!await equipFoodItem(bot, foodItem)) return false
    try {
      await bot.consume()
    } catch (err) {
      console.log(`[AUTO-EAT-WARN] ${reason}: consume failed for ${foodItem}: ${err?.message || err}`)
      return false
    }

    await delay(settleMs)
    hunger = getBotHunger(bot)
    if (hunger == null) return true
    if (hunger >= minHunger) {
      console.log(`[AUTO-EAT] ${reason}: ate ${foodItem}; hunger=${hunger}/${minHunger}.`)
      return true
    }
    if (hunger <= previousHunger && !bot.inventory.items().some((entry) => entry.name === foodItem)) {
      break
    }
    previousHunger = hunger
  }

  console.log(`[AUTO-EAT-WARN] ${reason}: hunger still low after eating attempts: hunger=${hunger ?? 'unknown'} min=${minHunger}.`)
  return false
}

async function returnUnusedFoodToChest(bot, config, foodItem, reason) {
  const advanced = config.advanced || {}
  if (advanced.autoEatReturnUnusedFood === false) return false

  const foodChest = config.machine?.foodChest
  const leftover = countInventoryByType(bot, foodItem)
  if (leftover <= 0 || !foodChest?.enabled || !foodChest?.position) return false

  const returned = await depositToChest(bot, config, foodChest.position, foodItem, leftover, foodChest.accessPosition)
  if (returned) {
    console.log(`[AUTO-EAT] ${reason}: returned ${leftover} unused ${foodItem} to food chest.`)
  } else {
    console.log(`[AUTO-EAT-WARN] ${reason}: could not return ${leftover} unused ${foodItem} to food chest.`)
  }
  return returned
}

async function pullFoodStackFromChest(bot, config, foodItem, reason) {
  const foodChest = config.machine?.foodChest
  if (!foodChest?.enabled || !foodChest?.position) {
    const message = 'Food chest is not configured; continuing without auto-eat.'
    console.log(`[AUTO-EAT-WARN] ${reason}: ${message}`)
    reportDashboardWarning(config, 'food-supply', message, { reason, item: foodItem })
    return false
  }

  const itemId = getItemId(bot, foodItem)
  if (!itemId) {
    const message = `Unknown configured food item ${foodItem}; continuing without auto-eat.`
    console.log(`[AUTO-EAT-WARN] ${reason}: ${message}`)
    reportDashboardWarning(config, 'food-supply', message, { reason, item: foodItem })
    return false
  }

  const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[foodItem]?.stackSize, 64))
  if (inventoryCapacityForItem(bot, foodItem) <= 0) {
    const message = `No inventory room for ${foodItem}; continuing without auto-eat.`
    console.log(`[AUTO-EAT-WARN] ${reason}: ${message}`)
    reportDashboardWarning(config, 'food-supply', message, { reason, item: foodItem })
    return false
  }

  const advanced = config.advanced || {}
  const syncWaitMs = Math.max(200, toNumber(advanced.autoEatChestSyncWaitMs, toNumber(advanced.restockInventorySyncWaitMs, 2000)))
  const pollMs = Math.max(25, toNumber(advanced.autoEatChestPollMs, 100))
  const settleMs = Math.max(100, toNumber(advanced.autoEatChestSettleMs, 300))
  let container = null

  try {
    container = await openContainerAt(bot, foodChest.position, foodChest.accessPosition)
    await delay(toNumber(advanced.preRestockDelayMs, 200))
    const chestHas = getChestWindowSlots(container)
      .some((entry) => entry.stack?.type === itemId || entry.stack?.name === foodItem)
    if (!chestHas) {
      const message = `Food chest is low or empty: no ${foodItem} found.`
      console.log(`[AUTO-EAT-WARN] ${reason}: ${message}`)
      reportDashboardWarning(config, 'food-supply', message, { reason, item: foodItem, chest: foodChest.position })
      return false
    }

    const before = countInventoryItems(bot, foodItem)
    const moved = await quickMoveChestItemStacks(bot, container, itemId, stackSize, stackSize, 1, {
      onlyFullStacks: false,
      timeoutMs: syncWaitMs,
      pollMs
    })
    await delay(settleMs)
    const windowCount = countWindowInventoryItems(container, itemId, foodItem)
    const after = Math.max(countInventoryItems(bot, foodItem), windowCount)
    if (moved.stacksMoved > 0 || after > before) {
      console.log(`[AUTO-EAT] ${reason}: pulled ${foodItem} from food chest; have=${after}.`)
      return true
    }

    const message = `Food chest transfer did not pull ${foodItem}; continuing.`
    console.log(`[AUTO-EAT-WARN] ${reason}: ${message}`)
    reportDashboardWarning(config, 'food-supply', message, { reason, item: foodItem, chest: foodChest.position })
    return false
  } catch (err) {
    const message = `Food chest pull failed: ${err?.message || err}`
    console.log(`[AUTO-EAT-WARN] ${reason}: ${message}`)
    reportDashboardWarning(config, 'food-supply', message, { reason, item: foodItem, chest: foodChest.position })
    return false
  } finally {
    if (container) {
      try { container.close() } catch { }
    }
  }
}

async function ensureFoodBeforeTraversal(bot, config, reason = 'before-traversal') {
  const advanced = config.advanced || {}
  if (advanced.autoEatEnabled === false) return true

  const hunger = getBotHunger(bot)
  if (hunger == null) return true

  const minHunger = Math.max(0, Math.min(20, toNumber(advanced.autoEatMinHunger, 12)))
  if (hunger >= minHunger) return true

  const foodItem = String(advanced.autoEatFoodItem || 'cooked_beef').replace(/^minecraft:/, '')
  if (!foodItem) return true

  console.log(`[AUTO-EAT] ${reason}: hunger=${hunger}/${minHunger}; checking ${foodItem}.`)
  const hadFoodBeforePull = bot.inventory.items().some((entry) => entry.name === foodItem)
  if (!bot.inventory.items().some((entry) => entry.name === foodItem)) {
    await pullFoodStackFromChest(bot, config, foodItem, reason)
    await delay(Math.max(100, toNumber(advanced.autoEatSettleMs, 500)))
  }

  if (!bot.inventory.items().some((entry) => entry.name === foodItem)) {
    const message = `No ${foodItem} available after food chest check; continuing.`
    console.log(`[AUTO-EAT-WARN] ${reason}: ${message}`)
    reportDashboardWarning(config, 'food-supply', message, { reason, item: foodItem })
    return false
  }

  const ok = await eatConfiguredFoodUntilReady(bot, config, foodItem, minHunger, reason)
  if (ok && !hadFoodBeforePull) {
    await returnUnusedFoodToChest(bot, config, foodItem, reason)
  }
  return ok
}

async function refillXpForPostPrint(bot, config) {
  const advanced = config.advanced || {}
  if (advanced.postPrintXpRefillEnabled === false) return

  const minLevel = Math.max(0, toNumber(advanced.postPrintMinXpLevel, 2))
  const targetLevel = Math.max(minLevel, toNumber(advanced.postPrintTargetXpLevel, 5))
  const currentLevel = toNumber(bot.experience?.level, 0)
  const machine = config.machine || {}
  const xpBottleChests = normalizeMachineChestList(machine.xpBottleChests)
  const xpButtonConfig = config.machine?.xpButton

  if (currentLevel >= minLevel) return

  if (xpBottleChests.length) {
    const beforeBottles = countInventoryByType(bot, 'experience_bottle')
    const stackSize = Math.max(1, toNumber(bot.registry.itemsByName.experience_bottle?.stackSize, 64))
    const pullStacks = Math.max(1, toNumber(advanced.postPrintXpBottlePullStacks, 1))
    const desiredPull = Math.min(stackSize * pullStacks, Math.max(stackSize, inventoryCapacityForItem(bot, 'experience_bottle')))
    if (beforeBottles <= 0 && desiredPull > 0) {
      console.log(`[POSTPRINT] XP level=${currentLevel}/${minLevel}; withdrawing XP bottles from chest.`)
      const pulled = await withdrawItemStacksFromChests(bot, config, xpBottleChests, 'experience_bottle', desiredPull)
      if (pulled <= 0 && countInventoryByType(bot, 'experience_bottle') <= 0) {
        reportSupportStockWarning(config, 'XP bottle chest has no withdrawable experience_bottle stack for post-print rename.', {
          item: 'experience_bottle',
          minLevel,
          targetLevel
        })
      }
    }

    const maxThrows = Math.max(1, toNumber(advanced.postPrintXpBottleMaxThrows, 64))
    const throwDelayMs = Math.max(100, toNumber(advanced.postPrintXpBottleThrowDelayMs, 250))
    const settleMs = Math.max(250, toNumber(advanced.postPrintXpBottleSettleMs, 750))
    let throws = 0
    while (toNumber(bot.experience?.level, 0) < targetLevel && throws < maxThrows) {
      assertRuntimeContinue(bot, config, 'stopping-during-xp-refill')
      const bottle = findInventoryItemByType(bot, 'experience_bottle')
      if (!bottle) break
      try {
        await bot.equip(bottle, 'hand')
        await bot.look(bot.entity.yaw || 0, Math.PI / 2, true)
        await bot.activateItem()
        if (typeof bot.deactivateItem === 'function') bot.deactivateItem()
        throws += 1
        await delay(throwDelayMs)
      } catch (err) {
        console.log(`[POSTPRINT-WARN] XP bottle throw failed: ${err?.message || err}`)
        break
      }
    }
    if (throws > 0) {
      await delay(settleMs)
      console.log(`[POSTPRINT] Threw ${throws} XP bottle(s); level=${toNumber(bot.experience?.level, 0)}/${targetLevel}.`)
    }

    const finalAfterBottles = toNumber(bot.experience?.level, 0)
    if (advanced.postPrintReturnUnusedXpBottles !== false && finalAfterBottles >= minLevel && countInventoryByType(bot, 'experience_bottle') > 0) {
      const returnChest = xpBottleChests[0]
      const leftover = countInventoryByType(bot, 'experience_bottle')
      const returned = await depositToChest(bot, config, returnChest.position, 'experience_bottle', leftover, returnChest.accessPosition)
      if (returned) {
        console.log(`[POSTPRINT] Returned ${leftover} unused XP bottle(s) to XP chest.`)
      }
    }

    if (finalAfterBottles >= minLevel) return
  }

  if (!xpButtonConfig?.enabled || !xpButtonConfig?.position) {
    console.log('[POSTPRINT-WARN] XP button is not configured; skipping XP refill.')
    return
  }

  const standPos = xpButtonConfig.accessPosition || xpButtonConfig.position
  const buttonPos = xpButtonConfig.position
  const maxPresses = Math.max(1, toNumber(advanced.postPrintXpButtonMaxPresses, 40))

  for (let i = 0; i < maxPresses && toNumber(bot.experience?.level, 0) < targetLevel; i++) {
    try {
      await bot.pathfinder.goto(new GoalNear(standPos.x, standPos.y, standPos.z, 1))
      const Vec3 = bot.entity.position.constructor
      const block = bot.blockAt(new Vec3(buttonPos.x, buttonPos.y, buttonPos.z))
      if (!block) {
        console.log(`[POSTPRINT-WARN] XP button block not found at ${buttonPos.x} ${buttonPos.y} ${buttonPos.z}.`)
        break
      }

      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
      await bot.activateBlock(block)
      const waitMs = 1000 + Math.floor(Math.random() * 1001)
      await delay(waitMs)
    } catch (err) {
      console.log(`[POSTPRINT-WARN] XP button press failed: ${err?.message || err}`)
      break
    }
  }

  const finalLevel = toNumber(bot.experience?.level, 0)
  if (finalLevel < minLevel) {
    console.log(`[POSTPRINT-WARN] XP refill ended below rename minimum: level=${finalLevel} min=${minLevel} target=${targetLevel}.`)
  }
}

async function renameFinishedMap(bot, config, anvilConfig, sourceName) {
  const advanced = config.advanced || {}
  if (advanced.postPrintRenameMapEnabled === false) return null
  if (!anvilConfig?.enabled || !anvilConfig?.position) {
    console.log('[POSTPRINT-WARN] Anvil is not configured; skipping rename.')
    return null
  }

  const renameTarget = String(path.parse(sourceName || 'map').name || 'map').slice(0, 35)
  const maxAttempts = Math.max(1, toNumber(advanced.postPrintRenameAttempts, 3))
  const settleMs = Math.max(
    toNumber(advanced.postPrintInteractionDelayMs, 200),
    toNumber(advanced.postPrintMapSettleDelayMs, 200)
  )
  const latencySettleMs = getLatencyAdjustedTimeoutMs(bot, config, settleMs, settleMs)
  warnIfAnvilPillarLow(bot, config, anvilConfig, 'postprint-rename')

  let filledMaps = findInventoryItemsByType(bot, 'filled_map')
  if (!filledMaps.length) {
    console.log('[POSTPRINT-WARN] No filled map found to rename.')
    return null
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const unnamed = filledMaps.filter((entry) => !isMapNamed(entry, renameTarget))
    if (!unnamed.length) {
      console.log(`[POSTPRINT] Verified ${filledMaps.length} filled map(s) named ${renameTarget}.`)
      return renameTarget
    }

    const filledMap = unnamed[0]

    try {
      const beforeHints = getItemNameHints(filledMap)
      if (beforeHints.length) {
        console.log(`[POSTPRINT-DEBUG] Rename attempt ${attempt}/${maxAttempts} candidate: ${beforeHints.join(' | ')}`)
      }

      await applyAdaptiveLatencyBackoff(bot, config, 'postprint-rename-before-open', { pauseMovement: true })
      const anvil = await openAnvilAt(bot, anvilConfig.position, anvilConfig.accessPosition, config)
      await delay(Math.max(toNumber(advanced.postPrintInteractionDelayMs, 200), latencySettleMs))
      await applyAdaptiveLatencyBackoff(bot, config, 'postprint-rename-before-rename', { pauseMovement: true })
      await anvil.rename(filledMap, renameTarget)
      await delay(latencySettleMs)
      if (typeof anvil.close === 'function') anvil.close()
      await delay(latencySettleMs)

      filledMaps = findInventoryItemsByType(bot, 'filled_map')
      const remainingUnnamed = filledMaps.filter((entry) => !isMapNamed(entry, renameTarget))
      if (!remainingUnnamed.length && filledMaps.length > 0) {
        console.log(`[POSTPRINT] Renamed and verified ${filledMaps.length} filled map(s) to ${renameTarget}.`)
        return renameTarget
      }

      const sampleNames = filledMaps.flatMap((entry) => getItemNameHints(entry)).slice(0, 8)
      console.log(`[POSTPRINT-WARN] Rename attempt ${attempt}/${maxAttempts} not fully verified. renamed=${filledMaps.length - remainingUnnamed.length}/${filledMaps.length} seen=${sampleNames.join(' | ') || 'none'}`)
    } catch (err) {
      console.log(`[POSTPRINT-WARN] Rename attempt ${attempt}/${maxAttempts} failed: ${err?.message || err}`)
      await delay(latencySettleMs)
      filledMaps = findInventoryItemsByType(bot, 'filled_map')
    }
  }

  console.log(`[POSTPRINT-WARN] Rename could not be verified after ${maxAttempts} attempt(s); not storing unverified map(s).`)
  return null
}

function getItemNameHints(item) {
  const hints = []

  if (typeof item?.customName === 'string' && item.customName.trim()) {
    hints.push(item.customName)
  }

  if (typeof item?.displayName === 'string' && item.displayName.trim()) {
    hints.push(item.displayName)
  }

  const nbtName = item?.nbt?.value?.display?.value?.Name?.value
  if (typeof nbtName === 'string' && nbtName.trim()) {
    hints.push(nbtName)
    try {
      const parsed = JSON.parse(nbtName)
      if (typeof parsed?.text === 'string' && parsed.text.trim()) {
        hints.push(parsed.text)
      }
    } catch {
      // Ignore invalid JSON display names.
    }
  }

  return hints
}

function isMapNamed(item, expectedName) {
  if (!expectedName) return true
  const needle = String(expectedName).toLowerCase()
  return getItemNameHints(item).some((entry) => String(entry).toLowerCase().includes(needle))
}

function itemDataContains(item, needle) {
  if (!item || !needle) return false
  const lowered = String(needle).toLowerCase()
  try {
    return JSON.stringify(item).toLowerCase().includes(lowered)
  } catch {
    return false
  }
}

function isFilledMapKnownLocked(item) {
  if (!item || item.name !== 'filled_map') return false
  return itemDataContains(item, 'locked')
}

async function runPostPrintWorkflow(bot, config, context = {}) {
  const advanced = config.advanced || {}
  const machine = config.machine || {}
  if (advanced.postPrintWorkflowEnabled === false) {
    return { completed: true, finalStep: 'done' }
  }

  const postPrintSteps = ['withdraw', 'fill_map', 'cartography', 'rename_store', 'reset', 'center', 'done']
  const requestedResumeStep = postPrintSteps.includes(context.resumePostPrintStep) ? context.resumePostPrintStep : 'withdraw'
  let resumeStep = requestedResumeStep
  let resumeStepIndex = postPrintSteps.indexOf(resumeStep)
  const shouldRunStep = (step) => postPrintSteps.indexOf(step) >= resumeStepIndex && resumeStep !== 'done'
  let cartographySucceeded = context.postPrintCartographyComplete === true || context.cartographyComplete === true
  const savePostPrintStep = (nextStep, action = `next-${nextStep}`, meta = {}) => {
    if (typeof context.savePostPrintState === 'function') {
      context.savePostPrintState(nextStep, action, {
        postPrintCartographyComplete: cartographySucceeded,
        ...meta
      })
    }
  }
  const setPostPrintStatus = (step) => {
    if (typeof context.setStatusDetail === 'function') {
      context.setStatusDetail(mapPostPrintStatusDetail(step))
    }
  }
  const failPostPrint = (step, message) => {
    if (message) console.log(`[POSTPRINT-WARN] ${message}`)
    setPostPrintStatus(`blocked-${step}`)
    savePostPrintStep(step, `blocked-${step}`)
    return { completed: false, failedStep: step, message: message || '' }
  }
  const checkPostPrintStop = (step) => {
    if (!isRuntimeStopRequested(config)) return
    if (step === 'reset') {
      if (typeof context.setStatusDetail === 'function') {
        context.setStatusDetail('pausing-after-reset')
      }
      savePostPrintStep(step, 'dashboard-stop-after-reset')
      return
    }
    if (typeof context.setStatusDetail === 'function') {
      context.setStatusDetail('pausing-after-current-step')
    }
    savePostPrintStep(step, 'dashboard-stop')
    assertRuntimeContinue(bot, config, 'pausing-after-current-step')
  }

  if (resumeStep !== 'withdraw') {
    console.log(`[POSTPRINT-RESUME] Resuming post-print at step=${resumeStep}.`)
  }
  if (resumeStep === 'done') return { completed: true, finalStep: 'done' }

  const mapChestPos = nearestPosition(bot, machine.mapMaterialChests || [])
  const cartographyConfig = machine.cartographyTable?.enabled ? machine.cartographyTable : null
  const finishedChestPos = machine.finishedMapChest?.enabled ? machine.finishedMapChest.position : null
  const anvilConfig = machine.anvil?.enabled ? machine.anvil : null
  const resetConfig = machine.resetBlock?.enabled ? machine.resetBlock : null

  if (advanced.postPrintUseCartographyEnabled !== false &&
    !cartographySucceeded &&
    resumeStepIndex > postPrintSteps.indexOf('cartography')) {
    const fallbackStep = countInventoryByType(bot, 'filled_map') > 0 ? 'cartography' : 'withdraw'
    console.log(`[POSTPRINT-RESUME] Saved step=${requestedResumeStep} but cartographyComplete=false; rewinding to step=${fallbackStep}.`)
    resumeStep = fallbackStep
    resumeStepIndex = postPrintSteps.indexOf(resumeStep)
  }

  if (shouldRunStep('withdraw') && !mapChestPos) {
    return failPostPrint('withdraw', 'Missing map material chest position. Post-print workflow cannot continue.')
  }

  savePostPrintStep(resumeStep, 'post-print-active')

  if (shouldRunStep('withdraw')) {
    checkPostPrintStop('withdraw')
    setPostPrintStatus('withdraw')
    if (finishedChestPos) {
      const leftoverMaps = findInventoryItemsByType(bot, 'filled_map')
      for (const stack of leftoverMaps) {
        checkPostPrintStop('withdraw')
        if (stack && stack.count > 0) {
          console.log(`[POSTPRINT] Dumping ${stack.count} leftover filled_map(s) before withdrawing new empty map.`)
          await depositToChest(bot, config, finishedChestPos, 'filled_map', stack.count, machine.finishedMapChest?.accessPosition)
        }
      }
    }

    await waitForPlatformReady(bot, config, 'postprint-withdraw')
    const gotMap = countInventoryByType(bot, 'map') > 0 || await withdrawFromChest(bot, config, mapChestPos, 'map', 1)
    const gotPane = countInventoryItems(bot, 'glass_pane') > 0 || await withdrawFromChest(bot, config, mapChestPos, 'glass_pane', 1)
    if (!gotMap || !gotPane) {
      return failPostPrint('withdraw', 'Could not withdraw map/glass pane for post-print flow.')
    }
    savePostPrintStep('fill_map', 'materials-withdrawn')
  }

  if (shouldRunStep('fill_map') && advanced.postPrintFillMapEnabled !== false) {
    checkPostPrintStop('fill_map')
    setPostPrintStatus('fill_map')
    const mapItem = findInventoryItemByType(bot, 'map')
    if (!mapItem) {
      if (countInventoryByType(bot, 'filled_map') > 0) {
        console.log('[POSTPRINT-RESUME] No empty map found, but a filled map is already in inventory; continuing at cartography.')
        savePostPrintStep('cartography', 'map-already-filled')
      } else {
        return failPostPrint('withdraw', 'No empty or filled map in inventory while resuming fill_map; rewinding to withdraw materials.')
      }
    } else {
      const center = getMapCenterPosition(config)
      await waitForPlatformReady(bot, config, 'postprint-fill-map')
      try {
        await bot.pathfinder.goto(new GoalNear(center.x, center.y, center.z, 1))
      } catch (err) {
        return failPostPrint('fill_map', `Could not reach map center before map activation: ${err?.message || err}`)
      }

      await applyAdaptiveLatencyBackoff(bot, config, 'postprint-fill-map-before-activate', { pauseMovement: true })
      await bot.equip(mapItem, 'hand')
      await bot.activateItem()
      const fillWaitMs = getLatencyAdjustedTimeoutMs(
        bot,
        config,
        toNumber(advanced.postPrintFillMapWaitMs, toNumber(advanced.postPrintInteractionDelayMs, 200)),
        toNumber(advanced.postPrintInteractionDelayMs, 200)
      )
      const fillPollMs = Math.max(50, toNumber(advanced.postPrintFillMapPollMs, toNumber(advanced.postPrintChestPollMs, 100)))
      const fillDeadline = Date.now() + fillWaitMs
      while (Date.now() < fillDeadline && countInventoryByType(bot, 'filled_map') <= 0) {
        await delay(Math.min(fillPollMs, Math.max(1, fillDeadline - Date.now())))
      }
      if (typeof bot.deactivateItem === 'function') bot.deactivateItem()

      const filledMapItem = findInventoryItemByType(bot, 'filled_map')
      if (!filledMapItem) {
        return failPostPrint('fill_map', 'Map activation did not produce a filled map.')
      }

      try {
        await bot.equip(filledMapItem, 'hand')
        console.log('[POSTPRINT] Equipped filled map in hand for terrain data capture.')
      } catch (err) {
        return failPostPrint('fill_map', `Could not equip filled map: ${err?.message || err}`)
      }

      const fillSquare = Math.max(0, toNumber(config.printer?.mapFillSquareSize, 1))
      if (fillSquare > 0) {
        const walkPoints = [
          { x: center.x - fillSquare, y: center.y, z: center.z + fillSquare },
          { x: center.x + fillSquare, y: center.y, z: center.z + fillSquare },
          { x: center.x + fillSquare, y: center.y, z: center.z - fillSquare },
          { x: center.x - fillSquare, y: center.y, z: center.z - fillSquare }
        ]

        for (const p of walkPoints) {
          checkPostPrintStop('fill_map')
          const currentMap = findInventoryItemByType(bot, 'filled_map')
          if (currentMap && bot.heldItem?.type !== currentMap.type) {
            await bot.equip(currentMap, 'hand')
          }
          try {
            await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 1))
          } catch (err) {
            return failPostPrint('fill_map', `Map fill walk failed: ${err?.message || err}`)
          }
          const stillHolding = findInventoryItemByType(bot, 'filled_map')
          if (stillHolding && bot.heldItem?.type !== stillHolding.type) {
            await bot.equip(stillHolding, 'hand')
          }
        }
      }

      await delay(toNumber(advanced.postPrintMapSettleDelayMs, 1500))
      if (countInventoryByType(bot, 'filled_map') <= 0) {
        return failPostPrint('fill_map', 'Filled map disappeared before cartography step.')
      }
      savePostPrintStep('cartography', 'map-filled')
    }
  } else if (shouldRunStep('fill_map')) {
    savePostPrintStep('cartography', 'fill-map-skipped')
  }

  const hasFilledMap = countInventoryByType(bot, 'filled_map') > 0

  if (shouldRunStep('cartography') && advanced.postPrintUseCartographyEnabled !== false && cartographyConfig?.position && hasFilledMap) {
    checkPostPrintStop('cartography')
    setPostPrintStatus('cartography')
    try {
      await waitForPlatformReady(bot, config, 'postprint-cartography')
      assertLivePlatformReady(bot, config, 'postprint-cartography')
      if (countInventoryByType(bot, 'filled_map') <= 0) {
        throw new Error('No filled map available before cartography step.')
      }
      if (countInventoryItems(bot, 'glass_pane') <= 0) {
        if (!mapChestPos) {
          throw new Error('No glass pane in inventory and missing map material chest position.')
        }
        console.log('[POSTPRINT] Glass pane missing while resuming cartography; withdrawing one before locking map.')
        const gotPane = await withdrawFromChest(bot, config, mapChestPos, 'glass_pane', 1)
        if (!gotPane || countInventoryItems(bot, 'glass_pane') <= 0) {
          throw new Error('Could not withdraw glass pane before cartography step.')
        }
      }
      closeCurrentWindowIfOpen(bot, 'postprint-cartography')
      const neutralHandReady = await selectNeutralHotbarForWindow(bot, ['filled_map', 'glass_pane'], 'postprint-cartography')
      if (!neutralHandReady) {
        throw new Error('Could not select a neutral hotbar slot before cartography window interaction.')
      }
      const outputWaitMs = Math.max(1000, toNumber(advanced.postPrintCartographyOutputWaitMs, 4000))
      const actionDelayMs = Math.max(50, toNumber(advanced.inventoryActionDelayMs, 100))
      const cartographyHumanDelayMs = Math.max(actionDelayMs, toNumber(advanced.postPrintCartographyHumanDelayMs, 1000))
      const cartographyOutputHumanDelayMs = Math.max(cartographyHumanDelayMs, toNumber(advanced.postPrintCartographyOutputHumanDelayMs, 1500))
      const pollMs = Math.max(50, toNumber(advanced.postPrintCartographyPollMs, 100))
      const clickTicks = Math.max(2, toNumber(advanced.postPrintCartographyClickWaitTicks, 4))
      const outputSettleTicks = Math.max(10, toNumber(advanced.postPrintCartographyOutputSettleTicks, 20))
      const cartographyAccessRange = Math.max(0.35, toNumber(advanced.postPrintCartographyAccessRange, 0.85))
      const maxAttempts = Math.max(1, toNumber(advanced.postPrintCartographyAttempts, 1))
      let lastWindowState = ''
      let lockedMapTaken = false
      let lockedMapConfirmedInWindow = false

      const cartographySafeMode = shouldUseLatencySafeMode(bot, config, 'cartography').active
      console.log(`[CARTO] start useApi=${advanced.postPrintCartographyUseApi !== false && !cartographySafeMode} attempts=${maxAttempts} accessRange=${cartographyAccessRange} clickTicks=${clickTicks} humanDelayMs=${cartographyHumanDelayMs} outputHumanDelayMs=${cartographyOutputHumanDelayMs} outputSettleTicks=${outputSettleTicks} safeMode=${cartographySafeMode} ${formatCartographyBotState(bot, config)}`)
      if (advanced.postPrintCartographyUseApi !== false && !cartographySafeMode) {
        try {
          const apiLocked = await lockMapWithCartographyApi(bot, config, cartographyConfig, advanced, {
            clickTicks,
            outputSettleTicks,
            outputWaitMs,
            pollMs
          })
          if (apiLocked === true) {
            lockedMapTaken = true
            lockedMapConfirmedInWindow = true
            console.log('[CARTO] API path completed cartography lock.')
          } else if (apiLocked === null) {
            console.log('[POSTPRINT] Mineflayer cartography API unavailable; using guarded manual cartography clicks.')
          }
        } catch (err) {
          const message = String(err?.message || err || '')
          if (message.includes('Missing cartography API method')) {
            console.log(`[POSTPRINT-WARN] ${message}; using guarded manual cartography clicks.`)
          } else {
            throw err
          }
        }
      }

      for (let attempt = 1; attempt <= maxAttempts && !lockedMapTaken; attempt += 1) {
        checkPostPrintStop('cartography')
        let window = null
        try {
          console.log(`[CARTO-MANUAL] attempt=${attempt}/${maxAttempts} begin ${formatCartographyBotState(bot, config)}`)
          const filledMapForTable = findInventoryItemByType(bot, 'filled_map')
          if (!filledMapForTable) {
            throw new Error('No filled map available for cartography step.')
          }
          console.log(`[CARTO-MANUAL] attempt=${attempt} material map=${formatWindowStack(filledMapForTable)} locked=${isFilledMapKnownLocked(filledMapForTable)} paneCount=${countInventoryItems(bot, 'glass_pane')}`)
          if (isFilledMapKnownLocked(filledMapForTable)) {
            console.log('[POSTPRINT] Filled map already appears locked; skipping cartography lock input and continuing to rename/store.')
            lockedMapTaken = true
            lockedMapConfirmedInWindow = true
            break
          }

          assertLivePlatformReady(bot, config, `postprint-cartography-attempt-${attempt}:before-open`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} opening table target=${formatCoordTriplet(cartographyConfig.position)} access=${formatCoordTriplet(cartographyConfig.accessPosition)}`)
          window = await openBlockWindowAt(bot, cartographyConfig.position, cartographyConfig.accessPosition, {
            config,
            reason: `postprint-cartography-attempt-${attempt}`,
            accessRange: cartographyAccessRange,
            strictAccess: true,
            blockWaitMs: Math.max(1000, toNumber(advanced.postPrintMachineBlockWaitMs, 10000)),
            blockPollMs: pollMs,
            expectedNames: ['cartography_table']
          })
          console.log(`[CARTO-MANUAL] attempt=${attempt} opened window type=${window?.type || 'unknown'} id=${window?.id ?? 'n/a'} ${formatCartographyWindowState(window)}`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} human-delay after-open ms=${cartographyHumanDelayMs}`)
          await delay(cartographyHumanDelayMs)
          await waitBotTicks(bot, clickTicks)
          assertLivePlatformReady(bot, config, `postprint-cartography-attempt-${attempt}:after-open`)
          await assertWindowCursorEmpty(window, `postprint-cartography-attempt-${attempt}:after-open`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} after-open ${formatCartographyWindowState(window)} ${formatCartographyBotState(bot, config)}`)

          const filledMapSlot = findWindowInventorySlot(window, bot, 'filled_map')
          let paneSlot = findWindowInventorySlot(window, bot, 'glass_pane')
          console.log(`[CARTO-MANUAL] attempt=${attempt} source-slots filledMapSlot=${filledMapSlot} paneSlot=${paneSlot}`)
          if (filledMapSlot < 0 || paneSlot < 0) {
            const filledMapId = getItemId(bot, 'filled_map')
            const paneId = getItemId(bot, 'glass_pane')
            throw new Error(
              'Missing filled map or glass pane in cartography window inventory: ' +
              `filledMapSlot=${filledMapSlot} paneSlot=${paneSlot} ` +
              `botFilled=${countInventoryByType(bot, 'filled_map')} botPane=${countInventoryItems(bot, 'glass_pane')} ` +
              `windowFilled=${countWindowInventoryItems(window, filledMapId, 'filled_map')} ` +
              `windowPane=${countWindowInventoryItems(window, paneId, 'glass_pane')} ` +
              `windowRange=${window?.inventoryStart ?? 'n/a'}-${window?.inventoryEnd ?? 'n/a'}`
            )
          }

          assertLivePlatformReady(bot, config, `postprint-cartography-attempt-${attempt}:before-map-input`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} before-map-input mode=nerv-quick-move from=${filledMapSlot} to=0 ${formatCartographyWindowState(window)}`)
          const inputMapReady = await quickMoveCartographyInputConfirmed(bot, window, filledMapSlot, 0, 'filled_map', outputWaitMs, pollMs, clickTicks)
          console.log(`[CARTO-MANUAL] attempt=${attempt} human-delay after-map-input ms=${cartographyHumanDelayMs}`)
          await delay(cartographyHumanDelayMs)
          assertLivePlatformReady(bot, config, `postprint-cartography-attempt-${attempt}:after-map-input`)
          await assertWindowCursorEmpty(window, `postprint-cartography-attempt-${attempt}:after-map-input`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} after-map-input ready=${inputMapReady} ${formatCartographyWindowState(window)} ${formatCartographyBotState(bot, config)}`)
          paneSlot = findWindowInventorySlot(window, bot, 'glass_pane')
          if (paneSlot < 0) {
            throw new Error('Glass pane disappeared before cartography input.')
          }
          assertLivePlatformReady(bot, config, `postprint-cartography-attempt-${attempt}:before-pane-input`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} before-pane-input mode=nerv-quick-move from=${paneSlot} to=1 ${formatCartographyWindowState(window)}`)
          const inputPaneReady = await quickMoveCartographyInputConfirmed(bot, window, paneSlot, 1, 'glass_pane', outputWaitMs, pollMs, clickTicks)
          console.log(`[CARTO-MANUAL] attempt=${attempt} human-delay after-pane-input ms=${cartographyHumanDelayMs}`)
          await delay(cartographyHumanDelayMs)
          assertLivePlatformReady(bot, config, `postprint-cartography-attempt-${attempt}:after-pane-input`)
          await assertWindowCursorEmpty(window, `postprint-cartography-attempt-${attempt}:after-pane-input`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} after-pane-input ready=${inputPaneReady} ${formatCartographyWindowState(window)} ${formatCartographyBotState(bot, config)}`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} waiting-output ticks=${outputSettleTicks}`)
          await waitBotTicks(bot, outputSettleTicks)
          const outputStack = await waitForWindowSlot(window, 2, (stack) => stack && toNumber(stack.count, 0) > 0, outputWaitMs, pollMs)
          lastWindowState = `in0=${formatWindowStack(window?.slots?.[0])} in1=${formatWindowStack(window?.slots?.[1])} out=${formatWindowStack(window?.slots?.[2])}`
          console.log(`[CARTO-MANUAL] attempt=${attempt} output-ready=${Boolean(outputStack)} ${formatCartographyWindowState(window)}`)

          if (!inputMapReady || !inputPaneReady || !outputStack) {
            const inputsPresent = window?.slots?.[0]?.name === 'filled_map' && window?.slots?.[1]?.name === 'glass_pane'
            if (inputMapReady && inputPaneReady && !outputStack && inputsPresent) {
              console.log(`[POSTPRINT-WARN] Cartography table accepted map + glass pane but produced no output: ${lastWindowState}. Treating the map as already locked/unlockable and continuing without retrying the lock.`)
              console.log(`[CARTO-MANUAL] attempt=${attempt} closing table to let server return accepted inputs; avoiding cursor reclaim clicks.`)
              lockedMapTaken = true
              lockedMapConfirmedInWindow = true
              break
            }
            console.log(`[CARTO-MANUAL] attempt=${attempt} incomplete output. inputMapReady=${inputMapReady} inputPaneReady=${inputPaneReady} outputReady=${Boolean(outputStack)}; closing instead of cursor reclaiming.`)
            if (attempt < maxAttempts) {
              console.log(`[POSTPRINT-WARN] Cartography output not ready on attempt ${attempt}/${maxAttempts}: ${lastWindowState}. Reopening table and retrying.`)
              try { window.close() } catch { }
              window = null
              await delay(Math.max(250, toNumber(advanced.postPrintInteractionDelayMs, 200)))
              continue
            }
            throw new Error(`Cartography output not ready after ${maxAttempts} attempt(s): ${lastWindowState}`)
          }

          const filledMapId = getItemId(bot, 'filled_map')
          const mapsBeforeOutput = countWindowInventoryItems(window, filledMapId, 'filled_map')
          assertLivePlatformReady(bot, config, `postprint-cartography-attempt-${attempt}:before-output`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} human-delay before-output ms=${cartographyOutputHumanDelayMs}`)
          await delay(cartographyOutputHumanDelayMs)
          assertLivePlatformReady(bot, config, `postprint-cartography-attempt-${attempt}:before-output-after-delay`)
          console.log(`[CARTO-MANUAL] attempt=${attempt} taking-output mode=nerv-quick-move beforeWindowFilled=${mapsBeforeOutput} ${formatCartographyWindowState(window)}`)
          const outputTaken = await quickMoveCartographyOutputConfirmed(bot, window, mapsBeforeOutput, outputWaitMs, pollMs, clickTicks)
          assertLivePlatformReady(bot, config, `postprint-cartography-attempt-${attempt}:after-output`)
          await delay(toNumber(advanced.postPrintInteractionDelayMs, 200))
          console.log(`[CARTO-MANUAL] attempt=${attempt} after-output outputTaken=${outputTaken} ${formatCartographyWindowState(window)} ${formatCartographyBotState(bot, config)}`)

          if (!outputTaken) {
            throw new Error(`Cartography output click did not return filled_map to inventory: ${lastWindowState}`)
          }
          lockedMapTaken = true
          lockedMapConfirmedInWindow = true
        } finally {
          if (window && typeof window.close === 'function') {
            try {
              window.close()
              console.log(`[CARTO-MANUAL] attempt=${attempt} window closed ${formatCartographyBotState(bot, config)}`)
            } catch { }
          }
        }
      }

      if (!lockedMapConfirmedInWindow && countInventoryByType(bot, 'filled_map') <= 0) {
        await waitForInventoryCountChangeOrTarget(
          bot,
          'filled_map',
          0,
          1,
          Math.max(500, toNumber(advanced.postPrintChestSyncWaitMs, 2500)),
          Math.max(50, toNumber(advanced.postPrintChestPollMs, 100)),
          Math.max(50, toNumber(advanced.inventoryActionDelayMs, 100))
        )
      }
      if (!lockedMapConfirmedInWindow && countInventoryByType(bot, 'filled_map') <= 0) {
        throw new Error('No filled map found in inventory after taking cartography output.')
      }

      cartographySucceeded = true
      console.log(`[CARTO] complete lockedMapTaken=${lockedMapTaken} confirmed=${lockedMapConfirmedInWindow} ${formatCartographyBotState(bot, config)}`)
      savePostPrintStep('rename_store', 'cartography-complete', { postPrintCartographyComplete: true })
    } catch (err) {
      return failPostPrint('cartography', `Cartography step failed: ${err?.message || err}`)
    }
  } else if (shouldRunStep('cartography')) {
    if (advanced.postPrintUseCartographyEnabled === false) cartographySucceeded = true
    if (advanced.postPrintUseCartographyEnabled !== false && !cartographyConfig?.position && hasFilledMap) {
      return failPostPrint('cartography', 'Cartography table is not configured for post-print map locking.')
    }
    savePostPrintStep('rename_store', 'cartography-skipped')
  }

  if (shouldRunStep('rename_store') && cartographySucceeded) {
    checkPostPrintStop('rename_store')
    setPostPrintStatus('rename_store')
    await waitForPlatformReady(bot, config, 'postprint-rename-store')

    if (countInventoryByType(bot, 'filled_map') <= 0) {
      const materializeWaitMs = Math.max(500, toNumber(advanced.postPrintInventoryMaterializeWaitMs, 6000))
      const materializePollMs = Math.max(50, toNumber(advanced.postPrintChestPollMs, 100))
      await waitForInventoryCountChangeOrTarget(
        bot,
        'filled_map',
        0,
        1,
        materializeWaitMs,
        materializePollMs,
        Math.max(50, toNumber(advanced.inventoryActionDelayMs, 100))
      )
      if (countInventoryByType(bot, 'filled_map') <= 0) {
        return failPostPrint('rename_store', 'Cartography output was confirmed in the table window, but the filled map is not visible in bot inventory for rename/store yet.')
      }
    }

    await refillXpForPostPrint(bot, config)
    const renamedTarget = await renameFinishedMap(bot, config, anvilConfig, context.sourceName)

    if (advanced.postPrintRenameMapEnabled !== false && advanced.postPrintRequireRenameBeforeStore !== false && !renamedTarget) {
      return failPostPrint('rename_store', 'Rename is required before store, but no verified renamed map exists.')
    }

    if (advanced.postPrintStoreFinishedMapEnabled !== false && finishedChestPos) {
      const filledMapId = getItemId(bot, 'filled_map')
      const filledMaps = bot.inventory.items().filter((entry) => entry.type === filledMapId)
      let mapsToStore = filledMaps

      if (!filledMaps.length) {
        return failPostPrint('rename_store', 'No filled map found to store after cartography.')
      }

      if (advanced.postPrintRenameMapEnabled !== false && advanced.postPrintRequireRenameBeforeStore !== false) {
        mapsToStore = filledMaps.filter((entry) => isMapNamed(entry, renamedTarget))
        const unverifiedCount = filledMaps.length - mapsToStore.length
        if (unverifiedCount > 0) {
          console.log(`[POSTPRINT-WARN] Leaving ${unverifiedCount} unverified filled map(s) in inventory; only storing verified renamed maps.`)
        }
      }

      if (!mapsToStore.length && filledMaps.length > 0) {
        if (advanced.postPrintRequireRenameBeforeStore !== false) {
          return failPostPrint('rename_store', 'No verified filled map selected for storage.')
        }
        console.log('[POSTPRINT-WARN] No verified renamed map selected, but strict rename-store is disabled. Storing all filled maps anyway.')
        mapsToStore = filledMaps
      }

      for (const stack of mapsToStore) {
        checkPostPrintStop('rename_store')
        if (stack.count <= 0) continue
        const hints = getItemNameHints(stack)
        if (hints.length) {
          console.log(`[POSTPRINT-DEBUG] Depositing map with name hints: ${hints.join(' | ')}`)
        }
        const stored = await depositToChest(bot, config, finishedChestPos, 'filled_map', stack.count, machine.finishedMapChest?.accessPosition)
        if (!stored) {
          return failPostPrint('rename_store', 'Could not store finished filled map in output chest.')
        }
      }
    }

    savePostPrintStep('reset', 'map-renamed-and-stored')
  } else if (shouldRunStep('rename_store') && advanced.postPrintUseCartographyEnabled !== false) {
    return failPostPrint('rename_store', 'Skipping XP refill and rename because cartography did not complete.')
  } else if (shouldRunStep('rename_store')) {
    savePostPrintStep('reset', 'rename-store-disabled')
  }

  const shouldInteractReset = advanced.postPrintResetEnabled !== false
    && resetConfig?.position
    && advanced.postPrintSkipResetInteraction !== true

  if (shouldRunStep('reset') && shouldInteractReset) {
    checkPostPrintStop('reset')
    setPostPrintStatus('reset')
    try {
      await interactWithConfiguredBlock(bot, config, resetConfig, 'reset-block')
    } catch (err) {
      return failPostPrint('reset', `Reset step failed: ${err?.message || err}`)
    }
    savePostPrintStep('center', 'reset-complete')
    if (isRuntimeStopRequested(config)) {
      savePostPrintStep('center', 'dashboard-stop-after-reset')
      assertRuntimeContinue(bot, config, 'pausing-after-reset')
    }
  } else if (shouldRunStep('reset') && advanced.postPrintSkipResetInteraction === true && resetConfig?.position) {
    console.log('[POSTPRINT] Reset interaction skipped by config. Walking to center step directly.')
    savePostPrintStep('center', 'reset-skipped-by-config')
  } else if (shouldRunStep('reset')) {
    savePostPrintStep('center', 'reset-unavailable')
  }

  if (shouldRunStep('center') && advanced.postPrintWalkToCenter !== false) {
    checkPostPrintStop('center')
    setPostPrintStatus('center')
    const center = getMapCenterPosition(config)

    try {
      await waitForPlatformReady(bot, config, 'postprint-center')
      await bot.pathfinder.goto(new GoalNear(center.x, center.y, center.z, 1))
      const centerWaitMs = Math.max(0, toNumber(advanced.postPrintCenterWaitMs, 3000))
      if (centerWaitMs > 0) {
        console.log(`[POSTPRINT] Waiting at center for ${centerWaitMs}ms.`)
        await delay(centerWaitMs)
      }
    } catch (err) {
      return failPostPrint('center', `Walk-to-center step failed: ${err?.message || err}`)
    }
    savePostPrintStep('done', 'center-complete')
  } else if (shouldRunStep('center')) {
    savePostPrintStep('done', 'center-skipped')
  }

  if (isRuntimeStopRequested(config)) {
    savePostPrintStep('done', 'dashboard-stop-after-reset')
    assertRuntimeContinue(bot, config, 'pausing-after-reset')
  }

  return { completed: true, finalStep: 'done' }
}

async function runPostPrintWorkflowWithRecovery(bot, config, makeContext, initialStep = 'withdraw', options = {}) {
  const advanced = config.advanced || {}
  const maxRecoveryAttempts = Math.max(0, toNumber(advanced.postPrintWorkflowRecoveryAttempts, 1))
  const recoveryDelayMs = Math.max(250, toNumber(advanced.postPrintWorkflowRecoveryDelayMs, 1500))
  const label = options.label || 'post-print'
  let resumeStep = initialStep

  for (let attempt = 0; attempt <= maxRecoveryAttempts; attempt += 1) {
    const result = await runPostPrintWorkflow(bot, config, makeContext({ resumePostPrintStep: resumeStep }))
    if (result?.completed) return result

    const failedStep = result?.failedStep || resumeStep || 'unknown'
    if (attempt >= maxRecoveryAttempts) return result

    console.log(`[POSTPRINT-RECOVER] ${label} blocked at step=${failedStep}. Retrying that step (${attempt + 1}/${maxRecoveryAttempts}) after ${recoveryDelayMs}ms.`)
    stopBotMovement(bot)
    await delay(recoveryDelayMs)
    await waitForPlatformReady(bot, config, `postprint-recover-${failedStep}`)
    resumeStep = failedStep
  }

  return { completed: false, failedStep: resumeStep }
}

function countInventoryItems(bot, itemName) {
  const inventory = bot.inventory || {}
  const slots = Array.isArray(inventory.slots) ? inventory.slots : []
  const start = Number.isFinite(inventory.inventoryStart) ? inventory.inventoryStart : 9
  const end = Number.isFinite(inventory.inventoryEnd) ? inventory.inventoryEnd : Math.min(slots.length, 45)
  let count = 0

  for (let slotIndex = start; slotIndex < end; slotIndex += 1) {
    const stack = slots[slotIndex]
    if (stack?.name === itemName) {
      count += toNumber(stack.count, 0)
    }
  }

  return count
}

async function waitForInventoryCountChangeOrTarget(bot, itemName, beforeCount, targetCount, timeoutMs, pollMs = 100, settleMs = 150) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let latest = countInventoryItems(bot, itemName)
  if (latest >= targetCount) return latest
  if (latest > beforeCount) {
    const settleDeadline = Date.now() + Math.max(0, settleMs)
    while (Date.now() < settleDeadline && latest < targetCount) {
      await delay(Math.min(Math.max(25, pollMs), Math.max(25, settleDeadline - Date.now())))
      latest = countInventoryItems(bot, itemName)
    }
    return latest
  }

  while (Date.now() < deadline) {
    await delay(Math.min(Math.max(25, pollMs), Math.max(25, deadline - Date.now())))
    latest = countInventoryItems(bot, itemName)
    if (latest >= targetCount) return latest
    if (latest > beforeCount) {
      const settleDeadline = Date.now() + Math.max(0, settleMs)
      while (Date.now() < settleDeadline && latest < targetCount) {
        await delay(Math.min(Math.max(25, pollMs), Math.max(25, settleDeadline - Date.now())))
        latest = countInventoryItems(bot, itemName)
      }
      return latest
    }
  }

  return countInventoryItems(bot, itemName)
}

function isProtectedInventoryItem(config, itemName) {
  const name = String(itemName || '').replace(/^minecraft:/, '')
  if (!name) return true

  const advanced = config?.advanced || {}
  const protectedNames = new Set([
    String(advanced.autoEatFoodItem || 'cooked_beef').replace(/^minecraft:/, ''),
    'experience_bottle',
    'map',
    'filled_map',
    'glass_pane'
  ])

  return protectedNames.has(name)
}

function isDumpableInventoryItem(config, itemName, materialNames = new Set()) {
  const name = String(itemName || '').replace(/^minecraft:/, '')
  if (!name || materialNames.has(name)) return false
  return !isProtectedInventoryItem(config, name)
}

function getBuildMaterialSlotCapacity(bot, config = null, targets = []) {
  const inventory = bot.inventory || {}
  const { start, end } = getInventorySlotBounds(bot)
  const materialNames = config ? getKnownBuildMaterials(config, targets) : new Set()
  let capacity = 0

  for (let i = start; i < end; i += 1) {
    const slot = inventory.slots[i]
    const name = String(slot?.name || '').replace(/^minecraft:/, '')
    if (!slot || materialNames.has(name) || (!config && name.endsWith('_carpet')) || (config && isDumpableInventoryItem(config, name, materialNames))) {
      capacity += 1
    }
  }

  return Math.max(1, capacity)
}

function countRequiredStacks(neededByBlock, bot) {
  let stacks = 0
  for (const [blockName, needed] of neededByBlock.entries()) {
    const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[blockName]?.stackSize, 64))
    const count = Math.max(0, toNumber(needed, 0))
    if (count <= 0) continue
    stacks += Math.ceil(count / stackSize)
  }
  return stacks
}

function getInventorySlotBounds(bot) {
  const inventory = bot.inventory || {}
  const start = Number.isFinite(inventory.inventoryStart) ? inventory.inventoryStart : 9
  const end = Number.isFinite(inventory.inventoryEnd) ? inventory.inventoryEnd : 45
  return { start, end }
}

function getKnownBuildMaterials(config, targets = []) {
  const materialNames = new Set()
  const materialDict = config.machine?.materialDict || {}

  for (const key of Object.keys(materialDict)) {
    const normalized = String(key || '').replace(/^minecraft:/, '')
    if (normalized) materialNames.add(normalized)
  }

  for (const target of targets) {
    if (target?.blockName) materialNames.add(target.blockName)
  }

  return materialNames
}

function getNervAvailableSlots(bot, config, targets = []) {
  const materialNames = getKnownBuildMaterials(config, targets)
  const { start, end } = getInventorySlotBounds(bot)
  const availableSlots = []

  for (let slotIndex = start; slotIndex < end; slotIndex += 1) {
    const stack = bot.inventory.slots[slotIndex]
    const name = String(stack?.name || '').replace(/^minecraft:/, '')
    if (!stack || materialNames.has(name) || isDumpableInventoryItem(config, name, materialNames)) {
      availableSlots.push({ slotIndex, stack: stack || null })
    }
  }

  return availableSlots
}

function stacksRequiredFromAmounts(amounts, bot, requiredItems = null) {
  let stacks = 0
  const entries = requiredItems instanceof Map ? [...requiredItems.entries()] : null

  if (entries) {
    for (const [blockName, amount] of entries) {
      const count = Math.max(0, toNumber(amount, 0))
      if (count <= 0) continue
      const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[blockName]?.stackSize, 64))
      stacks += Math.ceil(count / stackSize)
    }
    return stacks
  }

  for (const amount of amounts) {
    const count = Math.max(0, toNumber(amount, 0))
    if (count > 0) stacks += Math.ceil(count / 64)
  }
  return stacks
}

function buildNervTargetGrid(targets) {
  const byColRow = new Map()
  const cols = new Set()
  const rows = new Set()

  for (const target of targets) {
    cols.add(target.col)
    rows.add(target.row)
    byColRow.set(`${target.col}:${target.row}`, target)
  }

  return {
    byColRow,
    cols: [...cols].sort((a, b) => a - b),
    rows: [...rows].sort((a, b) => a - b)
  }
}

function selectInventoryPlanningTargets(targets, config) {
  const advanced = config.advanced || {}
  const rowLimit = Math.max(1, toNumber(advanced.inventoryRefillRows, 2))
  const maxMaterialTypes = Math.max(1, Math.min(16, toNumber(advanced.inventoryMaxMaterialTypes, 16)))
  const selectedRows = new Set()
  const selectedMaterials = new Set()
  const selectedTargets = []

  for (const target of targets) {
    if (!target) continue

    const isKnownRow = selectedRows.has(target.row)
    if (!isKnownRow && selectedRows.size >= rowLimit) continue

    const material = target.blockName
    const isKnownMaterial = selectedMaterials.has(material)
    if (!isKnownMaterial && selectedMaterials.size >= maxMaterialTypes) continue

    selectedRows.add(target.row)
    selectedMaterials.add(material)
    selectedTargets.push(target)
  }

  return {
    targets: selectedTargets,
    rows: [...selectedRows],
    materials: [...selectedMaterials]
  }
}

function selectInventoryPlanningTargetsFromPrintBatch(byColRow, colBatch, rowOrder, config) {
  const advanced = config.advanced || {}
  const lineLimit = getInventoryManagedLinesPerRun(config, Math.max(1, toNumber(config.printer?.linesPerRun, 3)))
  const maxMaterialTypes = Math.max(1, Math.min(16, toNumber(advanced.inventoryMaxMaterialTypes, 16)))
  const selectedCols = colBatch.slice(0, Math.min(lineLimit, colBatch.length))
  const selectedMaterials = new Set()
  const selectedTargets = []

  for (const row of rowOrder) {
    for (const col of selectedCols) {
      const target = byColRow.get(`${col}:${row}`)
      if (!target) continue

      const material = target.blockName
      const isKnownMaterial = selectedMaterials.has(material)
      if (!isKnownMaterial && selectedMaterials.size >= maxMaterialTypes) continue

      selectedMaterials.add(material)
      selectedTargets.push(target)
    }
  }

  return {
    targets: selectedTargets,
    cols: selectedCols,
    materials: [...selectedMaterials]
  }
}

function getInventoryManagedLinesPerRun(config, linesPerRun) {
  const advanced = config.advanced || {}
  const refillRows = Math.max(1, toNumber(advanced.inventoryRefillRows, 2))
  const rowWidth = Math.max(1, toNumber(linesPerRun, 1))
  return Math.max(1, rowWidth * refillRows)
}

function getNervRequiredItems(bot, config, targets) {
  const maxMaterialTypes = Math.max(1, Math.min(16, toNumber(config.advanced?.inventoryMaxMaterialTypes, 16)))
  const useWorldState = config.advanced?.inventoryPlanUseWorldState === true
  const availableSlots = getNervAvailableSlots(bot, config, targets)
  const requiredItems = new Map()
  const Vec3 = bot.entity.position.constructor
  let inspected = 0
  let counted = 0
  let unloaded = 0

  // Process all targets in a single pass — traversal direction does not affect material counts,
  // so batching by linesPerRun is unnecessary and causes the capacity check to fire prematurely
  // at exactly the linesPerRun boundary instead of at the full window boundary.
  for (const target of targets) {
    if (!target) continue
    inspected += 1

    const targetPos = new Vec3(target.position.x, target.position.y, target.position.z)
    if (useWorldState) {
      const blockState = bot.blockAt(targetPos)
      if (!blockState) unloaded += 1
      if (blockState && blockState.name !== 'air') continue
    }

    const blockName = target.blockName
    if (!requiredItems.has(blockName) && requiredItems.size >= maxMaterialTypes) {
      return { requiredItems, availableSlots, inspected, counted, unloaded, capacitySlots: availableSlots.length }
    }
    requiredItems.set(blockName, (requiredItems.get(blockName) || 0) + 1)
    counted += 1

    if (stacksRequiredFromAmounts([], bot, requiredItems) > availableSlots.length) {
      const reverted = Math.max(0, (requiredItems.get(blockName) || 1) - 1)
      if (reverted > 0) requiredItems.set(blockName, reverted)
      else requiredItems.delete(blockName)
      counted -= 1
      return { requiredItems, availableSlots, inspected, counted, unloaded, capacitySlots: availableSlots.length }
    }
  }

  return { requiredItems, availableSlots, inspected, counted, unloaded, capacitySlots: availableSlots.length }
}

function getNervInventoryInformation(bot, requiredItems, availableSlots) {
  const remainingRequired = new Map(requiredItems)
  const dumpSlots = []
  const materialInInv = new Map()
  const slotsByMaterial = new Map()

  for (const slot of availableSlots) {
    const stack = slot.stack
    if (!stack) continue

    if (!remainingRequired.has(stack.name)) {
      dumpSlots.push(slot)
      continue
    }

    const list = slotsByMaterial.get(stack.name) || []
    list.push(slot)
    slotsByMaterial.set(stack.name, list)
  }

  for (const [blockName, slots] of slotsByMaterial.entries()) {
    let requiredAmount = Math.max(0, toNumber(remainingRequired.get(blockName), 0))

    slots.sort((a, b) => {
      const ac = Math.max(0, toNumber(a.stack?.count, 0))
      const bc = Math.max(0, toNumber(b.stack?.count, 0))
      return ac - bc
    })

    for (const slot of slots) {
      const stackAmount = Math.max(0, toNumber(slot.stack?.count, 0))
      if (requiredAmount > 0) {
        requiredAmount = Math.max(0, requiredAmount - stackAmount)
        materialInInv.set(blockName, (materialInInv.get(blockName) || 0) + stackAmount)
      } else {
        dumpSlots.push(slot)
      }
    }

    remainingRequired.set(blockName, requiredAmount)
  }

  return { dumpSlots, materialInInv, remainingRequired }
}

function buildNervInventoryPlan(bot, config, targets) {
  const required = getNervRequiredItems(bot, config, targets)
  const invInfo = getNervInventoryInformation(bot, required.requiredItems, required.availableSlots)
  const restockList = []

  for (const [blockName, requiredAmount] of required.requiredItems.entries()) {
    const keptAmount = invInfo.materialInInv.get(blockName) || 0
    const deficit = Math.max(0, requiredAmount - keptAmount)
    if (deficit <= 0) continue
    const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[blockName]?.stackSize, 64))
    restockList.unshift({
      blockName,
      rawAmount: deficit,
      stacks: Math.ceil(deficit / stackSize)
    })
  }

  return {
    ...required,
    dumpSlots: invInfo.dumpSlots,
    materialInInv: invInfo.materialInInv,
    remainingRequired: invInfo.remainingRequired,
    restockList
  }
}

function buildNervInventoryPlanFromRequired(bot, config, targets, requiredItems, requiredMeta = {}) {
  const availableSlots = getNervAvailableSlots(bot, config, targets)
  const stableRequiredItems = new Map(requiredItems)
  const invInfo = getNervInventoryInformation(bot, stableRequiredItems, availableSlots)
  const restockList = []

  for (const [blockName, requiredAmount] of stableRequiredItems.entries()) {
    const keptAmount = invInfo.materialInInv.get(blockName) || 0
    const deficit = Math.max(0, requiredAmount - keptAmount)
    if (deficit <= 0) continue
    const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[blockName]?.stackSize, 64))
    restockList.unshift({
      blockName,
      rawAmount: deficit,
      stacks: Math.ceil(deficit / stackSize)
    })
  }

  return {
    requiredItems: stableRequiredItems,
    availableSlots,
    inspected: toNumber(requiredMeta.inspected, 0),
    counted: toNumber(requiredMeta.counted, 0),
    unloaded: toNumber(requiredMeta.unloaded, 0),
    capacitySlots: availableSlots.length,
    dumpSlots: invInfo.dumpSlots,
    materialInInv: invInfo.materialInInv,
    remainingRequired: invInfo.remainingRequired,
    restockList
  }
}

function estimateNeededFromTargetsLimitedByCapacity(targets, bot, capacityOverride, config = null) {
  const neededByBlock = new Map()
  const capacitySlots = (capacityOverride != null) ? capacityOverride : getBuildMaterialSlotCapacity(bot, config, targets)

  for (const target of targets) {
    const name = target.blockName
    neededByBlock.set(name, (neededByBlock.get(name) || 0) + 1)
    if (countRequiredStacks(neededByBlock, bot) > capacitySlots) {
      const reverted = Math.max(0, (neededByBlock.get(name) || 1) - 1)
      if (reverted > 0) {
        neededByBlock.set(name, reverted)
      } else {
        neededByBlock.delete(name)
      }
      break
    }
  }

  return neededByBlock
}

function getDumpableCarpetStacks(bot, neededByBlock = new Map()) {
  const remainingNeeded = new Map()
  for (const [blockName, needed] of neededByBlock.entries()) {
    remainingNeeded.set(blockName, Math.max(0, toNumber(needed, 0)))
  }

  const dumpable = []
  for (const stack of bot.inventory.items()) {
    const name = String(stack?.name || '')
    if (!name.endsWith('_carpet')) continue

    const remaining = remainingNeeded.get(name) || 0
    if (remaining > 0) {
      remainingNeeded.set(name, Math.max(0, remaining - toNumber(stack.count, 0)))
      continue
    }

    dumpable.push(stack)
  }

  return dumpable
}

async function dumpCarpetStacks(bot, config, stacks, reasonLabel = 'dumpedStacks', lockHeld = false) {
  if (!lockHeld && config.multiUser?.runtime?.enabled === true) {
    return await withMultiDumpLock(config, async () => dumpCarpetStacks(bot, config, stacks, reasonLabel, true))
  }

  const dumpStations = buildDumpStations(config)
  if (!stacks.length) return 0

  if (!dumpStations.length) {
    console.log(`[PREDUMP-WARN] Found ${stacks.length} dumpable carpet stacks, but dump station is not configured/enabled.`)
    return 0
  }

  const sortedStations = [...dumpStations].sort((a, b) => horizontalDist2(bot, a.position) - horizontalDist2(bot, b.position))
  let targetStation = null
  let dumpPos = null
  let lastReachError = null

  for (const station of sortedStations) {
    const stationPos = station?.position
    if (!stationPos) continue
    try {
      await reachDumpStation(bot, config, station, 0.5)
      targetStation = station
      dumpPos = stationPos
      break
    } catch (err) {
      lastReachError = err
      console.log(`[PREDUMP-WARN] Could not reach dump station ${stationPos.x} ${stationPos.y} ${stationPos.z}: ${err?.message || err}`)
    }
  }

  if (!targetStation || !dumpPos) {
    console.log(`[PREDUMP-WARN] Could not reach any dump station: ${lastReachError?.message || lastReachError || 'no reachable station'}`)
    return 0
  }

  const aim = minecraftYawPitchToMineflayerRadians(targetStation?.yaw, targetStation?.pitch, config.advanced || {})
  const yawDeg = aim?.yawDeg ?? null
  const pitchDeg = aim?.pitchDeg ?? null
  const botYawDeg = normalizeAngleDegrees(180 - (bot.entity.yaw * 180 / Math.PI))
  const botPitchDeg = -(bot.entity.pitch * 180 / Math.PI)
  const reaimEvery = Math.max(0, toNumber(config.advanced?.dumpReaimEveryStacks, 0))
  console.log(`[PREDUMP-AIM] Bot at ${bot.entity.position.x.toFixed(2)}, ${bot.entity.position.y.toFixed(2)}, ${bot.entity.position.z.toFixed(2)} | yaw=${yawDeg ?? 'null'} pitch=${pitchDeg ?? 'null'} | botYaw=${botYawDeg?.toFixed(2) ?? 'null'}deg botPitch=${botPitchDeg.toFixed(2)}`)

  let dumped = 0
  for (const stack of stacks) {
    try {
      if (reaimEvery > 0 && dumped > 0 && dumped % reaimEvery === 0) {
        await maintainDumpAim(bot, config, targetStation)
      }
      await bot.tossStack(stack)
      dumped += 1
      await delay(toNumber(config.advanced?.inventoryActionDelayMs, 100))
    } catch (err) {
      if (config.advanced?.debugPrints) {
        console.log(`[PREDUMP-DEBUG] ${stack?.name || 'unknown'} -> ${err?.message || err}`)
      }
    }
  }

  if (dumped > 0) {
    console.log(`[PREDUMP] ${reasonLabel}=${dumped} at ${dumpPos.x} ${dumpPos.y} ${dumpPos.z} yaw=${targetStation?.yaw ?? 'n/a'} pitch=${targetStation?.pitch ?? 'n/a'}`)
  }

  return dumped
}

async function dumpAssignedChestCleanupItems(bot, config, removedItems, targetName) {
  const action = String(config.advanced?.cleanAssignedMaterialChestAction || 'dump').toLowerCase().trim()
  if (action === 'none' || action === 'inventory-only' || !Array.isArray(removedItems) || removedItems.length <= 0) return 0
  if (action !== 'dump') {
    console.log(`[CHEST-CLEANUP-WARN] ${targetName}: unsupported cleanup action=${action}; keeping removed unwanted items in inventory.`)
    return 0
  }

  const remainingByName = new Map()
  for (const item of removedItems) {
    const name = String(item?.name || '').replace(/^minecraft:/, '')
    const count = Math.max(0, toNumber(item?.count, 0))
    if (!name || count <= 0) continue
    remainingByName.set(name, (remainingByName.get(name) || 0) + count)
  }
  if (!remainingByName.size) return 0

  const candidates = []
  for (const stack of bot.inventory.items()) {
    const name = String(stack?.name || '').replace(/^minecraft:/, '')
    let remaining = remainingByName.get(name) || 0
    if (remaining <= 0) continue
    candidates.push(stack)
    remaining -= Math.max(0, toNumber(stack?.count, 0))
    if (remaining > 0) remainingByName.set(name, remaining)
    else remainingByName.delete(name)
  }

  if (!candidates.length) return 0
  const dumped = await dumpCarpetStacks(bot, config, candidates, 'assignedChestCleanup')
  if (dumped > 0) {
    console.log(`[CHEST-CLEANUP] ${targetName}: dumped ${dumped} unwanted stack(s) removed from assigned material chest.`)
  }
  return dumped
}

async function dumpNervInventorySlots(bot, config, dumpSlots, reasonLabel = 'nervPredump') {
  const stacks = []
  for (const slot of dumpSlots) {
    const stack = bot.inventory.slots[slot.slotIndex]
    if (!stack) continue
    stacks.push(stack)
  }

  return await dumpCarpetStacks(bot, config, stacks, reasonLabel)
}

async function tossStackWithTimeout(bot, config, stack, reasonLabel = 'inventory-toss') {
  const timeoutMs = Math.max(250, toNumber(config.advanced?.inventoryTossTimeoutMs, toNumber(config.advanced?.retryInteractTimeoutMs, 800) * 2))
  await Promise.race([
    bot.tossStack(stack),
    (async () => {
      await delay(timeoutMs)
      throw new Error(`toss-timeout-${timeoutMs}ms`)
    })()
  ])
}

function inventoryHasRoomForItem(bot, itemName) {
  const itemInfo = bot.registry.itemsByName[itemName] || {}
  const stackSize = Math.max(1, toNumber(itemInfo.stackSize, 64))
  const inventory = bot.inventory || {}
  const { start, end } = getInventorySlotBounds(bot)

  for (let i = start; i < end; i += 1) {
    const slot = inventory.slots[i]
    if (!slot) return true
    if (slot.name === itemName && toNumber(slot.count, 0) < stackSize) return true
  }

  return false
}

function inventoryCapacityForItem(bot, itemName) {
  const itemInfo = bot.registry.itemsByName[itemName] || {}
  const stackSize = Math.max(1, toNumber(itemInfo.stackSize, 64))
  const inventory = bot.inventory || {}
  const slots = Array.isArray(inventory.slots) ? inventory.slots : []
  const { start, end } = getInventorySlotBounds(bot)
  let capacity = 0

  for (let i = start; i < end; i += 1) {
    const slot = slots[i]
    if (!slot) {
      capacity += stackSize
    } else if (slot.name === itemName) {
      capacity += Math.max(0, stackSize - toNumber(slot.count, 0))
    }
  }

  return capacity
}

async function waitForRestockInventoryReady(bot, config, blockName, beforeCount, targetCount, reason = 'restock') {
  const advanced = config.advanced || {}
  const expectedCount = Math.max(0, toNumber(targetCount, 0))
  const before = Math.max(0, toNumber(beforeCount, 0))
  const timeoutMs = Math.max(250, toNumber(advanced.restockPostCloseInventorySyncMs, toNumber(advanced.restockInventorySyncWaitMs, 2000)))
  const pollMs = Math.max(25, toNumber(advanced.restockSameChestRetryPollMs, 100))
  const settleMs = Math.max(0, toNumber(advanced.restockSameChestRetrySettleMs, 150))
  let haveNow = countInventoryItems(bot, blockName)

  if (haveNow < expectedCount && config.errorHandling?.logErrors !== false) {
    console.log(`[RESTOCK-SYNC-WAIT] ${blockName} reason=${reason} invHave=${haveNow} target=${expectedCount} before=${before} timeoutMs=${timeoutMs}`)
  }

  haveNow = await waitForInventoryCountChangeOrTarget(
    bot,
    blockName,
    Math.min(before, haveNow),
    expectedCount,
    timeoutMs,
    pollMs,
    settleMs
  )

  const inventoryItem = findBestInventorySlotForItem(bot, blockName)
  const selected = inventoryItem
    ? await selectHotbarMaterial(bot, config, blockName, { fastSwap: false })
    : false
  const ready = haveNow >= expectedCount && selectedMaterialMatches(bot, blockName)

  if (ready) {
    if (config.errorHandling?.logErrors !== false && haveNow > before) {
      console.log(`[RESTOCK-SYNC-OK] ${blockName} reason=${reason} invHave=${haveNow} target=${expectedCount} selected=${bot.heldItem?.name || 'empty'}`)
    }
    return true
  }

  if (config.errorHandling?.logErrors !== false) {
    const selectedName = getSelectedHotbarStack(bot)?.name || 'empty'
    console.log(`[RESTOCK-SYNC-WARN] ${blockName} reason=${reason} invHave=${haveNow} target=${expectedCount} selected=${selectedName} held=${bot.heldItem?.name || 'empty'} selectable=${Boolean(inventoryItem)}.`)
  }
  return false
}

function countEmptyInventorySlots(bot) {
  const inventory = bot.inventory || {}
  const slots = Array.isArray(inventory.slots) ? inventory.slots : []
  const { start, end } = getInventorySlotBounds(bot)
  let empty = 0

  for (let i = start; i < end; i += 1) {
    if (!slots[i]) empty += 1
  }

  return empty
}

function countPartialInventorySlotsForItem(bot, itemName) {
  const itemInfo = bot.registry.itemsByName[itemName] || {}
  const stackSize = Math.max(1, toNumber(itemInfo.stackSize, 64))
  const inventory = bot.inventory || {}
  const slots = Array.isArray(inventory.slots) ? inventory.slots : []
  const { start, end } = getInventorySlotBounds(bot)
  let partial = 0

  for (let i = start; i < end; i += 1) {
    const slot = slots[i]
    if (slot?.name === itemName && toNumber(slot.count, 0) < stackSize) {
      partial += 1
    }
  }

  return partial
}

function estimateDumpSlotsNeededForRestock(bot, restockList) {
  let emptySlots = countEmptyInventorySlots(bot)
  let dumpsNeeded = 0

  for (const item of restockList) {
    const stacks = Math.max(0, toNumber(item.stacks, 0))
    if (stacks <= 0) continue
    const partialSlots = countPartialInventorySlotsForItem(bot, item.blockName)
    const newSlotsNeeded = Math.max(0, stacks - partialSlots)
    const coveredByEmpty = Math.min(emptySlots, newSlotsNeeded)
    emptySlots -= coveredByEmpty
    dumpsNeeded += Math.max(0, newSlotsNeeded - coveredByEmpty)
  }

  return dumpsNeeded
}

async function dumpCarpetStacksForSpace(bot, config, keepNames = new Set(), maxStacks = 1, lockHeld = false) {
  if (!lockHeld && config.multiUser?.runtime?.enabled === true) {
    return await withMultiDumpLock(config, async () => dumpCarpetStacksForSpace(bot, config, keepNames, maxStacks, true))
  }

  const dumpStations = buildDumpStations(config)
  if (!dumpStations.length || maxStacks <= 0) return 0

  const carpetStacks = bot.inventory.items().filter((entry) => String(entry?.name || '').endsWith('_carpet'))
  if (!carpetStacks.length) return 0

  const preferred = carpetStacks.filter((entry) => !keepNames.has(entry.name))
  const candidates = (preferred.length ? preferred : carpetStacks)
    .slice()
    .sort((a, b) => toNumber(b.count, 0) - toNumber(a.count, 0))
    .slice(0, maxStacks)

  if (!candidates.length) return 0

  const sortedStations = [...dumpStations].sort((a, b) => horizontalDist2(bot, a.position) - horizontalDist2(bot, b.position))
  let targetStation = null
  let dumpPos = null
  let lastReachError = null

  for (const station of sortedStations) {
    const stationPos = station?.position
    if (!stationPos) continue
    try {
      await reachDumpStation(bot, config, station, 0.5)
      targetStation = station
      dumpPos = stationPos
      break
    } catch (err) {
      lastReachError = err
      console.log(`[PREDUMP-WARN] Could not reach dump station for space cleanup ${stationPos.x} ${stationPos.y} ${stationPos.z}: ${err?.message || err}`)
    }
  }

  if (!targetStation || !dumpPos) {
    console.log(`[PREDUMP-WARN] Could not reach any dump station for space cleanup: ${lastReachError?.message || lastReachError || 'no reachable station'}`)
    return 0
  }

  const reaimEvery = Math.max(0, toNumber(config.advanced?.dumpReaimEveryStacks, 0))
  let dumped = 0
  for (const stack of candidates) {
    try {
      if (reaimEvery > 0 && dumped > 0 && dumped % reaimEvery === 0) {
        await maintainDumpAim(bot, config, targetStation)
      }
      await tossStackWithTimeout(bot, config, stack, 'space-cleanup')
      dumped += 1
      await delay(toNumber(config.advanced?.inventoryActionDelayMs, 100))
    } catch (err) {
      if (config.errorHandling?.logErrors !== false) {
        console.log(`[PREDUMP-WARN] space-cleanup could not toss ${stack?.name || 'unknown'}x${toNumber(stack?.count, 0)}: ${err?.message || err}`)
      }
      if (config.advanced?.debugPrints) {
        console.log(`[PREDUMP-DEBUG] space-cleanup ${stack?.name || 'unknown'} -> ${err?.message || err}`)
      }
    }
  }

  if (dumped > 0) {
    console.log(`[PREDUMP] freedSpaceStacks=${dumped} at ${dumpPos.x} ${dumpPos.y} ${dumpPos.z}`)
  }

  return dumped
}

function estimateNeededFromLookahead(targets) {
  const neededByBlock = new Map()

  for (const target of targets) {
    const name = target.blockName
    neededByBlock.set(name, (neededByBlock.get(name) || 0) + 1)
  }

  return neededByBlock
}

async function ensureMaterialsForTargets(bot, config, targets, options = {}) {
  const advanced = config.advanced || {}
  if ((advanced.predictiveRestock === false && options.force !== true) || !targets.length) return true
  assertRuntimeContinue(bot, config, 'stopping-during-inventory-plan')

  const planning = options.windowed === true
    ? {
        targets,
        rows: options.rows || [],
        cols: options.cols || [],
        materials: options.materials || [...new Set(targets.map((target) => target?.blockName).filter(Boolean))]
      }
    : selectInventoryPlanningTargets(targets, config)
  const planningTargets = planning.targets
  if (!planningTargets.length) return true

  const maxIterations = Math.max(20, toNumber(advanced.nervInventoryMaxPlanIterations, 80))
  const stableRequired = getNervRequiredItems(bot, config, planningTargets)
  const stableBaseNeededByBlock = new Map(stableRequired.requiredItems)
  const configuredRestockBuffer = Math.max(0, toNumber(advanced.restockBufferItems, 10))

  // Preserve materials from upcoming windows: mark them as required for however much we
  // currently have in inventory so getNervInventoryInformation won't flag those slots as
  // dump candidates. This prevents pre-traversal dumps from discarding items that are
  // needed in the very next column batch.
  const preserveMaterials = options.preserveMaterials
  let activeRestockBuffer = configuredRestockBuffer
  const buildStableNeededByBlock = () => {
    const needed = new Map(stableBaseNeededByBlock)
    if (activeRestockBuffer > 0) {
      for (const [blockName, count] of needed.entries()) {
        needed.set(blockName, count + activeRestockBuffer)
      }
    }
    if (Array.isArray(preserveMaterials)) {
      for (const mat of preserveMaterials) {
        if (needed.has(mat)) continue
        const haveNow = countInventoryItems(bot, mat)
        if (haveNow > 0) needed.set(mat, haveNow)
      }
    }
    return needed
  }
  let stableNeededByBlock = buildStableNeededByBlock()

  if (config.advanced?.debugPrints) {
    const windowLabel = planning.cols?.length
      ? `cols=${planning.cols.join(',')}`
      : `rows=${planning.rows.join(',') || 'none'}`
    console.log(`[NERV-INVENTORY-WINDOW] ${windowLabel} materials=${planning.materials.length}/16 targets=${planningTargets.length}/${targets.length}`)
  }
  let safetyCounter = 0
  let didRestockThisWindow = false

  while (safetyCounter < maxIterations) {
    assertRuntimeContinue(bot, config, 'stopping-during-inventory-plan')
    safetyCounter++
    const plan = buildNervInventoryPlanFromRequired(bot, config, planningTargets, stableNeededByBlock, stableRequired)
    const neededByBlock = plan.requiredItems

    if (!neededByBlock.size) return true

    for (const blockName of neededByBlock.keys()) {
      unavailableMaterialCache.delete(blockName)
    }

    const restockList = plan.restockList.map((entry) => ({
      blockName: entry.blockName,
      needed: neededByBlock.get(entry.blockName) || entry.rawAmount,
      rawAmount: entry.rawAmount,
      stacks: entry.stacks
    }))

    if (config.advanced?.debugPrints) {
      console.log(`[NERV-INVENTORY] availableSlots=${plan.availableSlots.length} required=${formatInventoryPlanMap(plan.requiredItems)} keep=${formatInventoryPlanMap(plan.materialInInv)} dumpSlots=${plan.dumpSlots.length} restock=${formatRestockList(plan.restockList)}`)
    }

    if (!restockList.length) {
      if (!didRestockThisWindow && options.dumpWithoutRestock === true && advanced.dumpUnneededBeforeRefill !== false && plan.dumpSlots.length > 0) {
        console.log(`[NERV-DUMP] Dumping ${plan.dumpSlots.length} slot(s) before next chunk: ${formatDumpSlots(plan.dumpSlots)}`)
        const dumped = await dumpNervInventorySlots(bot, config, plan.dumpSlots, 'nervDumpBeforeNextChunk')
        if (dumped > 0) {
          await delay(toNumber(advanced.inventoryActionDelayMs, 100))
          continue
        }
        if (config.errorHandling?.logErrors !== false) {
          console.log('[NERV-DUMP-WARN] Optional before-next-chunk dump failed or timed out; continuing with current inventory.')
        }
      }
      return true
    }

    if (!didRestockThisWindow && advanced.dumpUnneededBeforeRefill !== false && plan.dumpSlots.length > 0) {
      const dumpsNeeded = options.dumpAllUnneededBeforeRestock === true
        ? plan.dumpSlots.length
        : Math.min(plan.dumpSlots.length, estimateDumpSlotsNeededForRestock(bot, restockList))
      if (dumpsNeeded > 0) {
        assertRuntimeContinue(bot, config, 'stopping-before-inventory-dump')
        const dumpSlots = plan.dumpSlots.slice(0, dumpsNeeded)
        console.log(`[NERV-DUMP] Dumping ${dumpSlots.length}/${plan.dumpSlots.length} slot(s) before restock: ${formatDumpSlots(dumpSlots)}`)
        const dumped = await dumpNervInventorySlots(bot, config, dumpSlots, 'nervPredumpBeforeRefill')
        if (dumped <= 0) return false
        await delay(toNumber(advanced.inventoryActionDelayMs, 100))
        continue
      }
    }

    let closestDist = Infinity
    let closestItem = null

    for (const item of restockList) {
      if (!shouldWaitForRequiredMaterialRestock(config) && restockFailureCache.has(item.blockName) && Date.now() - restockFailureCache.get(item.blockName) < Math.max(0, toNumber(advanced.restockFailureCooldownMs, 8000))) {
        continue
      }

      const groups = getMaterialChestGroupsForRefill(bot, config, item.blockName)
      if (!groups || !groups.length || !groups[0].length) continue

      const nearestChest = groups[0][0]
      const dist = horizontalDist2(bot, nearestChest)

      if (dist < closestDist) {
        closestDist = dist
        closestItem = item
      }
    }

    if (!closestItem) break

    const haveBefore = countInventoryItems(bot, closestItem.blockName)
    const pullsNeeded = Math.max(0, toNumber(closestItem.stacks, 0))

    if (pullsNeeded <= 0) continue

    console.log(`[NERV-RESTOCK] Closest material=${closestItem.blockName} dist=${Math.round(Math.sqrt(closestDist))} pullsRequested=${pullsNeeded} rawAmount=${closestItem.rawAmount}`)

    assertRuntimeContinue(bot, config, 'stopping-before-restock')
    const restocked = await waitForRequiredMaterialRestock(bot, config, closestItem.blockName, pullsNeeded, neededByBlock, 'inventory-window')

    if (!restocked) {
      const haveAfter = countInventoryItems(bot, closestItem.blockName)
      const stillNeed = Math.max(0, closestItem.needed - haveAfter)
      const remainingCapacity = inventoryCapacityForItem(bot, closestItem.blockName)
      const retryPlan = buildNervInventoryPlanFromRequired(bot, config, planningTargets, stableNeededByBlock, stableRequired)

      if (activeRestockBuffer > 0 && remainingCapacity < Math.max(1, toNumber(bot.registry.itemsByName[closestItem.blockName]?.stackSize, 64))) {
        const baseNeeded = Math.max(0, toNumber(stableBaseNeededByBlock.get(closestItem.blockName), 0))
        const maxCountWithoutExtraSlot = haveAfter + remainingCapacity
        const maxBufferWithoutExtraSlot = Math.max(0, maxCountWithoutExtraSlot - baseNeeded)
        const nextBuffer = Math.max(0, Math.min(activeRestockBuffer - 1, maxBufferWithoutExtraSlot))
        if (nextBuffer < activeRestockBuffer) {
          console.log(`[NERV-RESTOCK-BUFFER] ${closestItem.blockName} capacity blocked; capping restockBufferItems ${activeRestockBuffer}->${nextBuffer} for this inventory window to avoid an extra slot. have=${haveAfter} baseNeed=${baseNeeded} bufferedNeed=${closestItem.needed} capacity=${remainingCapacity}`)
          activeRestockBuffer = nextBuffer
          stableNeededByBlock = buildStableNeededByBlock()
          didRestockThisWindow = false
          await delay(toNumber(advanced.inventoryActionDelayMs, 100))
          continue
        }
      }

      if (advanced.dumpUnneededBeforeRefill !== false && retryPlan.dumpSlots.length > 0 && stillNeed > 0) {
        restockFailureCache.delete(closestItem.blockName)
        unavailableMaterialCache.delete(closestItem.blockName)
        const dumpsNeeded = Math.max(1, estimateDumpSlotsNeededForRestock(bot, [closestItem]))
        const dumpSlots = retryPlan.dumpSlots.slice(0, dumpsNeeded)
        console.log(`[NERV-RESTOCK-WARN] ${closestItem.blockName} needs ${stillNeed} more but capacity is ${remainingCapacity}; dumping ${dumpSlots.length} slot(s) before retry.`)
        const dumped = await dumpNervInventorySlots(bot, config, dumpSlots, 'nervCapacityRetryDump')
        if (dumped > 0) {
          didRestockThisWindow = false
          await delay(toNumber(advanced.inventoryActionDelayMs, 100))
          continue
        }
        if (stillNeed > remainingCapacity) {
          console.log(`[NERV-RESTOCK-WARN] ${closestItem.blockName} still needs ${stillNeed} but dump failed and capacity is only ${remainingCapacity}. Stopping refill.`)
          return false
        }
        continue
      }

      if (stillNeed > 0 && remainingCapacity < Math.max(1, toNumber(bot.registry.itemsByName[closestItem.blockName]?.stackSize, 64))) {
        console.log(`[NERV-RESTOCK-WARN] ${closestItem.blockName} still needs ${stillNeed}, but only partial-stack capacity ${remainingCapacity} is available and no buffer/dump recovery applied. Stopping refill cycle.`)
        return false
      }

      if (stillNeed > remainingCapacity) {
        console.log(`[NERV-RESTOCK-WARN] ${closestItem.blockName} still needs ${stillNeed}, but inventory can only accept ${remainingCapacity}. Stopping refill cycle to avoid cycling chests.`)
        return false
      }

      if (haveAfter <= haveBefore && config.errorHandling?.logErrors !== false) {
        console.log(`[NERV-RESTOCK-WARN] Could not restock ${closestItem.blockName}; replanning next material.`)
      }
      await delay(toNumber(advanced.inventoryActionDelayMs, 100))
      continue
    }

    await delay(toNumber(advanced.postRestockDelayMs, 300))
    didRestockThisWindow = true
  }

  if (config.errorHandling?.logErrors !== false) {
    console.log(`[NERV-RESTOCK-WARN] Refill planner hit safety limit (${maxIterations}); continuing with current inventory.`)
  }
  return false
}

function getRepairRestockPlan(bot, targets) {
  const neededByBlock = estimateNeededFromLookahead(targets)
  const missing = []

  for (const [blockName, needed] of neededByBlock.entries()) {
    const neededCount = Math.max(0, toNumber(needed, 0))
    const have = countInventoryItems(bot, blockName)
    const deficit = Math.max(0, neededCount - have)
    if (deficit <= 0) continue

    const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[blockName]?.stackSize, 64))
    missing.push({
      blockName,
      needed: neededCount,
      have,
      deficit,
      stacks: Math.ceil(deficit / stackSize)
    })
  }

  return { neededByBlock, missing }
}

async function ensureRepairMaterialsForTargets(bot, config, targets) {
  const advanced = config.advanced || {}
  if (advanced.predictiveRestock === false || !targets.length) return
  assertRuntimeContinue(bot, config, 'stopping-during-repair-restock')

  const maxIterations = Math.max(10, toNumber(advanced.repairRestockMaxIterations, 24))
  let safetyCounter = 0

  while (safetyCounter < maxIterations) {
    assertRuntimeContinue(bot, config, 'stopping-during-repair-restock')
    safetyCounter += 1
    const plan = getRepairRestockPlan(bot, targets)

    if (!plan.missing.length) {
      if (advanced.debugPrints) {
        console.log(`[REPAIR-RESTOCK] Inventory already covers repair batch: ${formatInventoryPlanMap(plan.neededByBlock)}`)
      }
      return
    }

    for (const item of plan.missing) {
      unavailableMaterialCache.delete(item.blockName)
    }

    let closestItem = null
    let closestDist = Infinity
    const failureCooldownMs = Math.max(0, toNumber(advanced.restockFailureCooldownMs, 8000))

    for (const item of plan.missing) {
      if (!shouldWaitForRequiredMaterialRestock(config) && restockFailureCache.has(item.blockName) && Date.now() - restockFailureCache.get(item.blockName) < failureCooldownMs) {
        continue
      }

      const groups = getMaterialChestGroupsForRefill(bot, config, item.blockName)
      if (!groups || !groups.length || !groups[0].length) continue

      const nearestChest = groups[0][0]
      const dist = horizontalDist2(bot, nearestChest)
      if (dist < closestDist) {
        closestDist = dist
        closestItem = item
      }
    }

    if (!closestItem) {
      console.log(`[REPAIR-RESTOCK-WARN] No available chest found for missing repair material(s): ${plan.missing.map((entry) => `${entry.blockName}x${entry.deficit}`).join(', ')}`)
      return
    }

    if (!inventoryHasRoomForItem(bot, closestItem.blockName)) {
      const dumpable = getDumpableCarpetStacks(bot, plan.neededByBlock).slice(0, 1)
      if (dumpable.length > 0) {
        assertRuntimeContinue(bot, config, 'stopping-before-repair-dump')
        console.log(`[REPAIR-DUMP] Freeing 1 slot before repair restock: ${dumpable[0].name}x${dumpable[0].count}`)
        await dumpCarpetStacks(bot, config, dumpable, 'repairPredumpBeforeRefill')
        await delay(toNumber(advanced.inventoryActionDelayMs, 100))
        continue
      }

      console.log(`[REPAIR-RESTOCK-WARN] No inventory space for ${closestItem.blockName}; repair will continue with current inventory.`)
      return
    }

    console.log(`[REPAIR-RESTOCK] material=${closestItem.blockName} have=${closestItem.have} need=${closestItem.needed} deficit=${closestItem.deficit} dist=${Math.round(Math.sqrt(closestDist))}`)
    assertRuntimeContinue(bot, config, 'stopping-before-repair-restock')
    const restocked = await waitForRequiredMaterialRestock(bot, config, closestItem.blockName, closestItem.stacks, plan.neededByBlock, 'repair-restock')

    if (!restocked) {
      const haveAfter = countInventoryItems(bot, closestItem.blockName)
      if (haveAfter >= closestItem.needed) return

      if (config.errorHandling?.logErrors !== false) {
        console.log(`[REPAIR-RESTOCK-WARN] Could not fully restock ${closestItem.blockName}; have=${haveAfter} need=${closestItem.needed}.`)
      }
      await delay(toNumber(advanced.inventoryActionDelayMs, 100))
    }
  }

  if (config.errorHandling?.logErrors !== false) {
    console.log(`[REPAIR-RESTOCK-WARN] Fast repair restock hit safety limit (${maxIterations}); continuing with current inventory.`)
  }
}

async function dumpUnneededCarpets(bot, config, neededByBlock) {
  const dumpable = getDumpableCarpetStacks(bot, neededByBlock)
  return await dumpCarpetStacks(bot, config, dumpable, 'dumpedStacks')
}

function resolveTargetPlacementPosition(bot, target, config) {
  const Vec3 = bot.entity.position.constructor
  let targetPos = new Vec3(target.position.x, target.position.y, target.position.z)
  let shiftedDown = false

  const initialSupport = bot.blockAt(targetPos.offset(0, -1, 0))
  if (!initialSupport || initialSupport.name === 'air') {
    const lowerTarget = targetPos.offset(0, -1, 0)
    const lowerSupport = bot.blockAt(lowerTarget.offset(0, -1, 0))
    const lowerBlock = bot.blockAt(lowerTarget)
    const lowerIsPlaceable = !lowerBlock || lowerBlock.name === 'air' || String(lowerBlock.name).endsWith('_carpet')

    if (lowerSupport && lowerSupport.name !== 'air' && lowerIsPlaceable) {
      targetPos = lowerTarget
      shiftedDown = true
      if (config.advanced?.debugPrints) {
        console.log(`[Y-AUTO] Shifted target down by 1 at ${target.position.x} ${target.position.y} ${target.position.z}`)
      }
    }
  }

  return { targetPos, shiftedDown }
}

function requiresSneakPlacementSupport(block) {
  const name = String(block?.name || '')
  return name === 'dispenser' || name === 'dropper'
}

function isTargetBlockPlaced(bot, targetPos, blockName) {
  const placed = bot?.blockAt?.(targetPos)
  return placed?.name === blockName
}

function getPlacementAttemptPriority(bot, targetPos, face) {
  const entityPos = bot?.entity?.position
  if (!entityPos || !face) return 0

  const eyeHeight = toNumber(bot?.entity?.height, 1.62)
  const eyePos = entityPos.offset(0, eyeHeight, 0)
  const targetCenter = targetPos.offset(0.5, 0.5, 0.5)
  const lookVec = targetCenter.minus(eyePos)
  const targetSide = face.scaled(-1)

  return (lookVec.x * targetSide.x) + (lookVec.y * targetSide.y) + (lookVec.z * targetSide.z)
}

async function waitForTargetBlockPlaced(bot, targetPos, blockName, waitMs = 0, pollMs = 15) {
  if (isTargetBlockPlaced(bot, targetPos, blockName)) return true
  const timeoutAt = Date.now() + Math.max(0, toNumber(waitMs, 0))
  const stepMs = Math.max(5, toNumber(pollMs, 15))
  while (Date.now() < timeoutAt) {
    await delay(Math.min(stepMs, Math.max(1, timeoutAt - Date.now())))
    if (isTargetBlockPlaced(bot, targetPos, blockName)) return true
  }
  return isTargetBlockPlaced(bot, targetPos, blockName)
}

async function placeTarget(bot, config, target, isRepairPass = false) {
  const printer = config.printer || {}
  const errors = config.errorHandling || {}
  const Vec3 = bot.entity.position.constructor
  const isFastNoWaitPlacement = isRepairPass === 'noWait' || isRepairPass === 'noWaitConfirm'
  const requiresFastConfirmation = isRepairPass === 'noWaitConfirm'
  const fastConfirmMs = isFastNoWaitPlacement
    ? (requiresFastConfirmation
        ? Math.max(20, toNumber(config.advanced?.repairFastConfirmMs, Math.max(160, toNumber(config.advanced?.scannerPlaceConfirmMs, 80) * 2)))
        : 0)
    : Math.max(0, toNumber(config.advanced?.scannerPlaceConfirmMs, Math.max(45, toNumber(config.advanced?.scannerWorkloadPollMs, 10) * 4)))
  const effectiveConfirmMs = getLatencyAdjustedTimeoutMs(bot, config, fastConfirmMs, fastConfirmMs)
  const fastConfirmPollMs = Math.max(5, toNumber(
    requiresFastConfirmation ? config.advanced?.repairFastConfirmPollMs : config.advanced?.scannerPlaceConfirmPollMs,
    toNumber(config.advanced?.scannerPlaceConfirmPollMs, 15)
  ))

  if (isFastNoWaitPlacement) {
    ensureUsableEntityState(bot, config, 'before-place-fast', { allowPlatformSeed: false, log: false })
  } else {
    await waitForPlatformReady(bot, config, 'before-place')
  }

  await waitForPlatformWaterClear(bot, config, config.__platformWaterGuardTargets || [target], 'before-place')

  const { targetPos } = resolveTargetPlacementPosition(bot, target, config)

  let blockAtTarget = bot.blockAt(targetPos)
  if (isWaterBlockName(blockAtTarget?.name)) {
    await waitForPlatformWaterClear(bot, config, config.__platformWaterGuardTargets || [target], 'water-at-target', { force: true })
    blockAtTarget = bot.blockAt(targetPos)
  }

  if (blockAtTarget?.name === target.blockName) {
    return { state: 'already' }
  }

  if (blockAtTarget && blockAtTarget.name !== 'air') {
    if (!String(blockAtTarget.name).endsWith('_carpet')) {
      return { state: 'skip', reason: `occupied-by-${blockAtTarget.name}` }
    }

    if (String(errors.errorAction || 'repair').toLowerCase() === 'repair') {
      try {
        await bot.dig(blockAtTarget, true)
      } catch (err) {
        return { state: 'skip', reason: `cannot-repair-${err?.message || err}` }
      }
    } else {
      return { state: 'skip', reason: 'misplaced-carpet' }
    }
  }

  const support = bot.blockAt(targetPos.offset(0, -1, 0))
  if (!support || support.name === 'air') {
    return { state: 'skip', reason: 'missing-support' }
  }
  if (isRepairPass && String(support.name || '').endsWith('_carpet')) {
    return { state: 'skip', reason: `support-is-carpet-possible-wrong-y-${support.name}` }
  }

  const botBlockX = Math.floor(bot.entity.position.x)
  const botBlockZ = Math.floor(bot.entity.position.z)
  const botNearTargetY = bot.entity.position.y >= targetPos.y && bot.entity.position.y < targetPos.y + 2.5
  if (!isFastNoWaitPlacement && botBlockX === targetPos.x && botBlockZ === targetPos.z && botNearTargetY) {
    const sidestepCandidates = [
      targetPos.offset(1, 1, 0),
      targetPos.offset(-1, 1, 0),
      targetPos.offset(0, 1, 1),
      targetPos.offset(0, 1, -1)
    ]

    for (const candidate of sidestepCandidates) {
      const floorBlock = bot.blockAt(candidate.offset(0, -1, 0))
      const feetBlock = bot.blockAt(candidate)
      const headBlock = bot.blockAt(candidate.offset(0, 1, 0))
      const hasFloor = floorBlock && floorBlock.name !== 'air'
      const feetOpen = !feetBlock || feetBlock.name === 'air' || String(feetBlock.name).endsWith('_carpet')
      const headOpen = !headBlock || headBlock.name === 'air'
      if (!hasFloor || !feetOpen || !headOpen) continue

      try {
        await bot.pathfinder.goto(new GoalNear(candidate.x, candidate.y, candidate.z, 0))
        break
      } catch {
        // Try the next sidestep option.
      }
    }
  }

  if (String(bot.heldItem?.name || '') !== target.blockName) {
    const equipped = await equipMaterial(bot, config, target.blockName, {
      fastSwap: isFastNoWaitPlacement,
      allowRestock: !isFastNoWaitPlacement
    })
    const selectedMaterialReady = selectedMaterialMatches(bot, target.blockName)
    if (!equipped || !selectedMaterialReady) {
      if (countInventoryItems(bot, target.blockName) > 0) {
        return { state: 'skip', reason: `held-item-desync-${target.blockName}` }
      }
      return { state: 'skip', reason: `missing-item-${target.blockName}` }
    }
  }

  if (!isFastNoWaitPlacement && printer.rotate !== false) {
    await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), true)
  }

  const placeAttempts = [{ block: support, face: new Vec3(0, 1, 0) }]
  if (!isFastNoWaitPlacement) {
    const sideCandidates = [
      { refPos: targetPos.offset(-1, 0, 0), face: new Vec3(1, 0, 0) },
      { refPos: targetPos.offset(1, 0, 0), face: new Vec3(-1, 0, 0) },
      { refPos: targetPos.offset(0, 0, -1), face: new Vec3(0, 0, 1) },
      { refPos: targetPos.offset(0, 0, 1), face: new Vec3(0, 0, -1) }
    ]

    for (const candidate of sideCandidates) {
      const sideBlock = bot.blockAt(candidate.refPos)
      if (sideBlock && sideBlock.name !== 'air') {
        placeAttempts.push({ block: sideBlock, face: candidate.face })
      }
    }
    placeAttempts.sort((a, b) => getPlacementAttemptPriority(bot, targetPos, b.face) - getPlacementAttemptPriority(bot, targetPos, a.face))
  }

  let placedSuccessfully = false
  let lastPlaceError = null

  for (const attempt of placeAttempts) {
    const sneakOnDispenserOnly = config.advanced?.sneakOnDispenserOnly !== false
    const shouldSneak = isFastNoWaitPlacement
      ? requiresSneakPlacementSupport(attempt?.block)
      : (sneakOnDispenserOnly ? requiresSneakPlacementSupport(attempt?.block) : true)
    try {
      if (!selectedMaterialMatches(bot, target.blockName)) {
        if (countInventoryItems(bot, target.blockName) > 0) {
          return { state: 'skip', reason: `held-item-desync-${target.blockName}` }
        }
        return { state: 'skip', reason: `missing-item-${target.blockName}` }
      }
      if (shouldSneak) {
        bot.setControlState('sneak', true)
        await new Promise(r => setTimeout(r, 60))
      }
      await applyAdaptiveLatencyBackoff(bot, config, 'before-place-block', { pauseMovement: true })
      if (isFastNoWaitPlacement && typeof bot._genericPlace === 'function') {
        await bot._genericPlace(attempt.block, attempt.face, {
          swingArm: 'right',
          forceLook: true
        })
      } else {
        await bot.placeBlock(attempt.block, attempt.face)
      }
      if (!requiresFastConfirmation && isFastNoWaitPlacement) {
        placedSuccessfully = true
        break
      }
      if (await waitForTargetBlockPlaced(bot, targetPos, target.blockName, effectiveConfirmMs, fastConfirmPollMs)) {
        placedSuccessfully = true
        break
      }
      if (requiresFastConfirmation) {
        lastPlaceError = new Error('unconfirmed-place')
      }
    } catch (err) {
      lastPlaceError = err
      const errMsg = String(err?.message || '').toLowerCase()
      if (errMsg.includes('must be holding an item')) {
        if (countInventoryItems(bot, target.blockName) > 0) {
          return { state: 'skip', reason: `held-item-desync-${target.blockName}` }
        }
        return { state: 'skip', reason: `missing-item-${target.blockName}` }
      }
      if (isFastNoWaitPlacement && !requiresFastConfirmation) {
        // Fast path: don't wait for confirmation on error, just report failure
        break
      }
      if (isTargetBlockPlaced(bot, targetPos, target.blockName) || await waitForTargetBlockPlaced(bot, targetPos, target.blockName, effectiveConfirmMs, fastConfirmPollMs)) {
        placedSuccessfully = true
        if (config.advanced?.debugPrints) {
          console.log(`[PLACE-WARN] Placement timeout but block is present at ${target.position.x} ${target.position.y} ${target.position.z}`)
        }
        break
      }
    } finally {
      if (shouldSneak) {
        bot.setControlState('sneak', false)
      }
    }
  }

  if (!placedSuccessfully) {
    if (requiresFastConfirmation && String(lastPlaceError?.message || '') === 'unconfirmed-place') {
      return { state: 'skip', reason: 'unconfirmed-place' }
    }
    throw lastPlaceError || new Error('placement failed with all faces')
  }

  if (!isFastNoWaitPlacement) {
    const latencyState = await applyAdaptiveLatencyBackoff(bot, config, 'after-place-block', { allowCriticalWait: false, maxWaitMs: 1000 })
    await delay(Math.max(toNumber(printer.placeDelayMs, 50), latencyState.delayMs || 0))
  }
  return { state: 'placed' }
}

function isTargetAlreadyResolved(bot, config, target) {
  const { targetPos } = resolveTargetPlacementPosition(bot, target, config)
  const actual = bot.blockAt(targetPos)
  return actual?.name === target.blockName
}

function getUnresolvedPlacementTargets(bot, config, targets) {
  return targets.filter((target) => !isTargetAlreadyResolved(bot, config, target))
}

function mergePlacementResults(left, right) {
  const merged = {
    placed: toNumber(left?.placed, 0) + toNumber(right?.placed, 0),
    already: toNumber(left?.already, 0) + toNumber(right?.already, 0),
    skipped: toNumber(left?.skipped, 0) + toNumber(right?.skipped, 0),
    seen: toNumber(left?.seen, 0) + toNumber(right?.seen, 0),
    missing: toNumber(right?.missing, toNumber(left?.missing, 0)),
    hardStops: toNumber(left?.hardStops, 0) + toNumber(right?.hardStops, 0),
    rawAllowed: toNumber(left?.rawAllowed, 0) + toNumber(right?.rawAllowed, 0),
    capped: toNumber(left?.capped, 0) + toNumber(right?.capped, 0),
    maxAllowed: Math.max(toNumber(left?.maxAllowed, 0), toNumber(right?.maxAllowed, 0))
  }
  return merged
}

async function runLatencySafePlacementBatch(bot, config, batchTargets, placeRange, label = 'LATENCY-SAFE-PLACE') {
  const remaining = [...batchTargets]
  const result = { placed: 0, already: 0, skipped: 0, seen: 0, missing: 0, hardStops: 0, rawAllowed: 0, capped: 0, maxAllowed: 0 }
  const targetRange = Math.max(0.75, Math.max(1, toNumber(placeRange, 4)) - 0.75)
  const settleMs = Math.max(0, toNumber(config.advanced?.latencySafePlacementSettleMs, toNumber(config.printer?.placeDelayMs, 50)))

  stopBotMovement(bot)

  while (remaining.length > 0) {
    assertRuntimeContinue(bot, config, 'stopping-during-latency-safe-placement')
    const mode = shouldUseLatencySafeMode(bot, config, 'placement')
    if (!mode.active) break

    const target = remaining.shift()
    if (!target) break

    try {
      const { targetPos } = resolveTargetPlacementPosition(bot, target, config)
      const actual = bot.blockAt(targetPos)
      if (actual?.name === target.blockName) {
        result.already += 1
        result.seen += 1
        continue
      }

      const distance = bot.entity.position.distanceTo(targetPos.offset(0.5, 0.5, 0.5))
      if (distance > Math.max(1, toNumber(placeRange, 4))) {
        stopBotMovement(bot)
        await gotoGoalWithHardTimeout(
          bot,
          new GoalNear(target.position.x, target.position.y, target.position.z, targetRange),
          getLatencyAdjustedTimeoutMs(bot, config, toNumber(config.advanced?.latencySafePlacementMoveTimeoutMs, 12000), 12000),
          `${label.toLowerCase()}-move`,
          {
            config,
            shouldPauseTimeout: () => getLatencyBackoffState(bot, config).level === 'critical',
            pollMs: Math.max(100, toNumber(config.advanced?.latencyBackoffPollMs, 500))
          }
        )
      }

      stopLagSensitiveMovement(bot)
      const placed = await placeTarget(bot, config, target, false)
      if (placed.state === 'placed') {
        result.placed += 1
        result.seen += 1
      } else if (placed.state === 'already') {
        result.already += 1
        result.seen += 1
      } else {
        result.skipped += 1
        if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
          console.log(`[${label}-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${placed.reason})`)
        }
      }
    } catch (err) {
      if (isRuntimeStopError(err)) throw err
      result.skipped += 1
      if (config.errorHandling?.logErrors !== false) {
        console.log(`[${label}-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
      }
    }

    if (settleMs > 0) await delay(settleMs)
  }

  result.remainingTargets = remaining
  result.missing = getUnresolvedPlacementTargets(bot, config, batchTargets).length
  return result
}

async function repairTargets(bot, config, targets, placeRange) {
  if (!targets.length) return { placed: 0, already: 0, skipped: 0 }
  assertRuntimeContinue(bot, config, 'stopping-during-repair')

  const printer = config.printer || {}
  const repairGoalRange = Math.max(0.5, toNumber(config.advanced?.repairGoalRange, Math.max(0.75, placeRange - 1.5)))
  const settleMs = Math.max(0, toNumber(config.advanced?.repairTargetSettleMs, 20))
  const remaining = [...targets]
  let placed = 0
  let already = 0
  let skipped = 0

  bot.setControlState('sprint', shouldSprintDuringRepair(config))

  while (remaining.length > 0) {
    assertRuntimeContinue(bot, config, 'stopping-during-repair')
    const botPos = bot.entity.position
    let bestIndex = 0
    let bestDist = Number.POSITIVE_INFINITY

    for (let i = 0; i < remaining.length; i += 1) {
      const pos = remaining[i].position
      const dx = botPos.x - (pos.x + 0.5)
      const dz = botPos.z - (pos.z + 0.5)
      const dist2 = dx * dx + dz * dz
      if (dist2 < bestDist) {
        bestDist = dist2
        bestIndex = i
      }
    }

    const [target] = remaining.splice(bestIndex, 1)
    try {
      if (Math.sqrt(bestDist) > Math.max(1, placeRange - 0.25)) {
        await bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, repairGoalRange))
      }

      const result = await placeTarget(bot, config, target, true)
      if (result.state === 'placed') placed += 1
      else if (result.state === 'already') already += 1
      else {
        skipped += 1
        if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
          console.log(`[REPAIR-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
        }
      }
    } catch (err) {
      skipped += 1
      if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
        console.log(`[REPAIR-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
      }
    }

    if (settleMs > 0) await delay(settleMs)
  }

  return { placed, already, skipped }
}

function scanPlacementErrors(bot, targets, options = {}) {
  const Vec3 = bot.entity.position.constructor
  const errors = []
  let unloaded = 0
  const logPrefix = options.logPrefix || 'SCAN'
  const logErrors = options.logErrors === true
  const maxLogs = Math.max(0, toNumber(options.maxLogs, 50))
  const includeUnloaded = options.includeUnloaded === true

  for (const target of targets) {
    const { targetPos, shiftedDown } = resolveTargetPlacementPosition(bot, target, options.config || {})
    const actual = bot.blockAt(targetPos)
    if (!actual) {
      unloaded += 1
      if (!includeUnloaded) continue
    }
    if (actual?.name === target.blockName) continue

    const reason = (!actual || actual.name === 'air') ? 'missing' : `wrong-${actual.name}`
    const resolvedTarget = shiftedDown
      ? { ...target, position: { x: targetPos.x, y: targetPos.y, z: targetPos.z } }
      : target
    errors.push({ target: resolvedTarget, reason, actualName: actual?.name || 'air' })

    if (logErrors && errors.length <= maxLogs) {
      const yNote = shiftedDown ? `, resolvedY=${targetPos.y}` : ''
      console.log(`[${logPrefix}-ERROR] ${target.position.x} ${target.position.y} ${target.position.z} (${reason}, expected=${target.blockName}${yNote})`)
    }
  }

  if (logErrors && errors.length > maxLogs) {
    console.log(`[${logPrefix}] ${errors.length - maxLogs} additional mismatch(es) not printed.`)
  }
  if (unloaded > 0) {
    console.log(`[${logPrefix}] unloaded=${unloaded} ${includeUnloaded ? 'included-as-missing' : 'skipped'}.`)
  }

  return errors
}

function logRepairMismatchWarning(config, mismatchCount, totalTargets, label = 'REPAIR') {
  const advanced = config.advanced || {}
  const maxCount = Math.max(1, toNumber(advanced.repairMaxMismatchCount, 512))
  const maxRatio = Math.max(0, toNumber(advanced.repairMaxMismatchRatio, 0.25))
  const ratio = totalTargets > 0 ? mismatchCount / totalTargets : 0
  const tooMany = mismatchCount > maxCount && ratio > maxRatio

  if (tooMany) {
    console.log(`[${label}-WARN] mismatchCount=${mismatchCount}/${totalTargets} (${(ratio * 100).toFixed(1)}%) exceeds repair warning limit; autonomous repair will continue.`)
  }

  return tooMany
}

function summarizeRepairMismatchReasons(bot, config, targets) {
  const summary = { missing: 0, occupied: 0, already: 0, unloaded: 0, total: 0 }
  const Vec3 = bot.entity.position.constructor

  for (const target of targets) {
    const { targetPos } = resolveTargetPlacementPosition(bot, target, config)
    const actual = bot.blockAt(new Vec3(targetPos.x, targetPos.y, targetPos.z))
    if (actual?.name === target.blockName) {
      summary.already += 1
      continue
    }
    if (!actual) {
      summary.unloaded += 1
      summary.missing += 1
    } else if (actual.name === 'air') {
      summary.missing += 1
    } else {
      summary.occupied += 1
    }
    summary.total += 1
  }

  return summary
}

function logRepairMismatchWarningForTargets(bot, config, targets, totalTargets, label = 'REPAIR') {
  const mismatchCount = targets.length
  const overWarningLimit = logRepairMismatchWarning(config, mismatchCount, totalTargets, label)
  if (!overWarningLimit) return false

  const summary = summarizeRepairMismatchReasons(bot, config, targets)
  const wrongRatio = summary.total > 0 ? summary.occupied / summary.total : 0
  if (placementNoiseLogsEnabled(config)) {
    console.log(`[${label}-WARN-DETAIL] missing=${summary.missing} occupied=${summary.occupied} unloaded=${summary.unloaded} wrongRatio=${(wrongRatio * 100).toFixed(1)}%; continuing repair.`)
  }
  return true
}

function takeNearestRepairBatch(bot, targets, batchSize) {
  const maxBatch = Math.max(1, toNumber(batchSize, 256))
  const remaining = [...targets]
  const batch = []
  let cursor = bot.entity.position

  while (remaining.length > 0 && batch.length < maxBatch) {
    let bestIndex = 0
    let bestDist = Number.POSITIVE_INFINITY

    for (let i = 0; i < remaining.length; i += 1) {
      const pos = remaining[i].position
      const dx = cursor.x - (pos.x + 0.5)
      const dz = cursor.z - (pos.z + 0.5)
      const dist2 = dx * dx + dz * dz
      if (dist2 < bestDist) {
        bestDist = dist2
        bestIndex = i
      }
    }

    const [target] = remaining.splice(bestIndex, 1)
    batch.push(target)
    cursor = { x: target.position.x + 0.5, z: target.position.z + 0.5 }
  }

  return { batch, remaining }
}

function classifyRepairTargets(bot, config, targets) {
  const already = []
  const missing = []
  const occupied = []

  for (const target of targets) {
    const { targetPos, shiftedDown } = resolveTargetPlacementPosition(bot, target, config)
    const resolvedTarget = shiftedDown
      ? { ...target, position: { x: targetPos.x, y: targetPos.y, z: targetPos.z } }
      : target
    const actual = bot.blockAt(targetPos)

    if (actual?.name === target.blockName) {
      already.push(resolvedTarget)
    } else if (!actual || actual.name === 'air') {
      missing.push(resolvedTarget)
    } else {
      occupied.push(resolvedTarget)
    }
  }

  return { already, missing, occupied }
}

function shouldSprintDuringRepair(config) {
  const mode = String(config.advanced?.repairSprintMode || 'always').toLowerCase()
  return mode !== 'off' && mode !== 'false' && mode !== 'never'
}

async function repairTargetsWhileMovingWithStops(bot, config, targets, placeRange, label = 'REPAIR-MIXED', allowEmergencyRestock = true) {
  if (!targets.length) return { placed: 0, already: 0, skipped: 0 }
  assertRuntimeContinue(bot, config, 'stopping-during-repair')

  if (shouldUseLatencySafeMode(bot, config, 'repair').active) {
    console.log(`[${label}-LATENCY-SAFE] MC ping high; using stop-place confirmed repair for ${targets.length} target(s).`)
    return await repairTargets(bot, config, targets, placeRange)
  }

  const printer = config.printer || {}
  const advanced = config.advanced || {}
  const tickMs = Math.max(10, toNumber(advanced.repairFastTickMs, toNumber(printer.fastTraversalTickMs, 40)))
  const maxPerTick = Math.max(1, toNumber(advanced.repairFastMaxPlacementsPerTick, toNumber(printer.maxPlacementsPerTick, 1)))
  const goalRange = Math.max(0.5, toNumber(advanced.repairFastGoalRange, toNumber(advanced.repairGoalRange, Math.max(0.75, placeRange - 1.5))))
  const moveTimeoutMs = Math.max(1000, toNumber(advanced.repairMoveTimeoutMs, 8000))
  const progressLogMs = Math.max(1000, toNumber(advanced.repairProgressLogMs, 5000))
  const fallbackToStopPlace = advanced.repairFallbackToStopPlace !== false
  const confirmFastPlacements = advanced.repairConfirmFastPlacements !== false
  const Vec3 = bot.entity.position.constructor
  const processed = new Set()
  const unconfirmedTargets = new Map()
  let active = true
  let placed = 0
  let already = 0
  let skipped = 0
  let lastProgressAt = Date.now()
  let lastLogAt = 0
  let fallbackNeeded = false
  let stopRepairActive = false
  let emergencyRestockBlock = null
  let emergencyRestockReason = ''
  const moveFailures = new Map()
  const transientRepairFailures = new Map()
  const transientRestockHits = Math.max(1, toNumber(advanced.repairEmergencyRestockTransientHits, 3))

  const targetKey = (target) => `${target.position.x}:${target.position.y}:${target.position.z}`
  const targetPosition = (target) => new Vec3(target.position.x, target.position.y, target.position.z)
  const getResolvedTarget = (target) => {
    const { targetPos, shiftedDown } = resolveTargetPlacementPosition(bot, target, config)
    return shiftedDown
      ? { ...target, position: { x: targetPos.x, y: targetPos.y, z: targetPos.z } }
      : target
  }

  const markResult = (target, result, prefix) => {
    if (result.state === 'placed') {
      lastProgressAt = Date.now()
      placed += 1
      transientRepairFailures.delete(target.blockName)
    } else if (result.state === 'already') {
      lastProgressAt = Date.now()
      already += 1
      transientRepairFailures.delete(target.blockName)
    } else {
      skipped += 1
      const reason = String(result.reason || '')
      if (reason === 'unconfirmed-place') {
        unconfirmedTargets.set(targetKey(target), target)
      }
      if (allowEmergencyRestock && advanced.repairStallEmergencyRestock !== false && (reason === 'unconfirmed-place' || reason.startsWith('held-item-desync-'))) {
        logPingDiagnostic(bot, config, `repair-${reason}`, {
          label,
          target: `${target.position.x},${target.position.y},${target.position.z}`,
          block: target.blockName,
          held: bot.heldItem?.name || 'empty',
          pos: formatBotPosition(bot)
        }, { force: true })
        const hits = (transientRepairFailures.get(target.blockName) || 0) + 1
        transientRepairFailures.set(target.blockName, hits)
        if (hits >= transientRestockHits && !emergencyRestockBlock) {
          emergencyRestockBlock = target.blockName
          emergencyRestockReason = `${hits} transient repair placement failure(s), latest=${reason}`
          active = false
          stopRepairActive = false
          console.log(`[${label}-STALL-RESTOCK] block=${emergencyRestockBlock} reason="${emergencyRestockReason}"; forcing emergency restock/refresh before retry.`)
          logPingDiagnostic(bot, config, 'repair-stall-restock-requested', {
            label,
            block: emergencyRestockBlock,
            target: `${target.position.x},${target.position.y},${target.position.z}`,
            pos: formatBotPosition(bot),
            reason: emergencyRestockReason
          }, { force: true })
        }
      }
      if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
        console.log(`[${prefix}-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
      }
    }
  }

  const fastAirLoop = (async () => {
    while (active) {
      assertRuntimeContinue(bot, config, 'stopping-during-repair')
      if (stopRepairActive || shouldUseLatencySafeMode(bot, config, 'repair').active) {
        stopLagSensitiveMovement(bot)
        await delay(tickMs)
        continue
      }

      const botPos = bot.entity.position
      const candidates = targets
        .filter((target) => !processed.has(targetKey(target)))
        .map(getResolvedTarget)
        .filter((target) => {
          const pos = targetPosition(target)
          const actual = bot.blockAt(pos)
          if (actual?.name === target.blockName) return true
          if (actual && actual.name !== 'air') return false
          return botPos.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= placeRange
        })
        .sort((a, b) => {
          const aPos = new Vec3(a.position.x + 0.5, a.position.y + 0.5, a.position.z + 0.5)
          const bPos = new Vec3(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5)
          return botPos.distanceTo(aPos) - botPos.distanceTo(bPos)
        })

      let placementsThisTick = 0
      for (const target of candidates) {
        const key = targetKey(target)
        if (processed.has(key)) continue
        if (placementsThisTick >= maxPerTick) break

        processed.add(key)
        placementsThisTick += 1

        try {
          const result = await placeNervScannerTarget(bot, config, target, { confirm: confirmFastPlacements })
          markResult(target, result, label)
        } catch (err) {
          skipped += 1
          if (config.errorHandling?.logErrors !== false) {
            console.log(`[${label}-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
          }
        }
      }

      await delay(tickMs)
    }
  })()

  try {
    bot.setControlState('sprint', shouldSprintDuringRepair(config))

    while (processed.size < targets.length) {
      assertRuntimeContinue(bot, config, 'stopping-during-repair')
      if (Date.now() - lastLogAt >= progressLogMs) {
        lastLogAt = Date.now()
        console.log(`[${label}-PROGRESS] processed=${processed.size}/${targets.length} placed=${placed} already=${already} skipped=${skipped} pos=${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`)
      }

      const botPos = bot.entity.position
      const remaining = targets
        .map(getResolvedTarget)
        .filter((target) => !processed.has(targetKey(target)))
        .sort((a, b) => {
          const aPos = new Vec3(a.position.x + 0.5, a.position.y + 0.5, a.position.z + 0.5)
          const bPos = new Vec3(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5)
          return botPos.distanceTo(aPos) - botPos.distanceTo(bPos)
        })

      const target = remaining[0]
      if (!target) break

      if (shouldUseLatencySafeMode(bot, config, 'repair').active) {
        stopRepairActive = true
        stopBotMovement(bot)
        const key = targetKey(target)
        processed.add(key)
        try {
          console.log(`[${label}-LATENCY-SAFE] stop-place repair target=${target.position.x} ${target.position.y} ${target.position.z}`)
          const result = await placeTarget(bot, config, target, true)
          markResult(target, result, `${label}-LATENCY-SAFE`)
        } catch (err) {
          skipped += 1
          if (config.errorHandling?.logErrors !== false) {
            console.log(`[${label}-LATENCY-SAFE-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
          }
        } finally {
          stopRepairActive = false
          bot.setControlState('sprint', shouldSprintDuringRepair(config))
        }
        await delay(tickMs)
        continue
      }

      try {
        const repairMovePromise = bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, goalRange))
        repairMovePromise.catch(() => {})
        await Promise.race([
          repairMovePromise,
          delay(moveTimeoutMs).then(() => {
            throw new Error(`repair move timeout after ${moveTimeoutMs}ms`)
          })
        ])
      } catch (err) {
        if (typeof bot.pathfinder?.stop === 'function') {
          try { bot.pathfinder.stop() } catch { }
        }
        const message = String(err?.message || err)
        const failures = (moveFailures.get(targetKey(target)) || 0) + 1
        moveFailures.set(targetKey(target), failures)
        console.log(`[${label}-MOVE-WARN] ${target.position.x} ${target.position.y} ${target.position.z} -> ${message}; continuing fast repair (${failures}/2).`)
        if (failures >= 2) {
          processed.add(targetKey(target))
          skipped += 1
          if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
            console.log(`[${label}-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (move-failed)`)
          }
        }
        await delay(tickMs)
        continue
      }

      const key = targetKey(target)
      if (processed.has(key)) continue

      const pos = targetPosition(target)
      const actual = bot.blockAt(pos)
      if (actual?.name === target.blockName) {
        processed.add(key)
        already += 1
        continue
      }

      processed.add(key)
      try {
        let result
        if (actual && actual.name !== 'air') {
          stopRepairActive = true
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
          bot.setControlState('left', false)
          bot.setControlState('right', false)
          bot.setControlState('back', false)
          console.log(`[${label}-STOP-FIX] ${target.position.x} ${target.position.y} ${target.position.z} occupied-by=${actual.name} expected=${target.blockName}`)
          try {
            result = await placeTarget(bot, config, target, true)
          } finally {
            stopRepairActive = false
            bot.setControlState('sprint', shouldSprintDuringRepair(config))
          }
        } else {
          result = await placeNervScannerTarget(bot, config, target, { confirm: confirmFastPlacements })
        }
        markResult(target, result, actual && actual.name !== 'air' ? `${label}-STOP` : label)
      } catch (err) {
        stopRepairActive = false
        skipped += 1
        if (config.errorHandling?.logErrors !== false) {
          console.log(`[${label}-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
        }
      }

      if (Date.now() - lastProgressAt > Math.max(moveTimeoutMs, progressLogMs * 2)) {
        const stalledMs = Date.now() - lastProgressAt
        if (allowEmergencyRestock && advanced.repairStallEmergencyRestock !== false) {
          emergencyRestockBlock = target.blockName
          emergencyRestockReason = `no repair placement progress for ${stalledMs}ms`
          console.log(`[${label}-STALL-RESTOCK] block=${emergencyRestockBlock} reason="${emergencyRestockReason}"; forcing emergency restock/refresh before retry.`)
        } else {
          console.log(`[${label}-PROGRESS-WARN] no repair placement progress for ${stalledMs}ms; falling back to stop-place.`)
          fallbackNeeded = true
        }
        break
      }
    }
  } catch (err) {
    if (config.errorHandling?.logErrors !== false) {
      console.log(`[${label}-MOVE-ERR] ${err?.message || err}`)
    }
  } finally {
    active = false
    await fastAirLoop
  }

  if (allowEmergencyRestock && emergencyRestockBlock) {
    console.log(`[${label}-EMERGENCY-RESTOCK] ${emergencyRestockBlock} ${emergencyRestockReason}; refilling and retrying unresolved repair targets once.`)
    const restocked = await waitForRequiredMaterialRestock(bot, config, emergencyRestockBlock, 1, null, emergencyRestockReason || 'repair-emergency-restock')
    const remainingTargets = scanPlacementErrors(bot, targets, {
      config,
      logPrefix: `${label}-RESTOCK-VERIFY`,
      logErrors: false,
      maxLogs: 0
    }).map((entry) => entry.target)
    if ((restocked || countInventoryItems(bot, emergencyRestockBlock) > 0) && remainingTargets.length > 0) {
      const retry = await repairTargetsWhileMovingWithStops(bot, config, remainingTargets, placeRange, `${label}-RESTOCK-RETRY`, false)
      placed += retry.placed
      already += retry.already
      skipped += retry.skipped
    } else if (remainingTargets.length > 0) {
      skipped += remainingTargets.length
    }
    return { placed, already, skipped }
  }

  if (fallbackToStopPlace && unconfirmedTargets.size > 0) {
    const unresolvedUnconfirmed = scanPlacementErrors(bot, [...unconfirmedTargets.values()], {
      config,
      logPrefix: `${label}-UNCONFIRMED-VERIFY`,
      logErrors: false,
      maxLogs: 0
    }).map((entry) => entry.target)

    if (unresolvedUnconfirmed.length > 0) {
      console.log(`[${label}-UNCONFIRMED-FALLBACK] stop-place repair for ${unresolvedUnconfirmed.length} unconfirmed fast placement(s).`)
      stopBotMovement(bot)
      const fallback = await repairTargets(bot, config, unresolvedUnconfirmed, placeRange)
      const resolvedByFallback = fallback.placed + fallback.already
      placed += fallback.placed
      already += fallback.already
      skipped = Math.max(0, skipped - resolvedByFallback) + fallback.skipped
    }
  }

  if (fallbackNeeded && fallbackToStopPlace) {
    const remainingTargets = targets
      .map(getResolvedTarget)
      .filter((target) => !processed.has(targetKey(target)))
    if (remainingTargets.length > 0) {
      console.log(`[${label}-FALLBACK] stop-place repair for ${remainingTargets.length} remaining target(s).`)
      const fallback = await repairTargets(bot, config, remainingTargets, placeRange)
      placed += fallback.placed
      already += fallback.already
      skipped += fallback.skipped
    }
  }

  return { placed, already, skipped }
}

async function repairTargetsInBatches(bot, config, targets, placeRange, label = 'REPAIR') {
  const advanced = config.advanced || {}
  const batchSize = Math.max(1, toNumber(advanced.repairBatchSize, 256))
  let remaining = [...targets]
  let placed = 0
  let already = 0
  let skipped = 0
  let batchNumber = 0
  const maxBatches = Math.max(
    1,
    Math.ceil(Math.max(1, targets.length) / batchSize) * Math.max(1, toNumber(advanced.repairTestMaxPasses, 3))
  )

  while (remaining.length > 0 && batchNumber < maxBatches) {
    assertRuntimeContinue(bot, config, 'stopping-during-repair')
    batchNumber += 1
    const selection = takeNearestRepairBatch(bot, remaining, batchSize)
    const batch = selection.batch
    remaining = selection.remaining

    console.log(`[${label}-BATCH] batch=${batchNumber} size=${batch.length} remainingAfterBatch=${remaining.length}`)
    if (String(advanced.repairRestockMode || 'fast').toLowerCase() === 'nerv') {
      await ensureMaterialsForTargets(bot, config, batch)
    } else {
      await ensureRepairMaterialsForTargets(bot, config, batch)
    }

    const repairGroups = classifyRepairTargets(bot, config, batch)
    console.log(`[${label}-BATCH] mixedRepair=true missing=${repairGroups.missing.length} occupied=${repairGroups.occupied.length} already=${repairGroups.already.length}`)

    const result = await repairTargetsWhileMovingWithStops(bot, config, batch, placeRange, `${label}-MIXED`)
    placed += result.placed
    already += result.already
    skipped += result.skipped

    await delay(toNumber(advanced.repairVerifySettleMs, 300))
    const stillWrong = scanPlacementErrors(bot, batch, {
      config,
      logPrefix: `${label}-VERIFY-BATCH-${batchNumber}`,
      logErrors: config.errorHandling?.logErrors !== false,
      maxLogs: toNumber(advanced.repairTestMaxErrorLogs, 80)
    }).map((entry) => entry.target)

    if (stillWrong.length > 0) {
      remaining.push(...stillWrong)
      console.log(`[${label}-BATCH] batch=${batchNumber} unresolved=${stillWrong.length}; queued for another pass.`)
    }
  }

  if (remaining.length > 0) {
    skipped += remaining.length
    console.log(`[${label}-BATCH] stopped with ${remaining.length} unresolved target(s) after ${batchNumber}/${maxBatches} batch attempt(s).`)
  }

  return { placed, already, skipped }
}

async function runContinuousPlacementBatch(bot, config, batchTargets, rowOrder, placeRange, label = 'LITEMATIC-ROW') {
  if (!batchTargets.length) return { placed: 0, already: 0, skipped: 0, processed: 0 }

  const printer = config.printer || {}
  const advanced = config.advanced || {}
  if (shouldUseLatencySafeMode(bot, config, 'placement').active) {
    console.log(`[${label}-LATENCY-SAFE] MC ping high; switching ${batchTargets.length} target(s) to one-by-one confirmed placement.`)
    const safe = await runLatencySafePlacementBatch(bot, config, batchTargets, placeRange, `${label}-LATENCY-SAFE`)
    if (safe.remainingTargets?.length) {
      const fast = await runContinuousPlacementBatch(bot, config, safe.remainingTargets, rowOrder, placeRange, label)
      return {
        placed: safe.placed + fast.placed,
        already: safe.already + fast.already,
        skipped: safe.skipped + fast.skipped,
        processed: toNumber(safe.seen, 0) + toNumber(fast.processed, 0)
      }
    }
    return { placed: safe.placed, already: safe.already, skipped: safe.skipped, processed: safe.seen }
  }

  const tickMs = Math.max(10, toNumber(printer.fastTraversalTickMs, 40))
  const maxPerTick = Math.max(1, toNumber(printer.maxPlacementsPerTick, 1))
  const checkpointBuffer = Math.max(0.5, toNumber(advanced.checkpointBuffer, 1))
  const lineEndSettleMs = Math.max(0, toNumber(advanced.litematicRowSettleMs, 150))
  const retryCooldownMs = Math.max(0, toNumber(advanced.scannerRetryCooldownMs, 150))
  const checkpoints = buildNervUCheckpoints(batchTargets, rowOrder[0] <= rowOrder[rowOrder.length - 1])
  const targetByXZ = new Map(batchTargets.map((target) => [`${target.position.x}:${target.position.z}`, target]))
  const neededByBlock = estimateNeededFromLookahead(batchTargets)
  const seen = new Set()
  const pendingUntil = new Map()
  const retryPriority = new Set()
  let active = true
  let currentGoal = checkpoints[0]?.position || null
  let currentAction = checkpoints[0]?.action || ''
  let currentActiveCols = checkpoints[0]?.activeCols || new Set(batchTargets.map((target) => target.col))
  let placed = 0
  let already = 0
  let skipped = 0
  let emergencyRestockBlock = null
  let latencySafeInterrupted = false
  let latencySafeSeen = 0
  const inventoryDesyncHits = new Map()
  const maxInventoryDesyncHits = Math.max(1, toNumber(advanced.scannerInventoryDesyncMaxHits, 3))
  const inventoryDesyncCooldownMs = Math.max(retryCooldownMs, toNumber(advanced.scannerInventoryDesyncCooldownMs, 250))

  const getTargetKey = (target) => `${target.position.x}:${target.position.y}:${target.position.z}`
  const getUniqueTargets = (targets) => [...new Map(targets.map((target) => [getTargetKey(target), target])).values()]
  const confirmTargetPlaced = (target) => {
    const Vec3Confirm = bot.entity.position.constructor
    const actual = bot.blockAt(new Vec3Confirm(target.position.x, target.position.y, target.position.z))
    return actual?.name === target.blockName
  }
  const isTransientPlacementReason = (reason) => {
    const text = String(reason || '')
    return text === 'unconfirmed-place' || text.startsWith('held-item-desync-')
  }
  const shouldEmergencyRestockMissingItem = (blockName) => countInventoryItems(bot, blockName) <= 0
  const getUnresolvedTargets = (targets) => getUniqueTargets(scanPlacementErrors(bot, targets, {
    config,
    logPrefix: `${label}-VERIFY`,
    logErrors: false,
    includeUnloaded: false,
    maxLogs: 0
  }).map((entry) => entry.target))

  const placementLoop = observeBackgroundTask((async () => {
    while (active) {
      assertRuntimeContinue(bot, config, 'stopping-during-placement')
      if (shouldUseLatencySafeMode(bot, config, 'placement').active) {
        latencySafeInterrupted = true
        active = false
        stopBotMovement(bot)
        console.log(`[${label}-LATENCY-SAFE] MC ping rose during fast traversal; stopping movement for confirmed placement.`)
        break
      }
      const allowPlacement = currentAction === '' || currentAction === 'lineEnd' || currentAction === 'sprint'
      if (allowPlacement) {
        const now = Date.now()
        const burstExcluded = new Set(seen)

        for (const [key, until] of pendingUntil.entries()) {
          if (until > now) burstExcluded.add(key)
          else pendingUntil.delete(key)
        }

        for (let i = 0; i < maxPerTick; i += 1) {
          const target = findNervScannerCandidate(bot, config, targetByXZ, currentGoal, burstExcluded, currentActiveCols, retryPriority)
          if (!target) break

          const key = getTargetKey(target)
          burstExcluded.add(key)

          try {
            const result = await placeNervScannerTarget(bot, config, target)
            const confirmed = confirmTargetPlaced(target)

            if (confirmed) {
              seen.add(key)
              pendingUntil.delete(key)
              retryPriority.delete(key)
              inventoryDesyncHits.delete(`${target.blockName}:${key}`)
            } else if (result.state === 'placed') {
              pendingUntil.set(key, Date.now() + retryCooldownMs)
              retryPriority.add(key)
            }

            if (result.state === 'placed' && confirmed) {
              placed += 1
            } else if (result.state === 'placed') {
              // Fast path stays non-blocking; unresolved attempts are retried while still in range.
            } else if (result.state === 'already') {
              already += 1
              seen.add(key)
              pendingUntil.delete(key)
              retryPriority.delete(key)
              inventoryDesyncHits.delete(`${target.blockName}:${key}`)
            } else {
              if (!isTransientPlacementReason(result.reason)) {
                skipped += 1
              }
              if (!String(result.reason || '').startsWith('missing-item-')) {
                pendingUntil.set(key, Date.now() + retryCooldownMs)
                retryPriority.add(key)
                inventoryDesyncHits.delete(`${target.blockName}:${key}`)
              }
              if (String(result.reason || '').startsWith('missing-item-')) {
                const haveNow = countInventoryItems(bot, target.blockName)
                if (haveNow > 0) {
                  if (config.errorHandling?.logErrors !== false) {
                    console.log(`[${label}-INVENTORY-DESYNC] ${target.blockName} reported missing while inventory had ${haveNow}; retrying hotbar swap instead of emergency refill.`)
                  }
                  pendingUntil.set(key, Date.now() + inventoryDesyncCooldownMs)
                  retryPriority.add(key)
                  continue
                }
                emergencyRestockBlock = target.blockName
                active = false
                break
              }
              if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config) && !isTransientPlacementReason(result.reason)) {
                console.log(`[${label}-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
              }
            }
          } catch (err) {
            if (isRuntimeStopError(err)) throw err
            pendingUntil.set(key, Date.now() + retryCooldownMs)
            retryPriority.add(key)
            skipped += 1
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[${label}-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
            }
          }
        }
      }

      await delay(tickMs)
    }
  })())

  try {
    for (const checkpoint of checkpoints) {
      assertRuntimeContinue(bot, config, 'stopping-during-placement')
      if (emergencyRestockBlock) break

      currentGoal = checkpoint.position
      currentAction = checkpoint.action
      currentActiveCols = checkpoint.activeCols

      const sprintMode = String(printer.sprintMode || 'always').toLowerCase()
      const shouldSprint = sprintMode === 'always' || (sprintMode !== 'off' && currentAction === 'sprint')
      bot.setControlState('sprint', shouldSprint)

      try {
        await bot.pathfinder.goto(new GoalNear(checkpoint.position.x, checkpoint.position.y, checkpoint.position.z, checkpointBuffer))
      } catch (err) {
        if (!latencySafeInterrupted) throw err
      }
      if (latencySafeInterrupted) break

      if (checkpoint.action === 'lineEnd') {
        if (lineEndSettleMs > 0) {
          await delay(lineEndSettleMs)
        }
      }
    }
  } catch (err) {
    if (config.errorHandling?.logErrors !== false) {
      console.log(`[${label}-MOVE-ERROR] Traversal interrupted: ${err?.message || err}`)
    }
  } finally {
    active = false
    await placementLoop
  }

  if (latencySafeInterrupted) {
    const remainingTargets = getUnresolvedPlacementTargets(bot, config, batchTargets)
    if (remainingTargets.length) {
      const safe = await runLatencySafePlacementBatch(bot, config, remainingTargets, placeRange, `${label}-LATENCY-SAFE`)
      placed += safe.placed
      already += safe.already
      skipped += safe.skipped
      if (safe.remainingTargets?.length) {
        const fast = await runContinuousPlacementBatch(bot, config, safe.remainingTargets, rowOrder, placeRange, label)
        placed += fast.placed
        already += fast.already
        skipped += fast.skipped
      }
    }
  }

  if (emergencyRestockBlock) {
    console.log(`[${label}-EMERGENCY-RESTOCK] ${emergencyRestockBlock} unavailable during placement; refilling and retrying the remaining band once.`)
    const restocked = await waitForRequiredMaterialRestock(bot, config, emergencyRestockBlock, 1, neededByBlock, 'placement-emergency-restock')
    if (restocked || countInventoryItems(bot, emergencyRestockBlock) > 0) {
      const Vec3Retry = bot.entity.position.constructor
      const remainingTargets = batchTargets.filter((target) => {
        const actual = bot.blockAt(new Vec3Retry(target.position.x, target.position.y, target.position.z))
        return actual?.name !== target.blockName
      })
      if (remainingTargets.length > 0) {
        const retry = await runContinuousPlacementBatch(bot, config, remainingTargets, rowOrder, placeRange, label)
        placed += retry.placed
        already += retry.already
        skipped += retry.skipped
      }
    }
  }

  const Vec3 = bot.entity.position.constructor
  const missing = batchTargets.filter((target) => {
    const actual = bot.blockAt(new Vec3(target.position.x, target.position.y, target.position.z))
    return actual?.name !== target.blockName
  }).length

  return { placed, already, skipped, processed: batchTargets.length - missing }
}

function buildNervUCheckpoints(batchTargets, startOnNorthSide, segmentSize = 0) {
  const orderedCols = [...new Set(batchTargets.map((target) => target.col))]
  const leadCol = orderedCols[0]
  const leadTarget = batchTargets.find((target) => target.col === leadCol) || batchTargets[0]
  const leadX = toNumber(leadTarget?.position?.x, Math.min(...batchTargets.map((target) => target.position.x)))
  const leadY = toNumber(leadTarget?.position?.y, Math.min(...batchTargets.map((target) => target.position.y)))
  const minZ = Math.min(...batchTargets.map((target) => target.position.z))
  const maxZ = Math.max(...batchTargets.map((target) => target.position.z))
  const activeCols = new Set(batchTargets.map((target) => target.col))
  const cp1 = { x: leadX + 0.5, y: leadY, z: minZ + 0.5 }
  const cp2 = { x: leadX + 0.5, y: leadY, z: maxZ + 0.5 }

  if (segmentSize <= 0 || maxZ - minZ <= segmentSize) {
    return startOnNorthSide
      ? [{ position: cp1, action: '', activeCols }, { position: cp2, action: 'lineEnd', activeCols }]
      : [{ position: cp2, action: '', activeCols }, { position: cp1, action: 'lineEnd', activeCols }]
  }

  const startZ = startOnNorthSide ? minZ : maxZ
  const endZ = startOnNorthSide ? maxZ : minZ
  const dir = startOnNorthSide ? 1 : -1
  const checkpoints = [{ position: { x: leadX + 0.5, y: leadY, z: startZ + 0.5 }, action: '', activeCols }]
  for (let z = startZ + dir * segmentSize; dir > 0 ? z < endZ : z > endZ; z += dir * segmentSize) {
    checkpoints.push({ position: { x: leadX + 0.5, y: leadY, z: z + 0.5 }, action: 'inline-repair', activeCols })
  }
  checkpoints.push({ position: { x: leadX + 0.5, y: leadY, z: endZ + 0.5 }, action: 'lineEnd', activeCols })
  return checkpoints
}

async function runNervScannerPlacementBatch(bot, config, batchTargets, startOnNorthSide, allowEmergencyRestock = true) {
  if (!batchTargets.length) return { placed: 0, already: 0, skipped: 0, seen: 0, missing: 0 }

  const printer = config.printer || {}
  const placeRange = Math.max(1, toNumber(printer.placeRange, 4))
  if (shouldUseLatencySafeMode(bot, config, 'placement').active) {
    console.log(`[NERV-SCANNER-LATENCY-SAFE] MC ping high; switching ${batchTargets.length} target(s) to one-by-one confirmed placement.`)
    const safe = await runLatencySafePlacementBatch(bot, config, batchTargets, placeRange, 'NERV-SCANNER-LATENCY-SAFE')
    if (safe.remainingTargets?.length) {
      const fast = await runNervScannerPlacementBatch(bot, config, safe.remainingTargets, startOnNorthSide, allowEmergencyRestock)
      return mergePlacementResults(safe, fast)
    }
    return safe
  }

  const tickMs = Math.max(10, toNumber(printer.fastTraversalTickMs, 40))
  const maxPerTick = Math.max(1, toNumber(printer.maxPlacementsPerTick, 1))
  const checkpointBuffer = Math.max(0.5, toNumber(config.advanced?.checkpointBuffer, 0.8))

  const checkpoints = buildNervUCheckpoints(batchTargets, startOnNorthSide)

  const targetByXZ = new Map(batchTargets.map((target) => [`${target.position.x}:${target.position.z}`, target]))
  const neededByBlock = estimateNeededFromLookahead(batchTargets)
  let active = true
  let currentGoal = checkpoints[0].position
  let currentAction = checkpoints[0].action
  let currentActiveCols = checkpoints[0].activeCols
  let placed = 0
  let already = 0
  let skipped = 0
  let emergencyRestockBlock = null
  let latencySafeInterrupted = false
  const seen = new Set()
  const retryPriority = new Set()
  const inventoryDesyncHits = new Map()
  const maxInventoryDesyncHits = Math.max(1, toNumber(config.advanced?.scannerInventoryDesyncMaxHits, 3))
  const inventoryDesyncCooldownMs = Math.max(tickMs, toNumber(config.advanced?.scannerInventoryDesyncCooldownMs, 250))

  const placementLoop = observeBackgroundTask((async () => {
    while (active) {
      assertRuntimeContinue(bot, config, 'stopping-during-placement')
      if (shouldUseLatencySafeMode(bot, config, 'placement').active) {
        latencySafeInterrupted = true
        active = false
        stopBotMovement(bot)
        console.log('[NERV-SCANNER-LATENCY-SAFE] MC ping rose during fast traversal; stopping movement for confirmed placement.')
        break
      }
      const allowPlacement = currentAction === '' || currentAction === 'lineEnd' || currentAction === 'sprint'
      if (allowPlacement) {
        for (let i = 0; i < maxPerTick; i += 1) {
          const target = findNervScannerCandidate(bot, config, targetByXZ, currentGoal, seen, currentActiveCols, retryPriority)
          if (!target) break

          const key = `${target.position.x}:${target.position.y}:${target.position.z}`

          try {
            const result = await placeNervScannerTarget(bot, config, target)
            const confirmed = confirmTargetPlaced(target)

            if (confirmed) {
              seen.add(key)
              retryPriority.delete(key)
              inventoryDesyncHits.delete(`${target.blockName}:${key}`)
            } else if (result.state === 'placed') {
              retryPriority.add(key)
            }

            if (result.state === 'placed' && confirmed) placed += 1
            else if (result.state === 'placed') {
              // Leave unconfirmed fast attempts in the retry set without treating them as failures.
            } else if (result.state === 'already') {
              already += 1
              seen.add(key)
              retryPriority.delete(key)
              inventoryDesyncHits.delete(`${target.blockName}:${key}`)
            } else {
              skipped += 1
              retryPriority.add(key)
              if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
                console.log(`[NERV-SCANNER-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
              }
              if (allowEmergencyRestock && String(result.reason || '').startsWith('missing-item-')) {
                const haveNow = countInventoryItems(bot, target.blockName)
                if (haveNow > 0) {
                  if (config.errorHandling?.logErrors !== false) {
                    console.log(`[NERV-SCANNER-INVENTORY-DESYNC] ${target.blockName} reported missing while inventory had ${haveNow}; retrying hotbar swap instead of emergency refill.`)
                  }
                  retryPriority.add(key)
                  await delay(inventoryDesyncCooldownMs)
                  break
                }
                emergencyRestockBlock = target.blockName
                active = false
                break
              }
            }
          } catch (err) {
            if (isRuntimeStopError(err)) throw err
            skipped += 1
            retryPriority.add(key)
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[NERV-SCANNER-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
            }
          }
        }
      }

      await delay(tickMs)
    }
  })())

  try {
    for (const checkpoint of checkpoints) {
      if (emergencyRestockBlock) break
      currentGoal = checkpoint.position
      currentAction = checkpoint.action
      currentActiveCols = checkpoint.activeCols
      const sprintMode = String(printer.sprintMode || 'notPlacing').toLowerCase()
      const shouldSprint = sprintMode === 'always' || (sprintMode !== 'off' && currentAction === 'sprint')
      bot.setControlState('sprint', shouldSprint)
      try {
        await bot.pathfinder.goto(new GoalNear(checkpoint.position.x, checkpoint.position.y, checkpoint.position.z, checkpointBuffer))
      } catch (err) {
        if (!latencySafeInterrupted) throw err
      }
      if (latencySafeInterrupted) break
    }
  } finally {
    active = false
    await placementLoop
  }

  if (latencySafeInterrupted) {
    const remainingTargets = getUnresolvedPlacementTargets(bot, config, batchTargets)
    if (remainingTargets.length) {
      const safe = await runLatencySafePlacementBatch(bot, config, remainingTargets, placeRange, 'NERV-SCANNER-LATENCY-SAFE')
      placed += safe.placed
      already += safe.already
      skipped += safe.skipped
      latencySafeSeen += toNumber(safe.seen, 0)
      if (safe.remainingTargets?.length) {
        const fast = await runNervScannerPlacementBatch(bot, config, safe.remainingTargets, startOnNorthSide, allowEmergencyRestock)
        placed += fast.placed
        already += fast.already
        skipped += fast.skipped
        latencySafeSeen += toNumber(fast.seen, 0)
      }
    }
  }

  if (allowEmergencyRestock && emergencyRestockBlock) {
    console.log(`[NERV-SCANNER-EMERGENCY-RESTOCK] ${emergencyRestockBlock} unavailable during placement; stopping movement, refilling, and retrying remaining targets once.`)
    const restocked = await waitForRequiredMaterialRestock(bot, config, emergencyRestockBlock, 1, neededByBlock, 'scanner-emergency-restock')
    if (restocked || countInventoryItems(bot, emergencyRestockBlock) > 0) {
      const Vec3Retry = bot.entity.position.constructor
      const remainingTargets = batchTargets.filter((target) => {
        const actual = bot.blockAt(new Vec3Retry(target.position.x, target.position.y, target.position.z))
        return actual?.name !== target.blockName
      })
      if (remainingTargets.length) {
        const retry = await runNervScannerPlacementBatch(bot, config, remainingTargets, startOnNorthSide, false)
        placed += retry.placed
        already += retry.already
        skipped += retry.skipped
      }
    }
  }

  const Vec3 = bot.entity.position.constructor
  let missing = 0
  for (const target of batchTargets) {
    const actual = bot.blockAt(new Vec3(target.position.x, target.position.y, target.position.z))
    if (actual?.name !== target.blockName) missing += 1
  }

  return { placed, already, skipped, seen: seen.size + latencySafeSeen, missing }
}

async function runNervTimeWorkloadPlacementBatch(bot, config, batchTargets, startOnNorthSide, allowEmergencyRestock = true) {
  if (!batchTargets.length) {
    return { placed: 0, already: 0, skipped: 0, seen: 0, missing: 0, hardStops: 0, rawAllowed: 0, capped: 0, maxAllowed: 0 }
  }

  const printer = config.printer || {}
  const advanced = config.advanced || {}
  const placeRange = Math.max(1, toNumber(printer.placeRange, 4))
  if (shouldUseLatencySafeMode(bot, config, 'placement').active) {
    console.log(`[NERV-WORKLOAD-LATENCY-SAFE] MC ping high; switching ${batchTargets.length} target(s) to one-by-one confirmed placement.`)
    const safe = await runLatencySafePlacementBatch(bot, config, batchTargets, placeRange, 'NERV-WORKLOAD-LATENCY-SAFE')
    if (safe.remainingTargets?.length) {
      const fast = await runNervTimeWorkloadPlacementBatch(bot, config, safe.remainingTargets, startOnNorthSide, allowEmergencyRestock)
      return mergePlacementResults(safe, fast)
    }
    return safe
  }

  const placeDelayMs = Math.max(0, toNumber(advanced.scannerPlaceDelayMs, 0))
  const maxCatchup = Math.max(1, toNumber(advanced.scannerMaxCatchupPlacements, 30))
  const pollMs = Math.max(0, toNumber(advanced.scannerWorkloadPollMs, 0))
  const retryCooldownMs = Math.max(0, toNumber(advanced.scannerRetryCooldownMs, 30))
  const optimisticRetryMs = Math.max(25, toNumber(advanced.scannerOptimisticRetryMs, Math.max(120, pollMs * 4)))
  const inlineRepairEnabled = advanced.scannerInlineRepairEnabled === true
  const lineEndSettleMs = Math.max(0, toNumber(advanced.scannerLineEndSettleMs, 0))
  const missRecoveryEnabled = advanced.scannerMissRecoveryEnabled !== false
  const missRecoveryThreshold = Math.max(1, toNumber(advanced.scannerMissRecoveryThreshold, 3))
  const missRecoveryBacktrackBlocks = Math.max(1, toNumber(advanced.scannerMissRecoveryBacktrackBlocks, 3))
  const alertPollMs = Math.max(10, toNumber(advanced.scannerAlertPollMs, Math.max(pollMs, 25)))
  const alertReach = Math.max(1, toNumber(advanced.scannerAlertReach, Math.max(printer.placeRange, 4) + 0.75))
  const checkpointBuffer = Math.max(0.5, toNumber(advanced.checkpointBuffer, 0.8))
  const checkpointMoveTimeoutMs = Math.max(1000, toNumber(advanced.workloadCheckpointMoveTimeoutMs, 30000))
  const checkpointTimeoutAcceptExtraRange = Math.max(0, toNumber(advanced.workloadCheckpointTimeoutAcceptExtraRange, 0.35))
  const straightCheckpointMovement = advanced.workloadStraightCheckpointMovement !== false
  const straightCheckpointTickMs = Math.max(25, toNumber(advanced.workloadStraightCheckpointTickMs, 50))
  const stallTimeoutMs = Math.max(0, toNumber(advanced.placementStallTimeoutMs, 5000))

  const stallSkipRadiusBlocks = Math.max(1, toNumber(advanced.placementStallSkipRadiusBlocks, placeRange + 1))
  const stallRecoveryMs = Math.max(0, toNumber(advanced.placementStallRecoveryMs, stallTimeoutMs > 0 ? Math.min(2000, Math.max(1500, Math.floor(stallTimeoutMs * 0.4))) : 0))
  const stallRecoveryAttempts = Math.max(0, toNumber(advanced.placementStallRecoveryAttempts, 3))
  const stallRecoveryConfirmMs = Math.max(20, toNumber(advanced.placementStallRecoveryConfirmMs, Math.max(160, toNumber(advanced.scannerPlaceConfirmMs, 80) * 2)))
  const stallRecoverySettleMs = Math.max(0, toNumber(advanced.placementStallRecoverySettleMs, 120))
  const stallRecoveryCooldownMs = Math.max(0, toNumber(advanced.placementStallRecoveryCooldownMs, 750))
  const inlineSegmentBlocks = Math.max(2, toNumber(advanced.inlineRepairSegmentBlocks, Math.max(2, placeRange - 1)))
  const checkpoints = buildNervUCheckpoints(batchTargets, startOnNorthSide, inlineSegmentBlocks)

  const targetByXZ = new Map(batchTargets.map((target) => [`${target.position.x}:${target.position.z}`, target]))
  let active = true
  let currentGoal = checkpoints[0].position
  let currentAction = checkpoints[0].action
  let currentActiveCols = checkpoints[0].activeCols
  let lastTickTime = Date.now()
  let placed = 0
  let already = 0
  let skipped = 0
  let hardStops = 0
  let rawAllowedTotal = 0
  let cappedTotal = 0
  let maxAllowedSeen = 0
  let emergencyRestockBlock = null
  let emergencyRestockReason = 'unavailable during placement'
  let emergencyRestockAnchor = null
  let prevCheckpointPos = null
  let latencySafeInterrupted = false
  let latencySafeSeen = 0
  const seen = new Set()
  const stallSkipped = new Set()
  const pendingUntil = new Map()
  const retryPriority = new Set()
  const repairAlerts = new Map()
  const inventoryDesyncHits = new Map()
  let lastAlertScanAt = 0
  let checkpointMoveInProgress = false
  const maxInventoryDesyncHits = Math.max(1, toNumber(advanced.scannerInventoryDesyncMaxHits, 3))
  const inventoryDesyncCooldownMs = Math.max(retryCooldownMs, toNumber(advanced.scannerInventoryDesyncCooldownMs, 250))
  const stall = {
    lastWorldProgressAt: Date.now(),
    attemptsSinceWorldProgress: 0,
    optimisticPlacementsSinceWorldProgress: 0,
    lastTarget: null,
    recoveryAttemptsSinceWorldProgress: 0,
    lastRecoveryAt: 0,
    recovering: false
  }

  const getTargetKey = (target) => `${target.position.x}:${target.position.y}:${target.position.z}`
  const captureEmergencyRestockAnchor = (target, reason) => {
    if (!target?.position) return
    const botPos = bot?.entity?.position
    emergencyRestockAnchor = {
      target,
      reason,
      botPos: botPos ? { x: botPos.x, y: botPos.y, z: botPos.z } : null,
      goal: currentGoal ? { x: currentGoal.x, y: currentGoal.y, z: currentGoal.z } : null,
      action: currentAction || ''
    }
  }
  const returnToEmergencyRestockAnchor = async () => {
    const target = emergencyRestockAnchor?.target
    if (!target?.position) return false
    const anchorRange = Math.max(0.75, toNumber(advanced.emergencyRestockReturnRange, Math.max(1.25, placeRange - 1)))
    const pos = target.position
    const botPos = bot?.entity?.position
    const beforeLabel = botPos ? `${botPos.x.toFixed(2)} ${botPos.y.toFixed(2)} ${botPos.z.toFixed(2)}` : 'unknown'
    console.log(`[NERV-WORKLOAD-RESTOCK-RETURN] block=${emergencyRestockBlock || target.blockName} target=${pos.x} ${pos.y} ${pos.z} range=${anchorRange} reason=${emergencyRestockAnchor.reason || 'restock'} from=${beforeLabel}`)
    try {
      bot.setControlState('sprint', false)
      bot.setControlState('forward', false)
      bot.setControlState('back', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
      await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, anchorRange))
      return true
    } catch (err) {
      console.log(`[NERV-WORKLOAD-RESTOCK-RETURN-WARN] target=${pos.x} ${pos.y} ${pos.z} -> ${err?.message || err}`)
      return false
    }
  }
  const isTransientPlacementReason = (reason) => {
    const text = String(reason || '')
    return text === 'unconfirmed-place' || text.startsWith('held-item-desync-')
  }
  const shouldWalkCheckpointStraight = (checkpoint) => {
    if (!straightCheckpointMovement) return false
    const action = String(checkpoint?.action || '')
    return action === 'inline-repair' || action === 'lineEnd' || action === 'sprint'
  }
  const noteWorldPlacementProgress = () => {
    stall.lastWorldProgressAt = Date.now()
    stall.attemptsSinceWorldProgress = 0
    stall.optimisticPlacementsSinceWorldProgress = 0
    stall.recoveryAttemptsSinceWorldProgress = 0
    stall.lastTarget = null
  }
  const noteOptimisticPlacement = () => {
    stall.optimisticPlacementsSinceWorldProgress += 1
  }
  const notePlacementAttempt = (target) => {
    stall.attemptsSinceWorldProgress += 1
    stall.lastTarget = target
  }
  const handlePlacementStall = async () => {
    if (emergencyRestockBlock) return []
    if (checkpointMoveInProgress) {
      // Foreground checkpoint movement owns pathfinder.goto. Do not let background
      // stall recovery change the goal and abort traversal with GoalChanged.
      stall.lastWorldProgressAt = Date.now()
      stall.attemptsSinceWorldProgress = 0
      stall.optimisticPlacementsSinceWorldProgress = 0
      stall.recoveryAttemptsSinceWorldProgress = 0
      stall.lastTarget = null
      return []
    }
    if (!stallTimeoutMs || stall.attemptsSinceWorldProgress <= 0) return []
    const stalledMs = Date.now() - stall.lastWorldProgressAt
    if (
      stallRecoveryMs > 0 &&
      stallRecoveryAttempts > 0 &&
      stalledMs >= stallRecoveryMs &&
      stall.recoveryAttemptsSinceWorldProgress < stallRecoveryAttempts &&
      !stall.recovering &&
      Date.now() - stall.lastRecoveryAt >= stallRecoveryCooldownMs
    ) {
      const recovered = await recoverPlacementStall(stalledMs)
      if (recovered || emergencyRestockBlock || stall.attemptsSinceWorldProgress <= 0) return []
    }
    if (stalledMs < stallTimeoutMs) return []
    const target = stall.lastTarget
    const pos = target?.position
    const targetLabel = pos ? `${pos.x} ${pos.y} ${pos.z}` : 'unknown'
    const botPos = bot?.entity?.position
    const centerX = Number.isFinite(pos?.x) ? pos.x + 0.5 : botPos?.x
    const centerZ = Number.isFinite(pos?.z) ? pos.z + 0.5 : botPos?.z
    const radius2 = stallSkipRadiusBlocks * stallSkipRadiusBlocks
    const skippedKeys = []

    if (Number.isFinite(centerX) && Number.isFinite(centerZ)) {
      for (const candidate of batchTargets) {
        if (currentActiveCols instanceof Set && !currentActiveCols.has(candidate.col)) continue
        const key = getTargetKey(candidate)
        if (seen.has(key) || stallSkipped.has(key)) continue
        const dx = (candidate.position.x + 0.5) - centerX
        const dz = (candidate.position.z + 0.5) - centerZ
        if ((dx * dx + dz * dz) > radius2) continue

        stallSkipped.add(key)
        skippedKeys.push(key)
        pendingUntil.delete(key)
        retryPriority.delete(key)
        clearRepairAlert(key)
        inventoryDesyncHits.delete(`${candidate.blockName}:${key}`)
      }
    }

    skipped += skippedKeys.length
    console.log(`[NERV-WORKLOAD-STALL-SKIP] buffer=${stallSkipRadiusBlocks} skipped=${skippedKeys.length} lastTarget=${targetLabel} stalledMs=${stalledMs} attempts=${stall.attemptsSinceWorldProgress} optimistic=${stall.optimisticPlacementsSinceWorldProgress}`)
    stall.lastWorldProgressAt = Date.now()
    stall.attemptsSinceWorldProgress = 0
    stall.optimisticPlacementsSinceWorldProgress = 0
    stall.recoveryAttemptsSinceWorldProgress = 0
    stall.lastTarget = null
    return skippedKeys
  }
  const raiseRepairAlert = (target, reason) => {
    const key = getTargetKey(target)
    if (seen.has(key)) return
    retryPriority.add(key)
    pendingUntil.set(key, 0)
    const existing = repairAlerts.get(key)
    if (!existing || existing.reason !== reason) {
      repairAlerts.set(key, { target, reason, lastRaisedAt: Date.now() })
      if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
        console.log(`[NERV-WORKLOAD-ALERT] ${target.position.x} ${target.position.y} ${target.position.z} (${reason})`)
      }
    }
  }
  const clearRepairAlert = (key) => {
    repairAlerts.delete(key)
    retryPriority.delete(key)
  }
  const markTargetPlacedInWorld = (target, key = getTargetKey(target)) => {
    seen.add(key)
    pendingUntil.delete(key)
    inventoryDesyncHits.delete(`${target.blockName}:${key}`)
    clearRepairAlert(key)
    noteWorldPlacementProgress()
  }
  const getTargetWorldBlock = (target) => {
    const Vec3Target = bot.entity.position.constructor
    return bot.blockAt(new Vec3Target(target.position.x, target.position.y, target.position.z))
  }
  const formatTargetLabel = (target) => target?.position
    ? `${target.position.x} ${target.position.y} ${target.position.z}`
    : 'unknown'
  const getSelectedHotbarName = () => {
    const selectedIndex = Number.isFinite(bot.quickBarSlot) ? bot.quickBarSlot : -1
    const selectedStack = selectedIndex >= 0 ? bot.inventory?.slots?.[getHotbarWindowSlot(selectedIndex)] : null
    return selectedStack?.name || 'empty'
  }
  const getWorkloadRuntime = (reason) => classifyRuntimePosition(bot, config, reason)
  const isWorkloadPlatformReady = (runtime = null) => {
    if (config.advanced?.platformWatchdogEnabled === false || getPlatformBounds(config) == null) return true
    const resolved = runtime || getWorkloadRuntime('workload-platform-check')
    if (resolved?.classification?.platform === true) return true
    const pos = bot?.entity?.position
    return isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config)
  }
  const waitForWorkloadPlatformReady = async (reason) => {
    if (isWorkloadPlatformReady()) return true
    const runtime = getWorkloadRuntime(reason)
    const state = runtime?.classification?.state || 'unknown'
    const pos = formatBotPosition(bot)
    console.log(`[NERV-WORKLOAD-PLATFORM-HOLD] reason=${reason} state=${state} pos=${pos}; pausing placement until platform is ready.`)
    stopBotMovement(bot)
    await waitForPlatformReady(bot, config, reason)
    lastTickTime = Date.now()
    return isWorkloadPlatformReady()
  }
  const chooseStallRecoveryTargets = () => {
    const selected = []
    const selectedKeys = new Set()
    const addCandidate = (target) => {
      if (!target) return
      const key = getTargetKey(target)
      if (selectedKeys.has(key) || seen.has(key) || stallSkipped.has(key)) return
      if (currentActiveCols instanceof Set && !currentActiveCols.has(target.col)) return
      const actual = getTargetWorldBlock(target)
      if (actual?.name === target.blockName) {
        markTargetPlacedInWorld(target, key)
        return
      }
      if (actual && actual.name !== 'air' && !String(actual.name).endsWith('_carpet')) return
      selected.push(target)
      selectedKeys.add(key)
    }

    addCandidate(stall.lastTarget)

    const botPos = bot.entity.position
    const candidates = batchTargets
      .filter((target) => {
        if (selectedKeys.has(getTargetKey(target))) return false
        if (currentActiveCols instanceof Set && !currentActiveCols.has(target.col)) return false
        if (seen.has(getTargetKey(target)) || stallSkipped.has(getTargetKey(target))) return false
        const dx = botPos.x - (target.position.x + 0.5)
        const dy = botPos.y - (target.position.y + 0.5)
        const dz = botPos.z - (target.position.z + 0.5)
        return dx * dx + dy * dy + dz * dz <= placeRange * placeRange
      })
      .sort((a, b) => {
        const adx = botPos.x - (a.position.x + 0.5)
        const ady = botPos.y - (a.position.y + 0.5)
        const adz = botPos.z - (a.position.z + 0.5)
        const bdx = botPos.x - (b.position.x + 0.5)
        const bdy = botPos.y - (b.position.y + 0.5)
        const bdz = botPos.z - (b.position.z + 0.5)
        return (adx * adx + ady * ady + adz * adz) - (bdx * bdx + bdy * bdy + bdz * bdz)
      })

    for (const candidate of candidates) {
      if (selected.length >= stallRecoveryAttempts) break
      addCandidate(candidate)
    }

    return selected.slice(0, stallRecoveryAttempts)
  }
  const recoverPlacementStall = async (stalledMs) => {
    const targets = chooseStallRecoveryTargets()
    if (!targets.length) return false

    stall.recovering = true
    stall.lastRecoveryAt = Date.now()
    stall.recoveryAttemptsSinceWorldProgress += 1

    const wasSprinting = bot.controlState?.sprint === true
    const wasSneaking = bot.controlState?.sneak === true
    const primary = targets[0]
    const botPos = bot.entity.position
    const recoveryConfig = {
      ...config,
      printer: { ...printer, rotate: true },
      advanced: { ...advanced, scannerPlaceConfirmMs: stallRecoveryConfirmMs }
    }
    console.log(`[NERV-WORKLOAD-STALL-RECOVER] start recovery=${stall.recoveryAttemptsSinceWorldProgress}/${stallRecoveryAttempts} stalledMs=${stalledMs} attempts=${stall.attemptsSinceWorldProgress} optimistic=${stall.optimisticPlacementsSinceWorldProgress} target=${formatTargetLabel(primary)} confirmMs=${stallRecoveryConfirmMs} held=${bot.heldItem?.name || 'empty'} selected=${getSelectedHotbarName()} pos=${botPos.x.toFixed(2)} ${botPos.y.toFixed(2)} ${botPos.z.toFixed(2)}`)
    logPingDiagnostic(bot, config, 'workload-stall-recover-start', {
      target: formatTargetLabel(primary),
      stalledMs,
      attempts: stall.attemptsSinceWorldProgress,
      optimistic: stall.optimisticPlacementsSinceWorldProgress,
      held: bot.heldItem?.name || 'empty',
      selected: getSelectedHotbarName(),
      pos: `${botPos.x.toFixed(2)},${botPos.y.toFixed(2)},${botPos.z.toFixed(2)}`
    }, { force: true })

    try {
      bot.setControlState('sprint', false)
      bot.setControlState('forward', false)
      bot.setControlState('back', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
      if (advanced.placementStallRecoverySneak !== false) bot.setControlState('sneak', true)
      if (stallRecoverySettleMs > 0) await delay(stallRecoverySettleMs)

      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index]
        const key = getTargetKey(target)
        const before = getTargetWorldBlock(target)
        if (before?.name === target.blockName) {
          markTargetPlacedInWorld(target, key)
          console.log(`[NERV-WORKLOAD-STALL-RECOVER] success attempt=${index + 1}/${targets.length} target=${formatTargetLabel(target)} already=true held=${bot.heldItem?.name || 'empty'} selected=${getSelectedHotbarName()}`)
          return true
        }

        const have = countInventoryItems(bot, target.blockName)
        if (have <= 0) {
          console.log(`[NERV-WORKLOAD-STALL-RECOVER] missing-inventory target=${formatTargetLabel(target)} block=${target.blockName} have=0 held=${bot.heldItem?.name || 'empty'} selected=${getSelectedHotbarName()}`)
          if (allowEmergencyRestock) {
            hardStops += 1
            emergencyRestockBlock = target.blockName
            emergencyRestockReason = 'missing inventory during stall recovery'
            captureEmergencyRestockAnchor(target, emergencyRestockReason)
            active = false
          }
          return false
        }

        const selected = await selectHotbarMaterial(bot, config, target.blockName, { fastSwap: false })
        if (!selected) {
          pendingUntil.set(key, Date.now() + inventoryDesyncCooldownMs)
          retryPriority.add(key)
          console.log(`[NERV-WORKLOAD-STALL-RECOVER] select-failed attempt=${index + 1}/${targets.length} target=${formatTargetLabel(target)} block=${target.blockName} have=${have} held=${bot.heldItem?.name || 'empty'} selected=${getSelectedHotbarName()}`)
          logPingDiagnostic(bot, config, 'workload-stall-select-failed', {
            target: formatTargetLabel(target),
            block: target.blockName,
            have,
            held: bot.heldItem?.name || 'empty',
            selected: getSelectedHotbarName(),
            pos: formatBotPosition(bot)
          }, { force: true })
          continue
        }

        let result = null
        let errorMessage = ''
        try {
          result = await placeTarget(bot, recoveryConfig, target, false)
        } catch (err) {
          errorMessage = err?.message || String(err)
        }

        const after = getTargetWorldBlock(target)
        const confirmed = after?.name === target.blockName
        const resultLabel = result ? `${result.state}${result.reason ? `:${result.reason}` : ''}` : `error:${errorMessage}`
        console.log(`[NERV-WORKLOAD-STALL-RECOVER] attempt=${index + 1}/${targets.length} target=${formatTargetLabel(target)} result=${resultLabel} confirmed=${confirmed} before=${before?.name || 'unloaded'} after=${after?.name || 'unloaded'} block=${target.blockName} have=${have} held=${bot.heldItem?.name || 'empty'} selected=${getSelectedHotbarName()}`)

        if (confirmed) {
          markTargetPlacedInWorld(target, key)
          return true
        }

        pendingUntil.set(key, Date.now() + inventoryDesyncCooldownMs)
        retryPriority.add(key)
      }

      const failedStalledMs = Date.now() - stall.lastWorldProgressAt
      console.log(`[NERV-WORKLOAD-STALL-RECOVER] failed recovery=${stall.recoveryAttemptsSinceWorldProgress}/${stallRecoveryAttempts} tried=${targets.length} stalledMs=${failedStalledMs} held=${bot.heldItem?.name || 'empty'} selected=${getSelectedHotbarName()}`)
      logPingDiagnostic(bot, config, 'workload-stall-recover-failed', {
        target: formatTargetLabel(primary),
        tried: targets.length,
        stalledMs: failedStalledMs,
        held: bot.heldItem?.name || 'empty',
        selected: getSelectedHotbarName(),
        pos: formatBotPosition(bot)
      }, { force: true })
      if (allowEmergencyRestock && advanced.placementStallEmergencyRestock !== false && primary?.blockName) {
        hardStops += 1
        emergencyRestockBlock = primary.blockName
        emergencyRestockReason = `stall recovery failed after ${failedStalledMs}ms without confirmed placement`
        captureEmergencyRestockAnchor(primary, emergencyRestockReason)
        active = false
        console.log(`[NERV-WORKLOAD-STALL-RESTOCK] block=${emergencyRestockBlock} reason="${emergencyRestockReason}"; forcing emergency restock/refresh before retry.`)
        logPingDiagnostic(bot, config, 'workload-stall-restock-requested', {
          block: emergencyRestockBlock,
          target: formatTargetLabel(primary),
          pos: formatBotPosition(bot),
          reason: emergencyRestockReason
        }, { force: true })
      }
      return false
    } finally {
      if (advanced.placementStallRecoverySneak !== false && !wasSneaking) bot.setControlState('sneak', false)
      bot.setControlState('sprint', wasSprinting)
      stall.recovering = false
      lastTickTime = Date.now()
    }
  }
  const getUnresolvedTargetsForActiveCols = (activeCols) => {
    const Vec3Current = bot.entity.position.constructor
    return batchTargets.filter((target) => {
      if (activeCols instanceof Set && !activeCols.has(target.col)) return false
      if (stallSkipped.has(getTargetKey(target))) return false
      const actual = bot.blockAt(new Vec3Current(target.position.x, target.position.y, target.position.z))
      return actual?.name !== target.blockName
    })
  }
  const getUnresolvedTraversalTargets = () => {
    const Vec3Current = bot.entity.position.constructor
    return batchTargets.filter((target) => {
      if (stallSkipped.has(getTargetKey(target))) return false
      const actual = bot.blockAt(new Vec3Current(target.position.x, target.position.y, target.position.z))
      return actual?.name !== target.blockName
    })
  }
  const scanNearbyRepairAlerts = () => {
    const now = Date.now()
    if (now - lastAlertScanAt < alertPollMs) return
    lastAlertScanAt = now

    const botPos = bot.entity.position
    const Vec3Alert = bot.entity.position.constructor

    for (const target of batchTargets) {
      if (currentActiveCols instanceof Set && !currentActiveCols.has(target.col)) continue

      const key = getTargetKey(target)
      if (seen.has(key)) {
        clearRepairAlert(key)
        pendingUntil.delete(key)
        continue
      }
      if (stallSkipped.has(key)) {
        clearRepairAlert(key)
        pendingUntil.delete(key)
        continue
      }

      const targetPos = new Vec3Alert(target.position.x, target.position.y, target.position.z)
      const distance = botPos.distanceTo(targetPos.offset(0.5, 0.5, 0.5))
      if (distance > alertReach) continue

      const actual = bot.blockAt(targetPos)
      if (actual?.name === target.blockName) {
        markTargetPlacedInWorld(target, key)
        continue
      }

      const reason = !actual || actual.name === 'air'
        ? 'missing'
        : `wrong-${actual.name}`
      raiseRepairAlert(target, reason)
    }
  }
  const drainActiveColumnTargets = async (timeoutMs) => {
    const drainTimeoutMs = Math.max(0, toNumber(timeoutMs, 0))
    if (drainTimeoutMs <= 0) return

    const drainStart = Date.now()
    const placeRangeSq = placeRange * placeRange
    const Vec3Drain = bot.entity.position.constructor
    while (Date.now() - drainStart < drainTimeoutMs) {
      assertRuntimeContinue(bot, config, 'stopping-during-placement')
      const now = Date.now()
      const botPos = bot.entity.position
      const hasNearbyPending = batchTargets.some((target) => {
        const key = getTargetKey(target)
        if (seen.has(key) || stallSkipped.has(key)) return false
        if (currentActiveCols instanceof Set && !currentActiveCols.has(target.col)) return false
        const actual = bot.blockAt(new Vec3Drain(target.position.x, target.position.y, target.position.z))
        if (actual?.name === target.blockName) {
          markTargetPlacedInWorld(target, key)
          return false
        }
        const pendingExpiry = pendingUntil.get(key)
        if (pendingExpiry !== undefined && pendingExpiry > now + drainTimeoutMs) return false
        const dx = botPos.x - (target.position.x + 0.5)
        const dy = botPos.y - (target.position.y + 0.5)
        const dz = botPos.z - (target.position.z + 0.5)
        return dx * dx + dy * dy + dz * dz <= placeRangeSq
      })
      if (!hasNearbyPending) break
      await delay(Math.max(1, pollMs || 10))
    }
  }

  const placementLoop = observeBackgroundTask((async () => {
    while (active) {
      assertRuntimeContinue(bot, config, 'stopping-during-placement')
      if (shouldUseLatencySafeMode(bot, config, 'placement').active) {
        latencySafeInterrupted = true
        active = false
        stopBotMovement(bot)
        console.log('[NERV-WORKLOAD-LATENCY-SAFE] MC ping rose during fast traversal; stopping movement for confirmed placement.')
        break
      }
      if (!isWorkloadPlatformReady()) {
        if (!checkpointMoveInProgress) {
          await waitForWorkloadPlatformReady('workload-placement-loop')
        } else {
          lastTickTime = Date.now()
          await delay(Math.max(250, pollMs || 0))
        }
        continue
      }
      if (inlineRepairEnabled) {
        scanNearbyRepairAlerts()
      }

      const now = Date.now()
      logPingDiagnostic(bot, config, 'placement-loop', {
        action: currentAction || 'place',
        goal: currentGoal ? `${currentGoal.x},${currentGoal.y},${currentGoal.z}` : 'none',
        pos: formatBotPosition(bot)
      }, { throttleKey: 'ping-placement-loop' })
      const rawAllowed = placeDelayMs > 0 ? Math.floor((now - lastTickTime) / placeDelayMs) : maxCatchup

      if (rawAllowed <= 0) {
        if (pollMs > 0) await delay(pollMs)
        else await delay(1)
        continue
      }

      lastTickTime = placeDelayMs > 0 ? lastTickTime + rawAllowed * placeDelayMs : now
      rawAllowedTotal += rawAllowed
      const allowed = Math.min(rawAllowed, maxCatchup)
      cappedTotal += Math.max(0, rawAllowed - allowed)
      maxAllowedSeen = Math.max(maxAllowedSeen, rawAllowed)

      const allowPlacement = currentAction === '' || currentAction === 'lineEnd' || currentAction === 'sprint' || currentAction === 'inline-repair'
      if (allowPlacement) {
        const burstExcluded = new Set([...seen, ...stallSkipped])
        for (const [key, until] of pendingUntil.entries()) {
          if (until > now && !retryPriority.has(key)) burstExcluded.add(key)
          else pendingUntil.delete(key)
        }

        for (let i = 0; i < allowed; i += 1) {
          const target = findNervScannerCandidate(bot, config, targetByXZ, currentGoal, burstExcluded, currentActiveCols, retryPriority)
          if (!target) break

          const key = `${target.position.x}:${target.position.y}:${target.position.z}`
          burstExcluded.add(key)
          notePlacementAttempt(target)

          try {
            const result = await placeNervScannerTarget(bot, config, target)

            if (result.state === 'placed') {
              placed += 1
              pendingUntil.set(key, now + optimisticRetryMs)
              retryPriority.delete(key)
              inventoryDesyncHits.delete(`${target.blockName}:${key}`)
              clearRepairAlert(key)
              const Vec3Placed = bot.entity.position.constructor
              const actual = bot.blockAt(new Vec3Placed(target.position.x, target.position.y, target.position.z))
              if (actual?.name === target.blockName) {
                markTargetPlacedInWorld(target, key)
              } else {
                noteOptimisticPlacement()
              }
            } else if (result.state === 'already') {
              already += 1
              markTargetPlacedInWorld(target, key)
            } else {
              if (!isTransientPlacementReason(result.reason)) {
                skipped += 1
              }
              if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
                console.log(`[NERV-WORKLOAD-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
              }
              if (isTransientPlacementReason(result.reason)) {
                logPingDiagnostic(bot, config, `workload-${result.reason}`, {
                  target: `${target.position.x},${target.position.y},${target.position.z}`,
                  block: target.blockName,
                  held: bot.heldItem?.name || 'empty',
                  selected: getSelectedHotbarName(),
                  pos: formatBotPosition(bot)
                }, { force: true })
              }

              if (!String(result.reason || '').startsWith('missing-item-')) {
                pendingUntil.set(key, 0)
                inventoryDesyncHits.delete(`${target.blockName}:${key}`)
              } else {
                const haveNow = countInventoryItems(bot, target.blockName)
                if (allowEmergencyRestock && haveNow <= 0) {
                  hardStops += 1
                  emergencyRestockBlock = target.blockName
                  emergencyRestockReason = 'missing item during placement'
                  captureEmergencyRestockAnchor(target, emergencyRestockReason)
                  active = false
                  lastTickTime = Date.now()
                  break
                }
                if (config.errorHandling?.logErrors !== false && haveNow > 0) {
                  console.log(`[NERV-WORKLOAD-INVENTORY-DESYNC] ${target.blockName} reported missing while inventory had ${haveNow}; retrying hotbar swap instead of emergency refill.`)
                }
                pendingUntil.set(key, Date.now() + inventoryDesyncCooldownMs)
                retryPriority.add(key)
                lastTickTime = Date.now()
                break
              }
            }
          } catch (err) {
            if (isRuntimeStopError(err)) throw err
            skipped += 1
            hardStops += 1
            pendingUntil.set(key, 0)
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[NERV-WORKLOAD-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
            }
            lastTickTime = Date.now()
            break
          }

          const stallSkippedNow = await handlePlacementStall()
          for (const skippedKey of stallSkippedNow) burstExcluded.add(skippedKey)
          if (stallSkippedNow.length > 0) {
            break
          }
        }
      }

      await handlePlacementStall()

      if (pollMs > 0) await delay(pollMs)
      else await delay(1)
    }
  })())

  try {
    for (const checkpoint of checkpoints) {
      assertRuntimeContinue(bot, config, 'stopping-during-placement')
      if (emergencyRestockBlock) break
      while (true) {
        assertRuntimeContinue(bot, config, 'stopping-during-placement')
        await waitForWorkloadPlatformReady('workload-checkpoint-pre')
        currentGoal = checkpoint.position
        currentAction = checkpoint.action
        currentActiveCols = checkpoint.activeCols
        const sprintMode = String(printer.sprintMode || 'notPlacing').toLowerCase()
        const shouldSprint = sprintMode === 'always' || (sprintMode !== 'off' && currentAction === 'sprint')
        bot.setControlState('sprint', shouldSprint)
        const beforeMove = bot.entity.position
        const checkpointAcceptRange = checkpointBuffer + checkpointTimeoutAcceptExtraRange
        const checkpointIsCloseEnough = () => distanceToPoint(bot?.entity?.position, checkpoint.position) <= checkpointAcceptRange
        const useStraightCheckpoint = shouldWalkCheckpointStraight(checkpoint)
        const movementMode = useStraightCheckpoint ? 'straight' : 'pathfinder'
        console.log(`[NERV-WORKLOAD-CHECKPOINT] action=${currentAction || 'place'} goal=${checkpoint.position.x.toFixed(2)} ${checkpoint.position.y.toFixed(2)} ${checkpoint.position.z.toFixed(2)} range=${checkpointBuffer} from=${beforeMove.x.toFixed(2)} ${beforeMove.y.toFixed(2)} ${beforeMove.z.toFixed(2)} timeoutMs=${checkpointMoveTimeoutMs} mode=${movementMode}`)
        checkpointMoveInProgress = true
        try {
          if (useStraightCheckpoint) {
            await walkStraightToPointWithHardTimeout(
              bot,
              checkpoint.position,
              checkpointBuffer,
              checkpointMoveTimeoutMs,
              'nerv-workload-checkpoint',
              {
                config,
                sprint: shouldSprint,
                jump: false,
                tickMs: straightCheckpointTickMs,
                shouldPauseTimeout: () => !isWorkloadPlatformReady(),
                isGoalSatisfied: checkpointIsCloseEnough
              }
            )
          } else {
            await gotoGoalWithHardTimeout(
              bot,
              new GoalNear(checkpoint.position.x, checkpoint.position.y, checkpoint.position.z, checkpointBuffer),
              checkpointMoveTimeoutMs,
              'nerv-workload-checkpoint',
              {
                config,
                shouldPauseTimeout: () => !isWorkloadPlatformReady(),
                pollMs: Math.max(100, Math.min(1000, toNumber(advanced.platformWatchdogPollMs, toNumber(config.advanced?.platformWatchdogPollMs, 1000)))),
                isGoalSatisfied: checkpointIsCloseEnough
              }
            )
          }
          const afterMove = bot.entity.position
          if (!isWorkloadPlatformReady()) {
            checkpointMoveInProgress = false
            await waitForWorkloadPlatformReady('workload-checkpoint-after-move')
            continue
          }
          console.log(`[NERV-WORKLOAD-CHECKPOINT-OK] action=${currentAction || 'place'} pos=${afterMove.x.toFixed(2)} ${afterMove.y.toFixed(2)} ${afterMove.z.toFixed(2)} mode=${movementMode}`)
          break
        } catch (err) {
          if (isRuntimeStopError(err)) throw err
          if (latencySafeInterrupted) {
            console.log('[NERV-WORKLOAD-LATENCY-SAFE] checkpoint movement interrupted by high MC ping.')
            break
          }
          const afterMove = bot.entity.position
          if (String(err?.message || err || '').includes('nerv-workload-checkpoint-timeout') && checkpointIsCloseEnough()) {
            console.log(`[NERV-WORKLOAD-CHECKPOINT-OK] action=${currentAction || 'place'} pos=${afterMove.x.toFixed(2)} ${afterMove.y.toFixed(2)} ${afterMove.z.toFixed(2)} reason=timeout-near-goal distance=${distanceToPoint(afterMove, checkpoint.position).toFixed(2)} acceptRange=${checkpointAcceptRange.toFixed(2)}`)
            break
          }
          const runtime = getWorkloadRuntime('workload-checkpoint-error')
          if (isGoalChangedError(err) && !isWorkloadPlatformReady(runtime)) {
            checkpointMoveInProgress = false
            console.log(`[NERV-WORKLOAD-CHECKPOINT-HOLD] action=${currentAction || 'place'} goal=${checkpoint.position.x.toFixed(2)} ${checkpoint.position.y.toFixed(2)} ${checkpoint.position.z.toFixed(2)} pos=${afterMove.x.toFixed(2)} ${afterMove.y.toFixed(2)} ${afterMove.z.toFixed(2)} state=${runtime?.classification?.state || 'unknown'}; waiting for platform then retrying checkpoint.`)
            await waitForWorkloadPlatformReady('workload-checkpoint-goalchanged')
            continue
          }
          console.log(`[NERV-WORKLOAD-CHECKPOINT-WARN] action=${currentAction || 'place'} goal=${checkpoint.position.x.toFixed(2)} ${checkpoint.position.y.toFixed(2)} ${checkpoint.position.z.toFixed(2)} pos=${afterMove.x.toFixed(2)} ${afterMove.y.toFixed(2)} ${afterMove.z.toFixed(2)} -> ${err?.message || err}`)
          throw err
        } finally {
          checkpointMoveInProgress = false
        }
      }

      if (latencySafeInterrupted) break

      if (checkpoint.action === 'inline-repair' && !emergencyRestockBlock) {
        await drainActiveColumnTargets(Math.max(50, toNumber(advanced.inlineRepairDrainMs, Math.max(200, retryCooldownMs * 4))))
      }

      if (checkpoint.action === 'lineEnd' && !emergencyRestockBlock) {
        await drainActiveColumnTargets(lineEndSettleMs)
      }

      if (missRecoveryEnabled && !emergencyRestockBlock && prevCheckpointPos) {
        const Vec3Miss = bot.entity.position.constructor
        const missedInCols = batchTargets.filter((target) => {
          if (currentActiveCols instanceof Set && !currentActiveCols.has(target.col)) return false
          const key = getTargetKey(target)
          if (seen.has(key) || stallSkipped.has(key)) return false
          const actual = bot.blockAt(new Vec3Miss(target.position.x, target.position.y, target.position.z))
          return actual?.name !== target.blockName
        })

        if (missedInCols.length >= missRecoveryThreshold) {
          console.log(`[NERV-WORKLOAD-MISS-RECOVERY] detected ${missedInCols.length} missed blocks; sneaking back ${missRecoveryBacktrackBlocks} blocks to re-place.`)

          bot.setControlState('sprint', false)
          bot.setControlState('sneak', true)

          const botPos = bot.entity.position
          const dx = prevCheckpointPos.x - botPos.x
          const dz = prevCheckpointPos.z - botPos.z
          const dist = Math.sqrt(dx * dx + dz * dz) || 1
          const backX = botPos.x + (dx / dist) * missRecoveryBacktrackBlocks
          const backZ = botPos.z + (dz / dist) * missRecoveryBacktrackBlocks

          try {
            assertRuntimeContinue(bot, config, 'stopping-during-placement')
            await walkStraightToPointWithHardTimeout(
              bot,
              { x: backX, y: checkpoint.position.y, z: backZ },
              checkpointBuffer,
              checkpointMoveTimeoutMs,
              'nerv-workload-miss-backtrack',
              {
                config,
                sprint: false,
                jump: false,
                tickMs: straightCheckpointTickMs,
                shouldPauseTimeout: () => !isWorkloadPlatformReady()
              }
            )
            assertRuntimeContinue(bot, config, 'stopping-during-placement')
            await walkStraightToPointWithHardTimeout(
              bot,
              checkpoint.position,
              checkpointBuffer,
              checkpointMoveTimeoutMs,
              'nerv-workload-miss-return',
              {
                config,
                sprint: false,
                jump: false,
                tickMs: straightCheckpointTickMs,
                shouldPauseTimeout: () => !isWorkloadPlatformReady()
              }
            )
          } finally {
            bot.setControlState('sneak', false)
          }

          const stillMissed = missedInCols.filter((target) => {
            const key = getTargetKey(target)
            if (seen.has(key) || stallSkipped.has(key)) return false
            const actual = bot.blockAt(new Vec3Miss(target.position.x, target.position.y, target.position.z))
            return actual?.name !== target.blockName
          })

          if (stillMissed.length > 0) {
            console.log(`[NERV-WORKLOAD-MISS-RECOVERY] ${stillMissed.length} still unresolved after backtrack; running targeted repair.`)
            const repaired = await repairTargetsInBatches(bot, config, stillMissed, Math.max(1, toNumber(printer.placeRange, 4)), 'NERV-MISS-REPAIR')
            placed += repaired.placed
            already += repaired.already
            skipped += repaired.skipped
            for (const target of stillMissed) {
              const key = getTargetKey(target)
              const actual = bot.blockAt(new Vec3Miss(target.position.x, target.position.y, target.position.z))
              if (actual?.name === target.blockName) {
                markTargetPlacedInWorld(target, key)
              }
            }
          }
        }
      }

      prevCheckpointPos = { x: checkpoint.position.x, y: checkpoint.position.y, z: checkpoint.position.z }

      if (checkpoint.action === 'lineEnd' && !emergencyRestockBlock) {
        const rowErrors = getUnresolvedTargetsForActiveCols(currentActiveCols)
        if (rowErrors.length > 0) {
          const previousAction = currentAction
          currentAction = 'lineEnd-repair'
          try {
            console.log(`[NERV-WORKLOAD-LINEEND-REPAIR] unresolved=${rowErrors.length}; repairing before next traversal leg.`)
            const repaired = await repairTargetsInBatches(bot, config, rowErrors, Math.max(1, toNumber(printer.placeRange, 4)), 'NERV-WORKLOAD-LINEEND')
            placed += repaired.placed
            already += repaired.already
            skipped += repaired.skipped
            for (const target of rowErrors) {
              const key = getTargetKey(target)
              const actual = bot.blockAt(new bot.entity.position.constructor(target.position.x, target.position.y, target.position.z))
              if (actual?.name === target.blockName) {
                markTargetPlacedInWorld(target, key)
              } else {
                raiseRepairAlert(target, 'lineend-unresolved')
              }
            }
          } finally {
            currentAction = previousAction
            lastTickTime = Date.now()
          }
        }
      }
    }
  } finally {
    active = false
    await placementLoop
  }

  if (latencySafeInterrupted) {
    const remainingTargets = getUnresolvedTraversalTargets()
    if (remainingTargets.length) {
      const safe = await runLatencySafePlacementBatch(bot, config, remainingTargets, placeRange, 'NERV-WORKLOAD-LATENCY-SAFE')
      placed += safe.placed
      already += safe.already
      skipped += safe.skipped
      latencySafeSeen += toNumber(safe.seen, 0)
      hardStops += safe.hardStops || 0
      rawAllowedTotal += safe.rawAllowed || 0
      cappedTotal += safe.capped || 0
      maxAllowedSeen = Math.max(maxAllowedSeen, safe.maxAllowed || 0)
      if (safe.remainingTargets?.length) {
        const fast = await runNervTimeWorkloadPlacementBatch(bot, config, safe.remainingTargets, startOnNorthSide, allowEmergencyRestock)
        placed += fast.placed
        already += fast.already
        skipped += fast.skipped
        latencySafeSeen += toNumber(fast.seen, 0)
        hardStops += fast.hardStops
        rawAllowedTotal += fast.rawAllowed
        cappedTotal += fast.capped
        maxAllowedSeen = Math.max(maxAllowedSeen, fast.maxAllowed)
      }
    }
  }

  if (allowEmergencyRestock && emergencyRestockBlock) {
    console.log(`[NERV-WORKLOAD-EMERGENCY-RESTOCK] ${emergencyRestockBlock} ${emergencyRestockReason}; stopping movement, refilling, and retrying remaining targets once.`)
    const unresolvedBeforeRestock = getUnresolvedTraversalTargets()
    const traversalNeededByBlock = estimateNeededFromLookahead(unresolvedBeforeRestock.length ? unresolvedBeforeRestock : batchTargets)
    const restocked = await waitForRequiredMaterialRestock(bot, config, emergencyRestockBlock, 1, traversalNeededByBlock, emergencyRestockReason || 'workload-emergency-restock')
    const hasEmergencyMaterial = restocked || countInventoryItems(bot, emergencyRestockBlock) > 0
    if (hasEmergencyMaterial && unresolvedBeforeRestock.length > 0) {
      await ensureMaterialsForTargets(bot, config, unresolvedBeforeRestock, {
        force: true,
        windowed: true,
        materials: [...new Set(unresolvedBeforeRestock.map((target) => target.blockName).filter(Boolean))]
      })
    }
    if (hasEmergencyMaterial) {
      await returnToEmergencyRestockAnchor()
      const Vec3Retry = bot.entity.position.constructor
      const remainingTargets = batchTargets.filter((target) => {
        const actual = bot.blockAt(new Vec3Retry(target.position.x, target.position.y, target.position.z))
        return actual?.name !== target.blockName
      })
      if (remainingTargets.length) {
        const retry = await runNervTimeWorkloadPlacementBatch(bot, config, remainingTargets, startOnNorthSide, false)
        placed += retry.placed
        already += retry.already
        skipped += retry.skipped
        hardStops += retry.hardStops
        rawAllowedTotal += retry.rawAllowed
        cappedTotal += retry.capped
        maxAllowedSeen = Math.max(maxAllowedSeen, retry.maxAllowed)
      }
    }
  }

  const Vec3 = bot.entity.position.constructor

  let missing = 0
  for (const target of batchTargets) {
    const actual = bot.blockAt(new Vec3(target.position.x, target.position.y, target.position.z))
    if (actual?.name !== target.blockName) missing += 1
  }

  return {
    placed,
    already,
    skipped,
    seen: seen.size + latencySafeSeen,
    missing,
    hardStops,
    rawAllowed: rawAllowedTotal,
    capped: cappedTotal,
    maxAllowed: maxAllowedSeen
  }
}

function probeStartupSupport(bot, targets) {
  if (!targets.length) return { supportCount: 0, sampleSize: 0 }
  const Vec3 = bot.entity.position.constructor
  const probeSample = targets.slice(0, Math.min(64, targets.length))
  let supportCount = 0

  for (const target of probeSample) {
    const pos = new Vec3(target.position.x, target.position.y, target.position.z)
    const support = bot.blockAt(pos.offset(0, -1, 0))
    if (support && support.name !== 'air') supportCount += 1
  }

  return { supportCount, sampleSize: probeSample.length }
}

async function waitForStartupSupport(bot, config, targets) {
  if (config.advanced?.startupSupportProbeEnabled === false || !targets.length) {
    return probeStartupSupport(bot, targets)
  }

  const minRatio = Math.max(0, Math.min(1, toNumber(config.advanced?.startupSupportMinRatio, 0.5)))
  const pollMs = Math.max(500, toNumber(config.advanced?.startupSupportPollMs, 5000))
  const logMs = Math.max(1000, toNumber(config.advanced?.startupSupportLogMs, 15000))
  let lastLog = 0
  let alertSent = false

  while (bot?._client && bot._client.state !== 'disconnected') {
    await waitForPlatformReady(bot, config, 'startup-support')

    if (typeof bot.waitForChunksToLoad === 'function') {
      try {
        await Promise.race([
          bot.waitForChunksToLoad(),
          delay(Math.min(4000, pollMs))
        ])
      } catch {
        // Continue with a direct block probe below.
      }
    }

    const probe = probeStartupSupport(bot, targets)
    const ratio = probe.sampleSize > 0 ? probe.supportCount / probe.sampleSize : 1
    if (ratio >= minRatio) {
      clearDashboardAlert(config, 'platform-support')
      return probe
    }
    if (!alertSent) {
      const message = `Platform support not ready (${probe.supportCount}/${probe.sampleSize}); waiting for chunks or platform repair`
      setDashboardAlert(config, 'platform-support', message, {
        supportCount: probe.supportCount,
        sampleSize: probe.sampleSize,
        ratio,
        minRatio
      }, 'critical')
      reportDashboardWarning(config, 'platform-support', message, {
        supportCount: probe.supportCount,
        sampleSize: probe.sampleSize,
        ratio,
        minRatio
      })
      alertSent = true
    }

    const now = Date.now()
    if (now - lastLog >= logMs) {
      console.log(`[PROBE-HOLD] support=${probe.supportCount}/${probe.sampleSize}; waiting for platform chunks/support before inventory or placement.`)
      lastLog = now
    }
    await delay(pollMs)
  }

  return probeStartupSupport(bot, targets)
}

async function runPrint(bot, config, dashboardRuntime = null) {
  config.__dashboardRuntime = dashboardRuntime || null
  config.__supportStockWarningsCheckedForRun = false
  ensureUsableEntityState(bot, config, 'run-print-start', { allowPlatformSeed: true, log: false })
  const files = config.files || {}
  const printer = config.printer || {}
  const progressEnabled = files.resumeProgress !== false
  const progressFile = path.resolve(process.cwd(), files.progressFile || './logs/nerv-printer-progress.json')
  const progressSaveEvery = Math.max(1, toNumber(files.progressSaveEvery, 64))

  // Give the client a brief chance to load nearby chunks before probing support/calibration.
  if (typeof bot.waitForChunksToLoad === 'function') {
    try {
      await Promise.race([
        bot.waitForChunksToLoad(),
        delay(4000)
      ])
    } catch {
      // Continue even if chunk warmup fails.
    }
  } else {
    await delay(800)
  }

  const input = await loadTargets(config)
  let calibratedTargets = calibrateTargetsForWorld(bot, input.targets, config)
  const multiRuntime = config.multiUser?.runtime?.enabled === true ? config.multiUser.runtime : null
  const multiAssignment = multiRuntime?.assignment || null
  const multiRole = String(multiRuntime?.role || '').toLowerCase()
  if (multiAssignment?.interval) {
    const start = Math.max(0, toNumber(multiAssignment.interval.start, 0))
    const end = Math.min(127, toNumber(multiAssignment.interval.end, 127))
    calibratedTargets = calibratedTargets.filter((target) => target.col >= start && target.col <= end)
    console.log(`[MULTI-${multiRole.toUpperCase() || 'WORKER'}] ${multiAssignment.name} interval=${start}-${end} selectedTargets=${calibratedTargets.length}/${input.targets.length}`)
    if (multiRole !== 'master') {
      writeMultiSlaveState(config, multiAssignment, { ready: true, finished: false, errorCount: 0, phase: 'ready' })
      await waitForMultiMasterRunning(config)
    } else {
      await waitForMultiSlavesReady(config, multiRuntime.plan || buildMultiUserPlan(config))
      writeMultiMasterState(config, multiRuntime.plan || buildMultiUserPlan(config), true, {
        jobId: multiRuntime.jobId,
        generation: multiRuntime.generation
      })
      console.log('[MULTI-MASTER] All workers released: master_state running=true.')
    }
  }
  const linesPerRun = toNumber(printer.linesPerRun, 3)
  const printChunkLines = getInventoryManagedLinesPerRun(config, linesPerRun)
  const northToSouth = printer.northToSouth !== false
  const placeWhileSprinting = printer.placeWhileSprinting === true
  const orderedTargets = orderTargetsLineByLine(calibratedTargets, linesPerRun, northToSouth)
  config.__platformWaterGuardTargets = orderedTargets
  const checkPlatformWater = async (reason) => {
    await waitForPlatformWaterClear(bot, config, orderedTargets, reason)
  }
  let resumeFrom = 0
  let resumePhase = 'printing'  // tracks which bot phase to resume after crash
  let resumePostPrintStep = 'withdraw'
  let resumePostPrintCartographyComplete = false
  let shouldRunResetPreflight = false
  let runtimeStopPhase = 'printing'
  let runtimeStopAction = 'dashboard-stop'
  let runtimeStopMeta = {}
  const setRuntimeStopCheckpoint = (phase = 'printing', action = 'dashboard-stop', meta = {}) => {
    runtimeStopPhase = phase
    runtimeStopAction = action
    runtimeStopMeta = meta && typeof meta === 'object' ? meta : {}
  }
  const checkRuntimeStop = (detail = 'pausing-after-current-step') => {
    assertRuntimeContinue(bot, config, detail)
  }

  if (progressEnabled) {
    const previous = readProgressState(progressFile)
    const sameInput =
      previous &&
      previous.sourceType === input.sourceType &&
      previous.sourceName === input.sourceName &&
      previous.totalTargets === orderedTargets.length

    if (sameInput) {
      resumeFrom = Math.max(0, Math.min(orderedTargets.length, toNumber(previous.processedTargets, 0)))
      const previousPhase = normalizeResumePhase(previous.phase)
      if (previous.resetBeforeResume === true) {
        shouldRunResetPreflight = true
        resumeFrom = 0
        resumePhase = 'printing'
        resumePostPrintStep = 'withdraw'
        resumePostPrintCartographyComplete = false
        console.log(`[RESET-RESUME] Reset requested for ${input.sourceName}; restarting from target 0 after platform reset preflight.`)
      }
      // If the bot crashed inside repair or post_print, skip the main sweep and jump directly there.
      if (!shouldRunResetPreflight && (previousPhase === 'repair' || previousPhase === 'post_print')) {
        resumePhase = previousPhase
        resumeFrom = orderedTargets.length
      }
      if (!shouldRunResetPreflight && previousPhase === 'post_print') {
        resumePostPrintStep = String(previous.postPrintStep || 'withdraw')
        resumePostPrintCartographyComplete = previous.postPrintCartographyComplete === true ||
          String(previous.action || '') === 'cartography-complete'
      }
      console.log(`[RESUME] Saved state phase=${previous.phase || 'printing'} state=${previous.state || 'n/a'} action=${previous.action || 'n/a'} processed=${resumeFrom}/${orderedTargets.length}.`)
    }
  }

  const pending = orderedTargets.slice(resumeFrom)
  if (shouldRunResetPreflight) {
    dashboardRuntime?.setPhase('cleanup', 'reset-current-nbt')
    if (progressEnabled) {
      writeProgressSnapshot(progressFile, input, orderedTargets.length, 0, 'printing', {
        state: 'reset_preflight',
        action: 'reset-platform-before-restart',
        resetBeforeResume: true
      })
    }
    await runPlatformResetPreflight(bot, config, 'reset-current-nbt')
    if (progressEnabled) {
      writeProgressSnapshot(progressFile, input, orderedTargets.length, 0, 'printing', {
        state: 'printing_start',
        action: 'reset-preflight-complete'
      })
    }
    dashboardRuntime?.setPhase('printing')
  }
  await checkPlatformWater('startup-water-check')
  const makePostPrintContext = (extra = {}) => ({
    sourceName: input.sourceName,
    sourcePath: input.sourcePath,
    sourceType: input.sourceType,
    resumePostPrintStep,
    postPrintCartographyComplete: resumePostPrintCartographyComplete,
    setStatusDetail: (detail) => {
      dashboardRuntime?.setPhase('post-print', detail)
    },
    savePostPrintState: (postPrintStep, action = 'post-print-active', meta = {}) => {
      const detail = String(action || '').startsWith('blocked-')
        ? mapPostPrintStatusDetail(action)
        : mapPostPrintStatusDetail(postPrintStep)
      dashboardRuntime?.setPhase('post-print', detail)
      if (!progressEnabled) return
      writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'post_print', {
        state: 'post_print_workflow',
        action,
        postPrintStep,
        ...meta
      })
    },
    ...extra
  })

  console.log(`[PLAN] Loaded ${input.sourceName} (${input.sourceType}) with ${orderedTargets.length} targets.`)
  if (resumeFrom > 0 && resumeFrom < orderedTargets.length) {
    console.log(`[RESUME] Continuing from target ${resumeFrom}/${orderedTargets.length}.`)
  }

  // Quick support probe to catch bad Y alignment before committing full sweep.
  if (pending.length) {
    const probe = await waitForStartupSupport(bot, config, pending)
    console.log(`[PROBE] support=${probe.supportCount}/${probe.sampleSize} at startup.`)
    checkRuntimeStop()
  }

  const placeRange = Math.max(1, toNumber(printer.placeRange, 4))
  const cliPostPrintTestOnly = hasCliFlag('--test-post-print') || hasCliFlag('--post-print-test-only')
  const cliPostPrintFullTest = hasCliFlag('--test-post-print-full') || hasCliFlag('--post-print-test-full')
  const postPrintTestOnly = printer.postPrintTestOnly === true || cliPostPrintTestOnly || cliPostPrintFullTest
  const scannerWorkloadMode = String(config.advanced?.scannerWorkloadMode || 'litematic').toLowerCase()
  const isLitematicBandMode = scannerWorkloadMode === 'litematic' || scannerWorkloadMode === 'reactive'

  await checkSupportStockWarningsOnce(bot, config, postPrintTestOnly ? 'post-print-test' : 'map-run')

  if (postPrintTestOnly) {
    console.log('[TEST] postPrintTestOnly=true, skipping carpet placement and running post-print workflow only.')
    if (cliPostPrintTestOnly) {
      config.advanced = {
        ...(config.advanced || {}),
        postPrintResetEnabled: false,
        postPrintWalkToCenter: false
      }
      console.log('[TEST] --test-post-print disables reset and final center walk for isolated post-print testing.')
    } else if (cliPostPrintFullTest) {
      config.advanced = {
        ...(config.advanced || {}),
        postPrintResetEnabled: true,
        postPrintSkipResetInteraction: false,
        postPrintWalkToCenter: true,
        resetChestWaitMs: 2000,
        resetChestCloseSettleMs: 0
      }
      console.log('[TEST] --test-post-print-full keeps reset and final center walk enabled; reset chest stays open for 2000ms.')
    }
    resumePostPrintStep = 'withdraw'
    if (progressEnabled) {
      writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'post_print', {
        state: 'post_print_workflow',
        action: 'post-print-test-only',
        postPrintStep: resumePostPrintStep,
        postPrintCartographyComplete: false
      })
    }

    setRuntimeStopCheckpoint('post_print', 'dashboard-stop-before-post-print-test', {
      postPrintStep: resumePostPrintStep,
      postPrintCartographyComplete: false
    })
    checkRuntimeStop()
    const postPrintOnlyResult = await runPostPrintWorkflowWithRecovery(bot, config, makePostPrintContext, resumePostPrintStep, { label: 'test-only' })
    if (!postPrintOnlyResult?.completed) {
      console.log(`[POSTPRINT-WARN] Post-print test-only workflow stopped at step=${postPrintOnlyResult?.failedStep || 'unknown'}.`)
      return {
        sourceType: input.sourceType,
        sourcePath: input.sourcePath,
        sourceName: input.sourceName,
        didWork: true,
        postPrintPending: true,
        postPrintFailedStep: postPrintOnlyResult?.failedStep || 'unknown'
      }
    }
    await delay(toNumber(config.advanced?.postBuildDelayMs, 0))
    return {
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      sourceName: input.sourceName,
      didWork: true
    }
  }

  if (!pending.length) {
    console.log('[PLAN] No build targets found.')
    console.log('[VERIFY] Progress indicates completed build. Running verification/repair and post-print workflow.')

    const Vec3Verify = bot.entity.position.constructor
    let placed = 0
    let skipped = 0
    let already = 0
    const errorList = []

    await checkPlatformWater('before-completed-build-verification')
    for (const target of orderedTargets) {
      setRuntimeStopCheckpoint('printing', 'dashboard-stop-during-verification')
      checkRuntimeStop()
      const actual = bot.blockAt(new Vec3Verify(target.position.x, target.position.y, target.position.z))
      if (actual?.name !== target.blockName) {
        errorList.push(target)
        if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
          const reason = (!actual || actual.name === 'air') ? 'missing' : `wrong-${actual.name}`
          console.log(`[LINEEND-ERROR] ${target.position.x} ${target.position.y} ${target.position.z} (${reason})`)
        }
      } else {
        already += 1
      }
    }

  console.log(`[DONE-SWEEP] placed=${placed} already=${already} skipped=${skipped} incrementalErrors=${errorList.length}`)

  // Final comprehensive scan: verify ALL targets against world state before finishing
  if (resumePhase !== 'post_print') {
    console.log('[FINAL-SCAN] Scanning entire map for final verification...')
    if (progressEnabled) {
      writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'printing', {
        state: 'final_scan',
        action: 'scan-before-repair'
      })
    }
    const Vec3_Final = bot.entity.position.constructor
    const fullMapErrors = []
    await checkPlatformWater('before-final-scan')
    for (const target of orderedTargets) {
      setRuntimeStopCheckpoint('printing', 'dashboard-stop-during-final-scan')
      checkRuntimeStop()
      const actual = bot.blockAt(new Vec3_Final(target.position.x, target.position.y, target.position.z))
      if (!actual || actual.name !== target.blockName) fullMapErrors.push(target)
    }
    errorList.length = 0
    errorList.push(...fullMapErrors)
    if (errorList.length > 0) console.log(`[FINAL-SCAN] Found ${errorList.length} mismatch(es).`)

    // Persist phase=repair before repair pass for crash recovery
    if (progressEnabled) {
      writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'repair', {
        state: 'repair_start',
        action: 'repair-final-scan-errors',
        errorCount: errorList.length
      })
    }

    // Repair pass: fix any missed or broken blocks
    const errorAction = String(config.errorHandling?.errorAction || 'repair').toLowerCase()
    if (errorList.length && errorAction === 'repair') {
      logRepairMismatchWarningForTargets(bot, config, errorList, orderedTargets.length, 'REPAIR')
      const maxRepairPasses = Math.max(1, toNumber(config.advanced?.repairTestMaxPasses, 3))
      for (let pass = 1; pass <= maxRepairPasses && errorList.length > 0; pass += 1) {
        setRuntimeStopCheckpoint('repair', 'dashboard-stop-during-repair', { pass, maxPasses: maxRepairPasses, errorCount: errorList.length })
        checkRuntimeStop()
        await checkPlatformWater('before-repair-pass')
        console.log(`[REPAIR-PASS] Starting repair pass ${pass}/${maxRepairPasses} for ${errorList.length} error(s).`)
        if (progressEnabled) {
          writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'repair', {
            state: 'repair_pass',
            action: 'repair-targets',
            pass,
            maxPasses: maxRepairPasses,
            errorCount: errorList.length
          })
        }
        const repairResult = await repairTargetsInBatches(bot, config, errorList, placeRange, `REPAIR-PASS-${pass}`)
        placed += repairResult.placed
        already += repairResult.already
        skipped += repairResult.skipped
        await delay(toNumber(config.advanced?.repairVerifySettleMs, 300))

        const remainingErrors = scanPlacementErrors(bot, orderedTargets, {
          config,
          logPrefix: `REPAIR-VERIFY-PASS-${pass}`,
          logErrors: config.errorHandling?.logErrors !== false,
          maxLogs: toNumber(config.advanced?.repairTestMaxErrorLogs, 80)
        }).map((entry) => entry.target)
        errorList.length = 0
        errorList.push(...remainingErrors)
        console.log(`[REPAIR-PASS] pass=${pass} fullScanRemaining=${errorList.length}.`)
        if (progressEnabled) {
          writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'repair', {
            state: 'repair_verify',
            action: 'full-scan-after-repair',
            pass,
            maxPasses: maxRepairPasses,
            errorCount: errorList.length
          })
        }
        if (pass < maxRepairPasses) {
          logRepairMismatchWarningForTargets(bot, config, errorList, orderedTargets.length, `REPAIR-VERIFY-PASS-${pass}`)
        }
      }
    }
  } else {
    console.log('[RESUME] Skipping final scan and repair (crashed during post_print). Going to post-print workflow.')
  }

  console.log(`[SWEEP-FINAL] placed=${placed} already=${already} skipped=${skipped} ErrorCount=${errorList.length}`)

  if (multiRuntime && multiRole !== 'master') {
    writeMultiSlaveState(config, multiAssignment, {
      ready: false,
      finished: true,
      errorCount: errorList.length,
      phase: 'finished'
    })
    console.log(`[MULTI-SLAVE] ${multiAssignment?.name || bot.username} finished interval ${multiAssignment?.interval?.start}-${multiAssignment?.interval?.end}; skipping post-print workflow.`)
    if (progressEnabled) {
      clearProgressState(progressFile)
    }
    return {
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      sourceName: input.sourceName,
      didWork: true
    }
  }

  if (multiRuntime && multiRole === 'master') {
    await waitForMultiSlavesFinished(config, multiRuntime.plan || buildMultiUserPlan(config))
  }

    // Persist phase=post_print so crash here resumes post-print, not repair again
  if (progressEnabled) {
    writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'post_print', {
      state: 'post_print_workflow',
      action: 'run-post-print',
      postPrintStep: resumePostPrintStep,
      postPrintCartographyComplete: resumePostPrintCartographyComplete
    })
  }

  setRuntimeStopCheckpoint('post_print', 'dashboard-stop-before-post-print', {
    postPrintStep: resumePostPrintStep,
    postPrintCartographyComplete: resumePostPrintCartographyComplete
  })
  checkRuntimeStop()
  const postPrintResult = await runPostPrintWorkflowWithRecovery(bot, config, makePostPrintContext, resumePostPrintStep, { label: 'main-run' })
  if (!postPrintResult?.completed) {
    console.log(`[POSTPRINT-WARN] Post-print workflow stopped at step=${postPrintResult?.failedStep || 'unknown'}. Job will remain pending until post-print completes.`)
    return {
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      sourceName: input.sourceName,
      didWork: true,
      postPrintPending: true,
      postPrintFailedStep: postPrintResult?.failedStep || 'unknown'
    }
  }
    await delay(toNumber(config.advanced?.postBuildDelayMs, 0))

    if (files.moveToFinishedFolder) {
      const fromPath = input.sourcePath
      if (fs.existsSync(fromPath)) {
        const finishedDir = path.resolve(process.cwd(), files.finishedFolder || './finished-maps')
        if (!fs.existsSync(finishedDir)) {
          fs.mkdirSync(finishedDir, { recursive: true })
        }

        const toPath = resolveUniqueFilePath(path.join(finishedDir, path.basename(fromPath)))
        fs.renameSync(fromPath, toPath)
        console.log(`[FILES] Moved ${path.basename(fromPath)} to ${toPath}`)
      }
    }

    if (files.disableOnFinished !== false) {
      console.log('[STATE] Job finished.')
    }

    if (progressEnabled) {
      clearProgressState(progressFile)
    }

    return {
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      sourceName: input.sourceName,
      didWork: true
    }
  }

  const byColRow = new Map()
  const cols = new Set()
  const rows = new Set()

  for (const target of pending) {
    cols.add(target.col)
    rows.add(target.row)
    byColRow.set(`${target.col}:${target.row}`, target)
  }

  const sortedCols = [...cols].sort((a, b) => a - b)
  const sortedRowsAsc = [...rows].sort((a, b) => a - b)

  // Nerv has a fixed logical start side, but in standalone Mineflayer runs it is safer
  // to start from the player-nearest corner to avoid long wrong-corner pathing.
  let colTraversal = sortedCols
  let startOnNorthSide = northToSouth
  const startCornerMode = String(printer.startCornerMode || 'mapCorner').toLowerCase()

  if (startCornerMode === 'nearest' && sortedCols.length && sortedRowsAsc.length) {
    const px = bot.entity.position.x
    const pz = bot.entity.position.z

    const minCol = sortedCols[0]
    const maxCol = sortedCols[sortedCols.length - 1]
    const minRow = sortedRowsAsc[0]
    const maxRow = sortedRowsAsc[sortedRowsAsc.length - 1]

    const minColTarget = byColRow.get(`${minCol}:${minRow}`) || byColRow.get(`${minCol}:${maxRow}`)
    const maxColTarget = byColRow.get(`${maxCol}:${minRow}`) || byColRow.get(`${maxCol}:${maxRow}`)
    const minRowTarget = byColRow.get(`${minCol}:${minRow}`) || byColRow.get(`${maxCol}:${minRow}`)
    const maxRowTarget = byColRow.get(`${minCol}:${maxRow}`) || byColRow.get(`${maxCol}:${maxRow}`)

    if (minColTarget && maxColTarget && minRowTarget && maxRowTarget) {
      const minColX = minColTarget.position.x + 0.5
      const maxColX = maxColTarget.position.x + 0.5
      const minRowZ = minRowTarget.position.z + 0.5
      const maxRowZ = maxRowTarget.position.z + 0.5

      const startFromMinCol = Math.abs(px - minColX) <= Math.abs(px - maxColX)
      const startFromMinRow = Math.abs(pz - minRowZ) <= Math.abs(pz - maxRowZ)

      if (!startFromMinCol) {
        colTraversal = [...sortedCols].reverse()
      }

      // true => ascending row order first, false => descending row order first
      startOnNorthSide = startFromMinRow
      console.log(`[START] cornerMode=nearest colStart=${startFromMinCol ? 'min' : 'max'} rowStart=${startFromMinRow ? 'min' : 'max'}`)
    }
  }

  let placed = 0
  let skipped = 0
  let already = 0
  let processedInRun = 0
  const errorList = []

  const saveProgress = (phase = 'printing', details = {}) => {
    if (!progressEnabled) return
    const processedTargets = Math.min(orderedTargets.length, resumeFrom + processedInRun)
    writeProgressSnapshot(progressFile, input, orderedTargets.length, processedTargets, phase, details)
    if (multiRuntime && multiAssignment) {
      const heartbeatDetails = {
        ready: multiRole !== 'master',
        finished: false,
        errorCount: errorList.length,
        phase,
        state: details.state || null,
        action: details.action || null,
        processedTargets,
        totalTargets: orderedTargets.length,
        sourceName: input.sourceName
      }
      if (multiRole === 'master') {
        writeMultiMasterState(config, multiRuntime.plan || buildMultiUserPlan(config), true, heartbeatDetails)
      } else {
        writeMultiSlaveState(config, multiAssignment, heartbeatDetails)
      }
    }
  }
  config.__runtimeStopHandler = (detail = 'pausing-after-current-step') => {
    saveProgress(runtimeStopPhase, {
      state: 'dashboard_stop_requested',
      action: runtimeStopAction,
      detail,
      ...runtimeStopMeta
    })
  }

  if (progressEnabled) {
    saveProgress('printing', { state: 'printing_start', action: 'resume-ready' })
  }
  checkRuntimeStop()

  // Pre-print cleanup: dump any leftover filled maps from previous runs before starting
  {
    const machine = config.machine || {}
    const finishedChestPos = machine.finishedMapChest?.enabled ? machine.finishedMapChest.position : null
    if (finishedChestPos) {
      const leftoverMaps = findInventoryItemsByType(bot, 'filled_map')
      for (const stack of leftoverMaps) {
        setRuntimeStopCheckpoint('printing', 'dashboard-stop-during-preprint-cleanup')
        checkRuntimeStop()
        if (stack && stack.count > 0) {
          console.log(`[PREPRINT] Dumping ${stack.count} leftover filled_map(s) from previous run before starting print.`)
          await depositToChest(bot, config, finishedChestPos, 'filled_map', stack.count, machine.finishedMapChest?.accessPosition)
        }
      }
    }
  }

  for (let i = 0; i < colTraversal.length; i += printChunkLines) {
    setRuntimeStopCheckpoint('printing', 'dashboard-stop-before-inventory-window', { colIndex: i })
    checkRuntimeStop()
    await checkPlatformWater('before-inventory-window')
    const inventoryCols = colTraversal.slice(i, i + printChunkLines)
    const inventoryRowOrder = startOnNorthSide ? sortedRowsAsc : [...sortedRowsAsc].reverse()
    const inventoryTargets = []
    for (const row of inventoryRowOrder) {
      for (const col of inventoryCols) {
        const target = byColRow.get(`${col}:${row}`)
        if (target) inventoryTargets.push(target)
      }
    }
    const inventoryWindow = selectInventoryPlanningTargetsFromPrintBatch(byColRow, inventoryCols, inventoryRowOrder, config)

    const lookaheadStart = Math.min(orderedTargets.length, resumeFrom + processedInRun)
    console.log(`[NERV-INVENTORY-WINDOW] cols=${inventoryWindow.cols.join(',') || 'none'} targets=${inventoryWindow.targets.length}/${inventoryTargets.length} materials=${inventoryWindow.materials.length}/16 inventoryCols=${inventoryCols.join(',')} inventoryRows=${Math.max(1, toNumber(config.advanced?.inventoryRefillRows, 2))} rowWidth=${Math.max(1, toNumber(linesPerRun, 1))}`)
    saveProgress('printing', {
      state: 'inventory_restock',
      action: 'ensure-materials',
      lookaheadStart,
      inventoryTargets: inventoryWindow.targets.length,
      inventoryCols: inventoryWindow.cols.join(','),
      colBatch: inventoryCols.join(',')
    })
    const materialsReady = await ensureMaterialsForTargets(bot, config, inventoryWindow.targets, {
      windowed: true,
      cols: inventoryWindow.cols,
      materials: inventoryWindow.materials,
      dumpWithoutRestock: true,
      dumpAllUnneededBeforeRestock: true
    })
    if (!materialsReady) {
      console.log('[NERV-INVENTORY-WARN] Could not fully clean/refill inventory for this window; continuing with current inventory. Emergency restocks will handle any shortfalls.')
    }
    checkRuntimeStop()

    let batchStartOnNorthSide = startOnNorthSide
    for (let j = 0; j < inventoryCols.length; j += Math.max(1, toNumber(linesPerRun, 1))) {
      setRuntimeStopCheckpoint('printing', 'dashboard-stop-before-placement-batch', { colBatch: inventoryCols.slice(j, j + Math.max(1, toNumber(linesPerRun, 1))).join(',') })
      checkRuntimeStop()
      await checkPlatformWater('before-placement-batch')
      const colBatch = inventoryCols.slice(j, j + Math.max(1, toNumber(linesPerRun, 1)))
      const rowOrder = batchStartOnNorthSide ? sortedRowsAsc : [...sortedRowsAsc].reverse()
      const batchTargets = []
      for (const row of rowOrder) {
        for (const col of colBatch) {
          const target = byColRow.get(`${col}:${row}`)
          if (target) batchTargets.push(target)
        }
      }

      saveProgress('printing', {
        state: 'printing_batch',
        action: 'place-batch',
        colBatch: colBatch.join(','),
        inventoryCols: inventoryCols.join(','),
        batchIndex: Math.floor((i + j) / Math.max(1, toNumber(linesPerRun, 1))) + 1
      })

      const useLitematicRowMode = isLitematicBandMode

      if (useLitematicRowMode) {
        await ensureFoodBeforeTraversal(bot, config, `litematic-batch cols=${colBatch.join(',')}`)
        const result = await runNervTimeWorkloadPlacementBatch(bot, config, batchTargets, batchStartOnNorthSide)
        placed += result.placed
        already += result.already
        skipped += result.skipped
        processedInRun += batchTargets.length
        checkRuntimeStop()
        if (placementNoiseLogsEnabled(config)) {
          console.log(`[LITEMATIC-WORKLOAD-BATCH] placed=${result.placed} already=${result.already} skipped=${result.skipped} seen=${result.seen}/${batchTargets.length} missing=${result.missing} hardStops=${result.hardStops} rawAllowed=${result.rawAllowed} capped=${result.capped} maxAllowed=${result.maxAllowed}`)
        }

        // Collect errors from this batch for deferred end-of-print repair.
        // Only scans loaded chunks; unloaded blocks are caught by the final sweep.
        {
          const Vec3Batch = bot.entity.position.constructor
          const batchErrorKeys = new Set(errorList.map(e => `${e.position.x}:${e.position.y}:${e.position.z}`))
          for (const target of batchTargets) {
            const key = `${target.position.x}:${target.position.y}:${target.position.z}`
            if (batchErrorKeys.has(key)) continue
            const actual = bot.blockAt(new Vec3Batch(target.position.x, target.position.y, target.position.z))
            if (!actual) continue
            if (actual.name !== target.blockName) {
              errorList.push(target)
              if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
                const reason = actual.name === 'air' ? 'missing' : `wrong-${actual.name}`
                console.log(`[BATCH-ERROR] ${target.position.x} ${target.position.y} ${target.position.z} (${reason})`)
              }
            }
          }
        }

        if (progressEnabled) {
          saveProgress('printing', {
            state: 'printing_batch',
            action: 'batch-complete',
            colBatch: colBatch.join(','),
            placed,
            already,
            skipped
          })
        }
        batchStartOnNorthSide = !batchStartOnNorthSide
      } else if (printer.fastTraversalEnabled === true) {
        await ensureFoodBeforeTraversal(bot, config, `fast-batch cols=${colBatch.join(',')}`)
        const result = scannerWorkloadMode === 'time'
          ? await runNervTimeWorkloadPlacementBatch(bot, config, batchTargets, batchStartOnNorthSide)
          : await runNervScannerPlacementBatch(bot, config, batchTargets, batchStartOnNorthSide)
        placed += result.placed
        already += result.already
        skipped += result.skipped
        processedInRun += batchTargets.length
        checkRuntimeStop()
        if (placementNoiseLogsEnabled(config) && scannerWorkloadMode === 'time') {
          console.log(`[NERV-WORKLOAD-BATCH] placed=${result.placed} already=${result.already} skipped=${result.skipped} seen=${result.seen}/${batchTargets.length} missing=${result.missing} hardStops=${result.hardStops} rawAllowed=${result.rawAllowed} capped=${result.capped} maxAllowed=${result.maxAllowed}`)
        } else if (placementNoiseLogsEnabled(config)) {
          console.log(`[NERV-SCANNER-BATCH] placed=${result.placed} already=${result.already} skipped=${result.skipped} seen=${result.seen}/${batchTargets.length} missing=${result.missing}`)
        }
        if (progressEnabled) {
          saveProgress('printing', {
            state: 'printing_batch',
            action: 'batch-complete',
            colBatch: colBatch.join(','),
            placed,
            already,
            skipped
          })
        }
        batchStartOnNorthSide = !batchStartOnNorthSide
      } else {
        const firstTarget = rowOrder
          .map((row) => colBatch.map((col) => byColRow.get(`${col}:${row}`)).find(Boolean))
          .find(Boolean)

        if (firstTarget) {
          setRuntimeStopCheckpoint('printing', 'dashboard-stop-before-manual-batch', { colBatch: colBatch.join(',') })
          checkRuntimeStop()
          await ensureFoodBeforeTraversal(bot, config, `manual-batch cols=${colBatch.join(',')}`)
          const startGoal = new GoalNear(firstTarget.position.x, firstTarget.position.y, firstTarget.position.z, Math.max(1, placeRange - 1))
          try {
            await bot.pathfinder.goto(startGoal)
          } catch (err) {
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[MOVE-ERROR] ${firstTarget.position.x} ${firstTarget.position.y} ${firstTarget.position.z} -> ${err?.message || err}`)
            }
          }
        }

        for (let rowIndex = 0; rowIndex < rowOrder.length; rowIndex++) {
          setRuntimeStopCheckpoint('printing', 'dashboard-stop-before-manual-row', { colBatch: colBatch.join(','), rowIndex })
          checkRuntimeStop()
          const row = rowOrder[rowIndex]
          const rowTargets = colBatch
            .map((col) => byColRow.get(`${col}:${row}`))
            .filter(Boolean)

          if (!rowTargets.length) continue

          const rowAnchor = rowTargets[0]
          const rowGoal = new GoalNear(rowAnchor.position.x, rowAnchor.position.y, rowAnchor.position.z, Math.max(1, placeRange - 1))

          let shouldGotoRow = true
          if (placeWhileSprinting) {
            const dx = bot.entity.position.x - (rowAnchor.position.x + 0.5)
            const dz = bot.entity.position.z - (rowAnchor.position.z + 0.5)
            const distance2 = dx * dx + dz * dz
            shouldGotoRow = distance2 > Math.pow(Math.max(1, placeRange - 0.5), 2)
          }

          if (shouldGotoRow) {
            try {
              await bot.pathfinder.goto(rowGoal)
            } catch (err) {
              skipped += rowTargets.length
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[MOVE-ERROR] ${rowAnchor.position.x} ${rowAnchor.position.y} ${rowAnchor.position.z} -> ${err?.message || err}`)
              }
              continue
            }
          }

          for (const target of rowTargets) {
            setRuntimeStopCheckpoint('printing', 'dashboard-stop-before-manual-target', { colBatch: colBatch.join(','), rowIndex })
            checkRuntimeStop()
            try {
              const result = await placeTarget(bot, config, target)
              if (result.state === 'placed') {
                placed += 1
                if (config.advanced?.debugPrints) {
                  console.log(`[PLACE] ${target.blockName} at ${target.position.x} ${target.position.y} ${target.position.z}`)
                }
              } else if (result.state === 'already') {
                already += 1
              } else {
                skipped += 1
                if (config.errorHandling?.logErrors !== false && placementNoiseLogsEnabled(config)) {
                  console.log(`[SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
                }
              }
            } catch (err) {
              skipped += 1
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[PLACE-ERROR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
              }
            }

            processedInRun += 1
            if (progressEnabled && (processedInRun % progressSaveEvery === 0 || resumeFrom + processedInRun >= orderedTargets.length)) {
              saveProgress('printing', {
                state: 'printing_batch',
                action: 'target-progress',
                placed,
                already,
                skipped
              })
            }
          }

          batchStartOnNorthSide = !batchStartOnNorthSide
        }
      }

      if (!isLitematicBandMode) {
        saveProgress('printing', {
          state: 'printing_lineend_check',
          action: 'verify-completed-batch',
          colBatch: colBatch.join(',')
        })
        const Vec3_LineEnd = bot.entity.position.constructor
        const errorListKeys = new Set(errorList.map(e => `${e.position.x}:${e.position.y}:${e.position.z}`))
        for (const col of colBatch) {
          for (const row of rowOrder) {
            setRuntimeStopCheckpoint('printing', 'dashboard-stop-during-lineend-check', { colBatch: colBatch.join(',') })
            checkRuntimeStop()
            const target = byColRow.get(`${col}:${row}`)
            if (!target) continue
            const key = `${target.position.x}:${target.position.y}:${target.position.z}`
            if (errorListKeys.has(key)) continue
            const actual = bot.blockAt(new Vec3_LineEnd(target.position.x, target.position.y, target.position.z))
            if (actual?.name !== target.blockName) {
              errorList.push(target)
              if (config.errorHandling?.logErrors !== false) {
                const reason = (!actual || actual.name === 'air') ? 'missing' : `wrong-${actual.name}`
                console.log(`[LINEEND-ERROR] ${target.position.x} ${target.position.y} ${target.position.z} (${reason})`)
              }
            }
          }
        }
      }

      startOnNorthSide = !startOnNorthSide
    }
  }

  if (isLitematicBandMode) {
    const existingErrorKeys = new Set(errorList.map(e => `${e.position.x}:${e.position.y}:${e.position.z}`))
    setRuntimeStopCheckpoint('printing', 'dashboard-stop-before-litematic-sweep')
    checkRuntimeStop()
    const sweepErrors = scanPlacementErrors(bot, orderedTargets, {
      config,
      logPrefix: 'LITEMATIC-SWEEP',
      logErrors: config.errorHandling?.logErrors !== false,
      maxLogs: toNumber(config.advanced?.repairTestMaxErrorLogs, 80)
    }).map((entry) => entry.target).filter(t => !existingErrorKeys.has(`${t.position.x}:${t.position.y}:${t.position.z}`))
    errorList.push(...sweepErrors)
  }

  console.log(`[DONE-SWEEP] placed=${placed} already=${already} skipped=${skipped} errors=${errorList.length}`)

  // Repair pass: fix collected errors if enabled
  const errorAction = String(config.errorHandling?.errorAction || 'repair').toLowerCase()
  if (errorList.length && errorAction === 'repair') {
    logRepairMismatchWarningForTargets(bot, config, errorList, orderedTargets.length, 'REPAIR')
    if (progressEnabled) {
      writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'repair', {
        state: 'repair_start',
        action: 'repair-lineend-errors',
        errorCount: errorList.length
      })
    }

    const maxRepairPasses = Math.max(1, toNumber(config.advanced?.repairTestMaxPasses, 3))
    for (let pass = 1; pass <= maxRepairPasses && errorList.length > 0; pass += 1) {
      setRuntimeStopCheckpoint('repair', 'dashboard-stop-during-repair', { pass, maxPasses: maxRepairPasses, errorCount: errorList.length })
      checkRuntimeStop()
      await checkPlatformWater('before-repair-pass')
      console.log(`[REPAIR-PASS] Starting repair pass ${pass}/${maxRepairPasses} for ${errorList.length} error(s).`)
      if (progressEnabled) {
        writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'repair', {
          state: 'repair_pass',
          action: 'repair-targets',
          pass,
          maxPasses: maxRepairPasses,
          errorCount: errorList.length
        })
      }
      const repairResult = await repairTargetsInBatches(bot, config, errorList, placeRange, `REPAIR-PASS-${pass}`)
      placed += repairResult.placed
      already += repairResult.already
      skipped += repairResult.skipped
      await delay(toNumber(config.advanced?.repairVerifySettleMs, 300))

      const remainingErrors = scanPlacementErrors(bot, orderedTargets, {
        config,
        logPrefix: `REPAIR-VERIFY-PASS-${pass}`,
        logErrors: config.errorHandling?.logErrors !== false,
        maxLogs: toNumber(config.advanced?.repairTestMaxErrorLogs, 80)
      }).map((entry) => entry.target)
      errorList.length = 0
      errorList.push(...remainingErrors)
      console.log(`[REPAIR-PASS] pass=${pass} fullScanRemaining=${errorList.length}.`)
      if (progressEnabled) {
        writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'repair', {
          state: 'repair_verify',
          action: 'full-scan-after-repair',
          pass,
          maxPasses: maxRepairPasses,
          errorCount: errorList.length
        })
      }
      if (pass < maxRepairPasses) {
        logRepairMismatchWarningForTargets(bot, config, errorList, orderedTargets.length, `REPAIR-VERIFY-PASS-${pass}`)
      }
    }
  }

  console.log(`[SWEEP-FINAL] placed=${placed} already=${already} skipped=${skipped} ErrorCount=${errorList.length}`)

  if (multiRuntime && multiRole !== 'master') {
    writeMultiSlaveState(config, multiAssignment, {
      ready: false,
      finished: true,
      errorCount: errorList.length,
      phase: 'finished'
    })
    console.log(`[MULTI-SLAVE] ${multiAssignment?.name || bot.username} finished interval ${multiAssignment?.interval?.start}-${multiAssignment?.interval?.end}; skipping post-print workflow.`)
    if (progressEnabled) {
      clearProgressState(progressFile)
    }
    return {
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      sourceName: input.sourceName,
      didWork: true
    }
  }

  if (multiRuntime && multiRole === 'master') {
    await waitForMultiSlavesFinished(config, multiRuntime.plan || buildMultiUserPlan(config))
  }
  checkRuntimeStop()

  // Persist phase=post_print so crash here resumes post-print, not repair again
  if (progressEnabled) {
    writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'post_print', {
      state: 'post_print_workflow',
      action: 'run-post-print',
      postPrintStep: resumePostPrintStep,
      postPrintCartographyComplete: resumePostPrintCartographyComplete
    })
  }

  setRuntimeStopCheckpoint('post_print', 'dashboard-stop-before-post-print', {
    postPrintStep: resumePostPrintStep,
    postPrintCartographyComplete: resumePostPrintCartographyComplete
  })
  checkRuntimeStop()
  const postPrintResult = await runPostPrintWorkflowWithRecovery(bot, config, makePostPrintContext, resumePostPrintStep, { label: 'resume-run' })
  if (!postPrintResult?.completed) {
    console.log(`[POSTPRINT-WARN] Post-print workflow stopped at step=${postPrintResult?.failedStep || 'unknown'}. Job will remain pending until post-print completes.`)
    return {
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      sourceName: input.sourceName,
      didWork: true,
      postPrintPending: true,
      postPrintFailedStep: postPrintResult?.failedStep || 'unknown'
    }
  }

  await delay(toNumber(config.advanced?.postBuildDelayMs, 0))

  if (files.moveToFinishedFolder) {
    const fromPath = input.sourcePath
    const finishedDir = path.resolve(process.cwd(), files.finishedFolder || './finished-maps')
    if (!fs.existsSync(finishedDir)) {
      fs.mkdirSync(finishedDir, { recursive: true })
    }

    const toPath = resolveUniqueFilePath(path.join(finishedDir, path.basename(fromPath)))
    fs.renameSync(fromPath, toPath)
    console.log(`[FILES] Moved ${path.basename(fromPath)} to ${toPath}`)
  }

  if (files.disableOnFinished !== false) {
    console.log('[STATE] Job finished.')
  }

  if (multiRuntime && multiRole === 'master') {
    writeMultiMasterState(config, multiRuntime.plan || buildMultiUserPlan(config), false, {
      phase: 'finished',
      state: 'job_finished',
      action: 'post-print-complete',
      processedTargets: orderedTargets.length,
      totalTargets: orderedTargets.length,
      sourceName: input.sourceName
    })
  }

  if (progressEnabled) {
    clearProgressState(progressFile)
  }

  return {
    sourceType: input.sourceType,
    sourcePath: input.sourcePath,
    sourceName: input.sourceName,
    didWork: true
  }
}

function createBot(config) {
  const botCfg = config.bot || {}
  const username = botCfg.username || 'MapartBot'
  console.log(`[BOT] username=${username} target=${botCfg.host || '127.0.0.1'}:${toNumber(botCfg.port, 25565)} auth=${botCfg.auth || 'offline'} version=${botCfg.version || 'auto'}`)

  const bot = mineflayer.createBot({
    host: botCfg.host || '127.0.0.1',
    port: toNumber(botCfg.port, 25565),
    username,
    auth: botCfg.auth || 'offline',
    version: botCfg.version === 'auto' ? false : (botCfg.version || false),
    profilesFolder: botCfg.profilesFolder || './auth-cache',
    viewDistance: botCfg.viewDistance || 'tiny',
    checkTimeoutInterval: toNumber(botCfg.checkTimeoutInterval, 60000),
    onMsaCode: (data) => {
      const code = data?.user_code || data?.code || ''
      const url = data?.verification_uri || 'https://www.microsoft.com/link'
      console.log(`[MICROSOFT-AUTH] ${username} -> ${code || 'code-unavailable'}`)
      console.log(`[MICROSOFT-AUTH] Open ${url}${code ? ` and enter code ${code}` : ''}. The bot will continue automatically after browser verification.`)
    }
  })

  installAdaptiveLatencyGuard(bot, config)
  applyAntiHunger(bot, config)
  installChatLogin(bot, config)
  installTeleportRequestAutoAccept(bot, config)
  bot.once('login', () => applyInventoryStateSync(bot, config))

  return bot
}

function waitForInventoryStateUpdate(bot, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      bot._client.removeListener('set_slot', finish)
      bot._client.removeListener('window_items', finish)
      resolve()
    }
    bot._client.once('set_slot', finish)
    bot._client.once('window_items', finish)
    setTimeout(finish, timeoutMs)
  })
}

function applyInventoryStateSync(bot, config) {
  const waitMs = Math.max(0, toNumber(config?.advanced?.inventoryExtraStateSyncMs, 0))
  if (waitMs <= 0) return
  if (!bot.supportFeature('stateIdUsed')) return
  const original = bot.clickWindow.bind(bot)
  bot.clickWindow = async function (slot, mouseButton, mode) {
    await original(slot, mouseButton, mode)
    await waitForInventoryStateUpdate(bot, waitMs)
  }
}

function getChatLoginPassword(config) {
  const botCfg = config.bot || {}
  return (
    botCfg.loginPassword ||
    botCfg.password ||
    botCfg.chatLoginPassword ||
    process.env.NERV_LOGIN_PASSWORD ||
    ''
  )
}

function isOfflineAuthConfig(config) {
  return String(config?.bot?.auth || 'offline').toLowerCase() === 'offline'
}

function shouldHoldForOfflineChatLogin(bot) {
  const state = bot?.__nervChatLogin
  return state?.enabled === true && state?.required === true && state?.holdStartupUntilLoggedIn !== false
}

function markChatLoginSuccess(bot, reason = 'chat-success') {
  const state = bot?.__nervChatLogin
  if (!state || state.loggedIn) return false
  state.loggedIn = true
  state.successReason = reason
  state.successAt = Date.now()
  console.log(`[CHAT-LOGIN] Login confirmed via ${reason}.`)
  try {
    bot.emit('nerv-chat-login-success', { reason, at: state.successAt })
  } catch { }
  return true
}

function canBypassRemainingSpawnGate(bot, config, spawnedCount, requiredSpawnCount) {
  if (!isOfflineAuthConfig(config)) return false
  if (requiredSpawnCount <= 1) return false
  if (spawnedCount < 1) return false
  return bot?.__nervChatLogin?.loggedIn === true
}

function trySendChatLoginCommand(bot, reason = 'prompt') {
  const state = bot?.__nervChatLogin
  if (!state?.enabled || !state.required || state.loggedIn) return false
  if (bot.__nervSessionActive === false || bot?._client?.state === 'disconnected') return false

  const now = Date.now()
  if (state.attempts >= state.maxAttempts) return false
  if (now - state.lastSentAt < state.retryMs) return false

  state.attempts += 1
  state.lastSentAt = now
  state.lastReason = reason
  console.log(`[CHAT-LOGIN] Sending ${state.command} command attempt ${state.attempts}/${state.maxAttempts} reason=${reason}.`)
  setTimeout(() => {
    if (bot.__nervSessionActive === false || bot?._client?.state === 'disconnected') return
    if (state.loggedIn) return
    try {
      bot.chat(`${state.command} ${state.password}`)
    } catch (err) {
      console.log(`[CHAT-LOGIN-WARN] Could not send login command: ${err?.message || err}`)
    }
  }, state.minDelayMs)
  return true
}

async function waitForOfflineChatLogin(bot, config, context = 'startup') {
  const state = bot?.__nervChatLogin
  if (!shouldHoldForOfflineChatLogin(bot)) return true
  if (state.loggedIn) return true

  const timeoutMs = Math.max(0, toNumber(state.waitTimeoutMs, 30000))
  const startedAt = Date.now()
  let lastLogAt = 0

  trySendChatLoginCommand(bot, `${context}-initial`)

  while (isBotSessionLive(bot) && !state.loggedIn) {
    const elapsedMs = Date.now() - startedAt
    if (timeoutMs > 0 && elapsedMs >= timeoutMs) break

    if (Date.now() - lastLogAt >= 5000) {
      const attemptsLeft = Math.max(0, state.maxAttempts - state.attempts)
      console.log(`[CHAT-LOGIN] Waiting for offline login before ${context}. elapsed=${Math.round(elapsedMs / 1000)}s attemptsLeft=${attemptsLeft}`)
      lastLogAt = Date.now()
    }

    trySendChatLoginCommand(bot, `${context}-retry`)
    await delay(500)
  }

  return state.loggedIn === true
}

function getOfflineChatLoginSettleMs(config) {
  const login = config?.bot?.chatLogin || config?.chatLogin || {}
  return Math.max(0, toNumber(login.postSuccessDelayMs, 5000))
}

async function waitForOfflineChatLoginSettle(bot, config, context = 'startup') {
  if (!shouldHoldForOfflineChatLogin(bot)) return
  if (!bot?.__nervChatLogin?.loggedIn) return
  const settleMs = getOfflineChatLoginSettleMs(config)
  if (settleMs <= 0) return
  console.log(`[CHAT-LOGIN] Login confirmed; waiting ${settleMs}ms before ${context} scene checks.`)
  await delay(settleMs)
}

function installChatLogin(bot, config) {
  const botCfg = config.bot || {}
  const login = botCfg.chatLogin || config.chatLogin || {}
  const connectionIs6b6t = config.connection?.active === '6b6t' || config.connection?.selected === '6b6t'
  const required = login.enabled !== false && connectionIs6b6t && (login.offlineOnly === false || isOfflineAuthConfig(config))

  bot.__nervChatLogin = {
    enabled: login.enabled !== false,
    required,
    loggedIn: false,
    attempts: 0,
    lastSentAt: 0,
    lastReason: '',
    successReason: '',
    successAt: 0,
    holdStartupUntilLoggedIn: login.holdStartupUntilLoggedIn !== false,
    waitTimeoutMs: Math.max(0, toNumber(login.waitTimeoutMs, 30000))
  }

  if (login.enabled === false) return
  if (!connectionIs6b6t) return
  if (!required) return

  const password = String(getChatLoginPassword(config) || '').trim()
  if (!password) {
    console.log('[CHAT-LOGIN] Enabled for offline 6b6t account, but no password is configured. Add loginPassword to this account entry.')
    bot.__nervChatLogin.enabled = false
    return
  }

  const command = String(login.command || '/login').trim() || '/login'
  const promptPatterns = Array.isArray(login.promptPatterns) && login.promptPatterns.length
    ? login.promptPatterns.map((value) => String(value).toLowerCase())
    : ['please login with the command', '/login <password>', 'please login', 'use /login', 'log in with /login']
  const successPatterns = Array.isArray(login.successPatterns)
    ? login.successPatterns.map((value) => String(value).toLowerCase()).filter(Boolean)
    : ['you are now logged in', 'successfully logged in', 'logged in successfully', 'you have been logged in']
  const minDelayMs = Math.max(0, toNumber(login.minDelayMs, 750))
  const retryMs = Math.max(1000, toNumber(login.retryMs, 5000))
  const maxAttempts = Math.max(1, toNumber(login.maxAttempts, 5))
  const autoSendOnSpawn = login.autoSendOnSpawn !== false
  const autoSendInitialDelayMs = Math.max(0, toNumber(login.autoSendInitialDelayMs, Math.max(minDelayMs, 1500)))

  Object.assign(bot.__nervChatLogin, {
    password,
    command,
    promptPatterns,
    successPatterns,
    minDelayMs,
    retryMs,
    maxAttempts,
    autoSendOnSpawn,
    autoSendInitialDelayMs
  })

  bot.on('messagestr', (message) => {
    const text = String(message || '').toLowerCase()
    if (successPatterns.some((pattern) => text.includes(pattern))) {
      markChatLoginSuccess(bot, 'success-message')
      return
    }
    if (bot.__nervChatLogin?.loggedIn) return
    if (!promptPatterns.some((pattern) => text.includes(pattern))) return
    trySendChatLoginCommand(bot, 'prompt-detected')
  })

  bot.on('spawn', () => {
    if (!autoSendOnSpawn) return
    setTimeout(() => {
      trySendChatLoginCommand(bot, 'spawn-auto')
    }, autoSendInitialDelayMs)
  })
}

function normalizeMinecraftUsername(value) {
  const username = String(value || '').trim()
  return /^[A-Za-z0-9_]{3,16}$/.test(username) ? username : ''
}

function getTeleportRequestWhitelist(config) {
  const advanced = config?.advanced || {}
  const configuredFile = String(advanced.teleportRequestWhitelistFile || '').trim()
  const whitelistFile = configuredFile
    ? path.resolve(process.cwd(), configuredFile)
    : path.resolve(process.cwd(), 'nerv-printer-config', 'whitelisted-users.json')
  const fileData = readOptionalJson(whitelistFile)
  const fileEntries = Array.isArray(fileData?.users)
    ? fileData.users
    : (Array.isArray(fileData?.whitelist) ? fileData.whitelist : [])
  const configEntries = Array.isArray(advanced.teleportRequestWhitelist)
    ? advanced.teleportRequestWhitelist
    : []
  const entries = [...configEntries, ...fileEntries]
  return new Set(entries
    .map((entry) => normalizeMinecraftUsername(entry).toLowerCase())
    .filter(Boolean))
}

function extractTeleportRequestUsername(message) {
  const text = stripMinecraftChatFormatting(message).replace(/\s+/g, ' ').trim()
  const match = text.match(/^([A-Za-z0-9_]{3,16}) wants to teleport to you[.!]?$/i)
  return normalizeMinecraftUsername(match?.[1] || '')
}

function installTeleportRequestAutoAccept(bot, config) {
  const advanced = config.advanced || {}
  if (advanced.autoAcceptTeleportRequests === false) return

  if (!getTeleportRequestWhitelist(config).size) {
    console.log('[TPA] Auto-accept enabled, but teleport whitelist is empty.')
  }

  const command = String(advanced.teleportRequestAcceptCommand || '/tpy').trim() || '/tpy'
  const cooldownMs = Math.max(1000, toNumber(advanced.teleportRequestAcceptCooldownMs, 30000))
  const acceptedAtByUser = new Map()

  bot.on('messagestr', (message) => {
    const username = extractTeleportRequestUsername(message)
    if (!username) return
    const key = username.toLowerCase()
    const whitelist = getTeleportRequestWhitelist(config)
    if (!whitelist.has(key)) {
      if (advanced.debugPrints) console.log(`[TPA] Ignored teleport request from non-whitelisted user ${username}.`)
      return
    }

    const now = Date.now()
    const lastAcceptedAt = acceptedAtByUser.get(key) || 0
    if (now - lastAcceptedAt < cooldownMs) return
    acceptedAtByUser.set(key, now)

    const acceptCommand = `${command} ${username}`
    console.log(`[TPA] Accepting teleport request from ${username}: ${acceptCommand}`)
    try {
      bot.chat(acceptCommand)
    } catch (err) {
      console.log(`[TPA-WARN] Failed to accept teleport request from ${username}: ${err?.message || err}`)
    }
  })
}

function getAntiHungerOptions(config) {
  const value = config.advanced?.antiHunger
  if (value === false) return { enabled: false }
  if (value && typeof value === 'object') {
    return {
      enabled: value.enabled !== false,
      sprint: value.sprint !== false,
      onGround: value.onGround !== false
    }
  }
  return {
    enabled: true,
    sprint: true,
    onGround: true
  }
}

function applyAntiHunger(bot, config) {
  const options = getAntiHungerOptions(config)
  if (!options.enabled || bot.__nervAntiHungerApplied || !bot._client?.write) return

  let lastOnGround = false
  let ignoreNextMovePacket = false
  const originalWrite = bot._client.write.bind(bot._client)

  const isMovePacket = (packetName) => {
    return packetName === 'position' || packetName === 'position_look' || packetName === 'look' || packetName === 'flying'
  }

  const isStartSprintingAction = (data) => {
    const action = String(data?.actionId ?? data?.action ?? '').toLowerCase()
    return data?.actionId === 3 || action === '3' || action === 'start_sprinting' || action === 'start sprinting'
  }

  bot._client.write = (packetName, data) => {
    const packetData = data || {}
    if (options.sprint && packetName === 'entity_action' && isStartSprintingAction(packetData)) {
      return
    }

    if (options.onGround && data && isMovePacket(packetName)) {
      const realOnGround = Boolean(bot.entity?.onGround)
      if (realOnGround && !lastOnGround) {
        ignoreNextMovePacket = true
      }
      lastOnGround = realOnGround

      if (ignoreNextMovePacket) {
        ignoreNextMovePacket = false
      } else {
        const inWater = Boolean(bot.entity?.isInWater || bot.entity?.isInLava)
        const hasVehicle = bot.vehicle != null
        const isDigging = bot.targetDigBlock != null
        // MeteorClient uses fallDistance <= 0 (effectively always true when onGround).
        // velocity.y fails when stepping onto carpet: physics briefly computes a small
        // positive y-velocity for the step-up, so the spoof was silently skipped on
        // every single carpet step, letting exhaustion accumulate despite anti-hunger.
        if (!hasVehicle && !inWater && realOnGround && !isDigging) {
          if (Object.prototype.hasOwnProperty.call(data, 'onGround')) data.onGround = false
          if (Object.prototype.hasOwnProperty.call(data, 'ground')) data.ground = false
        }
      }
    }

    return originalWrite(packetName, data)
  }

  bot.__nervAntiHungerApplied = true
  console.log(`[ANTI-HUNGER] Enabled by default. sprint=${options.sprint !== false} onGround=${options.onGround !== false}`)
}

function hasCliFlag(flag) {
  return process.argv.slice(2).includes(flag)
}

function getCliValue(name) {
  const prefix = `${name}=`
  const entry = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : null
}

function sanitizeSyncName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_')
}

function parseUsernameList(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function getSimpleUsernameRoster(config) {
  const cliUsernames = parseUsernameList(getCliValue('--usernames'))
  if (cliUsernames.length) return cliUsernames

  const cliUsername = getCliValue('--username')
  if (cliUsername) return [cliUsername.trim()].filter(Boolean)

  const envUsernames = parseUsernameList(process.env.NERV_USERNAMES)
  if (envUsernames.length) return envUsernames

  const envUsername = process.env.NERV_USERNAME
  if (envUsername) return [envUsername.trim()].filter(Boolean)

  if (Array.isArray(config.bot?.usernames) && config.bot.usernames.length) {
    return config.bot.usernames
  }

  return config.bot?.username ? [String(config.bot.username).trim()].filter(Boolean) : []
}

function getAccountBotOverrides(entry) {
  if (!entry || typeof entry !== 'object') return {}
  const allowedKeys = [
    'auth',
    'profilesFolder',
    'loginPassword',
    'password',
    'chatLoginPassword'
  ]
  const overrides = {}
  for (const key of allowedKeys) {
    if (entry[key] !== undefined) overrides[key] = entry[key]
  }
  return overrides
}

function mergeBotOverrides(baseBot, overrides = {}) {
  return {
    ...(baseBot || {}),
    ...overrides,
    reconnect: {
      ...(baseBot?.reconnect || {}),
      ...(overrides.reconnect || {})
    }
  }
}

function normalizeSimpleBotEntry(entry, index, multi) {
  if (typeof entry === 'string') {
    return {
      name: entry.trim(),
      role: index === 0 ? 'master' : 'slave',
      enabled: true,
      joinDelayMs: index * toNumber(multi.joinStaggerMs, 8000),
      startDelayMs: index * toNumber(multi.startStaggerMs, 3000),
      botOverrides: {},
      raw: entry
    }
  }

  if (entry && typeof entry === 'object') {
    return {
      name: String(entry.name || entry.username || '').trim(),
      role: String(entry.role || (index === 0 ? 'master' : 'slave')).toLowerCase(),
      enabled: entry.enabled !== false,
      joinDelayMs: Math.max(0, toNumber(entry.joinDelayMs, index * toNumber(multi.joinStaggerMs, 8000))),
      startDelayMs: Math.max(0, toNumber(entry.startDelayMs, index * toNumber(multi.startStaggerMs, 3000))),
      botOverrides: getAccountBotOverrides(entry),
      raw: entry
    }
  }

  return null
}

function getEnabledMultiBots(config) {
  const multi = config.multiUser || {}
  const simpleUsernames = getSimpleUsernameRoster(config)
  const simpleRoster = simpleUsernames.length ? simpleUsernames : null
  const configured = simpleRoster || (Array.isArray(multi.bots) ? multi.bots : [])
  const bots = configured
    .map((entry, index) => normalizeSimpleBotEntry(entry, index, multi))
    .filter((entry) => entry && entry.enabled !== false && entry.name)

  if (!bots.some((entry) => entry.role === 'master') && bots.length) {
    bots[0].role = 'master'
  }

  return bots
}

function shouldRunMultiUser(config) {
  if (config.multiUser?.enabled === false) return false
  return getEnabledMultiBots(config).length > 1
}

function applySingleBotRoster(config) {
  const bots = getEnabledMultiBots(config)
  const multiAllowed = config.multiUser?.enabled !== false
  if (bots.length === 1 || (bots.length > 1 && !multiAllowed)) {
    config.bot = {
      ...mergeBotOverrides(config.bot, bots[0].botOverrides),
      username: bots[0].name
    }
    if (bots.length > 1 && !multiAllowed) {
      console.log(`[CONFIG] multiUser.enabled=false; using first enabled bot account ${bots[0].name}.`)
    }
  }
  return config
}

function computeWorkerIntervals(workerCount, width = 128) {
  const count = Math.max(1, toNumber(workerCount, 1))
  const size = Math.max(1, toNumber(width, 128))
  const intervals = []
  for (let i = 0; i < count; i += 1) {
    intervals.push({
      start: Math.floor(i * size / count),
      end: Math.floor((i + 1) * size / count) - 1
    })
  }
  return intervals
}

function buildMultiUserPlan(config) {
  const bots = getEnabledMultiBots(config)
  const master = bots.find((entry) => entry.role === 'master') || bots[0] || null
  const slaves = bots.filter((entry) => entry !== master)
  const orderedWorkers = master ? [master, ...slaves] : bots
  const intervals = computeWorkerIntervals(orderedWorkers.length, 128)
  const assignments = orderedWorkers.map((bot, index) => ({
    ...bot,
    interval: intervals[index] || { start: 0, end: 127 },
    progressFile: `./logs/nerv-printer-progress-${sanitizeSyncName(bot.name)}.json`,
    stateFile: bot.role === 'master'
      ? 'master_state.json'
      : `slave_${sanitizeSyncName(bot.name)}_state.json`
  }))

  return {
    mode: String(config.multiUser?.mode || 'file').toLowerCase(),
    syncFolder: config.multiUser?.syncFolder || './logs/nerv-printer-sync',
    master: assignments.find((entry) => entry.role === 'master') || null,
    assignments
  }
}

function multiPlanMatchesState(plan, state) {
  if (!state || !Array.isArray(state.intervals)) return false
  const expected = plan.assignments.map((entry) => `${entry.name}:${entry.role}:${entry.interval.start}-${entry.interval.end}`).sort()
  const actual = state.intervals.map((entry) => `${entry.player}:${entry.role}:${entry.start}-${entry.end}`).sort()
  return expected.length === actual.length && expected.every((entry, index) => entry === actual[index])
}

function hasAnyMultiProgress(plan) {
  return plan.assignments.some((assignment) => {
    const progressPath = path.resolve(process.cwd(), assignment.progressFile)
    const progress = readOptionalJson(progressPath)
    return progress && String(progress.phase || '').toLowerCase() !== 'done'
  })
}

function resolveMultiRuntimeForLaunch(config, plan) {
  const now = Date.now()
  const existing = readOptionalJson(path.join(resolveMultiSyncFolder(config), 'master_state.json'))
  const canReuse = config.multiUser?.resumeExistingJob !== false &&
    existing?.jobId &&
    Number.isFinite(existing.generation) &&
    multiPlanMatchesState(plan, existing) &&
    (existing.running === true || hasAnyMultiProgress(plan))

  if (canReuse) {
    console.log(`[MULTI] Resuming existing jobId=${existing.jobId} generation=${existing.generation}.`)
    return {
      jobId: existing.jobId,
      generation: Number(existing.generation),
      resumed: true
    }
  }

  return {
    jobId: `job-${now}`,
    generation: now,
    resumed: false
  }
}

function resolveMultiSyncFolder(config) {
  return path.resolve(process.cwd(), config.multiUser?.syncFolder || './logs/nerv-printer-sync')
}

function multiStateFile(config, assignment) {
  return path.join(resolveMultiSyncFolder(config), assignment.stateFile)
}

function getMultiRuntime(config) {
  return config.multiUser?.runtime || {}
}

function multiStateMatchesRuntime(config, state) {
  const runtime = getMultiRuntime(config)
  if (!state) return false
  if (runtime.jobId && state.jobId && state.jobId !== runtime.jobId) return false
  if (Number.isFinite(runtime.generation) && Number.isFinite(state.generation) && Number(state.generation) !== Number(runtime.generation)) return false
  return true
}

function readMultiState(config, assignment) {
  const state = readOptionalJson(multiStateFile(config, assignment))
  return multiStateMatchesRuntime(config, state) ? state : null
}

function readMultiMasterState(config) {
  const state = readOptionalJson(path.join(resolveMultiSyncFolder(config), 'master_state.json'))
  return multiStateMatchesRuntime(config, state) ? state : null
}

function writeMultiMasterState(config, plan, running, extra = {}) {
  const master = plan.master
  if (!master) return
  const runtime = getMultiRuntime(config)
  writeJson(path.join(resolveMultiSyncFolder(config), 'master_state.json'), {
    jobId: runtime.jobId || extra.jobId || `job-${Date.now()}`,
    generation: toNumber(runtime.generation, toNumber(extra.generation, 0)),
    masterPlayerName: master.name,
    running: running === true,
    timestampMs: Date.now(),
    heartbeatMs: Math.max(1000, toNumber(config.multiUser?.heartbeatMs, 5000)),
    intervals: plan.assignments.map((entry) => ({
      player: entry.name,
      role: entry.role,
      start: entry.interval.start,
      end: entry.interval.end
    })),
    ...extra
  })
}

function writeMultiSlaveState(config, assignment, state = {}) {
  const previous = readOptionalJson(multiStateFile(config, assignment)) || {}
  const runtime = getMultiRuntime(config)
  writeJson(multiStateFile(config, assignment), {
    jobId: runtime.jobId || previous.jobId || `job-${Date.now()}`,
    generation: toNumber(runtime.generation, toNumber(previous.generation, 0)),
    playerName: assignment.name,
    role: assignment.role,
    interval: assignment.interval,
    ready: state.ready === true,
    finished: state.finished === true,
    errorCount: Math.max(0, toNumber(state.errorCount, 0)),
    phase: state.phase || 'unknown',
    state: state.state || previous.state || null,
    action: state.action || previous.action || null,
    processedTargets: Number.isFinite(state.processedTargets) ? state.processedTargets : previous.processedTargets,
    totalTargets: Number.isFinite(state.totalTargets) ? state.totalTargets : previous.totalTargets,
    sourceName: state.sourceName || previous.sourceName || null,
    session: Number.isFinite(state.session) ? state.session : previous.session,
    timestampMs: Date.now()
  })
}

function isFreshMultiState(state, staleMs) {
  if (!state || !Number.isFinite(state.timestampMs)) return false
  const age = Date.now() - state.timestampMs
  return age >= 0 && age <= Math.max(1000, toNumber(staleMs, 15000))
}

function writeMultiWorkerHeartbeat(config, assignment) {
  if (!assignment || config.multiUser?.runtime?.enabled !== true) return
  if (assignment.role === 'master') {
    const plan = config.multiUser.runtime.plan || buildMultiUserPlan(config)
    const previous = readMultiMasterState(config)
    writeMultiMasterState(config, plan, previous?.running === true, {
      phase: previous?.phase || 'connected',
      state: previous?.state || null,
      action: previous?.action || null,
      processedTargets: previous?.processedTargets,
      totalTargets: previous?.totalTargets,
      sourceName: previous?.sourceName || null
    })
    return
  }

  const previous = readMultiState(config, assignment)
  writeMultiSlaveState(config, assignment, {
    ready: previous?.ready === true,
    finished: previous?.finished === true,
    errorCount: toNumber(previous?.errorCount, 0),
    phase: previous?.phase || 'connected',
    state: previous?.state || null,
    action: previous?.action || null,
    processedTargets: previous?.processedTargets,
    totalTargets: previous?.totalTargets,
    sourceName: previous?.sourceName || null
  })
}

async function waitForMultiSlavesFinished(config, plan) {
  const staleMs = Math.max(1000, toNumber(config.multiUser?.staleStateMs, 15000))
  const pollMs = Math.max(500, Math.min(5000, Math.floor(staleMs / 3)))
  const slaves = plan.assignments.filter((entry) => entry.role !== 'master')
  if (!slaves.length) return true

  console.log(`[MULTI-MASTER] Waiting for ${slaves.length} slave(s) to finish before post-print.`)
  let lastLogAt = 0
  let lastHeartbeatAt = 0
  while (true) {
    const pending = []
    for (const slave of slaves) {
      const state = readMultiState(config, slave)
      const fresh = isFreshMultiState(state, staleMs)
      const finished = state?.finished === true
      if (!finished) pending.push(`${slave.name}${fresh ? '' : ':stale'}`)
    }

    if (!pending.length) {
      console.log('[MULTI-MASTER] All slaves finished.')
      return true
    }

    if (Date.now() - lastHeartbeatAt > Math.max(1000, toNumber(config.multiUser?.heartbeatMs, 5000))) {
      lastHeartbeatAt = Date.now()
      writeMultiMasterState(config, plan, true, { phase: 'waiting_slaves_finished' })
    }
    if (Date.now() - lastLogAt > 10000) {
      lastLogAt = Date.now()
      console.log(`[MULTI-MASTER] Waiting for slaves: ${pending.join(', ')}`)
    }
    await delay(pollMs)
  }
}

async function waitForMultiSlavesReady(config, plan) {
  if (config.multiUser?.requireAllReady === false) return true
  const staleMs = Math.max(1000, toNumber(config.multiUser?.staleStateMs, 15000))
  const pollMs = Math.max(500, Math.min(5000, Math.floor(staleMs / 3)))
  const slaves = plan.assignments.filter((entry) => entry.role !== 'master')
  if (!slaves.length) return true

  console.log(`[MULTI-MASTER] Waiting for ${slaves.length} slave(s) ready before starting interval.`)
  let lastLogAt = 0
  let lastHeartbeatAt = 0
  while (true) {
    const pending = []
    for (const slave of slaves) {
      const state = readMultiState(config, slave)
      const fresh = isFreshMultiState(state, staleMs)
      const ready = fresh && state.ready === true
      const finished = state?.finished === true
      if (!ready && !finished) pending.push(`${slave.name}${fresh ? '' : ':stale'}`)
    }

    if (!pending.length) {
      console.log('[MULTI-MASTER] All slaves ready.')
      return true
    }

    if (Date.now() - lastHeartbeatAt > Math.max(1000, toNumber(config.multiUser?.heartbeatMs, 5000))) {
      lastHeartbeatAt = Date.now()
      writeMultiMasterState(config, plan, false, { phase: 'waiting_slaves_ready' })
    }
    if (Date.now() - lastLogAt > 10000) {
      lastLogAt = Date.now()
      console.log(`[MULTI-MASTER] Waiting for ready slaves: ${pending.join(', ')}`)
    }
    await delay(pollMs)
  }
}

async function waitForMultiMasterRunning(config) {
  const staleMs = Math.max(1000, toNumber(config.multiUser?.staleStateMs, 15000))
  const pollMs = Math.max(500, Math.min(5000, Math.floor(staleMs / 3)))
  const assignment = config.multiUser?.runtime?.assignment || null
  let lastLogAt = 0
  let lastReadyWriteAt = 0
  while (true) {
    if (assignment && Date.now() - lastReadyWriteAt >= Math.max(1000, Math.floor(pollMs / 2))) {
      lastReadyWriteAt = Date.now()
      writeMultiSlaveState(config, assignment, { ready: true, finished: false, errorCount: 0, phase: 'waiting_master' })
    }
    const state = readMultiMasterState(config)
    if (isFreshMultiState(state, staleMs) && state.running === true) return true
    if (Date.now() - lastLogAt > 10000) {
      lastLogAt = Date.now()
      console.log('[MULTI-SLAVE] Waiting for fresh master_state.json running=true.')
    }
    await delay(pollMs)
  }
}

function makeMultiWorkerConfig(config, plan, assignment) {
  const workerConfig = cloneJson(config)
  workerConfig.bot = {
    ...mergeBotOverrides(workerConfig.bot || {}, assignment.botOverrides || {}),
    username: assignment.name
  }
  workerConfig.files = {
    ...(workerConfig.files || {}),
    progressFile: assignment.progressFile,
    moveToFinishedFolder: assignment.role === 'master' && config.files?.moveToFinishedFolder === true
  }
  workerConfig.printer = {
    ...(workerConfig.printer || {}),
    startDelayMs: Math.max(0, toNumber(config.printer?.startDelayMs, 1500) + toNumber(assignment.startDelayMs, 0))
  }
  workerConfig.multiUser = {
    ...(workerConfig.multiUser || {}),
    enabled: true,
    runtime: {
      enabled: true,
      mode: plan.mode,
      jobId: config.multiUser?.runtime?.jobId || `job-${Date.now()}`,
      generation: toNumber(config.multiUser?.runtime?.generation, 0),
      role: assignment.role,
      assignment,
      plan
    }
  }
  return workerConfig
}

async function runMultiUserPlanTest(config) {
  const plan = buildMultiUserPlan(config)
  console.log(`[TEST-MULTI] mode=${plan.mode} syncFolder=${plan.syncFolder}`)
  if (!plan.assignments.length) {
    console.log('[TEST-MULTI] No enabled bots configured.')
    return
  }

  for (const bot of plan.assignments) {
    const width = bot.interval.end - bot.interval.start + 1
    console.log(`[TEST-MULTI] ${bot.role.toUpperCase()} ${bot.name}: interval=${bot.interval.start}-${bot.interval.end} width=${width} joinDelayMs=${bot.joinDelayMs} startDelayMs=${bot.startDelayMs} progress=${bot.progressFile} state=${bot.stateFile}`)
  }

  const totalWidth = plan.assignments.reduce((sum, entry) => sum + (entry.interval.end - entry.interval.start + 1), 0)
  const hasOverlap = plan.assignments.some((entry, index) => plan.assignments.some((other, otherIndex) => {
    if (index >= otherIndex) return false
    return entry.interval.start <= other.interval.end && other.interval.start <= entry.interval.end
  }))
  console.log(`[TEST-MULTI] coverage=${totalWidth}/128 overlap=${hasOverlap}`)
}

async function runDumpTest(bot, config) {
  const dumpStations = buildDumpStations(config)
  if (!dumpStations.length) {
    console.log('[TEST-DUMP] No dump station configured.')
    return
  }

  const stations = dumpStations.slice()
  const waitMs = Math.max(0, toNumber(config.advanced?.dumpTestStationWaitMs, 5000))
  const tossAtEachStation = config.advanced?.dumpTestTossAtEachStation !== false

  console.log(`[TEST-DUMP] Testing ${stations.length} dump station(s). waitMs=${waitMs} toss=${tossAtEachStation}`)

  for (let index = 0; index < stations.length; index += 1) {
    const targetStation = stations[index]
    const dumpPos = targetStation?.position
    if (!dumpPos) {
      console.log(`[TEST-DUMP] Station ${index + 1}/${stations.length} has no position; skipping.`)
      continue
    }

    console.log(`[TEST-DUMP] Station ${index + 1}/${stations.length}: walking to ${dumpPos.x} ${dumpPos.y} ${dumpPos.z}.`)
    await bot.pathfinder.goto(new GoalNear(Number(dumpPos.x), Number(dumpPos.y), Number(dumpPos.z), 0.5))

    await maintainDumpAim(bot, config, targetStation)
    const aim = minecraftYawPitchToMineflayerRadians(targetStation?.yaw, targetStation?.pitch, config.advanced || {})
    const botYawDeg = normalizeAngleDegrees(180 - (bot.entity.yaw * 180 / Math.PI))
    const botPitchDeg = -(bot.entity.pitch * 180 / Math.PI)
    console.log(`[TEST-DUMP] Station ${index + 1}/${stations.length}: target yaw=${aim?.yawDeg ?? 'null'} pitch=${aim?.pitchDeg ?? 'null'} | bot yaw=${botYawDeg?.toFixed(2) ?? 'null'} pitch=${botPitchDeg.toFixed(2)}.`)

    if (tossAtEachStation) {
      const stack = bot.inventory.items().find((item) => String(item?.name || '').endsWith('_carpet'))
      if (stack) {
        console.log(`[TEST-DUMP] Station ${index + 1}/${stations.length}: tossing ${stack.name} x${stack.count}.`)
        await bot.tossStack(stack)
        await delay(toNumber(config.advanced?.inventoryActionDelayMs, 100))
        await maintainDumpAim(bot, config, targetStation)
      } else {
        console.log(`[TEST-DUMP] Station ${index + 1}/${stations.length}: no carpet stack found; aim only.`)
      }
    }

    if (waitMs > 0 && index < stations.length - 1) {
      console.log(`[TEST-DUMP] Waiting ${waitMs}ms before next station.`)
      await delay(waitMs)
    }
  }

  console.log('[TEST-DUMP] All dump stations tested.')
}

function runSingleDumpTestSession(config) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.loadPlugin(pathfinder)
    installPlatformSafety(bot, config)

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    let printerStarted = false
    let startupPending = false
    let spawnedCount = 0
    let spawnFallbackTimer = null

    const startAfterSpawn = async (trigger = 'threshold') => {
      if (printerStarted || startupPending) return
      startupPending = true
      if (spawnFallbackTimer) {
        clearTimeout(spawnFallbackTimer)
        spawnFallbackTimer = null
      }

      const reqSpawn = getRequiredSpawnCount(config)
      const triggerLabel = trigger === 'fallback'
        ? `Fallback startup after ${spawnedCount}/${reqSpawn} spawn event(s).`
        : `Threshold reached (${spawnedCount}/${reqSpawn}).`
      console.log(`[SPAWN] ${triggerLabel} Delaying startup...`)

      const printer = config.printer || {}
      await delay(toNumber(printer.startDelayMs, 1500))

      let attempts = 0
      while (attempts < 20) {
        const p = bot?.entity?.position
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) break
        await delay(500)
        attempts++
      }

      if (!isPlatformNearby(bot, config)) {
        console.log(`[STATE] Bot is not near the mapart platform (spawn ${spawnedCount}). Waiting idle.`)
        return
      }

      printerStarted = true
      const allowJump = printer.allowJump !== false

      console.log('[TEST-DUMP] Connected.')

      configurePathfinderMovements(bot, config)

      try {
        await delay(toNumber(printer.startDelayMs, 1500))
        await runDumpTest(bot, config)
      } catch (err) {
        console.log('[TEST-DUMP-ERROR]', err?.message || err)
      } finally {
        bot.quit('dump test complete')
        settle()
      }
    }

    bot.on('spawn', async () => {
      spawnedCount += 1
      if (printerStarted || startupPending) return

      const reqSpawn = getRequiredSpawnCount(config)
      if (spawnedCount < reqSpawn) {
        console.log(`[SPAWN] Event received (${spawnedCount}/${reqSpawn}). Waiting for more...`)
        return
      }

      await startAfterSpawn('threshold')
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${text}`)
    })

    bot.on('error', (err) => {
      console.log('[ERROR]', err?.message || String(err))
    })

    bot.on('end', () => {
      settle()
    })
  })
}

async function runMovingPlaceTest(bot, config) {
  const printer = config.printer || {}
  const input = await loadTargets(config)
  const calibratedTargets = calibrateTargetsForWorld(bot, input.targets, config)
  const linesPerRun = Math.max(1, toNumber(printer.linesPerRun, 3))
  const northToSouth = printer.northToSouth !== false
  const placeRange = Math.max(1, toNumber(printer.placeRange, 4))
  const tickMs = Math.max(10, toNumber(printer.fastTraversalTickMs, 40))
  const maxPerTick = Math.max(1, toNumber(printer.maxPlacementsPerTick, 1))
  const targetCount = Math.max(1, toNumber(config.advanced?.movingPlaceTestTargetCount, 64))
  const checkpointEveryRows = Math.max(1, toNumber(config.advanced?.movingPlaceTestCheckpointEveryRows, 8))
  const waitAfterMs = Math.max(0, toNumber(config.advanced?.movingPlaceTestWaitAfterMs, 5000))

  const orderedTargets = orderTargetsLineByLine(calibratedTargets, linesPerRun, northToSouth)
  const testTargets = orderedTargets.slice(0, Math.min(targetCount, orderedTargets.length))

  if (!testTargets.length) {
    console.log('[TEST-MOVE-PLACE] No targets loaded.')
    return
  }

  console.log(`[TEST-MOVE-PLACE] Loaded ${input.sourceName}; testing ${testTargets.length}/${orderedTargets.length} targets.`)
  await ensureMaterialsForTargets(bot, config, testTargets)

  const Vec3 = bot.entity.position.constructor
  const byRow = new Map()
  for (const target of testTargets) {
    const list = byRow.get(target.row) || []
    list.push(target)
    byRow.set(target.row, list)
  }

  const rows = [...byRow.keys()].sort((a, b) => northToSouth ? a - b : b - a)
  const checkpoints = []
  for (let i = 0; i < rows.length; i += checkpointEveryRows) {
    const rowTargets = byRow.get(rows[i]) || []
    const mid = rowTargets[Math.floor(rowTargets.length / 2)] || rowTargets[0]
    if (mid) checkpoints.push(mid.position)
  }
  checkpoints.push(testTargets[testTargets.length - 1].position)

  let active = true
  let placed = 0
  let already = 0
  let skipped = 0
  const processed = new Set()

  const placementLoop = observeBackgroundTask((async () => {
    while (active) {
      const botPos = bot.entity.position
      let placementsThisTick = 0

      const candidates = testTargets
        .filter((target) => !processed.has(target))
        .filter((target) => botPos.distanceTo(new Vec3(target.position.x + 0.5, target.position.y + 0.5, target.position.z + 0.5)) <= placeRange)
        .sort((a, b) => {
          const da = botPos.distanceTo(new Vec3(a.position.x + 0.5, a.position.y + 0.5, a.position.z + 0.5))
          const db = botPos.distanceTo(new Vec3(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5))
          return da - db
        })

      for (const target of candidates) {
        if (placementsThisTick >= maxPerTick) break
        processed.add(target)
        placementsThisTick += 1

        try {
          const result = await placeTarget(bot, config, target, true)
          if (result.state === 'placed') placed += 1
          else if (result.state === 'already') already += 1
          else {
            skipped += 1
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[TEST-MOVE-PLACE-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
            }
          }
        } catch (err) {
          skipped += 1
          if (config.errorHandling?.logErrors !== false) {
            console.log(`[TEST-MOVE-PLACE-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
          }
        }
      }

      await delay(tickMs)
    }
  })())

  try {
    bot.setControlState('sprint', String(printer.sprintMode || 'always').toLowerCase() !== 'off')
    for (let i = 0; i < checkpoints.length; i += 1) {
      const cp = checkpoints[i]
      console.log(`[TEST-MOVE-PLACE] Checkpoint ${i + 1}/${checkpoints.length}: ${cp.x} ${cp.y} ${cp.z}`)
      await bot.pathfinder.goto(new GoalNear(cp.x, cp.y, cp.z, 1))
    }
  } finally {
    active = false
    await placementLoop
  }

  console.log(`[TEST-MOVE-PLACE] Done. placed=${placed} already=${already} skipped=${skipped} processed=${processed.size}/${testTargets.length}`)
  if (waitAfterMs > 0) {
    console.log(`[TEST-MOVE-PLACE] Waiting ${waitAfterMs}ms before logout.`)
    await delay(waitAfterMs)
  }
}

function runSingleMovingPlaceTestSession(config) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.loadPlugin(pathfinder)

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    let printerStarted = false
    let startupPending = false
    let spawnedCount = 0
    let spawnFallbackTimer = null

    const startAfterSpawn = async (trigger = 'threshold') => {
      if (printerStarted || startupPending) return
      startupPending = true
      if (spawnFallbackTimer) {
        clearTimeout(spawnFallbackTimer)
        spawnFallbackTimer = null
      }

      const reqSpawn = getRequiredSpawnCount(config)
      const triggerLabel = trigger === 'fallback'
        ? `Fallback startup after ${spawnedCount}/${reqSpawn} spawn event(s).`
        : `Threshold reached (${spawnedCount}/${reqSpawn}).`
      console.log(`[SPAWN] ${triggerLabel} Delaying startup...`)

      const printer = config.printer || {}
      await delay(toNumber(printer.startDelayMs, 1500))

      let attempts = 0
      while (attempts < 20) {
        const p = bot?.entity?.position
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) break
        await delay(500)
        attempts++
      }

      if (!isPlatformNearby(bot, config)) {
        console.log(`[STATE] Bot is not near the mapart platform (spawn ${spawnedCount}). Waiting idle.`)
        return
      }

      printerStarted = true
      const allowJump = printer.allowJump !== false

      console.log('[TEST-MOVE-PLACE] Connected.')

      configurePathfinderMovements(bot, config)

      try {
        await delay(toNumber(printer.startDelayMs, 1500))
        await runMovingPlaceTest(bot, config)
      } catch (err) {
        console.log('[TEST-MOVE-PLACE-ERROR]', err?.message || err)
      } finally {
        bot.quit('moving place test complete')
        settle()
      }
    }

    bot.on('spawn', async () => {
      spawnedCount += 1
      if (printerStarted || startupPending) return

      const reqSpawn = getRequiredSpawnCount(config)
      if (spawnedCount < reqSpawn) {
        console.log(`[SPAWN] Event received (${spawnedCount}/${reqSpawn}). Waiting for more...`)
        return
      }

      await startAfterSpawn('threshold')
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${text}`)
    })

    bot.on('error', (err) => {
      console.log('[ERROR]', err?.message || String(err))
    })

    bot.on('end', () => {
      settle()
    })
  })
}

function buildNervScannerCheckpoints(targets, config, maxGroupsOverride = null) {
  const printer = config.printer || {}
  const linesPerRun = Math.max(1, toNumber(printer.linesPerRun, 3))
  const northToSouth = printer.northToSouth !== false
  const maxGroups = Math.max(1, toNumber(maxGroupsOverride ?? config.advanced?.nervScannerTestLineGroups, 2))

  const cols = [...new Set(targets.map((target) => target.col))].sort((a, b) => a - b)
  const checkpoints = []
  let startOnNorthSide = northToSouth
  let groupsAdded = 0

  for (let i = 0; i < cols.length && groupsAdded < maxGroups; i += linesPerRun) {
    const colBatch = cols.slice(i, i + linesPerRun)
    const groupTargets = targets.filter((target) => colBatch.includes(target.col))
    if (!groupTargets.length) continue

    const minX = Math.min(...groupTargets.map((target) => target.position.x))
    const minY = Math.min(...groupTargets.map((target) => target.position.y))
    const minZ = Math.min(...groupTargets.map((target) => target.position.z))
    const maxZ = Math.max(...groupTargets.map((target) => target.position.z))
    const cp1 = { x: minX + 0.5, y: minY, z: minZ + 0.5 }
    const cp2 = { x: minX + 0.5, y: minY, z: maxZ + 0.5 }

    if (startOnNorthSide) {
      checkpoints.push({ position: cp1, action: '', targets: groupTargets, colBatch })
      checkpoints.push({ position: cp2, action: 'lineEnd', targets: groupTargets, colBatch })
    } else {
      checkpoints.push({ position: cp2, action: '', targets: groupTargets, colBatch })
      checkpoints.push({ position: cp1, action: 'lineEnd', targets: groupTargets, colBatch })
    }

    startOnNorthSide = !startOnNorthSide
    groupsAdded += 1
  }

  return checkpoints
}

function findNervScannerCandidate(bot, config, targetByXZ, currentGoal, processed = new Set(), activeCols = null, priorityKeys = null) {
  const printer = config.printer || {}
  const placeRange = Math.max(1, toNumber(printer.placeRange, 4))
  const placeRange2 = placeRange * placeRange
  const minPlaceDistance = Math.max(0, toNumber(printer.minPlaceDistance, 0.8))
  const minPlaceDistance2 = minPlaceDistance * minPlaceDistance
  const bandWidth = Math.max(1, toNumber(printer.linesPerRun, 3))
  const goalBlockX = !(activeCols instanceof Set && activeCols.size > 0) && Number.isFinite(currentGoal?.x)
    ? Math.floor(currentGoal.x)
    : null
  const activeMinX = goalBlockX == null ? null : goalBlockX - 1
  const activeMaxX = goalBlockX == null ? null : goalBlockX + Math.max(0, bandWidth - 1)
  const radius = Math.ceil(placeRange) + 1
  const botX = bot.entity.position.x
  const botY = bot.entity.position.y
  const botZ = bot.entity.position.z
  const baseX = Math.floor(botX)
  const baseZ = Math.floor(botZ)

  let best = null
  let bestDistance2 = Number.POSITIVE_INFINITY
  let bestPriority = -1

  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const x = baseX + dx
      const z = baseZ + dz

      if (activeMinX != null && (x < activeMinX || x > activeMaxX)) continue

      const target = targetByXZ.get(`${x}:${z}`)
      if (!target) continue
      if (activeCols instanceof Set && !activeCols.has(target.col)) continue
      const key = `${target.position.x}:${target.position.y}:${target.position.z}`
      if (processed.has(key)) continue

      const tx = target.position.x + 0.5
      const ty = target.position.y + 0.5
      const tz = target.position.z + 0.5
      const ddx = botX - tx
      const ddy = botY - ty
      const ddz = botZ - tz
      const distance2 = ddx * ddx + ddy * ddy + ddz * ddz
      if (distance2 > placeRange2 || distance2 <= minPlaceDistance2) continue

      const priority = priorityKeys instanceof Set && priorityKeys.has(key) ? 1 : 0

      if (priority > bestPriority || (priority === bestPriority && distance2 < bestDistance2)) {
        // Only do blockAt for the current best candidate to skip expensive world reads
        const actual = bot.blockAt(new bot.entity.position.constructor(target.position.x, target.position.y, target.position.z))
        if (actual?.name === target.blockName) {
          processed.add(key)
          continue
        }
        if (actual && actual.name !== 'air' && !String(actual.name).endsWith('_carpet')) continue

        best = target
        bestDistance2 = distance2
        bestPriority = priority
      }
    }
  }

  return best
}

async function placeNervScannerTarget(bot, config, target, options = {}) {
  return await placeTarget(bot, config, target, options.confirm === true ? 'noWaitConfirm' : 'noWait')
}

async function runNervScannerTest(bot, config) {
  const printer = config.printer || {}
  const input = await loadTargets(config)
  const calibratedTargets = calibrateTargetsForWorld(bot, input.targets, config)
  const checkpoints = buildNervScannerCheckpoints(calibratedTargets, config)
  const testTargets = [...new Map(checkpoints.flatMap((cp) => cp.targets).map((target) => [`${target.position.x}:${target.position.y}:${target.position.z}`, target])).values()]
  const targetByXZ = new Map(testTargets.map((target) => [`${target.position.x}:${target.position.z}`, target]))
  const tickMs = Math.max(10, toNumber(printer.fastTraversalTickMs, 40))
  const maxPerTick = Math.max(1, toNumber(printer.maxPlacementsPerTick, 1))
  const waitAfterMs = Math.max(0, toNumber(config.advanced?.nervScannerTestWaitAfterMs, 5000))

  if (!checkpoints.length || !testTargets.length) {
    console.log('[TEST-NERV-SCANNER] No test checkpoints/targets loaded.')
    return
  }

  console.log(`[TEST-NERV-SCANNER] Loaded ${input.sourceName}; checkpoints=${checkpoints.length} targets=${testTargets.length}.`)
  await ensureMaterialsForTargets(bot, config, testTargets)

  let active = true
  let currentGoal = checkpoints[0].position
  let currentAction = checkpoints[0].action
  let placed = 0
  let already = 0
  let skipped = 0
  const processed = new Set()

  const placementLoop = observeBackgroundTask((async () => {
    while (active) {
      const allowPlacement = currentAction === '' || currentAction === 'lineEnd' || currentAction === 'sprint'
      if (allowPlacement) {
        for (let i = 0; i < maxPerTick; i += 1) {
          const target = findNervScannerCandidate(bot, config, targetByXZ, currentGoal, processed)
          if (!target) break

          const key = `${target.position.x}:${target.position.y}:${target.position.z}`
          processed.add(key)

          try {
            const result = await placeNervScannerTarget(bot, config, target)
            if (result.state === 'placed') placed += 1
            else if (result.state === 'already') already += 1
            else {
              skipped += 1
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[TEST-NERV-SCANNER-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
              }
            }
          } catch (err) {
            skipped += 1
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[TEST-NERV-SCANNER-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
            }
          }
        }
      }

      await delay(tickMs)
    }
  })())

  try {
    for (let i = 0; i < checkpoints.length; i += 1) {
      const checkpoint = checkpoints[i]
      currentGoal = checkpoint.position
      currentAction = checkpoint.action
      const sprintMode = String(printer.sprintMode || 'notPlacing').toLowerCase()
      const shouldSprint = sprintMode === 'always' || (sprintMode !== 'off' && currentAction === 'sprint')
      bot.setControlState('sprint', shouldSprint)

      console.log(`[TEST-NERV-SCANNER] Checkpoint ${i + 1}/${checkpoints.length}: ${checkpoint.position.x} ${checkpoint.position.y} ${checkpoint.position.z} action=${checkpoint.action || 'walk'}`)
      await bot.pathfinder.goto(new GoalNear(checkpoint.position.x, checkpoint.position.y, checkpoint.position.z, Math.max(0.5, toNumber(config.advanced?.checkpointBuffer, 0.8))))

      if (checkpoint.action === 'lineEnd') {
        let missing = 0
        for (const target of checkpoint.targets) {
          const actual = bot.blockAt(new bot.entity.position.constructor(target.position.x, target.position.y, target.position.z))
          if (actual?.name !== target.blockName) missing += 1
        }
        console.log(`[TEST-NERV-SCANNER] lineEnd missing=${missing}/${checkpoint.targets.length}`)
      }
    }
  } finally {
    active = false
    await placementLoop
  }

  console.log(`[TEST-NERV-SCANNER] Done. placed=${placed} already=${already} skipped=${skipped} seen=${processed.size}/${testTargets.length}`)
  if (waitAfterMs > 0) {
    console.log(`[TEST-NERV-SCANNER] Waiting ${waitAfterMs}ms before logout.`)
    await delay(waitAfterMs)
  }
}

async function runNervWorkloadTest(bot, config) {
  const printer = config.printer || {}
  const advanced = config.advanced || {}
  const input = await loadTargets(config)
  const calibratedTargets = calibrateTargetsForWorld(bot, input.targets, config)
  const maxGroups = Math.max(1, toNumber(advanced.nervWorkloadTestLineGroups, 2))
  const checkpoints = buildNervScannerCheckpoints(calibratedTargets, config, maxGroups)
  const testTargets = [...new Map(checkpoints.flatMap((cp) => cp.targets).map((target) => [`${target.position.x}:${target.position.y}:${target.position.z}`, target])).values()]
  const targetByXZ = new Map(testTargets.map((target) => [`${target.position.x}:${target.position.z}`, target]))
  const placeDelayMs = Math.max(0, toNumber(advanced.scannerPlaceDelayMs, 0))
  const maxCatchup = Math.max(1, toNumber(advanced.scannerMaxCatchupPlacements, 30))
  const pollMs = Math.max(0, toNumber(advanced.scannerWorkloadPollMs, 0))
  const logEveryMs = Math.max(0, toNumber(advanced.scannerWorkloadLogEveryMs, 1000))
  const retryCooldownMs = Math.max(0, toNumber(advanced.scannerRetryCooldownMs, 30))
  const waitAfterMs = Math.max(0, toNumber(advanced.nervWorkloadTestWaitAfterMs, 5000))

  if (!checkpoints.length || !testTargets.length) {
    console.log('[TEST-NERV-WORKLOAD] No test checkpoints/targets loaded.')
    return
  }

  console.log(`[TEST-NERV-WORKLOAD] Loaded ${input.sourceName}; checkpoints=${checkpoints.length} targets=${testTargets.length} placeDelayMs=${placeDelayMs} maxCatchup=${maxCatchup}.`)
  await ensureMaterialsForTargets(bot, config, testTargets)

  let active = true
  let currentGoal = checkpoints[0].position
  let currentAction = checkpoints[0].action
  let lastTickTime = Date.now()
  let lastLogAt = Date.now()
  let placed = 0
  let already = 0
  let skipped = 0
  let confirmed = 0
  let retried = 0
  let hardStops = 0
  let noCandidateBursts = 0
  let rawAllowedTotal = 0
  let cappedTotal = 0
  let maxAllowedSeen = 0
  const confirmedKeys = new Set()
  const pendingUntil = new Map()

  const targetKey = (target) => `${target.position.x}:${target.position.y}:${target.position.z}`

  const placementLoop = observeBackgroundTask((async () => {
    while (active) {
      const now = Date.now()
      const elapsed = now - lastTickTime
      const rawAllowed = Math.floor(elapsed / placeDelayMs)

      if (rawAllowed <= 0) {
        await delay(pollMs)
        continue
      }

      lastTickTime += rawAllowed * placeDelayMs
      rawAllowedTotal += rawAllowed
      const allowed = Math.min(rawAllowed, maxCatchup)
      cappedTotal += Math.max(0, rawAllowed - allowed)
      maxAllowedSeen = Math.max(maxAllowedSeen, rawAllowed)

      let placedThisBurst = 0
      let skippedThisBurst = 0
      let hardStopThisBurst = false
      const burstExcluded = new Set(confirmedKeys)

      for (const [key, until] of pendingUntil.entries()) {
        if (until > now) burstExcluded.add(key)
        else pendingUntil.delete(key)
      }

      const allowPlacement = currentAction === '' || currentAction === 'lineEnd' || currentAction === 'sprint'
      if (allowPlacement) {
        for (let i = 0; i < allowed; i += 1) {
          const target = findNervScannerCandidate(bot, config, targetByXZ, currentGoal, burstExcluded)
          if (!target) {
            noCandidateBursts += i === 0 ? 1 : 0
            break
          }

          const key = targetKey(target)
          const neededSwap = String(bot.heldItem?.name || '') !== target.blockName
          burstExcluded.add(key)

          try {
            const result = await placeNervScannerTarget(bot, config, target)
            const actual = bot.blockAt(new bot.entity.position.constructor(target.position.x, target.position.y, target.position.z))

            if (actual?.name === target.blockName) {
              if (!confirmedKeys.has(key)) confirmed += 1
              confirmedKeys.add(key)
              pendingUntil.delete(key)
            } else if (result.state === 'placed') {
              pendingUntil.set(key, Date.now() + retryCooldownMs)
            }

            if (result.state === 'placed') {
              placed += 1
              placedThisBurst += 1
              if (pendingUntil.has(key)) retried += 1
            } else if (result.state === 'already') {
              already += 1
              if (!confirmedKeys.has(key)) confirmed += 1
              confirmedKeys.add(key)
            } else {
              skipped += 1
              skippedThisBurst += 1
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[TEST-NERV-WORKLOAD-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
              }

              if (String(result.reason || '').startsWith('missing-item-')) {
                hardStops += 1
                hardStopThisBurst = true
                break
              }
            }
          } catch (err) {
            skipped += 1
            skippedThisBurst += 1
            hardStops += 1
            hardStopThisBurst = true
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[TEST-NERV-WORKLOAD-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
            }
            break
          }

          if (neededSwap) {
            lastTickTime = Date.now()
            hardStopThisBurst = true
            break
          }
        }
      }

      if (logEveryMs > 0 && Date.now() - lastLogAt >= logEveryMs) {
        console.log(`[TEST-NERV-WORKLOAD] elapsed=${elapsed}ms allowed=${allowed}/${rawAllowed} placedBurst=${placedThisBurst} skippedBurst=${skippedThisBurst} hardStop=${hardStopThisBurst} confirmed=${confirmedKeys.size}/${testTargets.length} cappedDebt=${cappedTotal}`)
        lastLogAt = Date.now()
      }

      await delay(pollMs)
    }
  })())

  try {
    for (let i = 0; i < checkpoints.length; i += 1) {
      const checkpoint = checkpoints[i]
      currentGoal = checkpoint.position
      currentAction = checkpoint.action
      const sprintMode = String(printer.sprintMode || 'notPlacing').toLowerCase()
      const shouldSprint = sprintMode === 'always' || (sprintMode !== 'off' && currentAction === 'sprint')
      bot.setControlState('sprint', shouldSprint)

      console.log(`[TEST-NERV-WORKLOAD] Checkpoint ${i + 1}/${checkpoints.length}: ${checkpoint.position.x} ${checkpoint.position.y} ${checkpoint.position.z} action=${checkpoint.action || 'walk'}`)
      await bot.pathfinder.goto(new GoalNear(checkpoint.position.x, checkpoint.position.y, checkpoint.position.z, Math.max(0.5, toNumber(advanced.checkpointBuffer, 0.8))))

      if (checkpoint.action === 'lineEnd') {
        let missing = 0
        for (const target of checkpoint.targets) {
          const actual = bot.blockAt(new bot.entity.position.constructor(target.position.x, target.position.y, target.position.z))
          if (actual?.name !== target.blockName) missing += 1
        }
        console.log(`[TEST-NERV-WORKLOAD] lineEnd missing=${missing}/${checkpoint.targets.length}`)
      }
    }
  } finally {
    active = false
    await placementLoop
  }

  let missing = 0
  for (const target of testTargets) {
    const actual = bot.blockAt(new bot.entity.position.constructor(target.position.x, target.position.y, target.position.z))
    if (actual?.name !== target.blockName) missing += 1
  }

  console.log(`[TEST-NERV-WORKLOAD] Done. placed=${placed} already=${already} skipped=${skipped} confirmed=${confirmedKeys.size}/${testTargets.length} missing=${missing} hardStops=${hardStops} noCandidateBursts=${noCandidateBursts} rawAllowed=${rawAllowedTotal} capped=${cappedTotal} maxAllowed=${maxAllowedSeen}`)
  if (waitAfterMs > 0) {
    console.log(`[TEST-NERV-WORKLOAD] Waiting ${waitAfterMs}ms before logout.`)
    await delay(waitAfterMs)
  }
}

function runSingleNervScannerTestSession(config) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.loadPlugin(pathfinder)

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    let printerStarted = false
    let spawnedCount = 0
    bot.on('spawn', async () => {
      spawnedCount += 1
      if (printerStarted) return

      const reqSpawn = getRequiredSpawnCount(config)
      if (spawnedCount < reqSpawn) {
        console.log(`[SPAWN] Event received (${spawnedCount}/${reqSpawn}). Waiting for more...`)
        return
      }

      console.log(`[SPAWN] Threshold reached (${spawnedCount}/${reqSpawn}). Delaying startup...`)

      const printer = config.printer || {}
      await delay(toNumber(printer.startDelayMs, 1500))

      let attempts = 0
      while (attempts < 20) {
        const p = bot?.entity?.position
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) break
        await delay(500)
        attempts++
      }

      if (!isPlatformNearby(bot, config)) {
        console.log(`[STATE] Bot is not near the mapart platform (spawn ${spawnedCount}). Waiting idle.`)
        return
      }

      printerStarted = true
      const allowJump = printer.allowJump !== false

      console.log('[TEST-NERV-SCANNER] Connected.')

      configurePathfinderMovements(bot, config)

      try {
        await delay(toNumber(printer.startDelayMs, 1500))
        await runNervScannerTest(bot, config)
      } catch (err) {
        console.log('[TEST-NERV-SCANNER-ERROR]', err?.message || err)
      } finally {
        bot.quit('nerv scanner test complete')
        settle()
      }
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${text}`)
    })

    bot.on('error', (err) => {
      console.log('[ERROR]', err?.message || String(err))
    })

    bot.on('end', () => {
      settle()
    })
  })
}

function runSingleNervWorkloadTestSession(config) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.loadPlugin(pathfinder)

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    let printerStarted = false
    let spawnedCount = 0
    bot.on('spawn', async () => {
      spawnedCount += 1
      if (printerStarted) return

      const reqSpawn = getRequiredSpawnCount(config)
      if (spawnedCount < reqSpawn) {
        console.log(`[SPAWN] Event received (${spawnedCount}/${reqSpawn}). Waiting for more...`)
        return
      }

      console.log(`[SPAWN] Threshold reached (${spawnedCount}/${reqSpawn}). Delaying startup...`)

      const printer = config.printer || {}
      await delay(toNumber(printer.startDelayMs, 1500))

      let attempts = 0
      while (attempts < 20) {
        const p = bot?.entity?.position
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) break
        await delay(500)
        attempts++
      }

      if (!isPlatformNearby(bot, config)) {
        console.log(`[STATE] Bot is not near the mapart platform (spawn ${spawnedCount}). Waiting idle.`)
        return
      }

      printerStarted = true
      const allowJump = printer.allowJump !== false

      console.log('[TEST-NERV-WORKLOAD] Connected.')

      configurePathfinderMovements(bot, config)

      try {
        await delay(toNumber(printer.startDelayMs, 1500))
        await runNervWorkloadTest(bot, config)
      } catch (err) {
        console.log('[TEST-NERV-WORKLOAD-ERROR]', err?.message || err)
      } finally {
        bot.quit('nerv workload test complete')
        settle()
      }
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${text}`)
    })

    bot.on('error', (err) => {
      console.log('[ERROR]', err?.message || String(err))
    })

    bot.on('end', () => {
      settle()
    })
  })
}

function formatInventoryPlanMap(map) {
  const entries = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (!entries.length) return 'none'
  return entries.map(([name, count]) => `${name}=${count}`).join(', ')
}

function formatRestockList(restockList) {
  if (!restockList.length) return 'none'
  return restockList
    .map((entry) => `${entry.blockName}=${entry.rawAmount} (${entry.stacks} stacks)`)
    .join(', ')
}

function formatDumpSlots(dumpSlots) {
  if (!dumpSlots.length) return 'none'
  return dumpSlots
    .map((slot) => {
      const stack = slot.stack
      if (!stack) return `slot${slot.slotIndex}=empty`
      return `slot${slot.slotIndex}=${stack.name}x${stack.count}`
    })
    .join(', ')
}

function selectFirstLogicalRows(targets, rowLimit, northToSouth) {
  const limit = Math.max(0, toNumber(rowLimit, 0))
  if (limit <= 0) {
    return { targets, rows: [...new Set(targets.map((target) => target.row))].sort((a, b) => a - b) }
  }

  const rows = [...new Set(targets.map((target) => target.row))].sort((a, b) => northToSouth ? a - b : b - a)
  const selectedRows = new Set(rows.slice(0, limit))
  return {
    targets: targets.filter((target) => selectedRows.has(target.row)),
    rows: [...selectedRows]
  }
}

async function runInventoryPlanTest(bot, config) {
  const input = await loadTargets(config)
  const calibratedTargets = calibrateTargetsForWorld(bot, input.targets, config)
  const printer = config.printer || {}
  const linesPerRun = Math.max(1, toNumber(printer.linesPerRun, 3))
  const northToSouth = printer.northToSouth !== false
  const orderedTargets = orderTargetsLineByLine(calibratedTargets, linesPerRun, northToSouth)
  const rowLimit = Math.max(0, toNumber(config.advanced?.inventoryCycleTestRows, 0))
  const selected = selectFirstLogicalRows(orderedTargets, rowLimit, northToSouth)
  const effective = selectInventoryPlanningTargets(selected.targets, config)
  const planTargets = effective.targets

  if (typeof bot.waitForChunksToLoad === 'function') {
    try {
      await Promise.race([
        bot.waitForChunksToLoad(),
        delay(4000)
      ])
    } catch {
      // Continue with the blocks currently available to the client.
    }
  } else {
    await delay(800)
  }

  if (!planTargets.length) {
    console.log('[TEST-INVENTORY-PLAN] No targets loaded.')
    return
  }

  const plan = buildNervInventoryPlan(bot, config, planTargets)
  const inventoryItems = bot.inventory.items()
    .filter((entry) => String(entry?.name || '').endsWith('_carpet'))
    .map((entry) => `slot${entry.slot}:${entry.name}x${entry.count}`)
    .join(', ') || 'none'

  console.log(`[TEST-INVENTORY-PLAN] Loaded ${input.sourceName}; selectedTargets=${selected.targets.length}/${orderedTargets.length} planTargets=${planTargets.length} linesPerRun=${linesPerRun} selectedRows=${selected.rows.join(',') || 'all'} refillRows=${effective.rows.join(',') || 'none'} materials=${effective.materials.length}/16.`)
  console.log(`[TEST-INVENTORY-PLAN] availableSlots=${plan.availableSlots.length} inspected=${plan.inspected} countedMissing=${plan.counted} unloaded=${plan.unloaded}`)
  console.log(`[TEST-INVENTORY-PLAN] inventoryCarpets=${inventoryItems}`)
  console.log(`[TEST-INVENTORY-PLAN] required=${formatInventoryPlanMap(plan.requiredItems)}`)
  console.log(`[TEST-INVENTORY-PLAN] keep=${formatInventoryPlanMap(plan.materialInInv)}`)
  console.log(`[TEST-INVENTORY-PLAN] dumpSlots=${plan.dumpSlots.length}: ${formatDumpSlots(plan.dumpSlots)}`)
  console.log(`[TEST-INVENTORY-PLAN] restock=${formatRestockList(plan.restockList)}`)
  console.log('[TEST-INVENTORY-PLAN] Dry run only. No items were dumped or restocked.')
}

async function runInventoryCycleTest(bot, config) {
  const input = await loadTargets(config)
  const calibratedTargets = calibrateTargetsForWorld(bot, input.targets, config)
  const printer = config.printer || {}
  const linesPerRun = Math.max(1, toNumber(printer.linesPerRun, 3))
  const northToSouth = printer.northToSouth !== false
  const orderedTargets = orderTargetsLineByLine(calibratedTargets, linesPerRun, northToSouth)
  const rowLimit = Math.max(0, toNumber(config.advanced?.inventoryCycleTestRows, 0))
  const selected = selectFirstLogicalRows(orderedTargets, rowLimit, northToSouth)
  const effective = selectInventoryPlanningTargets(selected.targets, config)
  const cycleTargets = effective.targets
  const waitAfterMs = Math.max(0, toNumber(config.advanced?.inventoryCycleTestWaitAfterMs, 5000))

  if (typeof bot.waitForChunksToLoad === 'function') {
    try {
      await Promise.race([
        bot.waitForChunksToLoad(),
        delay(4000)
      ])
    } catch {
      // Continue with the blocks currently available to the client.
    }
  } else {
    await delay(800)
  }

  if (!cycleTargets.length) {
    console.log('[TEST-INVENTORY-CYCLE] No targets loaded.')
    return
  }

  const beforePlan = buildNervInventoryPlan(bot, config, cycleTargets)
  console.log(`[TEST-INVENTORY-CYCLE] Loaded ${input.sourceName}; selectedTargets=${selected.targets.length}/${orderedTargets.length} cycleTargets=${cycleTargets.length} linesPerRun=${linesPerRun} selectedRows=${selected.rows.join(',') || 'all'} refillRows=${effective.rows.join(',') || 'none'} materials=${effective.materials.length}/16.`)
  console.log(`[TEST-INVENTORY-CYCLE] before required=${formatInventoryPlanMap(beforePlan.requiredItems)}`)
  console.log(`[TEST-INVENTORY-CYCLE] before keep=${formatInventoryPlanMap(beforePlan.materialInInv)}`)
  console.log(`[TEST-INVENTORY-CYCLE] before dumpSlots=${beforePlan.dumpSlots.length}: ${formatDumpSlots(beforePlan.dumpSlots)}`)
  console.log(`[TEST-INVENTORY-CYCLE] before restock=${formatRestockList(beforePlan.restockList)}`)

  await ensureMaterialsForTargets(bot, config, cycleTargets)

  const afterPlan = buildNervInventoryPlan(bot, config, cycleTargets)
  console.log(`[TEST-INVENTORY-CYCLE] after required=${formatInventoryPlanMap(afterPlan.requiredItems)}`)
  console.log(`[TEST-INVENTORY-CYCLE] after keep=${formatInventoryPlanMap(afterPlan.materialInInv)}`)
  console.log(`[TEST-INVENTORY-CYCLE] after dumpSlots=${afterPlan.dumpSlots.length}: ${formatDumpSlots(afterPlan.dumpSlots)}`)
  console.log(`[TEST-INVENTORY-CYCLE] after restock=${formatRestockList(afterPlan.restockList)}`)
  console.log('[TEST-INVENTORY-CYCLE] Done. No placement was attempted.')

  if (waitAfterMs > 0) {
    console.log(`[TEST-INVENTORY-CYCLE] Waiting ${waitAfterMs}ms before logout.`)
    await delay(waitAfterMs)
  }
}

async function runRepairTest(bot, config) {
  const input = await loadTargets(config)
  const calibratedTargets = calibrateTargetsForWorld(bot, input.targets, config)
  const printer = config.printer || {}
  const linesPerRun = Math.max(1, toNumber(printer.linesPerRun, 3))
  const northToSouth = printer.northToSouth !== false
  const orderedTargets = orderTargetsLineByLine(calibratedTargets, linesPerRun, northToSouth)
  const placeRange = Math.max(1, toNumber(printer.placeRange, 4))
  const maxPasses = Math.max(1, toNumber(config.advanced?.repairTestMaxPasses, 3))
  const waitAfterMs = Math.max(0, toNumber(config.advanced?.repairTestWaitAfterMs, 5000))

  if (typeof bot.waitForChunksToLoad === 'function') {
    try {
      await Promise.race([
        bot.waitForChunksToLoad(),
        delay(4000)
      ])
    } catch {
      // Continue with the blocks currently visible to the client.
    }
  } else {
    await delay(800)
  }

  if (!orderedTargets.length) {
    console.log('[TEST-REPAIR] No targets loaded.')
    return
  }

  console.log(`[TEST-REPAIR] Loaded ${input.sourceName}; targets=${orderedTargets.length} linesPerRun=${linesPerRun} maxPasses=${maxPasses}.`)
  let errors = scanPlacementErrors(bot, orderedTargets, {
    config,
    logPrefix: 'TEST-REPAIR-BEFORE',
    logErrors: config.errorHandling?.logErrors !== false,
    maxLogs: toNumber(config.advanced?.repairTestMaxErrorLogs, 80)
  })
  console.log(`[TEST-REPAIR] before mismatches=${errors.length}.`)
  logRepairMismatchWarning(config, errors.length, orderedTargets.length, 'TEST-REPAIR')

  let placed = 0
  let already = 0
  let skipped = 0

  for (let pass = 1; pass <= maxPasses && errors.length > 0; pass += 1) {
    const repairTargetsOnly = errors.map((entry) => entry.target)
    console.log(`[TEST-REPAIR] pass=${pass}/${maxPasses} repairing=${repairTargetsOnly.length}.`)
    const result = await repairTargetsInBatches(bot, config, repairTargetsOnly, placeRange, `TEST-REPAIR-PASS-${pass}`)
    placed += result.placed
    already += result.already
    skipped += result.skipped

    await delay(toNumber(config.advanced?.repairVerifySettleMs, 300))
    errors = scanPlacementErrors(bot, orderedTargets, {
      config,
      logPrefix: `TEST-REPAIR-AFTER-PASS-${pass}`,
      logErrors: config.errorHandling?.logErrors !== false,
      maxLogs: toNumber(config.advanced?.repairTestMaxErrorLogs, 80)
    })
    console.log(`[TEST-REPAIR] pass=${pass} fullScanRemaining=${errors.length}.`)
    if (pass < maxPasses) {
      logRepairMismatchWarning(config, errors.length, orderedTargets.length, `TEST-REPAIR-AFTER-PASS-${pass}`)
    }
  }

  const finalErrors = scanPlacementErrors(bot, orderedTargets, {
    config,
    logPrefix: 'TEST-REPAIR-FINAL',
    logErrors: config.errorHandling?.logErrors !== false,
    maxLogs: toNumber(config.advanced?.repairTestMaxErrorLogs, 80)
  })

  console.log(`[TEST-REPAIR] Done. placed=${placed} already=${already} skipped=${skipped} remaining=${finalErrors.length}.`)

  if (waitAfterMs > 0) {
    console.log(`[TEST-REPAIR] Waiting ${waitAfterMs}ms before logout.`)
    await delay(waitAfterMs)
  }
}

function runSingleInventoryPlanTestSession(config) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.loadPlugin(pathfinder)

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    let printerStarted = false
    let spawnedCount = 0
    bot.on('spawn', async () => {
      spawnedCount += 1
      if (printerStarted) return

      const reqSpawn = getRequiredSpawnCount(config)
      if (spawnedCount < reqSpawn) {
        console.log(`[SPAWN] Event received (${spawnedCount}/${reqSpawn}). Waiting for more...`)
        return
      }

      console.log(`[SPAWN] Threshold reached (${spawnedCount}/${reqSpawn}). Delaying startup...`)

      const printer = config.printer || {}
      await delay(toNumber(printer.startDelayMs, 1500))

      let attempts = 0
      while (attempts < 20) {
        const p = bot?.entity?.position
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) break
        await delay(500)
        attempts++
      }

      if (!isPlatformNearby(bot, config)) {
        console.log(`[STATE] Bot is not near the mapart platform (spawn ${spawnedCount}). Waiting idle.`)
        return
      }

      printerStarted = true

      console.log('[TEST-INVENTORY-PLAN] Connected.')

      try {
        await delay(toNumber(config.printer?.startDelayMs, 1500))
        await runInventoryPlanTest(bot, config)
      } catch (err) {
        console.log('[TEST-INVENTORY-PLAN-ERROR]', err?.message || err)
      } finally {
        bot.quit('inventory plan test complete')
        settle()
      }
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${text}`)
    })

    bot.on('error', (err) => {
      console.log('[ERROR]', err?.message || String(err))
    })

    bot.on('end', () => {
      settle()
    })
  })
}

function runSingleInventoryCycleTestSession(config) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.loadPlugin(pathfinder)

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    let printerStarted = false
    let spawnedCount = 0
    bot.on('spawn', async () => {
      spawnedCount += 1
      if (printerStarted) return

      const reqSpawn = getRequiredSpawnCount(config)
      if (spawnedCount < reqSpawn) {
        console.log(`[SPAWN] Event received (${spawnedCount}/${reqSpawn}). Waiting for more...`)
        return
      }

      console.log(`[SPAWN] Threshold reached (${spawnedCount}/${reqSpawn}). Delaying startup...`)

      const printer = config.printer || {}
      await delay(toNumber(printer.startDelayMs, 1500))

      let attempts = 0
      while (attempts < 20) {
        const p = bot?.entity?.position
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) break
        await delay(500)
        attempts++
      }

      if (!isPlatformNearby(bot, config)) {
        console.log(`[STATE] Bot is not near the mapart platform (spawn ${spawnedCount}). Waiting idle.`)
        return
      }

      printerStarted = true
      const allowJump = printer.allowJump !== false

      console.log('[TEST-INVENTORY-CYCLE] Connected.')

      configurePathfinderMovements(bot, config)

      try {
        await delay(toNumber(config.printer?.startDelayMs, 1500))
        await runInventoryCycleTest(bot, config)
      } catch (err) {
        console.log('[TEST-INVENTORY-CYCLE-ERROR]', err?.message || err)
      } finally {
        bot.quit('inventory cycle test complete')
        settle()
      }
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${text}`)
    })

    bot.on('error', (err) => {
      console.log('[ERROR]', err?.message || String(err))
    })

    bot.on('end', () => {
      settle()
    })
  })
}

function runSingleRepairTestSession(config) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.loadPlugin(pathfinder)

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    let printerStarted = false
    let spawnedCount = 0
    bot.on('spawn', async () => {
      spawnedCount += 1
      if (printerStarted) return

      const reqSpawn = getRequiredSpawnCount(config)
      if (spawnedCount < reqSpawn) {
        console.log(`[SPAWN] Event received (${spawnedCount}/${reqSpawn}). Waiting for more...`)
        return
      }

      console.log(`[SPAWN] Threshold reached (${spawnedCount}/${reqSpawn}). Delaying startup...`)

      const printer = config.printer || {}
      await delay(toNumber(printer.startDelayMs, 1500))

      let attempts = 0
      while (attempts < 20) {
        const p = bot?.entity?.position
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) break
        await delay(500)
        attempts++
      }

      if (!isPlatformNearby(bot, config)) {
        console.log(`[STATE] Bot is not near the mapart platform (spawn ${spawnedCount}). Waiting idle.`)
        return
      }

      printerStarted = true
      const allowJump = printer.allowJump !== false

      console.log('[TEST-REPAIR] Connected.')

      configurePathfinderMovements(bot, config)

      try {
        await delay(toNumber(config.printer?.startDelayMs, 1500))
        await runRepairTest(bot, config)
      } catch (err) {
        console.log('[TEST-REPAIR-ERROR]', err?.message || err)
      } finally {
        bot.quit('repair test complete')
        settle()
      }
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${text}`)
    })

    bot.on('error', (err) => {
      console.log('[ERROR]', err?.message || String(err))
    })

    bot.on('end', () => {
      settle()
    })
  })
}

function getReconnectConfig(config) {
  const reconnect = config?.bot?.reconnect || {}
  return {
    enabled: reconnect.enabled === true,
    delayMs: Math.max(0, toNumber(reconnect.delayMs, 9500)),
    maxAttempts: Math.max(1, toNumber(reconnect.maxAttempts, 5))
  }
}

function is6b6tConfig(config) {
  return config?.connection?.active === '6b6t' || String(config?.bot?.host || '').toLowerCase().includes('6b6t')
}

function get6b6tHosts(config) {
  const configured = Array.isArray(config.bot?.hosts) ? config.bot.hosts : []
  const hosts = uniqueList([
    ...configured,
    config.bot?.host,
    'alt.6b6t.org',
    'alt3.6b6t.org',
    'play.6b6t.org',
    'alt2.6b6t.org'
  ])
  return hosts.length ? hosts : [config.bot?.host || 'alt.6b6t.org']
}

function encodeMcVarInt(value) {
  let remaining = Number(value) >>> 0
  const bytes = []
  do {
    let temp = remaining & 0x7f
    remaining >>>= 7
    if (remaining !== 0) temp |= 0x80
    bytes.push(temp)
  } while (remaining !== 0)
  return Buffer.from(bytes)
}

function readMcVarInt(buffer, offset = 0) {
  let value = 0
  let shift = 0
  for (let i = offset; i < buffer.length && i < offset + 5; i += 1) {
    const byte = buffer[i]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) !== 0x80) {
      return { value, size: i - offset + 1 }
    }
    shift += 7
  }
  return null
}

function encodeMcString(value) {
  const body = Buffer.from(String(value || ''), 'utf8')
  return Buffer.concat([encodeMcVarInt(body.length), body])
}

function encodeMcPacket(packetId, parts = []) {
  const body = Buffer.concat([encodeMcVarInt(packetId), ...parts])
  return Buffer.concat([encodeMcVarInt(body.length), body])
}

function tryDecodeMcPacket(buffer) {
  const lengthInfo = readMcVarInt(buffer, 0)
  if (!lengthInfo) return null
  const totalLength = lengthInfo.size + lengthInfo.value
  if (buffer.length < totalLength) return null
  const body = buffer.subarray(lengthInfo.size, totalLength)
  const idInfo = readMcVarInt(body, 0)
  if (!idInfo) return null
  return {
    packetId: idInfo.value,
    payload: body.subarray(idInfo.size),
    rest: buffer.subarray(totalLength)
  }
}

function decodeMcStringPayload(payload) {
  const lengthInfo = readMcVarInt(payload, 0)
  if (!lengthInfo) return ''
  return payload.subarray(lengthInfo.size, lengthInfo.size + lengthInfo.value).toString('utf8')
}

function connectTcpSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const done = (err) => {
      if (settled) return
      settled = true
      socket.removeAllListeners('connect')
      socket.removeAllListeners('error')
      socket.removeAllListeners('timeout')
      if (err) {
        try { socket.destroy() } catch { }
        reject(err)
      } else {
        resolve(socket)
      }
    }
    socket.setNoDelay(true)
    socket.setTimeout(Math.max(500, timeoutMs))
    socket.once('connect', () => done(null))
    socket.once('error', done)
    socket.once('timeout', () => done(new Error(`status-timeout-${timeoutMs}ms`)))
  })
}

function readMinecraftPacket(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('end', onEnd)
      socket.removeListener('close', onClose)
    }
    const finish = (err, packet) => {
      cleanup()
      if (err) reject(err)
      else resolve(packet)
    }
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const packet = tryDecodeMcPacket(buffer)
      if (packet) finish(null, packet)
    }
    const onError = (err) => finish(err)
    const onEnd = () => finish(new Error('status-socket-ended'))
    const onClose = () => finish(new Error('status-socket-closed'))
    const timer = setTimeout(() => finish(new Error(`status-read-timeout-${timeoutMs}ms`)), Math.max(500, timeoutMs))
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.once('close', onClose)
  })
}

async function queryMinecraftServerStatus(host, port, config) {
  const advanced = config?.advanced || {}
  const timeoutMs = Math.max(500, toNumber(advanced.mcStatusHostSelectionTimeoutMs, 5000))
  const protocolVersion = Math.max(0, toNumber(advanced.mcStatusHostSelectionProtocolVersion, 763))
  const socket = await connectTcpSocket(host, port, timeoutMs)
  const startedAt = Date.now()
  try {
    socket.write(encodeMcPacket(0, [
      encodeMcVarInt(protocolVersion),
      encodeMcString(host),
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      encodeMcVarInt(1)
    ]))
    socket.write(encodeMcPacket(0))
    const statusPacket = await readMinecraftPacket(socket, timeoutMs)
    if (statusPacket.packetId !== 0) throw new Error(`unexpected-status-packet-${statusPacket.packetId}`)
    const statusLatencyMs = Date.now() - startedAt
    const rawJson = decodeMcStringPayload(statusPacket.payload)
    const status = rawJson ? JSON.parse(rawJson) : {}

    const pingPayload = Buffer.alloc(8)
    pingPayload.writeBigInt64BE(BigInt(Date.now()))
    const pingStartedAt = Date.now()
    socket.write(encodeMcPacket(1, [pingPayload]))
    const pongPacket = await readMinecraftPacket(socket, timeoutMs)
    const pongLatencyMs = pongPacket.packetId === 1 ? Date.now() - pingStartedAt : statusLatencyMs
    return {
      host,
      ok: true,
      latencyMs: Math.max(1, Math.round(statusLatencyMs)),
      statusLatencyMs: Math.max(1, Math.round(statusLatencyMs)),
      pongLatencyMs: Math.max(1, Math.round(pongLatencyMs || statusLatencyMs)),
      version: status?.version?.name || 'unknown',
      playersOnline: Number.isFinite(Number(status?.players?.online)) ? Number(status.players.online) : null,
      playersMax: Number.isFinite(Number(status?.players?.max)) ? Number(status.players.max) : null
    }
  } finally {
    try { socket.end() } catch { }
    try { socket.destroy() } catch { }
  }
}

async function chooseBest6b6tHostIndex(config, hosts, fallbackIndex = 0, label = 'runtime') {
  if (!Array.isArray(hosts) || hosts.length <= 1) return Math.max(0, fallbackIndex)
  if (config?.advanced?.mcStatusHostSelectionEnabled === false) return Math.max(0, fallbackIndex)

  const port = toNumber(config?.bot?.port, 25565)
  console.log(`[6B6T-MC-STATUS] ${label}: checking ${hosts.join(', ')} before connecting.`)
  const results = await Promise.all(hosts.map(async (host) => {
    try {
      return await queryMinecraftServerStatus(host, port, config)
    } catch (err) {
      return { host, ok: false, error: err?.message || String(err) }
    }
  }))

  for (const result of results) {
    if (result.ok) {
      const players = result.playersOnline == null ? 'unknown' : `${result.playersOnline}/${result.playersMax ?? '?'}`
      console.log(`[6B6T-MC-STATUS] ${result.host} MC_STATUS=${result.latencyMs}ms PONG=${result.pongLatencyMs}ms VERSION=${result.version} PLAYERS=${players}`)
    } else {
      console.log(`[6B6T-MC-STATUS] ${result.host} FAILED: ${result.error}`)
    }
  }

  const best = results
    .filter((result) => result.ok && Number.isFinite(result.latencyMs))
    .sort((left, right) => left.latencyMs - right.latencyMs)[0]
  if (!best) {
    console.log(`[6B6T-MC-STATUS] ${label}: all checks failed; keeping ${hosts[fallbackIndex] || hosts[0]}.`)
    return Math.max(0, fallbackIndex)
  }

  const bestIndex = Math.max(0, hosts.findIndex((host) => host === best.host))
  console.log(`[6B6T-MC-STATUS] ${label}: selected ${best.host} (${best.latencyMs}ms).`)
  return bestIndex
}

function makeHostConfig(config, host) {
  if (!host) return config
  return {
    ...config,
    bot: {
      ...(config.bot || {}),
      host
    }
  }
}

function getReconnectDelayForSession(session, reconnect) {
  const text = `${session?.endReason || ''} ${session?.lastError || ''} ${session?.kickedReason || ''}`
  if (isDdosProtectionText(text)) return Math.max(31000, toNumber(reconnect.delayMs, 0))
  return reconnect.delayMs
}

async function standbyWaitForReconnect(config) {
  const dashCfg = config?.dashboard || {}
  const serviceUrl = String(dashCfg.serviceUrl || '').replace(/\/$/, '')
  const botName = config?.bot?.username || ''
  const pollMs = toNumber(dashCfg.commandPollMs, 3000)
  if (!serviceUrl || !botName) return false

  console.log(`[STANDBY] Bot disconnected by dashboard. Polling every ${pollMs}ms for reconnect command...`)

  const postStandbyStatus = () => createDashboardRequest(`${serviceUrl}/api/bots/status`, 'POST', {
    botName,
    hostLabel: dashCfg.hostLabel || '',
    runtime: 'nerv-printer',
    online: false,
    phase: 'standby',
    heartbeatAt: new Date().toISOString(),
    lastStatusAt: new Date().toISOString()
  }).catch(() => {})

  await postStandbyStatus()

  while (true) {
    await delay(pollMs)
    await postStandbyStatus()
    try {
      const response = await createDashboardRequest(`${serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands`, 'GET')
      const items = Array.isArray(response.body?.items) ? response.body.items : []
      for (const cmd of items) {
        if (cmd.commandType === 'reconnect') {
          try {
            await createDashboardRequest(`${serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(cmd.commandId)}/claim`, 'POST', {})
            await createDashboardRequest(`${serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(cmd.commandId)}/result`, 'POST', { status: 'succeeded', resultMessage: 'reconnect accepted; restarting session' })
          } catch {}
          console.log('[STANDBY] Reconnect command received. Restarting session...')
          return true
        }
        if (cmd.commandType === 'disconnect') {
          try {
            await createDashboardRequest(`${serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(cmd.commandId)}/claim`, 'POST', {})
            await createDashboardRequest(`${serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(cmd.commandId)}/result`, 'POST', { status: 'succeeded', resultMessage: 'already disconnected; still in standby' })
          } catch {}
        }
      }
    } catch {}
  }
}

function shouldRetryReconnect(session, config) {
  const endReason = String(session?.endReason || '').toLowerCase()
  const lastError = String(session?.lastError || '').toLowerCase()
  const kicked = String(session?.kickedReason || '').toLowerCase()
  const text = `${endReason} ${lastError} ${kicked}`

  if (endReason.includes('dashboard-reset-current-nbt')) {
    return true
  }

  if (config?.bot?.skipReconnectOnModdedKick !== false) {
    if (text.includes('fabric') || text.includes('registry entry namespaces')) {
      console.log('[RECONNECT] Skipped reconnect because server requires unsupported client mods.')
      return false
    }
  }

  const nonRetryHints = [
    'disconnect.quitting',
    'manual disconnect',
    'logged out',
    'already connected',
    'dashboard-disconnect'
  ]
  if (nonRetryHints.some((hint) => text.includes(hint))) {
    return false
  }

  const retryHints = [
    'econnrefused',
    'socketclosed',
    'timed out',
    'timeout',
    'network',
    'endofstream',
    'connect',
    'disconnected'
  ]

  if (retryHints.some((hint) => text.includes(hint))) {
    return true
  }

  // Default to retry when uncertain.
  return true
}

function shouldForceReconnectForPlatformStall(session, config) {
  if (config?.advanced?.platformStallReconnectEnabled === false) return false
  return String(session?.endReason || '').toLowerCase().startsWith('platform-stall-')
}

function shouldForceReconnectForDashboardReset(session) {
  return String(session?.endReason || '').toLowerCase().includes('dashboard-reset-current-nbt')
}

function isDdosProtectionText(value) {
  const text = String(value || '').toLowerCase()
  return text.includes('ddos protection') || text.includes('np ddos') || text.includes('connection blocked') || text.includes('please wait 30s') || text.includes('blocked (')
}

function isTokenVerificationText(value) {
  const text = String(value || '').toLowerCase()
  return (
    text.includes('https://6b6t.org/verify') ||
    text.includes('verification code') ||
    text.includes('vpn/proxy') ||
    (text.includes('verify') && (
      text.includes('token') ||
      text.includes('website') ||
      text.includes('browser') ||
      text.includes('captcha') ||
      text.includes('6b6t')
    ))
  )
}

function extractVerificationCode(value) {
  const text = String(value || '')
  try {
    const payload = JSON.parse(text)
    const parts = []
    const collectTextParts = (node) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.text === 'string') {
        parts.push({
          text: node.text,
          color: typeof node.color === 'string' ? node.color : ''
        })
      }
      if (Array.isArray(node.extra)) {
        for (const child of node.extra) collectTextParts(child)
      }
      if (node.value && typeof node.value === 'object') {
        collectTextParts(node.value)
      }
    }
    collectTextParts(payload)

    for (let i = 0; i < parts.length; i += 1) {
      if (!/verification code/i.test(parts[i].text || '')) continue
      for (let j = i + 1; j < parts.length; j += 1) {
        const code = String(parts[j].text || '').trim().match(/^[A-Z0-9]{4,12}$/i)
        if (code) return code[0].toUpperCase()
      }
    }

    const whiteCode = parts
      .map((part) => ({ ...part, text: String(part.text || '').trim() }))
      .find((part) => part.color.toLowerCase() === 'white' && /^[A-Z0-9]{4,12}$/i.test(part.text))
    if (whiteCode) return whiteCode.text.toUpperCase()
  } catch { }

  const labeled = text.match(/verification code:\s*([A-Z0-9]{4,12})/i)
  if (labeled) return labeled[1].toUpperCase()

  const jsonWhiteText = [...text.matchAll(/"color"\s*:\s*"white"\s*,\s*"text"\s*:\s*"([A-Z0-9]{4,12})"/gi)]
  if (jsonWhiteText.length) return jsonWhiteText[jsonWhiteText.length - 1][1].toUpperCase()

  const ignored = new Set(['COLOR', 'WHITE', 'YELLOW', 'GRAY', 'EXTRA', 'VALUE', 'STRING', 'TEXT'])
  const loose = [...text.matchAll(/\b([A-Z0-9]{5,8})\b/gi)]
    .map((match) => match[1].toUpperCase())
    .find((match) => !ignored.has(match))
  return loose || ''
}

function createStdinLineReader() {
  const readline = require('readline')
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
}

function setRuntimeCommandStatus(nextStatus) {
  if (!nextStatus || typeof nextStatus !== 'object') return
  stdinCommandState.status = {
    ...(stdinCommandState.status || {}),
    ...nextStatus,
    updatedAt: Date.now()
  }
}

function clearRuntimeCommandStatus() {
  stdinCommandState.status = null
}

function formatRuntimeCommandStatus() {
  const status = stdinCommandState.status
  if (!status) return 'no active runtime status yet.'
  const updatedAgoMs = Math.max(0, Date.now() - toNumber(status.updatedAt, Date.now()))
  const updatedAgoSeconds = Math.round(updatedAgoMs / 1000)
  return [
    `phase=${status.phase || 'unknown'}`,
    `account=${status.account || 'unknown'}`,
    `host=${status.host || 'unknown'}`,
    `version=${status.version || 'unknown'}`,
    `session=${status.sessionNumber ?? 'unknown'}`,
    `control=${status.controlState || 'unknown'}`,
    `source=${status.controlSource || 'none'}`,
    `tokenWaiting=${status.tokenWaiting === true}`,
    `code=${status.verificationCode || 'none'}`,
    `updated=${updatedAgoSeconds}s-ago`
  ].join(' ')
}

function ensureStdinCommandInterface() {
  if (stdinCommandState.initialized) return stdinCommandState.rl
  stdinCommandState.initialized = true

  if (!process.stdin || typeof process.stdin.on !== 'function' || process.stdin.isTTY === false) {
    console.log('[COMMAND] Interactive stdin is not available; terminal commands are disabled for this run.')
    return null
  }

  const rl = createStdinLineReader()
  stdinCommandState.rl = rl

  rl.on('line', (line) => {
    const value = String(line || '').trim().toLowerCase()
    if (!value) return

    if (value === 'status') {
      console.log(`[COMMAND] ${formatRuntimeCommandStatus()}`)
      return
    }

    if (value === 'help' || value === '?') {
      console.log('[COMMAND] Commands: status, start, pause, stop, reset, verified, refresh, clear')
      return
    }

    if (value === 'start' || value === 'run') {
      if (!stdinCommandState.runtimeControl) {
        console.log('[COMMAND] No managed runtime is active. Use --wait-for-command or enable dashboard control first.')
        return
      }
      printingIntentActive = true
      console.log(`[COMMAND] ${stdinCommandState.runtimeControl.requestStart('terminal')}`)
      return
    }

    if (value === 'stop' || value === 'hold' || value === 'pause') {
      if (!stdinCommandState.runtimeControl) {
        console.log('[COMMAND] No managed runtime is active. Use --wait-for-command or enable dashboard control first.')
        return
      }
      printingIntentActive = false
      console.log(`[COMMAND] ${stdinCommandState.runtimeControl.requestStop('terminal')}`)
      return
    }

    if (value === 'reset' || value === 'reset-current-nbt' || value === 'reset-nbt') {
      if (typeof stdinCommandState.resetCurrentNbt !== 'function') {
        console.log('[COMMAND] No managed runtime is active. Reset current NBT is only available while the bot is connected under dashboard/command control.')
        return
      }
      printingIntentActive = true
      void stdinCommandState.resetCurrentNbt('terminal')
        .then((message) => console.log(`[COMMAND] ${message}`))
        .catch((err) => console.log(`[COMMAND] reset-current-nbt failed: ${err?.message || err}`))
      return
    }

    if (value === 'clear') {
      console.log('[COMMAND] Nothing queued. Verification commands are only accepted during the active token prompt.')
      return
    }

    const verificationAction = (value === 'verified' || value === 'verify' || value === 'done')
      ? 'verified'
      : ((value === 'refresh' || value === 'retry') ? 'refresh' : '')

    if (!verificationAction) {
      if (stdinCommandState.verificationWaiter) {
        console.log('[VERIFY] Waiting. Type "verified" after website verification, or "refresh" for a new code.')
      }
      return
    }

    if (stdinCommandState.verificationWaiter) {
      const waiter = stdinCommandState.verificationWaiter
      stdinCommandState.verificationWaiter = null
      waiter(verificationAction)
      return
    }

    console.log('[COMMAND] No active token verification prompt right now. This does not apply to Microsoft browser login.')
  })

  console.log('[COMMAND] Interactive commands enabled. Type "status", "start", "stop", "reset", "verified", or "refresh" while the bot is running.')
  return rl
}

function waitForVerificationInput({ account, host, version, code }) {
  const verifyUrl = 'https://6b6t.org/verify'
  console.log(`[VERIFY-CODE] ${account || 'unknown-account'} -> ${code || 'unknown-code'}`)
  console.log(`[VERIFY] account=${account} host=${host} version=${version} code=${code || 'unknown'} url=${verifyUrl}`)
  console.log('[VERIFY] Waiting. Type "verified" after completing verification, or "refresh" to request a new code.')

  return new Promise((resolve) => {
    ensureStdinCommandInterface()
    stdinCommandState.verificationWaiter = (value) => {
      resolve(value)
    }
  })
}

async function resolveTokenVerificationSession({
  session,
  account,
  host,
  version,
  sessionNumber,
  rerun,
  retryDelayMs = 3000,
  config = null
}) {
  let current = session
  setRuntimeCommandStatus({
    phase: current?.tokenVerification ? 'token-verification' : 'running',
    account,
    host,
    version,
    sessionNumber,
    tokenWaiting: current?.tokenVerification === true,
    verificationCode: current?.verificationCode || ''
  })
  while (current?.tokenVerification) {
    setRuntimeCommandStatus({
      phase: 'token-verification',
      account,
      host,
      version,
      sessionNumber,
      tokenWaiting: true,
      verificationCode: current?.verificationCode || ''
    })

    const dashCfg = config ? getDashboardConfig(config) : null
    let verifyHeartbeatTimer = null
    if (dashCfg?.enabled && dashCfg.serviceUrl) {
      const botName = String(config?.bot?.username || config?.bot?.name || account || 'unnamed-bot').trim()
      const verifyCode = current.verificationCode || null
      const postVerifyStatus = () => {
        createDashboardRequest(`${dashCfg.serviceUrl}/api/bots/status`, 'POST', {
          botName,
          runtime: 'nerv-printer',
          hostLabel: dashCfg.hostLabel,
          online: false,
          phase: 'token-verification',
          health: 20,
          hunger: 20,
          activeState: 'active',
          location: 'unknown',
          idle: false,
          heartbeatAt: new Date().toISOString(),
          role: String(config?.multiUser?.runtime?.role || 'single').toLowerCase() || 'single',
          recoveryState: 'none',
          reconnectState: 'idle',
          currentNbt: null,
          lastStatusAt: new Date().toISOString(),
          verificationCode: verifyCode,
          tokenWaiting: true
        }).catch(() => {})
      }
      const pollVerifyCommands = () => {
        if (!stdinCommandState.verificationWaiter) return
        createDashboardRequest(`${dashCfg.serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands`, 'GET')
          .then((res) => {
            const items = Array.isArray(res.body?.items) ? res.body.items : []
            const verifyCmd = items.find((item) => item.commandType === 'verify' && (item.status === 'pending' || item.status === 'claimed'))
            if (!verifyCmd || !stdinCommandState.verificationWaiter) return
            const verifyAction = String(verifyCmd.reason || '').toLowerCase() === 'verified' ? 'verified' : 'refresh'
            createDashboardRequest(`${dashCfg.serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(verifyCmd.commandId)}/claim`, 'POST', {}).catch(() => {})
            createDashboardRequest(`${dashCfg.serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(verifyCmd.commandId)}/result`, 'POST', { status: 'succeeded', resultMessage: `verification action=${verifyAction} applied` }).catch(() => {})
            const waiter = stdinCommandState.verificationWaiter
            stdinCommandState.verificationWaiter = null
            waiter(verifyAction)
          })
          .catch(() => {})
      }
      postVerifyStatus()
      verifyHeartbeatTimer = setInterval(() => {
        postVerifyStatus()
        pollVerifyCommands()
      }, Math.max(3000, dashCfg.commandPollMs))
      verifyHeartbeatTimer.unref?.()
    }

    const action = await waitForVerificationInput({ account, host, version, code: current.verificationCode })

    if (verifyHeartbeatTimer) clearInterval(verifyHeartbeatTimer)

    console.log(action === 'verified'
      ? `[VERIFY] account=${account} marked verified; retrying the same session.`
      : `[VERIFY] account=${account} requested a fresh code; retrying the same session.`
    )
    setRuntimeCommandStatus({
      phase: action === 'verified' ? 'retrying-after-verify' : 'retrying-after-refresh',
      account,
      host,
      version,
      sessionNumber,
      tokenWaiting: false,
      verificationCode: current?.verificationCode || ''
    })
    await delay(Math.max(1000, toNumber(getCliValue('--verify-retry-ms'), retryDelayMs)))
    current = await rerun(action)
    if (action === 'verified' && current?.tokenVerification) {
      console.log(`[VERIFY] account=${account} still requires verification after retry; waiting for input again.`)
    }
  }
  setRuntimeCommandStatus({
    phase: current?.successfulStartup ? 'running' : 'reconnect-loop',
    account,
    host,
    version,
    sessionNumber,
    tokenWaiting: false,
    verificationCode: current?.verificationCode || ''
  })
  return current
}

function getRequiredSpawnCount(config) {
  return toNumber(config.bot?.requiredSpawnCountBeforeStartup, is6b6tConfig(config) ? 3 : 1)
}

function getTransferWaitReconnectMs(config) {
  return Math.max(1000, toNumber(config.bot?.requiredSpawnFallbackSeconds, 25) * 1000)
}

function getLobbyPortalMaxSessionRuns(config) {
  const explicit = toNumber(getLobbyPortalConfig(config)?.maxSessionRuns, NaN)
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  return isOfflineAuthConfig(config) ? 4 : 2
}

function getPlatformBounds(config) {
  const mapCorner = config.machine?.mapCorner
  if (!mapCorner || !Number.isFinite(mapCorner.x) || !Number.isFinite(mapCorner.z)) {
    return null
  }
  const cx = toNumber(mapCorner.x, 0)
  const cz = toNumber(mapCorner.z, 0)
  const mw = toNumber(config.machine?.mapSize?.width, 128)
  const mh = toNumber(config.machine?.mapSize?.height, 128)

  return {
    minX: Math.min(cx, cx + mw, cx - mw) - 30,
    maxX: Math.max(cx, cx + mw, cx - mw) + 30,
    minZ: Math.min(cz, cz + mh, cz - mh) - 30,
    maxZ: Math.max(cz, cz + mh, cz - mh) + 30
  }
}

function getPlatformWaterLayerY(config, targets = null) {
  const explicit = toNumber(config.advanced?.platformWaterLayerY, NaN)
  if (Number.isFinite(explicit)) return Math.floor(explicit)
  if (Array.isArray(targets) && targets.length) {
    const counts = new Map()
    for (const target of targets) {
      const y = Math.floor(toNumber(target?.position?.y, NaN))
      if (!Number.isFinite(y)) continue
      counts.set(y, (counts.get(y) || 0) + 1)
    }
    const common = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]
    if (common) return common[0]
  }
  const offsets = getPrintOffsets(config)
  return Math.floor(toNumber(config.machine?.mapCorner?.y, 64) + offsets.y)
}

function getPlatformWaterScanBounds(config, targets = null) {
  const y = getPlatformWaterLayerY(config, targets)
  if (config.advanced?.platformWaterUseTargetBounds === true && Array.isArray(targets) && targets.length) {
    const xs = targets.map((target) => toNumber(target?.position?.x, NaN)).filter(Number.isFinite)
    const zs = targets.map((target) => toNumber(target?.position?.z, NaN)).filter(Number.isFinite)
    if (xs.length && zs.length) {
      return {
        y,
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minZ: Math.min(...zs),
        maxZ: Math.max(...zs)
      }
    }
  }
  const mapCorner = config.machine?.mapCorner
  if (!mapCorner || !Number.isFinite(mapCorner.x) || !Number.isFinite(mapCorner.z)) return null
  const offsets = getPrintOffsets(config)
  const minX = Math.floor(toNumber(mapCorner.x, 0) + offsets.x)
  const minZ = Math.floor(toNumber(mapCorner.z, 0) + offsets.z)
  const width = Math.max(1, toNumber(config.machine?.mapSize?.width, 128))
  const height = Math.max(1, toNumber(config.machine?.mapSize?.height, 128))
  return {
    y,
    minX,
    maxX: minX + width - 1,
    minZ,
    maxZ: minZ + height - 1
  }
}

function isWaterBlockName(name) {
  const text = String(name || '').toLowerCase()
  return text === 'water' || text === 'flowing_water' || text.includes('water')
}

function scanPlatformWater(bot, config, targets = null, maxFinds = 12) {
  if (config.advanced?.platformWaterGuardEnabled === false) {
    return { water: [], bounds: null }
  }
  const bounds = getPlatformWaterScanBounds(config, targets)
  if (!bounds) return { water: [], bounds: null }
  const Vec3 = bot.entity.position.constructor
  const water = []
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      const block = bot.blockAt(new Vec3(x, bounds.y, z))
      if (isWaterBlockName(block?.name)) {
        water.push({ x, y: bounds.y, z, name: block.name })
        if (water.length >= maxFinds) return { water, bounds }
      }
    }
  }
  return { water, bounds }
}

async function waitForPlatformWaterClear(bot, config, targets = null, reason = 'platform-water-check', options = {}) {
  if (config.advanced?.platformWaterGuardEnabled === false) return
  if (bot.__nervPlatformWaterHoldPromise) return bot.__nervPlatformWaterHoldPromise
  const checkIntervalMs = Math.max(1000, toNumber(config.advanced?.platformWaterCheckIntervalMs, 30000))
  if (options.force !== true && toNumber(bot.__nervPlatformWaterLastClearAt, 0) > 0 && Date.now() - bot.__nervPlatformWaterLastClearAt < checkIntervalMs) {
    return
  }

  const initial = scanPlatformWater(bot, config, targets, 12)
  if (!initial.water.length) {
    bot.__nervPlatformWaterLastClearAt = Date.now()
    clearDashboardAlert(config, 'platform-water')
    return
  }

  bot.__nervPlatformWaterHoldPromise = (async () => {
    const pollMs = Math.max(1000, toNumber(config.advanced?.platformWaterPollMs, 10000))
    const alertAfterMs = Math.max(1000, toNumber(config.advanced?.platformWaterAlertAfterMs, 150000))
    const clearStableMs = Math.max(1000, toNumber(config.advanced?.platformWaterClearStableMs, 15000))
    const logMs = Math.max(5000, toNumber(config.advanced?.platformWaterLogMs, 30000))
    const startedAt = Date.now()
    let lastLog = 0
    let clearSince = 0
    let alertSent = false

    stopBotMovement(bot)
    closeCurrentWindowIfOpen(bot, reason)
    bot.__nervPlatformWaterHoldActive = true
    config?.__dashboardRuntime?.setPhase?.('cleanup', 'water-on-platform-hold')
    const initialMessage = `Water on platform layer y=${initial.bounds?.y ?? 'unknown'}; waiting for real player cleanup`
    setDashboardAlert(config, 'platform-water', initialMessage, {
      reason,
      y: initial.bounds?.y ?? null,
      sample: initial.water.slice(0, 12),
      elapsedMs: 0
    }, 'critical')
    reportDashboardWarning(config, 'platform-water', initialMessage, {
      reason,
      y: initial.bounds?.y ?? null,
      sample: initial.water.slice(0, 12)
    })
    alertSent = true
    console.log(`[PLATFORM-WATER-HOLD] Paused ${reason}; water found on carpet layer y=${initial.bounds?.y ?? 'unknown'} at ${initial.water.slice(0, 4).map((pos) => `${pos.x},${pos.y},${pos.z}`).join(' ')}`)

    while (bot?._client && bot._client.state !== 'disconnected' && bot.__nervSessionActive !== false) {
      assertRuntimeContinue(bot, config, 'stopping-during-platform-water-hold')
      stopBotMovement(bot)
      const scan = scanPlatformWater(bot, config, targets, 12)
      const now = Date.now()
      if (!scan.water.length) {
        if (!clearSince) {
          clearSince = now
          console.log(`[PLATFORM-WATER-HOLD] Water cleared on carpet layer; waiting ${Math.round(clearStableMs / 1000)}s stable before resume.`)
        }
        if (now - clearSince >= clearStableMs) {
          bot.__nervPlatformWaterLastClearAt = Date.now()
          clearDashboardAlert(config, 'platform-water')
          config?.__dashboardRuntime?.setStatusDetail?.('water-clear-resuming')
          console.log('[PLATFORM-WATER-HOLD] Platform layer stayed clear. Resuming print.')
          return
        }
      } else {
        clearSince = 0
        if (!alertSent && now - startedAt >= alertAfterMs) {
          alertSent = true
          const message = `Water on platform layer y=${scan.bounds?.y ?? 'unknown'}; waiting for real player cleanup`
          setDashboardAlert(config, 'platform-water', message, {
            reason,
            y: scan.bounds?.y ?? null,
            sample: scan.water.slice(0, 12),
            elapsedMs: now - startedAt
          }, 'critical')
          reportDashboardWarning(config, 'platform-water', message, {
            reason,
            y: scan.bounds?.y ?? null,
            sample: scan.water.slice(0, 12)
          })
        }
        if (now - lastLog >= logMs) {
          console.log(`[PLATFORM-WATER-HOLD] Still waiting; water=${scan.water.length}+ layerY=${scan.bounds?.y ?? 'unknown'} sample=${scan.water.slice(0, 4).map((pos) => `${pos.x},${pos.y},${pos.z}`).join(' ')}`)
          lastLog = now
        }
      }
      await delay(pollMs)
    }
  })()

  try {
    await bot.__nervPlatformWaterHoldPromise
  } finally {
    bot.__nervPlatformWaterHoldActive = false
    bot.__nervPlatformWaterHoldPromise = null
  }
}

function isPositionUsable(pos) {
  return pos && Number.isFinite(pos.x) && Number.isFinite(pos.z) && (Math.abs(pos.x) > 1 || Math.abs(pos.z) > 1)
}

function isPositionMissing(pos) {
  return !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)
}

function formatBotPosition(bot) {
  const pos = bot?.entity?.position
  if (!pos) return 'x=null y=null z=null'
  const fmt = (value) => Number.isFinite(value) ? Number(value).toFixed(2) : 'null'
  return `x=${fmt(pos.x)} y=${fmt(pos.y)} z=${fmt(pos.z)}`
}

function isPositionInsidePlatformBounds(pos, config) {
  const bounds = getPlatformBounds(config)
  if (!bounds) return true
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return false
  return pos.x >= bounds.minX && pos.x <= bounds.maxX && pos.z >= bounds.minZ && pos.z <= bounds.maxZ
}

function isBotOnOrAroundPlatform(bot, config, reason = 'platform-ready-check') {
  if (getPlatformBounds(config) == null) return true
  const runtime = classifyRuntimePosition(bot, config, reason)
  if (runtime?.classification?.platform === true) return true
  const pos = bot?.entity?.position
  return isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config)
}

function getPlatformSeedPosition(config) {
  const mapCorner = config.machine?.mapCorner
  if (Number.isFinite(mapCorner?.x) && Number.isFinite(mapCorner?.y) && Number.isFinite(mapCorner?.z)) {
    return {
      x: Number(mapCorner.x) + 0.5,
      y: Number(mapCorner.y),
      z: Number(mapCorner.z) + 0.5
    }
  }

  const targetAnchor = config.anchorTranslation?.targetAnchor
  if (Number.isFinite(targetAnchor?.x) && Number.isFinite(targetAnchor?.y) && Number.isFinite(targetAnchor?.z)) {
    return {
      x: Number(targetAnchor.x) + 0.5,
      y: Number(targetAnchor.y),
      z: Number(targetAnchor.z) + 0.5
    }
  }

  const bounds = getPlatformBounds(config)
  if (bounds) {
    return {
      x: (bounds.minX + bounds.maxX) / 2,
      y: toNumber(config.machine?.mapCorner?.y, toNumber(config.anchorTranslation?.targetAnchor?.y, 64)),
      z: (bounds.minZ + bounds.maxZ) / 2
    }
  }

  return null
}

function seedBotPositionFromPlatform(bot, config, reason = 'position-seed') {
  if (config.bot?.seedPositionFromPlatformOnSpawn === false) return false
  const seed = getPlatformSeedPosition(config)
  return seedBotPosition(bot, seed, `${reason}: seeded internal Mineflayer position to ${seed?.x?.toFixed?.(1) ?? seed?.x},${seed?.y?.toFixed?.(1) ?? seed?.y},${seed?.z?.toFixed?.(1) ?? seed?.z} from platform config.`)
}

function seedBotPosition(bot, seed, reason = 'position-seed', options = {}) {
  if (!seed || !bot?.entity?.position) return false
  if (!Number.isFinite(seed.x) || !Number.isFinite(seed.y) || !Number.isFinite(seed.z)) return false

  try {
    if (typeof bot.entity.position.set === 'function') {
      bot.entity.position.set(seed.x, seed.y, seed.z)
    } else {
      bot.entity.position.x = seed.x
      bot.entity.position.y = seed.y
      bot.entity.position.z = seed.z
    }
    if (bot.entity.velocity && typeof bot.entity.velocity.set === 'function') {
      bot.entity.velocity.set(0, 0, 0)
    }
    if (options.log !== false) {
      console.log(`[POSITION-SEED] ${reason}`)
    }
    return true
  } catch (err) {
    console.log(`[POSITION-SEED-WARN] Could not seed internal position: ${err?.message || err}`)
    return false
  }
}

function rescueBotPositionFromPlatformCache(bot, config, source = 'position-cache', options = {}) {
  if (!isPlatformPositionCacheEnabled(config)) return false
  if (!isPositionMissing(bot?.entity?.position)) return false
  const cached = bot?.__nervLastPlatformPosition
  if (!cached || !Number.isFinite(cached.x) || !Number.isFinite(cached.y) || !Number.isFinite(cached.z)) return false
  if (!isPositionInsidePlatformBounds(cached, config)) return false
  const maxAgeMs = Math.max(15000, toNumber(config.bot?.platformPositionCacheMaxAgeMs, 120000))
  const ageMs = Date.now() - toNumber(cached.at, 0)
  if (ageMs > maxAgeMs) return false
  const restored = { x: cached.x, y: cached.y, z: cached.z }
  if (!seedBotPosition(bot, restored, `${source}: restored Mineflayer position from cached platform coord ${restored.x.toFixed(1)},${restored.y.toFixed(1)},${restored.z.toFixed(1)} ageMs=${ageMs}`, { log: options.log !== false })) return false
  if (options.log !== false) {
    console.log(`[POSITION-RESCUE] Restored null platform position from cached ${cached.source || 'unknown'} coord.`)
  }
  return true
}

function cloneFinitePosition(pos) {
  if (isPositionMissing(pos)) return null
  return {
    x: Number(pos.x),
    y: Number(pos.y),
    z: Number(pos.z)
  }
}

function hasInvalidVector(vec) {
  if (!vec) return false
  return !Number.isFinite(vec.x) || !Number.isFinite(vec.y) || !Number.isFinite(vec.z)
}

function repairInvalidEntityVelocity(bot, reason = 'velocity-repair', options = {}) {
  const velocity = bot?.entity?.velocity
  if (!hasInvalidVector(velocity)) return false
  try {
    if (typeof velocity?.set === 'function') velocity.set(0, 0, 0)
    else if (velocity) {
      velocity.x = 0
      velocity.y = 0
      velocity.z = 0
    } else {
      return false
    }
    if (options.log === true) {
      console.log(`[VELOCITY-RESCUE] ${reason}: reset invalid velocity to 0,0,0.`)
    }
    return true
  } catch (err) {
    console.log(`[VELOCITY-RESCUE-WARN] ${reason}: could not reset invalid velocity: ${err?.message || err}`)
    return false
  }
}

function getPhysicsProbePacketMaxAgeMs(config) {
  return Math.max(1000, toNumber(config.bot?.physicsRepairPacketMaxAgeMs, toNumber(config.bot?.physicsTestPacketMaxAgeMs, 15000)))
}

function rescueBotPositionFromLatestPacket(bot, config, source = 'position-packet', options = {}) {
  if (!isPositionMissing(bot?.entity?.position)) return false
  const state = bot?.__nervPhysicsProbe
  const packetPos = cloneFinitePosition(state?.lastPacketPosition)
  if (!packetPos) return false
  const ageMs = Date.now() - toNumber(state?.lastPacketAt, 0)
  if (ageMs > getPhysicsProbePacketMaxAgeMs(config)) return false
  const packetName = state?.lastPacketName || 'position'
  if (!seedBotPosition(bot, packetPos, `${source}: restored Mineflayer position from latest ${packetName} packet ${packetPos.x.toFixed(1)},${packetPos.y.toFixed(1)},${packetPos.z.toFixed(1)} ageMs=${ageMs}`, { log: options.log !== false })) return false
  if (options.log !== false) {
    console.log(`[POSITION-RESCUE] Restored null position from latest ${packetName} packet.`)
  }
  return true
}

function ensureUsableEntityState(bot, config, reason = 'entity-state', options = {}) {
  repairInvalidEntityVelocity(bot, reason, { log: options.log === true })
  if (!isPositionMissing(bot?.entity?.position)) return true
  if (rescueBotPositionFromLatestPacket(bot, config || {}, reason, { log: options.log === true })) return true
  if (config && isPlatformPositionCacheEnabled(config) && rescueBotPositionFromPlatformCache(bot, config, reason, { log: options.log === true })) return true
  if (config && options.allowPlatformSeed === true && seedBotPositionFromPlatform(bot, config, reason)) return true
  return !isPositionMissing(bot?.entity?.position)
}

function formatVec3ForLog(vec) {
  if (!vec) return 'x=null y=null z=null'
  const fmt = (value) => Number.isFinite(value) ? Number(value).toFixed(3) : 'NaN'
  return `x=${fmt(vec.x)} y=${fmt(vec.y)} z=${fmt(vec.z)}`
}

function installPhysicsNaNProbe(bot, config, label = 'physics-test', options = {}) {
  const logPackets = options.logPackets !== false
  const logRepairs = options.logRepairs !== false
  bot.__nervPhysicsProbe = {
    label,
    packetPositions: 0,
    positionRepairs: 0,
    velocityRepairs: 0,
    lastPacketPosition: null,
    lastPacketName: '',
    lastPacketAt: 0,
    lastRepairAt: 0
  }

  const recordPacket = (packetName, packet) => {
    if (!packet || !Number.isFinite(packet.x) || !Number.isFinite(packet.y) || !Number.isFinite(packet.z)) return
    const pos = { x: Number(packet.x), y: Number(packet.y), z: Number(packet.z) }
    bot.__nervPhysicsProbe.packetPositions += 1
    bot.__nervPhysicsProbe.lastPacketPosition = pos
    bot.__nervPhysicsProbe.lastPacketName = packetName
    bot.__nervPhysicsProbe.lastPacketAt = Date.now()
    if (logPackets) {
      console.log(`[PHYSICS-PACKET] ${label} ${packetName} pos=${formatVec3ForLog(pos)} entity=${formatBotPosition(bot)} vel=${formatVec3ForLog(bot?.entity?.velocity)}`)
    }
  }

  for (const packetName of ['position', 'position_look']) {
    bot._client?.on(packetName, (packet) => recordPacket(packetName, packet))
  }

  bot.on('physicsTick', () => {
    const state = bot.__nervPhysicsProbe
    if (!state) return

    const velocity = bot?.entity?.velocity
    if (hasInvalidVector(velocity)) {
      state.velocityRepairs += 1
      try {
        if (typeof velocity.set === 'function') velocity.set(0, 0, 0)
        else {
          velocity.x = 0
          velocity.y = 0
          velocity.z = 0
        }
        if (logRepairs) {
          console.log(`[PHYSICS-FIX] ${label} reset invalid velocity repair=${state.velocityRepairs}`)
        }
      } catch (err) {
        console.log(`[PHYSICS-FIX-WARN] ${label} could not reset invalid velocity: ${err?.message || err}`)
      }
    }

    const pos = bot?.entity?.position
    if (!isPositionMissing(pos)) return
    const repairNo = state.positionRepairs + 1
    const repaired = rescueBotPositionFromLatestPacket(bot, config, `physics-test:${label}: repaired invalid entity position repair=${repairNo}`, { log: false })
    if (!repaired) return
    state.positionRepairs = repairNo
    state.lastRepairAt = Date.now()
    if (logRepairs) {
      console.log(`[PHYSICS-FIX] ${label} repaired invalid entity position from latest ${state.lastPacketName || 'position'} packet repair=${state.positionRepairs}`)
    }
  })

  return bot.__nervPhysicsProbe
}

function isPlatformNearby(bot, config) {
  const bounds = getPlatformBounds(config)
  if (!bounds) {
    return true
  }

  const botPos = bot?.entity?.position
  if (!botPos || !Number.isFinite(botPos.x) || !Number.isFinite(botPos.z)) {
    console.log(`[STATE] Platform check strictly failed because coordinate data is completely missing or NaN. botPos=${JSON.stringify(botPos)}`)
    return false
  }

  if (!isPositionInsidePlatformBounds(botPos, config)) {
    console.log(`[STATE] Bot is at X:${Math.round(botPos.x)} Z:${Math.round(botPos.z)} which is too far from platform bounds X(${Math.round(bounds.minX)} to ${Math.round(bounds.maxX)}) Z(${Math.round(bounds.minZ)} to ${Math.round(bounds.maxZ)}).`)
    return false
  }
  return true
}

function stopBotMovement(bot) {
  for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
    try { bot.setControlState(control, false) } catch { }
  }
  try { bot.pathfinder?.stop?.() } catch { }
  try { bot.pathfinder?.setGoal?.(null) } catch { }
}

function getLobbyPortalConfig(config) {
  return config?.bot?.lobbyPortal || config?.lobbyPortal || null
}

function isLobbyPortalEnabled(config) {
  const portal = getLobbyPortalConfig(config)
  return portal?.enabled === true
}

function blockPosFromConfig(value) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y)) || !Number.isFinite(Number(value.z))) {
    return null
  }
  return {
    x: Number(value.x),
    y: Number(value.y),
    z: Number(value.z)
  }
}

function distance2d(a, x, z) {
  if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.z)) return Number.POSITIVE_INFINITY
  const dx = Number(a.x) - Number(x)
  const dz = Number(a.z) - Number(z)
  return Math.sqrt(dx * dx + dz * dz)
}

function chebyshevDistance3d(pos, x, y, z) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return Number.POSITIVE_INFINITY
  return Math.max(
    Math.abs(Number(pos.x) - Number(x)),
    Math.abs(Number(pos.y) - Number(y)),
    Math.abs(Number(pos.z) - Number(z))
  )
}

function isInsideLobbySpawnDisk(pos, portalConfig) {
  const spawn = portalConfig?.spawnDisk || {}
  if (spawn.enabled === false) return false
  const radius = Math.max(1, toNumber(spawn.radius, 128))
  return distance2d(pos, toNumber(spawn.centerX, 0), toNumber(spawn.centerZ, 0)) <= radius
}

function getSpawnWaypointPoint(spawn, fallbackY = null) {
  const waypoint = blockPosFromConfig(spawn?.waypoint)
  if (waypoint) return waypoint
  if (!Number.isFinite(Number(spawn?.centerX)) || !Number.isFinite(Number(spawn?.centerZ))) return null
  return {
    x: Number(spawn.centerX),
    y: Number.isFinite(Number(fallbackY)) ? Number(fallbackY) : 20,
    z: Number(spawn.centerZ)
  }
}

function isNearSpawnWaypoint(pos, spawn) {
  const waypoint = getSpawnWaypointPoint(spawn, pos?.y)
  if (!waypoint) return false
  const triggerRadius = Math.max(1, toNumber(spawn?.backoffTriggerRadius, 10))
  return distance2d(pos, waypoint.x, waypoint.z) <= triggerRadius
}

function buildSpawnWaypointBackoffPoint(spawn, fallbackY = null) {
  const waypoint = getSpawnWaypointPoint(spawn, fallbackY)
  if (!waypoint) return null
  const portal = blockPosFromConfig(spawn?.portal)
  const backoffBlocks = Math.max(1, toNumber(spawn?.backoffBlocks, 5))
  let stepX = 0
  let stepZ = 0

  if (portal) {
    const deltaX = waypoint.x - portal.x
    const deltaZ = waypoint.z - portal.z
    if (Math.abs(deltaX) >= Math.abs(deltaZ) && deltaX !== 0) {
      stepX = Math.sign(deltaX)
    } else if (deltaZ !== 0) {
      stepZ = Math.sign(deltaZ)
    }
  }

  if (stepX === 0 && stepZ === 0) {
    stepZ = 1
  }

  return {
    x: waypoint.x + (stepX * backoffBlocks),
    y: waypoint.y,
    z: waypoint.z + (stepZ * backoffBlocks),
    range: Math.max(1, toNumber(spawn?.backoffGoalRange, 1.5))
  }
}

function getForcedStraightSpawnRoute(spawn) {
  const route = spawn?.forcedStraightRoute
  if (!route || route.enabled === false) return null
  const trigger = route.trigger || {}
  const hasTriggerPoint = Number.isFinite(Number(trigger.x)) && Number.isFinite(Number(trigger.z))
  if (!hasTriggerPoint) return null
  return {
    ...route,
    trigger: {
      x: Number(trigger.x),
      y: Number.isFinite(Number(trigger.y)) ? Number(trigger.y) : null,
      z: Number(trigger.z),
      radius: Math.max(1, toNumber(trigger.radius, 10))
    }
  }
}

function isInsideForcedStraightSpawnRouteTrigger(pos, spawn) {
  const route = getForcedStraightSpawnRoute(spawn)
  if (!route || !pos) return false
  const trigger = route.trigger
  if (!Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.z))) return false
  const withinHorizontal = distance2d(pos, trigger.x, trigger.z) <= trigger.radius
  if (!withinHorizontal) return false
  if (!Number.isFinite(trigger.y) || !Number.isFinite(Number(pos.y))) return true
  return Math.abs(Number(pos.y) - trigger.y) <= trigger.radius
}

function buildForcedStraightSpawnBackoffPoint(pos, spawn) {
  const route = getForcedStraightSpawnRoute(spawn)
  if (!route || !pos) return null
  const waypoint = getSpawnWaypointPoint(spawn, pos?.y)
  if (!waypoint) return null
  const backoffBlocks = Math.max(1, toNumber(route.backoffBlocks, 5))
  let dx = Number(pos.x) - Number(waypoint.x)
  let dz = Number(pos.z) - Number(waypoint.z)
  let length = Math.sqrt((dx * dx) + (dz * dz))

  if (!(length > 0.001)) {
    const portal = blockPosFromConfig(spawn?.portal)
    dx = Number(waypoint.x) - Number(portal?.x || 0)
    dz = Number(waypoint.z) - Number(portal?.z || 1)
    length = Math.sqrt((dx * dx) + (dz * dz))
  }

  if (!(length > 0.001)) return null

  return {
    x: Number(pos.x) + ((dx / length) * backoffBlocks),
    y: Number.isFinite(Number(pos.y)) ? Number(pos.y) : Number(waypoint.y),
    z: Number(pos.z) + ((dz / length) * backoffBlocks),
    range: Math.max(0.5, toNumber(route.backoffGoalRange, 1.5))
  }
}

async function backoffFromLobbyPortalPoint(bot, config, point, label, backoffBlocks, options = {}) {
  if (!point || !isBotSessionLive(bot)) return false
  const tickMs = Math.max(50, toNumber(options.tickMs, 100))
  const msPerBlock = Math.max(100, toNumber(options.msPerBlock, 350))
  const duration = Math.max(250, Math.round(Math.max(1, toNumber(backoffBlocks, 5)) * msPerBlock))
  const sprint = options.sprint !== false && getPrinterSprintMode(config) !== 'off'
  const jump = options.jump !== false
  const Vec3 = bot?.entity?.position?.constructor
  stopBotMovement(bot)
  console.log(`[LOBBY-PORTAL] Backing off from ${label} for ${duration}ms (~${Math.max(1, toNumber(backoffBlocks, 5))} blocks).`)

  try {
    if (Vec3) {
      try {
        await bot.lookAt(new Vec3(Number(point.x) + 0.5, Number(point.y) + 0.5, Number(point.z) + 0.5), true)
      } catch { }
    }
    bot.setControlState('sprint', sprint)
    bot.setControlState('back', true)
    bot.setControlState('jump', jump)
    let elapsed = 0
    while (isBotSessionLive(bot) && elapsed < duration) {
      await delay(tickMs)
      elapsed += tickMs
    }
  } finally {
    stopBotMovement(bot)
  }

  console.log(`[LOBBY-PORTAL] Backoff from ${label} finished at ${formatBotPosition(bot)}.`)
  return true
}

function isInsideLoginPortalZone(pos, portalConfig) {
  const login = portalConfig?.loginPortal || {}
  if (login.enabled === false) return false
  const radius = Math.max(1, toNumber(login.radius, 10))
  return chebyshevDistance3d(pos, toNumber(login.x, -999), toNumber(login.y, 100), toNumber(login.z, -999)) <= radius
}

function getConfiguredLobbyRegions(portalConfig) {
  const regions = Array.isArray(portalConfig?.lobbyRegions) ? portalConfig.lobbyRegions : []
  if (regions.length) return regions

  const fallback = []
  const spawn = portalConfig?.spawnDisk || {}
  if (spawn.enabled !== false) {
    fallback.push({
      name: 'lobby-1',
      type: 'disk',
      centerX: toNumber(spawn.centerX, 500),
      centerZ: toNumber(spawn.centerZ, 500),
      radius: toNumber(spawn.radius, 192)
    })
  }

  const login = portalConfig?.loginPortal || {}
  if (login.enabled !== false) {
    fallback.push({
      name: 'login-portal',
      type: 'box',
      x: toNumber(login.x, -999),
      y: toNumber(login.y, 100),
      z: toNumber(login.z, -999),
      radius: toNumber(login.radius, 10)
    })
  }

  return fallback
}

function getMatchedLobbyRegion(pos, portalConfig) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null
  const regions = getConfiguredLobbyRegions(portalConfig)
  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i] || {}
    const name = String(region.name || `lobby-${i + 1}`)
    const type = String(region.type || 'disk').toLowerCase()
    const radius = Math.max(1, toNumber(region.radius, 128))
    if (type === 'box') {
      const x = toNumber(region.x, region.centerX)
      const y = toNumber(region.y, pos.y)
      const z = toNumber(region.z, region.centerZ)
      if (chebyshevDistance3d(pos, x, y, z) <= radius) {
        return { name, type, action: String(region.action || '').toLowerCase(), x, y, z, radius }
      }
      continue
    }

    const centerX = toNumber(region.centerX, region.x)
    const centerZ = toNumber(region.centerZ, region.z)
    if (!Number.isFinite(centerX) || !Number.isFinite(centerZ)) continue
    if (distance2d(pos, centerX, centerZ) <= radius) {
      return { name, type: 'disk', action: String(region.action || '').toLowerCase(), centerX, centerZ, radius }
    }
  }
  return null
}

function logLobbyRegionIfMatched(bot, config, reason = 'startup') {
  const portalConfig = getLobbyPortalConfig(config)
  if (!portalConfig?.enabled) return null
  const pos = bot?.entity?.position
  const region = getMatchedLobbyRegion(pos, portalConfig)
  if (!region) {
    bot.__nervLastLobbyRegionKey = null
    return null
  }

  const now = Date.now()
  const centerText = region.type === 'box'
    ? `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.z)}`
    : `${Math.round(region.centerX)},*,${Math.round(region.centerZ)}`
  const key = `${region.name}|${centerText}`
  const lastAt = bot.__nervLastLobbyRegionLogAt || 0
  if (bot.__nervLastLobbyRegionKey !== key || now - lastAt >= 15000) {
    const action = region.action ? ` action=${region.action}` : ''
    console.log(`[LOBBY-REGION] ${region.name} matched during ${reason}: center=${centerText} radius=${region.radius}${action} bot=${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`)
    bot.__nervLastLobbyRegionKey = key
    bot.__nervLastLobbyRegionLogAt = now
  }
  return region
}

function getTransferLobbyRegion(pos, config) {
  if (!is6b6tConfig(config)) return null
  const region = getMatchedLobbyRegion(pos, getLobbyPortalConfig(config))
  return region?.action === 'wait-transfer' ? region : null
}

function isTransferLobbyPosition(pos, config) {
  return getTransferLobbyRegion(pos, config) != null
}

function getLobbyPortalAutoTrigger(pos, config) {
  const portalConfig = getLobbyPortalConfig(config)
  if (!portalConfig?.enabled) return null
  if (!isPositionUsable(pos)) return null
  if (isPositionInsidePlatformBounds(pos, config)) return null

  const transferRegion = getTransferLobbyRegion(pos, config)
  if (transferRegion) {
    return {
      hold: true,
      source: `transfer-region:${transferRegion.name}`,
      region: transferRegion
    }
  }

  if (isInsideLoginPortalZone(pos, portalConfig)) {
    return {
      hold: false,
      source: 'login-portal-zone',
      region: getMatchedLobbyRegion(pos, portalConfig)
    }
  }

  if (isInsideLobbySpawnDisk(pos, portalConfig)) {
    return {
      hold: false,
      source: 'spawn-disk',
      region: getMatchedLobbyRegion(pos, portalConfig)
    }
  }

  const region = getMatchedLobbyRegion(pos, portalConfig)
  if (region && region.action !== 'wait-transfer') {
    return {
      hold: false,
      source: `region:${region.name}`,
      region
    }
  }

  return null
}

function sanitizeSpatialName(value) {
  return String(value || 'bot').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'bot'
}

function getSpatialAwarenessConfig(config) {
  const cliRadius = getCliValue('--spatial-radius')
  const cliVerticalRadius = getCliValue('--spatial-y-radius')
  return {
    enabled: true,
    scanRadius: Math.min(48, Math.max(0, cliRadius == null ? toNumber(config.advanced?.spatialAwareness?.scanRadius, 16) : toNumber(cliRadius, 16))),
    verticalRadius: Math.min(16, Math.max(1, cliVerticalRadius == null ? toNumber(config.advanced?.spatialAwareness?.verticalRadius, 6) : toNumber(cliVerticalRadius, 6))),
    file: getCliValue('--spatial-file') || config.advanced?.spatialAwareness?.file || null
  }
}

function getSpatialAwarenessFile(config) {
  const spatial = getSpatialAwarenessConfig(config)
  if (spatial.file) return path.resolve(process.cwd(), spatial.file)
  const connection = sanitizeSpatialName(config.connection?.active || config.connection?.selected || 'local')
  const username = sanitizeSpatialName(config.bot?.username || 'MapartBot')
  return path.resolve(process.cwd(), 'spatial-awareness', `${connection}-${username}.json`)
}

function readSavedSpatialSnapshot(config) {
  return readOptionalJson(getSpatialAwarenessFile(config))
}

function getSpatialReferencePosition(bot, config, reason = 'spatial-reference') {
  let pos = bot?.entity?.position
  if (!isPositionMissing(pos)) return pos
  if (rescueBotPositionFromLatestPacket(bot, config, reason, { log: false })) {
    pos = bot?.entity?.position
    if (!isPositionMissing(pos)) return pos
  }
  if (isPlatformPositionCacheEnabled(config) && rescueBotPositionFromPlatformCache(bot, config, reason, { log: false })) {
    pos = bot?.entity?.position
    if (!isPositionMissing(pos)) return pos
  }
  const cached = isPlatformPositionCacheEnabled(config) ? bot?.__nervLastPlatformPosition : null
  if (cached && Number.isFinite(cached.x) && Number.isFinite(cached.y) && Number.isFinite(cached.z)) {
    return {
      x: Number(cached.x),
      y: Number(cached.y),
      z: Number(cached.z)
    }
  }
  return pos
}

function classifySpatialPosition(pos, config) {
  if (isPositionMissing(pos)) return { state: 'missing-position', platform: false }
  const transferRegion = getTransferLobbyRegion(pos, config)
  if (transferRegion) return { state: 'transfer-lobby', platform: false, region: transferRegion }
  const region = getMatchedLobbyRegion(pos, getLobbyPortalConfig(config))
  if (region) return { state: region.action === 'wait-transfer' ? 'transfer-lobby' : 'lobby-region', platform: false, region }
  if (isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config)) return { state: 'platform', platform: true }
  return { state: 'off-platform', platform: false }
}

function roundPosition(pos) {
  if (!pos) return null
  return {
    x: Math.round(Number(pos.x) * 100) / 100,
    y: Math.round(Number(pos.y) * 100) / 100,
    z: Math.round(Number(pos.z) * 100) / 100
  }
}

function getSpatialAnchor(config) {
  const targetAnchor = toPoint3(config.anchorTranslation?.targetAnchor)
  if (targetAnchor) {
    return {
      type: 'targetAnchor',
      absolute: targetAnchor
    }
  }

  const mapCorner = toPoint3(config.machine?.mapCorner)
  if (mapCorner) {
    return {
      type: 'mapCorner-fallback',
      absolute: mapCorner
    }
  }

  return {
    type: 'missing',
    absolute: null
  }
}

function relativeToAnchor(pos, anchor) {
  if (!pos || !anchor?.absolute) return null
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null
  return {
    dx: Math.round((Number(pos.x) - Number(anchor.absolute.x)) * 100) / 100,
    dy: Math.round((Number(pos.y) - Number(anchor.absolute.y)) * 100) / 100,
    dz: Math.round((Number(pos.z) - Number(anchor.absolute.z)) * 100) / 100
  }
}

function relativeBoundsToAnchor(bounds, anchor) {
  if (!bounds || !anchor?.absolute) return null
  return {
    minDx: Math.round((Number(bounds.minX) - Number(anchor.absolute.x)) * 100) / 100,
    maxDx: Math.round((Number(bounds.maxX) - Number(anchor.absolute.x)) * 100) / 100,
    minDz: Math.round((Number(bounds.minZ) - Number(anchor.absolute.z)) * 100) / 100,
    maxDz: Math.round((Number(bounds.maxZ) - Number(anchor.absolute.z)) * 100) / 100
  }
}

function toVec3ForBot(bot, pos) {
  const Vec3 = bot?.entity?.position?.constructor
  if (typeof Vec3 !== 'function') return null
  return new Vec3(Math.floor(Number(pos.x)), Math.floor(Number(pos.y)), Math.floor(Number(pos.z)))
}

function getBlockNameAt(bot, pos) {
  const vec = toVec3ForBot(bot, pos)
  if (!vec) return null
  try {
    return bot.blockAt(vec)?.name || null
  } catch {
    return null
  }
}

function countLoadedBlocksNear(bot, radius = 2, verticalRadius = 2) {
  const center = bot?.entity?.position
  if (isPositionMissing(center)) return 0
  const base = {
    x: Math.floor(center.x),
    y: Math.floor(center.y),
    z: Math.floor(center.z)
  }
  let loaded = 0
  for (let x = base.x - radius; x <= base.x + radius; x += 1) {
    for (let y = base.y - verticalRadius; y <= base.y + verticalRadius; y += 1) {
      for (let z = base.z - radius; z <= base.z + radius; z += 1) {
        if (getBlockNameAt(bot, { x, y, z }) != null) loaded += 1
      }
    }
  }
  return loaded
}

async function waitForSpatialChunks(bot, config) {
  const maxMs = Math.max(1000, toNumber(config.advanced?.spatialAwareness?.chunkWaitMs, 15000))
  const minLoaded = Math.max(1, toNumber(config.advanced?.spatialAwareness?.minLoadedNearbyBlocks, 8))
  const startedAt = Date.now()
  let lastLoaded = 0
  while (Date.now() - startedAt < maxMs && isBotSessionLive(bot)) {
    const loaded = countLoadedBlocksNear(bot, 2, 2)
    lastLoaded = loaded
    if (loaded >= minLoaded) {
      console.log(`[SPATIAL] chunk data ready near bot loaded=${loaded}/${minLoaded}`)
      return true
    }
    await delay(500)
  }
  console.log(`[SPATIAL-WARN] chunk data not ready near bot after ${maxMs}ms loaded=${lastLoaded}/${minLoaded}; saving pending snapshot.`)
  return false
}

function machineNodePosition(node) {
  const pos = blockPosFromConfig(node?.position || node)
  return pos
}

function addSpatialLandmark(landmarks, key, node, options = {}) {
  const pos = machineNodePosition(node)
  const enabled = node?.enabled !== false && pos != null
  landmarks.push({
    key,
    enabled,
    required: options.required === true,
    expected: options.expected || [],
    position: pos,
    accessPosition: blockPosFromConfig(node?.accessPosition || null),
    note: options.note || ''
  })
}

function collectSpatialLandmarks(config) {
  const landmarks = []
  const machine = config.machine || {}
  addSpatialLandmark(landmarks, 'mapCorner', { enabled: true, position: machine.mapCorner }, { required: true })
  addSpatialLandmark(landmarks, 'dumpStation', machine.dumpStation, { required: machine.dumpStation?.enabled === true })
  const dumpStations = Array.isArray(machine.dumpStations) ? machine.dumpStations : []
  dumpStations.forEach((station, index) => {
    addSpatialLandmark(landmarks, `dumpStations.${index}`, { enabled: true, position: station.position }, { required: true })
  })
  addSpatialLandmark(landmarks, 'cartographyTable', machine.cartographyTable, { expected: ['cartography_table'], required: machine.cartographyTable?.enabled === true })
  addSpatialLandmark(landmarks, 'finishedMapChest', machine.finishedMapChest, { expected: ['chest', 'trapped_chest', 'barrel'], required: machine.finishedMapChest?.enabled === true })
  addSpatialLandmark(landmarks, 'resetBlock', machine.resetBlock, { required: machine.resetBlock?.enabled === true })
  addSpatialLandmark(landmarks, 'xpButton', machine.xpButton, { expected: ['stone_button', 'oak_button', 'spruce_button', 'birch_button', 'jungle_button', 'acacia_button', 'dark_oak_button', 'mangrove_button', 'cherry_button', 'bamboo_button', 'crimson_button', 'warped_button', 'polished_blackstone_button'], required: machine.xpButton?.enabled === true })
  const xpBottleChests = Array.isArray(machine.xpBottleChests) ? machine.xpBottleChests : []
  xpBottleChests.forEach((node, index) => {
    addSpatialLandmark(landmarks, `xpBottleChests.${index}`, node, { expected: ['chest', 'trapped_chest', 'barrel'], required: false })
  })
  addSpatialLandmark(landmarks, 'anvil', machine.anvil, { expected: ['anvil', 'chipped_anvil', 'damaged_anvil'], required: machine.anvil?.enabled === true })
  addSpatialLandmark(landmarks, 'foodChest', machine.foodChest, { expected: ['chest', 'trapped_chest', 'barrel'], required: machine.foodChest?.enabled === true })

  const materialDict = machine.materialDict && typeof machine.materialDict === 'object' ? machine.materialDict : {}
  for (const [material, spots] of Object.entries(materialDict)) {
    const list = Array.isArray(spots) ? spots : []
    list.forEach((spot, index) => {
      landmarks.push({
        key: `materialDict.${material}.${index}`,
        material,
        enabled: true,
        required: false,
        expected: ['chest', 'trapped_chest', 'barrel'],
        position: blockPosFromConfig(spot),
        accessPosition: blockPosFromConfig(spot?.accessPosition || null),
        note: 'Material chest candidate.'
      })
    })
  }

  return landmarks.filter((entry) => entry.position)
}

function isSpatialInterestingBlock(name) {
  if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return false
  return (
    name.includes('chest') ||
    name.includes('shulker') ||
    name.includes('button') ||
    name.includes('anvil') ||
    name === 'barrel' ||
    name === 'dispenser' ||
    name === 'dropper' ||
    name === 'cartography_table' ||
    name === 'nether_portal' ||
    name === 'glass' ||
    name.endsWith('_glass') ||
    name.endsWith('_stained_glass')
  )
}

function scanSpatialBlocks(bot, config, anchor = getSpatialAnchor(config)) {
  const spatial = getSpatialAwarenessConfig(config)
  const center = getSpatialReferencePosition(bot, config, 'spatial-scan')
  if (isPositionMissing(center)) return { radius: spatial.scanRadius, verticalRadius: spatial.verticalRadius, counts: {}, interesting: [], scanned: 0 }
  const base = {
    x: Math.floor(center.x),
    y: Math.floor(center.y),
    z: Math.floor(center.z)
  }
  const counts = {}
  const interesting = []
  let scanned = 0
  for (let x = base.x - spatial.scanRadius; x <= base.x + spatial.scanRadius; x += 1) {
    for (let y = base.y - spatial.verticalRadius; y <= base.y + spatial.verticalRadius; y += 1) {
      for (let z = base.z - spatial.scanRadius; z <= base.z + spatial.scanRadius; z += 1) {
        const name = getBlockNameAt(bot, { x, y, z }) || 'unloaded'
        scanned += 1
        counts[name] = (counts[name] || 0) + 1
        if (isSpatialInterestingBlock(name)) {
          const position = { x, y, z }
          interesting.push({
            name,
            position,
            relativePosition: relativeToAnchor(position, anchor)
          })
        }
      }
    }
  }
  return {
    radius: spatial.scanRadius,
    verticalRadius: spatial.verticalRadius,
    center: base,
    relativeCenter: relativeToAnchor(base, anchor),
    scanned,
    counts,
    interesting
  }
}

function createSpatialAggregate() {
  return {
    mode: 'coverage-walk',
    waypointsVisited: 0,
    waypointsFailed: 0,
    scanned: 0,
    counts: {},
    interestingByPosition: new Map(),
    coverageWaypoints: []
  }
}

function mergeSpatialScanIntoAggregate(aggregate, scan, waypoint) {
  if (!aggregate || !scan) return aggregate
  aggregate.waypointsVisited += 1
  aggregate.scanned += toNumber(scan.scanned, 0)
  aggregate.coverageWaypoints.push({
    index: aggregate.coverageWaypoints.length + 1,
    position: waypoint,
    scanCenter: scan.center || null,
    scanned: scan.scanned || 0,
    interesting: Array.isArray(scan.interesting) ? scan.interesting.length : 0
  })
  for (const [name, count] of Object.entries(scan.counts || {})) {
    aggregate.counts[name] = (aggregate.counts[name] || 0) + toNumber(count, 0)
  }
  for (const entry of scan.interesting || []) {
    const pos = entry.position
    if (!pos) continue
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
    aggregate.interestingByPosition.set(key, entry)
  }
  return aggregate
}

function finalizeSpatialAggregate(aggregate, anchor) {
  if (!aggregate) return null
  const interesting = Array.from(aggregate.interestingByPosition?.values?.() || [])
    .sort((a, b) => {
      const ap = a.position || {}
      const bp = b.position || {}
      return (ap.x - bp.x) || (ap.z - bp.z) || (ap.y - bp.y)
    })
    .map((entry) => ({
      ...entry,
      relativePosition: entry.relativePosition || relativeToAnchor(entry.position, anchor)
    }))
  return {
    mode: aggregate.mode,
    waypointsVisited: aggregate.waypointsVisited,
    waypointsFailed: aggregate.waypointsFailed,
    scanned: aggregate.scanned,
    counts: aggregate.counts,
    interesting,
    coverageWaypoints: aggregate.coverageWaypoints
  }
}

function getSpatialCoverageBounds(config) {
  const corner = toPoint3(config.machine?.mapCorner)
  if (!corner) return null
  const width = Math.max(1, Math.floor(toNumber(config.machine?.mapSize?.width, 128)))
  const height = Math.max(1, Math.floor(toNumber(config.machine?.mapSize?.height, 128)))
  const spatial = config.advanced?.spatialAwareness || {}
  const margin = Math.min(20, Math.max(0, toNumber(getCliValue('--spatial-margin'), toNumber(spatial.coverageMarginBlocks, 20))))
  const rawBounds = {
    minX: Math.min(corner.x, corner.x + width - 1) - margin,
    maxX: Math.max(corner.x, corner.x + width - 1) + margin,
    minZ: Math.min(corner.z, corner.z + height - 1) - margin,
    maxZ: Math.max(corner.z, corner.z + height - 1) + margin
  }
  const platformBounds = getPlatformBounds(config)
  if (!platformBounds) {
    return { ...rawBounds, y: corner.y, margin, width, height }
  }
  return {
    minX: Math.max(rawBounds.minX, platformBounds.minX),
    maxX: Math.min(rawBounds.maxX, platformBounds.maxX),
    minZ: Math.max(rawBounds.minZ, platformBounds.minZ),
    maxZ: Math.min(rawBounds.maxZ, platformBounds.maxZ),
    y: corner.y,
    margin,
    width,
    height
  }
}

function buildSpatialCoverageWaypoints(config) {
  const bounds = getSpatialCoverageBounds(config)
  if (!bounds) return []
  const spatial = config.advanced?.spatialAwareness || {}
  const step = Math.max(8, Math.min(32, toNumber(getCliValue('--spatial-step'), toNumber(spatial.coverageStepBlocks, 16))))
  const y = toNumber(bounds.y, toNumber(config.machine?.mapCorner?.y, 64))
  const xs = []
  const zs = []
  for (let x = Math.ceil(bounds.minX + Math.min(8, step / 2)); x <= bounds.maxX; x += step) xs.push(Math.min(x, bounds.maxX))
  for (let z = Math.ceil(bounds.minZ + Math.min(8, step / 2)); z <= bounds.maxZ; z += step) zs.push(Math.min(z, bounds.maxZ))
  if (!xs.length) xs.push(Math.round((bounds.minX + bounds.maxX) / 2))
  if (!zs.length) zs.push(Math.round((bounds.minZ + bounds.maxZ) / 2))

  const waypoints = []
  for (let zi = 0; zi < zs.length; zi += 1) {
    const rowXs = zi % 2 === 0 ? xs : [...xs].reverse()
    for (const x of rowXs) {
      waypoints.push({
        x: Math.max(bounds.minX, Math.min(bounds.maxX, x)),
        y,
        z: Math.max(bounds.minZ, Math.min(bounds.maxZ, zs[zi]))
      })
    }
  }
  return waypoints
}

async function walkSpatialCoverage(bot, config) {
  if (config.advanced?.spatialAwareness?.coverageWalk === false || hasCliFlag('--spatial-no-walk')) return null
  const bounds = getSpatialCoverageBounds(config)
  const waypoints = buildSpatialCoverageWaypoints(config)
  if (!bounds || !waypoints.length) return null
  const anchor = getSpatialAnchor(config)
  const aggregate = createSpatialAggregate()
  const timeoutMs = Math.max(5000, toNumber(config.advanced?.spatialAwareness?.waypointTimeoutMs, 30000))
  const goalRange = Math.max(0.5, toNumber(config.advanced?.spatialAwareness?.waypointGoalRange, 2))
  configurePathfinderMovements(bot, config)
  console.log(`[SPATIAL-COVERAGE] Walking ${waypoints.length} chunk waypoint(s). bounds=(${Math.round(bounds.minX)},${Math.round(bounds.minZ)})..(${Math.round(bounds.maxX)},${Math.round(bounds.maxZ)}) margin=${bounds.margin} step=${Math.max(8, Math.min(32, toNumber(getCliValue('--spatial-step'), toNumber(config.advanced?.spatialAwareness?.coverageStepBlocks, 16))))}`)

  for (let i = 0; i < waypoints.length && isBotSessionLive(bot); i += 1) {
    const waypoint = waypoints[i]
    let currentPos = getSpatialReferencePosition(bot, config, `spatial-coverage:${i + 1}`)
    if (isPositionMissing(currentPos) && seedBotPositionFromPlatform(bot, config, `spatial-coverage:${i + 1}`)) {
      currentPos = bot?.entity?.position
    }
    const classification = classifySpatialPosition(currentPos, config)
    if (classification.state === 'transfer-lobby' || classification.state === 'missing-position') {
      console.log(`[SPATIAL-COVERAGE-WARN] pausing coverage walk because bot state=${classification.state}; waypoint=${i + 1}/${waypoints.length}`)
      break
    }
    try {
      await gotoWithTemporaryThinkTimeout(bot, new GoalNear(waypoint.x, waypoint.y, waypoint.z, goalRange), timeoutMs)
      await waitForSpatialChunks(bot, config)
      const scan = scanSpatialBlocks(bot, config, anchor)
      mergeSpatialScanIntoAggregate(aggregate, scan, waypoint)
      if (i === 0 || (i + 1) % 5 === 0 || i === waypoints.length - 1) {
        console.log(`[SPATIAL-COVERAGE] waypoint ${i + 1}/${waypoints.length} at ${Math.round(waypoint.x)},${Math.round(waypoint.y)},${Math.round(waypoint.z)} scanned=${scan.scanned} interesting=${scan.interesting.length}`)
      }
    } catch (err) {
      aggregate.waypointsFailed += 1
      console.log(`[SPATIAL-COVERAGE-WARN] waypoint ${i + 1}/${waypoints.length} failed at ${Math.round(waypoint.x)},${Math.round(waypoint.y)},${Math.round(waypoint.z)}: ${err?.message || err}`)
    }
  }

  bot.__nervSpatialAggregate = aggregate
  return aggregate
}

function verifySpatialLandmarks(bot, config, anchor = getSpatialAnchor(config)) {
  const landmarks = collectSpatialLandmarks(config)
  return landmarks.map((landmark) => {
    const actual = getBlockNameAt(bot, landmark.position)
    const expected = Array.isArray(landmark.expected) ? landmark.expected : []
    const expectedOk = !expected.length || expected.includes(actual)
    const loaded = actual != null
    const status = landmark.enabled === false
      ? 'disabled'
      : (!loaded ? 'pending-unloaded' : (expectedOk ? 'ok' : 'mismatch'))
    const ok = status === 'disabled' || status === 'ok'
    return {
      ...landmark,
      relativePosition: relativeToAnchor(landmark.position, anchor),
      relativeAccessPosition: relativeToAnchor(landmark.accessPosition, anchor),
      loaded,
      actual: actual || 'unloaded',
      status,
      ok
    }
  })
}

function buildSpatialSnapshot(bot, config) {
  const savedSnapshot = readSavedSpatialSnapshot(config)
  const referencePosition = getSpatialReferencePosition(bot, config, 'spatial-snapshot')
  const position = roundPosition(referencePosition)
  const bounds = getPlatformBounds(config)
  const anchor = getSpatialAnchor(config)
  const classification = classifySpatialPosition(referencePosition, config)
  const landmarks = verifySpatialLandmarks(bot, config, anchor)
  const liveScan = finalizeSpatialAggregate(bot.__nervSpatialAggregate, anchor) || scanSpatialBlocks(bot, config, anchor)
  const shouldReuseSavedScan = !!savedSnapshot?.scan && ((toNumber(liveScan?.waypointsVisited, 0) <= 0 && toNumber(liveScan?.scanned, 0) <= 0) || hasCliFlag('--spatial-reuse-last'))
  const scan = shouldReuseSavedScan ? savedSnapshot.scan : liveScan
  const requiredFailures = landmarks.filter((entry) => entry.required && entry.enabled !== false && entry.status === 'mismatch')
  const requiredPending = landmarks.filter((entry) => entry.required && entry.enabled !== false && entry.status === 'pending-unloaded')
  const warnings = []
  if (!classification.platform) warnings.push(`not-on-platform:${classification.state}`)
  if (shouldReuseSavedScan) warnings.push(`reused-saved-spatial-scan:${savedSnapshot.createdAt || 'unknown'}`)
  for (const pending of requiredPending) {
    warnings.push(`required landmark pending/unloaded: ${pending.key} expected=${pending.expected.join('|') || 'any'}`)
  }
  for (const failure of requiredFailures) {
    warnings.push(`required landmark failed: ${failure.key} expected=${failure.expected.join('|') || 'any'} actual=${failure.actual}`)
  }
  return {
    createdAt: new Date().toISOString(),
    connection: config.connection?.active || config.connection?.selected || 'local',
    username: config.bot?.username || 'MapartBot',
    position,
    relativePosition: relativeToAnchor(position, anchor),
    classification,
    anchor,
    platformBounds: bounds,
    relativePlatformBounds: relativeBoundsToAnchor(bounds, anchor),
    machine: {
      mapCorner: config.machine?.mapCorner || null,
      relativeMapCorner: relativeToAnchor(config.machine?.mapCorner, anchor),
      mapSize: config.machine?.mapSize || null
    },
    coverageBounds: getSpatialCoverageBounds(config),
    relativeCoverageBounds: relativeBoundsToAnchor(getSpatialCoverageBounds(config), anchor),
    scan,
    reusedSavedScan: shouldReuseSavedScan,
    landmarks,
    summary: {
      ok: classification.platform === true && requiredFailures.length === 0 && requiredPending.length === 0,
      status: classification.platform !== true
        ? 'off-platform'
        : (requiredFailures.length > 0 ? 'failed' : (requiredPending.length > 0 ? 'pending-unloaded' : 'ok')),
      requiredFailures: requiredFailures.length,
      requiredPending: requiredPending.length,
      landmarks: landmarks.length,
      warnings
    }
  }
}

function findNearestNetherPortal(bot, maxDistance) {
  try {
    return bot.findBlock({
      matching: (block) => block?.name === 'nether_portal',
      maxDistance: Math.max(8, toNumber(maxDistance, 96)),
      count: 1
    })
  } catch {
    return null
  }
}

function getBlockAtPosition(bot, pos) {
  try {
    const Vec3 = bot?.entity?.position?.constructor
    if (typeof Vec3 !== 'function' || !pos) return null
    return bot.blockAt(new Vec3(Number(pos.x), Number(pos.y), Number(pos.z)))
  } catch {
    return null
  }
}

function isPortalWalkableAir(block) {
  const name = String(block?.name || '')
  return !name || name === 'air' || name === 'cave_air' || name === 'void_air' || name.endsWith('_carpet')
}

function isPortalSupportBlock(block) {
  const name = String(block?.name || '')
  if (!name) return false
  if (name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'nether_portal') return false
  return true
}

function buildPortalApproachCandidates(portalPos) {
  const baseY = Number(portalPos.y) - 1
  return [
    { x: Number(portalPos.x) + 1, y: baseY, z: Number(portalPos.z), face: { x: Number(portalPos.x), y: Number(portalPos.y), z: Number(portalPos.z) } },
    { x: Number(portalPos.x) - 1, y: baseY, z: Number(portalPos.z), face: { x: Number(portalPos.x), y: Number(portalPos.y), z: Number(portalPos.z) } },
    { x: Number(portalPos.x), y: baseY, z: Number(portalPos.z) + 1, face: { x: Number(portalPos.x), y: Number(portalPos.y), z: Number(portalPos.z) } },
    { x: Number(portalPos.x), y: baseY, z: Number(portalPos.z) - 1, face: { x: Number(portalPos.x), y: Number(portalPos.y), z: Number(portalPos.z) } }
  ]
}

function getPortalApproachPoint(bot, portalPos, preferredPoint = null) {
  if (!portalPos) return null
  const candidates = buildPortalApproachCandidates(portalPos)
    .map((candidate) => {
      const dx = Math.sign(Number(candidate.face.x) - Number(candidate.x))
      const dz = Math.sign(Number(candidate.face.z) - Number(candidate.z))
      const floorBlock = getBlockAtPosition(bot, { x: candidate.x, y: candidate.y - 1, z: candidate.z })
      const feetBlock = getBlockAtPosition(bot, { x: candidate.x, y: candidate.y, z: candidate.z })
      const headBlock = getBlockAtPosition(bot, { x: candidate.x, y: candidate.y + 1, z: candidate.z })
      const approachFeetBlock = getBlockAtPosition(bot, { x: candidate.x - dx, y: candidate.y, z: candidate.z - dz })
      const approachHeadBlock = getBlockAtPosition(bot, { x: candidate.x - dx, y: candidate.y + 1, z: candidate.z - dz })
      const portalNeighbor = getBlockAtPosition(bot, {
        x: candidate.face.x + (candidate.face.x - candidate.x),
        y: candidate.face.y,
        z: candidate.face.z + (candidate.face.z - candidate.z)
      })
      const hasFloor = isPortalSupportBlock(floorBlock)
      const feetOpen = isPortalWalkableAir(feetBlock)
      const headOpen = isPortalWalkableAir(headBlock) || String(headBlock?.name || '') === 'nether_portal'
      const approachFeetOpen = isPortalWalkableAir(approachFeetBlock)
      const approachHeadOpen = isPortalWalkableAir(approachHeadBlock)
      const facesPortal = String(portalNeighbor?.name || '') === 'nether_portal' || String(getBlockAtPosition(bot, candidate.face)?.name || '') === 'nether_portal'
      if (!hasFloor || !feetOpen || !headOpen || !facesPortal || !approachFeetOpen || !approachHeadOpen) return null
      return {
        ...candidate,
        range: 0.5,
        distanceToPreferred: preferredPoint
          ? Math.sqrt(((Number(candidate.x) - Number(preferredPoint.x)) ** 2) + ((Number(candidate.y) - Number(preferredPoint.y)) ** 2) + ((Number(candidate.z) - Number(preferredPoint.z)) ** 2))
          : 0,
        distanceToBot: bot?.entity?.position
          ? Math.sqrt(((Number(candidate.x) - Number(bot.entity.position.x)) ** 2) + ((Number(candidate.y) - Number(bot.entity.position.y)) ** 2) + ((Number(candidate.z) - Number(bot.entity.position.z)) ** 2))
          : 0
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const preferredDelta = a.distanceToPreferred - b.distanceToPreferred
      if (Math.abs(preferredDelta) > 0.001) return preferredDelta
      return a.distanceToBot - b.distanceToBot
    })

  return candidates[0] || null
}

function getPortalCount(portalConfig, config = null) {
  const explicit = toNumber(portalConfig?.portalCount, NaN)
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)

  let mode = String(portalConfig?.accountMode || 'auto').toLowerCase()
  if (mode === 'auto') {
    const auth = String(config?.bot?.auth || '').toLowerCase()
    mode = auth === 'offline' ? 'cracked' : 'premium'
  }

  return mode === 'cracked' ? 2 : 1
}

function isBotSessionLive(bot) {
  return bot?.__nervSessionActive !== false && bot?._client?.state !== 'disconnected'
}

function distanceToPoint(pos, point) {
  if (!pos || !point) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y)) || !Number.isFinite(Number(pos.z))) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y)) || !Number.isFinite(Number(point.z))) return Number.POSITIVE_INFINITY
  const dx = Number(pos.x) - Number(point.x)
  const dy = Number(pos.y) - Number(point.y)
  const dz = Number(pos.z) - Number(point.z)
  return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz))
}

async function holdForwardIntoPortal(bot, config, ms) {
  const duration = Math.max(0, toNumber(ms, 3000))
  if (duration <= 0 || !isBotSessionLive(bot)) return
  console.log(`[LOBBY-PORTAL] Holding forward into portal for ${duration}ms.`)
  bot.setControlState('sprint', getPrinterSprintMode(config) !== 'off')
  bot.setControlState('forward', true)
  await delay(duration)
  bot.setControlState('forward', false)
  const insidePortal = getBlockNameAt(bot, bot?.entity?.position) === 'nether_portal'
  console.log(`[LOBBY-PORTAL] Forward hold finished. insidePortal=${insidePortal}`)
}

async function walkStraightToLobbyPortalPoint(bot, config, point, label, timeoutMs, defaultRange = 2, options = {}) {
  if (!point || !isBotSessionLive(bot)) return false
  const range = Math.max(0.5, toNumber(point.range, defaultRange))
  const timeout = Math.max(1000, toNumber(timeoutMs, 15000))
  const tickMs = Math.max(50, toNumber(options.tickMs, 100))
  const sprint = options.sprint !== false && getPrinterSprintMode(config) !== 'off'
  const jump = options.jump !== false
  const Vec3 = bot?.entity?.position?.constructor
  const startedAt = Date.now()
  let lastProgressAt = startedAt
  let bestDistance = Number.POSITIVE_INFINITY
  let lastPos = bot?.entity?.position?.clone?.() || (bot?.entity?.position ? { ...bot.entity.position } : null)
  stopBotMovement(bot)
  console.log(`[LOBBY-PORTAL] Walking straight to ${label}: ${Math.round(point.x)} ${Math.round(point.y)} ${Math.round(point.z)} range=${range}`)

  try {
    while (isBotSessionLive(bot)) {
      const pos = bot?.entity?.position
      const distance = distanceToPoint(pos, point)
      if (distance <= range) break

      if (distance + 0.05 < bestDistance) {
        bestDistance = distance
        lastProgressAt = Date.now()
      } else if (lastPos && pos) {
        const movedDistance = distanceToPoint(pos, lastPos)
        if (movedDistance >= Math.max(0.35, toNumber(options.progressStep, 0.5))) {
          lastProgressAt = Date.now()
          lastPos = pos.clone?.() || { ...pos }
        }
      }

      if ((Date.now() - lastProgressAt) >= Math.min(timeout, Math.max(12000, tickMs * 60))) {
        throw new Error(`Straight walk to ${label} stalled at ${formatBotPosition(bot)}`)
      }

      if ((Date.now() - startedAt) > timeout) {
        throw new Error(`Straight walk to ${label} timed out at ${formatBotPosition(bot)}`)
      }

      try {
        await bot.lookAt(new Vec3(Number(point.x) + 0.5, Number(point.y) + 0.5, Number(point.z) + 0.5), true)
      } catch { }
      bot.setControlState('sprint', sprint)
      bot.setControlState('forward', true)
      bot.setControlState('jump', jump)
      await delay(tickMs)
    }
  } finally {
    stopBotMovement(bot)
  }

  console.log(`[LOBBY-PORTAL] Reached ${label} using straight walk.`)
  return true
}

async function runForcedStraightSpawnRoute(bot, config, spawn, timeoutMs, entryMs, waitAfterMs, options = {}) {
  const route = getForcedStraightSpawnRoute(spawn)
  if (!route) return false
  const matchedTrigger = isInsideForcedStraightSpawnRouteTrigger(bot?.entity?.position, spawn)
  const alwaysUse = options.alwaysUse === true
  if (!matchedTrigger && !alwaysUse) return false
  console.log(`[LOBBY-PORTAL] Forced straight spawn route ${matchedTrigger ? 'matched' : 'continued'} near ${Math.round(route.trigger.x)} ${Math.round(route.trigger.y ?? bot?.entity?.position?.y ?? 0)} ${Math.round(route.trigger.z)} radius=${route.trigger.radius}.`)

  const waypoint = getSpawnWaypointPoint(spawn, bot?.entity?.position?.y)
  if (waypoint && matchedTrigger) {
    await backoffFromLobbyPortalPoint(
      bot,
      config,
      waypoint,
      'forced spawn waypoint',
      Math.max(1, toNumber(route.backoffBlocks, 5)),
      {
        jump: true,
        msPerBlock: Math.max(150, toNumber(route.backoffMsPerBlock, 350))
      }
    )
  }

  if (waypoint) {
    await walkStraightToLobbyPortalPoint(bot, config, {
      ...waypoint,
      range: Math.max(0.5, toNumber(route.waypointGoalRange, 2))
    }, 'forced spawn waypoint', timeoutMs, Math.max(0.5, toNumber(route.waypointGoalRange, 2)), { jump: true })
  }

  const portalTarget = blockPosFromConfig(spawn?.portal)
  if (!portalTarget) {
    console.log('[LOBBY-PORTAL-WARN] Forced straight spawn route is enabled but spawnDisk.portal is missing.')
    return false
  }

  await walkStraightToLobbyPortalPoint(bot, config, {
    ...portalTarget,
    range: Math.max(0.5, toNumber(route.portalGoalRange, toNumber(spawn?.goalRange, 2)))
  }, 'forced spawn portal', timeoutMs, Math.max(0.5, toNumber(route.portalGoalRange, toNumber(spawn?.goalRange, 2))), { jump: true })
  await holdForwardIntoPortal(bot, config, entryMs)
  await delay(waitAfterMs)
  return true
}

async function replayMeteorSceneMovement(bot, config, match, fallbackMs = 3000, context = 'scene-replay') {
  const hint = match?.best?.movementHint
  const portalPoint = match?.best?.portalPoint
  const duration = Math.max(0, toNumber(hint?.forwardMs, fallbackMs))
  if (duration <= 0 || !isBotSessionLive(bot)) return false

  const recordedAim = minecraftYawPitchToMineflayerRadians(hint?.capturedYaw, hint?.capturedPitch, config?.advanced || {})
  const hasRecordedLook = recordedAim != null

  if (hasRecordedLook) {
    try {
      await bot.look(recordedAim.yawRad, recordedAim.pitchRad, true)
    } catch { }
  } else if (hint?.lookAtPortal !== false && portalPoint) {
    try {
      const Vec3 = bot.entity.position.constructor
      await bot.lookAt(new Vec3(Number(portalPoint.x) + 0.5, Number(portalPoint.y) + 0.5, Number(portalPoint.z) + 0.5), true)
    } catch { }
  }

  const strafe = String(hint?.strafe || 'none').toLowerCase()
  const useSprint = hint?.sprint === true && getPrinterSprintMode(config) !== 'off'
  const useJump = hint?.jump === true
  console.log(`[METEOR-SCENE] replay reason=${context} label=${match?.best?.label || 'unknown'} durationMs=${duration} strafe=${strafe} jump=${useJump} sprint=${useSprint} look=${hasRecordedLook ? 'recorded' : (hint?.lookAtPortal !== false && portalPoint ? 'portal' : 'unchanged')}`)

  bot.setControlState('sprint', useSprint)
  bot.setControlState('forward', true)
  bot.setControlState('back', strafe === 'back')
  bot.setControlState('left', strafe === 'left')
  bot.setControlState('right', strafe === 'right')
  bot.setControlState('jump', useJump)

  try {
    await delay(duration)
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    bot.setControlState('jump', false)
    bot.setControlState('sprint', false)
  }
  const insidePortal = getBlockNameAt(bot, bot?.entity?.position) === 'nether_portal'
  console.log(`[METEOR-SCENE] replay finished reason=${context} label=${match?.best?.label || 'unknown'} insidePortal=${insidePortal}`)
  return true
}

async function replayMeteorSceneMovementSequence(bot, config, match, fallbackMs = 3000, context = 'scene-sequence') {
  const sequence = buildMeteorSceneMovementSequence(match, config)
  if (!sequence.length || !isBotSessionLive(bot)) return false

  let used = false
  for (let index = 0; index < sequence.length; index += 1) {
    if (!isBotSessionLive(bot)) break
    const insidePortalBeforeStep = getBlockNameAt(bot, bot?.entity?.position) === 'nether_portal'
    if (insidePortalBeforeStep) return true
    const step = sequence[index]
    const moved = await replayMeteorSceneMovement(bot, config, { best: step }, fallbackMs, `${context}-${index + 1}`)
    used = used || moved
    const insidePortalAfterStep = getBlockNameAt(bot, bot?.entity?.position) === 'nether_portal'
    if (insidePortalAfterStep || step.insidePortalBlock === true) return true
    await delay(150)
  }

  return used
}

async function gotoLobbyPortalPoint(bot, config, point, label, timeoutMs, defaultRange = 2) {
  if (!point || !isBotSessionLive(bot)) return false
  configurePathfinderMovements(bot, config)
  const range = Math.max(0.5, toNumber(point.range, defaultRange))
  const useExactGoal = point.exact === true
  console.log(`[LOBBY-PORTAL] Walking to ${label}: ${Math.round(point.x)} ${Math.round(point.y)} ${Math.round(point.z)}${useExactGoal ? ' exact' : ` range=${range}`}`)
  await gotoWithTemporaryThinkTimeout(
    bot,
    useExactGoal
      ? new GoalBlock(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z))
      : new GoalNear(point.x, point.y, point.z, range),
    timeoutMs
  )
  console.log(`[LOBBY-PORTAL] Reached ${label}.`)
  if (!isBotSessionLive(bot)) return false
  try {
    const Vec3 = bot.entity.position.constructor
    await bot.lookAt(new Vec3(Number(point.x) + 0.5, Number(point.y) + 0.5, Number(point.z) + 0.5), true)
  } catch { }
  return true
}

async function runLobbyPortalLeg(bot, config, portalConfig, legIndex) {
  ensureUsableEntityState(bot, config, `lobby-portal-leg-${legIndex}`, { allowPlatformSeed: false, log: false })
  const pos = getSpatialReferencePosition(bot, config, `lobby-portal-leg-${legIndex}`)
  const searchRadius = Math.max(8, toNumber(portalConfig?.portalSearchRadius, 96))
  const timeoutMs = Math.max(5000, toNumber(portalConfig?.pathTimeoutMs, 60000))
  const entryMs = Math.max(0, toNumber(portalConfig?.portalEntryMs, 3000))
  const waitAfterMs = Math.max(0, toNumber(portalConfig?.waitAfterPortalMs, 12000))
  const runtime = classifyRuntimePosition(bot, config, `lobby-portal-leg-${legIndex}`)
  const matchedRegion = getMatchedLobbyRegion(pos, portalConfig)
  const matchedSpawnRegion = matchedRegion?.action === 'spawn-portal' ? matchedRegion : null
  const forcedSpawnRouteMatched = isInsideForcedStraightSpawnRouteTrigger(pos, portalConfig?.spawnDisk || {})
  const sceneAction = String(runtime?.meteor?.best?.action || '')
  const scenePortalPoint = runtime?.meteor?.best?.portalPoint || buildMeteorScenePortalPoint(runtime?.meteor?.best?.scene)
  const savedSpatialEntry = chooseSavedSpatialPortalStep(
    bot,
    config,
    legIndex === 1 ? ['login-portal'] : ['spawn-portal']
  )

  if (isInsideLoginPortalZone(pos, portalConfig) || sceneAction === 'login-portal') {
    const login = portalConfig.loginPortal || {}
    const loginScene = getHighestScoredMeteorSceneByAction(bot, config, 'login-portal') || runtime?.meteor
    const sceneMovementSequence = buildMeteorSceneMovementSequence(loginScene, config)
    await delay(Math.max(0, toNumber(login.waitBeforeMoveMs, 5000)))
    if (!isBotSessionLive(bot)) return false
    if (!isInsideLoginPortalZone(bot?.entity?.position, portalConfig) && sceneAction !== 'login-portal') {
      console.log(`[LOBBY-PORTAL] Leg ${legIndex}: left configured login portal zone before search; skipping portal movement.`)
      return false
    }

    let usedSceneMovement = false
    if (sceneMovementSequence.length) {
      usedSceneMovement = await replayMeteorSceneMovementSequence(bot, config, loginScene, entryMs, `login-leg-${legIndex}`)
    }

    const insidePortalBeforeMove = String(bot?.blockAt?.(bot?.entity?.position)?.name || '') === 'nether_portal'
    const moved = insidePortalBeforeMove
      ? true
      : (usedSceneMovement || await replayMeteorSceneMovement(bot, config, loginScene, entryMs, `login-leg-${legIndex}-fallback`))
    if (!insidePortalBeforeMove && !moved) {
      await holdForwardIntoPortal(bot, config, entryMs)
    }
    const insidePortalAfterMove = String(bot?.blockAt?.(bot?.entity?.position)?.name || '') === 'nether_portal'
    console.log(`[LOBBY-PORTAL] Leg ${legIndex}: after movement insidePortal=${insidePortalAfterMove} pos=${formatBotPosition(bot)}`)
    await delay(waitAfterMs)
    console.log(`[LOBBY-PORTAL] Leg ${legIndex}: waitAfterPortal complete. pos=${formatBotPosition(bot)}`)
    return true
  }

  if (matchedSpawnRegion || isInsideLobbySpawnDisk(pos, portalConfig) || forcedSpawnRouteMatched || sceneAction === 'spawn-portal') {
    const spawn = portalConfig.spawnDisk || {}
    const regionLabel = matchedSpawnRegion ? ` region=${matchedSpawnRegion.name}` : ''
    const forcedLabel = forcedSpawnRouteMatched ? ' forcedStraightRoute' : ''
    console.log(`[LOBBY-PORTAL] Leg ${legIndex}: matched spawn portal route${regionLabel}${forcedLabel}; running spawn portal route.`)
    await delay(Math.max(0, toNumber(spawn.waitBeforeMoveMs, 2500)))
    if (!isBotSessionLive(bot)) return false
    const currentSpawnRegion = getMatchedLobbyRegion(bot?.entity?.position, portalConfig)
    const stillInsideSpawnRegion = currentSpawnRegion?.action === 'spawn-portal'
    const stillInsideForcedRoute = isInsideForcedStraightSpawnRouteTrigger(bot?.entity?.position, spawn)
    if (!stillInsideSpawnRegion && !isInsideLobbySpawnDisk(bot?.entity?.position, portalConfig) && !stillInsideForcedRoute && sceneAction !== 'spawn-portal') {
      console.log(`[LOBBY-PORTAL] Leg ${legIndex}: left configured spawn disk before search; skipping portal movement.`)
      return false
    }

    if (await runForcedStraightSpawnRoute(bot, config, spawn, timeoutMs, entryMs, waitAfterMs, { alwaysUse: true })) {
      return true
    }

    if (spawn.backoffWhenNearWaypoint !== false && isNearSpawnWaypoint(bot?.entity?.position, spawn)) {
      const backoffPoint = buildSpawnWaypointBackoffPoint(spawn, bot?.entity?.position?.y)
      if (backoffPoint) {
        console.log(`[LOBBY-PORTAL] Leg ${legIndex}: near spawn waypoint; backing off ${Math.max(1, toNumber(spawn.backoffBlocks, 5))} blocks before spawn portal walk.`)
        await gotoLobbyPortalPoint(bot, config, backoffPoint, 'spawn waypoint backoff', timeoutMs, backoffPoint.range)
      }
    }

    if (spawn.useConfiguredPortalTarget === true) {
      if (spawn.twoStepRoute === true) {
        await gotoLobbyPortalPoint(bot, config, blockPosFromConfig(spawn.waypoint), 'spawn portal waypoint', timeoutMs, 2)
      }
      const target = blockPosFromConfig(spawn.portal)
      if (!target) {
        console.log(`[LOBBY-PORTAL-WARN] Leg ${legIndex}: no nether portal loaded and no configured spawnDisk.portal target.`)
        return false
      }
      await gotoLobbyPortalPoint(bot, config, { ...target, range: toNumber(spawn.goalRange, 2) }, 'configured spawn portal', timeoutMs, toNumber(spawn.goalRange, 2))
    } else {
      const portalBlock = findNearestNetherPortal(bot, searchRadius)
      if (portalBlock?.position) {
        await gotoLobbyPortalPoint(bot, config, {
          x: portalBlock.position.x,
          y: portalBlock.position.y,
          z: portalBlock.position.z,
          range: toNumber(spawn.goalRange, 2)
        }, 'spawn nether portal block', timeoutMs, toNumber(spawn.goalRange, 2))
      } else if (scenePortalPoint) {
        await gotoLobbyPortalPoint(bot, config, { ...scenePortalPoint, range: toNumber(spawn.goalRange, 2) }, 'scene-matched spawn portal', timeoutMs, toNumber(spawn.goalRange, 2))
      } else {
        console.log(`[LOBBY-PORTAL-WARN] Leg ${legIndex}: no loaded nether_portal block found within ${searchRadius} blocks. Set spawnDisk.useConfiguredPortalTarget=true and spawnDisk.portal coords if Mineflayer cannot see it.`)
        return false
      }
    }

    await holdForwardIntoPortal(bot, config, entryMs)
    await delay(waitAfterMs)
    return true
  }

  if (savedSpatialEntry) {
    console.log(`[LOBBY-PORTAL] Leg ${legIndex}: using saved spatial portal route label=${savedSpatialEntry.step.label} action=${savedSpatialEntry.step.action} distance=${savedSpatialEntry.distance.toFixed(2)} file=${savedSpatialEntry.file}`)
    await runSpatialPortalStep(bot, config, savedSpatialEntry, legIndex)
    await delay(waitAfterMs)
    return true
  }

  console.log(`[LOBBY-PORTAL] Leg ${legIndex}: current position is not in a configured lobby portal zone. p=${JSON.stringify(pos)}`)
  return false
}

async function runLobbyPortalAutomation(bot, config) {
  const portalConfig = getLobbyPortalConfig(config)
  if (!portalConfig?.enabled) return false
  ensureUsableEntityState(bot, config, 'lobby-portal-preflight', { allowPlatformSeed: false, log: false })
  const currentPos = getSpatialReferencePosition(bot, config, 'lobby-portal-preflight')
  if (!isPositionUsable(currentPos)) return false
  if (isPositionInsidePlatformBounds(currentPos, config)) return false
  const region = getMatchedLobbyRegion(currentPos, portalConfig)
  const forcedSpawnRouteMatched = isInsideForcedStraightSpawnRouteTrigger(currentPos, portalConfig?.spawnDisk || {})
  const runtime = classifyRuntimePosition(bot, config, 'lobby-portal-preflight')
  const sceneAction = String(runtime?.meteor?.best?.action || '')
  const savedLoginStep = chooseSavedSpatialPortalStep(bot, config, ['login-portal'])
  const savedSpawnStep = chooseSavedSpatialPortalStep(bot, config, ['spawn-portal'])
  if (region?.action === 'wait-transfer') {
    logLobbyRegionIfMatched(bot, config, 'transfer-wait')
    return false
  }

  if (
    !region &&
    !isInsideLoginPortalZone(currentPos, portalConfig) &&
    !isInsideLobbySpawnDisk(currentPos, portalConfig) &&
    !forcedSpawnRouteMatched &&
    sceneAction !== 'login-portal' &&
    sceneAction !== 'spawn-portal' &&
    !savedLoginStep &&
    !savedSpawnStep
  ) {
    console.log(`[LOBBY-PORTAL] Skipping portal automation: no configured zone or saved spatial route matched current position. p=${JSON.stringify(currentPos)}`)
    return false
  }

  const totalLegs = getPortalCount(portalConfig, config)
  const maxAttempts = Math.max(1, toNumber(portalConfig.maxAttempts, 3))
  const overallTimeoutMs = Math.max(60000, toNumber(portalConfig.overallTimeoutMs, 180000))
  bot.__nervAllowOffPlatformNavigation = true
  bot.__nervPlatformWatchdogActive = false

  const stuckTimer = setTimeout(() => {
    if (isOperatorPauseHoldActive(config)) {
      console.log(`[LOBBY-PORTAL] Operator pause active; not reconnecting after ${Math.round(overallTimeoutMs / 1000)}s portal automation timeout.`)
      return
    }
    console.log(`[LOBBY-PORTAL] Stuck in portal automation for ${Math.round(overallTimeoutMs / 1000)}s; disconnecting to reconnect.`)
    stopBotMovement(bot)
    try { bot.quit('lobby-portal-stuck') } catch {}
  }, overallTimeoutMs)

  try {
    for (let leg = 1; leg <= totalLegs; leg += 1) {
      let completed = false
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (!isBotSessionLive(bot)) return completed
        try {
          console.log(`[LOBBY-PORTAL] Starting leg ${leg}/${totalLegs}, attempt ${attempt}/${maxAttempts}.`)
          completed = await runLobbyPortalLeg(bot, config, portalConfig, leg)
          if (completed) break
        } catch (err) {
          console.log(`[LOBBY-PORTAL-WARN] Leg ${leg} attempt ${attempt} failed: ${err?.message || err}`)
          stopBotMovement(bot)
          await delay(Math.max(1000, toNumber(portalConfig.recoveryCooldownMs, 3000)))
        }
      }

      if (!completed) {
        console.log(`[LOBBY-PORTAL-WARN] Leg ${leg}/${totalLegs} could not complete. Startup will keep waiting for platform position.`)
        return false
      }

      const pos = bot?.entity?.position
      if (isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config)) {
        console.log(`[LOBBY-PORTAL] Reached platform after leg ${leg}/${totalLegs}.`)
        return true
      }
    }
    return true
  } finally {
    clearTimeout(stuckTimer)
    stopBotMovement(bot)
    bot.__nervAllowOffPlatformNavigation = false
  }
}

function getPlatformHoldReason(bot, config) {
  const runtime = classifyRuntimePosition(bot, config, 'platform-hold')
  if (runtime?.classification?.platform === true && runtime.source === 'meteor') {
    return `meteor-platform-match label=${runtime.meteor?.best?.label || 'unknown'} score=${runtime.meteor?.best?.score?.toFixed?.(3) || 'n/a'}`
  }
  const pos = bot?.entity?.position
  if (!isPositionUsable(pos)) return `position-not-ready p=${JSON.stringify(pos)}`
  const transferRegion = getTransferLobbyRegion(pos, config)
  if (transferRegion) return `transfer-lobby region=${transferRegion.name} p=${JSON.stringify(pos)}`
  if (!isPositionInsidePlatformBounds(pos, config)) return `outside-platform p=${JSON.stringify(pos)}`
  return ''
}

function getPlatformRecoveryTpaSettings(config) {
  const recovery = config?.bot?.platformRecoveryTpa || {}
  const command = String(recovery.command || '/tpa ComicSquid74273').trim()
  return {
    enabled: recovery.enabled !== false && command.length > 0,
    command,
    retryMs: Math.max(60000, toNumber(recovery.retryMs, 300000))
  }
}

function shouldRequestPlatformRecoveryTpa(bot, config, runtime) {
  if (bot.__nervAllowOffPlatformNavigation) return false
  const settings = getPlatformRecoveryTpaSettings(config)
  if (!settings.enabled) return false
  const classification = runtime?.classification || classifyRuntimePosition(bot, config, 'platform-recovery-tpa').classification
  if (classification?.platform === true) return false
  return classification?.state === 'off-platform'
}

function maybeRequestPlatformRecoveryTpa(bot, config, reason, runtime) {
  if (!shouldRequestPlatformRecoveryTpa(bot, config, runtime)) return false
  const settings = getPlatformRecoveryTpaSettings(config)
  const now = Date.now()
  const retryMs = settings.retryMs
  const lastAt = toNumber(bot.__nervPlatformRecoveryTpaLastAt, 0)
  if (lastAt > 0 && now - lastAt < retryMs) return false
  bot.__nervPlatformRecoveryTpaLastAt = now
  try {
    bot.chat(settings.command)
    console.log(`[PLATFORM-TPA] Sent ${settings.command} because bot is off-platform in final world during ${reason}. Next retry in ${Math.round(retryMs / 60000)}m if still needed.`)
    return true
  } catch (err) {
    console.log(`[PLATFORM-TPA-WARN] Failed to send ${settings.command} during ${reason}: ${err?.message || err}`)
    return false
  }
}

async function waitForPlatformReady(bot, config, reason = 'platform-hold') {
  if (config.advanced?.platformWatchdogEnabled === false || getPlatformBounds(config) == null) return
  if (bot.__nervAllowOffPlatformNavigation) return
  if (isOperatorPauseHoldActive(config) && bot.__nervPauseParkingInProgress !== true) return
  if (rescueBotPositionFromLatestPacket(bot, config, reason, { log: false })) return
  if (rescueBotPositionFromPlatformCache(bot, config, reason)) return
  const runtime = classifyRuntimePosition(bot, config, reason)
  if (runtime?.classification?.platform === true) return
  if (isPositionUsable(bot?.entity?.position) && isPositionInsidePlatformBounds(bot.entity.position, config)) return
  closeCurrentWindowIfOpen(bot, reason)

  if (bot.__nervPlatformHoldPromise) {
    return bot.__nervPlatformHoldPromise
  }

  bot.__nervPlatformHoldPromise = (async () => {
    const pollMs = Math.max(250, toNumber(config.advanced?.platformWatchdogPollMs, 1000))
    const logMs = Math.max(1000, toNumber(config.advanced?.platformHoldLogMs, 5000))
    const stuckTimeoutMs = Math.max(60000, toNumber(config.advanced?.platformHoldStuckTimeoutMs, 180000))
    const portalCooldownMs = Math.max(5000, toNumber(config.advanced?.platformHoldPortalCooldownMs, 15000))
    let lastLog = 0
    let announced = false
    let lastPortalAttemptAt = 0
    let activeStuckMs = 0
    let lastStuckCheckAt = Date.now()

    while (bot?._client && bot._client.state !== 'disconnected' && bot.__nervSessionActive !== false) {
      const nowForStuck = Date.now()
      const elapsedSinceLastCheck = Math.max(0, nowForStuck - lastStuckCheckAt)
      lastStuckCheckAt = nowForStuck
      const latencyState = getLatencyBackoffState(bot, config)
      if (latencyState.level === 'critical') {
        stopLagSensitiveMovement(bot)
        await applyAdaptiveLatencyBackoff(bot, config, `${reason}-platform-hold`, { pauseMovement: true })
        continue
      }
      activeStuckMs += elapsedSinceLastCheck
      if (activeStuckMs > stuckTimeoutMs) {
        if (isOperatorPauseHoldActive(config)) {
          console.log(`[PLATFORM-HOLD] Operator pause active; not reconnecting after ${Math.round(stuckTimeoutMs / 1000)}s platform hold.`)
          return
        }
        console.log(`[PLATFORM-HOLD] Stuck in platform hold for ${Math.round(stuckTimeoutMs / 1000)}s; disconnecting to reconnect.`)
        try { bot.quit('platform-hold-stuck') } catch {}
        return
      }
      if (bot.__nervAllowOffPlatformNavigation) return
      if (rescueBotPositionFromLatestPacket(bot, config, reason, { log: false })) return
      if (rescueBotPositionFromPlatformCache(bot, config, reason)) return
      const runtime = classifyRuntimePosition(bot, config, reason)
      if (runtime?.classification?.platform === true) return
      const pos = bot?.entity?.position
      if (isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config)) {
        if (announced) {
          console.log(`[PLATFORM-HOLD] Recovered on platform at X:${Math.round(pos.x)} Z:${Math.round(pos.z)}. Resuming.`)
        }
        return
      }

      const holdState = runtime?.classification?.state
      if (
        isLobbyPortalEnabled(config) &&
        holdState !== 'transfer-lobby' &&
        holdState !== 'missing-position' &&
        Date.now() - lastPortalAttemptAt > portalCooldownMs
      ) {
        lastPortalAttemptAt = Date.now()
        console.log(`[PLATFORM-HOLD] In lobby zone (${holdState}) during ${reason}; running portal automation to recover platform position.`)
        await runLobbyPortalAutomation(bot, config)
        continue
      }

      stopBotMovement(bot)
      closeCurrentWindowIfOpen(bot, reason)
      maybeRequestPlatformRecoveryTpa(bot, config, reason, runtime)
      const now = Date.now()
      if (!announced || now - lastLog >= logMs) {
        console.log(`[PLATFORM-HOLD] Paused ${reason}; waiting for platform position. ${getPlatformHoldReason(bot, config)}`)
        lastLog = now
        announced = true
      }
      await delay(pollMs)
    }
  })()

  try {
    await bot.__nervPlatformHoldPromise
  } finally {
    bot.__nervPlatformHoldPromise = null
  }
}

function installPlatformSafety(bot, config) {
  if (config.advanced?.platformWatchdogEnabled === false || bot.__nervPlatformSafetyInstalled) return
  bot.__nervPlatformSafetyInstalled = true

  startPlatformStallReconnectWatchdog(bot, config)

  const pollMs = Math.max(250, toNumber(config.advanced?.platformWatchdogPollMs, 1000))
  const timer = setInterval(() => {
    if (!bot.__nervPlatformWatchdogActive) return
    if (isOperatorPauseHoldActive(config)) return
    if (bot.__nervAllowOffPlatformNavigation) return
    if (!getPlatformBounds(config)) return
    const runtime = classifyRuntimePosition(bot, config, 'runtime-watchdog')
    if (runtime?.classification?.platform === true) return
    const pos = bot?.entity?.position
    if (isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config)) return
    if (rescueBotPositionFromLatestPacket(bot, config, 'runtime-watchdog', { log: false })) return
    if (rescueBotPositionFromPlatformCache(bot, config, 'runtime-watchdog')) return
    if (bot.__nervPlatformRecoveryInProgress) return
    stopBotMovement(bot)
    bot.__nervPlatformRecoveryInProgress = true
    void waitForPlatformReady(bot, config, 'runtime-watchdog').finally(() => {
      bot.__nervPlatformRecoveryInProgress = false
    })
  }, pollMs)
  timer.unref?.()
  bot.once('end', () => clearInterval(timer))

  if (bot.pathfinder?.goto && !bot.pathfinder.__nervPlatformGotoWrapped) {
    const originalGoto = bot.pathfinder.goto.bind(bot.pathfinder)
    bot.pathfinder.goto = async (goal) => {
      if (isRuntimeStopRequested(config) && bot.__nervPauseParkingInProgress !== true) {
        stopBotMovement(bot)
        throw new RuntimeStopRequestedError('stopping-during-navigation')
      }
      if (!bot.__nervAllowOffPlatformNavigation) {
        await waitForPlatformReady(bot, config, 'before-path')
      }
      while (true) {
        try {
          return await originalGoto(goal)
        } catch (err) {
          if (isRuntimeStopRequested(config) && bot.__nervPauseParkingInProgress !== true) {
            stopBotMovement(bot)
            throw new RuntimeStopRequestedError('stopping-during-navigation')
          }
          const message = String(err?.message || err || '')
          const goalChanged = message.toLowerCase().includes('goal was changed')
          const offPlatform = !bot.__nervAllowOffPlatformNavigation &&
            (!isPositionUsable(bot?.entity?.position) || !isPositionInsidePlatformBounds(bot.entity.position, config))
          if (goalChanged) {
            if (!bot.__nervAllowOffPlatformNavigation) {
              console.log('[PATH-RECOVER] Pathfinder goal changed during platform/transfer hold; waiting for platform and retrying.')
              await waitForPlatformReady(bot, config, 'path-goal-changed')
            } else {
              console.log('[PATH-RECOVER] Pathfinder goal changed; retrying navigation.')
            }
            continue
          }
          if (offPlatform) {
            await waitForPlatformReady(bot, config, 'path-interrupted')
            continue
          }
          throw err
        }
      }
    }
    bot.pathfinder.__nervPlatformGotoWrapped = true
  }
}

function formatCoordTriplet(pos) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return 'disabled'
  return `${Number(pos.x)},${Number(pos.y)},${Number(pos.z)}`
}

function logConfiguredCoordinateSummary(config) {
  const bounds = getPlatformBounds(config)
  const portalConfig = getLobbyPortalConfig(config)
  const machine = config.machine || {}

  if (bounds) {
    console.log(`[COORDS] platform bounds x=${Math.round(bounds.minX)}..${Math.round(bounds.maxX)} z=${Math.round(bounds.minZ)}..${Math.round(bounds.maxZ)} mapCorner=${formatCoordTriplet(machine.mapCorner)}`)
  }

  if (portalConfig?.enabled) {
    const regions = getConfiguredLobbyRegions(portalConfig)
    if (regions.length) {
      for (const region of regions) {
        const type = String(region.type || 'disk').toLowerCase()
        if (type === 'box') {
          console.log(`[COORDS] lobby region ${region.name || 'unnamed'} type=box action=${String(region.action || 'none').toLowerCase()} center=${toNumber(region.x, region.centerX)},${toNumber(region.y, 0)},${toNumber(region.z, region.centerZ)} radius=${toNumber(region.radius, 0)}`)
        } else {
          console.log(`[COORDS] lobby region ${region.name || 'unnamed'} type=disk action=${String(region.action || 'none').toLowerCase()} center=${toNumber(region.centerX, region.x)},*,${toNumber(region.centerZ, region.z)} radius=${toNumber(region.radius, 0)}`)
        }
      }
    }

    const spawn = portalConfig.spawnDisk || {}
    console.log(`[COORDS] spawnDisk enabled=${spawn.enabled !== false} center=${toNumber(spawn.centerX, 0)},*,${toNumber(spawn.centerZ, 0)} radius=${toNumber(spawn.radius, 0)} waypoint=${formatCoordTriplet(spawn.waypoint)} portal=${formatCoordTriplet(spawn.portal)}`)

    const login = portalConfig.loginPortal || {}
    console.log(`[COORDS] loginPortal enabled=${login.enabled !== false} center=${toNumber(login.x, 0)},${toNumber(login.y, 0)},${toNumber(login.z, 0)} radius=${toNumber(login.radius, 0)}`)
  }

  for (const key of ['cartographyTable', 'finishedMapChest', 'resetBlock', 'xpButton', 'anvil', 'foodChest']) {
    const node = machine[key]
    if (!node) continue
    console.log(`[COORDS] machine ${key} enabled=${node.enabled !== false} position=${formatCoordTriplet(node.position)} access=${formatCoordTriplet(node.accessPosition)}`)
  }
  const xpBottleChests = Array.isArray(machine.xpBottleChests) ? machine.xpBottleChests : []
  xpBottleChests.forEach((node, index) => {
    console.log(`[COORDS] machine xpBottleChests.${index} enabled=${node?.enabled !== false} position=${formatCoordTriplet(node?.position)} access=${formatCoordTriplet(node?.accessPosition)}`)
  })
}

function logStartupSummary(config, reconnect) {
  const bot = config.bot || {}
  const files = config.files || {}
  const printer = config.printer || {}
  const connection = config.connection || {}
  const offset = printer.printOffset || {}
  const anchor = config.anchorTranslation || {}
  const delta = anchor.appliedDelta || { x: 0, y: 0, z: 0 }

  console.log(
    `[STARTUP] connection=${connection.selected || connection.active || 'default'} host=${bot.host || '127.0.0.1'} port=${toNumber(bot.port, 25565)} inputMode=${String(files.inputMode || 'auto')}`
  )
  console.log(
    `[STARTUP] allowJump=${printer.allowJump !== false} offset=(${toNumber(offset.x, 0)},${toNumber(offset.y, 0)},${toNumber(offset.z, -1)}) resume=${files.resumeProgress !== false}`
  )
  console.log(
    `[STARTUP] reconnect enabled=${reconnect.enabled} delayMs=${reconnect.delayMs} maxAttempts=${reconnect.maxAttempts}`
  )
  console.log(
    `[STARTUP] anchor enabled=${anchor.enabled !== false} source=(${toNumber(anchor.sourceAnchor?.x, 0)},${toNumber(anchor.sourceAnchor?.y, 0)},${toNumber(anchor.sourceAnchor?.z, 0)}) target=(${toNumber(anchor.targetAnchor?.x, 0)},${toNumber(anchor.targetAnchor?.y, 0)},${toNumber(anchor.targetAnchor?.z, 0)}) delta=(${toNumber(delta.x, 0)},${toNumber(delta.y, 0)},${toNumber(delta.z, 0)})`
  )
  logConfiguredCoordinateSummary(config)
}

function runSingleSession(config, sessionNumber) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.__nervSessionActive = true
    const managedControlEnabled = isDashboardEnabled(config) || config?.printer?.startOnSpawn === false
    const runtimeControl = managedControlEnabled ? createRuntimeControl(config) : null
    runtimeControl?.attach()
    const dashboardRuntime = createDashboardRuntime(bot, config, sessionNumber, runtimeControl)
    bot.loadPlugin(pathfinder)
    installPlatformSafety(bot, config)
    if (is6b6tConfig(config)) {
      installPhysicsNaNProbe(bot, config, `main-session-${sessionNumber}`, { logPackets: false, logRepairs: false })
    }
    dashboardRuntime?.start()
    bot.on('move', () => {
      dashboardRuntime?.noteActivity()
    })

    let lastErrorText = ''
    let kickedText = ''
    let successfulStartup = false
    let printerStarted = false
    let startupPending = false
    let spawnedCount = 0
    let spawnFallbackTimer = null
    let lastPlatformCacheLogKey = ''
    let lastPlatformCacheLogAt = 0
    let verificationCode = ''
    let pathfinderMovementsConfigured = false

    const clonePos = (pos) => ({ x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) })
    const recordPlatformPosition = (pos, source) => {
      if (!isPlatformPositionCacheEnabled(config)) return false
      if (!isPositionUsable(pos) || !Number.isFinite(pos.y) || !isPositionInsidePlatformBounds(pos, config)) return false
      const value = clonePos(pos)
      bot.__nervLastPlatformPosition = {
        ...value,
        at: Date.now(),
        source
      }
      const key = `${Math.round(value.x)},${Math.round(value.y)},${Math.round(value.z)}`
      const now = Date.now()
      const shouldLog = key !== lastPlatformCacheLogKey && (source.startsWith('packet:') || now - lastPlatformCacheLogAt >= 15000)
      if (shouldLog) {
        console.log(`[POSITION-CACHE] Cached platform position from ${source}: ${value.x.toFixed(2)},${value.y.toFixed(2)},${value.z.toFixed(2)} spawned=${spawnedCount}.`)
        lastPlatformCacheLogKey = key
        lastPlatformCacheLogAt = now
      }
      return true
    }
    const tryRescuePositionFromCache = (source) => {
      if (!isPlatformPositionCacheEnabled(config)) return false
      if (spawnedCount < getRequiredSpawnCount(config)) return false
      if (rescueBotPositionFromLatestPacket(bot, config, source, { log: false })) return true
      return rescueBotPositionFromPlatformCache(bot, config, source)
    }

    if (is6b6tConfig(config)) {
      for (const packetName of ['position', 'position_look']) {
        bot._client?.on(packetName, (packet) => {
          if (!packet || !Number.isFinite(packet.x) || !Number.isFinite(packet.y) || !Number.isFinite(packet.z)) return
          recordPlatformPosition({ x: Number(packet.x), y: Number(packet.y), z: Number(packet.z) }, `packet:${packetName}`)
        })
      }
      bot.on('move', () => {
        recordPlatformPosition(bot?.entity?.position, 'move')
      })
    }

    let settled = false
    const settle = (reason) => {
      if (settled) return
      settled = true
      bot.__nervSessionActive = false
      bot.__nervAllowOffPlatformNavigation = false
      if (spawnFallbackTimer) {
        clearTimeout(spawnFallbackTimer)
        spawnFallbackTimer = null
      }
      const finalPhase = String(reason || '').includes('dashboard-stop') || String(reason || '').includes('stop')
        ? 'stopped'
        : ((successfulStartup || printerStarted) ? 'crashed' : 'stopped')
      const rawError = lastErrorText || kickedText || reason || ''
      const isVerifyError = isTokenVerificationText(rawError)
      const extractedCode = isVerifyError ? (verificationCode || extractVerificationCode(rawError)) : null
      const cleanError = isVerifyError
        ? `Verification required${extractedCode ? ` — code: ${extractedCode}` : ''}`
        : rawError
      dashboardRuntime?.setLastError(cleanError)
      dashboardRuntime?.stop(finalPhase, false)
      runtimeControl?.detach()
      resolve({
        endReason: reason || 'disconnected',
        lastError: lastErrorText,
        kickedReason: kickedText,
        successfulStartup,
        verificationCode: verificationCode || extractVerificationCode(`${reason || ''} ${lastErrorText} ${kickedText}`),
        tokenVerification: isTokenVerificationText(`${reason || ''} ${lastErrorText} ${kickedText}`)
      })
    }

    const settleAndQuit = (reason) => {
      settle(reason)
      try { bot.quit(reason || 'token-verification-required') } catch { }
    }

    const ensurePathfinderMovementsConfigured = () => {
      if (pathfinderMovementsConfigured) return
      configurePathfinderMovements(bot, config)
      pathfinderMovementsConfigured = true
    }

    const enterPausedManagedLoop = async (stage) => {
      if (!isOperatorPaused(config)) return false
      console.log(`[CONTROL] Operator pause active during ${stage}; holding connected instead of reconnecting.`)
      printerStarted = true
      successfulStartup = true
      bot.__nervPlatformWatchdogActive = true
      dashboardRuntime?.setReconnectState('idle')
      dashboardRuntime?.setPhase('paused', 'paused')
      ensurePathfinderMovementsConfigured()
      await runDashboardManagedPrintLoop(bot, config, runtimeControl, dashboardRuntime, false)
      return true
    }

    const startAfterSpawn = async (trigger = 'threshold') => {
      if (printerStarted || startupPending) return
      startupPending = true
      if (spawnFallbackTimer) {
        clearTimeout(spawnFallbackTimer)
        spawnFallbackTimer = null
      }

      const reqSpawn = getRequiredSpawnCount(config)
      const triggerLabel = trigger === 'fallback'
        ? `Fallback startup after ${spawnedCount}/${reqSpawn} spawn event(s).`
        : (trigger === 'zone-auto'
            ? `Auto-triggered from lobby portal zone at ${spawnedCount}/${reqSpawn} spawn event(s).`
            : `Threshold reached (${spawnedCount}/${reqSpawn}).`)
      console.log(`[SPAWN] ${triggerLabel} Delaying startup...`)
      dashboardRuntime?.setPhase('waiting-spawn', `spawn-${spawnedCount}`)

      const printer = config.printer || {}
      await delay(toNumber(printer.startDelayMs, 1500))

      if (!await waitForOfflineChatLogin(bot, config, 'spawn-startup')) {
        lastErrorText = `offline chat login not confirmed within ${Math.round(toNumber(bot.__nervChatLogin?.waitTimeoutMs, 30000) / 1000)}s`
        if (await enterPausedManagedLoop('chat-login-timeout')) return
        console.log(`[CHAT-LOGIN-RECONNECT] ${lastErrorText}; reconnecting before portal/startup flow.`)
        try { bot.quit('chat-login-timeout') } catch { }
        settle('chat-login-timeout')
        return
      }
      await waitForOfflineChatLoginSettle(bot, config, 'spawn-startup')

      const maxAttempts = Math.max(1, toNumber(config.bot?.spawnPositionTimeoutSeconds, 60)) * 2
      const missingReconnectAttempts = Math.max(0, toNumber(config.bot?.spawnMissingPositionReconnectSeconds, 0)) * 2
      const waitForPlatformPosition = config.bot?.waitForPlatformPositionOnSpawn !== false && getPlatformBounds(config) != null
      const transferReconnectAttempts = Math.max(1, Math.floor(getTransferWaitReconnectMs(config) / 500))
      let attempts = 0
      let missingPositionAttempts = 0
      let transferWaitAttempts = 0
      let lobbyPortalAttempts = 0
      const maxLobbyPortalRuns = getLobbyPortalMaxSessionRuns(config)
      while (attempts < maxAttempts) {
        if (settled || bot.__nervSessionActive === false) return
        let p = bot?.entity?.position
        recordPlatformPosition(p, 'spawn-wait')
        if (isPositionMissing(p) && tryRescuePositionFromCache('spawn-wait')) {
          p = bot?.entity?.position
        }
        let positionMissing = isPositionMissing(p)
        let runtime = classifyRuntimePosition(bot, config, 'spawn-wait')
        if (positionMissing && isTrustedMeteorSceneMatch(runtime?.meteor, true)) {
          updateLobbyPortalConfigFromMeteorScene(config, runtime.meteor)
          if (seedBotPositionFromMeteorScene(bot, runtime.meteor, 'spawn-wait')) {
            p = bot?.entity?.position
            positionMissing = isPositionMissing(p)
            runtime = classifyRuntimePosition(bot, config, 'spawn-wait-seeded')
          }
        }
        const runtimeClassification = runtime.classification || classifySpatialPosition(p, config)
        if (runtime?.meteor?.matched) {
          updateLobbyPortalConfigFromMeteorScene(config, runtime.meteor)
        }

        if (positionMissing) {
          missingPositionAttempts += 1
        } else {
          missingPositionAttempts = 0
        }

        transferWaitAttempts = runtimeClassification.state === 'transfer-lobby' ? (transferWaitAttempts + 1) : 0

        if (runtimeClassification.platform === true || (isPositionUsable(p) && (!waitForPlatformPosition || isPositionInsidePlatformBounds(p, config)))) {
          break
        }

        if (isPositionUsable(p)) {
          logLobbyRegionIfMatched(bot, config, 'spawn-wait')
        }

        if (missingReconnectAttempts > 0 && missingPositionAttempts >= missingReconnectAttempts) {
          lastErrorText = `spawn position missing for ${Math.round(missingPositionAttempts / 2)}s`
          if (await enterPausedManagedLoop('spawn-position-missing')) return
          console.log(`[SPAWN-RECONNECT] ${lastErrorText}; reconnecting instead of waiting idle.`)
          try { bot.quit('spawn-position-missing') } catch { }
          settle('spawn-position-missing')
          return
        }

        if (transferWaitAttempts >= transferReconnectAttempts) {
          lastErrorText = `transfer zone wait exceeded ${Math.round(transferWaitAttempts / 2)}s`
          if (await enterPausedManagedLoop('transfer-zone-timeout')) return
          console.log(`[SPAWN-RECONNECT] ${lastErrorText}; reconnecting instead of fallback startup.`)
          try { bot.quit('transfer-zone-timeout') } catch { }
          settle('transfer-zone-timeout')
          return
        }

        if (waitForPlatformPosition && isLobbyPortalEnabled(config) && runtimeClassification.platform !== true && lobbyPortalAttempts < maxLobbyPortalRuns) {
          const action = runtime?.meteor?.matched ? String(runtime?.meteor?.best?.action || '') : ''
          const inTransfer = runtimeClassification.state === 'transfer-lobby'
          if (inTransfer) {
            await delay(500)
            attempts++
            continue
          }
          if (!isPositionUsable(p) && action !== 'login-portal' && action !== 'spawn-portal') {
            await delay(500)
            attempts++
            continue
          }
          lobbyPortalAttempts += 1
          dashboardRuntime?.setPhase('waiting-spawn', `lobby-portal-${lobbyPortalAttempts}`)
          console.log(`[LOBBY-PORTAL] Position is outside platform during startup; trying lobby portal automation (${lobbyPortalAttempts}/${maxLobbyPortalRuns}). state=${runtimeClassification.state}${action ? ` scene=${action}` : ''}`)
          const attempted = await runLobbyPortalAutomation(bot, config)
          if (attempted) {
            attempts = 0
            await delay(500)
            continue
          }
        }

        if (attempts > 0 && attempts % 10 === 0) {
          const reason = runtimeClassification.platform ? 'platform-detected' : (isPositionUsable(p) ? 'not near platform yet' : 'missing or resetting')
          logThrottled(`spawn-coordinates-${bot?.username || 'bot'}`, `[SPAWN] Coordinates ${reason}... (${attempts}/${maxAttempts}) p=${JSON.stringify(p)} state=${runtimeClassification.state}`, {
            intervalMs: 15000
          })
        }
        await delay(500)
        attempts++
      }

      const finalPos = bot?.entity?.position
      if (!isPositionUsable(finalPos)) {
        if (!tryRescuePositionFromCache('spawn-position-nan')) {
          seedBotPositionFromPlatform(bot, config, 'spawn-position-nan')
        }
      }

      const finalRuntime = classifyRuntimePosition(bot, config, 'spawn-final')
      if (!isPositionUsable(bot?.entity?.position) || (finalRuntime.classification?.platform !== true && !isPositionInsidePlatformBounds(bot.entity.position, config))) {
        if (await enterPausedManagedLoop('spawn-platform-hold')) return
        console.log(`[SPAWN-HOLD] Position was not ready/on-platform after ${Math.round(maxAttempts / 2)}s. Holding instead of quitting.`)
        await waitForPlatformReady(bot, config, 'spawn')
      }
      if (settled || bot.__nervSessionActive === false) return

      printerStarted = true
      successfulStartup = true
      bot.__nervPlatformWatchdogActive = true
      dashboardRuntime?.setLastError('')
      dashboardRuntime?.setReconnectState('idle')
      const allowJump = printer.allowJump !== false

      console.log(`[SPAWN] Connected. session=${sessionNumber}`)

      ensurePathfinderMovementsConfigured()

      bot.on('physicsTick', () => {
        const sprintMode = getPrinterSprintMode(config)
        if (sprintMode === 'always') {
          bot.setControlState('sprint', true)
        } else if (sprintMode === 'off') {
          bot.setControlState('sprint', false)
        }

        if (!allowJump) {
          bot.setControlState('jump', false)
        }
      })

      bot.setControlState('sprint', getPrinterSprintMode(config) === 'always')
      if (!allowJump) {
        bot.setControlState('jump', false)
      }

      if (printer.startOnSpawn === false) {
        const savedProgressIntent = hasUnfinishedProgressIntent(config)
        const shouldResumeManagedPrint = printingIntentActive || savedProgressIntent
        if (shouldResumeManagedPrint) {
          printingIntentActive = true
        }
        if (printingIntentActive && savedProgressIntent) {
          console.log('[STATE] startOnSpawn is false but unfinished progress exists - resuming printing after reconnect.')
        } else if (printingIntentActive) {
          console.log('[STATE] startOnSpawn is false but printing intent is active - resuming printing after reconnect.')
        } else {
          console.log('[STATE] startOnSpawn is false. Waiting idle for start command.')
        }
        dashboardRuntime?.setPhase('idle')
        await runDashboardManagedPrintLoop(bot, config, runtimeControl, dashboardRuntime, shouldResumeManagedPrint)
        return
      }

      try {
        if (dashboardRuntime) {
          await runDashboardManagedPrintLoop(bot, config, runtimeControl, dashboardRuntime, !isOperatorPaused(config))
        } else {
          while (true) {
            let runInfo = null
            try {
              runInfo = await runPrint(bot, config)
            } catch (err) {
              const text = String(err?.message || err)
              const noMoreInput = text.includes('No NBT files found in folder:') || text.includes('No input found.')
              if (noMoreInput) {
                console.log('[STATE] No more map files found. Waiting idle.')
                break
              }
              throw err
            }

            if (runInfo?.sourceType !== 'nbt') {
              break
            }

            if (runInfo?.didWork === false) {
              console.log('[STATE] Nothing left to build for current file/progress. Waiting idle.')
              break
            }

            if (config.files?.moveToFinishedFolder !== true) {
              break
            }
          }
        }
      } catch (err) {
        dashboardRuntime?.setLastError(err?.message || String(err))
        console.log('[FATAL]', err?.message || err)
      }
    }

    bot.on('spawn', async () => {
      spawnedCount += 1
      dashboardRuntime?.noteActivity()
      if (printerStarted || startupPending) return
      dashboardRuntime?.setPhase('waiting-spawn', `spawn-${spawnedCount}`)

      const reqSpawn = getRequiredSpawnCount(config)
      const autoTrigger = getLobbyPortalAutoTrigger(bot?.entity?.position, config)
      if (autoTrigger && !autoTrigger.hold) {
        console.log(`[SPAWN] Auto-triggering startup from ${autoTrigger.source} at ${spawnedCount}/${reqSpawn} spawn event(s).`)
        await startAfterSpawn('zone-auto')
        return
      }
      if (canBypassRemainingSpawnGate(bot, config, spawnedCount, reqSpawn)) {
        console.log(`[SPAWN] Offline login confirmed; bypassing remaining spawn gate at ${spawnedCount}/${reqSpawn}.`)
        await startAfterSpawn('offline-login')
        return
      }
      if (spawnedCount < reqSpawn) {
        logThrottled(`spawn-event-${bot?.username || 'bot'}`, `[SPAWN] Event received (${spawnedCount}/${reqSpawn}). Waiting for more...`, {
          intervalMs: 10000
        })
        if (!spawnFallbackTimer) {
          const fallbackMs = getTransferWaitReconnectMs(config)
          spawnFallbackTimer = setTimeout(() => {
            void (async () => {
            lastErrorText = `spawn gate stalled at ${spawnedCount}/${reqSpawn} for ${Math.round(fallbackMs / 1000)}s`
            if (autoTrigger?.hold) {
              lastErrorText = `transfer zone wait exceeded ${Math.round(fallbackMs / 1000)}s before spawn gate`
              if (await enterPausedManagedLoop('spawn-gate-transfer-timeout')) return
              console.log(`[SPAWN-RECONNECT] ${lastErrorText}; reconnecting instead of fallback startup.`)
              try { bot.quit('transfer-zone-timeout') } catch { }
              settle('transfer-zone-timeout')
              return
            }
            if (await enterPausedManagedLoop('spawn-gate-timeout')) return
            console.log(`[SPAWN-RECONNECT] ${lastErrorText}; reconnecting instead of fallback startup.`)
            try { bot.quit('spawn-gate-timeout') } catch { }
            settle('spawn-gate-timeout')
            })().catch((err) => {
              console.log(`[SPAWN-RECONNECT-WARN] Pause-aware spawn fallback failed: ${err?.message || err}`)
              try { bot.quit('spawn-gate-timeout') } catch { }
              settle('spawn-gate-timeout')
            })
          }, fallbackMs)
          spawnFallbackTimer.unref?.()
        }
        return
      }

      await startAfterSpawn('threshold')
    })

    bot.on('nerv-chat-login-success', async () => {
      dashboardRuntime?.noteActivity()
      if (printerStarted || startupPending) return
      const reqSpawn = getRequiredSpawnCount(config)
      if (!canBypassRemainingSpawnGate(bot, config, spawnedCount, reqSpawn)) return
      console.log(`[SPAWN] Offline login completed after spawn ${spawnedCount}/${reqSpawn}; resuming startup without waiting for more spawn events.`)
      await startAfterSpawn('offline-login')
    })

    bot.on('messagestr', (message) => {
      rememberRecentServerMessage(bot, message, 'messagestr')
      dashboardRuntime?.noteActivity()
      if (isTokenVerificationText(message)) {
        verificationCode = extractVerificationCode(message)
        console.log(`[VERIFY] token/web verification required: ${message}`)
        settleAndQuit('token-verification-required')
        return
      }
      if (config.advanced?.debugPrints) {
        console.log(`[CHAT] ${message}`)
      }
    })

    bot.on('kicked', (reason) => {
      kickedText = typeof reason === 'string' ? reason : JSON.stringify(reason)
      dashboardRuntime?.setLastError(kickedText)
      console.log(`[KICKED] ${kickedText}`)
      if (isTokenVerificationText(kickedText)) {
        verificationCode = extractVerificationCode(kickedText)
        settle('token-verification-required')
      }
    })

    bot.on('error', (err) => {
      lastErrorText = err?.message || String(err)
      dashboardRuntime?.setLastError(lastErrorText)
      console.log('[ERROR]', lastErrorText)
    })

    bot.on('end', (reason) => {
      const text = bot.__nervForcedEndReason || reason || 'disconnected'
      console.log(`[END] ${text}`)
      markProgressInterrupted(config, text, sessionNumber)
      settle(text)
    })
  })
}

function uniqueList(values) {
  const result = []
  const seen = new Set()
  for (const value of values) {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

function get6b6tTestHosts(config) {
  const cli = parseUsernameList(getCliValue('--hosts'))
  if (cli.length) return cli
  const configured = Array.isArray(config.bot?.hosts) ? config.bot.hosts : []
  if (configured.length) return uniqueList(configured)
  return uniqueList([
    config.bot?.host,
    'alt.6b6t.org',
    'alt3.6b6t.org',
    'play.6b6t.org',
    'alt2.6b6t.org'
  ])
}

function get6b6tTestVersions(config) {
  const raw = getCliValue('--versions')
  if (raw) {
    const value = String(raw).trim().toLowerCase()
    if (value !== 'all') return parseUsernameList(raw)
  }
  return uniqueList([
    config.bot?.version,
    '1.20'
  ])
}

function make6b6tTestConfig(baseConfig, account, host, version) {
  const config = cloneJson(baseConfig)
  config.connection = {
    ...(config.connection || {}),
    active: '6b6t',
    selected: '6b6t'
  }
  config.bot = mergeBotOverrides(config.bot, account?.botOverrides || {})
  config.bot.username = account?.name || config.bot.username || 'MapartBot'
  config.bot.host = host
  config.bot.port = 25565
  config.bot.version = version === 'auto' ? 'auto' : version
  config.bot.requiredSpawnCountBeforeStartup = Math.max(3, toNumber(config.bot.requiredSpawnCountBeforeStartup, 2))
  config.bot.requiredSpawnFallbackSeconds = Math.max(90, toNumber(config.bot.requiredSpawnFallbackSeconds, 25))
  config.bot.spawnPositionTimeoutSeconds = Math.max(240, toNumber(config.bot.spawnPositionTimeoutSeconds, 180))
  config.bot.spawnMissingPositionReconnectSeconds = Math.max(75, toNumber(config.bot.spawnMissingPositionReconnectSeconds, 45))
  config.printer = {
    ...(config.printer || {}),
    startOnSpawn: false
  }
  config.files = {
    ...(config.files || {}),
    resumeProgress: false
  }
  return config
}

function runSpatialAwarenessTestSession(config) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.__nervSessionActive = true
    bot.loadPlugin(pathfinder)
    installPlatformSafety(bot, config)

    let settled = false
    let started = false
    let spawnedCount = 0
    let spawnFallbackTimer = null
    let lastErrorText = ''
    let kickedText = ''
    let lastCacheLogKey = ''
    const reqSpawn = getRequiredSpawnCount(config)
    const cacheMaxAgeMs = Math.max(15000, toNumber(config.bot?.platformPositionCacheMaxAgeMs, 120000))

    const clonePos = (pos) => ({ x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) })
    const recordPlatformPosition = (pos, source) => {
      if (!isPlatformPositionCacheEnabled(config)) return false
      if (!isPositionUsable(pos) || !Number.isFinite(pos.y) || !isPositionInsidePlatformBounds(pos, config)) return false
      const value = clonePos(pos)
      bot.__nervLastPlatformPosition = {
        ...value,
        at: Date.now(),
        source
      }
      const key = `${source}|${Math.round(value.x)},${Math.round(value.y)},${Math.round(value.z)}`
      if (key !== lastCacheLogKey) {
        console.log(`[SPATIAL-CACHE] Cached platform position from ${source}: ${value.x.toFixed(2)},${value.y.toFixed(2)},${value.z.toFixed(2)} spawned=${spawnedCount}.`)
        lastCacheLogKey = key
      }
      return true
    }

    const tryRescuePositionFromCache = (source) => {
      if (!isPlatformPositionCacheEnabled(config)) return false
      if (spawnedCount < reqSpawn) return false
      const cached = bot.__nervLastPlatformPosition
      if (!cached || Date.now() - cached.at > cacheMaxAgeMs) return false
      return rescueBotPositionFromPlatformCache(bot, config, source)
    }

    for (const packetName of ['position', 'position_look']) {
      bot._client?.on(packetName, (packet) => {
        if (!packet || !Number.isFinite(packet.x) || !Number.isFinite(packet.y) || !Number.isFinite(packet.z)) return
        const pos = { x: Number(packet.x), y: Number(packet.y), z: Number(packet.z) }
        const classification = classifySpatialPosition(pos, config)
        console.log(`[SPATIAL-PACKET] ${packetName} x=${pos.x.toFixed(2)} y=${pos.y.toFixed(2)} z=${pos.z.toFixed(2)} state=${classification.state} spawned=${spawnedCount}`)
        recordPlatformPosition(pos, `packet:${packetName}`)
      })
    }

    bot.on('move', () => {
      recordPlatformPosition(bot?.entity?.position, 'move')
    })

    const finish = (result = {}) => {
      if (settled) return
      settled = true
      bot.__nervSessionActive = false
      bot.__nervAllowOffPlatformNavigation = false
      if (spawnFallbackTimer) {
        clearTimeout(spawnFallbackTimer)
        spawnFallbackTimer = null
      }
      resolve({
        success: result.success === true,
        endReason: result.endReason || 'spatial-ended',
        file: result.file || null,
        summary: result.summary || null,
        lastError: lastErrorText,
        kickedReason: kickedText
      })
    }

    const finishAndQuit = (result) => {
      finish(result)
      try { bot.quit(result?.endReason || 'spatial-complete') } catch { }
    }

    const saveSnapshot = () => {
      const snapshot = buildSpatialSnapshot(bot, config)
      const filePath = getSpatialAwarenessFile(config)
      writeJson(filePath, snapshot)
      console.log(`[SPATIAL] saved ${filePath}`)
      const status = snapshot.summary.ok ? 'passed' : snapshot.summary.status
      console.log(`[SPATIAL] verification ${status}: requiredFailures=${snapshot.summary.requiredFailures} requiredPending=${snapshot.summary.requiredPending} landmarks=${snapshot.summary.landmarks} interestingBlocks=${snapshot.scan.interesting.length}`)
      for (const warning of snapshot.summary.warnings) {
        console.log(`[SPATIAL-WARN] ${warning}`)
      }
      const xpButton = snapshot.landmarks.find((entry) => entry.key === 'xpButton')
      if (xpButton) console.log(`[SPATIAL-CHECK] xpButton actual=${xpButton.actual} ok=${xpButton.ok} pos=${JSON.stringify(xpButton.position)}`)
      return { snapshot, filePath }
    }

    const startSpatialWait = async (trigger = 'threshold') => {
      if (started || settled) return
      started = true
      if (spawnFallbackTimer) {
        clearTimeout(spawnFallbackTimer)
        spawnFallbackTimer = null
      }
      const triggerText = trigger === 'fallback'
        ? `Fallback after ${spawnedCount}/${reqSpawn} spawn event(s).`
        : (trigger === 'zone-auto'
            ? `Auto-triggered from lobby portal zone at ${spawnedCount}/${reqSpawn} spawn event(s).`
            : `Spawn gate reached (${spawnedCount}/${reqSpawn}).`)
      console.log(`[SPATIAL] ${triggerText} Waiting for final platform; printer will not start.`)

      if (!await waitForOfflineChatLogin(bot, config, 'spatial-startup')) {
        console.log(`[SPATIAL-STOP] offline chat login not confirmed within ${Math.round(toNumber(bot.__nervChatLogin?.waitTimeoutMs, 30000) / 1000)}s; ending spatial run.`)
        finishAndQuit({ endReason: 'chat-login-timeout' })
        return
      }
      await waitForOfflineChatLoginSettle(bot, config, 'spatial-startup')

      const maxAttempts = Math.max(1, toNumber(config.bot?.spawnPositionTimeoutSeconds, 180)) * 2
      const missingReconnectAttempts = Math.max(0, toNumber(config.bot?.spawnMissingPositionReconnectSeconds, 45)) * 2
      const waitForPlatformPosition = config.bot?.waitForPlatformPositionOnSpawn !== false && getPlatformBounds(config) != null
      const transferReconnectAttempts = Math.max(1, Math.floor(getTransferWaitReconnectMs(config) / 500))
      const maxLobbyPortalRuns = getLobbyPortalMaxSessionRuns(config)
      let attempts = 0
      let missingAttempts = 0
      let transferWaitAttempts = 0
      let lobbyPortalAttempts = 0
      while (!settled && isBotSessionLive(bot) && attempts < maxAttempts) {
        let pos = bot?.entity?.position
        recordPlatformPosition(pos, 'spatial-wait')
        if (isPositionMissing(pos) && tryRescuePositionFromCache('spatial-wait')) {
          pos = bot?.entity?.position
        }
        const classification = classifySpatialPosition(pos, config)
        if (classification.state === 'missing-position') missingAttempts += 1
        else missingAttempts = 0
        transferWaitAttempts = classification.state === 'transfer-lobby' ? (transferWaitAttempts + 1) : 0

        if (attempts % 6 === 0) {
          const region = classification.region ? ` region=${classification.region.name}${classification.region.action ? ` action=${classification.region.action}` : ''}` : ''
          console.log(`[SPATIAL-POS] ${formatBotPosition(bot)} state=${classification.state}${region} spawned=${spawnedCount}`)
        }

        if (classification.platform) {
          await waitForSpatialChunks(bot, config)
          await walkSpatialCoverage(bot, config)
          const { snapshot, filePath } = saveSnapshot()
          finishAndQuit({ success: snapshot.summary.ok, endReason: snapshot.summary.ok ? 'spatial-success' : 'spatial-verify-failed', file: filePath, summary: snapshot.summary })
          return
        }

        if (classification.state === 'transfer-lobby') {
          logLobbyRegionIfMatched(bot, config, 'spatial-wait')
        }

        if (missingReconnectAttempts > 0 && missingAttempts >= missingReconnectAttempts) {
          console.log(`[SPATIAL-RECONNECT] position missing for ${Math.round(missingAttempts / 2)}s; ending test so host rotation/retry can handle it.`)
          finishAndQuit({ endReason: 'spatial-position-missing' })
          return
        }

        if (transferWaitAttempts >= transferReconnectAttempts) {
          console.log(`[SPATIAL-RECONNECT] transfer zone wait exceeded ${Math.round(transferWaitAttempts / 2)}s; ending test so reconnect/rotation can handle it.`)
          finishAndQuit({ endReason: 'transfer-zone-timeout' })
          return
        }

        if (waitForPlatformPosition && isLobbyPortalEnabled(config) && classification.state !== 'missing-position' && classification.platform !== true && lobbyPortalAttempts < maxLobbyPortalRuns) {
          if (classification.state === 'transfer-lobby') {
            await delay(500)
            attempts += 1
            continue
          }

          lobbyPortalAttempts += 1
          console.log(`[SPATIAL-PORTAL] Outside platform during spatial test; trying lobby portal automation (${lobbyPortalAttempts}/${maxLobbyPortalRuns}).`)
          try {
            const attempted = await runLobbyPortalAutomation(bot, config)
            if (attempted) {
              attempts = 0
              await delay(500)
              continue
            }
          } catch (err) {
            console.log(`[SPATIAL-PORTAL-WARN] Lobby portal automation failed: ${err?.message || err}`)
          }
        }

        await delay(500)
        attempts += 1
      }

      if (!settled && isBotSessionLive(bot)) {
        if (!isPositionUsable(bot?.entity?.position)) {
          if (!tryRescuePositionFromCache('spatial-timeout')) {
            seedBotPositionFromPlatform(bot, config, 'spatial-timeout')
          }
        }

        const { snapshot, filePath } = saveSnapshot()
        finishAndQuit({
          success: snapshot.summary.ok,
          endReason: settled ? 'settled' : 'spatial-timeout',
          file: filePath,
          summary: snapshot.summary
        })
        return
      }

      finishAndQuit({ endReason: settled ? 'settled' : 'spatial-timeout' })
    }

    bot.on('spawn', () => {
      spawnedCount += 1
      const autoTrigger = getLobbyPortalAutoTrigger(bot?.entity?.position, config)
      if (autoTrigger && !autoTrigger.hold) {
        console.log(`[SPATIAL] Auto-triggering spatial wait from ${autoTrigger.source} at ${spawnedCount}/${reqSpawn} spawn event(s).`)
        void startSpatialWait('zone-auto')
        return
      }
      if (canBypassRemainingSpawnGate(bot, config, spawnedCount, reqSpawn)) {
        console.log(`[SPATIAL] Offline login confirmed; bypassing remaining spawn gate at ${spawnedCount}/${reqSpawn}.`)
        void startSpatialWait('offline-login')
        return
      }
      if (spawnedCount < reqSpawn) {
        console.log(`[SPATIAL] spawn event ${spawnedCount}/${reqSpawn}; waiting for backend/world transfer.`)
        if (!spawnFallbackTimer) {
          const fallbackMs = getTransferWaitReconnectMs(config)
          spawnFallbackTimer = setTimeout(() => {
            if (autoTrigger?.hold) {
              console.log(`[SPATIAL-RECONNECT] transfer zone wait exceeded ${Math.round(fallbackMs / 1000)}s before spawn gate; ending test.`)
              finishAndQuit({ endReason: 'transfer-zone-timeout' })
              return
            }
            void startSpatialWait('fallback')
          }, fallbackMs)
          spawnFallbackTimer.unref?.()
        }
        return
      }
      void startSpatialWait('threshold')
    })

    bot.on('nerv-chat-login-success', () => {
      if (started || settled) return
      if (!canBypassRemainingSpawnGate(bot, config, spawnedCount, reqSpawn)) return
      console.log(`[SPATIAL] Offline login completed after spawn ${spawnedCount}/${reqSpawn}; resuming spatial wait without more spawn events.`)
      void startSpatialWait('offline-login')
    })

    bot.on('messagestr', (message) => {
      if (isTokenVerificationText(message)) {
        console.log(`[SPATIAL-STOP] token/web verification required: ${message}`)
        finishAndQuit({ endReason: 'token-verification-required' })
      }
    })

    bot.on('kicked', (reason) => {
      kickedText = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${kickedText}`)
      if (isTokenVerificationText(kickedText)) {
        finish({ endReason: 'token-verification-required' })
      }
    })

    bot.on('error', (err) => {
      lastErrorText = err?.message || String(err)
      console.log('[ERROR]', lastErrorText)
    })

    bot.on('end', (reason) => {
      const text = reason || 'disconnected'
      console.log(`[END] ${text}`)
      finish({ endReason: text })
    })
  })
}

function get6b6tTestAccounts(config) {
  const accountName = getCliValue('--test-account') || getCliValue('--username')
  const accounts = getEnabledMultiBots(config)
  if (!accountName) return accounts.length ? accounts : [{
    name: config.bot?.username || 'MapartBot',
    role: 'master',
    enabled: true,
    botOverrides: {}
  }]
  const enabledMatches = accounts.filter((entry) => entry.name.toLowerCase() === String(accountName).toLowerCase())
  if (enabledMatches.length) return enabledMatches

  const multi = config.multiUser || {}
  const configured = Array.isArray(config.bot?.usernames) && config.bot.usernames.length
    ? config.bot.usernames
    : (Array.isArray(multi.bots) ? multi.bots : [])
  const allMatches = configured
    .map((entry, index) => normalizeSimpleBotEntry(entry, index, multi))
    .filter((entry) => entry && entry.name.toLowerCase() === String(accountName).toLowerCase())
  return allMatches
}

function getAccountAuthLabel(config, account) {
  return account?.botOverrides?.auth || config.bot?.auth || 'offline'
}

function run6b6tLobbyTestSession(config, label) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.__nervSessionActive = true
    bot.loadPlugin(pathfinder)
    installPlatformSafety(bot, config)

    let settled = false
    let kickedText = ''
    let lastErrorText = ''
    let verificationCode = ''
    let spawnedCount = 0
    let started = false
    let spawnFallbackTimer = null
    let lastPlatformPacketLogAt = 0
    let lastPlatformCacheLogKey = ''
    const lastPlatformPositionMaxAgeMs = Math.max(15000, toNumber(config.bot?.testPositionRescueMaxAgeMs, 120000))

    const getReqSpawnMet = () => spawnedCount >= getRequiredSpawnCount(config)
    const clonePos = (pos) => ({ x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) })
    const recordPlatformPosition = (pos, source) => {
      if (!isPositionUsable(pos) || !Number.isFinite(pos.y) || !isPositionInsidePlatformBounds(pos, config)) return false
      const value = clonePos(pos)
      bot.__nervTestLastPlatformPosition = {
        ...value,
        at: Date.now(),
        source
      }
      const key = `${source}|${Math.round(value.x)},${Math.round(value.y)},${Math.round(value.z)}|${spawnedCount}`
      if (key !== lastPlatformCacheLogKey) {
        console.log(`[TEST-6B6T-CACHE] ${label}: cached platform position from ${source} at ${value.x.toFixed(2)},${value.y.toFixed(2)},${value.z.toFixed(2)} spawned=${spawnedCount}.`)
        lastPlatformCacheLogKey = key
      }
      return true
    }
    const tryRescuePositionFromCache = (source) => {
      if (!getReqSpawnMet()) return false
      if (!isPositionMissing(bot?.entity?.position)) return false
      const cached = bot.__nervTestLastPlatformPosition
      if (!cached) return false
      const ageMs = Date.now() - cached.at
      if (ageMs > lastPlatformPositionMaxAgeMs) return false
      const restored = { x: cached.x, y: cached.y, z: cached.z }
      if (!seedBotPosition(bot, restored, `${source}: restored Mineflayer position from cached real platform coord ${restored.x.toFixed(1)},${restored.y.toFixed(1)},${restored.z.toFixed(1)} ageMs=${ageMs}`)) return false
      console.log(`[TEST-6B6T-RESCUE] ${label}: restored null position after final spawn using cached ${cached.source} coord.`)
      return true
    }

    const logPositionPacket = (packetName, packet) => {
      const pos = packet && Number.isFinite(packet.x) && Number.isFinite(packet.y) && Number.isFinite(packet.z)
        ? { x: Number(packet.x), y: Number(packet.y), z: Number(packet.z) }
        : null
      if (!pos) return
      const platform = isPositionInsidePlatformBounds(pos, config)
      if (platform || Date.now() - lastPlatformPacketLogAt >= 10000) {
        const flags = packet.flags != null ? ` flags=${packet.flags}` : ''
        console.log(`[TEST-6B6T-PACKET] ${label}: ${packetName} x=${pos.x.toFixed(2)} y=${pos.y.toFixed(2)} z=${pos.z.toFixed(2)} platform=${platform} spawned=${spawnedCount}${flags}`)
        lastPlatformPacketLogAt = Date.now()
      }
      recordPlatformPosition(pos, `packet:${packetName}`)
    }

    for (const packetName of ['position', 'position_look']) {
      bot._client?.on(packetName, (packet) => logPositionPacket(packetName, packet))
    }
    bot._client?.on('respawn', () => {
      console.log(`[TEST-6B6T-PACKET] ${label}: respawn packet received spawned=${spawnedCount} pos=${formatBotPosition(bot)}`)
    })
    bot.on('move', () => {
      recordPlatformPosition(bot?.entity?.position, 'move')
    })

    const positionLogMs = Math.max(1000, toNumber(config.bot?.testPositionLogMs, 3000))
    const positionTimer = setInterval(() => {
      if (settled) return
      const pos = bot?.entity?.position
      recordPlatformPosition(pos, 'heartbeat')
      tryRescuePositionFromCache('test-heartbeat')
      const region = logLobbyRegionIfMatched(bot, config, 'test-position')
      const regionText = region ? ` region=${region.name}${region.action ? ` action=${region.action}` : ''}` : ''
      const currentPos = bot?.entity?.position
      const platformReady = isPositionUsable(currentPos) && isPositionInsidePlatformBounds(currentPos, config)
      const platformText = platformReady
        ? ' platform=true'
        : ' platform=false'
      console.log(`[TEST-6B6T-POS] ${label}: ${formatBotPosition(bot)}${regionText}${platformText} clientState=${bot?._client?.state || 'unknown'} spawned=${spawnedCount}`)
      if (platformReady && getReqSpawnMet()) {
        console.log(`[TEST-6B6T-SUCCESS] ${label}: heartbeat reached final platform at ${Math.round(currentPos.x)},${Math.round(currentPos.y)},${Math.round(currentPos.z)} after final spawn gate. Printer not started.`)
        finishAndQuit({ success: true, endReason: 'test-success-platform', finalPosition: { x: currentPos.x, y: currentPos.y, z: currentPos.z } })
      }
    }, positionLogMs)
    positionTimer.unref?.()

    const settle = (result = {}) => {
      if (settled) return
      settled = true
      clearInterval(positionTimer)
      bot.__nervSessionActive = false
      bot.__nervAllowOffPlatformNavigation = false
      if (spawnFallbackTimer) {
        clearTimeout(spawnFallbackTimer)
        spawnFallbackTimer = null
      }
      resolve({
        label,
        success: result.success === true,
        endReason: result.endReason || 'ended',
        lastError: lastErrorText,
        kickedReason: kickedText,
        verificationCode: result.verificationCode || verificationCode || extractVerificationCode(`${kickedText} ${lastErrorText}`),
        finalPosition: result.finalPosition || null,
        ddos: isDdosProtectionText(`${result.endReason || ''} ${lastErrorText} ${kickedText}`),
        tokenVerification: isTokenVerificationText(`${result.endReason || ''} ${lastErrorText} ${kickedText}`)
      })
    }

    const finishAndQuit = (result) => {
      settle(result)
      try { bot.quit(result?.endReason || 'test-complete') } catch { }
    }

    const startTestWait = async (trigger = 'threshold') => {
      if (started || settled) return
      started = true
      if (spawnFallbackTimer) {
        clearTimeout(spawnFallbackTimer)
        spawnFallbackTimer = null
      }

      const reqSpawn = getRequiredSpawnCount(config)
      const triggerLabel = trigger === 'fallback'
        ? `Fallback startup after ${spawnedCount}/${reqSpawn} spawn event(s).`
        : (trigger === 'zone-auto'
            ? `Auto-triggered from lobby portal zone at ${spawnedCount}/${reqSpawn} spawn event(s).`
            : `Threshold reached (${spawnedCount}/${reqSpawn}).`)
      console.log(`[TEST-6B6T] ${label}: ${triggerLabel} Waiting for final destination only; printer will not start.`)

      if (!await waitForOfflineChatLogin(bot, config, `${label}:startup`)) {
        lastErrorText = `offline chat login not confirmed within ${Math.round(toNumber(bot.__nervChatLogin?.waitTimeoutMs, 30000) / 1000)}s`
        console.log(`[TEST-6B6T-STOP] ${label}: ${lastErrorText}.`)
        finishAndQuit({ endReason: 'chat-login-timeout' })
        return
      }
      await waitForOfflineChatLoginSettle(bot, config, `${label}:startup`)

      const maxAttempts = Math.max(1, toNumber(config.bot?.spawnPositionTimeoutSeconds, 180)) * 2
      const missingReconnectAttempts = Math.max(0, toNumber(config.bot?.spawnMissingPositionReconnectSeconds, 45)) * 2
      const transferReconnectAttempts = Math.max(1, Math.floor(getTransferWaitReconnectMs(config) / 500))
      let attempts = 0
      let missingPositionAttempts = 0
      let transferWaitAttempts = 0
      let lobbyPortalAttempts = 0
      const maxLobbyPortalRuns = getLobbyPortalMaxSessionRuns(config)

      while (attempts < maxAttempts && !settled && isBotSessionLive(bot)) {
        let pos = bot?.entity?.position
        recordPlatformPosition(pos, 'wait-loop')
        if (isPositionMissing(pos) && tryRescuePositionFromCache('test-wait-loop')) {
          pos = bot?.entity?.position
        }
        const positionMissing = isPositionMissing(pos)
        if (positionMissing) missingPositionAttempts += 1
        else missingPositionAttempts = 0
        const transferRegion = getTransferLobbyRegion(pos, config)
        transferWaitAttempts = transferRegion ? (transferWaitAttempts + 1) : 0

        if (isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config)) {
          console.log(`[TEST-6B6T-SUCCESS] ${label}: reached final platform at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}. Printer not started.`)
          finishAndQuit({ success: true, endReason: 'test-success-platform', finalPosition: { x: pos.x, y: pos.y, z: pos.z } })
          return
        }

        if (isPositionUsable(pos)) {
          const region = logLobbyRegionIfMatched(bot, config, 'test-wait')
          if (region?.action === 'wait-transfer') {
            // 500/500 is a transfer/wait zone on 6b6t, not a portal zone.
          } else if (isLobbyPortalEnabled(config) && lobbyPortalAttempts < maxLobbyPortalRuns) {
            lobbyPortalAttempts += 1
            console.log(`[TEST-6B6T] ${label}: outside platform; trying portal automation (${lobbyPortalAttempts}/${maxLobbyPortalRuns}).`)
            await runLobbyPortalAutomation(bot, config)
          }
        }

        if (missingReconnectAttempts > 0 && missingPositionAttempts >= missingReconnectAttempts) {
          lastErrorText = `spawn position missing for ${Math.round(missingPositionAttempts / 2)}s`
          console.log(`[TEST-6B6T-RECONNECT] ${label}: ${lastErrorText}.`)
          finishAndQuit({ endReason: 'spawn-position-missing' })
          return
        }

        if (transferWaitAttempts >= transferReconnectAttempts) {
          lastErrorText = `transfer zone wait exceeded ${Math.round(transferWaitAttempts / 2)}s`
          console.log(`[TEST-6B6T-RECONNECT] ${label}: ${lastErrorText}.`)
          finishAndQuit({ endReason: 'transfer-zone-timeout' })
          return
        }

        if (attempts > 0 && attempts % 10 === 0) {
          const reason = isPositionUsable(pos) ? 'not at final platform yet' : 'missing or resetting'
          console.log(`[TEST-6B6T] ${label}: coordinates ${reason} (${attempts}/${maxAttempts}) p=${JSON.stringify(pos)}`)
        }

        await delay(500)
        attempts += 1
      }

      finishAndQuit({ endReason: settled ? 'settled' : 'test-timeout' })
    }

    bot.on('spawn', async () => {
      spawnedCount += 1
      const reqSpawn = getRequiredSpawnCount(config)
      const autoTrigger = getLobbyPortalAutoTrigger(bot?.entity?.position, config)
      if (autoTrigger && !autoTrigger.hold) {
        console.log(`[TEST-6B6T] ${label}: auto-triggering destination wait from ${autoTrigger.source} at ${spawnedCount}/${reqSpawn} spawn event(s).`)
        await startTestWait('zone-auto')
        return
      }
      if (canBypassRemainingSpawnGate(bot, config, spawnedCount, reqSpawn)) {
        console.log(`[TEST-6B6T] ${label}: offline login confirmed; bypassing remaining spawn gate at ${spawnedCount}/${reqSpawn}.`)
        await startTestWait('offline-login')
        return
      }
      if (spawnedCount < reqSpawn) {
        console.log(`[TEST-6B6T] ${label}: spawn event ${spawnedCount}/${reqSpawn}; waiting for transfer/backend spawn.`)
        if (!spawnFallbackTimer) {
          const fallbackMs = getTransferWaitReconnectMs(config)
          spawnFallbackTimer = setTimeout(() => {
            if (autoTrigger?.hold) {
              lastErrorText = `transfer zone wait exceeded ${Math.round(fallbackMs / 1000)}s before spawn gate`
              console.log(`[TEST-6B6T-RECONNECT] ${label}: ${lastErrorText}.`)
              finishAndQuit({ endReason: 'transfer-zone-timeout' })
              return
            }
            void startTestWait('fallback')
          }, fallbackMs)

                bot.on('nerv-chat-login-success', async () => {
                  if (started || settled) return
                  const reqSpawn = getRequiredSpawnCount(config)
                  if (!canBypassRemainingSpawnGate(bot, config, spawnedCount, reqSpawn)) return
                  console.log(`[TEST-6B6T] ${label}: offline login completed after spawn ${spawnedCount}/${reqSpawn}; resuming destination wait without more spawn events.`)
                  await startTestWait('offline-login')
                })
          spawnFallbackTimer.unref?.()
        }
        return
      }
      await startTestWait('threshold')
    })

    bot.on('kicked', (reason) => {
      kickedText = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${kickedText}`)
      if (isTokenVerificationText(kickedText)) {
        verificationCode = extractVerificationCode(kickedText)
        settle({ endReason: 'token-verification-required', verificationCode })
      }
    })

    bot.on('messagestr', (message) => {
      if (isTokenVerificationText(message)) {
        console.log(`[TEST-6B6T-STOP] ${label}: token/web verification chat detected. message=${message}`)
        verificationCode = extractVerificationCode(message)
        finishAndQuit({ endReason: 'token-verification-required', verificationCode })
      }
    })

    bot.on('error', (err) => {
      lastErrorText = err?.message || String(err)
      console.log('[ERROR]', lastErrorText)
    })

    bot.on('end', (reason) => {
      const text = reason || 'disconnected'
      console.log(`[END] ${text}`)
      settle({ endReason: text })
    })
  })
}

async function run6b6tLobbyMatrixTest(config) {
  const accounts = get6b6tTestAccounts(config)
  if (!accounts.length) {
    throw new Error('No enabled bot accounts found for --test-6b6t-lobby.')
  }

  const hosts = get6b6tTestHosts(config)
  const versions = get6b6tTestVersions(config)
  const normalDelayMs = Math.max(10000, toNumber(getCliValue('--normal-retry-ms'), 10000))
  const ddosDelayMs = Math.max(31000, toNumber(getCliValue('--ddos-retry-ms'), 32000))
  const maxCases = Math.max(1, toNumber(getCliValue('--max-cases'), accounts.length * hosts.length * versions.length))
  const results = []
  let caseNo = 0

  console.log(`[TEST-6B6T] Matrix starting. accounts=${accounts.map((a) => `${a.name}/${getAccountAuthLabel(config, a)} passwordConfigured=${Boolean(a.botOverrides?.loginPassword || a.botOverrides?.password || a.botOverrides?.chatLoginPassword)}`).join(', ')} hosts=${hosts.join(', ')} versions=${versions.join(', ')} maxCases=${maxCases}`)
  console.log(`[TEST-6B6T] Retry delays: normal=${normalDelayMs}ms ddos=${ddosDelayMs}ms. Printer will never start in this mode.`)

  const runCase = async (account, host, version, label) => {
    const testConfig = make6b6tTestConfig(config, account, host, version)
    console.log(`[TEST-6B6T-CONFIG] ${label} config=${JSON.stringify({
      host,
      port: testConfig.bot.port,
      username: testConfig.bot.username,
      auth: testConfig.bot.auth,
      version: testConfig.bot.version,
      loginPasswordConfigured: Boolean(testConfig.bot.loginPassword || testConfig.bot.password || testConfig.bot.chatLoginPassword),
      requiredSpawnCountBeforeStartup: testConfig.bot.requiredSpawnCountBeforeStartup,
      spawnPositionTimeoutSeconds: testConfig.bot.spawnPositionTimeoutSeconds,
      spawnMissingPositionReconnectSeconds: testConfig.bot.spawnMissingPositionReconnectSeconds,
      chatLoginEnabled: testConfig.bot.chatLogin?.enabled !== false,
      lobbyPortal: testConfig.bot.lobbyPortal
    })}`)
    return await run6b6tLobbyTestSession(testConfig, label)
  }

  for (const version of versions) {
    for (let hostIndex = 0; hostIndex < hosts.length; hostIndex += 1) {
      for (const account of accounts) {
        if (caseNo >= maxCases) break
        const host = hosts[hostIndex]
        caseNo += 1
        const label = `case=${caseNo} account=${account.name} auth=${getAccountAuthLabel(config, account)} host=${host} version=${version}`
        let result = await runCase(account, host, version, label)
        results.push(result)
        console.log(`[TEST-6B6T-RESULT] ${label} success=${result.success} end=${result.endReason} ddos=${result.ddos} tokenVerification=${result.tokenVerification} verificationCode=${result.verificationCode || ''} pos=${JSON.stringify(result.finalPosition)}`)

        if (result.success) {
          console.log(`[TEST-6B6T-DONE] Success reached final destination with ${label}. Stopping matrix.`)
          return results
        }

        while (result.tokenVerification) {
          const refreshMs = Math.max(60000, toNumber(getCliValue('--verify-refresh-ms'), 9 * 60 * 1000))
          const action = await waitForVerificationInput({
            account: account.name,
            host,
            version,
            code: result.verificationCode,
            refreshMs
          })
          const suffix = action === 'verified' ? 'verified-retry' : 'refresh-code'
          console.log(action === 'verified'
            ? `[VERIFY] User marked account=${account.name} as verified; retrying the same case before continuing.`
            : `[VERIFY] Refresh requested/expired for account=${account.name}; retrying same case to get a new code.`
          )
          await delay(normalDelayMs)
          result = await runCase(account, host, version, `${label} ${suffix}`)
          results.push(result)
          console.log(`[TEST-6B6T-RESULT] ${label} ${suffix} success=${result.success} end=${result.endReason} ddos=${result.ddos} tokenVerification=${result.tokenVerification} verificationCode=${result.verificationCode || ''} pos=${JSON.stringify(result.finalPosition)}`)
          if (result.success) {
            console.log(`[TEST-6B6T-DONE] Success reached final destination with ${label} after verification. Stopping matrix.`)
            return results
          }
          if (action === 'verified' && result.tokenVerification) {
            console.log(`[VERIFY] account=${account.name} still needs verification after retry; waiting again.`)
          }
        }

        const waitMs = result.ddos ? ddosDelayMs : normalDelayMs
        if (caseNo < maxCases) {
          console.log(`[TEST-6B6T] Waiting ${waitMs}ms before next case. reason=${result.ddos ? 'ddos-protection' : result.endReason}`)
          await delay(waitMs)
        }

        if (result.ddos && hosts.length > 1) {
          console.log('[TEST-6B6T] DDoS protection detected; next case will continue host rotation.')
        }
      }
      if (caseNo >= maxCases) break
    }
    if (caseNo >= maxCases) break
  }

  console.log(`[TEST-6B6T-DONE] Matrix finished without platform success. cases=${results.length}`)
  return results
}

function make6b6tPhysicsTestConfig(baseConfig, account, host, version) {
  const config = make6b6tTestConfig(baseConfig, account, host, version)
  config.bot.requiredSpawnCountBeforeStartup = Math.max(1, toNumber(config.bot.requiredSpawnCountBeforeStartup, 1))
  config.bot.spawnPositionTimeoutSeconds = Math.max(60, toNumber(config.bot.spawnPositionTimeoutSeconds, 120))
  config.bot.physicsTestPacketMaxAgeMs = Math.max(1000, toNumber(config.bot.physicsTestPacketMaxAgeMs, 15000))
  if (hasCliFlag('--physics-disable-antihunger') || hasCliFlag('--physics-no-antihunger')) {
    config.advanced = { ...(config.advanced || {}), antiHunger: false }
  }
  return config
}

function run6b6tPhysicsTestSession(config, label) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.__nervSessionActive = true
    const probe = installPhysicsNaNProbe(bot, config, label)

    let settled = false
    let kickedText = ''
    let lastErrorText = ''
    let spawnedCount = 0
    let loginSeen = false
    let verificationCode = ''
    const startedAt = Date.now()
    const durationMs = Math.max(10000, toNumber(getCliValue('--physics-test-ms'), toNumber(getCliValue('--physics-duration-ms'), toNumber(getCliValue('--physics-seconds'), 120) * 1000)))

    const settle = (result = {}) => {
      if (settled) return
      settled = true
      clearInterval(heartbeatTimer)
      bot.__nervSessionActive = false
      const current = bot.__nervPhysicsProbe || probe || {}
      resolve({
        label,
        success: result.success === true,
        endReason: result.endReason || 'physics-ended',
        spawnedCount,
        loginSeen,
        lastError: lastErrorText,
        kickedReason: kickedText,
        verificationCode: result.verificationCode || verificationCode || extractVerificationCode(`${kickedText} ${lastErrorText}`),
        packetPositions: current.packetPositions || 0,
        positionRepairs: current.positionRepairs || 0,
        velocityRepairs: current.velocityRepairs || 0,
        finalPosition: cloneFinitePosition(bot?.entity?.position),
        finalVelocityInvalid: hasInvalidVector(bot?.entity?.velocity),
        tokenVerification: isTokenVerificationText(`${result.endReason || ''} ${kickedText} ${lastErrorText}`),
        ddos: isDdosProtectionText(`${result.endReason || ''} ${kickedText} ${lastErrorText}`)
      })
    }

    const finishAndQuit = (result) => {
      settle(result)
      try { bot.quit(result?.endReason || 'physics-test-complete') } catch { }
    }

    const heartbeatTimer = setInterval(() => {
      if (settled) return
      const elapsed = Date.now() - startedAt
      const state = bot.__nervPhysicsProbe || probe || {}
      const packetAge = state.lastPacketAt ? Date.now() - state.lastPacketAt : -1
      console.log(`[PHYSICS-STATE] ${label} elapsed=${Math.round(elapsed / 1000)}s clientState=${bot?._client?.state || 'unknown'} spawned=${spawnedCount} login=${loginSeen} chatLogin=${bot.__nervChatLogin?.loggedIn === true} entity=${formatBotPosition(bot)} vel=${formatVec3ForLog(bot?.entity?.velocity)} packetAgeMs=${packetAge} packetPositions=${state.packetPositions || 0} posRepairs=${state.positionRepairs || 0} velRepairs=${state.velocityRepairs || 0}`)
      if (elapsed >= durationMs) {
        const invalidPos = isPositionMissing(bot?.entity?.position)
        const invalidVel = hasInvalidVector(bot?.entity?.velocity)
        finishAndQuit({
          success: !invalidPos && !invalidVel && (state.packetPositions || 0) > 0,
          endReason: invalidPos || invalidVel ? 'physics-invalid-after-test' : 'physics-test-complete'
        })
      }
    }, Math.max(500, toNumber(getCliValue('--physics-log-ms'), 1000)))
    heartbeatTimer.unref?.()

    bot.on('login', () => {
      loginSeen = true
      console.log(`[PHYSICS] ${label} login event.`)
    })

    bot.on('spawn', () => {
      spawnedCount += 1
      console.log(`[PHYSICS] ${label} spawn event ${spawnedCount}. entity=${formatBotPosition(bot)} vel=${formatVec3ForLog(bot?.entity?.velocity)}`)
    })

    bot.on('nerv-chat-login-success', (info) => {
      console.log(`[PHYSICS] ${label} offline chat login confirmed reason=${info?.reason || 'unknown'}. entity=${formatBotPosition(bot)} vel=${formatVec3ForLog(bot?.entity?.velocity)}`)
    })

    bot.on('messagestr', (message) => {
      if (isTokenVerificationText(message)) {
        verificationCode = extractVerificationCode(message)
        console.log(`[PHYSICS-STOP] ${label} token/web verification detected code=${verificationCode || 'unknown'}.`)
        finishAndQuit({ endReason: 'token-verification-required', verificationCode })
      }
    })

    bot.on('kicked', (reason) => {
      kickedText = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${kickedText}`)
      if (isTokenVerificationText(kickedText)) {
        verificationCode = extractVerificationCode(kickedText)
        settle({ endReason: 'token-verification-required', verificationCode })
      }
    })

    bot.on('error', (err) => {
      lastErrorText = err?.message || String(err)
      console.log('[ERROR]', lastErrorText)
    })

    bot.on('end', (reason) => {
      const text = reason || 'disconnected'
      console.log(`[END] ${text}`)
      settle({ endReason: text })
    })
  })
}

async function run6b6tPhysicsMatrixTest(config) {
  const accounts = get6b6tTestAccounts(config)
  if (!accounts.length) {
    throw new Error('No account found for --test-6b6t-physics. Use --test-account=<name> or enable one account.')
  }

  const hosts = get6b6tTestHosts(config)
  const versions = get6b6tTestVersions(config)
  const maxCases = Math.max(1, toNumber(getCliValue('--max-cases'), accounts.length * hosts.length * versions.length))
  const normalDelayMs = Math.max(10000, toNumber(getCliValue('--normal-retry-ms'), 10000))
  const ddosDelayMs = Math.max(31000, toNumber(getCliValue('--ddos-retry-ms'), 32000))
  const results = []
  let caseNo = 0

  console.log(`[TEST-6B6T-PHYSICS] Matrix starting. accounts=${accounts.map((a) => `${a.name}/${getAccountAuthLabel(config, a)} passwordConfigured=${Boolean(a.botOverrides?.loginPassword || a.botOverrides?.password || a.botOverrides?.chatLoginPassword)}`).join(', ')} hosts=${hosts.join(', ')} versions=${versions.join(', ')} maxCases=${maxCases} antiHungerDisabled=${hasCliFlag('--physics-disable-antihunger') || hasCliFlag('--physics-no-antihunger')}`)

  for (const version of versions) {
    for (const host of hosts) {
      for (const account of accounts) {
        if (caseNo >= maxCases) break
        caseNo += 1
        const label = `case=${caseNo} account=${account.name} auth=${getAccountAuthLabel(config, account)} host=${host} version=${version}`
        const testConfig = make6b6tPhysicsTestConfig(config, account, host, version)
        console.log(`[TEST-6B6T-PHYSICS-CONFIG] ${label} config=${JSON.stringify({
          host,
          username: testConfig.bot.username,
          auth: testConfig.bot.auth,
          version: testConfig.bot.version,
          loginPasswordConfigured: Boolean(testConfig.bot.loginPassword || testConfig.bot.password || testConfig.bot.chatLoginPassword),
          antiHunger: testConfig.advanced?.antiHunger !== false,
          durationMs: Math.max(10000, toNumber(getCliValue('--physics-test-ms'), toNumber(getCliValue('--physics-duration-ms'), toNumber(getCliValue('--physics-seconds'), 120) * 1000)))
        })}`)
        const result = await run6b6tPhysicsTestSession(testConfig, label)
        results.push(result)
        console.log(`[TEST-6B6T-PHYSICS-RESULT] ${label} success=${result.success} end=${result.endReason} packets=${result.packetPositions} posRepairs=${result.positionRepairs} velRepairs=${result.velocityRepairs} finalPos=${JSON.stringify(result.finalPosition)} finalVelocityInvalid=${result.finalVelocityInvalid} ddos=${result.ddos} tokenVerification=${result.tokenVerification} verificationCode=${result.verificationCode || ''}`)
        if (result.success) {
          console.log(`[TEST-6B6T-PHYSICS-DONE] Physics test passed with ${label}.`)
          return results
        }
        if (caseNo >= maxCases) break
        const waitMs = result.ddos ? ddosDelayMs : normalDelayMs
        console.log(`[TEST-6B6T-PHYSICS] Waiting ${waitMs}ms before next case. reason=${result.ddos ? 'ddos-protection' : result.endReason}`)
        await delay(waitMs)
      }
      if (caseNo >= maxCases) break
    }
    if (caseNo >= maxCases) break
  }

  console.log(`[TEST-6B6T-PHYSICS-DONE] Matrix finished. cases=${results.length}`)
  return results
}

function make6b6tPortalTestConfig(baseConfig, account, host, version) {
  const config = make6b6tPhysicsTestConfig(baseConfig, account, host, version)
  config.printer = {
    ...(config.printer || {}),
    startOnSpawn: false
  }
  config.files = {
    ...(config.files || {}),
    resumeProgress: false
  }
  return config
}

function run6b6tPortalTestSession(config, label) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.__nervSessionActive = true
    bot.loadPlugin(pathfinder)
    installPlatformSafety(bot, config)
    installPhysicsNaNProbe(bot, config, `${label} portal`)

    let settled = false
    let kickedText = ''
    let lastErrorText = ''
    let verificationCode = ''
    let spawnedCount = 0
    let portalAttempts = 0
    let portalSuccess = false
    let portalLoopBusy = false
    let lastClassificationState = ''
    const startedAt = Date.now()
    const maxMs = Math.max(30000, toNumber(getCliValue('--portal-test-ms'), toNumber(getCliValue('--portal-seconds'), 180) * 1000))
    const maxPortalAttempts = Math.max(1, toNumber(getCliValue('--portal-attempts'), toNumber(getLobbyPortalConfig(config)?.maxSessionRuns, 4)))

    const settle = (result = {}) => {
      if (settled) return
      settled = true
      clearInterval(loopTimer)
      bot.__nervSessionActive = false
      bot.__nervAllowOffPlatformNavigation = false
      const probe = bot.__nervPhysicsProbe || {}
      resolve({
        label,
        success: result.success === true,
        endReason: result.endReason || 'portal-test-ended',
        spawnedCount,
        portalAttempts,
        portalSuccess,
        lastClassificationState,
        lastError: lastErrorText,
        kickedReason: kickedText,
        verificationCode: result.verificationCode || verificationCode || extractVerificationCode(`${kickedText} ${lastErrorText}`),
        packetPositions: probe.packetPositions || 0,
        positionRepairs: probe.positionRepairs || 0,
        velocityRepairs: probe.velocityRepairs || 0,
        finalPosition: cloneFinitePosition(bot?.entity?.position),
        tokenVerification: isTokenVerificationText(`${result.endReason || ''} ${kickedText} ${lastErrorText}`),
        ddos: isDdosProtectionText(`${result.endReason || ''} ${kickedText} ${lastErrorText}`)
      })
    }

    const finishAndQuit = (result) => {
      settle(result)
      try { bot.quit(result?.endReason || 'portal-test-complete') } catch { }
    }

    const loopTimer = setInterval(() => {
      void (async () => {
        if (settled || !isBotSessionLive(bot) || portalLoopBusy) return
        portalLoopBusy = true
        try {
        const elapsedMs = Date.now() - startedAt
        const runtime = classifyRuntimePosition(bot, config, 'portal-test-loop')
        const classification = runtime?.classification || { state: 'unknown', platform: false }
        lastClassificationState = classification.state
        const region = logLobbyRegionIfMatched(bot, config, 'portal-test-loop')
        const regionText = region ? ` region=${region.name}${region.action ? ` action=${region.action}` : ''}` : ''
        const sceneText = runtime?.meteor?.best
          ? ` scene=${runtime.meteor.best.label} action=${runtime.meteor.best.action} score=${runtime.meteor.best.score.toFixed(3)}`
          : ''
        console.log(`[PORTAL-TEST] ${label} elapsed=${Math.round(elapsedMs / 1000)}s state=${classification.state}${regionText}${sceneText} spawned=${spawnedCount} chatLogin=${bot.__nervChatLogin?.loggedIn === true} pos=${formatBotPosition(bot)} vel=${formatVec3ForLog(bot?.entity?.velocity)} attempts=${portalAttempts}/${maxPortalAttempts}`)

        if (classification.platform === true || (isPositionUsable(bot?.entity?.position) && isPositionInsidePlatformBounds(bot.entity.position, config))) {
          finishAndQuit({ success: true, endReason: 'portal-test-platform-reached' })
          return
        }

        if (elapsedMs >= maxMs) {
          finishAndQuit({ success: false, endReason: 'portal-test-timeout' })
          return
        }

        if (shouldHoldForOfflineChatLogin(bot) && !bot.__nervChatLogin?.loggedIn) {
          trySendChatLoginCommand(bot, 'portal-test-loop')
          return
        }

        if (classification.state === 'transfer-lobby') return

        const action = String(runtime?.meteor?.best?.action || region?.action || '').toLowerCase()
        const shouldTryPortal = action === 'login-portal' || action === 'spawn-portal' || classification.state === 'lobby-region' || classification.state.endsWith('-scene')
        if (!shouldTryPortal || portalAttempts >= maxPortalAttempts) return

        portalAttempts += 1
        console.log(`[PORTAL-TEST] ${label} attempting portal automation ${portalAttempts}/${maxPortalAttempts}. state=${classification.state}${action ? ` action=${action}` : ''}`)
        try {
          const attempted = await runLobbyPortalAutomation(bot, config)
          portalSuccess = portalSuccess || attempted
          console.log(`[PORTAL-TEST] ${label} portal automation result=${attempted} pos=${formatBotPosition(bot)}`)
        } catch (err) {
          console.log(`[PORTAL-TEST-WARN] ${label} portal automation failed: ${err?.message || err}`)
          stopBotMovement(bot)
        }
        } finally {
          portalLoopBusy = false
        }
      })()
    }, Math.max(500, toNumber(getCliValue('--portal-log-ms'), 1500)))
    loopTimer.unref?.()

    bot.on('spawn', () => {
      spawnedCount += 1
      console.log(`[PORTAL-TEST] ${label} spawn event ${spawnedCount}. pos=${formatBotPosition(bot)} vel=${formatVec3ForLog(bot?.entity?.velocity)}`)
    })

    bot.on('nerv-chat-login-success', (info) => {
      console.log(`[PORTAL-TEST] ${label} offline chat login confirmed reason=${info?.reason || 'unknown'}. Waiting for portal scene/position.`)
    })

    bot.on('messagestr', (message) => {
      if (isTokenVerificationText(message)) {
        verificationCode = extractVerificationCode(message)
        console.log(`[PORTAL-TEST-STOP] ${label} token/web verification detected code=${verificationCode || 'unknown'}.`)
        finishAndQuit({ endReason: 'token-verification-required', verificationCode })
      }
    })

    bot.on('kicked', (reason) => {
      kickedText = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${kickedText}`)
      if (isTokenVerificationText(kickedText)) {
        verificationCode = extractVerificationCode(kickedText)
        settle({ endReason: 'token-verification-required', verificationCode })
      }
    })

    bot.on('error', (err) => {
      lastErrorText = err?.message || String(err)
      console.log('[ERROR]', lastErrorText)
    })

    bot.on('end', (reason) => {
      const text = reason || 'disconnected'
      console.log(`[END] ${text}`)
      settle({ endReason: text })
    })
  })
}

async function run6b6tPortalMatrixTest(config) {
  const accounts = get6b6tTestAccounts(config)
  if (!accounts.length) {
    throw new Error('No account found for --test-6b6t-portal. Use --test-account=<name> or enable one account.')
  }

  const hosts = get6b6tTestHosts(config)
  const versions = get6b6tTestVersions(config)
  const maxCases = Math.max(1, toNumber(getCliValue('--max-cases'), accounts.length * hosts.length * versions.length))
  const normalDelayMs = Math.max(10000, toNumber(getCliValue('--normal-retry-ms'), 10000))
  const ddosDelayMs = Math.max(31000, toNumber(getCliValue('--ddos-retry-ms'), 32000))
  const results = []
  let caseNo = 0

  console.log(`[TEST-6B6T-PORTAL] Matrix starting. accounts=${accounts.map((a) => `${a.name}/${getAccountAuthLabel(config, a)} passwordConfigured=${Boolean(a.botOverrides?.loginPassword || a.botOverrides?.password || a.botOverrides?.chatLoginPassword)}`).join(', ')} hosts=${hosts.join(', ')} versions=${versions.join(', ')} maxCases=${maxCases}`)

  for (const version of versions) {
    for (const host of hosts) {
      for (const account of accounts) {
        if (caseNo >= maxCases) break
        caseNo += 1
        const label = `case=${caseNo} account=${account.name} auth=${getAccountAuthLabel(config, account)} host=${host} version=${version}`
        const testConfig = make6b6tPortalTestConfig(config, account, host, version)
        console.log(`[TEST-6B6T-PORTAL-CONFIG] ${label} config=${JSON.stringify({
          host,
          username: testConfig.bot.username,
          auth: testConfig.bot.auth,
          version: testConfig.bot.version,
          portalCount: getPortalCount(getLobbyPortalConfig(testConfig), testConfig),
          loginPasswordConfigured: Boolean(testConfig.bot.loginPassword || testConfig.bot.password || testConfig.bot.chatLoginPassword),
          lobbyPortal: testConfig.bot.lobbyPortal
        })}`)
        const result = await run6b6tPortalTestSession(testConfig, label)
        results.push(result)
        console.log(`[TEST-6B6T-PORTAL-RESULT] ${label} success=${result.success} end=${result.endReason} portalAttempts=${result.portalAttempts} portalSuccess=${result.portalSuccess} lastState=${result.lastClassificationState} packets=${result.packetPositions} posRepairs=${result.positionRepairs} velRepairs=${result.velocityRepairs} finalPos=${JSON.stringify(result.finalPosition)} ddos=${result.ddos} tokenVerification=${result.tokenVerification} verificationCode=${result.verificationCode || ''}`)
        if (result.success) {
          console.log(`[TEST-6B6T-PORTAL-DONE] Portal test reached final platform with ${label}.`)
          return results
        }
        if (caseNo >= maxCases) break
        const waitMs = result.ddos ? ddosDelayMs : normalDelayMs
        console.log(`[TEST-6B6T-PORTAL] Waiting ${waitMs}ms before next case. reason=${result.ddos ? 'ddos-protection' : result.endReason}`)
        await delay(waitMs)
      }
      if (caseNo >= maxCases) break
    }
    if (caseNo >= maxCases) break
  }

  console.log(`[TEST-6B6T-PORTAL-DONE] Matrix finished. cases=${results.length}`)
  return results
}

function getSpatialPortalFile(config) {
  const explicit = getCliValue('--spatial-portal-file') || getCliValue('--portal-spatial-file')
  if (explicit) return path.resolve(process.cwd(), explicit)
  const meteorFile = config?.advanced?.meteorSceneAwareness?.file
  if (meteorFile) return path.resolve(process.cwd(), meteorFile)
  return getSpatialAwarenessFile(config)
}

function inferSpatialPortalSceneAction(scene) {
  const dimension = String(scene?.dimension || '').toLowerCase()
  const position = buildMeteorScenePlayerPoint(scene)
  const portalPoint = buildMeteorScenePortalPoint(scene)
  const label = String(scene?.label || '').toLowerCase()
  if (dimension.includes('the_end')) return 'login-portal'
  if (dimension.includes('overworld') && portalPoint && Math.abs(portalPoint.x) < 5000 && Math.abs(portalPoint.z) < 5000) return 'spawn-portal'
  if (label.includes('login')) return 'login-portal'
  if (label.includes('spawn')) return 'spawn-portal'
  if (position && Math.abs(position.x) < 5000 && Math.abs(position.z) < 5000) return 'spawn-portal'
  return 'unknown'
}

function getSpatialPortalSceneStage(scene) {
  const label = String(scene?.label || '').toLowerCase()
  if (scene?.insidePortalBlock === true || label.includes('portal-enter')) return 3
  if (label.includes('teleport')) return 2
  if (label.includes('start')) return 1
  return 0
}

function loadSpatialPortalSteps(config) {
  const file = getSpatialPortalFile(config)
  const snapshot = readOptionalJson(file)
  const scenes = [
    ...(Array.isArray(snapshot?.scenes) ? snapshot.scenes : []),
    ...(snapshot?.lastScene ? [snapshot.lastScene] : [])
  ]

  const seen = new Set()
  const steps = []
  for (const scene of scenes) {
    const playerPoint = buildMeteorScenePlayerPoint(scene)
    const movementHint = buildMeteorSceneMovementHint(scene)
    const portalPoint = buildMeteorScenePortalPoint(scene)
    if (!playerPoint || (!movementHint && !portalPoint)) continue
    const action = inferSpatialPortalSceneAction(scene)
    if (action !== 'login-portal' && action !== 'spawn-portal') continue
    const dimension = String(scene?.dimension || '').toLowerCase()
    const key = [
      action,
      dimension,
      Math.round(playerPoint.x),
      Math.round(playerPoint.y),
      Math.round(playerPoint.z),
      portalPoint ? `${Math.round(portalPoint.x)},${Math.round(portalPoint.y)},${Math.round(portalPoint.z)}` : 'no-portal',
      scene?.insidePortalBlock === true ? 'inside' : 'outside'
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    steps.push({
      label: String(scene?.label || 'spatial-portal-step'),
      action,
      dimension,
      score: 1,
      topScore: 1,
      signatureScore: 1,
      dimensionScore: 1,
      chatScore: 1,
      portalStateScore: scene?.insidePortalBlock === true ? 1 : 0,
      flowStage: getSpatialPortalSceneStage(scene),
      capturedAtMs: getMeteorSceneCapturedAtMs(scene),
      playerPoint,
      portalPoint,
      movementHint,
      insidePortalBlock: scene?.insidePortalBlock === true,
      scene
    })
  }

  return {
    file,
    steps: steps.sort((a, b) => {
      const actionDelta = (a.action === 'login-portal' ? 0 : 1) - (b.action === 'login-portal' ? 0 : 1)
      if (actionDelta !== 0) return actionDelta
      const dimensionDelta = a.dimension.localeCompare(b.dimension)
      if (dimensionDelta !== 0) return dimensionDelta
      const stageDelta = a.flowStage - b.flowStage
      if (stageDelta !== 0) return stageDelta
      return a.capturedAtMs - b.capturedAtMs
    })
  }
}

function chooseSpatialPortalStep(bot, config, steps) {
  const pos = getSpatialReferencePosition(bot, config, 'choose-spatial-portal-step')
  if (isPositionMissing(pos) || !Array.isArray(steps) || !steps.length) return null
  const currentDimension = String(bot?.game?.dimension || '').toLowerCase()
  const radius = Math.max(4, toNumber(getCliValue('--spatial-portal-radius'), 96))
  const candidates = steps
    .map((step) => {
      const distance = distanceToPoint(pos, step.playerPoint)
      const dimensionBonus = currentDimension && step.dimension && currentDimension === step.dimension ? -1000 : 0
      const insidePenalty = step.insidePortalBlock ? 4 : 0
      return { step, distance, score: distance + dimensionBonus + insidePenalty }
    })
    .filter((entry) => entry.distance <= radius || (currentDimension && entry.step.dimension === currentDimension && entry.distance <= radius * 4))
    .sort((a, b) => a.score - b.score)
  return candidates[0] || null
}

function chooseSavedSpatialPortalStep(bot, config, allowedActions = null) {
  const portalData = loadSpatialPortalSteps(config)
  const allowed = Array.isArray(allowedActions) && allowedActions.length
    ? new Set(allowedActions.map((value) => String(value || '').toLowerCase()).filter(Boolean))
    : null
  const steps = allowed
    ? portalData.steps.filter((step) => allowed.has(String(step?.action || '').toLowerCase()))
    : portalData.steps
  const entry = chooseSpatialPortalStep(bot, config, steps)
  if (!entry) return null
  return {
    ...entry,
    file: portalData.file,
    totalSteps: portalData.steps.length
  }
}

async function runSpatialPortalStep(bot, config, entry, attempt) {
  const step = entry?.step
  if (!step || !isBotSessionLive(bot)) return false
  ensureUsableEntityState(bot, config, `spatial-portal-${attempt}`, { allowPlatformSeed: false, log: false })
  const timeoutMs = Math.max(5000, toNumber(getCliValue('--spatial-portal-path-ms'), toNumber(getLobbyPortalConfig(config)?.pathTimeoutMs, 60000)))
  const entryMs = Math.max(250, toNumber(getCliValue('--spatial-portal-entry-ms'), toNumber(getLobbyPortalConfig(config)?.portalEntryMs, 3000)))
  const runtimePos = getSpatialReferencePosition(bot, config, `spatial-portal-${attempt}`)
  const portalDistance = step.portalPoint ? distanceToPoint(runtimePos, step.portalPoint) : Number.POSITIVE_INFINITY
  console.log(`[SPATIAL-PORTAL] attempt=${attempt} selected label=${step.label} action=${step.action} dimension=${step.dimension || 'unknown'} distance=${entry.distance.toFixed(2)} portalDistance=${Number.isFinite(portalDistance) ? portalDistance.toFixed(2) : 'n/a'} pos=${formatBotPosition(bot)}`)

  bot.__nervAllowOffPlatformNavigation = true
  bot.__nervPlatformWatchdogActive = false

  if (step.portalPoint && portalDistance > 3.5) {
    await gotoLobbyPortalPoint(bot, config, { ...step.portalPoint, range: 2, exact: false }, `spatial portal ${step.label}`, timeoutMs, 2)
  }

  const replayed = await replayMeteorSceneMovementSequence(bot, config, { best: step }, entryMs, `spatial-portal-${attempt}`)
    || await replayMeteorSceneMovement(bot, config, { best: step }, entryMs, `spatial-portal-${attempt}-fallback`)
  if (!replayed) await holdForwardIntoPortal(bot, config, entryMs)
  return true
}

function run6b6tSpatialPortalTestSession(config, label) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.__nervSessionActive = true
    bot.loadPlugin(pathfinder)
    installPlatformSafety(bot, config)
    installPhysicsNaNProbe(bot, config, `${label} spatial-portal`)

    const portalData = loadSpatialPortalSteps(config)
    let settled = false
    let kickedText = ''
    let lastErrorText = ''
    let verificationCode = ''
    let spawnedCount = 0
    let portalAttempts = 0
    let portalLoopBusy = false
    let lastState = ''
    const startedAt = Date.now()
    const maxMs = Math.max(30000, toNumber(getCliValue('--spatial-portal-ms'), toNumber(getCliValue('--portal-seconds'), 180) * 1000))
    const maxPortalAttempts = Math.max(1, toNumber(getCliValue('--spatial-portal-attempts'), 8))

    console.log(`[SPATIAL-PORTAL] ${label} loaded file=${portalData.file} steps=${portalData.steps.length}`)
    for (const step of portalData.steps.slice(0, 12)) {
      const pos = step.playerPoint
      const portal = step.portalPoint
      console.log(`[SPATIAL-PORTAL-STEP] action=${step.action} label=${step.label} dim=${step.dimension || 'unknown'} player=${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} portal=${portal ? `${Math.round(portal.x)},${Math.round(portal.y)},${Math.round(portal.z)}` : 'none'} inside=${step.insidePortalBlock}`)
    }

    const settle = (result = {}) => {
      if (settled) return
      settled = true
      clearInterval(loopTimer)
      bot.__nervSessionActive = false
      bot.__nervAllowOffPlatformNavigation = false
      stopBotMovement(bot)
      const probe = bot.__nervPhysicsProbe || {}
      resolve({
        label,
        success: result.success === true,
        endReason: result.endReason || 'spatial-portal-ended',
        spawnedCount,
        portalAttempts,
        lastState,
        lastError: lastErrorText,
        kickedReason: kickedText,
        verificationCode: result.verificationCode || verificationCode || extractVerificationCode(`${kickedText} ${lastErrorText}`),
        packetPositions: probe.packetPositions || 0,
        positionRepairs: probe.positionRepairs || 0,
        velocityRepairs: probe.velocityRepairs || 0,
        finalPosition: cloneFinitePosition(bot?.entity?.position),
        tokenVerification: isTokenVerificationText(`${result.endReason || ''} ${kickedText} ${lastErrorText}`),
        ddos: isDdosProtectionText(`${result.endReason || ''} ${kickedText} ${lastErrorText}`),
        spatialFile: portalData.file,
        spatialSteps: portalData.steps.length
      })
    }

    const finishAndQuit = (result) => {
      settle(result)
      try { bot.quit(result?.endReason || 'spatial-portal-complete') } catch { }
    }

    const loopTimer = setInterval(() => {
      void (async () => {
        if (settled || !isBotSessionLive(bot) || portalLoopBusy) return
        portalLoopBusy = true
        try {
          const elapsedMs = Date.now() - startedAt
          const pos = bot?.entity?.position
          const classification = classifySpatialPosition(pos, config)
          lastState = classification.state
          const region = logLobbyRegionIfMatched(bot, config, 'spatial-portal-loop')
          const regionText = region ? ` region=${region.name}${region.action ? ` action=${region.action}` : ''}` : ''
          const chosen = chooseSpatialPortalStep(bot, config, portalData.steps)
          const chosenText = chosen ? ` chosen=${chosen.step.label}/${chosen.step.action} dist=${chosen.distance.toFixed(1)}` : ''
          console.log(`[SPATIAL-PORTAL] ${label} elapsed=${Math.round(elapsedMs / 1000)}s state=${classification.state}${regionText}${chosenText} spawned=${spawnedCount} chatLogin=${bot.__nervChatLogin?.loggedIn === true} pos=${formatBotPosition(bot)} vel=${formatVec3ForLog(bot?.entity?.velocity)} attempts=${portalAttempts}/${maxPortalAttempts}`)

          if (classification.platform === true || (isPositionUsable(pos) && isPositionInsidePlatformBounds(pos, config))) {
            finishAndQuit({ success: true, endReason: 'spatial-portal-platform-reached' })
            return
          }

          if (elapsedMs >= maxMs) {
            finishAndQuit({ success: false, endReason: 'spatial-portal-timeout' })
            return
          }

          if (shouldHoldForOfflineChatLogin(bot) && !bot.__nervChatLogin?.loggedIn) {
            trySendChatLoginCommand(bot, 'spatial-portal-loop')
            return
          }

          if (classification.state === 'transfer-lobby') return
          if (!chosen || portalAttempts >= maxPortalAttempts) return

          portalAttempts += 1
          const moved = await runSpatialPortalStep(bot, config, chosen, portalAttempts)
          console.log(`[SPATIAL-PORTAL] ${label} movement result=${moved} pos=${formatBotPosition(bot)}`)
        } catch (err) {
          console.log(`[SPATIAL-PORTAL-WARN] ${label} failed: ${err?.message || err}`)
          stopBotMovement(bot)
        } finally {
          portalLoopBusy = false
        }
      })()
    }, Math.max(500, toNumber(getCliValue('--spatial-portal-log-ms'), 1500)))
    loopTimer.unref?.()

    bot.on('spawn', () => {
      spawnedCount += 1
      console.log(`[SPATIAL-PORTAL] ${label} spawn event ${spawnedCount}. pos=${formatBotPosition(bot)} vel=${formatVec3ForLog(bot?.entity?.velocity)}`)
    })

    bot.on('nerv-chat-login-success', (info) => {
      console.log(`[SPATIAL-PORTAL] ${label} offline chat login confirmed reason=${info?.reason || 'unknown'}.`)
    })

    bot.on('messagestr', (message) => {
      if (isTokenVerificationText(message)) {
        verificationCode = extractVerificationCode(message)
        console.log(`[SPATIAL-PORTAL-STOP] ${label} token/web verification detected code=${verificationCode || 'unknown'}.`)
        finishAndQuit({ endReason: 'token-verification-required', verificationCode })
      }
    })

    bot.on('kicked', (reason) => {
      kickedText = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${kickedText}`)
      if (isTokenVerificationText(kickedText)) {
        verificationCode = extractVerificationCode(kickedText)
        settle({ endReason: 'token-verification-required', verificationCode })
      }
    })

    bot.on('error', (err) => {
      lastErrorText = err?.message || String(err)
      console.log('[ERROR]', lastErrorText)
    })

    bot.on('end', (reason) => {
      const text = reason || 'disconnected'
      console.log(`[END] ${text}`)
      settle({ endReason: text })
    })
  })
}

async function run6b6tSpatialPortalMatrixTest(config) {
  const accounts = get6b6tTestAccounts(config)
  if (!accounts.length) {
    throw new Error('No account found for --test-spatial-portal. Use --test-account=<name> or enable one account.')
  }

  const hosts = get6b6tTestHosts(config)
  const versions = get6b6tTestVersions(config)
  const maxCases = Math.max(1, toNumber(getCliValue('--max-cases'), accounts.length * hosts.length * versions.length))
  const normalDelayMs = Math.max(10000, toNumber(getCliValue('--normal-retry-ms'), 10000))
  const ddosDelayMs = Math.max(31000, toNumber(getCliValue('--ddos-retry-ms'), 32000))
  const results = []
  let caseNo = 0

  console.log(`[TEST-SPATIAL-PORTAL] Matrix starting. accounts=${accounts.map((a) => `${a.name}/${getAccountAuthLabel(config, a)}`).join(', ')} hosts=${hosts.join(', ')} versions=${versions.join(', ')} maxCases=${maxCases}`)

  for (const version of versions) {
    for (const host of hosts) {
      for (const account of accounts) {
        if (caseNo >= maxCases) break
        caseNo += 1
        const label = `case=${caseNo} account=${account.name} auth=${getAccountAuthLabel(config, account)} host=${host} version=${version}`
        const testConfig = make6b6tPortalTestConfig(config, account, host, version)
        console.log(`[TEST-SPATIAL-PORTAL-CONFIG] ${label} config=${JSON.stringify({
          host,
          username: testConfig.bot.username,
          auth: testConfig.bot.auth,
          version: testConfig.bot.version,
          spatialPortalFile: getSpatialPortalFile(testConfig),
          loginPasswordConfigured: Boolean(testConfig.bot.loginPassword || testConfig.bot.password || testConfig.bot.chatLoginPassword)
        })}`)
        const result = await run6b6tSpatialPortalTestSession(testConfig, label)
        results.push(result)
        console.log(`[TEST-SPATIAL-PORTAL-RESULT] ${label} success=${result.success} end=${result.endReason} attempts=${result.portalAttempts} steps=${result.spatialSteps} file=${result.spatialFile} packets=${result.packetPositions} posRepairs=${result.positionRepairs} velRepairs=${result.velocityRepairs} finalPos=${JSON.stringify(result.finalPosition)} ddos=${result.ddos} tokenVerification=${result.tokenVerification} verificationCode=${result.verificationCode || ''}`)
        if (result.success) {
          console.log(`[TEST-SPATIAL-PORTAL-DONE] Reached final platform with ${label}.`)
          return results
        }
        if (caseNo >= maxCases) break
        const waitMs = result.ddos ? ddosDelayMs : normalDelayMs
        console.log(`[TEST-SPATIAL-PORTAL] Waiting ${waitMs}ms before next case. reason=${result.ddos ? 'ddos-protection' : result.endReason}`)
        await delay(waitMs)
      }
      if (caseNo >= maxCases) break
    }
    if (caseNo >= maxCases) break
  }

  console.log(`[TEST-SPATIAL-PORTAL-DONE] Matrix finished. cases=${results.length}`)
  return results
}

async function runWorkerReconnectLoop(workerConfig, assignment, reconnect) {
  return logContext.run({ botName: assignment.name }, async () => {
    await delay(Math.max(0, toNumber(assignment.joinDelayMs, 0)))
    console.log(`[MULTI-LAUNCH] ${assignment.name} role=${assignment.role} joining after ${assignment.joinDelayMs}ms interval=${assignment.interval.start}-${assignment.interval.end}`)

    const runtimeHosts = is6b6tConfig(workerConfig) ? get6b6tHosts(workerConfig) : []
    let runtimeHostIndex = Math.max(0, runtimeHosts.findIndex((host) => host === workerConfig.bot?.host))
    if (runtimeHostIndex < 0) runtimeHostIndex = 0
    if (runtimeHosts.length > 1) {
      console.log(`[6B6T-HOSTS] ${assignment.name} rotation enabled: ${runtimeHosts.join(', ')}. starting=${runtimeHosts[runtimeHostIndex]}`)
    }

    let attempt = 1
    while (true) {
      if (attempt > 1) {
        console.log(`[RECONNECT] Starting attempt ${attempt}/${reconnect.maxAttempts}.`)
      }

      writeMultiWorkerHeartbeat(workerConfig, assignment)
      const heartbeatMs = Math.max(1000, toNumber(workerConfig.multiUser?.heartbeatMs, 5000))
      const heartbeatTimer = setInterval(() => {
        try { writeMultiWorkerHeartbeat(workerConfig, assignment) } catch { }
      }, heartbeatMs)
      let session
      if (runtimeHosts.length > 1) {
        runtimeHostIndex = await chooseBest6b6tHostIndex(workerConfig, runtimeHosts, runtimeHostIndex, assignment.name || 'worker')
      }
      const activeHost = runtimeHosts.length ? runtimeHosts[runtimeHostIndex] : workerConfig.bot?.host
      const sessionConfig = activeHost ? makeHostConfig(workerConfig, activeHost) : workerConfig
      try {
        session = await runSingleSession(sessionConfig, attempt)
        session = await resolveTokenVerificationSession({
          session,
          account: assignment.name || sessionConfig.bot?.username || 'MapartBot',
          host: activeHost || sessionConfig.bot?.host || 'unknown-host',
          version: sessionConfig.bot?.version || 'unknown-version',
          sessionNumber: attempt,
          retryDelayMs: Math.max(1000, Math.min(5000, toNumber(reconnect.delayMs, 3000))),
          rerun: async () => await runSingleSession(sessionConfig, attempt),
          config: sessionConfig
        })
      } finally {
        clearInterval(heartbeatTimer)
      }
      const retryable = shouldRetryReconnect(session, sessionConfig)
      const forceDashboardResetReconnect = shouldForceReconnectForDashboardReset(session)
      const operatorPaused = isOperatorPauseHoldActive(sessionConfig)
      const reconnectAllowed = reconnect.enabled || shouldForceReconnectForPlatformStall(session, sessionConfig) || forceDashboardResetReconnect
      console.log(`[SESSION] attempt=${attempt} host=${activeHost || sessionConfig.bot?.host || 'default'} end=${session.endReason} retryable=${retryable} successfulStartup=${session.successfulStartup === true}`)

      if (operatorPaused && !forceDashboardResetReconnect) {
        console.log(`[RECONNECT] Operator pause is active; not reconnecting after session end reason=${session.endReason}.`)
        break
      }

      if (!reconnectAllowed || !retryable || (attempt >= reconnect.maxAttempts && !forceDashboardResetReconnect)) {
        break
      }

      const retryDelayMs = getReconnectDelayForSession(session, reconnect)
      if (runtimeHosts.length > 1 && session.successfulStartup !== true) {
        const previousHost = runtimeHosts[runtimeHostIndex]
        runtimeHostIndex = (runtimeHostIndex + 1) % runtimeHosts.length
        console.log(`[6B6T-HOSTS] ${assignment.name} switching host after failed startup: ${previousHost} -> ${runtimeHosts[runtimeHostIndex]}`)
      }

      console.log(`[RECONNECT] Retrying in ${retryDelayMs}ms. reason=${session.endReason}`)
      await delay(retryDelayMs)
      if (session.successfulStartup === true) {
        if (attempt > 1) console.log('[RECONNECT] Previous session reached startup; resetting reconnect attempt counter.')
        attempt = 1
      } else {
        attempt += 1
      }
    }
  })
}

async function runMultiUserLive(config, reconnect) {
  const plan = buildMultiUserPlan(config)
  if (plan.mode !== 'file') {
    throw new Error(`Unsupported multiUser.mode=${plan.mode}; only "file" is implemented.`)
  }
  if (!plan.master) {
    throw new Error('multiUser requires one enabled master bot.')
  }
  if (config.multiUser?.launchFromSingleProcess === false) {
    throw new Error('multiUser.launchFromSingleProcess=false is not implemented yet. Set it true to launch the configured roster from this process.')
  }

  const runtime = resolveMultiRuntimeForLaunch(config, plan)
  config.multiUser = { ...(config.multiUser || {}), runtime }
  writeMultiMasterState(config, plan, runtime.resumed === true, { jobId: runtime.jobId, generation: runtime.generation, phase: runtime.resumed ? 'resumed' : 'starting' })

  console.log(`[MULTI] Starting ${plan.assignments.length} worker(s) with file coordination. syncFolder=${plan.syncFolder}`)
  for (const entry of plan.assignments) {
    console.log(`[MULTI] ${entry.role.toUpperCase()} ${entry.name}: interval=${entry.interval.start}-${entry.interval.end} joinDelayMs=${entry.joinDelayMs} startDelayMs=${entry.startDelayMs}`)
  }

  const workers = plan.assignments.map((assignment) => {
    const workerConfig = makeMultiWorkerConfig(config, plan, assignment)
    return runWorkerReconnectLoop(workerConfig, assignment, reconnect)
  })

  await Promise.all(workers)
}

async function start() {
  ensureStdinCommandInterface()
  const config = loadConfig()
  if (isWaitForCommandEnabled()) {
    config.printer = {
      ...(config.printer || {}),
      startOnSpawn: false
    }
    console.log('[CONTROL] wait-for-command mode enabled. The bot will connect and remain idle until a dashboard or terminal start command is issued.')
  }
  const cliPostPrintTestOnly = hasCliFlag('--test-post-print') || hasCliFlag('--post-print-test-only')
  const cliPostPrintFullTest = hasCliFlag('--test-post-print-full') || hasCliFlag('--post-print-test-full')
  if (cliPostPrintTestOnly || cliPostPrintFullTest) {
    config.printer = {
      ...(config.printer || {}),
      startOnSpawn: true,
      postPrintTestOnly: true
    }
    if (cliPostPrintTestOnly) {
      config.advanced = {
        ...(config.advanced || {}),
        postPrintResetEnabled: false,
        postPrintWalkToCenter: false
      }
      console.log('[TEST-POSTPRINT] Running post-print workflow only. Printing, reset, and final center walk are disabled.')
    } else {
      config.advanced = {
        ...(config.advanced || {}),
        postPrintResetEnabled: true,
        postPrintSkipResetInteraction: false,
        postPrintWalkToCenter: true,
        resetChestWaitMs: 2000,
        resetChestCloseSettleMs: 0
      }
      console.log('[TEST-POSTPRINT] Running post-print workflow only. Reset and final center walk are enabled; reset chest stays open for 2000ms.')
    }
  }
  const reconnect = getReconnectConfig(config)
  logStartupSummary(config, reconnect)

  if (hasCliFlag('--test-dump')) {
    console.log('[TEST-DUMP] Running isolated dump test only.')
    await runSingleDumpTestSession(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-moving-place')) {
    console.log('[TEST-MOVE-PLACE] Running isolated moving placement test only.')
    await runSingleMovingPlaceTestSession(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-nerv-scanner')) {
    console.log('[TEST-NERV-SCANNER] Running isolated NERV-style scanner placement test only.')
    await runSingleNervScannerTestSession(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-nerv-workload')) {
    console.log('[TEST-NERV-WORKLOAD] Running isolated NERV-style time workload placement test only.')
    await runSingleNervWorkloadTestSession(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-inventory-plan')) {
    const inventoryRows = getCliValue('--inventory-rows')
    if (inventoryRows != null) {
      config.advanced = { ...(config.advanced || {}), inventoryCycleTestRows: Math.max(0, toNumber(inventoryRows, 0)) }
    }
    console.log('[TEST-INVENTORY-PLAN] Running isolated NERV-style inventory plan test only.')
    await runSingleInventoryPlanTestSession(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-inventory-cycle')) {
    const inventoryRows = getCliValue('--inventory-rows')
    if (inventoryRows != null) {
      config.advanced = { ...(config.advanced || {}), inventoryCycleTestRows: Math.max(0, toNumber(inventoryRows, 0)) }
    }
    console.log('[TEST-INVENTORY-CYCLE] Running isolated NERV-style inventory dump/restock cycle only.')
    await runSingleInventoryCycleTestSession(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-repair')) {
    console.log('[TEST-REPAIR] Running isolated repair scan/fix/verify cycle only.')
    await runSingleRepairTestSession(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-multi-user-plan')) {
    console.log('[TEST-MULTI] Running isolated multi-user planning test only. No bot will connect.')
    await runMultiUserPlanTest(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-6b6t-lobby')) {
    console.log('[TEST-6B6T] Running isolated 6b6t host/version/lobby matrix test only. Printer will not start.')
    await run6b6tLobbyMatrixTest(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-6b6t-physics') || hasCliFlag('--test-physics-naN') || hasCliFlag('--test-physics-nan')) {
    console.log('[TEST-6B6T-PHYSICS] Running isolated 6b6t physics/NaN diagnostic test only. Printer will not start.')
    await run6b6tPhysicsMatrixTest(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-6b6t-portal') || hasCliFlag('--test-portal')) {
    console.log('[TEST-6B6T-PORTAL] Running isolated 6b6t portal automation test only. Printer/spatial will not start.')
    await run6b6tPortalMatrixTest(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-spatial-portal') || hasCliFlag('--test-6b6t-spatial-portal')) {
    console.log('[TEST-SPATIAL-PORTAL] Running isolated saved spatial portal route test only. Printer/spatial scan will not start.')
    await run6b6tSpatialPortalMatrixTest(config)
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (hasCliFlag('--test-spatial') || hasCliFlag('--scan-spatial') || hasCliFlag('--test-spatial-awareness')) {
    applySingleBotRoster(config)
    console.log('[SPATIAL] Running isolated spatial awareness scan only. Printer will not start.')
    const session = await runSpatialAwarenessTestSession(config)
    console.log(`[SPATIAL-RESULT] success=${session.success} end=${session.endReason} file=${session.file || ''} summary=${JSON.stringify(session.summary || {})}`)
    setTimeout(() => process.exit(session.success ? 0 : 1), 100)
    return
  }

  applySingleBotRoster(config)

  if (shouldRunMultiUser(config)) {
    await runMultiUserLive(config, reconnect)
    return
  }

  const runtimeHosts = is6b6tConfig(config) ? get6b6tHosts(config) : []
  let runtimeHostIndex = Math.max(0, runtimeHosts.findIndex((host) => host === config.bot?.host))
  if (runtimeHostIndex < 0) runtimeHostIndex = 0
  if (runtimeHosts.length > 1) {
    console.log(`[6B6T-HOSTS] Rotation enabled: ${runtimeHosts.join(', ')}. starting=${runtimeHosts[runtimeHostIndex]}`)
  }

  let continueOuter = true
  while (continueOuter) {
    continueOuter = false
    let attempt = 1
    let lastEndReason = null

    while (true) {
      if (attempt > 1) {
        console.log(`[RECONNECT] Starting attempt ${attempt}/${reconnect.maxAttempts}.`)
      }

      if (runtimeHosts.length > 1) {
        runtimeHostIndex = await chooseBest6b6tHostIndex(config, runtimeHosts, runtimeHostIndex, 'runtime')
      }
      const activeHost = runtimeHosts.length ? runtimeHosts[runtimeHostIndex] : config.bot?.host
      const sessionConfig = activeHost ? makeHostConfig(config, activeHost) : config
      let session = await runSingleSession(sessionConfig, attempt)
      session = await resolveTokenVerificationSession({
        session,
        account: sessionConfig.bot?.username || 'MapartBot',
        host: activeHost || sessionConfig.bot?.host || 'unknown-host',
        version: sessionConfig.bot?.version || 'unknown-version',
        sessionNumber: attempt,
        retryDelayMs: Math.max(1000, Math.min(5000, toNumber(reconnect.delayMs, 3000))),
        rerun: async () => await runSingleSession(sessionConfig, attempt),
        config: sessionConfig
      })
      const retryable = shouldRetryReconnect(session, sessionConfig)
      const forceDashboardResetReconnect = shouldForceReconnectForDashboardReset(session)
      const operatorPaused = isOperatorPauseHoldActive(sessionConfig)
      const reconnectAllowed = reconnect.enabled || shouldForceReconnectForPlatformStall(session, sessionConfig) || forceDashboardResetReconnect
      lastEndReason = session.endReason
      console.log(`[SESSION] attempt=${attempt} host=${activeHost || sessionConfig.bot?.host || 'default'} end=${session.endReason} retryable=${retryable} successfulStartup=${session.successfulStartup === true}`)

      if (operatorPaused && !forceDashboardResetReconnect) {
        console.log(`[RECONNECT] Operator pause is active; not reconnecting after session end reason=${session.endReason}.`)
        break
      }

      if (!reconnectAllowed) {
        break
      }

      if (!retryable) {
        console.log(`[RECONNECT] Not retrying due to non-retryable reason: ${session.endReason}`)
        break
      }

      if (attempt >= reconnect.maxAttempts && !forceDashboardResetReconnect) {
        console.log(`[RECONNECT] Stopping after ${attempt} attempts. Last reason: ${session.endReason}`)
        break
      }

      const retryDelayMs = getReconnectDelayForSession(session, reconnect)
      if (runtimeHosts.length > 1 && session.successfulStartup !== true) {
        const previousHost = runtimeHosts[runtimeHostIndex]
        runtimeHostIndex = (runtimeHostIndex + 1) % runtimeHosts.length
        console.log(`[6B6T-HOSTS] Switching host after failed startup: ${previousHost} -> ${runtimeHosts[runtimeHostIndex]}`)
      }

      console.log(`[RECONNECT] Retrying in ${retryDelayMs}ms. reason=${session.endReason}`)
      await delay(retryDelayMs)
      if (session.successfulStartup === true) {
        if (attempt > 1) console.log('[RECONNECT] Previous session reached startup; resetting reconnect attempt counter.')
        attempt = 1
      } else {
        attempt += 1
      }
    }

    if (String(lastEndReason || '').includes('dashboard-disconnect') && config?.dashboard?.enabled !== false) {
      printingIntentActive = false
      const shouldRestart = await standbyWaitForReconnect(config)
      if (shouldRestart) {
        continueOuter = true
      }
    }
  }
}

initLogger()

start().catch((err) => {
  console.error('[FATAL]', err?.message || err)
  process.exitCode = 1
})
