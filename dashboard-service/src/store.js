const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
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
  const uploadsFile = path.join(dataDir, 'files.json')
  const eventsFile = path.join(dataDir, 'events.json')
  const operatorsFile = path.join(dataDir, 'operators.json')
  const nodeStatsFile = path.join(dataDir, 'node-stats.json')
  const COUNTED_NODE_PHASES = new Set(['printing', 'repair', 'rescan', 'post-print', 'cleanup'])
  const HOLD_NODE_PHASES = new Set([])

  function defaultOperators() {
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
  if (!fs.existsSync(botsFile)) writeJson(botsFile, {})
  if (!fs.existsSync(commandsFile)) writeJson(commandsFile, [])
  if (!fs.existsSync(uploadsFile)) writeJson(uploadsFile, [])
  if (!fs.existsSync(eventsFile)) writeJson(eventsFile, [])
  if (!fs.existsSync(operatorsFile)) writeJson(operatorsFile, defaultOperators())
  if (!fs.existsSync(nodeStatsFile)) writeJson(nodeStatsFile, {})

  function toTimestamp(value) {
    const ms = new Date(value || 0).getTime()
    return Number.isFinite(ms) ? ms : 0
  }

  function readBotMap() {
    const bots = readJson(botsFile, {})
    return bots && typeof bots === 'object' && !Array.isArray(bots) ? bots : {}
  }

  function readNodeStatsMap() {
    const items = readJson(nodeStatsFile, {})
    return items && typeof items === 'object' && !Array.isArray(items) ? items : {}
  }

  function saveNodeStatsMap(items) {
    writeJson(nodeStatsFile, items)
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
        : []
    }
  }

  function sanitizeTimingHistoryEntry(input) {
    if (!input || typeof input !== 'object') return null
    const fileName = String(input.fileName || '').trim()
    const startedAt = String(input.startedAt || '').trim()
    const completedAt = String(input.completedAt || '').trim()
    const durationMs = Math.max(0, toNumber(input.durationMs, 0))
    if (!fileName || !startedAt || !completedAt || !Number.isFinite(durationMs)) return null
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
        botNames: []
      }

      current.botCount += 1
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

  function recordCompletedNodeRun(record, completedRun) {
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

    if (!historyEntry) return record

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
      nextRecord = recordCompletedNodeRun(nextRecord, {
        fileName: closedRun?.fileName || previousActiveRun.fileName,
        startedAt: closedRun?.startedAt || previousActiveRun.startedAt,
        completedAt: snapshotActiveRun?.countedStartedAtCandidate || snapshot.lastHostStatusAt || previousActiveRun.lastSeenAt || nowIso(),
        durationMs: closedRun?.accumulatedActiveMs || 0,
        botNames: closedRun?.botNames || previousActiveRun.botNames
      })
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
          botNames: snapshotActiveRun.botNames
        })
      } else {
        let activeRun = sanitizeTimingRun({
          ...nextRecord.activeRun,
          lastSeenAt: snapshotActiveRun.lastSeenAt || nextRecord.activeRun.lastSeenAt,
          activeBotCount: snapshotActiveRun.activeBotCount,
          botNames: snapshotActiveRun.botNames
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

  function listBots() {
    const bots = readBotMap()
    return Object.values(bots).sort((left, right) => String(left.botName).localeCompare(String(right.botName)))
  }

  function getBot(botName) {
    const bots = readBotMap()
    return bots[botName] || null
  }

  function listNodes() {
    const botMap = readBotMap()
    reconcileAllNodeTiming(botMap)
    const timingByHost = readNodeStatsMap()
    const byHost = new Map()
    for (const bot of Object.values(botMap)) {
      const hostLabel = String(bot.hostLabel || '').trim() || 'unknown-host'
      const current = byHost.get(hostLabel) || {
        hostLabel,
        botCount: 0,
        onlineCount: 0,
        botNames: [],
        lastStatusAt: null,
        nodeFiles: [],
        timing: summarizeNodeTiming(timingByHost[hostLabel])
      }
      current.botCount += 1
      if (bot.online === true) current.onlineCount += 1
      current.botNames.push(bot.botName)
      if (!current.lastStatusAt || String(bot.lastStatusAt || '') > String(current.lastStatusAt || '')) {
        current.lastStatusAt = bot.lastStatusAt || null
        current.nodeFiles = Array.isArray(bot.nodeFiles) ? bot.nodeFiles : []
      }
      byHost.set(hostLabel, current)
    }
    return Array.from(byHost.values()).sort((left, right) => String(left.hostLabel).localeCompare(String(right.hostLabel)))
  }

  function listBotsForHost(hostLabel) {
    return listBots().filter((bot) => String(bot.hostLabel || '').trim() === String(hostLabel || '').trim())
  }

  function upsertBotStatus(status) {
    const bots = readBotMap()
    const next = {
      ...status,
      lastStatusAt: status.lastStatusAt || nowIso()
    }
    bots[status.botName] = next
    writeJson(botsFile, bots)
    reconcileHostNodeTiming(next.hostLabel, bots)
    return next
  }

  function listCommands(filterFn = null) {
    const items = readJson(commandsFile, [])
    return typeof filterFn === 'function' ? items.filter(filterFn) : items
  }

  function getCommand(commandId) {
    return listCommands((item) => item.commandId === commandId)[0] || null
  }

  function saveCommands(items) {
    writeJson(commandsFile, items)
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
      reason: input.reason || null,
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
    items[index] = {
      ...current,
      status,
      resultMessage: resultMessage || null,
      completedAt: nowIso()
    }
    saveCommands(items)
    return items[index]
  }

  function listPendingCommands(botName) {
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

  function createFileUpload({ originalName, contentBase64, uploadedBy, notes, targetHostLabel }) {
    const buffer = Buffer.from(String(contentBase64 || ''), 'base64')
    const fileId = crypto.randomUUID()
    const extension = path.extname(originalName || '').toLowerCase() || '.nbt'
    const storedName = `${fileId}${extension}`
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    const duplicateCount = listFiles().filter((item) => String(item.originalName || '').toLowerCase() === String(originalName || '').toLowerCase()).length
    const assignedHostLabel = String(targetHostLabel || '').trim() || null
    fs.writeFileSync(path.join(filesDir, storedName), buffer)

    const item = {
      fileId,
      originalName: originalName || storedName,
      storedName,
      uploadedAt: nowIso(),
      sizeBytes: buffer.length,
      sha256,
      assignedBotName: null,
      assignedHostLabel,
      claimedByBotName: null,
      claimedAt: null,
      deliveryStatus: assignedHostLabel ? 'assigned' : 'unassigned',
      uploadedBy: uploadedBy || null,
      notes: notes || null,
      nameConflictCount: duplicateCount,
      deliveredAt: null,
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
    const index = items.findIndex((item) => item.targetHostLabel === normalizedHost && (item.status === 'pending' || (item.status === 'claimed' && item.claimedByBotName === normalizedBot)))
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
    items[index] = {
      ...current,
      status,
      resultMessage: resultMessage || null,
      completedAt: nowIso()
    }
    saveCommands(items)
    return items[index]
  }

  function resolveFilePath(fileId) {
    const item = getFile(fileId)
    if (!item) return null
    return path.join(filesDir, item.storedName)
  }

  reconcileAllNodeTiming(readBotMap())

  return {
    listBots,
    getBot,
    listNodes,
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
    claimNextNodeCommand,
    completeFileDelivery,
    completeNodeFileDelivery,
    completeNodeCommand,
    resolveFilePath
  }
}

module.exports = {
  createStore
}