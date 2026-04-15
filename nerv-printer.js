const restockFailureCache = new Map()
const unavailableMaterialCache = new Set()
const fs = require('fs')
const path = require('path')
const { AsyncLocalStorage } = require('async_hooks')
const mineflayer = require('mineflayer')
const nbt = require('prismarine-nbt')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { createPlacementWorkload } = require('./nerv-printer/placement/workload')

const placementWorkload = createPlacementWorkload({
  toNumber,
  delay,
  GoalNear,
  estimateNeededFromLookahead,
  restockMaterial,
  countInventoryItems,
  findNervScannerCandidate,
  placeNervScannerTarget
})

const CONFIG_FILE = path.resolve(process.cwd(), 'nerv-printer-config.json')
const DEFAULT_IMPORTED_CONFIG_FILE = path.resolve(process.cwd(), 'nerv-printer-config', '_configs', 'carpet-printer-config.json')
const TEST_BOT_CONFIG_FILE = path.resolve(process.cwd(), 'config.test.json')
const LOG_FILE = path.resolve(process.cwd(), 'logs', 'nerv-printer.log')
const logContext = new AsyncLocalStorage()
const botLogStreams = new Map()

function formatLogArg(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function initLogger() {
  const logDir = path.dirname(LOG_FILE)
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }

  const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
  const getBotStream = (botName) => {
    const safeName = sanitizeSyncName(botName)
    if (!safeName) return null
    if (!botLogStreams.has(safeName)) {
      botLogStreams.set(safeName, fs.createWriteStream(path.join(logDir, `nerv-printer-${safeName}.log`), { flags: 'a' }))
    }
    return botLogStreams.get(safeName)
  }
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error
  }

  const write = (level, args) => {
    const message = args.map(formatLogArg).join(' ')
    const context = logContext.getStore()
    const botName = context?.botName || null
    const prefix = botName ? ` [${botName}]` : ''
    const line = `[${new Date().toISOString()}] [${level}]${prefix} ${message}\n`
    stream.write(line)
    const botStream = botName ? getBotStream(botName) : null
    if (botStream) botStream.write(line)
  }

  console.log = (...args) => {
    original.log(...args)
    write('INFO', args)
  }

  console.warn = (...args) => {
    original.warn(...args)
    write('WARN', args)
  }

  console.error = (...args) => {
    original.error(...args)
    write('ERROR', args)
  }

  process.on('exit', () => {
    stream.end()
    for (const botStream of botLogStreams.values()) {
      botStream.end()
    }
  })

  original.log(`[LOG] Writing runtime logs to ${LOG_FILE}`)
  write('INFO', [`[LOG] Writing runtime logs to ${LOG_FILE}`])
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function toNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function normalizeResumePhase(phase) {
  const value = String(phase || 'printing').toLowerCase()
  if (value === 'repair' || value.startsWith('repair_')) return 'repair'
  if (value === 'post_print' || value.startsWith('post_print')) return 'post_print'
  if (value === 'finished') return 'finished'
  return 'printing'
}

function markProgressInterrupted(config, reason, sessionNumber) {
  const files = config.files || {}
  if (files.resumeProgress === false) return

  const progressFile = path.resolve(process.cwd(), files.progressFile || './logs/nerv-printer-progress.json')
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

function createDefaultConfig() {
  return {
    bot: {
      host: '127.0.0.1',
      port: 25565,
      username: 'MapartBot',
      usernames: ['MapartBot'],
      auth: 'offline',
      version: '1.21.8',
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
            version: '1.21.8',
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
            port: 25565,
            auth: 'microsoft',
            version: 'auto',
            profilesFolder: './auth-cache',
            viewDistance: 'short',
            checkTimeoutInterval: 90000,
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
      preRestockDelayMs: 500,
      inventoryActionDelayMs: 100,
      postRestockDelayMs: 500,
      restockFailureCooldownMs: 8000,
      predictiveRestock: true,
      dumpUnneededBeforeRefill: true,
      inventoryRefillRows: 2,
      inventoryMaxMaterialTypes: 16,
      inventoryPlanUseWorldState: false,
      sneakOnDispenserOnly: true,
      postPrintWorkflowEnabled: true,
      postPrintFillMapEnabled: true,
      postPrintUseCartographyEnabled: true,
      postPrintStoreFinishedMapEnabled: true,
      postPrintResetEnabled: true,
      postPrintXpRefillEnabled: true,
      postPrintRenameMapEnabled: true,
      postPrintMinXpLevel: 2,
      postPrintTargetXpLevel: 5,
      postPrintXpButtonMaxPresses: 40,
      postPrintSkipResetInteraction: false,
      postPrintWalkToCenter: true,
      postPrintCenterWaitMs: 15000,
      postPrintInteractionDelayMs: 100,
      postPrintMapSettleDelayMs: 100,
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
      scannerPreSwapDelayMs: 0,
      scannerPostSwapDelayMs: 0,
      scannerWorkloadMode: 'fixed',
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
      xpButton: { enabled: false, position: { x: 0, y: 0, z: 0 }, accessPosition: null },
      anvil: { enabled: false, position: { x: 0, y: 0, z: 0 }, accessPosition: null },
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

  for (const key of ['cartographyTable', 'finishedMapChest', 'resetBlock', 'xpBottleChest', 'xpButton', 'anvil']) {
    const node = machine[key]
    if (!node) continue
    node.position = translatePoint(node.position, delta)
    node.accessPosition = translatePoint(node.accessPosition, delta)
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

  const xpBottleChestPos = toBlockPos(imported?.xpBottleChest)
  if (xpBottleChestPos) {
    merged.machine.xpBottleChest = {
      enabled: true,
      position: xpBottleChestPos,
      accessPosition: toOpenPos(imported?.xpBottleChest)
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

  const mapMaterial = Array.isArray(imported?.mapMaterialChests)
    ? imported.mapMaterialChests.map(toBlockPos).filter(Boolean)
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
      xpButton: { ...base.machine.xpButton, ...(loaded.machine?.xpButton || {}) },
      anvil: { ...base.machine.anvil, ...(loaded.machine?.anvil || {}) }
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

  // Try to get the machineConfigFile path from the main config
  let machineConfigFilePath = DEFAULT_IMPORTED_CONFIG_FILE
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const mainConfig = readJson(CONFIG_FILE)
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

    if (fs.existsSync(CONFIG_FILE)) {
      const loaded = readJson(CONFIG_FILE)
      const config = mergeUserConfig(importedConfig, loaded, { applyMachine: false, allowMapCornerOnly: false })
      applyAnchorTranslation(config)
      applyConnectionProfile(config)
      console.log('[CONFIG] Loaded nerv-printer-config.json (non-machine overrides only).')
      console.log('[CONFIG] Machine/platform/chest settings remain sourced from machine config file.')
      return config
    }

    const config = importedConfig
    applyAnchorTranslation(config)
    applyConnectionProfile(config)
    console.log('[CONFIG] Using machine config only (no local overrides found).')
    return config
  }

  if (fs.existsSync(CONFIG_FILE)) {
    const loaded = readJson(CONFIG_FILE)
    const config = mergeUserConfig(base, loaded)
    applyAnchorTranslation(config)
    applyConnectionProfile(config)

    if (!config?.bot) {
      throw new Error('Invalid config: missing bot section.')
    }

    console.log('[CONFIG] Loaded nerv-printer-config.json')
    return config
  }

  throw new Error(`Missing config. Expected nerv-printer-config.json or the machineConfigFile path specified in files.machineConfigFile`)
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
    const nextNbt = getNextNbtFile(config)
    if (nextNbt) {
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

async function equipMaterial(bot, config, blockName) {
  const advanced = config.advanced || {}
  const inventoryItem = bot.inventory.items().find((entry) => entry.name === blockName)
  const stackSize = Math.max(1, toNumber(bot.registry.itemsByName[blockName]?.stackSize, 64))

  if (inventoryItem) {
    await delay(toNumber(advanced.preSwapDelayMs, 100))
    await bot.equip(inventoryItem, 'hand')
    await delay(toNumber(advanced.postSwapDelayMs, 100))
    unavailableMaterialCache.delete(blockName)
    return true
  }

  if (unavailableMaterialCache.has(blockName)) {
    return false
  }

  return await restockMaterial(bot, config, blockName, 1, new Map([[blockName, stackSize]]))
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

async function openContainerAt(bot, position, accessPosition) {
  const Vec3 = bot.entity.position.constructor
  const blockPos = new Vec3(position.x, position.y, position.z)
  const goalPos = accessPosition && bot.entity.position.distanceTo(new Vec3(accessPosition.x, accessPosition.y, accessPosition.z)) <= 6
    ? accessPosition
    : position
  const goal = new GoalNear(goalPos.x, goalPos.y, goalPos.z, 2)

  await bot.pathfinder.goto(goal)

  const block = bot.blockAt(blockPos)
  if (!block) {
    throw new Error(`No container block found at ${position.x} ${position.y} ${position.z}`)
  }

  return await bot.openContainer(block)
}

async function restockMaterial(bot, config, blockName, requestedPulls = 1, neededByBlock = null) {
  const advanced = config.advanced || {}
  const failureCooldownMs = Math.max(0, toNumber(advanced.restockFailureCooldownMs, 8000))
  const lastFailedAt = restockFailureCache.get(blockName)
  if (lastFailedAt && Date.now() - lastFailedAt < failureCooldownMs) {
    return false
  }

  const spotGroups = getMaterialChestGroupsForRefill(bot, config, blockName)
  const spots = spotGroups.flat()

  if (!spots.length) {
    unavailableMaterialCache.add(blockName)
    return false
  }

  const itemId = bot.registry.itemsByName[blockName]?.id
  if (!itemId) {
    unavailableMaterialCache.add(blockName)
    return false
  }

  const itemInfo = bot.registry.itemsByName[blockName] || {}
  const stackSize = Math.max(1, toNumber(itemInfo.stackSize, 64))
  const requestedStackCount = Math.max(1, toNumber(requestedPulls, 1))
  const haveBeforeRestock = countInventoryItems(bot, blockName)
  const desiredItemCount = neededByBlock instanceof Map && neededByBlock.has(blockName)
    ? Math.max(
      stackSize,
      haveBeforeRestock + (requestedStackCount * stackSize),
      toNumber(neededByBlock.get(blockName), requestedStackCount * stackSize)
    )
    : Math.max(stackSize, haveBeforeRestock + (requestedStackCount * stackSize))
  const keepPlan = neededByBlock instanceof Map ? neededByBlock : new Map([[blockName, desiredItemCount]])

  if (!inventoryHasRoomForItem(bot, blockName)) {
    const dumped = await dumpUnneededCarpets(bot, config, keepPlan)
    if (!dumped && !inventoryHasRoomForItem(bot, blockName)) {
      restockFailureCache.set(blockName, Date.now())
      if (config.errorHandling?.logErrors !== false) {
        console.log(`[RESTOCK-WARN] No inventory space for ${blockName} and nothing dumpable.`)
      }
      return false
    }
  }

  for (let groupIndex = 0; groupIndex < spotGroups.length; groupIndex += 1) {
    const group = spotGroups[groupIndex]

    for (const spot of group) {
      let container = null
      try {
        const travel = chestTravelPoint(spot)
        if (config.errorHandling?.logErrors !== false) {
          console.log(`[RESTOCK-CHEST] ${blockName}: chest=${spot.x},${spot.y},${spot.z} open=${travel?.x ?? spot.x},${travel?.y ?? spot.y},${travel?.z ?? spot.z} dist=${Math.round(Math.sqrt(horizontalDist2(bot, spot)))}`)
        }
        container = await openContainerAt(bot, spot, spot.accessPosition)
        await delay(toNumber(advanced.preRestockDelayMs, 200))

        // Count ALL of the target item in this chest — including partial stacks.
        // BUG FIX: old code used Math.floor(total/64) which silently skipped chests
        // with partial stacks (e.g. 30 carpets -> 30/64=0 -> skipped entirely).
        const chestSlots = container.containerItems().filter((entry) => entry.type === itemId)
        const totalInChest = chestSlots.reduce((sum, entry) => sum + toNumber(entry.count, 0), 0)

        if (totalInChest <= 0) {
          if (config.advanced?.debugPrints) {
            console.log(`[RESTOCK-SKIP] Chest at ${spot.x} ${spot.y} ${spot.z} has 0 of ${blockName}, moving to next.`)
          }
          try { container.close() } catch { }
          container = null
          continue
        }

        // How much do we need vs what the chest has?
        const haveAtStart = countInventoryItems(bot, blockName)
        const stillNeedTotal = Math.max(0, desiredItemCount - haveAtStart)
        const willPullTotal = Math.min(totalInChest, stillNeedTotal)

        if (config.errorHandling?.logErrors !== false) {
          console.log(`[RESTOCK-PULL] ${blockName}: have=${haveAtStart} need=${desiredItemCount} chestHas=${totalInChest} pulling=${willPullTotal}`)
        }

        // Pull in increments until we get what we need from this chest.
        // Handles fragmented chests (many small stacks) correctly.
        let plannedHaveAfterPulls = haveAtStart
        const targetCount = haveAtStart + willPullTotal
        let attempts = 0
        let stoppedForInventoryFull = false
        const maxAttempts = chestSlots.length + 8
        while (plannedHaveAfterPulls < targetCount && attempts < maxAttempts) {
          attempts++
          const haveBeforePull = countInventoryItems(bot, blockName)
          const amountStillNeeded = targetCount - plannedHaveAfterPulls
          const pullAmount = Math.min(stackSize, amountStillNeeded)
          try {
            await container.withdraw(itemId, null, pullAmount)
            plannedHaveAfterPulls += pullAmount
            await delay(toNumber(advanced.inventoryActionDelayMs, 80))
            const haveAfterPull = countInventoryItems(bot, blockName)
            if (haveAfterPull <= haveBeforePull && config.errorHandling?.logErrors !== false) {
              console.log(`[RESTOCK-WARN] ${blockName} inventory update pending: before=${haveBeforePull} after=${haveAfterPull} requested=${pullAmount} planned=${plannedHaveAfterPulls}/${targetCount}`)
            }
          } catch (err) {
            const message = String(err?.message || err).toLowerCase()
            const inventoryFull = message.includes('no free') ||
              message.includes('inventory full') ||
              message.includes('inventory is full') ||
              message.includes('free room') ||
              message.includes('no space')

            if (inventoryFull) {
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[RESTOCK-WARN] Inventory full while pulling ${blockName}; stopping this chest.`)
              }
              stoppedForInventoryFull = true
              break
            }
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[RESTOCK-WARN] withdraw error for ${blockName}: ${err?.message || err}`)
            }
            break
          }
        }

        await delay(toNumber(advanced.postRestockDelayMs, 300))

        if (stoppedForInventoryFull) {
          restockFailureCache.set(blockName, Date.now())
          const haveNow = countInventoryItems(bot, blockName)
          console.log(`[RESTOCK-WARN] Stopping ${blockName} restock because inventory is full: have=${haveNow} target=${desiredItemCount}.`)
          return false
        }

        if (countInventoryItems(bot, blockName) >= desiredItemCount) {
          const inventoryItem = bot.inventory.items().find((entry) => entry.name === blockName)
          await bot.equip(inventoryItem, 'hand')
          restockFailureCache.delete(blockName)
          unavailableMaterialCache.delete(blockName)
          return true
        }
      } catch (err) {
        if (config.advanced?.debugPrints) {
          console.log(`[RESTOCK-DEBUG] ${blockName} @ ${spot.x},${spot.z}: ${err?.message || err}`)
        }
      } finally {
        if (container) {
          try { container.close() } catch { }
        }
      }
    }
  }

  const haveAfterRestock = countInventoryItems(bot, blockName)
  if (haveAfterRestock > haveBeforeRestock) {
    console.log(`[RESTOCK-WARN] Partial restock for ${blockName}: have=${haveAfterRestock} target=${desiredItemCount}.`)
  }

  restockFailureCache.set(blockName, Date.now())
  unavailableMaterialCache.add(blockName)
  return false
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

function configurePathfinderMovements(bot, config) {
  const printer = config.printer || {}
  const allowJump = printer.allowJump !== false
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = allowJump
  movements.allowSprinting = true
  movements.canSprint = true
  bot.pathfinder.setMovements(movements)
  return movements
}

async function gotoWithTemporaryThinkTimeout(bot, goal, timeoutMs) {
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

  try {
    const container = await openContainerAt(bot, chestPos, accessPosition)
    await delay(toNumber(config.advanced?.postPrintInteractionDelayMs, 200))
    await container.withdraw(itemId, null, Math.max(1, toNumber(amount, 1)))
    await delay(toNumber(config.advanced?.inventoryActionDelayMs, 100))
    container.close()
    await delay(toNumber(config.advanced?.postPrintInteractionDelayMs, 200))
    return true
  } catch (err) {
    if (config.advanced?.debugPrints) {
      console.log(`[POSTPRINT-DEBUG] withdraw ${itemName} -> ${err?.message || err}`)
    }
    return false
  }
}

async function depositToChest(bot, config, chestPos, itemName, amount, accessPosition) {
  const itemId = bot.registry.itemsByName[itemName]?.id
  if (!itemId) return false

  try {
    const container = await openContainerAt(bot, chestPos, accessPosition)
    await delay(toNumber(config.advanced?.postPrintInteractionDelayMs, 200))
    await container.deposit(itemId, null, Math.max(1, toNumber(amount, 1)))
    await delay(toNumber(config.advanced?.inventoryActionDelayMs, 100))
    container.close()
    await delay(toNumber(config.advanced?.postPrintInteractionDelayMs, 200))
    return true
  } catch (err) {
    if (config.advanced?.debugPrints) {
      console.log(`[POSTPRINT-DEBUG] deposit ${itemName} -> ${err?.message || err}`)
    }
    return false
  }
}

async function openBlockWindowAt(bot, position, accessPosition) {
  const Vec3 = bot.entity.position.constructor
  const blockPos = new Vec3(position.x, position.y, position.z)
  const goalPos = accessPosition && bot.entity.position.distanceTo(new Vec3(accessPosition.x, accessPosition.y, accessPosition.z)) <= 6
    ? accessPosition
    : position
  await bot.pathfinder.goto(new GoalNear(goalPos.x, goalPos.y, goalPos.z, 2))
  const block = bot.blockAt(blockPos)
  if (!block) throw new Error(`No block at ${position.x} ${position.y} ${position.z}`)
  return await bot.openBlock(block)
}

async function openAnvilAt(bot, position, accessPosition) {
  const Vec3 = bot.entity.position.constructor
  const blockPos = new Vec3(position.x, position.y, position.z)
  const goalPos = accessPosition && bot.entity.position.distanceTo(new Vec3(accessPosition.x, accessPosition.y, accessPosition.z)) <= 6
    ? accessPosition
    : position
  await bot.pathfinder.goto(new GoalNear(goalPos.x, goalPos.y, goalPos.z, 2))
  const block = bot.blockAt(blockPos)
  if (!block) throw new Error(`No anvil at ${position.x} ${position.y} ${position.z}`)
  return await bot.openAnvil(block)
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

function getItemId(bot, itemName) {
  return bot.registry.itemsByName[itemName]?.id || null
}

function findInventoryItemByType(bot, itemName) {
  const itemId = getItemId(bot, itemName)
  if (!itemId) return null
  return bot.inventory.items().find((entry) => entry.type === itemId)
}

function countInventoryByType(bot, itemName) {
  const itemId = getItemId(bot, itemName)
  if (!itemId) return 0
  return bot.inventory.items()
    .filter((entry) => entry.type === itemId)
    .reduce((sum, entry) => sum + toNumber(entry.count, 0), 0)
}

async function refillXpForPostPrint(bot, config) {
  const advanced = config.advanced || {}
  if (advanced.postPrintXpRefillEnabled === false) return

  const minLevel = Math.max(0, toNumber(advanced.postPrintMinXpLevel, 2))
  const targetLevel = Math.max(minLevel, toNumber(advanced.postPrintTargetXpLevel, 5))
  const currentLevel = toNumber(bot.experience?.level, 0)
  const xpButtonConfig = config.machine?.xpButton

  if (currentLevel >= minLevel) return

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
}

async function renameFinishedMap(bot, config, anvilConfig, sourceName) {
  const advanced = config.advanced || {}
  if (advanced.postPrintRenameMapEnabled === false) return null
  if (!anvilConfig?.enabled || !anvilConfig?.position) {
    console.log('[POSTPRINT-WARN] Anvil is not configured; skipping rename.')
    return null
  }

  const filledMap = findInventoryItemByType(bot, 'filled_map')
  if (!filledMap) {
    console.log('[POSTPRINT-WARN] No filled map found to rename.')
    return null
  }

  const renameTarget = String(path.parse(sourceName || 'map').name || 'map').slice(0, 35)
  try {
    const beforeHints = getItemNameHints(filledMap)
    if (beforeHints.length) {
      console.log(`[POSTPRINT-DEBUG] Rename candidate before anvil: ${beforeHints.join(' | ')}`)
    }

    const anvil = await openAnvilAt(bot, anvilConfig.position, anvilConfig.accessPosition)
    await delay(toNumber(advanced.postPrintInteractionDelayMs, 200))
    await anvil.rename(filledMap, renameTarget)
    await delay(toNumber(advanced.postPrintInteractionDelayMs, 200))
    if (typeof anvil.close === 'function') anvil.close()

    const filledMapId = getItemId(bot, 'filled_map')
    const inventoryMaps = bot.inventory.items().filter((entry) => entry.type === filledMapId)
    const matched = inventoryMaps.find((entry) => isMapNamed(entry, renameTarget))
    if (!matched) {
      const sampleNames = inventoryMaps.flatMap((entry) => getItemNameHints(entry)).slice(0, 6)
      console.log(`[POSTPRINT-WARN] Rename reported success but renamed map name not found in inventory. Seen names: ${sampleNames.join(' | ') || 'none'}`)
    }

    console.log(`[POSTPRINT] Renamed finished map to ${renameTarget}.`)
    return renameTarget
  } catch (err) {
    console.log(`[POSTPRINT-WARN] Rename step failed: ${err?.message || err}`)
    return null
  }
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

async function runPostPrintWorkflow(bot, config, context = {}) {
  const advanced = config.advanced || {}
  const machine = config.machine || {}
  if (advanced.postPrintWorkflowEnabled === false) return

  const postPrintSteps = ['withdraw', 'fill_map', 'cartography', 'rename_store', 'reset', 'center', 'done']
  const resumeStep = postPrintSteps.includes(context.resumePostPrintStep) ? context.resumePostPrintStep : 'withdraw'
  const resumeStepIndex = postPrintSteps.indexOf(resumeStep)
  const shouldRunStep = (step) => postPrintSteps.indexOf(step) >= resumeStepIndex && resumeStep !== 'done'
  const savePostPrintStep = (nextStep, action = `next-${nextStep}`) => {
    if (typeof context.savePostPrintState === 'function') {
      context.savePostPrintState(nextStep, action)
    }
  }

  if (resumeStep !== 'withdraw') {
    console.log(`[POSTPRINT-RESUME] Resuming post-print at step=${resumeStep}.`)
  }
  if (resumeStep === 'done') return

  const mapChestPos = nearestPosition(bot, machine.mapMaterialChests || [])
  const cartographyPos = machine.cartographyTable?.enabled ? machine.cartographyTable.position : null
  const finishedChestPos = machine.finishedMapChest?.enabled ? machine.finishedMapChest.position : null
  const anvilConfig = machine.anvil?.enabled ? machine.anvil : null
  const resetPos = machine.resetBlock?.enabled ? machine.resetBlock.position : null
  let cartographySucceeded = resumeStepIndex > postPrintSteps.indexOf('cartography')

  if (shouldRunStep('withdraw') && !mapChestPos) {
    console.log('[POSTPRINT-WARN] Missing map material chest position. Skipping post-print workflow.')
    return
  }

  savePostPrintStep(resumeStep, 'post-print-active')

  if (shouldRunStep('withdraw')) {
    const gotMap = countInventoryByType(bot, 'map') > 0 || await withdrawFromChest(bot, config, mapChestPos, 'map', 1)
    const gotPane = countInventoryItems(bot, 'glass_pane') > 0 || await withdrawFromChest(bot, config, mapChestPos, 'glass_pane', 1)
    if (!gotMap || !gotPane) {
      console.log('[POSTPRINT-WARN] Could not withdraw map/glass pane for post-print flow.')
    }
    savePostPrintStep('fill_map', 'materials-withdrawn')
  }

  if (shouldRunStep('fill_map') && advanced.postPrintFillMapEnabled !== false) {
    const mapItem = findInventoryItemByType(bot, 'map')
    if (mapItem) {
      const center = getMapCenterPosition(config)
      try {
        await bot.pathfinder.goto(new GoalNear(center.x, center.y, center.z, 1))
      } catch (err) {
        console.log(`[POSTPRINT-WARN] Could not reach map center before map activation: ${err?.message || err}`)
      }

      // Use the empty map to create filled_map, then immediately equip it.
      // The bot must hold the filled map throughout the fill walk so the server
      // sends map data packets back (otherwise the map stays blank).
      await bot.equip(mapItem, 'hand')
      await bot.activateItem()
      await delay(toNumber(advanced.postPrintInteractionDelayMs, 200))
      if (typeof bot.deactivateItem === 'function') bot.deactivateItem()

      const filledMapItem = findInventoryItemByType(bot, 'filled_map')
      if (filledMapItem) {
        try {
          await bot.equip(filledMapItem, 'hand')
          console.log('[POSTPRINT] Equipped filled map in hand for terrain data capture.')
        } catch (err) {
          console.log(`[POSTPRINT-WARN] Could not equip filled map: ${err?.message || err}`)
        }
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
          const currentMap = findInventoryItemByType(bot, 'filled_map')
          if (currentMap && bot.heldItem?.type !== currentMap.type) {
            await bot.equip(currentMap, 'hand')
          }
          try {
            await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 1))
          } catch {
            break
          }
          // Re-equip after each pathfinder call in case hotbar slot was swapped
          const stillHolding = findInventoryItemByType(bot, 'filled_map')
          if (stillHolding && bot.heldItem?.type !== stillHolding.type) {
            await bot.equip(stillHolding, 'hand')
          }
        }
      }
    } else {
      console.log('[POSTPRINT-WARN] No empty map in inventory to fill.')
    }

    await delay(toNumber(advanced.postPrintMapSettleDelayMs, 1500))
    savePostPrintStep('cartography', 'map-filled')
  } else if (shouldRunStep('fill_map')) {
    savePostPrintStep('cartography', 'fill-map-skipped')
  }

  const hasFilledMap = countInventoryByType(bot, 'filled_map') > 0

  if (shouldRunStep('cartography') && advanced.postPrintUseCartographyEnabled !== false && cartographyPos && hasFilledMap) {
    try {
      const filledMapForTable = findInventoryItemByType(bot, 'filled_map')
      if (filledMapForTable && bot.heldItem?.type !== filledMapForTable.type) {
        await bot.equip(filledMapForTable, 'hand')
      }

      const window = await openBlockWindowAt(bot, cartographyPos)
      await delay(toNumber(advanced.postPrintInteractionDelayMs, 200))

      const filledMapSlot = findWindowInventorySlot(window, bot, 'filled_map')
      const paneSlot = findWindowInventorySlot(window, bot, 'glass_pane')

      if (filledMapSlot >= 0 && paneSlot >= 0) {
        await moveWindowItem(bot, filledMapSlot, 0)
        await delay(toNumber(advanced.inventoryActionDelayMs, 100))
        await moveWindowItem(bot, paneSlot, 1)
        await delay(toNumber(advanced.postPrintInteractionDelayMs, 200))

        const outputStack = window.slots[2]
        if (outputStack && outputStack.count > 0) {
          await bot.clickWindow(2, 0, 1)
          await delay(toNumber(advanced.inventoryActionDelayMs, 100))
          cartographySucceeded = true
        }
      } else {
        console.log('[POSTPRINT-WARN] Missing filled map or glass pane in inventory for cartography step.')
      }

      if (typeof window.close === 'function') window.close()
    } catch (err) {
      console.log(`[POSTPRINT-WARN] Cartography step failed: ${err?.message || err}`)
    }
    savePostPrintStep('rename_store', cartographySucceeded ? 'cartography-complete' : 'cartography-failed')
  } else if (shouldRunStep('cartography')) {
    if (advanced.postPrintUseCartographyEnabled === false) cartographySucceeded = true
    savePostPrintStep('rename_store', 'cartography-skipped')
  }

  if (shouldRunStep('rename_store') && cartographySucceeded) {
    await refillXpForPostPrint(bot, config)
    const renamedTarget = await renameFinishedMap(bot, config, anvilConfig, context.sourceName)

    if (advanced.postPrintStoreFinishedMapEnabled !== false && finishedChestPos && (cartographySucceeded || advanced.postPrintUseCartographyEnabled === false)) {
      const filledMapId = getItemId(bot, 'filled_map')
      const filledMaps = bot.inventory.items().filter((entry) => entry.type === filledMapId)

      if (advanced.postPrintRenameMapEnabled !== false && renamedTarget) {
        const renamedCount = filledMaps.filter((entry) => isMapNamed(entry, renamedTarget)).length
        if (renamedCount === 0) {
          console.log('[POSTPRINT-WARN] Did not detect renamed map name in inventory; depositing anyway as requested.')
        }
      }

      for (const stack of filledMaps) {
        if (stack.count <= 0) continue
        const hints = getItemNameHints(stack)
        if (hints.length) {
          console.log(`[POSTPRINT-DEBUG] Depositing map with name hints: ${hints.join(' | ')}`)
        }
        await depositToChest(bot, config, finishedChestPos, 'filled_map', stack.count, machine.finishedMapChest?.accessPosition)
      }
    }
    savePostPrintStep('reset', 'map-renamed-and-stored')
  } else if (shouldRunStep('rename_store') && advanced.postPrintUseCartographyEnabled !== false) {
    console.log('[POSTPRINT-WARN] Skipping XP refill and rename because cartography did not complete.')
    savePostPrintStep('reset', 'rename-store-skipped')
  } else if (shouldRunStep('rename_store')) {
    savePostPrintStep('reset', 'rename-store-disabled')
  }

  const shouldInteractReset = advanced.postPrintResetEnabled !== false
    && resetPos
    && advanced.postPrintSkipResetInteraction !== true

  if (shouldRunStep('reset') && shouldInteractReset) {
    try {
      const resetContainer = await openContainerAt(bot, resetPos, machine.resetBlock?.accessPosition)
      await delay(toNumber(advanced.postPrintInteractionDelayMs, 200))
      resetContainer.close()
    } catch (err) {
      console.log(`[POSTPRINT-WARN] Reset step failed: ${err?.message || err}`)
    }
    savePostPrintStep('center', 'reset-complete')
  } else if (shouldRunStep('reset') && advanced.postPrintSkipResetInteraction === true && resetPos) {
    console.log('[POSTPRINT] Reset interaction skipped by config. Walking to center step directly.')
    savePostPrintStep('center', 'reset-skipped-by-config')
  } else if (shouldRunStep('reset')) {
    savePostPrintStep('center', 'reset-unavailable')
  }

  if (shouldRunStep('center') && advanced.postPrintWalkToCenter !== false) {
    const center = getMapCenterPosition(config)

    try {
      await bot.pathfinder.goto(new GoalNear(center.x, center.y, center.z, 1))
      const centerWaitMs = Math.max(0, toNumber(advanced.postPrintCenterWaitMs, 3000))
      if (centerWaitMs > 0) {
        console.log(`[POSTPRINT] Waiting at center for ${centerWaitMs}ms.`)
        await delay(centerWaitMs)
      }
    } catch (err) {
      console.log(`[POSTPRINT-WARN] Walk-to-center step failed: ${err?.message || err}`)
    }
    savePostPrintStep('done', 'center-complete')
  } else if (shouldRunStep('center')) {
    savePostPrintStep('done', 'center-skipped')
  }
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

function getBuildMaterialSlotCapacity(bot) {
  const inventory = bot.inventory
  const start = Number.isFinite(inventory.inventoryStart) ? inventory.inventoryStart : 9
  const end = Number.isFinite(inventory.inventoryEnd) ? inventory.inventoryEnd : (Array.isArray(inventory.slots) ? inventory.slots.length : 46)
  let capacity = 0

  for (let i = start; i < end; i += 1) {
    const slot = inventory.slots[i]
    if (!slot || String(slot.name || '').endsWith('_carpet')) {
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
    if (!stack || materialNames.has(stack.name)) {
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
  const printer = config.printer || {}
  const linesPerRun = Math.max(1, toNumber(printer.linesPerRun, 3))
  const maxMaterialTypes = Math.max(1, Math.min(16, toNumber(config.advanced?.inventoryMaxMaterialTypes, 16)))
  const useWorldState = config.advanced?.inventoryPlanUseWorldState === true
  const availableSlots = getNervAvailableSlots(bot, config, targets)
  const requiredItems = new Map()
  const { byColRow, cols, rows } = buildNervTargetGrid(targets)
  const Vec3 = bot.entity.position.constructor
  let isStartSide = true
  let inspected = 0
  let counted = 0
  let unloaded = 0

  for (let i = 0; i < cols.length; i += linesPerRun) {
    const colBatch = cols.slice(i, i + linesPerRun)
    const rowOrder = isStartSide ? rows : [...rows].reverse()

    for (const row of rowOrder) {
      for (const col of colBatch) {
        const target = byColRow.get(`${col}:${row}`)
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
    }

    isStartSide = !isStartSide
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

function estimateNeededFromTargetsLimitedByCapacity(targets, bot, capacityOverride) {
  const neededByBlock = new Map()
  const capacitySlots = (capacityOverride != null) ? capacityOverride : getBuildMaterialSlotCapacity(bot)

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

async function dumpNervInventorySlots(bot, config, dumpSlots, reasonLabel = 'nervPredump') {
  const stacks = []
  for (const slot of dumpSlots) {
    const stack = bot.inventory.slots[slot.slotIndex]
    if (!stack) continue
    stacks.push(stack)
  }

  return await dumpCarpetStacks(bot, config, stacks, reasonLabel)
}

function inventoryHasRoomForItem(bot, itemName) {
  const itemInfo = bot.registry.itemsByName[itemName] || {}
  const stackSize = Math.max(1, toNumber(itemInfo.stackSize, 64))
  const inventory = bot.inventory
  const start = Number.isFinite(inventory.inventoryStart) ? inventory.inventoryStart : 9
  const end = Number.isFinite(inventory.inventoryEnd) ? inventory.inventoryEnd : (Array.isArray(inventory.slots) ? inventory.slots.length : 46)

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
  const start = Number.isFinite(inventory.inventoryStart) ? inventory.inventoryStart : 9
  const end = Number.isFinite(inventory.inventoryEnd) ? inventory.inventoryEnd : (Array.isArray(inventory.slots) ? inventory.slots.length : 46)
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

function countEmptyInventorySlots(bot) {
  const inventory = bot.inventory || {}
  const slots = Array.isArray(inventory.slots) ? inventory.slots : []
  const start = Number.isFinite(inventory.inventoryStart) ? inventory.inventoryStart : 9
  const end = Number.isFinite(inventory.inventoryEnd) ? inventory.inventoryEnd : (Array.isArray(inventory.slots) ? inventory.slots.length : 46)
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
  const start = Number.isFinite(inventory.inventoryStart) ? inventory.inventoryStart : 9
  const end = Number.isFinite(inventory.inventoryEnd) ? inventory.inventoryEnd : (Array.isArray(inventory.slots) ? inventory.slots.length : 46)
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
      await bot.tossStack(stack)
      dumped += 1
      await delay(toNumber(config.advanced?.inventoryActionDelayMs, 100))
    } catch (err) {
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
  if (advanced.predictiveRestock === false || !targets.length) return true

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
  const stableNeededByBlock = new Map(stableRequired.requiredItems)
  if (config.advanced?.debugPrints) {
    const windowLabel = planning.cols?.length
      ? `cols=${planning.cols.join(',')}`
      : `rows=${planning.rows.join(',') || 'none'}`
    console.log(`[NERV-INVENTORY-WINDOW] ${windowLabel} materials=${planning.materials.length}/16 targets=${planningTargets.length}/${targets.length}`)
  }
  let safetyCounter = 0
  let didRestockThisWindow = false

  while (safetyCounter < maxIterations) {
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
        if (dumped <= 0) return false
        await delay(toNumber(advanced.inventoryActionDelayMs, 100))
        continue
      }
      return true
    }

    if (!didRestockThisWindow && advanced.dumpUnneededBeforeRefill !== false && plan.dumpSlots.length > 0) {
      const dumpsNeeded = options.dumpAllUnneededBeforeRestock === true
        ? plan.dumpSlots.length
        : Math.min(plan.dumpSlots.length, estimateDumpSlotsNeededForRestock(bot, restockList))
      if (dumpsNeeded > 0) {
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
      if (restockFailureCache.has(item.blockName) && Date.now() - restockFailureCache.get(item.blockName) < Math.max(0, toNumber(advanced.restockFailureCooldownMs, 8000))) {
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

    const restocked = await restockMaterial(bot, config, closestItem.blockName, pullsNeeded, neededByBlock)

    if (!restocked) {
      const haveAfter = countInventoryItems(bot, closestItem.blockName)
      const stillNeed = Math.max(0, closestItem.needed - haveAfter)
      const remainingCapacity = inventoryCapacityForItem(bot, closestItem.blockName)
      const retryPlan = buildNervInventoryPlanFromRequired(bot, config, planningTargets, stableNeededByBlock, stableRequired)

      if (advanced.dumpUnneededBeforeRefill !== false && retryPlan.dumpSlots.length > 0) {
        restockFailureCache.delete(closestItem.blockName)
        unavailableMaterialCache.delete(closestItem.blockName)
        console.log(`[NERV-RESTOCK-WARN] ${closestItem.blockName} needs ${stillNeed} more but capacity is ${remainingCapacity}; dumping from fresh plan before retry.`)
        continue
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

  const maxIterations = Math.max(10, toNumber(advanced.repairRestockMaxIterations, 24))
  let safetyCounter = 0

  while (safetyCounter < maxIterations) {
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
      if (restockFailureCache.has(item.blockName) && Date.now() - restockFailureCache.get(item.blockName) < failureCooldownMs) {
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
        console.log(`[REPAIR-DUMP] Freeing 1 slot before repair restock: ${dumpable[0].name}x${dumpable[0].count}`)
        await dumpCarpetStacks(bot, config, dumpable, 'repairPredumpBeforeRefill')
        await delay(toNumber(advanced.inventoryActionDelayMs, 100))
        continue
      }

      console.log(`[REPAIR-RESTOCK-WARN] No inventory space for ${closestItem.blockName}; repair will continue with current inventory.`)
      return
    }

    console.log(`[REPAIR-RESTOCK] material=${closestItem.blockName} have=${closestItem.have} need=${closestItem.needed} deficit=${closestItem.deficit} dist=${Math.round(Math.sqrt(closestDist))}`)
    const restocked = await restockMaterial(bot, config, closestItem.blockName, closestItem.stacks, plan.neededByBlock)

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

async function placeTarget(bot, config, target, isRepairPass = false) {
  const printer = config.printer || {}
  const errors = config.errorHandling || {}
  const Vec3 = bot.entity.position.constructor
  const noWaitForBlockUpdate = isRepairPass === true || isRepairPass === 'noWait'

  const { targetPos } = resolveTargetPlacementPosition(bot, target, config)

  const blockAtTarget = bot.blockAt(targetPos)

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
  if (botBlockX === targetPos.x && botBlockZ === targetPos.z && botNearTargetY) {
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

  const equipped = await equipMaterial(bot, config, target.blockName)
  if (!equipped) {
    return { state: 'skip', reason: `missing-item-${target.blockName}` }
  }

  const heldItemName = String(bot.heldItem?.name || '')
  if (heldItemName !== target.blockName) {
    const reequipped = await equipMaterial(bot, config, target.blockName)
    if (!reequipped || String(bot.heldItem?.name || '') !== target.blockName) {
      return { state: 'skip', reason: `missing-item-${target.blockName}` }
    }
  }

  if (printer.rotate !== false) {
    await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), true)
  }

  const sideCandidates = [
    { refPos: targetPos.offset(-1, 0, 0), face: new Vec3(1, 0, 0) },
    { refPos: targetPos.offset(1, 0, 0), face: new Vec3(-1, 0, 0) },
    { refPos: targetPos.offset(0, 0, -1), face: new Vec3(0, 0, 1) },
    { refPos: targetPos.offset(0, 0, 1), face: new Vec3(0, 0, -1) }
  ]

  const placeAttempts = [{ block: support, face: new Vec3(0, 1, 0) }]
  for (const candidate of sideCandidates) {
    const sideBlock = bot.blockAt(candidate.refPos)
    if (sideBlock && sideBlock.name !== 'air') {
      placeAttempts.push({ block: sideBlock, face: candidate.face })
    }
  }

  let placedSuccessfully = false
  let lastPlaceError = null

  for (const attempt of placeAttempts) {
    const sneakOnDispenserOnly = config.advanced?.sneakOnDispenserOnly !== false
    const shouldSneak = sneakOnDispenserOnly ? attempt?.block?.name === 'dispenser' : true
    try {
      if (shouldSneak) {
        bot.setControlState('sneak', true)
      }
      if (noWaitForBlockUpdate && typeof bot._genericPlace === 'function') {
        await bot._genericPlace(attempt.block, attempt.face, {
          swingArm: 'right',
          forceLook: printer.rotate !== false ? true : 'ignore'
        })
      } else {
        await bot.placeBlock(attempt.block, attempt.face)
      }
      placedSuccessfully = true
      break
    } catch (err) {
      lastPlaceError = err
      const errMsg = String(err?.message || '').toLowerCase()
      if (errMsg.includes('must be holding an item')) {
        return { state: 'skip', reason: `missing-item-${target.blockName}` }
      }
      const afterPlace = bot.blockAt(targetPos)
      if (afterPlace?.name === target.blockName) {
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
    throw lastPlaceError || new Error('placement failed with all faces')
  }

  await delay(toNumber(printer.placeDelayMs, 50))
  return { state: 'placed' }
}

async function repairTargets(bot, config, targets, placeRange) {
  if (!targets.length) return { placed: 0, already: 0, skipped: 0 }

  const printer = config.printer || {}
  const repairGoalRange = Math.max(0.5, toNumber(config.advanced?.repairGoalRange, Math.max(0.75, placeRange - 1.5)))
  const settleMs = Math.max(0, toNumber(config.advanced?.repairTargetSettleMs, 20))
  const remaining = [...targets]
  let placed = 0
  let already = 0
  let skipped = 0

  bot.setControlState('sprint', shouldSprintDuringRepair(config))

  while (remaining.length > 0) {
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
        if (config.errorHandling?.logErrors !== false) {
          console.log(`[REPAIR-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
        }
      }
    } catch (err) {
      skipped += 1
      if (config.errorHandling?.logErrors !== false) {
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
  console.log(`[${label}-WARN-DETAIL] missing=${summary.missing} occupied=${summary.occupied} unloaded=${summary.unloaded} wrongRatio=${(wrongRatio * 100).toFixed(1)}%; continuing repair.`)
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

async function repairTargetsWhileMovingWithStops(bot, config, targets, placeRange, label = 'REPAIR-MIXED') {
  if (!targets.length) return { placed: 0, already: 0, skipped: 0 }

  const printer = config.printer || {}
  const advanced = config.advanced || {}
  const tickMs = Math.max(10, toNumber(advanced.repairFastTickMs, toNumber(printer.fastTraversalTickMs, 40)))
  const maxPerTick = Math.max(1, toNumber(advanced.repairFastMaxPlacementsPerTick, toNumber(printer.maxPlacementsPerTick, 1)))
  const goalRange = Math.max(0.5, toNumber(advanced.repairFastGoalRange, toNumber(advanced.repairGoalRange, Math.max(0.75, placeRange - 1.5))))
  const moveTimeoutMs = Math.max(1000, toNumber(advanced.repairMoveTimeoutMs, 8000))
  const progressLogMs = Math.max(1000, toNumber(advanced.repairProgressLogMs, 5000))
  const fallbackToStopPlace = advanced.repairFallbackToStopPlace !== false
  const Vec3 = bot.entity.position.constructor
  const processed = new Set()
  let active = true
  let placed = 0
  let already = 0
  let skipped = 0
  let lastProgressAt = Date.now()
  let lastLogAt = 0
  let fallbackNeeded = false
  let stopRepairActive = false
  const moveFailures = new Map()

  const targetKey = (target) => `${target.position.x}:${target.position.y}:${target.position.z}`
  const targetPosition = (target) => new Vec3(target.position.x, target.position.y, target.position.z)
  const getResolvedTarget = (target) => {
    const { targetPos, shiftedDown } = resolveTargetPlacementPosition(bot, target, config)
    return shiftedDown
      ? { ...target, position: { x: targetPos.x, y: targetPos.y, z: targetPos.z } }
      : target
  }

  const markResult = (target, result, prefix) => {
    lastProgressAt = Date.now()
    if (result.state === 'placed') placed += 1
    else if (result.state === 'already') already += 1
    else {
      skipped += 1
      if (config.errorHandling?.logErrors !== false) {
        console.log(`[${prefix}-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
      }
    }
  }

  const fastAirLoop = (async () => {
    while (active) {
      if (stopRepairActive) {
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
          const result = await placeNervScannerTarget(bot, config, target)
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

      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, goalRange)),
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
          if (config.errorHandling?.logErrors !== false) {
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
          result = await placeNervScannerTarget(bot, config, target)
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
        console.log(`[${label}-PROGRESS-WARN] no repair placement progress for ${Date.now() - lastProgressAt}ms; falling back to stop-place.`)
        fallbackNeeded = true
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

async function runContinuousPlacementBatch(bot, config, batchTargets, rowOrder, placeRange) {
  if (!batchTargets.length) return { placed: 0, already: 0, skipped: 0, processed: 0 }

  const printer = config.printer || {}
  const tickMs = Math.max(10, toNumber(printer.fastTraversalTickMs, 40))
  const maxPerTick = Math.max(1, toNumber(printer.maxPlacementsPerTick, 1))
  const checkpointEveryRows = Math.max(1, toNumber(printer.fastTraversalCheckpointEveryRows, 8))
  const catchupPasses = Math.max(0, toNumber(printer.fastTraversalCatchupPasses, 3))
  const catchupStallMs = Math.max(100, toNumber(printer.fastTraversalCatchupStallMs, 6000))
  const Vec3 = bot.entity.position.constructor

  const byRow = new Map()
  for (const target of batchTargets) {
    const list = byRow.get(target.row) || []
    list.push(target)
    byRow.set(target.row, list)
  }

  const checkpoints = []
  const rowsWithTargets = rowOrder.filter((row) => byRow.has(row))
  for (let i = 0; i < rowsWithTargets.length; i += checkpointEveryRows) {
    const rowTargets = byRow.get(rowsWithTargets[i]) || []
    const mid = rowTargets[Math.floor(rowTargets.length / 2)] || rowTargets[0]
    if (mid) checkpoints.push(mid.position)
  }
  checkpoints.push(batchTargets[batchTargets.length - 1].position)

  let active = true
  let placed = 0
  let already = 0
  let skipped = 0
  const processed = new Set()

  const placementLoop = (async () => {
    while (active) {
      const botPos = bot.entity.position
      let placementsThisTick = 0

      const candidates = batchTargets
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
              console.log(`[FAST-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
            }
          }
        } catch (err) {
          skipped += 1
          if (config.errorHandling?.logErrors !== false) {
            console.log(`[FAST-PLACE-ERROR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
          }
        }
      }

      await delay(tickMs)
    }
  })()

  try {
    bot.setControlState('sprint', String(printer.sprintMode || 'always').toLowerCase() !== 'off')
    for (const cp of checkpoints) {
      await bot.pathfinder.goto(new GoalNear(cp.x, cp.y, cp.z, 1))
    }

    for (let pass = 1; pass <= catchupPasses && processed.size < batchTargets.length; pass += 1) {
      let lastProcessed = processed.size
      console.log(`[FAST-CATCHUP] pass=${pass}/${catchupPasses} remaining=${batchTargets.length - processed.size}`)

      while (processed.size < batchTargets.length) {
        const botPos = bot.entity.position
        const remaining = batchTargets
          .filter((target) => !processed.has(target))
          .sort((a, b) => {
            const da = botPos.distanceTo(new Vec3(a.position.x + 0.5, a.position.y + 0.5, a.position.z + 0.5))
            const db = botPos.distanceTo(new Vec3(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5))
            return da - db
          })

        const next = remaining[0]
        if (!next) break

        await bot.pathfinder.goto(new GoalNear(next.position.x, next.position.y, next.position.z, Math.max(1, placeRange - 1)))
        await delay(catchupStallMs)

        if (processed.size <= lastProcessed) {
          console.log(`[FAST-CATCHUP] stalled pass=${pass} remaining=${batchTargets.length - processed.size}`)
          break
        }
        lastProcessed = processed.size
      }
    }
  } catch (err) {
    if (config.errorHandling?.logErrors !== false) {
      console.log(`[FAST-MOVE-ERROR] Traversal interrupted: ${err?.message || err}`)
    }
  } finally {
    active = false
    await placementLoop
  }

  return { placed, already, skipped, processed: processed.size }
}

function buildNervUCheckpoints(batchTargets, startOnNorthSide) {
  const minX = Math.min(...batchTargets.map((target) => target.position.x))
  const minY = Math.min(...batchTargets.map((target) => target.position.y))
  const minZ = Math.min(...batchTargets.map((target) => target.position.z))
  const maxZ = Math.max(...batchTargets.map((target) => target.position.z))
  const activeCols = new Set(batchTargets.map((target) => target.col))
  const cp1 = { x: minX + 0.5, y: minY, z: minZ + 0.5 }
  const cp2 = { x: minX + 0.5, y: minY, z: maxZ + 0.5 }

  return startOnNorthSide
    ? [{ position: cp1, action: '', activeCols }, { position: cp2, action: 'lineEnd', activeCols }]
    : [{ position: cp2, action: '', activeCols }, { position: cp1, action: 'lineEnd', activeCols }]
}

async function runNervScannerPlacementBatch(bot, config, batchTargets, startOnNorthSide, allowEmergencyRestock = true) {
  if (!batchTargets.length) return { placed: 0, already: 0, skipped: 0, seen: 0, missing: 0 }

  const printer = config.printer || {}
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
  const seen = new Set()

  const placementLoop = (async () => {
    while (active) {
      const allowPlacement = currentAction === '' || currentAction === 'lineEnd' || currentAction === 'sprint'
      if (allowPlacement) {
        for (let i = 0; i < maxPerTick; i += 1) {
          const target = findNervScannerCandidate(bot, config, targetByXZ, currentGoal, seen, currentActiveCols)
          if (!target) break

          const key = `${target.position.x}:${target.position.y}:${target.position.z}`
          seen.add(key)

          try {
            const result = await placeNervScannerTarget(bot, config, target)
            if (result.state === 'placed') placed += 1
            else if (result.state === 'already') already += 1
            else {
              skipped += 1
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[NERV-SCANNER-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
              }
              if (allowEmergencyRestock && String(result.reason || '').startsWith('missing-item-')) {
                emergencyRestockBlock = target.blockName
                active = false
                break
              }
            }
          } catch (err) {
            skipped += 1
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[NERV-SCANNER-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
            }
          }
        }
      }

      await delay(tickMs)
    }
  })()

  try {
    for (const checkpoint of checkpoints) {
      if (emergencyRestockBlock) break
      currentGoal = checkpoint.position
      currentAction = checkpoint.action
      currentActiveCols = checkpoint.activeCols
      const sprintMode = String(printer.sprintMode || 'notPlacing').toLowerCase()
      const shouldSprint = sprintMode === 'always' || (sprintMode !== 'off' && currentAction === 'sprint')
      bot.setControlState('sprint', shouldSprint)
      await bot.pathfinder.goto(new GoalNear(checkpoint.position.x, checkpoint.position.y, checkpoint.position.z, checkpointBuffer))
    }
  } finally {
    active = false
    await placementLoop
  }

  if (allowEmergencyRestock && emergencyRestockBlock) {
    console.log(`[NERV-SCANNER-EMERGENCY-RESTOCK] ${emergencyRestockBlock} unavailable during placement; stopping movement, refilling, and retrying remaining targets once.`)
    const restocked = await restockMaterial(bot, config, emergencyRestockBlock, 1, neededByBlock)
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

  return { placed, already, skipped, seen: seen.size, missing }
}

async function runNervTimeWorkloadPlacementBatch(bot, config, batchTargets, startOnNorthSide, allowEmergencyRestock = true) {
  if (!batchTargets.length) {
    return { placed: 0, already: 0, skipped: 0, seen: 0, missing: 0, hardStops: 0, rawAllowed: 0, capped: 0, maxAllowed: 0 }
  }

  const printer = config.printer || {}
  const advanced = config.advanced || {}
  const placeDelayMs = Math.max(1, toNumber(advanced.scannerPlaceDelayMs, toNumber(printer.placeDelayMs, 10)))
  const maxCatchup = Math.max(1, toNumber(advanced.scannerMaxCatchupPlacements, 12))
  const pollMs = Math.max(1, toNumber(advanced.scannerWorkloadPollMs, Math.min(10, placeDelayMs)))
  const retryCooldownMs = Math.max(0, toNumber(advanced.scannerRetryCooldownMs, 30))
  const checkpointBuffer = Math.max(0.5, toNumber(advanced.checkpointBuffer, 0.8))

  const checkpoints = buildNervUCheckpoints(batchTargets, startOnNorthSide)

  const targetByXZ = new Map(batchTargets.map((target) => [`${target.position.x}:${target.position.z}`, target]))
  const neededByBlock = estimateNeededFromLookahead(batchTargets)
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
  const seen = new Set()
  const pendingUntil = new Map()

  const placementLoop = (async () => {
    while (active) {
      const now = Date.now()
      const rawAllowed = Math.floor((now - lastTickTime) / placeDelayMs)

      if (rawAllowed <= 0) {
        await delay(pollMs)
        continue
      }

      lastTickTime += rawAllowed * placeDelayMs
      rawAllowedTotal += rawAllowed
      const allowed = Math.min(rawAllowed, maxCatchup)
      cappedTotal += Math.max(0, rawAllowed - allowed)
      maxAllowedSeen = Math.max(maxAllowedSeen, rawAllowed)

      const allowPlacement = currentAction === '' || currentAction === 'lineEnd' || currentAction === 'sprint'
      if (allowPlacement) {
        const burstExcluded = new Set(seen)
        for (const [key, until] of pendingUntil.entries()) {
          if (until > now) burstExcluded.add(key)
          else pendingUntil.delete(key)
        }

        for (let i = 0; i < allowed; i += 1) {
          const target = findNervScannerCandidate(bot, config, targetByXZ, currentGoal, burstExcluded, currentActiveCols)
          if (!target) break

          const key = `${target.position.x}:${target.position.y}:${target.position.z}`
          const neededSwap = String(bot.heldItem?.name || '') !== target.blockName
          burstExcluded.add(key)

          try {
            const result = await placeNervScannerTarget(bot, config, target)
            const actual = bot.blockAt(new bot.entity.position.constructor(target.position.x, target.position.y, target.position.z))

            if (actual?.name === target.blockName) {
              seen.add(key)
              pendingUntil.delete(key)
            } else if (result.state === 'placed') {
              pendingUntil.set(key, Date.now() + retryCooldownMs)
            }

            if (result.state === 'placed') {
              placed += 1
            } else if (result.state === 'already') {
              already += 1
              seen.add(key)
              pendingUntil.delete(key)
            } else {
              skipped += 1
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[NERV-WORKLOAD-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
              }

              if (String(result.reason || '').startsWith('missing-item-')) {
                hardStops += 1
                if (allowEmergencyRestock) {
                  emergencyRestockBlock = target.blockName
                  active = false
                }
                lastTickTime = Date.now()
                break
              }
            }
          } catch (err) {
            skipped += 1
            hardStops += 1
            if (config.errorHandling?.logErrors !== false) {
              console.log(`[NERV-WORKLOAD-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
            }
            lastTickTime = Date.now()
            break
          }

          if (neededSwap) {
            hardStops += 1
            lastTickTime = Date.now()
            break
          }
        }
      }

      await delay(pollMs)
    }
  })()

  try {
    for (const checkpoint of checkpoints) {
      if (emergencyRestockBlock) break
      currentGoal = checkpoint.position
      currentAction = checkpoint.action
      currentActiveCols = checkpoint.activeCols
      const sprintMode = String(printer.sprintMode || 'notPlacing').toLowerCase()
      const shouldSprint = sprintMode === 'always' || (sprintMode !== 'off' && currentAction === 'sprint')
      bot.setControlState('sprint', shouldSprint)
      await bot.pathfinder.goto(new GoalNear(checkpoint.position.x, checkpoint.position.y, checkpoint.position.z, checkpointBuffer))
    }
  } finally {
    active = false
    await placementLoop
  }

  if (allowEmergencyRestock && emergencyRestockBlock) {
    console.log(`[NERV-WORKLOAD-EMERGENCY-RESTOCK] ${emergencyRestockBlock} unavailable during placement; stopping movement, refilling, and retrying remaining targets once.`)
    const restocked = await restockMaterial(bot, config, emergencyRestockBlock, 1, neededByBlock)
    if (restocked || countInventoryItems(bot, emergencyRestockBlock) > 0) {
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
    seen: seen.size,
    missing,
    hardStops,
    rawAllowed: rawAllowedTotal,
    capped: cappedTotal,
    maxAllowed: maxAllowedSeen
  }
}

async function runPrint(bot, config) {
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
  let resumeFrom = 0
  let resumePhase = 'printing'  // tracks which bot phase to resume after crash
  let resumePostPrintStep = 'withdraw'

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
      // If the bot crashed inside repair or post_print, skip the main sweep and jump directly there.
      if (previousPhase === 'repair' || previousPhase === 'post_print') {
        resumePhase = previousPhase
        resumeFrom = orderedTargets.length
      }
      if (previousPhase === 'post_print') {
        resumePostPrintStep = String(previous.postPrintStep || 'withdraw')
      }
      console.log(`[RESUME] Saved state phase=${previous.phase || 'printing'} state=${previous.state || 'n/a'} action=${previous.action || 'n/a'} processed=${resumeFrom}/${orderedTargets.length}.`)
    }
  }

  const pending = orderedTargets.slice(resumeFrom)
  const makePostPrintContext = (extra = {}) => ({
    sourceName: input.sourceName,
    sourcePath: input.sourcePath,
    sourceType: input.sourceType,
    resumePostPrintStep,
    savePostPrintState: (postPrintStep, action = 'post-print-active') => {
      if (!progressEnabled) return
      writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'post_print', {
        state: 'post_print_workflow',
        action,
        postPrintStep
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
    const Vec3 = bot.entity.position.constructor
    const probeSample = pending.slice(0, Math.min(64, pending.length))
    let supportCount = 0
    for (const target of probeSample) {
      const pos = new Vec3(target.position.x, target.position.y, target.position.z)
      const support = bot.blockAt(pos.offset(0, -1, 0))
      if (support && support.name !== 'air') supportCount += 1
    }
    console.log(`[PROBE] support=${supportCount}/${probeSample.length} at startup.`)
  }

  if (!pending.length) {
    console.log('[PLAN] No build targets found.')
    console.log('[VERIFY] Progress indicates completed build. Running verification/repair and post-print workflow.')

    const placeRange = Math.max(1, toNumber(printer.placeRange, 4))
    const Vec3Verify = bot.entity.position.constructor
    let placed = 0
    let skipped = 0
    let already = 0
    const errorList = []

    for (const target of orderedTargets) {
      const actual = bot.blockAt(new Vec3Verify(target.position.x, target.position.y, target.position.z))
      if (actual?.name !== target.blockName) {
        errorList.push(target)
        if (config.errorHandling?.logErrors !== false) {
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
    for (const target of orderedTargets) {
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
      postPrintStep: resumePostPrintStep
    })
  }

  await runPostPrintWorkflow(bot, config, makePostPrintContext())
    await delay(toNumber(config.advanced?.postBuildDelayMs, 0))

    if (files.moveToFinishedFolder) {
      const fromPath = input.sourcePath
      if (fs.existsSync(fromPath)) {
        const finishedDir = path.resolve(process.cwd(), files.finishedFolder || './finished-maps')
        if (!fs.existsSync(finishedDir)) {
          fs.mkdirSync(finishedDir, { recursive: true })
        }

        const toPath = path.join(finishedDir, path.basename(fromPath))
        if (!fs.existsSync(toPath)) {
          fs.renameSync(fromPath, toPath)
          console.log(`[FILES] Moved ${path.basename(fromPath)} to ${toPath}`)
        }
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

  const placeRange = Math.max(1, toNumber(printer.placeRange, 4))
  const postPrintTestOnly = printer.postPrintTestOnly === true

  if (postPrintTestOnly) {
    console.log('[TEST] postPrintTestOnly=true, skipping carpet placement and running post-print workflow only.')
    // Persist phase=post_print so crash here resumes post-print, not repair again
  if (progressEnabled) {
    writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'post_print', {
      state: 'post_print_workflow',
      action: 'post-print-test-only',
      postPrintStep: resumePostPrintStep
    })
  }

  await runPostPrintWorkflow(bot, config, makePostPrintContext())
    await delay(toNumber(config.advanced?.postBuildDelayMs, 0))
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

  if (progressEnabled) {
    saveProgress('printing', { state: 'printing_start', action: 'resume-ready' })
  }


  for (let i = 0; i < colTraversal.length; i += printChunkLines) {
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
      console.log('[NERV-INVENTORY-BLOCKED] Could not clean/refill inventory for this window. Stopping before placement to avoid skips with residue items.')
      return {
        sourceType: input.sourceType,
        sourcePath: input.sourcePath,
        sourceName: input.sourceName,
        didWork: true
      }
    }

    for (let j = 0; j < inventoryCols.length; j += Math.max(1, toNumber(linesPerRun, 1))) {
      const colBatch = inventoryCols.slice(j, j + Math.max(1, toNumber(linesPerRun, 1)))
      const rowOrder = startOnNorthSide ? sortedRowsAsc : [...sortedRowsAsc].reverse()
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

      if (printer.fastTraversalEnabled === true) {
        const scannerWorkloadMode = String(config.advanced?.scannerWorkloadMode || 'fixed').toLowerCase()
        const result = scannerWorkloadMode === 'time'
          ? await placementWorkload.runNervTimeWorkloadPlacementBatch(bot, config, batchTargets, startOnNorthSide)
          : await placementWorkload.runNervScannerPlacementBatch(bot, config, batchTargets, startOnNorthSide)
        placed += result.placed
        already += result.already
        skipped += result.skipped
        processedInRun += batchTargets.length
        if (scannerWorkloadMode === 'time') {
          console.log(`[NERV-WORKLOAD-BATCH] placed=${result.placed} already=${result.already} skipped=${result.skipped} seen=${result.seen}/${batchTargets.length} missing=${result.missing} hardStops=${result.hardStops} rawAllowed=${result.rawAllowed} capped=${result.capped} maxAllowed=${result.maxAllowed}`)
        } else {
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
      } else {
        const firstTarget = rowOrder
          .map((row) => colBatch.map((col) => byColRow.get(`${col}:${row}`)).find(Boolean))
          .find(Boolean)

        if (firstTarget) {
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
                if (config.errorHandling?.logErrors !== false) {
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
        }
      }

      // LineEnd: scan the completed movement row for errors
      saveProgress('printing', {
        state: 'printing_lineend_check',
        action: 'verify-completed-batch',
        colBatch: colBatch.join(',')
      })
      const Vec3_LineEnd = bot.entity.position.constructor
      const errorListKeys = new Set(errorList.map(e => `${e.position.x}:${e.position.y}:${e.position.z}`))
      for (const col of colBatch) {
        for (const row of rowOrder) {
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

      startOnNorthSide = !startOnNorthSide
    }
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

  // Persist phase=post_print so crash here resumes post-print, not repair again
  if (progressEnabled) {
    writeProgressSnapshot(progressFile, input, orderedTargets.length, orderedTargets.length, 'post_print', {
      state: 'post_print_workflow',
      action: 'run-post-print',
      postPrintStep: resumePostPrintStep
    })
  }

  await runPostPrintWorkflow(bot, config, makePostPrintContext())

  await delay(toNumber(config.advanced?.postBuildDelayMs, 0))

  if (files.moveToFinishedFolder) {
    const fromPath = input.sourcePath
    const finishedDir = path.resolve(process.cwd(), files.finishedFolder || './finished-maps')
    if (!fs.existsSync(finishedDir)) {
      fs.mkdirSync(finishedDir, { recursive: true })
    }

    const toPath = path.join(finishedDir, path.basename(fromPath))
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

  return mineflayer.createBot({
    host: botCfg.host || '127.0.0.1',
    port: toNumber(botCfg.port, 25565),
    username: botCfg.username || 'MapartBot',
    auth: botCfg.auth || 'offline',
    version: botCfg.version === 'auto' ? false : (botCfg.version || false),
    profilesFolder: botCfg.profilesFolder || './auth-cache',
    viewDistance: botCfg.viewDistance || 'tiny',
    checkTimeoutInterval: toNumber(botCfg.checkTimeoutInterval, 60000)
  })
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

function normalizeSimpleBotEntry(entry, index, multi) {
  if (typeof entry === 'string') {
    return {
      name: entry.trim(),
      role: index === 0 ? 'master' : 'slave',
      enabled: true,
      joinDelayMs: index * toNumber(multi.joinStaggerMs, 8000),
      startDelayMs: index * toNumber(multi.startStaggerMs, 3000),
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
      raw: entry
    }
  }

  return null
}

function getEnabledMultiBots(config) {
  const multi = config.multiUser || {}
  const simpleRoster = Array.isArray(config.bot?.usernames) && config.bot.usernames.length
    ? config.bot.usernames
    : null
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
  if (bots.length === 1) {
    config.bot = {
      ...(config.bot || {}),
      username: bots[0].name
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
  workerConfig.bot = { ...(workerConfig.bot || {}), username: assignment.name }
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

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    bot.once('spawn', async () => {
      const printer = config.printer || {}
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

  const placementLoop = (async () => {
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
  })()

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

    bot.once('spawn', async () => {
      const printer = config.printer || {}
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

function findNervScannerCandidate(bot, config, targetByXZ, currentGoal, processed = new Set(), activeCols = null) {
  const printer = config.printer || {}
  const placeRange = Math.max(1, toNumber(printer.placeRange, 4))
  const minPlaceDistance = Math.max(0, toNumber(printer.minPlaceDistance, 0.8))
  const radius = Math.ceil(placeRange) + 1
  const Vec3 = bot.entity.position.constructor
  const baseX = Math.floor(bot.entity.position.x)
  const baseZ = Math.floor(bot.entity.position.z)

  let best = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const x = baseX + dx
      const z = baseZ + dz

      const target = targetByXZ.get(`${x}:${z}`)
      if (!target) continue
      if (activeCols instanceof Set && !activeCols.has(target.col)) continue
      const key = `${target.position.x}:${target.position.y}:${target.position.z}`
      if (processed.has(key)) continue

      const targetPos = new Vec3(target.position.x, target.position.y, target.position.z)
      const distance = bot.entity.position.distanceTo(targetPos.offset(0.5, 0.5, 0.5))
      if (distance > placeRange || distance <= minPlaceDistance) continue

      const actual = bot.blockAt(targetPos)
      if (actual && actual.name !== 'air') continue

      if (distance < bestDistance) {
        best = target
        bestDistance = distance
      }
    }
  }

  return best
}

async function placeNervScannerTarget(bot, config, target) {
  const advanced = config.advanced || {}
  const Vec3 = bot.entity.position.constructor
  const targetPos = new Vec3(target.position.x, target.position.y, target.position.z)
  const blockAtTarget = bot.blockAt(targetPos)

  if (blockAtTarget?.name === target.blockName) {
    return { state: 'already' }
  }

  if (blockAtTarget && blockAtTarget.name !== 'air') {
    return { state: 'skip', reason: `occupied-by-${blockAtTarget.name}` }
  }

  const support = bot.blockAt(targetPos.offset(0, -1, 0))
  if (!support || support.name === 'air') {
    return { state: 'skip', reason: 'missing-support' }
  }

  if (String(bot.heldItem?.name || '') !== target.blockName) {
    const equipped = await equipMaterial(bot, config, target.blockName)
    if (!equipped) {
      return { state: 'skip', reason: `missing-item-${target.blockName}` }
    }
    await delay(toNumber(advanced.scannerPreSwapDelayMs, 0))
    await delay(toNumber(advanced.scannerPostSwapDelayMs, 0))
  }

  if (String(bot.heldItem?.name || '') !== target.blockName) {
    const equipped = await equipMaterial(bot, config, target.blockName)
    if (!equipped || String(bot.heldItem?.name || '') !== target.blockName) {
      return { state: 'skip', reason: `missing-item-${target.blockName}` }
    }
  }

  const sneakOnDispenserOnly = config.advanced?.sneakOnDispenserOnly !== false
  const shouldSneak = sneakOnDispenserOnly ? support.name === 'dispenser' : true
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      if (shouldSneak) {
        bot.setControlState('sneak', true)
      }

      if (typeof bot._genericPlace === 'function') {
        await bot._genericPlace(support, new Vec3(0, 1, 0), {
          swingArm: 'right',
          forceLook: 'ignore'
        })
      } else {
        await bot.placeBlock(support, new Vec3(0, 1, 0))
      }
      return { state: 'placed' }
    } catch (err) {
      lastErr = err
      const errMsg = String(err?.message || err).toLowerCase()
      if (!errMsg.includes('must be holding an item') || attempt >= 2) {
        throw err
      }
      await equipMaterial(bot, config, target.blockName)
      await delay(toNumber(advanced.scannerPostSwapDelayMs, 0))
    } finally {
      if (shouldSneak) {
        bot.setControlState('sneak', false)
      }
    }
  } 

  throw lastErr || new Error('scanner placement failed')
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

  const placementLoop = (async () => {
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
  })()

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
  const placeDelayMs = Math.max(1, toNumber(advanced.scannerPlaceDelayMs, toNumber(printer.placeDelayMs, 10)))
  const maxCatchup = Math.max(1, toNumber(advanced.scannerMaxCatchupPlacements, 12))
  const pollMs = Math.max(1, toNumber(advanced.scannerWorkloadPollMs, Math.min(10, placeDelayMs)))
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

  const placementLoop = (async () => {
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
  })()

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

    bot.once('spawn', async () => {
      const printer = config.printer || {}
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

    bot.once('spawn', async () => {
      const printer = config.printer || {}
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

    bot.once('spawn', async () => {
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

    bot.once('spawn', async () => {
      const printer = config.printer || {}
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

    bot.once('spawn', async () => {
      const printer = config.printer || {}
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

function shouldRetryReconnect(session) {
  const endReason = String(session?.endReason || '').toLowerCase()
  const lastError = String(session?.lastError || '').toLowerCase()
  const kicked = String(session?.kickedReason || '').toLowerCase()
  const text = `${endReason} ${lastError} ${kicked}`

  const nonRetryHints = [
    'disconnect.quitting',
    'manual disconnect',
    'logged out',
    'already connected'
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
}

function runSingleSession(config, sessionNumber) {
  return new Promise((resolve) => {
    const bot = createBot(config)
    bot.loadPlugin(pathfinder)

    let lastErrorText = ''
    let kickedText = ''

    let settled = false
    const settle = (reason) => {
      if (settled) return
      settled = true
      resolve({
        endReason: reason || 'disconnected',
        lastError: lastErrorText,
        kickedReason: kickedText
      })
    }

    bot.once('spawn', async () => {
      const printer = config.printer || {}
      const allowJump = printer.allowJump !== false

      console.log(`[SPAWN] Connected. session=${sessionNumber}`)

      configurePathfinderMovements(bot, config)

      await delay(toNumber(printer.startDelayMs, 1500))

      bot.on('physicsTick', () => {
        if (String(printer.sprintMode || 'always').toLowerCase() === 'always') {
          bot.setControlState('sprint', true)
        }

        if (!allowJump) {
          bot.setControlState('jump', false)
        }
      })

      bot.setControlState('sprint', true)
      if (!allowJump) {
        bot.setControlState('jump', false)
      }

      if (printer.startOnSpawn === false) {
        console.log('[STATE] startOnSpawn is false. Waiting idle.')
        return
      }

      try {
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
      } catch (err) {
        console.log('[FATAL]', err?.message || err)
      }
    })

    bot.on('messagestr', (message) => {
      if (config.advanced?.debugPrints) {
        console.log(`[CHAT] ${message}`)
      }
    })

    bot.on('kicked', (reason) => {
      kickedText = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log(`[KICKED] ${kickedText}`)
    })

    bot.on('error', (err) => {
      lastErrorText = err?.message || String(err)
      console.log('[ERROR]', lastErrorText)
    })

    bot.on('end', (reason) => {
      const text = reason || 'disconnected'
      console.log(`[END] ${text}`)
      markProgressInterrupted(config, text, sessionNumber)
      settle(text)
    })
  })
}

async function runWorkerReconnectLoop(workerConfig, assignment, reconnect) {
  return logContext.run({ botName: assignment.name }, async () => {
    await delay(Math.max(0, toNumber(assignment.joinDelayMs, 0)))
    console.log(`[MULTI-LAUNCH] ${assignment.name} role=${assignment.role} joining after ${assignment.joinDelayMs}ms interval=${assignment.interval.start}-${assignment.interval.end}`)

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
      try {
        session = await runSingleSession(workerConfig, attempt)
      } finally {
        clearInterval(heartbeatTimer)
      }
      const retryable = shouldRetryReconnect(session)
      console.log(`[SESSION] attempt=${attempt} end=${session.endReason} retryable=${retryable}`)

      if (!reconnect.enabled || !retryable || attempt >= reconnect.maxAttempts) {
        break
      }

      console.log(`[RECONNECT] Retrying in ${reconnect.delayMs}ms. reason=${session.endReason}`)
      await delay(reconnect.delayMs)
      attempt += 1
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
  const config = loadConfig()
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

  applySingleBotRoster(config)

  if (shouldRunMultiUser(config)) {
    await runMultiUserLive(config, reconnect)
    return
  }

  let attempt = 1
  while (true) {
    if (attempt > 1) {
      console.log(`[RECONNECT] Starting attempt ${attempt}/${reconnect.maxAttempts}.`)
    }

    const session = await runSingleSession(config, attempt)
    const retryable = shouldRetryReconnect(session)
    console.log(`[SESSION] attempt=${attempt} end=${session.endReason} retryable=${retryable}`)

    if (!reconnect.enabled) {
      break
    }

    if (!retryable) {
      console.log(`[RECONNECT] Not retrying due to non-retryable reason: ${session.endReason}`)
      break
    }

    if (attempt >= reconnect.maxAttempts) {
      console.log(`[RECONNECT] Stopping after ${attempt} attempts. Last reason: ${session.endReason}`)
      break
    }

    console.log(`[RECONNECT] Retrying in ${reconnect.delayMs}ms. reason=${session.endReason}`)
    await delay(reconnect.delayMs)
    attempt += 1
  }
}

initLogger()

start().catch((err) => {
  console.error('[FATAL]', err?.message || err)
  process.exitCode = 1
})
