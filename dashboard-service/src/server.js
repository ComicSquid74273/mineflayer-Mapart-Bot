const http = require('http')
const path = require('path')
const fs = require('fs')
const { createStore } = require('./store')

const HOST = process.env.DASHBOARD_HOST || '0.0.0.0'
const PORT = Number(process.env.DASHBOARD_PORT || 4080)
const DATA_DIR = process.env.DASHBOARD_DATA_DIR || path.resolve(__dirname, '..', 'data')
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')
const LOGS_DIR = process.env.DASHBOARD_LOGS_DIR || path.resolve(__dirname, '..', '..', 'logs')
const store = createStore(DATA_DIR)
const ROLE_DEFAULT_PERMISSIONS = {
  viewer: {
    canViewLogs: true,
    canOperate: false,
    canDeleteNodeFiles: false,
    canManageOperators: false
  },
  operator: {
    canViewLogs: true,
    canOperate: true,
    canDeleteNodeFiles: false,
    canManageOperators: false
  },
  admin: {
    canViewLogs: true,
    canOperate: true,
    canDeleteNodeFiles: true,
    canManageOperators: true
  }
}

const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(payload, null, 2))
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(String(message || ''))
}

function sendFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase()
  const contentType = STATIC_TYPES[extension] || 'application/octet-stream'
  const headers = { 'content-type': contentType }
  if (extension === '.html') headers['cache-control'] = 'no-store'
  res.writeHead(200, headers)
  fs.createReadStream(filePath).pipe(res)
}

function notFound(res) {
  sendJson(res, 404, { error: 'not found' })
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message })
}

function methodNotAllowed(res) {
  sendJson(res, 405, { error: 'method not allowed' })
}

function unauthorized(res) {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'www-authenticate': 'Basic realm="Mapart Dashboard"'
  })
  res.end(JSON.stringify({ error: 'authentication required' }, null, 2))
}

function forbidden(res, message = 'forbidden') {
  sendJson(res, 403, { error: message })
}

function sanitizeStaticPath(pathname) {
  const normalized = path.normalize(pathname).replace(/^([.][.][\\/])+/, '')
  return normalized.replace(/^[/\\]+/, '')
}

function tryServeStatic(req, res, pathname) {
  if (req.method !== 'GET') return false
  const requested = pathname === '/' ? 'index.html' : sanitizeStaticPath(pathname)
  const filePath = path.join(PUBLIC_DIR, requested)
  if (!filePath.startsWith(PUBLIC_DIR)) return false
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false
  sendFile(res, filePath)
  return true
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`)
}

function parseBasicAuth(req) {
  const header = String(req.headers.authorization || '')
  if (!header.startsWith('Basic ')) return null
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const splitIndex = decoded.indexOf(':')
    if (splitIndex < 0) return null
    return {
      username: decoded.slice(0, splitIndex),
      password: decoded.slice(splitIndex + 1)
    }
  } catch {
    return null
  }
}

function normalizeRole(role, fallback = 'viewer') {
  const value = String(role || '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(ROLE_DEFAULT_PERMISSIONS, value) ? value : fallback
}

function sanitizePermissionOverrides(input) {
  const source = input && typeof input === 'object' ? input : {}
  const permissions = {}
  for (const key of ['canViewLogs', 'canOperate', 'canDeleteNodeFiles', 'canManageOperators']) {
    if (typeof source[key] === 'boolean') permissions[key] = source[key]
  }
  return permissions
}

function getEffectivePermissions(account) {
  const normalizedRole = normalizeRole(account?.role, 'viewer')
  return {
    ...ROLE_DEFAULT_PERMISSIONS[normalizedRole],
    ...sanitizePermissionOverrides(account?.permissions)
  }
}

function summarizeOperatorAccount(account) {
  return {
    username: account.username,
    role: normalizeRole(account.role, 'viewer'),
    permissions: getEffectivePermissions(account),
    permissionOverrides: sanitizePermissionOverrides(account.permissions),
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null
  }
}

function actorHasPermission(actor, requiredPermission) {
  if (requiredPermission === 'authenticated') return Boolean(actor)
  return Boolean(actor?.permissions?.[requiredPermission])
}

function getAuthRequirement(pathname, method) {
  if (pathname === '/api/dashboard/auth/me') return 'authenticated'
  if (reqIsLogPath(pathname, method)) return 'canViewLogs'
  if (reqIsOperatorManagementPath(pathname)) return 'canManageOperators'
  if (reqIsNodeDeletePath(pathname, method)) return 'canDeleteNodeFiles'
  if (method !== 'GET' && pathname.startsWith('/api/dashboard/')) return 'canOperate'
  return null
}

function reqIsLogPath(pathname, method) {
  if (method !== 'GET') return false
  return pathname === '/api/dashboard/logs'
    || Boolean(matchPath(pathname, '/api/dashboard/logs/:fileName/download'))
}

function reqIsNodeDeletePath(pathname, method) {
  return method === 'POST' && Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/files/:fileName/delete'))
}

function reqIsOperatorManagementPath(pathname) {
  return pathname === '/api/dashboard/operators'
    || Boolean(matchPath(pathname, '/api/dashboard/operators/:username/delete'))
}

function ensureWithinDir(filePath, dirPath) {
  const relative = path.relative(dirPath, filePath)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

function listDownloadableLogs() {
  if (!fs.existsSync(LOGS_DIR)) return []
  return fs.readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.log'))
    .map((entry) => {
      const filePath = path.join(LOGS_DIR, entry.name)
      const stats = fs.statSync(filePath)
      return {
        fileName: entry.name,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString()
      }
    })
    .sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)))
}

function resolveLogFilePath(fileName) {
  const safeName = path.basename(String(fileName || '').trim())
  if (!safeName || !safeName.toLowerCase().endsWith('.log')) return null
  const filePath = path.join(LOGS_DIR, safeName)
  if (!ensureWithinDir(filePath, LOGS_DIR)) return null
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return null
  return filePath
}

function projectOperatorAccount(existing, input) {
  const username = String(input?.username || existing?.username || '').trim()
  if (!username) return null
  const password = String(input?.password || '')
  if (!password && !existing?.password) return null
  return {
    username,
    password: password || existing.password,
    role: normalizeRole(input?.role || existing?.role || 'viewer', 'viewer'),
    permissions: sanitizePermissionOverrides(input?.permissions ?? existing?.permissions),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

function getAuthorizedActor(req) {
  const auth = parseBasicAuth(req)
  if (!auth) return null
  const match = store.listOperatorCredentials().find((item) => item.username === auth.username && item.password === auth.password)
  return match ? {
    username: match.username,
    role: normalizeRole(match.role, 'viewer'),
    permissions: getEffectivePermissions(match)
  } : null
}

function auditOperatorAction(actor, action, message, details = null, level = 'info') {
  return store.addEvent({
    operator: actor?.username || 'unknown',
    action,
    message,
    details: {
      role: actor?.role || 'unknown',
      permissions: actor?.permissions || null,
      ...(details || {})
    },
    level
  })
}

function matchPath(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean)
  const patternParts = pattern.split('/').filter(Boolean)
  if (pathParts.length !== patternParts.length) return null
  const params = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const part = patternParts[index]
    const actual = pathParts[index]
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(actual)
      continue
    }
    if (part !== actual) return null
  }
  return params
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  if (!raw.length) return null
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  if (contentType.includes('application/json')) {
    return JSON.parse(raw.toString('utf8'))
  }
  return raw
}

function validateBotStatus(body) {
  const required = [
    'botName',
    'runtime',
    'hostLabel',
    'online',
    'phase',
    'health',
    'hunger',
    'activeState',
    'location',
    'idle',
    'heartbeatAt',
    'role',
    'recoveryState',
    'reconnectState',
    'currentNbt',
    'lastStatusAt'
  ]

  for (const field of required) {
    if (!(field in (body || {}))) return `missing field '${field}'`
  }
  return ''
}

function summarizeBot(bot) {
  const lastStatusAt = new Date(bot?.lastStatusAt || bot?.heartbeatAt || 0).getTime()
  const ageMs = Number.isFinite(lastStatusAt) ? Math.max(0, Date.now() - lastStatusAt) : Number.POSITIVE_INFINITY
  const fresh = ageMs <= 30000
  return {
    botName: bot.botName,
    runtime: bot.runtime,
    hostLabel: bot.hostLabel,
    online: fresh ? bot.online === true : false,
    phase: bot.phase,
    health: bot.health,
    hunger: bot.hunger,
    activeState: fresh ? bot.activeState : 'stale',
    location: bot.location,
    idle: bot.idle,
    heartbeatAt: bot.heartbeatAt,
    role: bot.role,
    recoveryState: bot.recoveryState,
    reconnectState: bot.reconnectState,
    currentNbt: bot.currentNbt,
    lastStatusAt: bot.lastStatusAt,
    lastError: bot.lastError || null,
    progress: bot.progress || null
  }
}

function summarizeNode(node) {
  return {
    hostLabel: node.hostLabel,
    botCount: node.botCount,
    onlineCount: node.onlineCount,
    botNames: node.botNames,
    lastStatusAt: node.lastStatusAt,
    nodeFiles: Array.isArray(node.nodeFiles) ? node.nodeFiles : [],
    timing: node.timing || null
  }
}

async function route(req, res) {
  const { pathname } = parseUrl(req)
  const actor = getAuthorizedActor(req)
  const requiredPermission = getAuthRequirement(pathname, req.method)

  if (requiredPermission && !actor) {
    return unauthorized(res)
  }
  if (requiredPermission && !actorHasPermission(actor, requiredPermission)) {
    return forbidden(res, `${requiredPermission} permission required`)
  }

  if (pathname === '/' || pathname.startsWith('/assets/')) {
    if (tryServeStatic(req, res, pathname)) return
  }

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/auth/me') {
    if (!actor) return unauthorized(res)
    return sendJson(res, 200, {
      ok: true,
      operator: actor.username,
      role: actor.role,
      permissions: {
        ...actor.permissions,
        canAdmin: Boolean(actor.permissions?.canManageOperators || actor.permissions?.canDeleteNodeFiles)
      }
    })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/operators') {
    return sendJson(res, 200, {
      items: store.listOperators().map((item) => summarizeOperatorAccount(item))
    })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/operators') {
    const body = await readBody(req)
    const username = String(body?.username || '').trim()
    if (!username) return badRequest(res, 'username is required')

    const existing = store.getOperator(username, true)
    if (!existing && !String(body?.password || '').trim()) {
      return badRequest(res, 'password is required when creating an operator')
    }

    const projected = projectOperatorAccount(existing, body)
    if (!projected) return badRequest(res, 'invalid operator payload')

    const operators = store.listOperatorCredentials()
    const nextOperators = existing
      ? operators.map((item) => (String(item.username).toLowerCase() === String(existing.username).toLowerCase() ? projected : item))
      : [...operators, projected]

    if (!nextOperators.some((item) => getEffectivePermissions(item).canManageOperators === true)) {
      return badRequest(res, 'at least one operator with canManageOperators must remain')
    }

    const saved = store.upsertOperator(body)
    if (!saved) return badRequest(res, 'failed to save operator')
    auditOperatorAction(actor, existing ? 'update-operator' : 'create-operator', `${existing ? 'Updated' : 'Created'} operator ${saved.username}.`, {
      username: saved.username,
      role: saved.role,
      permissions: summarizeOperatorAccount(saved).permissions
    })
    return sendJson(res, existing ? 200 : 201, { item: summarizeOperatorAccount(saved) })
  }

  let params = matchPath(pathname, '/api/dashboard/operators/:username/delete')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const username = String(params.username || '').trim()
    if (!username) return badRequest(res, 'username is required')
    if (String(actor.username || '').toLowerCase() === username.toLowerCase()) {
      return badRequest(res, 'you cannot delete the currently authenticated operator')
    }

    const operators = store.listOperatorCredentials()
    const target = operators.find((item) => String(item.username || '').toLowerCase() === username.toLowerCase())
    if (!target) return notFound(res)
    const remaining = operators.filter((item) => String(item.username || '').toLowerCase() !== username.toLowerCase())
    if (!remaining.some((item) => getEffectivePermissions(item).canManageOperators === true)) {
      return badRequest(res, 'at least one operator with canManageOperators must remain')
    }

    const removed = store.deleteOperator(username)
    auditOperatorAction(actor, 'delete-operator', `Deleted operator ${username}.`, {
      username,
      role: target.role,
      permissions: getEffectivePermissions(target)
    }, 'warn')
    return sendJson(res, 200, { item: removed ? summarizeOperatorAccount(removed) : null })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/logs') {
    return sendJson(res, 200, { items: listDownloadableLogs() })
  }

  const logDownloadParams = matchPath(pathname, '/api/dashboard/logs/:fileName/download')
  if (logDownloadParams) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    const filePath = resolveLogFilePath(logDownloadParams.fileName)
    if (!filePath) return notFound(res)
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${path.basename(filePath)}"`,
      'cache-control': 'no-store'
    })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  if (req.method === 'POST' && pathname === '/api/bots/status') {
    const body = await readBody(req)
    const error = validateBotStatus(body)
    if (error) return badRequest(res, error)
    const bot = store.upsertBotStatus(body)
    return sendJson(res, 200, { ok: true, nextPollMs: 3000, bot: summarizeBot(bot) })
  }

  params = matchPath(pathname, '/api/bots/:botName/commands')
  if (params) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    return sendJson(res, 200, { items: store.listPendingCommands(params.botName) })
  }

  params = matchPath(pathname, '/api/bots/:botName/commands/:commandId/claim')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const command = store.claimCommand(params.botName, params.commandId)
    if (!command) return notFound(res)
    return sendJson(res, 200, { ok: true, command })
  }

  params = matchPath(pathname, '/api/bots/:botName/commands/:commandId/result')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const status = String(body?.status || '').trim().toLowerCase()
    if (status !== 'succeeded' && status !== 'failed') return badRequest(res, 'status must be succeeded or failed')
    const command = store.completeCommand(params.botName, params.commandId, status, body?.resultMessage)
    if (!command) return notFound(res)
    return sendJson(res, 200, { ok: true, command })
  }

  params = matchPath(pathname, '/api/bots/:botName/files/next')
  if (params) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    const item = store.getNextAssignedFile(params.botName)
    return sendJson(res, 200, { item })
  }

  params = matchPath(pathname, '/api/nodes/:hostLabel/files/claim-next')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    if (!body?.botName) return badRequest(res, 'botName is required')
    const item = store.claimNextNodeFile(params.hostLabel, body.botName)
    return sendJson(res, 200, { item })
  }

  params = matchPath(pathname, '/api/nodes/:hostLabel/commands/claim-next')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    if (!body?.botName) return badRequest(res, 'botName is required')
    const command = store.claimNextNodeCommand(params.hostLabel, body.botName)
    return sendJson(res, 200, { command })
  }

  params = matchPath(pathname, '/api/files/:fileId/download')
  if (params) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    const file = store.getFile(params.fileId)
    const filePath = store.resolveFilePath(params.fileId)
    if (!file || !filePath || !fs.existsSync(filePath)) return notFound(res)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${file.originalName}"`
    })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  params = matchPath(pathname, '/api/bots/:botName/files/:fileId/result')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const deliveryStatus = String(body?.deliveryStatus || '').trim().toLowerCase()
    if (!['downloaded', 'placed', 'failed'].includes(deliveryStatus)) {
      return badRequest(res, 'deliveryStatus must be downloaded, placed, or failed')
    }
    const item = store.completeFileDelivery(params.botName, params.fileId, deliveryStatus, body?.failedReason)
    if (!item) return notFound(res)
    return sendJson(res, 200, { ok: true, item })
  }

  params = matchPath(pathname, '/api/nodes/:hostLabel/files/:fileId/result')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const deliveryStatus = String(body?.deliveryStatus || '').trim().toLowerCase()
    if (!['downloaded', 'placed', 'failed'].includes(deliveryStatus)) {
      return badRequest(res, 'deliveryStatus must be downloaded, placed, or failed')
    }
    const item = store.completeNodeFileDelivery(params.hostLabel, params.fileId, deliveryStatus, body?.failedReason, body?.botName || null)
    if (!item) return notFound(res)
    return sendJson(res, 200, { ok: true, item })
  }

  params = matchPath(pathname, '/api/nodes/:hostLabel/commands/:commandId/result')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const status = String(body?.status || '').trim().toLowerCase()
    if (status !== 'succeeded' && status !== 'failed') return badRequest(res, 'status must be succeeded or failed')
    const command = store.completeNodeCommand(params.hostLabel, params.commandId, status, body?.resultMessage, body?.botName || null)
    if (!command) return notFound(res)
    return sendJson(res, 200, { ok: true, command })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/bots') {
    return sendJson(res, 200, { items: store.listBots().map(summarizeBot) })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/events') {
    return sendJson(res, 200, { items: store.listEvents(150) })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/nodes') {
    return sendJson(res, 200, { items: store.listNodes().map(summarizeNode) })
  }

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/files')
  if (params) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    const node = store.listNodes().find((item) => item.hostLabel === params.hostLabel)
    if (!node) return notFound(res)
    return sendJson(res, 200, { items: Array.isArray(node.nodeFiles) ? node.nodeFiles : [] })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName')
  if (params) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    const bot = store.getBot(params.botName)
    if (!bot) return notFound(res)
    const recentCommands = store.listCommands((item) => item.targetBotName === params.botName).slice(-5).reverse()
    return sendJson(res, 200, {
      bot,
      recentCommands
    })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/commands/start-all') {
    const botNames = store.listBots().map((item) => item.botName)
    const items = store.createCommandsForBots(botNames, 'start')
    auditOperatorAction(actor, 'start-all', `Queued print start for ${botNames.length} bot(s).`, { botNames })
    return sendJson(res, 201, { items })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/commands/stop-all') {
    const body = await readBody(req)
    const botNames = store.listBots().map((item) => item.botName)
    const items = store.createCommandsForBots(botNames, 'stop', { reason: body?.reason || null })
    auditOperatorAction(actor, 'stop-all', `Queued print stop for ${botNames.length} bot(s).`, { botNames, reason: body?.reason || null }, 'warn')
    return sendJson(res, 201, { items })
  }

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/start')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const bots = store.listBotsForHost(params.hostLabel)
    if (!bots.length) return notFound(res)
    const botNames = bots.map((item) => item.botName)
    const items = store.createCommandsForBots(botNames, 'start', { requestedBy: actor.username })
    auditOperatorAction(actor, 'start-node', `Queued print start for node ${params.hostLabel}.`, { hostLabel: params.hostLabel, botNames })
    return sendJson(res, 201, { items })
  }

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/stop')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const bots = store.listBotsForHost(params.hostLabel)
    if (!bots.length) return notFound(res)
    const botNames = bots.map((item) => item.botName)
    const items = store.createCommandsForBots(botNames, 'stop', {
      requestedBy: actor.username,
      reason: body?.reason || null
    })
    auditOperatorAction(actor, 'stop-node', `Queued print stop for node ${params.hostLabel}.`, { hostLabel: params.hostLabel, botNames, reason: body?.reason || null }, 'warn')
    return sendJson(res, 201, { items })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/start')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const command = store.createCommand({ targetBotName: params.botName, commandType: 'start', requestedBy: actor.username })
    auditOperatorAction(actor, 'start-bot', `Queued print start for ${params.botName}.`, { botName: params.botName })
    return sendJson(res, 201, { command })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/stop')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const command = store.createCommand({
      targetBotName: params.botName,
      commandType: 'stop',
      reason: body?.reason || null,
      requestedBy: actor.username
    })
    auditOperatorAction(actor, 'stop-bot', `Queued print stop for ${params.botName}.`, { botName: params.botName, reason: body?.reason || null }, 'warn')
    return sendJson(res, 201, {
      command
    })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/files') {
    const body = await readBody(req)
    if (!body?.originalName || !body?.contentBase64) {
      return badRequest(res, 'originalName and contentBase64 are required')
    }
    const targetHostLabel = String(body?.targetHostLabel || '').trim()
    if (targetHostLabel && !store.listNodes().some((item) => item.hostLabel === targetHostLabel)) {
      return badRequest(res, `unknown targetHostLabel: ${targetHostLabel}`)
    }
    const item = store.createFileUpload({ ...body, uploadedBy: body?.uploadedBy || actor.username })
    auditOperatorAction(actor, targetHostLabel ? 'upload-file-direct-node' : 'upload-file', targetHostLabel ? `Uploaded ${item.originalName} directly to node ${targetHostLabel}.` : `Uploaded ${item.originalName}.`, {
      fileId: item.fileId,
      originalName: item.originalName,
      sizeBytes: item.sizeBytes,
      nameConflictCount: item.nameConflictCount,
      targetHostLabel: item.assignedHostLabel
    })
    return sendJson(res, 201, { item })
  }

  params = matchPath(pathname, '/api/dashboard/files/:fileId/assign')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    if (!body?.targetHostLabel) return badRequest(res, 'targetHostLabel is required')
    const item = store.assignFileToNode(params.fileId, body.targetHostLabel)
    if (!item) return notFound(res)
    auditOperatorAction(actor, 'assign-file', `Assigned ${item.originalName} to node ${body.targetHostLabel}.`, {
      fileId: item.fileId,
      originalName: item.originalName,
      targetHostLabel: body.targetHostLabel
    })
    return sendJson(res, 200, { item })
  }

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/files/:fileName/delete')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const fileName = path.basename(String(params.fileName || '').trim())
    if (!fileName) return badRequest(res, 'fileName is required')
    const command = store.createCommand({
      targetHostLabel: params.hostLabel,
      commandType: 'delete-node-file',
      fileName,
      requestedBy: actor.username
    })
    auditOperatorAction(actor, 'delete-node-file', `Queued delete for ${fileName} on node ${params.hostLabel}.`, {
      hostLabel: params.hostLabel,
      fileName,
      commandId: command.commandId
    }, 'warn')
    return sendJson(res, 201, { command })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/files') {
    return sendJson(res, 200, { items: store.listFiles() })
  }

  return notFound(res)
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    sendJson(res, 500, { error: error?.message || String(error) })
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[dashboard-service] listening on http://${HOST}:${PORT}`)
  console.log(`[dashboard-service] loaded ${store.listOperators().length} operator account(s) from ${path.join(DATA_DIR, 'operators.json')}`)
  console.log(`[dashboard-service] log downloads served from ${LOGS_DIR}`)
})