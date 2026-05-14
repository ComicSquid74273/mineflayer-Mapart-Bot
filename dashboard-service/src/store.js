const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const jsonCache = new Map()

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function readJson(filePath, fallback) {
  if (jsonCache.has(filePath)) return jsonCache.get(filePath)
  if (!fs.existsSync(filePath)) return fallback
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    jsonCache.set(filePath, parsed)
    return parsed
  } catch {
    return fallback
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(value), 'utf8')
  fs.renameSync(tempPath, filePath)
  jsonCache.set(filePath, value)
}

function toNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function createStore(baseDir) {
  const dataDir = path.resolve(baseDir)
  const filesDir = path.join(dataDir, 'files')
  const botsFile = path.join(dataDir, 'bots.json')
  const commandsFile = path.join(dataDir, 'commands.json')
  const controlFile = path.join(dataDir, 'control.json')
  const uploadsFile = path.join(dataDir, 'files.json')
  const eventsFile = path.join(dataDir, 'events.json')
  const operatorsFile = path.join(dataDir, 'operators.json')
  const nodeStatsFile = path.join(dataDir, 'node-stats.json')
  const nodeInventoryFile = path.join(dataDir, 'node-inventory.json')
  const nodeLogDownloadsDir = path.join(dataDir, 'node-log-downloads')
  const BOT_FRESH_MS = Math.max(5000, Number(process.env.DASHBOARD_BOT_FRESH_MS || 90000))
  const NODE_INVENTORY_FRESH_MS = Math.max(BOT_FRESH_MS, Number(process.env.DASHBOARD_NODE_INVENTORY_FRESH_MS || 3 * 60 * 1000))
  const ALERT_ERROR_TTL_MS = Math.max(30000, Number(process.env.DASHBOARD_ALERT_ERROR_TTL_MS || 15 * 60 * 1000))
  const ALERT_WARNING_TTL_MS = Math.max(30000, Number(process.env.DASHBOARD_ALERT_WARNING_TTL_MS || 15 * 60 * 1000))
  const NODE_TIMING_RECONCILE_MS = Math.max(1000, Number(process.env.DASHBOARD_NODE_TIMING_RECONCILE_MS || 10000))
  const QUEUE_BATCH_HIGH_WATER = Math.max(1, Number(process.env.DASHBOARD_QUEUE_BATCH_HIGH_WATER || 10))
  const QUEUE_BATCH_MAX_CLAIM = Math.max(1, Number(process.env.DASHBOARD_QUEUE_BATCH_MAX_CLAIM || 10))
  const COUNTED_NODE_PHASES = new Set(['printing', 'repair', 'rescan', 'post-print', 'cleanup'])
  const HOLD_NODE_PHASES = new Set([])
  const nextNodeTimingReconcileAtByHost = new Map()

  function defaultOperators() {
    if (String(process.env.DASHBOARD_SEED_DEMO_OPERATORS || '').trim().toLowerCase() !== 'true') {
      return [
        {
          username: String(process.env.DASHBOARD_ADMIN_USERNAME || 'admin').trim() || 'admin',
          password: String(process.env.DASHBOARD_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url')).trim(),
          role: 'admin',
          permissions: {},
          createdAt: nowIso(),
          updatedAt: nowIso()
        }
      ]
    }
    return [
      {
        username: 'admin-demo',
        password: 'admin-demo',
        role: 'admin',
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso()
      },
      {
        username: 'operator-demo',
        password: 'operator-demo',
        role: 'operator',
        permissions: {
          canViewLogs: true,
          canOperate: true,
          canDeleteNodeFiles: false,
          canManageOperators: false
        },
        createdAt: nowIso(),
        updatedAt: nowIso()
      },
      {
        username: 'viewer-demo',
        password: 'viewer-demo',
        role: 'viewer',
        permissions: {
          canViewLogs: true,
          canOperate: false,
          canDeleteNodeFiles: false,
          canManageOperators: false
        },
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
    ]
  }

  ensureDir(dataDir)
  ensureDir(filesDir)
  ensureDir(nodeLogDownloadsDir)
  if (!fs.existsSync(botsFile)) writeJson(botsFile, {})
  if (!fs.existsSync(commandsFile)) writeJson(commandsFile, [])
  if (!fs.existsSync(controlFile)) writeJson(controlFile, { pausedBots: {} })
  if (!fs.existsSync(uploadsFile)) writeJson(uploadsFile, [])
  if (!fs.existsSync(eventsFile)) writeJson(eventsFile, [])
  if (!fs.existsSync(operatorsFile)) writeJson(operatorsFile, defaultOperators())
  if (!fs.existsSync(nodeStatsFile)) writeJson(nodeStatsFile, {})
  if (!fs.existsSync(nodeInventoryFile)) writeJson(nodeInventoryFile, {})

  function toTimestamp(value) {
    const ms = new Date(value || 0).getTime()
    return Number.isFinite(ms) ? ms : 0
  }

  function readBotMap() {
    const bots = readJson(botsFile, {})
    return bots && typeof bots === 'object' && !Array.isArray(bots) ? bots : {}
  }

  function readControlState() {
    const state = readJson(controlFile, { pausedBots: {} })
    return state && typeof state === 'object' && !Array.isArray(state) ? {
      ...state,
      pausedBots: state.pausedBots && typeof state.pausedBots === 'object' && !Array.isArray(state.pausedBots) ? state.pausedBots : {}
    } : { pausedBots: {} }
  }

  function saveControlState(state) {
    writeJson(controlFile, {
      ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}),
      pausedBots: state?.pausedBots && typeof state.pausedBots === 'object' && !Array.isArray(state.pausedBots) ? state.pausedBots : {}
    })
  }

  function readNodeInventoryMap() {
    const items = readJson(nodeInventoryFile, {})
    return items && typeof items === 'object' && !Array.isArray(items) ? items : {}
  }

  function writeNodeInventoryMap(items) {
    writeJson(nodeInventoryFile, items && typeof items === 'object' && !Array.isArray(items) ? items : {})
  }

  function readNodeStatsMap() {
    const items = readJson(nodeStatsFile, {})
    return items && typeof items === 'object' && !Array.isArray(items) ? items : {}
  }

  function saveNodeStatsMap(items) {
    writeJson(nodeStatsFile, items)
  }

  function sanitizeNodeFileEntry(input) {
    if (!input || typeof input !== 'object') return null
    const fileName = path.basename(String(input.fileName || '').trim())
    if (!fileName) return null
    const reportedByBotNames = Array.isArray(input.reportedByBotNames)
      ? input.reportedByBotNames
      : (input.reportedByBotName ? [input.reportedByBotName] : [])
    return {
      fileName,
      sizeBytes: Math.max(0, toNumber(input.sizeBytes, 0)),
      modifiedAt: String(input.modifiedAt || '').trim() || null,
      reportedByBotNames: reportedByBotNames
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .sort((left, right) => String(left).localeCompare(String(right), undefined, { sensitivity: 'base' }))
    }
  }

  function mergeNodeFileEntries(currentItems, incomingItems) {
    const byName = new Map()
    for (const item of [...(Array.isArray(currentItems) ? currentItems : []), ...(Array.isArray(incomingItems) ? incomingItems : [])]) {
      const normalized = sanitizeNodeFileEntry(item)
      if (!normalized) continue
      const key = normalized.fileName.toLowerCase()
      const existing = byName.get(key)
      if (!existing) {
        byName.set(key, normalized)
        continue
      }
      const existingModifiedMs = toTimestamp(existing.modifiedAt)
      const nextModifiedMs = toTimestamp(normalized.modifiedAt)
      byName.set(key, {
        fileName: normalized.fileName || existing.fileName,
        sizeBytes: Math.max(toNumber(existing.sizeBytes, 0), toNumber(normalized.sizeBytes, 0)),
        modifiedAt: nextModifiedMs >= existingModifiedMs
          ? (normalized.modifiedAt || existing.modifiedAt)
          : (existing.modifiedAt || normalized.modifiedAt),
        reportedByBotNames: Array.from(new Set([
          ...(Array.isArray(existing.reportedByBotNames) ? existing.reportedByBotNames : []),
          ...(Array.isArray(normalized.reportedByBotNames) ? normalized.reportedByBotNames : [])
        ])).sort((left, right) => String(left).localeCompare(String(right), undefined, { sensitivity: 'base' }))
      })
    }
    return Array.from(byName.values())
      .sort((left, right) => String(left.fileName).localeCompare(String(right.fileName), undefined, { numeric: true, sensitivity: 'base' }))
  }

  function addNodeFileEntries(byName, incomingItems) {
    if (!(byName instanceof Map)) return byName
    for (const item of Array.isArray(incomingItems) ? incomingItems : []) {
      const normalized = sanitizeNodeFileEntry(item)
      if (!normalized) continue
      const key = normalized.fileName.toLowerCase()
      const existing = byName.get(key)
      if (!existing) {
        byName.set(key, normalized)
        continue
      }
      const existingModifiedMs = toTimestamp(existing.modifiedAt)
      const nextModifiedMs = toTimestamp(normalized.modifiedAt)
      byName.set(key, {
        fileName: normalized.fileName || existing.fileName,
        sizeBytes: Math.max(toNumber(existing.sizeBytes, 0), toNumber(normalized.sizeBytes, 0)),
        modifiedAt: nextModifiedMs >= existingModifiedMs
          ? (normalized.modifiedAt || existing.modifiedAt)
          : (existing.modifiedAt || normalized.modifiedAt),
        reportedByBotNames: Array.from(new Set([
          ...(Array.isArray(existing.reportedByBotNames) ? existing.reportedByBotNames : []),
          ...(Array.isArray(normalized.reportedByBotNames) ? normalized.reportedByBotNames : [])
        ]))
      })
    }
    return byName
  }

  function finalizeNodeFileEntries(byName) {
    if (!(byName instanceof Map)) return []
    return Array.from(byName.values())
      .map((item) => ({
        ...item,
        reportedByBotNames: Array.from(new Set(Array.isArray(item.reportedByBotNames) ? item.reportedByBotNames : []))
          .sort((left, right) => String(left).localeCompare(String(right), undefined, { sensitivity: 'base' }))
      }))
      .sort((left, right) => String(left.fileName).localeCompare(String(right.fileName), undefined, { numeric: true, sensitivity: 'base' }))
  }

  function createAssignmentStats() {
    return {
      assignedTotal: 0,
      assignedPending: 0,
      assignedCompleted: 0,
      assignedFailed: 0
    }
  }

  function addAssignmentStatus(stats, status) {
    stats.assignedTotal += 1
    const normalized = String(status || '').trim().toLowerCase()
    if (normalized === 'failed' || normalized === 'failed-final') {
      stats.assignedFailed += 1
    } else if (normalized === 'placed' || normalized === 'succeeded' || normalized === 'completed') {
      stats.assignedCompleted += 1
    } else if (normalized === 'pending' || normalized === 'assigned' || normalized === 'claimed' || normalized === 'downloaded' || normalized === 'printing') {
      stats.assignedPending += 1
    }
    return stats
  }

  function buildAssignmentStatsByHost(botMap) {
    const botToHost = new Map()
    for (const bot of Object.values(botMap || {})) {
      const botName = String(bot?.botName || '').trim()
      const hostLabel = String(bot?.hostLabel || '').trim()
      if (botName && hostLabel) botToHost.set(botName, hostLabel)
    }

    const byHost = new Map()
    const ensureStats = (hostLabel) => {
      const normalizedHost = String(hostLabel || '').trim()
      if (!normalizedHost) return null
      const stats = byHost.get(normalizedHost) || createAssignmentStats()
      byHost.set(normalizedHost, stats)
      return stats
    }

    for (const item of listFiles()) {
      const targetHost = String(item.assignedHostLabel || '').trim()
      const targetBot = String(item.assignedBotName || '').trim()
      const hostLabel = targetHost || (targetBot ? botToHost.get(targetBot) : '')
      const stats = ensureStats(hostLabel)
      if (stats) addAssignmentStatus(stats, item.deliveryStatus)
    }

    return byHost
  }

  function createNodeOperationalStats() {
    return {
      reconnectCount: 0,
      reconnectingCount: 0,
      staleBotCount: 0,
      warningCount: 0,
      errorCount: 0,
      remainingMaps: 0
    }
  }

  function timestampMs(value) {
    const parsed = new Date(value || 0).getTime()
    return Number.isFinite(parsed) ? parsed : 0
  }

  function isRecentTimestamp(value, ttlMs, now = Date.now()) {
    const parsed = timestampMs(value)
    if (!parsed) return false
    const age = now - parsed
    return age >= 0 && age <= ttlMs
  }

  function hasRecentBotError(bot, now = Date.now()) {
    const text = String(bot?.lastError || '').trim()
    if (!text) return false
    return isRecentTimestamp(bot?.lastErrorAt, ALERT_ERROR_TTL_MS, now)
  }

  function countRecentWarnings(warnings, now = Date.now()) {
    return (Array.isArray(warnings) ? warnings : []).filter((warning) => {
      const lastSeenAt = warning?.lastSeenAt || warning?.firstSeenAt
      return isRecentTimestamp(lastSeenAt, ALERT_WARNING_TTL_MS, now)
    }).length
  }

  function sanitizeTimingRun(input) {
    if (!input || typeof input !== 'object') return null
    const fileName = String(input.fileName || '').trim()
    if (!fileName) return null
    const startedAt = String(input.startedAt || '').trim()
    const lastSeenAt = String(input.lastSeenAt || '').trim() || startedAt
    return {
      fileName: path.basename(fileName),
      startedAt: startedAt || nowIso(),
      lastSeenAt: lastSeenAt || startedAt || nowIso(),
      activeBotCount: Math.max(0, toNumber(input.activeBotCount, 0)),
      accumulatedActiveMs: Math.max(0, toNumber(input.accumulatedActiveMs, 0)),
      segmentStartedAt: String(input.segmentStartedAt || '').trim() || null,
      segmentLastSeenAt: String(input.segmentLastSeenAt || '').trim() || null,
      botNames: Array.isArray(input.botNames)
        ? input.botNames.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      maxProgressPercent: Math.min(100, Math.max(0, toNumber(input.maxProgressPercent, 0)))
    }
  }

  function sanitizeTimingHistoryEntry(input) {
    if (!input || typeof input !== 'object') return null
    const fileName = String(input.fileName || '').trim()
    const startedAt = String(input.startedAt || '').trim()
    const completedAt = String(input.completedAt || '').trim()
    const durationMs = Math.max(0, toNumber(input.durationMs, 0))
    if (!fileName || !startedAt || !completedAt || !Number.isFinite(durationMs) || durationMs <= 0) return null
    return {
      fileName: path.basename(fileName),
      startedAt,
      completedAt,
      durationMs,
      botNames: Array.isArray(input.botNames)
        ? input.botNames.map((item) => String(item || '').trim()).filter(Boolean)
        : []
    }
  }

  function createNodeTimingRecord(input = null) {
    const totalCompletedMaps = Math.max(0, toNumber(input?.totalCompletedMaps, 0))
    const totalDurationMs = Math.max(0, toNumber(input?.totalDurationMs, 0))
    const recentRuns = (Array.isArray(input?.recentRuns) ? input.recentRuns : [])
      .map((item) => sanitizeTimingHistoryEntry(item))
      .filter(Boolean)
      .slice(-12)
    const averageDurationMs = totalCompletedMaps > 0
      ? Math.round(totalDurationMs / totalCompletedMaps)
      : 0
    return {
      totalCompletedMaps,
      totalDurationMs,
      averageDurationMs,
      recentRuns,
      activeRun: sanitizeTimingRun(input?.activeRun),
      updatedAt: String(input?.updatedAt || '').trim() || null
    }
  }

  function isCountedNodePhase(phase) {
    return COUNTED_NODE_PHASES.has(String(phase || '').trim().toLowerCase())
  }

  function isHoldNodePhase(phase) {
    return HOLD_NODE_PHASES.has(String(phase || '').trim().toLowerCase())
  }

  function getOpenSegmentDurationMs(run, endAt = null) {
    const startMs = toTimestamp(run?.segmentStartedAt)
    if (!startMs) return 0
    const endMs = Math.max(startMs, toTimestamp(endAt || run?.segmentLastSeenAt || run?.lastSeenAt || nowIso()))
    return Math.max(0, endMs - startMs)
  }

  function closeTimingSegment(run, endAt = null) {
    const current = sanitizeTimingRun(run)
    if (!current) return null
    return sanitizeTimingRun({
      ...current,
      accumulatedActiveMs: current.accumulatedActiveMs + getOpenSegmentDurationMs(current, endAt),
      segmentStartedAt: null,
      segmentLastSeenAt: null
    })
  }

  function buildHostActivitySnapshot(hostLabel, botMap) {
    const normalizedHost = String(hostLabel || '').trim()
    const bots = Object.values(botMap || {}).filter((bot) => String(bot?.hostLabel || '').trim() === normalizedHost)
    let lastHostStatusAt = null
    let lastHostStatusAtMs = 0
    const groups = new Map()

    for (const bot of bots) {
      const statusAt = String(bot?.lastStatusAt || bot?.heartbeatAt || '').trim()
      const statusAtMs = toTimestamp(statusAt)
      if (statusAtMs >= lastHostStatusAtMs) {
        lastHostStatusAtMs = statusAtMs
        lastHostStatusAt = statusAt || lastHostStatusAt
      }

      const currentNbt = String(bot?.currentNbt || '').trim()
      const phase = String(bot?.phase || '').trim().toLowerCase()
      const countedPhase = isCountedNodePhase(phase)
      const holdPhase = isHoldNodePhase(phase)
      if (!currentNbt || (!countedPhase && !holdPhase)) continue

      const fileName = path.basename(currentNbt)
      const current = groups.get(fileName) || {
        fileName,
        botCount: 0,
        activeBotCount: 0,
        countedStartedAtCandidate: null,
        countedStartedAtCandidateMs: 0,
        countedLastSeenAt: null,
        countedLastSeenAtMs: 0,
        lastSeenAt: statusAt || nowIso(),
        lastSeenAtMs: statusAtMs || Date.now(),
        botNames: [],
        maxProgressPercent: 0
      }

      current.botCount += 1
      const botProgressPercent = toNumber(bot?.progress?.percent, 0)
      if (botProgressPercent > current.maxProgressPercent) current.maxProgressPercent = botProgressPercent
      if (countedPhase) {
        current.activeBotCount += 1
        if (statusAtMs && (!current.countedStartedAtCandidateMs || statusAtMs < current.countedStartedAtCandidateMs)) {
          current.countedStartedAtCandidateMs = statusAtMs
          current.countedStartedAtCandidate = statusAt
        }
        if (statusAtMs >= current.countedLastSeenAtMs) {
          current.countedLastSeenAtMs = statusAtMs || current.countedLastSeenAtMs
          current.countedLastSeenAt = statusAt || current.countedLastSeenAt
        }
      }
      if (statusAtMs >= current.lastSeenAtMs) {
        current.lastSeenAtMs = statusAtMs || current.lastSeenAtMs
        current.lastSeenAt = statusAt || current.lastSeenAt
      }
      current.botNames.push(String(bot?.botName || '').trim())
      groups.set(fileName, current)
    }

    const activeRun = Array.from(groups.values())
      .sort((left, right) => {
        if (right.activeBotCount !== left.activeBotCount) return right.activeBotCount - left.activeBotCount
        if (right.botCount !== left.botCount) return right.botCount - left.botCount
        return right.lastSeenAtMs - left.lastSeenAtMs
      })[0] || null

    return {
      lastHostStatusAt: lastHostStatusAt || nowIso(),
      lastHostStatusAtMs: lastHostStatusAtMs || Date.now(),
      activeRun
    }
  }

  function recordCompletedNodeRun(record, completedRun, wasCompleted = false) {
    if (!wasCompleted) return createNodeTimingRecord(record)
    const startedAtMs = toTimestamp(completedRun.startedAt)
    const completedAtMs = Math.max(startedAtMs, toTimestamp(completedRun.completedAt))
    const durationMs = Math.max(0, toNumber(completedRun.durationMs, Math.max(0, completedAtMs - startedAtMs)))
    const historyEntry = sanitizeTimingHistoryEntry({
      fileName: completedRun.fileName,
      startedAt: completedRun.startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs,
      botNames: completedRun.botNames
    })

    if (!historyEntry) return createNodeTimingRecord(record)

    const next = createNodeTimingRecord(record)
    next.totalCompletedMaps += 1
    next.totalDurationMs += historyEntry.durationMs
    next.averageDurationMs = next.totalCompletedMaps > 0
      ? Math.round(next.totalDurationMs / next.totalCompletedMaps)
      : 0
    next.recentRuns = [...next.recentRuns, historyEntry].slice(-12)
    next.updatedAt = historyEntry.completedAt
    return next
  }

  function summarizeNodeTiming(record) {
    const current = createNodeTimingRecord(record)
    const activeRun = current.activeRun
      ? {
          ...current.activeRun,
          elapsedMs: current.activeRun.accumulatedActiveMs + getOpenSegmentDurationMs(current.activeRun, Date.now())
        }
      : null
    const lastCompleted = current.recentRuns[current.recentRuns.length - 1] || null
    return {
      totalCompletedMaps: current.totalCompletedMaps,
      totalDurationMs: current.totalDurationMs,
      averageDurationMs: current.averageDurationMs,
      lastCompletedAt: lastCompleted?.completedAt || null,
      lastCompletedFileName: lastCompleted?.fileName || null,
      activeRun,
      recentRuns: current.recentRuns,
      updatedAt: current.updatedAt || null
    }
  }

  function reconcileHostNodeTiming(hostLabel, botMap = readBotMap()) {
    const normalizedHost = String(hostLabel || '').trim()
    if (!normalizedHost) return summarizeNodeTiming(null)

    const statsMap = readNodeStatsMap()
    let nextRecord = createNodeTimingRecord(statsMap[normalizedHost])
    const snapshot = buildHostActivitySnapshot(normalizedHost, botMap)
    const previousActiveRun = nextRecord.activeRun
    const snapshotActiveRun = snapshot.activeRun

    if (previousActiveRun && (!snapshotActiveRun || snapshotActiveRun.fileName !== previousActiveRun.fileName)) {
      const closedRun = closeTimingSegment(previousActiveRun, previousActiveRun.segmentLastSeenAt || snapshot.lastHostStatusAt || nowIso())
      const wasCompleted = (previousActiveRun.maxProgressPercent || 0) >= 100
      nextRecord = recordCompletedNodeRun(nextRecord, {
        fileName: closedRun?.fileName || previousActiveRun.fileName,
        startedAt: closedRun?.startedAt || previousActiveRun.startedAt,
        completedAt: snapshotActiveRun?.countedStartedAtCandidate || snapshot.lastHostStatusAt || previousActiveRun.lastSeenAt || nowIso(),
        durationMs: closedRun?.accumulatedActiveMs || 0,
        botNames: closedRun?.botNames || previousActiveRun.botNames
      }, wasCompleted)
      nextRecord.activeRun = null
    }

    if (snapshotActiveRun) {
      if (!nextRecord.activeRun || nextRecord.activeRun.fileName !== snapshotActiveRun.fileName) {
        nextRecord.activeRun = sanitizeTimingRun({
          fileName: snapshotActiveRun.fileName,
          startedAt: snapshotActiveRun.countedStartedAtCandidate || snapshotActiveRun.lastSeenAt || snapshot.lastHostStatusAt || nowIso(),
          lastSeenAt: snapshotActiveRun.lastSeenAt || snapshot.lastHostStatusAt || nowIso(),
          activeBotCount: snapshotActiveRun.activeBotCount,
          accumulatedActiveMs: 0,
          segmentStartedAt: snapshotActiveRun.activeBotCount > 0
            ? (snapshotActiveRun.countedStartedAtCandidate || snapshot.lastHostStatusAt || nowIso())
            : null,
          segmentLastSeenAt: snapshotActiveRun.activeBotCount > 0
            ? (snapshotActiveRun.countedLastSeenAt || snapshot.lastHostStatusAt || nowIso())
            : null,
          botNames: snapshotActiveRun.botNames,
          maxProgressPercent: snapshotActiveRun.maxProgressPercent || 0
        })
      } else {
        let activeRun = sanitizeTimingRun({
          ...nextRecord.activeRun,
          lastSeenAt: snapshotActiveRun.lastSeenAt || nextRecord.activeRun.lastSeenAt,
          activeBotCount: snapshotActiveRun.activeBotCount,
          botNames: snapshotActiveRun.botNames,
          maxProgressPercent: Math.max(nextRecord.activeRun.maxProgressPercent || 0, snapshotActiveRun.maxProgressPercent || 0)
        })
        if (snapshotActiveRun.activeBotCount > 0) {
          activeRun = sanitizeTimingRun({
            ...activeRun,
            segmentStartedAt: activeRun.segmentStartedAt || snapshotActiveRun.countedStartedAtCandidate || snapshot.lastHostStatusAt || nowIso(),
            segmentLastSeenAt: snapshotActiveRun.countedLastSeenAt || activeRun.segmentLastSeenAt || snapshot.lastHostStatusAt || nowIso()
          })
        } else if (activeRun.segmentStartedAt) {
          activeRun = closeTimingSegment(activeRun, activeRun.segmentLastSeenAt || snapshot.lastHostStatusAt || nowIso())
        }
        nextRecord.activeRun = activeRun
      }
    } else {
      nextRecord.activeRun = null
    }

    nextRecord.updatedAt = snapshot.lastHostStatusAt || nextRecord.updatedAt || nowIso()
    statsMap[normalizedHost] = nextRecord
    saveNodeStatsMap(statsMap)
    return summarizeNodeTiming(nextRecord)
  }

  function reconcileAllNodeTiming(botMap = readBotMap()) {
    const hostLabels = new Set(
      Object.values(botMap)
        .map((bot) => String(bot?.hostLabel || '').trim())
        .filter(Boolean)
    )
    for (const hostLabel of hostLabels) {
      reconcileHostNodeTiming(hostLabel, botMap)
    }
  }

  function sanitizeOperatorPermissions(input) {
    const source = input && typeof input === 'object' ? input : {}
    const permissions = {}
    for (const key of ['canViewLogs', 'canOperate', 'canDeleteNodeFiles', 'canManageOperators']) {
      if (typeof source[key] === 'boolean') permissions[key] = source[key]
    }
    return permissions
  }

  function sanitizeOperatorRecord(input, options = {}) {
    const includePassword = options.includePassword === true
    const username = String(input?.username || '').trim()
    if (!username) return null
    const record = {
      username,
      role: String(input?.role || 'viewer').trim().toLowerCase() || 'viewer',
      permissions: sanitizeOperatorPermissions(input?.permissions),
      createdAt: input?.createdAt || nowIso(),
      updatedAt: input?.updatedAt || nowIso()
    }
    if (includePassword) {
      record.password = String(input?.password || '')
    }
    return record
  }

  function readOperators(includePasswords = false) {
    const fallback = defaultOperators()
    const items = readJson(operatorsFile, fallback)
    const normalized = (Array.isArray(items) ? items : fallback)
      .map((item) => sanitizeOperatorRecord(item, { includePassword: true }))
      .filter((item) => item && item.username && item.password)
      .sort((left, right) => String(left.username).localeCompare(String(right.username), undefined, { sensitivity: 'base' }))
    if (!includePasswords) {
      return normalized.map((item) => sanitizeOperatorRecord(item, { includePassword: false }))
    }
    return normalized
  }

  function saveOperators(items) {
    writeJson(operatorsFile, (Array.isArray(items) ? items : [])
      .map((item) => sanitizeOperatorRecord(item, { includePassword: true }))
      .filter((item) => item && item.username && item.password))
  }

  function listOperators() {
    return readOperators(false)
  }

  function listOperatorCredentials() {
    return readOperators(true)
  }

  function getOperator(username, includePassword = false) {
    const wanted = String(username || '').trim().toLowerCase()
    if (!wanted) return null
    const items = readOperators(includePassword)
    return items.find((item) => String(item.username || '').trim().toLowerCase() === wanted) || null
  }

  function upsertOperator(input) {
    const username = String(input?.username || '').trim()
    if (!username) return null
    const items = readOperators(true)
    const existingIndex = items.findIndex((item) => String(item.username || '').trim().toLowerCase() === username.toLowerCase())
    const existing = existingIndex >= 0 ? items[existingIndex] : null
    const password = String(input?.password || '')

    if (!existing && !password) {
      return null
    }

    const next = {
      username,
      password: password || existing.password,
      role: String(input?.role || existing?.role || 'viewer').trim().toLowerCase() || 'viewer',
      permissions: input && Object.prototype.hasOwnProperty.call(input, 'permissions')
        ? sanitizeOperatorPermissions(input.permissions)
        : sanitizeOperatorPermissions(existing?.permissions),
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso()
    }

    if (existingIndex >= 0) {
      items[existingIndex] = next
    } else {
      items.push(next)
    }

    saveOperators(items)
    return sanitizeOperatorRecord(next, { includePassword: false })
  }

  function deleteOperator(username) {
    const wanted = String(username || '').trim().toLowerCase()
    if (!wanted) return null
    const items = readOperators(true)
    const index = items.findIndex((item) => String(item.username || '').trim().toLowerCase() === wanted)
    if (index < 0) return null
    const [removed] = items.splice(index, 1)
    saveOperators(items)
    return sanitizeOperatorRecord(removed, { includePassword: false })
  }

  function listBotsFromMap(botMap) {
    const bots = botMap && typeof botMap === 'object' ? botMap : {}
    return Object.values(bots).sort((left, right) => String(left.botName).localeCompare(String(right.botName)))
  }

  function listBots() {
    return listBotsFromMap(readBotMap())
  }

  function getBot(botName) {
    const bots = readBotMap()
    return bots[botName] || null
  }

  function listNodesFromMap(botMapInput) {
    const botMap = botMapInput && typeof botMapInput === 'object' ? botMapInput : {}
    const nowMs = Date.now()
    const nodeInventoryMap = readNodeInventoryMap()
    const timingByHost = readNodeStatsMap()
    const assignmentStatsByHost = buildAssignmentStatsByHost(botMap)
    const byHost = new Map()
    for (const bot of Object.values(botMap)) {
      const hostLabel = String(bot.hostLabel || '').trim() || 'unknown-host'
      const inventory = nodeInventoryMap[bot.botName] && String(nodeInventoryMap[bot.botName].hostLabel || '').trim() === hostLabel
        ? nodeInventoryMap[bot.botName]
        : bot
      const botFinishedMapFiles = Array.isArray(inventory.finishedMapFiles) ? inventory.finishedMapFiles : []
      const reportedFinishedMapCount = Math.max(0, toNumber(inventory.finishedMapCount, botFinishedMapFiles.length))
      const current = byHost.get(hostLabel) || {
        hostLabel,
        botCount: 0,
        onlineCount: 0,
        botNames: [],
        configFiles: [],
        lastStatusAt: null,
        nodeFiles: [],
        nodeLogs: [],
        finishedMapCount: 0,
        finishedMapFiles: [],
        totalCompletedMapCount: 0,
        _nodeFilesByName: new Map(),
        _nodeLogsByName: new Map(),
        _finishedMapFilesByName: new Map(),
        latestFinishedMapStatusAtMs: 0,
        timing: summarizeNodeTiming(timingByHost[hostLabel]),
        assignmentStats: assignmentStatsByHost.get(hostLabel) || createAssignmentStats(),
        operationalStats: createNodeOperationalStats()
      }
      current.botCount += 1
      const botLastStatusMs = new Date(bot?.serverStatusAt || bot?.lastStatusAt || bot?.heartbeatAt || 0).getTime()
      const botAgeMs = Number.isFinite(botLastStatusMs) ? Math.max(0, nowMs - botLastStatusMs) : Number.POSITIVE_INFINITY
      const botOnline = botAgeMs <= BOT_FRESH_MS && bot.online === true
      const inventoryStatusMs = timestampMs(inventory.nodeInventoryAt || inventory.serverStatusAt || inventory.lastStatusAt || bot.serverStatusAt || bot.lastStatusAt || bot.heartbeatAt)
      const inventoryFresh = inventoryStatusMs > 0 && (nowMs - inventoryStatusMs) <= NODE_INVENTORY_FRESH_MS
      if (botOnline) current.onlineCount += 1
      current.botNames.push(bot.botName)
      const configFileName = path.basename(String(bot.configFileName || '').trim())
      if (configFileName && !current.configFiles.includes(configFileName)) {
        current.configFiles.push(configFileName)
        current.configFiles.sort((left, right) => String(left).localeCompare(String(right), undefined, { sensitivity: 'base' }))
      }
      current.operationalStats.reconnectCount += Math.max(0, toNumber(bot.reconnectCount, 0))
      if (String(bot.reconnectState || '').trim().toLowerCase() === 'reconnecting') current.operationalStats.reconnectingCount += 1
      if (botOnline && String(bot.activeState || '').trim().toLowerCase() === 'stale') current.operationalStats.staleBotCount += 1
      if (botOnline && hasRecentBotError(bot, nowMs)) current.operationalStats.errorCount += 1
      current.operationalStats.warningCount += botOnline ? countRecentWarnings(bot.warnings, nowMs) : 0
      if (inventoryFresh) {
        addNodeFileEntries(current._nodeFilesByName, inventory.nodeFiles)
        addNodeFileEntries(current._nodeLogsByName, inventory.nodeLogs)
        addNodeFileEntries(current._finishedMapFilesByName, botFinishedMapFiles)
      }
      if (inventoryFresh && inventoryStatusMs >= current.latestFinishedMapStatusAtMs && (Object.prototype.hasOwnProperty.call(inventory, 'finishedMapCount') || botFinishedMapFiles.length > 0)) {
        current.latestFinishedMapStatusAtMs = inventoryStatusMs
        current.finishedMapCount = reportedFinishedMapCount
      } else if (!current.latestFinishedMapStatusAtMs) {
        current.finishedMapCount = current._finishedMapFilesByName.size
      }
      const botStatusAt = bot.serverStatusAt || bot.lastStatusAt || null
      if (!current.lastStatusAt || String(botStatusAt || '') > String(current.lastStatusAt || '')) {
        current.lastStatusAt = botStatusAt
      }
      byHost.set(hostLabel, current)
    }
    for (const node of byHost.values()) {
      node.nodeFiles = finalizeNodeFileEntries(node._nodeFilesByName)
      node.nodeLogs = finalizeNodeFileEntries(node._nodeLogsByName)
      node.finishedMapFiles = finalizeNodeFileEntries(node._finishedMapFilesByName)
      node.totalCompletedMapCount = Math.max(
        Math.max(0, toNumber(node.finishedMapCount, 0)),
        Math.max(0, toNumber(node.timing?.totalCompletedMaps, 0))
      )
      delete node._nodeFilesByName
      delete node._nodeLogsByName
      delete node._finishedMapFilesByName
      node.operationalStats.remainingMaps = Math.max(0, toNumber(node.assignmentStats?.assignedTotal, 0) - toNumber(node.finishedMapCount, 0))
    }
    return Array.from(byHost.values()).sort((left, right) => String(left.hostLabel).localeCompare(String(right.hostLabel)))
  }

  function listNodes() {
    return listNodesFromMap(readBotMap())
  }

  function listFleet() {
    const botMap = readBotMap()
    return {
      bots: listBotsFromMap(botMap),
      nodes: listNodesFromMap(botMap)
    }
  }

  function listBotsForHost(hostLabel) {
    return listBots().filter((bot) => String(bot.hostLabel || '').trim() === String(hostLabel || '').trim())
  }

  function reconcileQueueForBotLocalWork(status) {
    const botName = String(status?.botName || '').trim()
    const hostLabel = String(status?.hostLabel || '').trim()
    if (!botName || !hostLabel) return

    const currentNbt = path.basename(String(status?.currentNbt || '').trim())
    const localNodeFiles = Array.isArray(status?.nodeFiles)
      ? status.nodeFiles.map((entry) => path.basename(String(entry?.fileName || entry?.name || '').trim())).filter(Boolean)
      : []
    const localNames = new Set([currentNbt, ...localNodeFiles].filter(Boolean))
    if (!localNames.size) return

    const phase = normalizeFileStatus(status?.phase, 'held')
    const resumableStatus = ['printing', 'repair', 'post-print', 'cleanup'].includes(phase) ? phase : 'held'
    const items = listFiles()
    let changed = false

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (!isQueueFile(item)) continue
      const queueStatus = getQueueStatus(item)
      if (!['failed', 'failed-final', 'pending', 'held'].includes(queueStatus)) continue
      if (item.claimedByBotName && item.claimedByBotName !== botName) continue
      if (item.claimedByHostLabel && item.claimedByHostLabel !== hostLabel) continue

      const names = [
        item.localFileName,
        item.originalName,
        item.storedName,
        item.fileName
      ].map((value) => path.basename(String(value || '').trim())).filter(Boolean)
      if (!names.some((name) => localNames.has(name))) continue

      items[index] = {
        ...item,
        claimedByBotName: botName,
        claimedByHostLabel: hostLabel,
        claimHeartbeatAt: nowIso(),
        deliveryStatus: resumableStatus,
        queueStatus: resumableStatus,
        queueMode: true,
        localFileName: currentNbt || names[0] || item.localFileName || null,
        failedReason: queueStatus === 'failed-final'
          ? `revived from ${queueStatus}; bot still reports local NBT work`
          : item.failedReason || null,
        retryReason: null
      }
      changed = true
    }

    if (changed) saveFiles(items)
  }

  function upsertBotStatus(status) {
    const bots = readBotMap()
    const previous = bots[status.botName] || {}
    const receivedAt = nowIso()
    const previousReconnectCount = Math.max(0, toNumber(previous.reconnectCount, 0))
    const reportedReconnectCount = Math.max(0, toNumber(status.reconnectCount, 0))
    const previousRuntimeInstanceId = String(previous.runtimeInstanceId || '').trim()
    const reportedRuntimeInstanceId = String(status.runtimeInstanceId || '').trim()
    const runtimeRestartDetected = Boolean(previous.botName && previousRuntimeInstanceId && reportedRuntimeInstanceId && previousRuntimeInstanceId !== reportedRuntimeInstanceId)
    const reconnectCount = runtimeRestartDetected
      ? Math.max(previousReconnectCount + 1, reportedReconnectCount)
      : Math.max(previousReconnectCount, reportedReconnectCount)
    const next = {
      ...previous,
      ...status,
      reconnectCount,
      nodeRestartCount: Math.max(0, toNumber(previous.nodeRestartCount, 0)) + (runtimeRestartDetected ? 1 : 0),
      reportedLastStatusAt: status.lastStatusAt || null,
      reportedHeartbeatAt: status.heartbeatAt || null,
      serverStatusAt: receivedAt,
      lastStatusAt: receivedAt
    }
    const inventoryFields = ['nodeFiles', 'nodeLogs', 'finishedMapFiles', 'finishedMapCount', 'nodeInventoryAt']
    const hasInventoryPayload = inventoryFields.some((field) => Object.prototype.hasOwnProperty.call(status, field))
    if (hasInventoryPayload) {
      const inventory = readNodeInventoryMap()
      inventory[status.botName] = {
        botName: status.botName,
        hostLabel: status.hostLabel,
        nodeFiles: Array.isArray(status.nodeFiles) ? status.nodeFiles : [],
        nodeLogs: Array.isArray(status.nodeLogs) ? status.nodeLogs : [],
        finishedMapFiles: Array.isArray(status.finishedMapFiles) ? status.finishedMapFiles : [],
        finishedMapCount: Math.max(0, toNumber(status.finishedMapCount, Array.isArray(status.finishedMapFiles) ? status.finishedMapFiles.length : 0)),
        nodeInventoryAt: status.nodeInventoryAt || next.lastStatusAt,
        serverStatusAt: receivedAt,
        updatedAt: receivedAt
      }
      writeNodeInventoryMap(inventory)
    }
    for (const field of inventoryFields) {
      delete next[field]
    }
    bots[status.botName] = next
    writeJson(botsFile, bots)
    reconcileQueueForBotLocalWork(next)
    const normalizedHost = String(next.hostLabel || '').trim()
    if (normalizedHost) {
      const nowMs = Date.now()
      const nextReconcileAt = nextNodeTimingReconcileAtByHost.get(normalizedHost) || 0
      if (nowMs >= nextReconcileAt) {
        nextNodeTimingReconcileAtByHost.set(normalizedHost, nowMs + NODE_TIMING_RECONCILE_MS)
        reconcileHostNodeTiming(normalizedHost, bots)
      }
    }
    return next
  }

  function listCommands(filterFn = null) {
    const items = readJson(commandsFile, [])
    return typeof filterFn === 'function' ? items.filter(filterFn) : items
  }

  function getCommand(commandId) {
    return listCommands((item) => item.commandId === commandId)[0] || null
  }

  function compactCommandRecord(item) {
    if (!item || typeof item !== 'object') return item
    const status = String(item.status || '').trim().toLowerCase()
    if (item.commandType === 'upload-node-file' && status !== 'pending' && status !== 'claimed' && Object.prototype.hasOwnProperty.call(item, 'contentBase64')) {
      const { contentBase64, ...rest } = item
      return rest
    }
    return item
  }

  function compactCommandList(items) {
    let changed = false
    const compacted = (Array.isArray(items) ? items : []).map((item) => {
      const next = compactCommandRecord(item)
      if (next !== item) changed = true
      return next
    })
    return { items: compacted, changed }
  }

  function saveCommands(items) {
    writeJson(commandsFile, compactCommandList(items).items)
  }

  function createCommand(input) {
    const items = listCommands()
    const nextItems = ['start', 'stop'].includes(input.commandType) && input.targetBotName
      ? items.filter((item) => !(item.targetBotName === input.targetBotName && ['start', 'stop'].includes(item.commandType) && (item.status === 'pending' || item.status === 'claimed')))
      : items
    const command = {
      commandId: crypto.randomUUID(),
      targetBotName: input.targetBotName || null,
      targetHostLabel: input.targetHostLabel || null,
      claimedByBotName: null,
      commandType: input.commandType,
      createdAt: nowIso(),
      status: 'pending',
      requestedBy: input.requestedBy || null,
      nbtFileId: input.nbtFileId || null,
      fileName: input.fileName || null,
      contentBase64: input.contentBase64 || null,
      reason: input.reason || null,
      message: input.message || null,
      expiresAt: input.expiresAt || null,
      resultMessage: null,
      completedAt: null
    }
    nextItems.push(command)
    saveCommands(nextItems)
    return command
  }

  function createCommandsForBots(botNames, commandType, extra = {}) {
    return botNames.map((botName) => createCommand({ ...extra, targetBotName: botName, commandType }))
  }

  function setBotPauseDesired(botName, paused, reason = null) {
    const name = String(botName || '').trim()
    if (!name) return null
    const state = readControlState()
    if (paused === true) {
      const previous = state.pausedBots[name] && typeof state.pausedBots[name] === 'object' ? state.pausedBots[name] : {}
      const pausedAt = String(previous.pausedAt || previous.updatedAt || '').trim() || nowIso()
      state.pausedBots[name] = {
        paused: true,
        reason: reason || null,
        pausedAt,
        updatedAt: nowIso()
      }
    } else {
      delete state.pausedBots[name]
    }
    saveControlState(state)
    return state.pausedBots[name] || null
  }

  function setBotsPauseDesired(botNames, paused, reason = null) {
    return (Array.isArray(botNames) ? botNames : []).map((botName) => setBotPauseDesired(botName, paused, reason))
  }

  function isBotPauseDesired(botName) {
    const name = String(botName || '').trim()
    if (!name) return false
    return readControlState().pausedBots[name]?.paused === true
  }

  function getBotPauseState(botName) {
    const name = String(botName || '').trim()
    if (!name) return null
    const item = readControlState().pausedBots[name]
    if (!item || item.paused !== true) return null
    return {
      paused: true,
      reason: item.reason || null,
      pausedAt: item.pausedAt || item.updatedAt || null,
      updatedAt: item.updatedAt || null
    }
  }

  function isBotReportingPaused(bot) {
    const phase = String(bot?.phase || '').trim().toLowerCase()
    const detail = String(bot?.statusDetail || '').trim().toLowerCase()
    const active = String(bot?.activeState || '').trim().toLowerCase()
    return phase === 'paused' || detail === 'paused' || active === 'paused'
  }

  function ensureDesiredPauseCommand(botName) {
    const name = String(botName || '').trim()
    if (!name || !isBotPauseDesired(name)) return null
    const bot = getBot(name)
    if (isBotReportingPaused(bot)) return null
    const existing = listCommands((item) => item.targetBotName === name && item.commandType === 'stop' && (item.status === 'pending' || item.status === 'claimed'))[0]
    if (existing) return existing
    return createCommand({
      targetBotName: name,
      commandType: 'stop',
      reason: 'dashboard-pause-policy'
    })
  }

  function claimCommand(botName, commandId) {
    const items = listCommands()
    const index = items.findIndex((item) => item.commandId === commandId && item.targetBotName === botName)
    if (index < 0) return null
    const current = items[index]
    if (current.status !== 'pending') return current
    items[index] = { ...current, status: 'claimed', claimedByBotName: botName }
    saveCommands(items)
    return items[index]
  }

  function completeCommand(botName, commandId, status, resultMessage) {
    const items = listCommands()
    const index = items.findIndex((item) => item.commandId === commandId && item.targetBotName === botName)
    if (index < 0) return null
    const current = items[index]
    items[index] = compactCommandRecord({
      ...current,
      status,
      resultMessage: resultMessage || null,
      completedAt: nowIso()
    })
    saveCommands(items)
    return items[index]
  }

  function listPendingCommands(botName) {
    ensureDesiredPauseCommand(botName)
    return listCommands((item) => item.targetBotName === botName && (item.status === 'pending' || item.status === 'claimed'))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  }

  function listFiles() {
    return readJson(uploadsFile, []).sort((left, right) => String(right.uploadedAt).localeCompare(String(left.uploadedAt)))
  }

  function getFile(fileId) {
    return listFiles().find((item) => item.fileId === fileId) || null
  }

  function saveFiles(items) {
    writeJson(uploadsFile, items)
  }

  function normalizeFileStatus(status, fallback = 'pending') {
    const normalized = String(status || '').trim().toLowerCase()
    return normalized || fallback
  }

  function isQueueFile(item) {
    return item?.queueMode === true || Boolean(item?.queueStatus) || Boolean(item?.batchId)
  }

  function getQueueStatus(item) {
    return normalizeFileStatus(item?.queueStatus || item?.deliveryStatus, 'pending')
  }

  function isTerminalQueueStatus(status) {
    const normalized = normalizeFileStatus(status, '')
    return normalized === 'placed' || normalized === 'completed' || normalized === 'succeeded' || normalized === 'cancelled'
  }

  function isActiveQueueStatus(status) {
    return ['claimed', 'downloaded', 'printing', 'repair', 'post-print', 'cleanup', 'held'].includes(normalizeFileStatus(status, ''))
  }

  function isRetryableQueueFile(item) {
    const status = getQueueStatus(item)
    return status === 'failed' || status === 'failed-final' || item?.deliveryStatus === 'failed'
  }

  function queueFileMatchesWorker(item, hostLabel, botName) {
    const normalizedHost = String(hostLabel || '').trim()
    const normalizedBot = String(botName || '').trim()
    const targetHost = String(item?.targetHostLabel || item?.assignedHostLabel || '').trim()
    const targetBot = String(item?.targetBotName || item?.assignedBotName || '').trim()
    if (targetHost && targetHost !== normalizedHost) return false
    if (targetBot && targetBot !== normalizedBot) return false
    return true
  }

  function listEvents(limit = 100) {
    const items = readJson(eventsFile, [])
    return items.slice(-Math.max(1, Number(limit) || 100)).reverse()
  }

  function addEvent(input) {
    const items = readJson(eventsFile, [])
    const event = {
      eventId: crypto.randomUUID(),
      createdAt: nowIso(),
      level: input.level || 'info',
      operator: input.operator || 'unknown',
      action: input.action || 'unknown',
      message: input.message || '',
      details: input.details || null
    }
    items.push(event)
    const maxEvents = 500
    writeJson(eventsFile, items.slice(-maxEvents))
    return event
  }

  function createFileUpload({
    originalName,
    contentBase64,
    contentBuffer,
    uploadedBy,
    notes,
    targetHostLabel,
    targetBotName,
    batchId,
    source,
    queueMode,
    maxAttempts
  }) {
    const buffer = Buffer.isBuffer(contentBuffer)
      ? contentBuffer
      : Buffer.from(String(contentBase64 || ''), 'base64')
    const fileId = crypto.randomUUID()
    const extension = path.extname(originalName || '').toLowerCase() || '.nbt'
    const storedName = `${fileId}${extension}`
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    const duplicateCount = listFiles().filter((item) => String(item.originalName || '').toLowerCase() === String(originalName || '').toLowerCase()).length
    const assignedHostLabel = String(targetHostLabel || '').trim() || null
    const assignedBotName = String(targetBotName || '').trim() || null
    const queued = queueMode === true
    const initialStatus = queued ? 'pending' : (assignedHostLabel ? 'assigned' : 'unassigned')
    fs.writeFileSync(path.join(filesDir, storedName), buffer)

    const item = {
      fileId,
      originalName: originalName || storedName,
      storedName,
      uploadedAt: nowIso(),
      sizeBytes: buffer.length,
      sha256,
      assignedBotName,
      assignedHostLabel,
      targetBotName: assignedBotName,
      targetHostLabel: assignedHostLabel,
      claimedByBotName: null,
      claimedByHostLabel: null,
      claimedAt: null,
      claimHeartbeatAt: null,
      deliveryStatus: initialStatus,
      queueMode: queued,
      queueStatus: queued ? 'pending' : null,
      batchId: String(batchId || '').trim() || null,
      source: String(source || 'upload').trim() || 'upload',
      attemptCount: 0,
      claimCount: 0,
      maxAttempts: Math.max(1, toNumber(maxAttempts, 3)),
      failureHistory: [],
      uploadedBy: uploadedBy || null,
      notes: notes || null,
      nameConflictCount: duplicateCount,
      deliveredAt: null,
      downloadedAt: null,
      lastAttemptAt: null,
      failedReason: null
    }

    const items = listFiles()
    items.push(item)
    saveFiles(items)
    return item
  }

  function assignFile(fileId, botName) {
    const items = listFiles()
    const index = items.findIndex((item) => item.fileId === fileId)
    if (index < 0) return null
    items[index] = {
      ...items[index],
      assignedBotName: botName,
      deliveryStatus: 'assigned',
      failedReason: null
    }
    saveFiles(items)
    // Cancel any stale assign-nbt commands for this file before creating a new one.
    const commands = listCommands()
    const updated = commands.map((cmd) =>
      cmd.nbtFileId === fileId && cmd.commandType === 'assign-nbt' && (cmd.status === 'pending' || cmd.status === 'claimed')
        ? { ...cmd, status: 'failed', resultMessage: 'cancelled: file reassigned', completedAt: nowIso() }
        : cmd
    )
    saveCommands(updated)
    createCommand({ targetBotName: botName, commandType: 'assign-nbt', nbtFileId: fileId })
    return items[index]
  }

  function assignFileToNode(fileId, hostLabel) {
    const normalizedHost = String(hostLabel || '').trim()
    if (!normalizedHost) return null
    const items = listFiles()
    const index = items.findIndex((item) => item.fileId === fileId)
    if (index < 0) return null
    items[index] = {
      ...items[index],
      assignedBotName: null,
      assignedHostLabel: normalizedHost,
      claimedByBotName: null,
      claimedAt: null,
      deliveryStatus: 'assigned',
      failedReason: null,
      deliveredAt: null
    }
    saveFiles(items)
    // Cancel any pending/claimed assign-nbt commands for this file so bots don't
    // keep retrying a bot-level command that no longer matches the assignment.
    const commands = listCommands()
    const updated = commands.map((cmd) =>
      cmd.nbtFileId === fileId && cmd.commandType === 'assign-nbt' && (cmd.status === 'pending' || cmd.status === 'claimed')
        ? { ...cmd, status: 'failed', resultMessage: 'cancelled: file reassigned to node', completedAt: nowIso() }
        : cmd
    )
    saveCommands(updated)
    return items[index]
  }

  function getNextAssignedFile(botName) {
    return listFiles().find((item) => item.assignedBotName === botName && (item.deliveryStatus === 'assigned' || item.deliveryStatus === 'downloaded')) || null
  }

  function claimNextNodeFile(hostLabel, botName) {
    const normalizedHost = String(hostLabel || '').trim()
    const normalizedBot = String(botName || '').trim()
    if (!normalizedHost || !normalizedBot) return null
    const items = listFiles()
    const index = items.findIndex((item) => item.assignedHostLabel === normalizedHost && item.deliveryStatus === 'assigned')
    if (index < 0) return null
    items[index] = {
      ...items[index],
      claimedByBotName: normalizedBot,
      claimedAt: nowIso(),
      deliveryStatus: 'claimed',
      failedReason: null
    }
    saveFiles(items)
    return items[index]
  }

  function claimNextNodeCommand(hostLabel, botName) {
    const normalizedHost = String(hostLabel || '').trim()
    const normalizedBot = String(botName || '').trim()
    if (!normalizedHost || !normalizedBot) return null
    const items = listCommands()
    const commandMatchesBot = (item) => !item.targetBotName || String(item.targetBotName || '').trim() === normalizedBot
    const index = items.findIndex((item) =>
      item.targetHostLabel === normalizedHost
      && commandMatchesBot(item)
      && (item.status === 'pending' || (item.status === 'claimed' && item.claimedByBotName === normalizedBot))
    )
    if (index < 0) return null
    const current = items[index]
    if (current.status === 'pending') {
      items[index] = {
        ...current,
        status: 'claimed',
        claimedByBotName: normalizedBot
      }
      saveCommands(items)
      return items[index]
    }
    return current
  }

  function completeFileDelivery(botName, fileId, deliveryStatus, failedReason) {
    const items = listFiles()
    const index = items.findIndex((item) => item.fileId === fileId && item.assignedBotName === botName)
    if (index < 0) return null
    items[index] = {
      ...items[index],
      deliveryStatus,
      deliveredAt: deliveryStatus === 'placed' ? nowIso() : items[index].deliveredAt,
      failedReason: failedReason || null
    }
    saveFiles(items)
    return items[index]
  }

  function completeNodeFileDelivery(hostLabel, fileId, deliveryStatus, failedReason, botName = null) {
    const normalizedHost = String(hostLabel || '').trim()
    const normalizedBot = botName ? String(botName).trim() : null
    const items = listFiles()
    const index = items.findIndex((item) => item.fileId === fileId && item.assignedHostLabel === normalizedHost)
    if (index < 0) return null
    const current = items[index]
    if (normalizedBot && current.claimedByBotName && current.claimedByBotName !== normalizedBot) {
      return null
    }
    items[index] = {
      ...current,
      deliveryStatus,
      deliveredAt: deliveryStatus === 'placed' ? nowIso() : current.deliveredAt,
      failedReason: failedReason || null
    }
    saveFiles(items)
    return items[index]
  }

  function isPendingQueueCandidate(item) {
    const status = getQueueStatus(item)
    if (isTerminalQueueStatus(status)) return false
    if (isActiveQueueStatus(status)) return false
    return status === 'pending'
  }

  function getQueueBatchPolicy(limit = 1) {
    const requestedLimit = Math.max(1, Math.min(QUEUE_BATCH_MAX_CLAIM, Math.floor(toNumber(limit, 1))))
    const knownNodeCount = Math.max(1, listNodes().length || 0)
    const pendingQueueCount = listFiles().filter((item) => isQueueFile(item) && isPendingQueueCandidate(item)).length
    const threshold = knownNodeCount * QUEUE_BATCH_HIGH_WATER
    return {
      requestedLimit,
      knownNodeCount,
      pendingQueueCount,
      threshold,
      batchLimited: requestedLimit > 1 && pendingQueueCount < threshold
    }
  }

  function claimNextQueueFiles(hostLabel, botName, limit = 1) {
    const normalizedHost = String(hostLabel || '').trim()
    const normalizedBot = String(botName || '').trim()
    if (!normalizedHost || !normalizedBot) return []

    const items = listFiles()
    const sortedIndexes = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => isQueueFile(item) && queueFileMatchesWorker(item, normalizedHost, normalizedBot))
      .sort((left, right) => String(left.item.uploadedAt || '').localeCompare(String(right.item.uploadedAt || '')))

    const policy = getQueueBatchPolicy(limit)
    const requestedLimit = policy.requestedLimit
    const lowQueueDepth = policy.batchLimited
    const claimed = []
    let changed = false

    for (const held of sortedIndexes.filter(({ item }) => {
      const status = getQueueStatus(item)
      return item.claimedByBotName === normalizedBot && isActiveQueueStatus(status)
    })) {
      if (claimed.length >= requestedLimit) break
      const current = items[held.index]
      items[held.index] = {
        ...current,
        claimedByHostLabel: normalizedHost,
        claimHeartbeatAt: nowIso()
      }
      claimed.push(items[held.index])
      changed = true
    }

    const newClaimLimit = lowQueueDepth
      ? Math.min(1, Math.max(0, requestedLimit - claimed.length))
      : Math.max(0, requestedLimit - claimed.length)
    let newClaimCount = 0

    for (const next of sortedIndexes.filter(({ item }) => isPendingQueueCandidate(item))) {
      if (newClaimCount >= newClaimLimit) break

      const current = items[next.index]
      items[next.index] = {
        ...current,
        claimedByBotName: normalizedBot,
        claimedByHostLabel: normalizedHost,
        claimedAt: nowIso(),
        claimHeartbeatAt: nowIso(),
        deliveryStatus: 'claimed',
        queueStatus: 'claimed',
        queueMode: true,
        claimCount: Math.max(0, toNumber(current.claimCount, 0)) + 1,
        lastAttemptAt: nowIso(),
        failedReason: null,
        retryReason: null,
        localFileName: null,
        localPath: null
      }
      claimed.push(items[next.index])
      newClaimCount += 1
      changed = true
    }

    if (changed) saveFiles(items)
    return claimed
  }

  function claimNextQueueFile(hostLabel, botName) {
    return claimNextQueueFiles(hostLabel, botName, 1)[0] || null
  }

  function isResumableQueueRuntimeFailure(failedReason = '') {
    const text = String(failedReason || '').toLowerCase()
    if (!text) return false
    return (
      text.includes('nerv-workload-checkpoint-timeout') ||
      text.includes('checkpoint-timeout') ||
      text.includes('goal was changed') ||
      text.includes('goalchanged') ||
      text.includes('path was interrupted') ||
      text.includes('platform-hold') ||
      text.includes('platform-stall') ||
      text.includes('latency') ||
      text.includes('timed out') ||
      text.includes('timeout')
    )
  }

  function completeQueueFileDelivery(hostLabel, botName, fileId, deliveryStatus, failedReason = null, details = null) {
    const normalizedHost = String(hostLabel || '').trim()
    const normalizedBot = String(botName || '').trim()
    const status = normalizeFileStatus(deliveryStatus, '')
    const items = listFiles()
    const index = items.findIndex((item) => item.fileId === fileId && isQueueFile(item))
    if (index < 0) return null

    const current = items[index]
    if (current.claimedByBotName && current.claimedByBotName !== normalizedBot) return null
    if (current.claimedByHostLabel && current.claimedByHostLabel !== normalizedHost) return null

    if (['downloaded', 'printing', 'repair', 'post-print', 'cleanup', 'held'].includes(status)) {
      items[index] = {
        ...current,
        claimedByBotName: normalizedBot || current.claimedByBotName || null,
        claimedByHostLabel: normalizedHost || current.claimedByHostLabel || null,
        claimHeartbeatAt: nowIso(),
        deliveryStatus: status,
        queueStatus: status,
        queueMode: true,
        downloadedAt: status === 'downloaded' ? nowIso() : current.downloadedAt || null,
        localFileName: path.basename(String(details?.localFileName || current.localFileName || current.originalName || current.storedName || '')),
        localPath: String(details?.localPath || current.localPath || '').trim() || null,
        failedReason: null
      }
      saveFiles(items)
      return items[index]
    }

    if (status === 'placed' || status === 'completed' || status === 'succeeded') {
      items[index] = {
        ...current,
        claimedByBotName: normalizedBot || current.claimedByBotName || null,
        claimedByHostLabel: normalizedHost || current.claimedByHostLabel || null,
        claimHeartbeatAt: nowIso(),
        deliveryStatus: 'placed',
        queueStatus: 'completed',
        queueMode: true,
        deliveredAt: nowIso(),
        localFileName: path.basename(String(details?.localFileName || current.localFileName || current.originalName || current.storedName || '')),
        localPath: String(details?.localPath || current.localPath || '').trim() || null,
        failedReason: null
      }
      saveFiles(items)
      return items[index]
    }

    if (status === 'failed' && isResumableQueueRuntimeFailure(failedReason)) {
      items[index] = {
        ...current,
        claimedByBotName: normalizedBot || current.claimedByBotName || null,
        claimedByHostLabel: normalizedHost || current.claimedByHostLabel || null,
        claimHeartbeatAt: nowIso(),
        deliveryStatus: 'held',
        queueStatus: 'held',
        queueMode: true,
        localFileName: path.basename(String(details?.localFileName || current.localFileName || current.originalName || current.storedName || '')),
        localPath: String(details?.localPath || current.localPath || '').trim() || null,
        failedReason: failedReason || null,
        retryReason: failedReason || null,
        lastAttemptAt: nowIso()
      }
      saveFiles(items)
      return items[index]
    }

    if (status === 'failed') {
      const attemptCount = Math.max(0, toNumber(current.attemptCount, 0)) + 1
      const maxAttempts = Math.max(1, toNumber(current.maxAttempts, 3))
      const finalFailure = attemptCount >= maxAttempts
      const history = Array.isArray(current.failureHistory) ? current.failureHistory.slice(-19) : []
      history.push({
        botName: normalizedBot || current.claimedByBotName || null,
        hostLabel: normalizedHost || current.claimedByHostLabel || null,
        failedAt: nowIso(),
        reason: failedReason || null,
        attempt: attemptCount
      })
      items[index] = {
        ...current,
        claimedByBotName: normalizedBot || current.claimedByBotName || null,
        claimedByHostLabel: normalizedHost || current.claimedByHostLabel || null,
        claimHeartbeatAt: nowIso(),
        deliveryStatus: 'failed',
        queueStatus: finalFailure ? 'failed-final' : 'pending',
        queueMode: true,
        attemptCount,
        failedReason: failedReason || null,
        failedAt: nowIso(),
        lastAttemptAt: nowIso(),
        failureHistory: history
      }
      saveFiles(items)
      return items[index]
    }

    return null
  }

  function releaseQueueFile(fileId, reason = null) {
    const items = listFiles()
    const index = items.findIndex((item) => item.fileId === fileId && isQueueFile(item))
    if (index < 0) return null
    const current = items[index]
    if (isTerminalQueueStatus(getQueueStatus(current))) return current
    if (isActiveQueueStatus(getQueueStatus(current))) return null
    items[index] = {
      ...current,
      claimedByBotName: null,
      claimedByHostLabel: null,
      claimedAt: null,
      claimHeartbeatAt: null,
      deliveryStatus: 'pending',
      queueStatus: 'pending',
      queueMode: true,
      attemptCount: Math.max(0, toNumber(current.attemptCount, 0)),
      failedReason: reason || current.failedReason || null
    }
    saveFiles(items)
    return items[index]
  }

  function retryQueueFile(fileId, reason = null) {
    const items = listFiles()
    const index = items.findIndex((item) => item.fileId === fileId && isQueueFile(item))
    if (index < 0) return null
    const current = items[index]
    if (!isRetryableQueueFile(current)) return null
    const history = Array.isArray(current.retryHistory) ? current.retryHistory.slice(-19) : []
    history.push({
      retryAt: nowIso(),
      reason: reason || null,
      previousStatus: getQueueStatus(current),
      previousAttemptCount: Math.max(0, toNumber(current.attemptCount, 0)),
      previousClaimedByBotName: current.claimedByBotName || null,
      previousClaimedByHostLabel: current.claimedByHostLabel || null
    })
    items[index] = {
      ...current,
      claimedByBotName: null,
      claimedByHostLabel: null,
      claimedAt: null,
      claimHeartbeatAt: null,
      deliveryStatus: 'pending',
      queueStatus: 'pending',
      queueMode: true,
      attemptCount: 0,
      failedReason: null,
      retryReason: reason || null,
      retryHistory: history,
      retriedAt: nowIso()
    }
    saveFiles(items)
    return items[index]
  }

  function retryFailedQueueFiles(reason = null) {
    const items = listFiles()
    const affected = []
    const next = items.map((item) => {
      if (!isQueueFile(item) || !isRetryableQueueFile(item)) return item
      const history = Array.isArray(item.retryHistory) ? item.retryHistory.slice(-19) : []
      history.push({
        retryAt: nowIso(),
        reason: reason || null,
        previousStatus: getQueueStatus(item),
        previousAttemptCount: Math.max(0, toNumber(item.attemptCount, 0)),
        previousClaimedByBotName: item.claimedByBotName || null,
        previousClaimedByHostLabel: item.claimedByHostLabel || null
      })
      affected.push({
        fileId: item.fileId,
        originalName: item.originalName || null,
        previousStatus: getQueueStatus(item),
        previousAttemptCount: Math.max(0, toNumber(item.attemptCount, 0)),
        previousClaimedByBotName: item.claimedByBotName || null,
        previousClaimedByHostLabel: item.claimedByHostLabel || null
      })
      return {
        ...item,
        claimedByBotName: null,
        claimedByHostLabel: null,
        claimedAt: null,
        claimHeartbeatAt: null,
        deliveryStatus: 'pending',
        queueStatus: 'pending',
        queueMode: true,
        attemptCount: 0,
        failedReason: null,
        retryReason: reason || null,
        retryHistory: history,
        retriedAt: nowIso()
      }
    })
    if (affected.length) saveFiles(next)
    return { count: affected.length, items: affected }
  }

  function resetDashboardForFreshStart() {
    const previousFiles = listFiles()
    const previousInventoryMap = readNodeInventoryMap()
    const previousInventory = Object.keys(previousInventoryMap)
    const previousCommands = listCommands()
    const bots = readBotMap()
    const nodeStats = readNodeStatsMap()
    const completedByHost = new Map()
    let clearedBotInventoryFields = 0
    const deletedUploadFiles = []
    const uploadErrors = []

    function rememberCompletedCount(hostLabel, count) {
      const normalizedHost = String(hostLabel || '').trim()
      const completed = Math.max(0, toNumber(count, 0))
      if (!normalizedHost || completed <= 0) return
      completedByHost.set(normalizedHost, Math.max(completedByHost.get(normalizedHost) || 0, completed))
    }

    for (const item of Object.values(previousInventoryMap)) {
      rememberCompletedCount(item?.hostLabel, Math.max(
        toNumber(item?.finishedMapCount, 0),
        Array.isArray(item?.finishedMapFiles) ? item.finishedMapFiles.length : 0
      ))
    }
    for (const bot of Object.values(bots)) {
      rememberCompletedCount(bot?.hostLabel, Math.max(
        toNumber(bot?.finishedMapCount, 0),
        Array.isArray(bot?.finishedMapFiles) ? bot.finishedMapFiles.length : 0
      ))
    }
    for (const [hostLabel, completed] of completedByHost.entries()) {
      const current = createNodeTimingRecord(nodeStats[hostLabel])
      if (completed > current.totalCompletedMaps) {
        const averageDurationMs = current.averageDurationMs > 0
          ? current.averageDurationMs
          : (current.totalCompletedMaps > 0 && current.totalDurationMs > 0 ? Math.round(current.totalDurationMs / current.totalCompletedMaps) : 0)
        nodeStats[hostLabel] = {
          ...current,
          totalCompletedMaps: completed,
          totalDurationMs: averageDurationMs > 0 ? averageDurationMs * completed : current.totalDurationMs,
          averageDurationMs,
          updatedAt: current.updatedAt || nowIso()
        }
      }
    }

    if (fs.existsSync(filesDir)) {
      for (const entry of fs.readdirSync(filesDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const filePath = path.join(filesDir, entry.name)
        try {
          fs.unlinkSync(filePath)
          deletedUploadFiles.push(entry.name)
        } catch (err) {
          uploadErrors.push({ fileName: entry.name, error: err?.message || String(err) })
        }
      }
    }

    saveCommands([])
    saveFiles([])
    writeNodeInventoryMap({})
    saveNodeStatsMap(nodeStats)
    for (const bot of Object.values(bots)) {
      let changed = false
      for (const field of ['nodeFiles', 'nodeLogs', 'finishedMapFiles', 'finishedMapCount', 'nodeInventoryAt']) {
        if (Object.prototype.hasOwnProperty.call(bot, field)) {
          delete bot[field]
          changed = true
        }
      }
      if (changed) clearedBotInventoryFields += 1
    }
    if (clearedBotInventoryFields) writeJson(botsFile, bots)

    return {
      clearedQueueFiles: previousFiles.length,
      clearedNodeInventories: previousInventory.length,
      clearedBotInventoryFields,
      clearedCommands: previousCommands.length,
      deletedUploadFiles: deletedUploadFiles.length,
      uploadErrors
    }
  }

  function completeNodeCommand(hostLabel, commandId, status, resultMessage, botName = null) {
    const normalizedHost = String(hostLabel || '').trim()
    const normalizedBot = botName ? String(botName).trim() : null
    const items = listCommands()
    const index = items.findIndex((item) => item.commandId === commandId && item.targetHostLabel === normalizedHost)
    if (index < 0) return null
    const current = items[index]
    if (normalizedBot && current.claimedByBotName && current.claimedByBotName !== normalizedBot) {
      return null
    }
    items[index] = compactCommandRecord({
      ...current,
      status,
      resultMessage: resultMessage || null,
      completedAt: nowIso()
    })
    saveCommands(items)
    return items[index]
  }

  function saveNodeLogDownload({ commandId, hostLabel, botName, fileName, contentBase64 }) {
    const safeCommandId = String(commandId || '').trim()
    const safeHostLabel = String(hostLabel || '').trim()
    const safeFileName = path.basename(String(fileName || '').trim())
    if (!safeCommandId || !safeHostLabel || !safeFileName) return null
    const dataPath = path.join(nodeLogDownloadsDir, `${safeCommandId}.log`)
    const metaPath = path.join(nodeLogDownloadsDir, `${safeCommandId}.json`)
    const buffer = Buffer.from(String(contentBase64 || ''), 'base64')
    fs.writeFileSync(dataPath, buffer)
    writeJson(metaPath, {
      commandId: safeCommandId,
      hostLabel: safeHostLabel,
      botName: String(botName || '').trim() || null,
      fileName: safeFileName,
      sizeBytes: buffer.length,
      savedAt: nowIso()
    })
    return { dataPath, metaPath }
  }

  function getNodeLogDownload(commandId) {
    const safeCommandId = String(commandId || '').trim()
    if (!safeCommandId) return null
    const dataPath = path.join(nodeLogDownloadsDir, `${safeCommandId}.log`)
    const metaPath = path.join(nodeLogDownloadsDir, `${safeCommandId}.json`)
    if (!fs.existsSync(dataPath) || !fs.existsSync(metaPath)) return null
    const meta = readJson(metaPath, null)
    if (!meta) return null
    return {
      ...meta,
      filePath: dataPath
    }
  }

  function resolveFilePath(fileId) {
    const item = getFile(fileId)
    if (!item) return null
    return path.join(filesDir, item.storedName)
  }

  function invalidateDataFileCache(filePaths) {
    for (const filePath of Array.isArray(filePaths) ? filePaths : [filePaths]) {
      if (!filePath) continue
      jsonCache.delete(path.resolve(filePath))
    }
  }

  const existingCommands = readJson(commandsFile, [])
  const compactedCommands = compactCommandList(existingCommands)
  if (compactedCommands.changed) writeJson(commandsFile, compactedCommands.items)

  reconcileAllNodeTiming(readBotMap())

  return {
    listBots,
    getBot,
    listNodes,
    listFleet,
    listBotsForHost,
    listOperators,
    listOperatorCredentials,
    getOperator,
    upsertOperator,
    deleteOperator,
    upsertBotStatus,
    listCommands,
    getCommand,
    createCommand,
    createCommandsForBots,
    setBotPauseDesired,
    setBotsPauseDesired,
    isBotPauseDesired,
    getBotPauseState,
    claimCommand,
    completeCommand,
    listPendingCommands,
    listFiles,
    getFile,
    listEvents,
    addEvent,
    createFileUpload,
    assignFile,
    assignFileToNode,
    getNextAssignedFile,
    claimNextNodeFile,
    claimNextQueueFile,
    claimNextQueueFiles,
    getQueueBatchPolicy,
    claimNextNodeCommand,
    completeFileDelivery,
    completeNodeFileDelivery,
    completeQueueFileDelivery,
    releaseQueueFile,
    retryQueueFile,
    retryFailedQueueFiles,
    resetDashboardForFreshStart,
    completeNodeCommand,
    saveNodeLogDownload,
    getNodeLogDownload,
    invalidateDataFileCache,
    resolveFilePath
  }
}

module.exports = {
  createStore
}
