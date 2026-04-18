const http = require('http')
const path = require('path')
const fs = require('fs')
const { createStore } = require('./store')

const HOST = process.env.DASHBOARD_HOST || '0.0.0.0'
const PORT = Number(process.env.DASHBOARD_PORT || 4080)
const DATA_DIR = process.env.DASHBOARD_DATA_DIR || path.resolve(__dirname, '..', 'data')
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')
const store = createStore(DATA_DIR)

const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload, null, 2))
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(String(message || ''))
}

function sendFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase()
  const contentType = STATIC_TYPES[extension] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': contentType })
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
  return {
    botName: bot.botName,
    runtime: bot.runtime,
    hostLabel: bot.hostLabel,
    online: bot.online,
    phase: bot.phase,
    health: bot.health,
    hunger: bot.hunger,
    activeState: bot.activeState,
    location: bot.location,
    idle: bot.idle,
    heartbeatAt: bot.heartbeatAt,
    role: bot.role,
    recoveryState: bot.recoveryState,
    reconnectState: bot.reconnectState,
    currentNbt: bot.currentNbt,
    lastStatusAt: bot.lastStatusAt,
    lastError: bot.lastError || null
  }
}

async function route(req, res) {
  const { pathname } = parseUrl(req)

  if (pathname === '/' || pathname.startsWith('/assets/')) {
    if (tryServeStatic(req, res, pathname)) return
  }

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'POST' && pathname === '/api/bots/status') {
    const body = await readBody(req)
    const error = validateBotStatus(body)
    if (error) return badRequest(res, error)
    const bot = store.upsertBotStatus(body)
    return sendJson(res, 200, { ok: true, nextPollMs: 3000, bot: summarizeBot(bot) })
  }

  let params = matchPath(pathname, '/api/bots/:botName/commands')
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

  if (req.method === 'GET' && pathname === '/api/dashboard/bots') {
    return sendJson(res, 200, { items: store.listBots().map(summarizeBot) })
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
    return sendJson(res, 201, { items })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/commands/stop-all') {
    const body = await readBody(req)
    const botNames = store.listBots().map((item) => item.botName)
    const items = store.createCommandsForBots(botNames, 'stop', { reason: body?.reason || null })
    return sendJson(res, 201, { items })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/start')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    return sendJson(res, 201, { command: store.createCommand({ targetBotName: params.botName, commandType: 'start' }) })
  }

  params = matchPath(pathname, '/api/dashboard/bots/:botName/commands/stop')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    return sendJson(res, 201, {
      command: store.createCommand({
        targetBotName: params.botName,
        commandType: 'stop',
        reason: body?.reason || null
      })
    })
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/files') {
    const body = await readBody(req)
    if (!body?.originalName || !body?.contentBase64) {
      return badRequest(res, 'originalName and contentBase64 are required')
    }
    const item = store.createFileUpload(body)
    return sendJson(res, 201, { item })
  }

  params = matchPath(pathname, '/api/dashboard/files/:fileId/assign')
  if (params) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readBody(req)
    if (!body?.targetBotName) return badRequest(res, 'targetBotName is required')
    const item = store.assignFile(params.fileId, body.targetBotName)
    if (!item) return notFound(res)
    return sendJson(res, 200, { item })
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
})