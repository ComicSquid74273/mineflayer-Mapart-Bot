const http = require('http')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const zlib = require('zlib')
const os = require('os')
const { createStore } = require('./store')

const HOST = process.env.DASHBOARD_HOST || '0.0.0.0'
const PORT = Number(process.env.DASHBOARD_PORT || 4080)
const DATA_DIR = process.env.DASHBOARD_DATA_DIR || path.resolve(__dirname, '..', 'data')
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')
const LOGS_DIR = process.env.DASHBOARD_LOGS_DIR || path.resolve(__dirname, '..', '..', 'logs')
const CONFIG_DIR = process.env.DASHBOARD_CONFIG_DIR || path.resolve(__dirname, '..', '..', 'nerv-printer-config', '_configs')
const NBT_DIR = process.env.DASHBOARD_NBT_DIR || path.resolve(__dirname, '..', '..', 'nerv-printer-config')
const store = createStore(DATA_DIR)
const SESSION_COOKIE_NAME = 'mapart_dashboard_session'
const SESSION_MAX_AGE_SECONDS = Math.max(3600, Number(process.env.DASHBOARD_SESSION_MAX_AGE_SECONDS || 7 * 24 * 60 * 60))
const SNAPSHOT_CACHE_MS = Math.max(0, Number(process.env.DASHBOARD_SNAPSHOT_CACHE_MS || 10000))
const SNAPSHOT_SLOW_STEP_MS = Math.max(0, Number(process.env.DASHBOARD_SNAPSHOT_SLOW_STEP_MS || 500))
const SLOW_ROUTE_MS = Math.max(0, Number(process.env.DASHBOARD_SLOW_ROUTE_MS || 750))
const BOT_FRESH_MS = Math.max(5000, Number(process.env.DASHBOARD_BOT_FRESH_MS || 90000))
const ETA_MAP_TIME_MS = Math.max(60 * 1000, Number(process.env.DASHBOARD_ETA_MAP_TIME_MS || 30 * 60 * 1000))
const NODE_DOWNLOAD_TIMEOUT_MS = Math.max(15000, Number(process.env.DASHBOARD_NODE_DOWNLOAD_TIMEOUT_MS || 60000))
const ALERT_ERROR_TTL_MS = Math.max(30000, Number(process.env.DASHBOARD_ALERT_ERROR_TTL_MS || 15 * 60 * 1000))
const ALERT_WARNING_TTL_MS = Math.max(30000, Number(process.env.DASHBOARD_ALERT_WARNING_TTL_MS || 15 * 60 * 1000))
const RUNTIME_DURATION_ALERT_MS = Math.max(60 * 1000, Number(process.env.DASHBOARD_RUNTIME_DURATION_ALERT_MS || 30 * 60 * 1000))
const MAX_REQUEST_BODY_BYTES = Math.max(1024 * 1024, Number(process.env.DASHBOARD_MAX_REQUEST_BYTES || 64 * 1024 * 1024))
const MAX_UPLOAD_BYTES = Math.max(1024 * 1024, Number(process.env.DASHBOARD_MAX_UPLOAD_BYTES || 512 * 1024 * 1024))
const MAX_ZIP_ENTRY_BYTES = Math.max(1024 * 1024, Number(process.env.DASHBOARD_MAX_ZIP_ENTRY_BYTES || 64 * 1024 * 1024))
const MAX_ZIP_TOTAL_BYTES = Math.max(MAX_ZIP_ENTRY_BYTES, Number(process.env.DASHBOARD_MAX_ZIP_TOTAL_BYTES || MAX_UPLOAD_BYTES))
const MAX_ZIP_ENTRIES = Math.max(1, Number(process.env.DASHBOARD_MAX_ZIP_ENTRIES || 1000))
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

function installTimestampedConsole() {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error
  }
  const formatArgs = (args) => [`[${new Date().toISOString()}]`, ...args]
  console.log = (...args) => original.log(...formatArgs(args))
  console.warn = (...args) => original.warn(...formatArgs(args))
  console.error = (...args) => original.error(...formatArgs(args))
}

installTimestampedConsole()

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
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
    'cache-control': 'no-store'
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
  if (requiredPermission === 'admin') return normalizeRole(actor?.role, '') === 'admin'
  return Boolean(actor?.permissions?.[requiredPermission])
}

function getAuthRequirement(pathname, method) {
  if (pathname === '/api/dashboard/auth/login' || pathname === '/api/dashboard/auth/logout') return null
  if (pathname === '/api/dashboard/auth/me') return 'authenticated'
  if (reqIsLogPath(pathname, method)) return 'canViewLogs'
  if (reqIsLogDeletePath(pathname, method)) return 'canManageOperators'
  if (reqIsDashboardFileReadPath(pathname, method)) return 'canOperate'
  if (reqIsOperatorManagementPath(pathname)) return 'canManageOperators'
  if (reqIsAdminOnlyPath(pathname, method)) return 'admin'
  if (reqIsDataManagementPath(pathname)) return 'canManageOperators'
  if (reqIsConfigManagementPath(pathname)) return 'canManageOperators'
  if (reqIsFinishedMapDeletePath(pathname, method)) return 'canManageOperators'
  if (reqIsNodeDeletePath(pathname, method)) return 'canDeleteNodeFiles'
  if (reqIsDashboardOperationPath(pathname, method)) return 'canOperate'
  return null
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '')
  const cookies = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!key) continue
    cookies[key] = decodeURIComponent(value)
  }
  return cookies
}

function getSessionSecret() {
  const envSecret = String(process.env.DASHBOARD_SESSION_SECRET || '').trim()
  if (envSecret) return envSecret
  const secretPath = path.join(DATA_DIR, 'session-secret.txt')
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, 'utf8').trim()
      if (existing) return existing
    }
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    const generated = crypto.randomBytes(32).toString('base64url')
    fs.writeFileSync(secretPath, generated, { encoding: 'utf8', flag: 'wx' })
    return generated
  } catch {
    return crypto.createHash('sha256').update(`${DATA_DIR}:${PORT}:mapart-dashboard`).digest('hex')
  }
}

const SESSION_SECRET = getSessionSecret()

function signSessionPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verifySessionToken(token) {
  const value = String(token || '').trim()
  const [body, sig] = value.split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url')
  const expectedBuffer = Buffer.from(expected)
  const sigBuffer = Buffer.from(sig)
  if (expectedBuffer.length !== sigBuffer.length || !crypto.timingSafeEqual(expectedBuffer, sigBuffer)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (Number(payload?.exp || 0) < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

function createSessionCookie(username) {
  const token = signSessionPayload({
    username,
    iat: Date.now(),
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
  })
  const secure = String(process.env.DASHBOARD_COOKIE_SECURE || '').trim().toLowerCase() === 'true'
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`
}

function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
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

function reqIsFinishedMapDeletePath(pathname, method) {
  return method === 'POST' && (
    pathname === '/api/dashboard/nodes/finished-maps/delete-all'
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/finished-maps/:fileName/delete'))
  )
}

function reqIsAdminOnlyPath(pathname, method) {
  return method === 'POST' && (
    pathname === '/api/dashboard/reset-everything'
    || pathname === '/api/dashboard/nodes/finished-maps/delete-all'
  )
}

function reqIsLogDeletePath(pathname, method) {
  return method === 'POST' && Boolean(matchPath(pathname, '/api/dashboard/logs/:fileName/delete'))
}

function reqIsDashboardFileReadPath(pathname, method) {
  return method === 'GET' && (pathname === '/api/dashboard/files' || pathname === '/api/dashboard/queue')
}

function reqIsOperatorManagementPath(pathname) {
  return pathname === '/api/dashboard/operators'
    || Boolean(matchPath(pathname, '/api/dashboard/operators/:username/delete'))
}

function reqIsDataManagementPath(pathname) {
  return pathname === '/api/dashboard/data'
    || pathname === '/api/dashboard/data/clear'
    || pathname === '/api/dashboard/reset-everything'
    || Boolean(matchPath(pathname, '/api/dashboard/data/:fileName/delete'))
}

function reqIsConfigManagementPath(pathname) {
  return pathname === '/api/dashboard/config'
    || Boolean(matchPath(pathname, '/api/dashboard/config/:fileName'))
    || Boolean(matchPath(pathname, '/api/dashboard/config/:fileName/download'))
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/config/:fileName/download'))
}

function reqIsDashboardOperationPath(pathname, method) {
  if (method !== 'POST') return false
  return pathname === '/api/dashboard/commands/start-all'
    || pathname === '/api/dashboard/commands/stop-all'
    || pathname === '/api/dashboard/files'
    || pathname === '/api/dashboard/uploads'
    || pathname === '/api/dashboard/reset-everything'
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/nbt/upload'))
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/start'))
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/stop'))
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/chat'))
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/reset-current-nbt'))
    || Boolean(matchPath(pathname, '/api/dashboard/nodes/:hostLabel/finished-maps/:fileName/reprint'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/start'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/stop'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/verify'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/chat'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/disconnect'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/reconnect'))
    || Boolean(matchPath(pathname, '/api/dashboard/bots/:botName/commands/reset-current-nbt'))
    || Boolean(matchPath(pathname, '/api/dashboard/files/:fileId/assign'))
    || Boolean(matchPath(pathname, '/api/dashboard/queue/:fileId/release'))
    || Boolean(matchPath(pathname, '/api/dashboard/queue/:fileId/retry'))
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
  const homeDir = os.homedir()
  if (homeDir && !dirs.includes(homeDir)) dirs.push(homeDir)

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
  const homeDir = os.homedir()
  if (homeDir && !dirs.includes(homeDir)) dirs.push(homeDir)
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
  const cookies = parseCookies(req)
  const session = verifySessionToken(cookies[SESSION_COOKIE_NAME])
  if (session?.username) {
    const account = store.getOperator(session.username, true)
    if (account) {
      return {
        username: account.username,
        role: normalizeRole(account.role, 'viewer'),
        permissions: getEffectivePermissions(account)
      }
    }
  }

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

function payloadTooLarge(message) {
  const error = new Error(message)
  error.statusCode = 413
  error.code = 'PAYLOAD_TOO_LARGE'
  return error
}

async function readBody(req, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes || MAX_REQUEST_BODY_BYTES))
  const contentLength = Number(req.headers['content-length'] || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw payloadTooLarge(`request body exceeds ${maxBytes} bytes`)
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) {
      throw payloadTooLarge(`request body exceeds ${maxBytes} bytes`)
    }
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

function parseMultipartBody(buffer, contentType) {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2] || '').trim() : ''
  if (!boundary) throw new Error('multipart boundary is missing')
  const delimiter = Buffer.from(`--${boundary}`)
  const parts = []
  let cursor = buffer.indexOf(delimiter)
  while (cursor >= 0) {
    cursor += delimiter.length
    if (buffer.slice(cursor, cursor + 2).toString() === '--') break
    if (buffer.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor)
    if (headerEnd < 0) break
    const rawHeaders = buffer.slice(cursor, headerEnd).toString('utf8')
    let bodyStart = headerEnd + 4
    let next = buffer.indexOf(delimiter, bodyStart)
    if (next < 0) break
    let bodyEnd = next
    if (bodyEnd >= 2 && buffer.slice(bodyEnd - 2, bodyEnd).toString() === '\r\n') bodyEnd -= 2
    const headers = {}
    for (const line of rawHeaders.split('\r\n')) {
      const index = line.indexOf(':')
      if (index < 0) continue
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
    }
    const disposition = headers['content-disposition'] || ''
    const name = disposition.match(/name="([^"]+)"/i)?.[1] || ''
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1] || ''
    parts.push({
      name,
      filename: filename ? path.basename(filename) : '',
      contentType: headers['content-type'] || '',
      data: buffer.slice(bodyStart, bodyEnd)
    })
    cursor = next
  }
  return parts
}

async function readMultipartForm(req) {
  const raw = await readBody(req, { maxBytes: MAX_UPLOAD_BYTES })
  const parts = parseMultipartBody(Buffer.isBuffer(raw) ? raw : Buffer.alloc(0), req.headers['content-type'])
  const fields = {}
  const files = []
  for (const part of parts) {
    if (part.filename) {
      files.push(part)
    } else if (part.name) {
      fields[part.name] = part.data.toString('utf8')
    }
  }
  return { fields, files }
}

function readUInt32(buffer, offset) {
  return offset >= 0 && offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0
}

function readUInt16(buffer, offset) {
  return offset >= 0 && offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : 0
}

function findZipEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 65535)
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (readUInt32(buffer, offset) === 0x06054b50) return offset
  }
  return -1
}

function extractNbtFilesFromZip(buffer, archiveName) {
  const eocd = findZipEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error(`${archiveName}: invalid zip file`)
  const entryCount = readUInt16(buffer, eocd + 10)
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error(`${archiveName}: zip contains too many entries (${entryCount}/${MAX_ZIP_ENTRIES})`)
  }
  const centralDirOffset = readUInt32(buffer, eocd + 16)
  const items = []
  let totalUncompressedBytes = 0
  let offset = centralDirOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(buffer, offset) !== 0x02014b50) break
    const compression = readUInt16(buffer, offset + 10)
    const compressedSize = readUInt32(buffer, offset + 20)
    const uncompressedSize = readUInt32(buffer, offset + 24)
    const fileNameLength = readUInt16(buffer, offset + 28)
    const extraLength = readUInt16(buffer, offset + 30)
    const commentLength = readUInt16(buffer, offset + 32)
    const localHeaderOffset = readUInt32(buffer, offset + 42)
    const rawName = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8')
    const fileName = path.basename(rawName)
    offset += 46 + fileNameLength + extraLength + commentLength
    if (!fileName || !fileName.toLowerCase().endsWith('.nbt')) continue
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw new Error(`${archiveName}: ${fileName} exceeds max entry size ${MAX_ZIP_ENTRY_BYTES} bytes`)
    }
    totalUncompressedBytes += uncompressedSize
    if (totalUncompressedBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(`${archiveName}: extracted NBT total exceeds ${MAX_ZIP_TOTAL_BYTES} bytes`)
    }
    if (readUInt32(buffer, localHeaderOffset) !== 0x04034b50) continue
    const localNameLength = readUInt16(buffer, localHeaderOffset + 26)
    const localExtraLength = readUInt16(buffer, localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.slice(dataStart, dataStart + compressedSize)
    let data
    if (compression === 0) {
      data = compressed
    } else if (compression === 8) {
      data = zlib.inflateRawSync(compressed)
    } else {
      throw new Error(`${archiveName}: unsupported zip compression method ${compression} for ${fileName}`)
    }
    if (uncompressedSize && data.length !== uncompressedSize) {
      throw new Error(`${archiveName}: size mismatch for ${fileName}`)
    }
    if (data.length > MAX_ZIP_ENTRY_BYTES) {
      throw new Error(`${archiveName}: ${fileName} exceeds max entry size ${MAX_ZIP_ENTRY_BYTES} bytes`)
    }
    items.push({ fileName, data })
  }
  return items
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

function filterRecentWarnings(warnings, now = Date.now()) {
  return (Array.isArray(warnings) ? warnings : [])
    .filter((warning) => {
      const lastSeenAt = warning?.lastSeenAt || warning?.firstSeenAt
      return isRecentTimestamp(lastSeenAt, ALERT_WARNING_TTL_MS, now)
    })
    .slice(-5)
}

function hasRecentBotError(bot, now = Date.now()) {
  const text = String(bot?.lastError || '').trim()
  if (!text) return false
  return isRecentTimestamp(bot?.lastErrorAt, ALERT_ERROR_TTL_MS, now)
}

function summarizeBot(bot, pauseState = null) {
  const lastStatusAt = new Date(bot?.serverStatusAt || bot?.lastStatusAt || bot?.heartbeatAt || 0).getTime()
  const ageMs = Number.isFinite(lastStatusAt) ? Math.max(0, Date.now() - lastStatusAt) : Number.POSITIVE_INFINITY
  const fresh = ageMs <= BOT_FRESH_MS
  const online = fresh ? bot.online === true : false
  const activeState = fresh ? bot.activeState : 'offline'
  const currentNbt = String(bot?.currentNbt || '').trim()
  const statusDetail = bot.statusDetail || bot.phase || null
  const spawnDetail = /^spawn-\d+$/i.test(String(statusDetail || '').trim())
  const spawnPhase = String(bot?.phase || '').trim().toLowerCase() === 'waiting-spawn'
  const activeNbtRun = fresh && currentNbt && currentNbt.toLowerCase() !== 'none' && bot?.currentNbtStartedAt
  const displayPhase = activeNbtRun && (spawnPhase || spawnDetail) ? 'printing' : bot.phase
  const displayStatusDetail = activeNbtRun && (spawnPhase || spawnDetail) ? 'printing' : statusDetail
  const warnings = online ? filterRecentWarnings(bot.warnings) : []
  const recentError = online && hasRecentBotError(bot)
  return {
    botName: bot.botName,
    runtime: bot.runtime,
    runtimeInstanceId: bot.runtimeInstanceId || null,
    runtimeStartedAt: bot.runtimeStartedAt || null,
    hostLabel: bot.hostLabel,
    configFileName: bot.configFileName || null,
    online,
    phase: displayPhase,
    statusDetail: displayStatusDetail,
    health: bot.health,
    hunger: bot.hunger,
    activeState,
    pauseDesired: pauseState?.paused === true,
    pauseStartedAt: pauseState?.pausedAt || null,
    pauseUpdatedAt: pauseState?.updatedAt || null,
    pauseReason: pauseState?.reason || null,
    location: bot.location,
    locationDetail: bot.locationDetail || bot.location || null,
    idle: bot.idle,
    heartbeatAt: bot.heartbeatAt,
    role: bot.role,
    recoveryState: bot.recoveryState,
    reconnectState: bot.reconnectState,
    reconnectCount: Number.isFinite(Number(bot.reconnectCount)) ? Number(bot.reconnectCount) : 0,
    reconnectStreak: Number.isFinite(Number(bot.reconnectStreak)) ? Number(bot.reconnectStreak) : 0,
    nodeRestartCount: Number.isFinite(Number(bot.nodeRestartCount)) ? Number(bot.nodeRestartCount) : 0,
    currentNbt,
    lastStatusAt: bot.serverStatusAt || bot.lastStatusAt,
    reportedLastStatusAt: bot.reportedLastStatusAt || bot.lastStatusAt || null,
    lastError: recentError ? bot.lastError : null,
    lastErrorAt: recentError ? bot.lastErrorAt : null,
    deathMessage: String(bot.deathMessage || '').trim() || null,
    deathMessageAt: bot.deathMessage ? bot.deathMessageAt || null : null,
    warnings,
    alerts: fresh ? (Array.isArray(bot.alerts) ? bot.alerts.filter((item) => item && item.active === true).slice(-8) : []) : [],
    progress: bot.progress || null,
    verificationCode: bot.verificationCode || null,
    tokenWaiting: bot.tokenWaiting === true,
    botIp: bot.botIp || null,
    currentNbtStartedAt: bot.currentNbtStartedAt || null,
    latencyMs: typeof bot.latencyMs === 'number' ? bot.latencyMs : null,
    tpaTarget: bot.tpaTarget || null,
    clientState: bot.clientState || null,
    recentChat: Array.isArray(bot.recentChat) ? bot.recentChat : []
  }
}

function summarizeNode(node) {
  return {
    hostLabel: node.hostLabel,
    botCount: node.botCount,
    onlineCount: node.onlineCount,
    botNames: node.botNames,
    configFiles: Array.isArray(node.configFiles) ? node.configFiles : [],
    lastStatusAt: node.lastStatusAt,
    nodeFiles: Array.isArray(node.nodeFiles) ? node.nodeFiles : [],
    nodeLogs: Array.isArray(node.nodeLogs) ? node.nodeLogs : [],
    finishedMapCount: Number.isFinite(Number(node.finishedMapCount)) ? Number(node.finishedMapCount) : 0,
    finishedMapFiles: Array.isArray(node.finishedMapFiles) ? node.finishedMapFiles : [],
    reprintCommands: listNodeReprintCommands(node.hostLabel),
    assignmentStats: node.assignmentStats || null,
    operationalStats: node.operationalStats || null,
    currentRun: node.timing?.activeRun || null,
    timing: node.timing || null
  }
}

function listNodeReprintCommands(hostLabel) {
  const normalizedHost = String(hostLabel || '').trim()
  if (!normalizedHost) return []
  const cutoffMs = Date.now() - (10 * 60 * 1000)
  return store.listCommands((item) => {
    if (item.commandType !== 'reprint-finished-map') return false
    if (String(item.targetHostLabel || '').trim() !== normalizedHost) return false
    if (item.status === 'pending' || item.status === 'claimed') return true
    const completedMs = new Date(item.completedAt || item.createdAt || 0).getTime()
    return Number.isFinite(completedMs) && completedMs >= cutoffMs
  })
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    .slice(0, 8)
    .map((item) => ({
      commandId: item.commandId,
      fileName: item.fileName || 'unknown.nbt',
      status: item.status || 'unknown',
      claimedByBotName: item.claimedByBotName || null,
      createdAt: item.createdAt || null,
      completedAt: item.completedAt || null,
      resultMessage: item.resultMessage || null
    }))
}

function listUploadAssignments(limit = 150) {
  const commandCutoffMs = Date.now() - (60 * 60 * 1000)
  const nowMs = Date.now()
  const botStatusByName = new Map(store.listBots().map((bot) => [bot.botName, bot]))
  const activeQueueStatuses = new Set(['claimed', 'downloaded', 'printing', 'repair', 'post-print', 'cleanup'])
  const displayQueueStatus = (item) => {
    const status = String(item.queueStatus || '').trim().toLowerCase()
    const botName = String(item.claimedByBotName || '').trim()
    if (!botName || !activeQueueStatuses.has(status)) return item.queueStatus || null
    const bot = botStatusByName.get(botName)
    const lastStatusMs = new Date(bot?.serverStatusAt || bot?.lastStatusAt || bot?.heartbeatAt || 0).getTime()
    const fresh = Number.isFinite(lastStatusMs) && nowMs - lastStatusMs <= BOT_FRESH_MS && bot?.online === true
    return fresh ? item.queueStatus || null : 'held'
  }
  const fileAssignments = store.listFiles()
    .filter((item) => item.queueMode === true || item.assignedBotName || item.assignedHostLabel || item.claimedByBotName || item.deliveryStatus !== 'unassigned')
    .map((item) => ({
      id: item.fileId,
      source: item.source || (item.queueMode === true ? 'queue' : 'stored-file'),
      batchId: item.batchId || null,
      fileName: item.originalName || item.storedName || item.fileId,
      sizeBytes: item.sizeBytes,
      targetBotName: item.targetBotName || item.assignedBotName || null,
      targetHostLabel: item.targetHostLabel || item.assignedHostLabel || null,
      claimedByBotName: item.claimedByBotName || null,
      claimedByHostLabel: item.claimedByHostLabel || null,
      status: item.deliveryStatus || 'unknown',
      queueStatus: displayQueueStatus(item),
      attemptCount: Number.isFinite(Number(item.attemptCount)) ? Number(item.attemptCount) : 0,
      maxAttempts: Number.isFinite(Number(item.maxAttempts)) ? Number(item.maxAttempts) : 3,
      localFileName: item.localFileName || null,
      localPath: item.localPath || null,
      lastAttemptAt: item.lastAttemptAt || null,
      failedAt: item.failedAt || null,
      failureHistory: Array.isArray(item.failureHistory) ? item.failureHistory.slice(-5) : [],
      retryReason: item.retryReason || null,
      retriedAt: item.retriedAt || null,
      createdAt: item.uploadedAt || null,
      completedAt: item.deliveredAt || null,
      resultMessage: item.failedReason || null
    }))
  const commandAssignments = store.listCommands((item) => {
    if (item.commandType !== 'upload-node-file') return false
    if (item.status === 'pending' || item.status === 'claimed') return true
    const completedMs = new Date(item.completedAt || item.createdAt || 0).getTime()
    return Number.isFinite(completedMs) && completedMs >= commandCutoffMs
  })
    .map((item) => ({
      id: item.commandId,
      source: 'node-command',
      fileName: item.fileName || 'unknown.nbt',
      sizeBytes: null,
      targetBotName: item.targetBotName || null,
      targetHostLabel: item.targetHostLabel || null,
      claimedByBotName: item.claimedByBotName || null,
      status: item.status || 'unknown',
      createdAt: item.createdAt || null,
      completedAt: item.completedAt || null,
      resultMessage: item.resultMessage || null
    }))
  const items = [...commandAssignments, ...fileAssignments]
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
  const parsedLimit = Number(limit)
  return Number.isFinite(parsedLimit) && parsedLimit > 0 ? items.slice(0, parsedLimit) : items
}

function getAssignmentDisplayStatus(item) {
  return String(item.queueStatus || item.status || '').trim().toLowerCase()
}

function buildFixedQueueEtaValue(remaining, workerCount, reasonWhenEmpty) {
  const count = Math.max(0, Number(workerCount || 0))
  if (remaining <= 0) {
    return {
      available: true,
      reason: 'complete',
      workerCount: count,
      ms: 0
    }
  }
  if (count <= 0) {
    return {
      available: false,
      reason: reasonWhenEmpty,
      workerCount: 0,
      ms: null
    }
  }
  return {
    available: true,
    reason: 'fixed-map-time',
    workerCount: count,
    ms: Math.ceil((remaining * ETA_MAP_TIME_MS) / count)
  }
}

function buildObservedNodeQueueEtaValue(remaining, nodes = []) {
  const onlineNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => Math.max(0, Number(node?.onlineCount || 0)) > 0)
  const timingNodes = onlineNodes
    .map((node) => {
      const averageDurationMs = Math.max(0, Number(node?.timing?.averageDurationMs || 0))
      const totalCompletedMaps = Math.max(0, Number(node?.timing?.totalCompletedMaps || 0))
      return { averageDurationMs, totalCompletedMaps }
    })
    .filter((item) => item.averageDurationMs > 0 && item.totalCompletedMaps > 0)

  if (remaining <= 0) {
    return {
      available: true,
      reason: 'complete',
      workerCount: timingNodes.length,
      nodeCount: onlineNodes.length,
      observedNodeCount: timingNodes.length,
      averageMapMs: 0,
      ms: 0
    }
  }
  if (!onlineNodes.length) {
    return {
      available: false,
      reason: 'no-online-nodes',
      workerCount: 0,
      nodeCount: 0,
      observedNodeCount: 0,
      averageMapMs: null,
      ms: null
    }
  }
  if (!timingNodes.length) {
    return {
      available: false,
      reason: 'no-node-timing',
      workerCount: 0,
      nodeCount: onlineNodes.length,
      observedNodeCount: 0,
      averageMapMs: null,
      ms: null
    }
  }

  const totalCompletedMaps = timingNodes.reduce((sum, item) => sum + item.totalCompletedMaps, 0)
  const totalDurationMs = timingNodes.reduce((sum, item) => sum + (item.averageDurationMs * item.totalCompletedMaps), 0)
  const observedAverageMapMs = totalCompletedMaps > 0 ? Math.round(totalDurationMs / totalCompletedMaps) : 0
  const mapsPerMs = timingNodes.reduce((sum, item) => sum + (1 / item.averageDurationMs), 0)

  return {
    available: true,
    reason: 'observed-node-time',
    workerCount: timingNodes.length,
    nodeCount: onlineNodes.length,
    observedNodeCount: timingNodes.length,
    averageMapMs: observedAverageMapMs,
    ms: mapsPerMs > 0 ? Math.ceil(remaining / mapsPerMs) : null
  }
}

function buildQueueEta(remainingCount, nodes = []) {
  const remaining = Math.max(0, Number(remainingCount || 0))
  const allNodes = Array.isArray(nodes) ? nodes : []
  const knownNodeCount = allNodes.length
  const onlineBotCount = allNodes.reduce((count, node) => count + Math.max(0, Number(node?.onlineCount || 0)), 0)
  const onlineNodeCount = allNodes.filter((node) => Math.max(0, Number(node?.onlineCount || 0)) > 0).length

  return {
    strategy: 'deployed-fixed-online-observed-node-time',
    averageMapMs: ETA_MAP_TIME_MS,
    remaining,
    knownNodeCount,
    onlineBotCount,
    onlineNodeCount,
    deployed: buildFixedQueueEtaValue(remaining, knownNodeCount, 'no-known-nodes'),
    online: buildObservedNodeQueueEtaValue(remaining, allNodes)
  }
}

function buildQueueSummary(assignments, nodes = []) {
  const summary = {
    total: 0,
    remaining: 0,
    pending: 0,
    active: 0,
    retrying: 0,
    requeued: 0,
    completed: 0,
    cancelled: 0,
    attention: 0,
    localNodeFiles: 0,
    managedLocalNodeFiles: 0,
    nodeFinishedMapCount: 0,
    combinedRemaining: 0,
    combinedCompleted: 0,
    combinedTotal: 0,
    eta: null
  }
  const activeStatuses = new Set(['claimed', 'downloaded', 'printing', 'repair', 'post-print', 'cleanup', 'held'])
  const completedStatuses = new Set(['placed', 'completed', 'succeeded'])
  for (const item of assignments) {
    if (item.source === 'node-command') continue
    const status = getAssignmentDisplayStatus(item) || 'pending'
    summary.total += 1
    if (completedStatuses.has(status)) {
      summary.completed += 1
      continue
    }
    if (status === 'cancelled') {
      summary.cancelled += 1
      continue
    }
    summary.remaining += 1
    if (activeStatuses.has(status)) {
      summary.active += 1
    } else if (status === 'failed' || status === 'failed-final') {
      summary.retrying += 1
    } else {
      summary.pending += 1
      if (Number(item.attemptCount || 0) > 0) summary.requeued += 1
    }
    const maxAttempts = Math.max(1, Number(item.maxAttempts || 3) || 3)
    if (Number(item.attemptCount || 0) >= maxAttempts) summary.attention += 1
  }
  const managedLocalNamesByHost = new Map()
  for (const item of assignments) {
    if (item.source === 'node-command') continue
    const status = getAssignmentDisplayStatus(item) || 'pending'
    if (completedStatuses.has(status) || status === 'cancelled') continue
    const hostLabel = String(item.claimedByHostLabel || item.targetHostLabel || '').trim()
    const localName = path.basename(String(item.localFileName || item.fileName || '').trim())
    if (!hostLabel || !localName) continue
    if (!managedLocalNamesByHost.has(hostLabel)) managedLocalNamesByHost.set(hostLabel, new Set())
    managedLocalNamesByHost.get(hostLabel).add(localName)
  }
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const hostLabel = String(node?.hostLabel || '').trim()
    const managedNames = managedLocalNamesByHost.get(hostLabel) || new Set()
    for (const file of Array.isArray(node.nodeFiles) ? node.nodeFiles : []) {
      const fileName = path.basename(String(file?.fileName || '').trim())
      if (fileName && managedNames.has(fileName)) {
        summary.managedLocalNodeFiles += 1
      } else {
        summary.localNodeFiles += 1
      }
    }
  }
  summary.nodeFinishedMapCount = (Array.isArray(nodes) ? nodes : []).reduce((count, node) => {
    const currentFinished = Math.max(0, Number(node.finishedMapCount || 0) || 0)
    const lifetimeCompleted = Math.max(
      currentFinished,
      Number(node.totalCompletedMapCount || 0) || 0,
      Number(node?.timing?.totalCompletedMaps || 0) || 0
    )
    return count + lifetimeCompleted
  }, 0)
  summary.combinedRemaining = summary.remaining + summary.localNodeFiles
  summary.combinedCompleted = Math.max(summary.completed, summary.nodeFinishedMapCount)
  summary.combinedTotal = summary.combinedRemaining + summary.combinedCompleted
  summary.eta = buildQueueEta(summary.combinedRemaining, nodes)
  return summary
}

function createAlert(level, category, title, message, details = {}) {
  return {
    id: `${category}:${crypto.createHash('sha1').update(`${title}:${message}`).digest('hex').slice(0, 10)}`,
    level,
    category,
    title,
    message,
    details,
    createdAt: new Date().toISOString()
  }
}

function botHasLobbyPortal4Signal(bot) {
  const fields = [
    bot?.phase,
    bot?.statusDetail,
    bot?.location,
    bot?.locationDetail,
    bot?.lastError,
    bot?.activeState,
    bot?.clientState
  ]
  for (const value of fields) {
    if (String(value || '').trim().toLowerCase() === 'lobby-portal-4') return true
  }

  const warningHit = Array.isArray(bot?.warnings) && bot.warnings.some((warning) => {
    const text = `${warning?.category || ''} ${warning?.message || ''} ${JSON.stringify(warning?.details || {})}`.toLowerCase()
    return text.includes('lobby-portal-4')
  })
  if (warningHit) return true

  return Array.isArray(bot?.alerts) && bot.alerts.some((alert) => {
    if (alert?.active === false) return false
    const text = `${alert?.category || ''} ${alert?.message || ''} ${JSON.stringify(alert?.details || {})}`.toLowerCase()
    return text.includes('lobby-portal-4')
  })
}

function isActiveRuntimePhase(phase) {
  return ['printing', 'repair', 'rescan', 'post-print', 'cleanup'].includes(String(phase || '').trim().toLowerCase())
}

function getRuntimeElapsedMs(bot, now = Date.now()) {
  if (bot?.online !== true) return 0
  if (!isActiveRuntimePhase(bot?.phase)) return 0
  if (!String(bot?.currentNbt || '').trim()) return 0
  const startedAtMs = timestampMs(bot?.currentNbtStartedAt)
  if (!startedAtMs) return 0
  return Math.max(0, now - startedAtMs)
}

function buildDashboardAlerts(bots, nodes, assignments) {
  const alerts = []
  const now = Date.now()
  const staleBots = bots.filter((bot) => bot.online === true && bot.activeState === 'stale')
  const offlineBots = bots.filter((bot) => bot.online !== true)
  const offlineNodes = nodes.filter((node) => Number(node.onlineCount || 0) <= 0)
  const errorBots = bots.filter((bot) => String(bot.lastError || '').trim())
  const deathBots = bots.filter((bot) => String(bot.deathMessage || '').trim())
  const lobbyPortal4Bots = bots.filter(botHasLobbyPortal4Signal)
  const longRuntimeBots = bots
    .map((bot) => ({ bot, elapsedMs: getRuntimeElapsedMs(bot, now) }))
    .filter((entry) => entry.elapsedMs >= RUNTIME_DURATION_ALERT_MS)
  const heldAssignments = assignments.filter((item) => {
    const status = getAssignmentDisplayStatus(item)
    if (!['claimed', 'downloaded', 'printing', 'repair', 'post-print', 'cleanup', 'held'].includes(status)) return false
    if (!item.claimedByBotName) return false
    const bot = bots.find((entry) => entry.botName === item.claimedByBotName)
    return !bot || bot.online !== true || bot.activeState === 'stale'
  })
  const retryingFailures = assignments.filter((item) => {
    const status = getAssignmentDisplayStatus(item)
    return status === 'failed' || status === 'failed-final'
  })
  const exceededAttempts = assignments.filter((item) => {
    const status = getAssignmentDisplayStatus(item)
    if (!['pending', 'failed', 'failed-final'].includes(status)) return false
    const maxAttempts = Math.max(1, Number(item.maxAttempts || 3) || 3)
    return Number(item.attemptCount || 0) >= maxAttempts
  })

  const activeWaterBots = bots.filter((bot) =>
    Array.isArray(bot.alerts) && bot.alerts.some((alert) => alert?.active === true && String(alert.category || '') === 'platform-water')
  )
  const stockWarnings = bots.filter((bot) => bot.online === true).flatMap((bot) => (Array.isArray(bot.warnings) ? bot.warnings : [])
    .filter((warning) => /stock|material|food|map|xp|bottle/i.test(`${warning.category || ''} ${warning.message || ''}`))
    .map((warning) => ({ bot, warning })))

  if (lobbyPortal4Bots.length) {
    const botNames = [...new Set(lobbyPortal4Bots.map((bot) => String(bot.botName || '').trim()).filter(Boolean))]
    const hostLabels = [...new Set(lobbyPortal4Bots.map((bot) => String(bot.hostLabel || '').trim()).filter(Boolean))]
    alerts.push(createAlert('critical', 'lobby-portal-4', 'Lobby portal error', `lobby-portal-4 reported by ${botNames.join(', ') || 'unknown bot'} on ${hostLabels.join(', ') || 'unknown node'}.`, {
      botNames,
      hostLabels,
      bots: lobbyPortal4Bots.map((bot) => ({ botName: bot.botName, hostLabel: bot.hostLabel || null }))
    }))
  }
  if (activeWaterBots.length) {
    alerts.push(createAlert('critical', 'platform-water', 'Water on platform', `${activeWaterBots.length} bot(s) are paused until water is removed from the carpet layer.`, {
      botNames: activeWaterBots.map((bot) => bot.botName),
      bots: activeWaterBots.map((bot) => ({ botName: bot.botName, hostLabel: bot.hostLabel || null }))
    }))
  }
  if (longRuntimeBots.length) {
    const alertMinutes = Math.round(RUNTIME_DURATION_ALERT_MS / 60000)
    alerts.push(createAlert('critical', 'runtime-duration', `Runtime over ${alertMinutes}m`, `${longRuntimeBots.length} bot(s) have been running the current NBT for more than ${alertMinutes} minutes.`, {
      bots: longRuntimeBots.map(({ bot, elapsedMs }) => ({
        botName: bot.botName,
        hostLabel: bot.hostLabel || null,
        phase: bot.phase || null,
        currentNbt: bot.currentNbt || null,
        currentNbtStartedAt: bot.currentNbtStartedAt || null,
        elapsedMs
      }))
    }))
  }
  if (deathBots.length) {
    const summaries = deathBots.slice(0, 3).map((bot) => `${bot.botName || 'unknown bot'}: ${bot.deathMessage}`)
    const extra = deathBots.length > summaries.length ? ` +${deathBots.length - summaries.length} more` : ''
    alerts.push(createAlert('critical', 'bot-death', 'Bot death detected', `${summaries.join(' | ')}${extra}. Waiting until bot is back on platform.`, {
      botNames: deathBots.map((bot) => bot.botName),
      bots: deathBots.map((bot) => ({
        botName: bot.botName,
        hostLabel: bot.hostLabel || null,
        deathMessage: bot.deathMessage || null,
        deathMessageAt: bot.deathMessageAt || null,
        location: bot.location || null,
        locationDetail: bot.locationDetail || null
      }))
    }))
  }
  if (offlineNodes.length) {
    alerts.push(createAlert('warn', 'offline-nodes', 'Offline nodes', `${offlineNodes.length} node(s) have no online bots.`, {
      hostLabels: offlineNodes.map((node) => node.hostLabel)
    }))
  }
  if (offlineBots.length) {
    alerts.push(createAlert('warn', 'offline-bots', 'Offline bots', `${offlineBots.length}/${bots.length} bot(s) are offline.`, {
      botNames: offlineBots.map((bot) => bot.botName).slice(0, 20),
      bots: offlineBots.slice(0, 20).map((bot) => ({ botName: bot.botName, hostLabel: bot.hostLabel || null }))
    }))
  }
  if (staleBots.length) {
    alerts.push(createAlert('warn', 'stale-bots', 'Stale bots', `${staleBots.length} bot(s) stopped sending fresh activity.`, {
      botNames: staleBots.map((bot) => bot.botName),
      bots: staleBots.map((bot) => ({ botName: bot.botName, hostLabel: bot.hostLabel || null }))
    }))
  }
  if (errorBots.length) {
    alerts.push(createAlert('critical', 'bot-errors', 'Bot errors', `${errorBots.length} bot(s) reported a last error.`, {
      botNames: errorBots.map((bot) => bot.botName),
      bots: errorBots.map((bot) => ({ botName: bot.botName, hostLabel: bot.hostLabel || null }))
    }))
  }
  if (stockWarnings.length) {
    const stockWarningBots = [...new Map(stockWarnings.map((item) => [item.bot.botName, item.bot])).values()]
    alerts.push(createAlert('warn', 'stock-warnings', 'Missing stock warnings', `${stockWarnings.length} active material/food/map/XP warning(s).`, {
      botNames: stockWarningBots.map((bot) => bot.botName),
      bots: stockWarningBots.map((bot) => ({ botName: bot.botName, hostLabel: bot.hostLabel || null }))
    }))
  }
  if (heldAssignments.length) {
    alerts.push(createAlert('warn', 'queue-held', 'Held queue files', `${heldAssignments.length} queue file(s) are held for an offline or stale bot.`, {
      files: heldAssignments.slice(0, 20).map((item) => ({ fileName: item.fileName, botName: item.claimedByBotName, hostLabel: item.claimedByHostLabel || null }))
    }))
  }
  if (retryingFailures.length) {
    alerts.push(createAlert('warn', 'queue-retrying', 'Queue retry needed', `${retryingFailures.length} file(s) need to be requeued after a failed attempt.`, {
      files: retryingFailures.slice(0, 20).map((item) => item.fileName)
    }))
  }
  if (exceededAttempts.length) {
    alerts.push(createAlert('warn', 'queue-attempts', 'Queue attention', `${exceededAttempts.length} file(s) exceeded configured attempts but remain retryable.`, {
      files: exceededAttempts.slice(0, 20).map((item) => item.fileName)
    }))
  }

  const levelRank = { critical: 0, warn: 1, info: 2 }
  return alerts.sort((left, right) => (levelRank[left.level] ?? 9) - (levelRank[right.level] ?? 9))
}

let snapshotCache = { expiresAt: 0, payload: null }

function invalidateSnapshotCache() {
  snapshotCache = { expiresAt: 0, payload: null }
}

function buildDashboardSnapshot(actor = null) {
  const now = Date.now()
  const cacheKey = actor?.permissions?.canOperate === true ? 'operate' : 'public'
  if (snapshotCache.payload?.cacheKey === cacheKey && snapshotCache.expiresAt > now) {
    return snapshotCache.payload.body
  }
  const timings = []
  const timed = (label, work) => {
    const startedAt = Date.now()
    const value = work()
    timings.push(`${label}=${Date.now() - startedAt}ms`)
    return value
  }
  const fleet = timed('fleet', () => store.listFleet())
  const bots = timed('bots', () => fleet.bots.map((bot) => summarizeBot(bot, store.getBotPauseState(bot.botName))))
  const nodes = timed('nodes', () => fleet.nodes.map(summarizeNode))
  const events = timed('events', () => store.listEvents(150))
  const allAssignments = timed('assignments', () => listUploadAssignments(0))
  const assignments = actor?.permissions?.canOperate ? allAssignments.slice(0, 150) : []
  const queueSummary = timed('queueSummary', () => buildQueueSummary(allAssignments, nodes))
  const alerts = timed('alerts', () => buildDashboardAlerts(bots, nodes, allAssignments))
  const body = {
    ok: true,
    health: { ok: true },
    bots,
    nodes,
    events,
    alerts,
    queueSummary,
    uploadAssignments: assignments
  }
  const totalMs = Date.now() - now
  if (SNAPSHOT_SLOW_STEP_MS > 0 && totalMs >= SNAPSHOT_SLOW_STEP_MS) {
    console.warn(`[dashboard-service] slow snapshot total=${totalMs}ms ${timings.join(' ')}`)
  }
  snapshotCache = {
    expiresAt: now + SNAPSHOT_CACHE_MS,
    payload: { cacheKey, body }
  }
  return body
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

  if (req.method === 'GET' && pathname === '/api/dashboard/snapshot') {
    return sendJson(res, 200, buildDashboardSnapshot(actor))
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/auth/login') {
    const body = await readBody(req)
    const username = String(body?.username || '').trim()
    const password = String(body?.password || '')
    if (!username || !password) return unauthorized(res)
    const match = store.listOperatorCredentials().find((item) => item.username === username && item.password === password)
    if (!match) return unauthorized(res)
    const signedActor = {
      username: match.username,
      role: normalizeRole(match.role, 'viewer'),
      permissions: getEffectivePermissions(match)
    }
    auditOperatorAction(signedActor, 'login', `Operator ${match.username} logged in.`, { role: signedActor.role })
    return sendJson(res, 200, {
      ok: true,
      operator: signedActor.username,
      role: signedActor.role,
      permissions: {
        ...signedActor.permissions,
        canAdmin: Boolean(signedActor.permissions?.canManageOperators || signedActor.permissions?.canDeleteNodeFiles)
      }
    }, {
      'set-cookie': createSessionCookie(match.username)
    })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/auth/logout') {
    if (actor) auditOperatorAction(actor, 'logout', `Operator ${actor.username} logged out.`, { role: actor.role })
    return sendJson(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() })
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
    store.invalidateDataFileCache(filePath)
    invalidateSnapshotCache()
    if (fileName.toLowerCase() !== 'events.json') {
      auditOperatorAction(actor, 'delete-data-file', `Deleted data file ${fileName}.`, { fileName }, 'warn')
    }
    return sendJson(res, 200, { ok: true, deleted: [fileName] })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/data/clear') {
    const deleted = []
    const deletedPaths = []
    const errors = []
    try {
      for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
        if (PROTECTED_DATA_FILES.has(entry.name.toLowerCase())) continue
        const filePath = path.join(DATA_DIR, entry.name)
        try {
          fs.unlinkSync(filePath)
          deleted.push(entry.name)
          deletedPaths.push(filePath)
        } catch (err) {
          errors.push({ name: entry.name, error: err?.message || String(err) })
        }
      }
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err?.message || String(err) })
    }
    store.invalidateDataFileCache(deletedPaths)
    invalidateSnapshotCache()
    auditOperatorAction(actor, 'clear-data', `Cleared data folder: deleted ${deleted.length} file(s).`, { deleted }, 'warn')
    return sendJson(res, 200, { ok: true, deleted, errors })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/reset-everything') {
    if (normalizeRole(actor?.role, '') !== 'admin') return forbidden(res, 'admin role required')
    const body = await readBody(req)
    const phrase = String(body?.confirm || '').trim().toUpperCase()
    if (phrase !== 'RESETEVERYTHING') return badRequest(res, 'confirm must be RESETEVERYTHING')

    const nodes = store.listNodes()
    const bots = store.listBots()
    const reset = store.resetDashboardForFreshStart()
    const nodeCommands = []
    const botCommands = []
    for (const node of nodes) {
      const hostLabel = String(node.hostLabel || '').trim()
      if (!hostLabel) continue
      nodeCommands.push(store.createCommand({
        targetHostLabel: hostLabel,
        commandType: 'fresh-start-clean-node',
        reason: 'dashboard reset everything',
        requestedBy: actor.username
      }))
    }
    for (const bot of bots) {
      const botName = String(bot.botName || '').trim()
      if (!botName) continue
      botCommands.push(store.createCommand({
        targetBotName: botName,
        commandType: 'platform-cleanup',
        reason: 'dashboard reset everything',
        requestedBy: actor.username
      }))
    }

    auditOperatorAction(actor, 'reset-everything', `Reset dashboard state and queued fresh-start cleanup for ${nodes.length} node(s), ${bots.length} bot(s).`, {
      nodeCommandCount: nodeCommands.length,
      botCommandCount: botCommands.length,
      reset
    }, 'critical')
    return sendJson(res, 201, {
      ok: true,
      reset,
      nodeCommandCount: nodeCommands.length,
      botCommandCount: botCommands.length,
      nodeCommands,
      botCommands
    })
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
    files.sort((left, right) => String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base' }))
    return sendJson(res, 200, { files, configDir: CONFIG_DIR })
  }

  const configDownloadParams = matchPath(pathname, '/api/dashboard/config/:fileName/download')
  if (configDownloadParams) {
    if (!actor?.permissions?.canManageOperators) return forbidden(res, 'admin permission required')
    if (req.method !== 'GET') return methodNotAllowed(res)
    const safeName = path.basename(String(configDownloadParams.fileName || '').trim())
    if (!safeName || !safeName.toLowerCase().endsWith('.json')) return notFound(res)
    const filePath = path.join(CONFIG_DIR, safeName)
    if (!ensureWithinDir(filePath, CONFIG_DIR)) return notFound(res)
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return notFound(res)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${safeName}"`,
      'cache-control': 'no-store'
    })
    fs.createReadStream(filePath).pipe(res)
    return
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
    const { contentBase64: _contentBase64, ...commandSummary } = command
    return sendJson(res, 201, { ok: true, queued: true, command: commandSummary, fileName, sizeBytes: buffer.length })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/uploads') {
    const contentType = String(req.headers['content-type'] || '').toLowerCase()
    if (!contentType.includes('multipart/form-data')) {
      return badRequest(res, 'multipart/form-data upload is required')
    }
    const { fields, files } = await readMultipartForm(req)
    if (!files.length) return badRequest(res, 'at least one .nbt or .zip file is required')

    const targetBotName = String(fields.targetBotName || '').trim()
    const targetHostLabel = String(fields.targetHostLabel || '').trim()
    const notes = String(fields.notes || '').trim() || null
    const maxAttempts = Math.max(1, Math.min(20, Number(fields.maxAttempts || 3) || 3))
    if (targetBotName && !store.listBots().some((b) => b.botName === targetBotName)) {
      return badRequest(res, `unknown targetBotName: ${targetBotName}`)
    }
    if (targetHostLabel && !store.listBotsForHost(targetHostLabel).length) {
      return badRequest(res, `unknown targetHostLabel: ${targetHostLabel}`)
    }

    const batchId = crypto.randomUUID()
    const errors = []
    const queuedInputs = []
    for (const file of files) {
      const fileName = path.basename(String(file.filename || '').trim())
      const lower = fileName.toLowerCase()
      try {
        if (lower.endsWith('.nbt')) {
          queuedInputs.push({ fileName, data: file.data, source: 'upload' })
        } else if (lower.endsWith('.zip')) {
          const extracted = extractNbtFilesFromZip(file.data, fileName)
          if (!extracted.length) {
            errors.push({ fileName, error: 'zip contained no .nbt files' })
          } else {
            for (const entry of extracted) {
              queuedInputs.push({ fileName: entry.fileName, data: entry.data, source: `zip:${fileName}` })
            }
          }
        } else {
          errors.push({ fileName, error: 'only .nbt and .zip uploads are accepted' })
        }
      } catch (error) {
        errors.push({ fileName, error: error?.message || String(error) })
      }
    }

    const items = []
    for (const entry of queuedInputs) {
      try {
        const item = store.createFileUpload({
          originalName: entry.fileName,
          contentBuffer: entry.data,
          uploadedBy: actor.username,
          notes,
          targetHostLabel: targetHostLabel || null,
          targetBotName: targetBotName || null,
          batchId,
          source: entry.source,
          queueMode: true,
          maxAttempts
        })
        items.push(item)
      } catch (error) {
        errors.push({ fileName: entry.fileName, error: error?.message || String(error) })
      }
    }

    if (!items.length) {
      return sendJson(res, 400, { ok: false, error: 'no files were queued', errors })
    }

    auditOperatorAction(actor, 'upload-queue', `Queued ${items.length} NBT file(s) in dashboard queue.`, {
      batchId,
      fileCount: items.length,
      errors,
      targetBotName: targetBotName || null,
      targetHostLabel: targetHostLabel || null,
      maxAttempts
    }, errors.length ? 'warn' : 'info')
    return sendJson(res, 201, { ok: true, batchId, items, errors })
  }

  if (req.method === 'POST' && pathname === '/api/bots/status') {
    const body = await readBody(req)
    const error = validateBotStatus(body)
    if (error) return badRequest(res, error)
    const rawIp = req.socket?.remoteAddress || req.connection?.remoteAddress || null
    const botIp = rawIp ? rawIp.replace(/^::ffff:/, '') : null
    const bot = store.upsertBotStatus({ ...body, botIp })
    return sendJson(res, 200, { ok: true, nextPollMs: 3000, bot: summarizeBot(bot, store.getBotPauseState(bot.botName)) })
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

  params = matchPath(pathname, '/api/nodes/:hostLabel/queue/claim-next')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    if (!body?.botName) return badRequest(res, 'botName is required')
    const parsedLimit = Number(body.limit)
    const limit = Math.max(1, Math.floor(Number.isFinite(parsedLimit) ? parsedLimit : 1))
    const batchPolicy = store.getQueueBatchPolicy(limit)
    const items = limit > 1
      ? store.claimNextQueueFiles(params.hostLabel, body.botName, limit)
      : [store.claimNextQueueFile(params.hostLabel, body.botName)].filter(Boolean)
    return sendJson(res, 200, { item: items[0] || null, items, batchPolicy })
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

  params = matchPath(pathname, '/api/nodes/:hostLabel/queue/:fileId/result')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const deliveryStatus = String(body?.deliveryStatus || '').trim().toLowerCase()
    if (!['downloaded', 'printing', 'repair', 'post-print', 'cleanup', 'held', 'placed', 'completed', 'failed'].includes(deliveryStatus)) {
      return badRequest(res, 'deliveryStatus must be downloaded, printing, repair, post-print, cleanup, held, placed, completed, or failed')
    }
    const item = store.completeQueueFileDelivery(params.hostLabel, body?.botName || '', params.fileId, deliveryStatus, body?.failedReason, {
      localFileName: body?.localFileName || null,
      localPath: body?.localPath || null
    })
    if (!item) return notFound(res)
    if (deliveryStatus === 'failed') {
      const held = item.queueStatus === 'held'
      const final = item.queueStatus === 'failed-final'
      store.addEvent({
        operator: `bot:${body?.botName || params.hostLabel}`,
        action: held ? 'queue-file-held-for-resume' : (final ? 'queue-file-failed-final' : 'queue-file-auto-retry'),
        message: held
          ? `${item.originalName || params.fileId} hit a resumable runtime error and is held for the same bot/node to resume.`
          : final
          ? `${item.originalName || params.fileId} hit max attempts and needs operator retry.`
          : `${item.originalName || params.fileId} failed and returned to pending.`,
        details: {
          fileId: params.fileId,
          hostLabel: params.hostLabel,
          botName: body?.botName || null,
          failedReason: body?.failedReason || null,
          attemptCount: item.attemptCount || 0,
          maxAttempts: item.maxAttempts || 3,
          previousClaimedByBotName: item.claimedByBotName || null,
          previousClaimedByHostLabel: item.claimedByHostLabel || null
        },
        level: 'warn'
      })
    }
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
    if (command.commandType === 'delete-node-file' || command.commandType === 'delete-finished-map' || command.commandType === 'fresh-start-clean-node') {
      const finishedMapDelete = command.commandType === 'delete-finished-map'
      const freshStartCleanup = command.commandType === 'fresh-start-clean-node'
      store.addEvent({
        operator: `bot:${body?.botName || params.hostLabel}`,
        action: freshStartCleanup ? 'fresh-start-clean-node-completed' : (finishedMapDelete ? 'delete-finished-map-completed' : 'delete-node-file-completed'),
        message: freshStartCleanup
          ? `${status === 'succeeded' ? 'Cleaned' : 'Failed to clean'} fresh-start files on node ${params.hostLabel}.`
          : `${status === 'succeeded' ? 'Deleted' : 'Failed to delete'} ${finishedMapDelete ? 'finished map ' : ''}${command.fileName || 'unknown'} on node ${params.hostLabel}.`,
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

  params = matchPath(pathname, '/api/nodes/:hostLabel/config/:commandId/result')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const fileName = path.basename(String(body?.fileName || '').trim())
    const contentBase64 = String(body?.contentBase64 || '')
    if (!fileName || !fileName.toLowerCase().endsWith('.json')) return badRequest(res, 'fileName must end in .json')
    if (!contentBase64) return badRequest(res, 'contentBase64 is required')
    const command = store.getCommand(params.commandId)
    if (!command || command.targetHostLabel !== params.hostLabel || command.commandType !== 'download-node-config') return notFound(res)
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
    const downloaded = await waitForNodeLogDownload(store, command.commandId, NODE_DOWNLOAD_TIMEOUT_MS)
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

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/config/:fileName/download')
  if (params) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    const node = store.listNodes().find((item) => item.hostLabel === params.hostLabel)
    if (!node) return notFound(res)
    const fileName = path.basename(String(params.fileName || '').trim())
    if (!fileName || !fileName.toLowerCase().endsWith('.json')) return notFound(res)
    const command = store.createCommand({
      targetHostLabel: params.hostLabel,
      commandType: 'download-node-config',
      fileName,
      requestedBy: actor?.username || 'unknown'
    })
    const downloaded = await waitForNodeLogDownload(store, command.commandId, NODE_DOWNLOAD_TIMEOUT_MS)
    if (!downloaded?.filePath || !fs.existsSync(downloaded.filePath)) {
      return sendJson(res, 504, { error: `Timed out waiting for node config ${fileName} from ${params.hostLabel}` })
    }
    const downloadName = `${params.hostLabel}-${downloaded.fileName}`.replace(/[^a-zA-Z0-9._-]+/g, '-')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${downloadName}"`,
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
    store.setBotsPauseDesired(botNames, false, 'dashboard-ui start all')
    const items = store.createCommandsForBots(botNames, 'start')
    auditOperatorAction(actor, 'start-all', `Queued print start for ${botNames.length} bot(s).`, { botNames })
    return sendJson(res, 201, { items })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/commands/stop-all') {
    const body = await readBody(req)
    const botNames = store.listBots().map((item) => item.botName)
    store.setBotsPauseDesired(botNames, true, body?.reason || 'dashboard-ui pause all')
    const items = store.createCommandsForBots(botNames, 'stop', { reason: body?.reason || null })
    auditOperatorAction(actor, 'pause-all', `Queued print pause for ${botNames.length} bot(s).`, { botNames, reason: body?.reason || null }, 'warn')
    return sendJson(res, 201, { items })
  }

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/start')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const bots = store.listBotsForHost(params.hostLabel)
    if (!bots.length) return notFound(res)
    const botNames = bots.map((item) => item.botName)
    store.setBotsPauseDesired(botNames, false, 'dashboard-ui node start')
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
    store.setBotsPauseDesired(botNames, true, body?.reason || 'dashboard-ui node pause')
    const items = store.createCommandsForBots(botNames, 'stop', {
      requestedBy: actor.username,
      reason: body?.reason || null
    })
    auditOperatorAction(actor, 'pause-node', `Queued print pause for node ${params.hostLabel}.`, { hostLabel: params.hostLabel, botNames, reason: body?.reason || null }, 'warn')
    return sendJson(res, 201, { items })
  }

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/chat')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const message = String(body?.message || '').trim()
    if (!message) return badRequest(res, 'message is required')
    const bots = store.listBotsForHost(params.hostLabel)
    if (!bots.length) return notFound(res)
    const botNames = bots.map((item) => item.botName)
    const items = store.createCommandsForBots(botNames, 'chat', {
      message,
      requestedBy: actor.username
    })
    auditOperatorAction(actor, 'chat-node', `Sent chat to node ${params.hostLabel}: ${message}`, { hostLabel: params.hostLabel, botNames, message })
    return sendJson(res, 201, { items })
  }

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/commands/reset-current-nbt')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const bots = store.listBotsForHost(params.hostLabel)
      .filter((bot) => {
        const currentNbt = String(bot?.currentNbt || '').trim()
        return bot?.online === true && currentNbt && currentNbt.toLowerCase() !== 'none'
      })
    if (!bots.length) return badRequest(res, `node ${params.hostLabel} has no active NBT bot to reset`)
    const botNames = bots.map((item) => item.botName)
    const items = store.createCommandsForBots(botNames, 'reset-current-nbt', {
      requestedBy: actor.username,
      reason: body?.reason || 'dashboard-ui node reset current NBT'
    })
    auditOperatorAction(actor, 'reset-node-current-nbt', `Queued current NBT reset for node ${params.hostLabel}.`, { hostLabel: params.hostLabel, botNames, reason: body?.reason || null }, 'warn')
    return sendJson(res, 201, { items })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/start')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    store.setBotPauseDesired(params.botName, false, 'dashboard-ui bot start')
    const command = store.createCommand({ targetBotName: params.botName, commandType: 'start', requestedBy: actor.username })
    auditOperatorAction(actor, 'start-bot', `Queued print start for ${params.botName}.`, { botName: params.botName })
    return sendJson(res, 201, { command })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/stop')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    store.setBotPauseDesired(params.botName, true, body?.reason || 'dashboard-ui bot pause')
    const command = store.createCommand({
      targetBotName: params.botName,
      commandType: 'stop',
      reason: body?.reason || null,
      requestedBy: actor.username
    })
    auditOperatorAction(actor, 'pause-bot', `Queued print pause for ${params.botName}.`, { botName: params.botName, reason: body?.reason || null }, 'warn')
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

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/reset-current-nbt')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const command = store.createCommand({
      targetBotName: params.botName,
      commandType: 'reset-current-nbt',
      reason: body?.reason || 'dashboard-ui reset current NBT',
      requestedBy: actor.username
    })
    auditOperatorAction(actor, 'reset-current-nbt', `Queued current NBT reset for ${params.botName}.`, { botName: params.botName, reason: body?.reason || null }, 'warn')
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

  if (req.method === 'POST' && pathname === '/api/dashboard/nodes/finished-maps/delete-all') {
    if (normalizeRole(actor?.role, '') !== 'admin') return forbidden(res, 'admin role required')
    const existingDeletes = new Set(store.listCommands((command) =>
      command.commandType === 'delete-finished-map'
      && (command.status === 'pending' || command.status === 'claimed')
    ).map((command) => `${command.targetHostLabel || ''}\u0000${command.fileName || ''}`))
    const commands = []
    const skipped = []
    for (const node of store.listNodes()) {
      const hostLabel = String(node.hostLabel || '').trim()
      if (!hostLabel) continue
      for (const file of Array.isArray(node.finishedMapFiles) ? node.finishedMapFiles : []) {
        const fileName = path.basename(String(file?.fileName || '').trim())
        if (!fileName || !fileName.toLowerCase().endsWith('.nbt')) continue
        const key = `${hostLabel}\u0000${fileName}`
        if (existingDeletes.has(key)) {
          skipped.push({ hostLabel, fileName, reason: 'already queued' })
          continue
        }
        existingDeletes.add(key)
        commands.push(store.createCommand({
          targetHostLabel: hostLabel,
          commandType: 'delete-finished-map',
          fileName,
          requestedBy: actor.username
        }))
      }
    }
    auditOperatorAction(actor, 'delete-finished-maps-all', `Queued ${commands.length} finished map delete command(s) across all nodes.`, {
      commandCount: commands.length,
      skippedCount: skipped.length
    }, 'warn')
    return sendJson(res, 201, {
      ok: true,
      count: commands.length,
      skippedCount: skipped.length,
      commands
    })
  }

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/finished-maps/:fileName/delete')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const fileName = path.basename(String(params.fileName || '').trim())
    if (!fileName || !fileName.toLowerCase().endsWith('.nbt')) return badRequest(res, 'fileName must end in .nbt')
    const command = store.createCommand({
      targetHostLabel: params.hostLabel,
      commandType: 'delete-finished-map',
      fileName,
      requestedBy: actor.username
    })
    auditOperatorAction(actor, 'delete-finished-map', `Queued finished map delete for ${fileName} on node ${params.hostLabel}.`, {
      hostLabel: params.hostLabel,
      fileName,
      commandId: command.commandId
    }, 'warn')
    return sendJson(res, 201, { command })
  }

  params = matchPath(pathname, '/api/dashboard/nodes/:hostLabel/finished-maps/:fileName/reprint')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const fileName = path.basename(String(params.fileName || '').trim())
    if (!fileName || !fileName.toLowerCase().endsWith('.nbt')) return badRequest(res, 'fileName must end in .nbt')
    const command = store.createCommand({
      targetHostLabel: params.hostLabel,
      commandType: 'reprint-finished-map',
      fileName,
      requestedBy: actor.username
    })
    auditOperatorAction(actor, 'reprint-finished-map', `Queued reprint for ${fileName} on node ${params.hostLabel}.`, {
      hostLabel: params.hostLabel,
      fileName,
      commandId: command.commandId
    })
    return sendJson(res, 201, { command })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/files') {
    return sendJson(res, 200, { items: store.listFiles(), assignments: listUploadAssignments() })
  }

  if (req.method === 'GET' && pathname === '/api/dashboard/queue') {
    return sendJson(res, 200, { items: store.listFiles().filter((item) => item.queueMode === true || item.queueStatus), assignments: listUploadAssignments() })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/queue/retry-failed-all') {
    const body = await readBody(req)
    const reason = body?.reason || 'operator retry all failed'
    const result = store.retryFailedQueueFiles(reason)
    auditOperatorAction(actor, 'queue-retry-failed-all', `Retried ${result.count} failed queue file(s).`, {
      reason,
      affectedFileIds: result.items.map((item) => item.fileId),
      items: result.items
    })
    return sendJson(res, 200, result)
  }

  params = matchPath(pathname, '/api/dashboard/queue/:fileId/release')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const item = store.releaseQueueFile(params.fileId, body?.reason || 'operator release')
    if (!item) return notFound(res)
    auditOperatorAction(actor, 'queue-release', `Released queue file ${item.originalName || params.fileId}.`, {
      fileId: params.fileId,
      reason: body?.reason || null
    }, 'warn')
    return sendJson(res, 200, { item })
  }

  params = matchPath(pathname, '/api/dashboard/queue/:fileId/retry')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    const item = store.retryQueueFile(params.fileId, body?.reason || 'operator retry')
    if (!item) return notFound(res)
    auditOperatorAction(actor, 'queue-retry', `Retried queue file ${item.originalName || params.fileId}.`, {
      fileId: params.fileId,
      reason: body?.reason || null,
      previousClaimedByBotName: item.retryHistory?.at?.(-1)?.previousClaimedByBotName || null,
      previousClaimedByHostLabel: item.retryHistory?.at?.(-1)?.previousClaimedByHostLabel || null,
      previousAttemptCount: item.retryHistory?.at?.(-1)?.previousAttemptCount || null
    })
    return sendJson(res, 200, { item })
  }

  return notFound(res)
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now()
  res.on('finish', () => {
    const elapsed = Date.now() - startedAt
    if (SLOW_ROUTE_MS > 0 && elapsed >= SLOW_ROUTE_MS) {
      console.warn(`[dashboard-service] slow route ${req.method} ${req.url} status=${res.statusCode} elapsed=${elapsed}ms`)
    }
  })
  route(req, res).catch((error) => {
    const statusCode = Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : 500
    sendJson(res, statusCode, { error: error?.message || String(error) })
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
  console.log(`[dashboard-service] log downloads served from ${LOGS_DIR} (also checks ${path.resolve(process.cwd(), 'logs')} and ${os.homedir()})`)
  console.log(`[dashboard-service] direct NBT uploads go to ${NBT_DIR}`)
})
