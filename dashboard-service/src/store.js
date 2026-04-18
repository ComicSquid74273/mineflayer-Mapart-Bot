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

function createStore(baseDir) {
  const dataDir = path.resolve(baseDir)
  const filesDir = path.join(dataDir, 'files')
  const botsFile = path.join(dataDir, 'bots.json')
  const commandsFile = path.join(dataDir, 'commands.json')
  const uploadsFile = path.join(dataDir, 'files.json')
  const eventsFile = path.join(dataDir, 'events.json')
  const operatorsFile = path.join(dataDir, 'operators.json')

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
    const bots = readJson(botsFile, {})
    return Object.values(bots).sort((left, right) => String(left.botName).localeCompare(String(right.botName)))
  }

  function getBot(botName) {
    const bots = readJson(botsFile, {})
    return bots[botName] || null
  }

  function listNodes() {
    const byHost = new Map()
    for (const bot of listBots()) {
      const hostLabel = String(bot.hostLabel || '').trim() || 'unknown-host'
      const current = byHost.get(hostLabel) || {
        hostLabel,
        botCount: 0,
        onlineCount: 0,
        botNames: [],
        lastStatusAt: null,
        nodeFiles: []
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
    const bots = readJson(botsFile, {})
    const next = {
      ...status,
      lastStatusAt: status.lastStatusAt || nowIso()
    }
    bots[status.botName] = next
    writeJson(botsFile, bots)
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