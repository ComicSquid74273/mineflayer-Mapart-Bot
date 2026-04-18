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

  ensureDir(dataDir)
  ensureDir(filesDir)
  if (!fs.existsSync(botsFile)) writeJson(botsFile, {})
  if (!fs.existsSync(commandsFile)) writeJson(commandsFile, [])
  if (!fs.existsSync(uploadsFile)) writeJson(uploadsFile, [])

  function listBots() {
    const bots = readJson(botsFile, {})
    return Object.values(bots).sort((left, right) => String(left.botName).localeCompare(String(right.botName)))
  }

  function getBot(botName) {
    const bots = readJson(botsFile, {})
    return bots[botName] || null
  }

  function upsertBotStatus(status) {
    const bots = readJson(botsFile, {})
    const previous = bots[status.botName] || {}
    const next = {
      ...previous,
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
    const command = {
      commandId: crypto.randomUUID(),
      targetBotName: input.targetBotName,
      commandType: input.commandType,
      createdAt: nowIso(),
      status: 'pending',
      requestedBy: input.requestedBy || null,
      nbtFileId: input.nbtFileId || null,
      reason: input.reason || null,
      expiresAt: input.expiresAt || null,
      resultMessage: null,
      completedAt: null
    }
    items.push(command)
    saveCommands(items)
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
    items[index] = { ...current, status: 'claimed' }
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

  function createFileUpload({ originalName, contentBase64, uploadedBy, notes }) {
    const buffer = Buffer.from(String(contentBase64 || ''), 'base64')
    const fileId = crypto.randomUUID()
    const extension = path.extname(originalName || '').toLowerCase() || '.nbt'
    const storedName = `${fileId}${extension}`
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    fs.writeFileSync(path.join(filesDir, storedName), buffer)

    const item = {
      fileId,
      originalName: originalName || storedName,
      storedName,
      uploadedAt: nowIso(),
      sizeBytes: buffer.length,
      sha256,
      assignedBotName: null,
      deliveryStatus: 'unassigned',
      uploadedBy: uploadedBy || null,
      notes: notes || null,
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

  function getNextAssignedFile(botName) {
    return listFiles().find((item) => item.assignedBotName === botName && (item.deliveryStatus === 'assigned' || item.deliveryStatus === 'downloaded')) || null
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

  function resolveFilePath(fileId) {
    const item = getFile(fileId)
    if (!item) return null
    return path.join(filesDir, item.storedName)
  }

  return {
    listBots,
    getBot,
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
    createFileUpload,
    assignFile,
    getNextAssignedFile,
    completeFileDelivery,
    resolveFilePath
  }
}

module.exports = {
  createStore
}