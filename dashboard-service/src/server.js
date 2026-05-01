const http = require('http')
const path = require('path')
const fs = require('fs')
const { createStore } = require('./store')

const HOST = process.env.DASHBOARD_HOST || '0.0.0.0'
const PORT = Number(process.env.DASHBOARD_PORT || 4080)
const DATA_DIR = process.env.DASHBOARD_DATA_DIR || path.resolve(__dirname, '..', 'data')
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')
const LOGS_DIR = process.env.DASHBOARD_LOGS_DIR || path.resolve(__dirname, '..', '..', 'logs')
const CONFIG_DIR = process.env.DASHBOARD_CONFIG_DIR || path.resolve(__dirname, '..', '..', 'nerv-printer-config', '_configs')
const NBT_DIR = process.env.DASHBOARD_NBT_DIR || path.resolve(__dirname, '..', '..', 'nerv-printer-config')
const store = createStore(DATA_DIR)
const PROTECTED_DATA_FILES = new Set(['operators.json'])
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
  if (['.html', '.js', '.css'].includes(extension)) headers['cache-control'] = 'no-store'
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
  if (reqIsLogDeletePath(pathname, method)) return 'canManageOperators'
  if (reqIsOperatorManagementPath(pathname)) return 'canManageOperators'
  if (reqIsDataManagementPath(pathname)) return 'canManageOperators'
  if (reqIsConfigManagementPath(pathname)) return 'canManageOperators'
  if (reqIsNodeDeletePath(pathname, method)) return 'canDeleteNodeFiles'
  if (reqIsDashboardOperationPath(pathname, method)) return 'canOperate'
  return null
}

function reqIsLogPath(pathname, method) {
  if (method !== 'GET') return false
  return pathname === '/api/dashboard/logs'
    || Boolean(matchPath(pathname, '/api/dashboard/logs/:fileName/download'))
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/logs/:fileName/download'))
}

function reqIsNodeDeletePath(pathname, method) {
  return method === 'POST' && Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/files/:fileName/delete'))
}

function reqIsLogDeletePath(pathname, method) {
  return method === 'POST' && Boolean(matchPath(pathname, '/api/dashboard/logs/:fileName/delete'))
}

function reqIsOperatorManagementPath(pathname) {
  return pathname === '/api/dashboard/operators'
    || Boolean(matchPath(pathname, '/api/dashboard/operators/:username/delete'))
}

function reqIsDataManagementPath(pathname) {
  return pathname === '/api/dashboard/data'
    || pathname === '/api/dashboard/data/clear'
    || Boolean(matchPath(pathname, '/api/dashboard/data/:fileName/delete'))
}

function reqIsConfigManagementPath(pathname) {
  return pathname === '/api/dashboard/config'
    || Boolean(matchPath(pathname, '/api/dashboard/config/:fileName'))
}

function reqIsDashboardOperationPath(pathname, method) {
  if (method !== 'POST') return false
  return pathname === '/api/dashboard/commands/start-all'
    || pathname === '/api/dashboard/commands/stop-all'
    || pathname === '/api/dashboard/files'
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/nbt/upload'))
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/start'))
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/stop'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/start'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/stop'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/verify'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/chat'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/disconnect'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/reconnect'))
    || Boolean(matchPath(pathname, '/api/dashboard/files/:fileId/assign'))
}

function ensureWithinDir(filePath, dirPath) {
  const relative = path.relative(dirPath, filePath)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

function listDataFiles() {
  const files = []
  if (!fs.existsSync(DATA_DIR)) return files
  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    const filePath = path.join(DATA_DIR, entry.name)
    if (!ensureWithinDir(filePath, DATA_DIR)) continue
    const stats = fs.statSync(filePath)
    const protectedFile = PROTECTED_DATA_FILES.has(entry.name.toLowerCase())
    files.push({
      name: entry.name,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      protected: protectedFile,
      deletable: !protectedFile
    })
  }
  return files.sort((a, b) => {
    if (a.protected !== b.protected) return a.protected ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function resolveDeletableDataFilePath(fileName) {
  const safeName = path.basename(String(fileName || '').trim())
  if (!safeName || !safeName.toLowerCase().endsWith('.json')) return null
  if (PROTECTED_DATA_FILES.has(safeName.toLowerCase())) return null
  const filePath = path.join(DATA_DIR, safeName)
  if (!ensureWithinDir(filePath, DATA_DIR)) return null
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return null
  return filePath
}

function listDownloadableLogs() {
  const dirs = [LOGS_DIR]
  const cwdLogs = path.resolve(process.cwd(), 'logs')
  if (cwdLogs !== LOGS_DIR) dirs.push(cwdLogs)

  const seen = new Set()
  const results = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.log')) continue
      if (seen.has(entry.name)) continue
      seen.add(entry.name)
      const filePath = path.join(dir, entry.name)
      const stats = fs.statSync(filePath)
      results.push({ fileName: entry.name, sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString(), _dir: dir })
    }
  }
  return results.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
}

function resolveLogFilePath(fileName) {
  const safeName = path.basename(String(fileName || '').trim())
  if (!safeName || !safeName.toLowerCase().endsWith('.log')) return null
  const dirs = [LOGS_DIR]
  const cwdLogs = path.resolve(process.cwd(), 'logs')
  if (cwdLogs !== LOGS_DIR) dirs.push(cwdLogs)
  for (const dir of dirs) {
    const filePath = path.join(dir, safeName)
    if (!ensureWithinDir(filePath, dir)) continue
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) return filePath
  }
  return null
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
    statusDetail: bot.statusDetail || bot.phase || null,
    health: bot.health,
    hunger: bot.hunger,
    activeState: fresh ? bot.activeState : 'stale',
    location: bot.location,
    locationDetail: bot.locationDetail || bot.location || null,
    idle: bot.idle,
    heartbeatAt: bot.heartbeatAt,
    role: bot.role,
    recoveryState: bot.recoveryState,
    reconnectState: bot.reconnectState,
    currentNbt: bot.currentNbt,
    lastStatusAt: bot.lastStatusAt,
    lastError: bot.lastError || null,
    warnings: Array.isArray(bot.warnings) ? bot.warnings.slice(-5) : [],
    progress: bot.progress || null,
    verificationCode: bot.verificationCode || null,
    tokenWaiting: bot.tokenWaiting === true,
    botIp: bot.botIp || null,
    currentNbtStartedAt: bot.currentNbtStartedAt || null,
    latencyMs: typeof bot.latencyMs === 'number' ? bot.latencyMs : null,
    tpaTarget: bot.tpaTarget || null,
    recentChat: Array.isArray(bot.recentChat) ? bot.recentChat : []
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
    nodeLogs: Array.isArray(node.nodeLogs) ? node.nodeLogs : [],
    timing: node.timing || null
  }
}

async function waitForNodeLogDownload(store, commandId, timeoutMs = 15000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const ready = store.getNodeLogDownload(commandId)
    if (ready) return ready
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
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

  const logDeleteParams = matchPath(pathname, '/api/dashboard/logs/:fileName/delete')
  if (logDeleteParams) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const filePath = resolveLogFilePath(logDeleteParams.fileName)
    if (!filePath) return notFound(res)
    fs.unlinkSync(filePath)
    auditOperatorAction(actor, 'delete-log', `Deleted log file ${logDeleteParams.fileName}.`, { fileName: logDeleteParams.fileName }, 'warn')
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/data') {
    return sendJson(res, 200, { files: listDataFiles(), dataDir: DATA_DIR })
  }

  const dataDeleteParams = matchPath(pathname, '/api/dashboard/data/:fileName/delete')
  if (dataDeleteParams) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const fileName = path.basename(String(dataDeleteParams.fileName || '').trim())
    if (PROTECTED_DATA_FILES.has(fileName.toLowerCase())) {
      return forbidden(res, `${fileName} is protected`)
    }
    const filePath = resolveDeletableDataFilePath(fileName)
    if (!filePath) return notFound(res)
    fs.unlinkSync(filePath)
    if (fileName.toLowerCase() !== 'events.json') {
      auditOperatorAction(actor, 'delete-data-file', `Deleted data file ${fileName}.`, { fileName }, 'warn')
    }
    return sendJson(res, 200, { ok: true, deleted: [fileName] })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/data/clear') {
    const deleted = []
    const errors = []
    try {
      for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
        if (PROTECTED_DATA_FILES.has(entry.name.toLowerCase())) continue
        const filePath = path.join(DATA_DIR, entry.name)
        try {
          fs.unlinkSync(filePath)
          deleted.push(entry.name)
        } catch (err) {
          errors.push({ name: entry.name, error: err?.message || String(err) })
        }
      }
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err?.message || String(err) })
    }
    auditOperatorAction(actor, 'clear-data', `Cleared data folder: deleted ${deleted.length} file(s).`, { deleted }, 'warn')
    return sendJson(res, 200, { ok: true, deleted, errors })
  }

  if (pathname === '/api/dashboard/config') {
    if (!actor?.permissions?.canManageOperators) return forbidden(res, 'admin permission required')
    if (req.method !== 'GET') return methodNotAllowed(res)
    const files = []
    try {
      if (fs.existsSync(CONFIG_DIR)) {
        for (const entry of fs.readdirSync(CONFIG_DIR, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
          const filePath = path.join(CONFIG_DIR, entry.name)
          const stats = fs.statSync(filePath)
          files.push({ name: entry.name, sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString() })
        }
      }
    } catch {}
    return sendJson(res, 200, { files, configDir: CONFIG_DIR })
  }

  const configFileParams = matchPath(pathname, '/api/dashboard/config/:fileName')
  if (configFileParams) {
    if (!actor?.permissions?.canManageOperators) return forbidden(res, 'admin permission required')
    const safeName = String(configFileParams.fileName || '')
    if (!safeName || !safeName.toLowerCase().endsWith('.json')) return notFound(res)
    const filePath = path.join(CONFIG_DIR, safeName)
    if (!ensureWithinDir(filePath, CONFIG_DIR)) return notFound(res)
    if (req.method === 'GET') {
      if (!fs.existsSync(filePath)) return notFound(res)
      const content = fs.readFileSync(filePath, 'utf8')
      return sendJson(res, 200, { name: safeName, content })
    }
    if (req.method === 'PUT') {
      const body = await readBody(req)
      const content = String(body?.content || '')
      try { JSON.parse(content) } catch { return badRequest(res, 'invalid JSON') }
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
      fs.writeFileSync(filePath, content, 'utf8')
      auditOperatorAction(actor, 'edit-config', `Updated config file ${safeName}.`, { fileName: safeName })
      return sendJson(res, 200, { ok: true })
    }
    return methodNotAllowed(res)
  }

  const nbtUploadParams = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/nbt/upload')
  if (nbtUploadParams) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    if (!store.listBotsForHost(nbtUploadParams.hostLabel).length) return notFound(res)
    const fileName = path.basename(String(body?.fileName || '').trim())
    if (!fileName || !fileName.toLowerCase().endsWith('.nbt')) {
      return badRequest(res, 'fileName must end in .nbt')
    }
    const contentBase64 = String(body?.contentBase64 || '')
    if (!contentBase64) return badRequest(res, 'contentBase64 is required')
    let buffer
    try { buffer = Buffer.from(contentBase64, 'base64') } catch { return badRequest(res, 'invalid base64 content') }
    const targetBotName = String(body?.targetBotName || '').trim()
    if (targetBotName && !store.listBotsForHost(nbtUploadParams.hostLabel).some((bot) => bot.botName === targetBotName)) {
      return badRequest(res, `targetBotName ${targetBotName} is not on node ${nbtUploadParams.hostLabel}`)
    }
    const command = store.createCommand({
      targetBotName: targetBotName || null,
      targetHostLabel: nbtUploadParams.hostLabel,
      commandType: 'upload-node-file',
      fileName,
      contentBase64,
      requestedBy: actor.username
    })
    auditOperatorAction(actor, 'upload-nbt', `Queued direct node upload for ${fileName} to ${nbtUploadParams.hostLabel}.`, {
      hostLabel: nbtUploadParams.hostLabel, targetBotName: targetBotName || null, fileName, sizeBytes: buffer.length, commandId: command.commandId
    })
    return sendJson(res, 201, { ok: true, queued: true, command, fileName, sizeBytes: buffer.length })
  }

  if (req.method === 'POST' && pathname === '/api/bots/status') {
    const body = await readBody(req)
    const error = validateBotStatus(body)
    if (error) return badRequest(res, error)
    const rawIp = req.socket?.remoteAddress || req.connection?.remoteAddress || null
    const botIp = rawIp ? rawIp.replace(/^::ffff:/, '') : null
    const bot = store.upsertBotStatus({ ...body, botIp })
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
    if (command.commandType === 'delete-node-file') {
      store.addEvent({
        operator: `bot:${body?.botName || params.hostLabel}`,
        action: 'delete-node-file-completed',
        message: `${status === 'succeeded' ? 'Deleted' : 'Failed to delete'} ${command.fileName || 'unknown'} on node ${params.hostLabel}.`,
        details: { hostLabel: params.hostLabel, fileName: command.fileName, commandId: params.commandId, status, resultMessage: body?.resultMessage || null },
        level: status === 'succeeded' ? 'info' : 'warn'
      })
    }
    return sendJson(res, 200, { ok: true, command })
  }

  params = matchPath(pathname, '/api/nodes/:hostLabel/logs/:commandId/result')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const fileName = path.basename(String(body?.fileName || '').trim())
    const contentBase64 = String(body?.contentBase64 || '')
    if (!fileName || !fileName.toLowerCase().endsWith('.log')) return badRequest(res, 'fileName must end in .log')
    if (!contentBase64) return badRequest(res, 'contentBase64 is required')
    const command = store.getCommand(params.commandId)
    if (!command || command.targetHostLabel !== params.hostLabel || command.commandType !== 'download-node-log') return notFound(res)
    store.saveNodeLogDownload({
      commandId: params.commandId,
      hostLabel: params.hostLabel,
      botName: body?.botName || null,
      fileName,
      contentBase64
    })
    return sendJson(res, 200, { ok: true })
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

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/logs/:fileName/download')
  if (params) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    const node = store.listNodes().find((item) => item.hostLabel === params.hostLabel)
    if (!node) return notFound(res)
    const fileName = path.basename(String(params.fileName || '').trim())
    if (!fileName || !fileName.toLowerCase().endsWith('.log')) return notFound(res)
    const command = store.createCommand({
      targetHostLabel: params.hostLabel,
      commandType: 'download-node-log',
      fileName,
      requestedBy: actor?.username || 'unknown'
    })
    const downloaded = await waitForNodeLogDownload(store, command.commandId, 15000)
    if (!downloaded?.filePath || !fs.existsSync(downloaded.filePath)) {
      return sendJson(res, 504, { error: `Timed out waiting for node log ${fileName} from ${params.hostLabel}` })
    }
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${downloaded.fileName}"`,
      'cache-control': 'no-store'
    })
    fs.createReadStream(downloaded.filePath).pipe(res)
    return
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

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/verify')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const action = String(body?.action || '').trim().toLowerCase()
    if (action !== 'verified' && action !== 'refresh') return badRequest(res, 'action must be verified or refresh')
    const command = store.createCommand({
      targetBotName: params.botName,
      commandType: 'verify',
      reason: action,
      requestedBy: actor.username
    })
    auditOperatorAction(actor, `verify-${action}`, `Sent verification ${action} for ${params.botName}.`, { botName: params.botName })
    return sendJson(res, 201, { command })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/chat')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const message = String(body?.message || '').trim()
    if (!message) return badRequest(res, 'message is required')
    const command = store.createCommand({
      targetBotName: params.botName,
      commandType: 'chat',
      message,
      requestedBy: actor.username
    })
    auditOperatorAction(actor, 'chat-bot', `Sent chat to ${params.botName}: ${message}`, { botName: params.botName, message })
    return sendJson(res, 201, { command })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/disconnect')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const command = store.createCommand({ targetBotName: params.botName, commandType: 'disconnect', requestedBy: actor.username })
    auditOperatorAction(actor, 'disconnect-bot', `Queued disconnect for ${params.botName}.`, { botName: params.botName }, 'warn')
    return sendJson(res, 201, { command })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/reconnect')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const command = store.createCommand({ targetBotName: params.botName, commandType: 'reconnect', requestedBy: actor.username })
    auditOperatorAction(actor, 'reconnect-bot', `Queued force-reconnect for ${params.botName}.`, { botName: params.botName })
    return sendJson(res, 201, { command })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/files') {
    const body = await readBody(req)
    if (!body?.originalName || !body?.contentBase64) {
      return badRequest(res, 'originalName and contentBase64 are required')
    }
    const targetBotName = String(body?.targetBotName || '').trim()
    const targetHostLabel = String(body?.targetHostLabel || '').trim()
    if (targetBotName && !store.listBots().some((b) => b.botName === targetBotName)) {
      return badRequest(res, `unknown targetBotName: ${targetBotName}`)
    }
    if (targetHostLabel && !store.listBotsForHost(targetHostLabel).length) {
      return badRequest(res, `unknown targetHostLabel: ${targetHostLabel}`)
    }
    const item = store.createFileUpload({ ...body, uploadedBy: body?.uploadedBy || actor.username, targetHostLabel })
    let finalItem = item
    if (targetBotName) {
      finalItem = store.assignFile(item.fileId, targetBotName) || item
    } else if (targetHostLabel) {
      finalItem = store.assignFileToNode(item.fileId, targetHostLabel) || item
    }
    auditOperatorAction(
      actor,
      targetBotName ? 'upload-file-assign-bot' : (targetHostLabel ? 'upload-file-assign-node' : 'upload-file'),
      targetBotName
        ? `Uploaded ${item.originalName} and assigned to bot ${targetBotName}.`
        : (targetHostLabel ? `Uploaded ${item.originalName} and assigned to node ${targetHostLabel}.` : `Uploaded ${item.originalName}.`),
      {
      fileId: item.fileId,
      originalName: item.originalName,
      sizeBytes: item.sizeBytes,
      nameConflictCount: item.nameConflictCount,
      targetBotName: targetBotName || null,
      targetHostLabel: targetHostLabel || null
    })
    return sendJson(res, 201, { item: finalItem })
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
  const demoOperators = store.listOperatorCredentials().filter((item) => {
    const username = String(item.username || '').toLowerCase()
    return (username === 'admin-demo' || username === 'operator-demo' || username === 'viewer-demo')
      && String(item.password || '') === username
  })
  console.log(`[dashboard-service] listening on http://${HOST}:${PORT}`)
  console.log(`[dashboard-service] loaded ${store.listOperators().length} operator account(s) from ${path.join(DATA_DIR, 'operators.json')}`)
  if (demoOperators.length) {
    console.warn(`[dashboard-service] WARNING: demo operator credentials are enabled: ${demoOperators.map((item) => item.username).join(', ')}. Replace or delete them before exposing this dashboard.`)
  }
  console.log(`[dashboard-service] log downloads served from ${LOGS_DIR} (also checks ${path.resolve(process.cwd(), 'logs')})`)
  console.log(`[dashboard-service] direct NBT uploads go to ${NBT_DIR}`)
})
