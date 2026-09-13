const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-dashboard-server-'))
process.env.DASHBOARD_DATA_DIR = dataDir
process.env.DASHBOARD_CONFIG_DIR = path.join(dataDir, 'config')
process.env.DASHBOARD_NBT_DIR = path.join(dataDir, 'nbt')
process.env.DASHBOARD_LOGS_DIR = path.join(dataDir, 'logs')
process.env.DASHBOARD_DELIVERY_RUNTIME_DIR = path.join(dataDir, 'delivery')
process.env.DASHBOARD_HOST = '127.0.0.1'
process.env.DASHBOARD_PORT = '0'
process.env.DASHBOARD_SESSION_SECRET = 'dashboard-route-test-secret'

const { createDashboardServer, store } = require('../src/server')

let server
let baseUrl

function registerBot(botName, hostLabel, role) {
  store.upsertBotStatus({
    botName,
    hostLabel,
    online: true,
    role,
    phase: 'idle'
  })
}

function createNbt(name, options = {}) {
  return store.createFileUpload({
    originalName: name,
    contentBuffer: Buffer.from(`fake-nbt:${name}`),
    targetBotName: options.targetBotName || null,
    targetHostLabel: options.targetHostLabel || null,
    queueMode: options.queueMode === true,
    uploadedBy: 'test'
  })
}

async function request(relativePath, options = {}) {
  const response = await fetch(`${baseUrl}${relativePath}`, options)
  const contentType = String(response.headers.get('content-type') || '')
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.arrayBuffer()
  return { response, body }
}

function jsonRequest(relativePath, body) {
  return request(relativePath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

test.before(async () => {
  server = createDashboardServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('bots receive player join messages only when the version changes', async () => {
  const item = store.updatePlayerJoinMessages({ fileName: 'messages.csv', messages: ['hello'] })
  let result = await request('/api/bots/master-a/player-join-messages?version=0')
  assert.equal(result.response.status, 200)
  assert.equal(result.body.version, item.version)
  assert.deepEqual(result.body.messages, ['hello'])

  result = await request(`/api/bots/master-a/player-join-messages?version=${item.version}`)
  assert.equal(result.response.status, 304)
})

test('dashboard advertising controls persist desired state and queue live bot commands', async () => {
  registerBot('advertising-bot', 'node-advertising', 'single')
  const operator = store.listOperatorCredentials().find((item) => item.role === 'admin' || item.role === 'operator')
  const login = await jsonRequest('/api/dashboard/auth/login', { username: operator.username, password: operator.password })
  const cookie = String(login.response.headers.get('set-cookie') || '').split(';')[0]
  assert.equal(login.response.status, 200)

  let result = await request('/api/dashboard/bots/advertising-bot/advertising/start', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}'
  })
  assert.equal(result.response.status, 201)
  assert.equal(store.getBotAdvertisingState('advertising-bot').enabled, true)
  assert.equal(result.body.command.commandType, 'advertising-start')

  result = await request('/api/dashboard/bots/advertising-bot/advertising/stop', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}'
  })
  assert.equal(result.response.status, 201)
  assert.equal(store.getBotAdvertisingState('advertising-bot').enabled, false)
  assert.equal(result.body.command.commandType, 'advertising-stop')
})

test('dashboard NBT downloads require the owning controller and exact host', async () => {
  registerBot('master-a', 'node-a', 'master')
  registerBot('slave-a', 'node-a', 'slave')
  registerBot('master-peer', 'node-a', 'master')
  registerBot('master-b', 'node-b', 'master')

  const assigned = createNbt('assigned.nbt', { targetBotName: 'master-a' })
  let result = await request(`/api/files/${assigned.fileId}/download?botName=master-a&hostLabel=node-a`)
  assert.equal(result.response.status, 200)

  const nodeFile = createNbt('node-claimed.nbt', { targetHostLabel: 'node-a' })
  const nodeClaim = store.claimNextNodeFile('node-a', 'master-a')
  assert.equal(nodeClaim.fileId, nodeFile.fileId)
  assert.equal(nodeClaim.claimedByHostLabel, 'node-a')
  result = await request(`/api/files/${nodeFile.fileId}/download?botName=master-a&hostLabel=node-a`)
  assert.equal(result.response.status, 200)

  const queueFile = createNbt('queue-claimed.nbt', { targetHostLabel: 'node-a', queueMode: true })
  const queueClaim = store.claimNextQueueFile('node-a', 'master-a')
  assert.equal(queueClaim.fileId, queueFile.fileId)
  result = await request(`/api/files/${queueFile.fileId}/download?botName=master-a&hostLabel=node-a`)
  assert.equal(result.response.status, 200)

  result = await jsonRequest('/api/nodes/node-a/queue/recover-active', {
    botName: 'slave-a',
    localFileName: 'queue-claimed.nbt',
    localPath: '/srv/master-a/queue-claimed.nbt',
    sha256: queueFile.sha256
  })
  assert.equal(result.response.status, 403)
  result = await jsonRequest('/api/nodes/node-a/queue/recover-active', {
    botName: 'master-peer',
    localFileName: 'queue-claimed.nbt',
    localPath: '/srv/master-a/queue-claimed.nbt',
    sha256: queueFile.sha256
  })
  assert.equal(result.response.status, 404)
  result = await jsonRequest('/api/nodes/node-a/queue/recover-active', {
    botName: 'master-a',
    localFileName: 'queue-claimed.nbt',
    localPath: '/srv/master-a/queue-claimed.nbt',
    sha256: 'wrong-sha'
  })
  assert.equal(result.response.status, 404)
  result = await jsonRequest('/api/nodes/node-a/queue/recover-active', {
    botName: 'master-a',
    localFileName: 'queue-claimed.nbt',
    localPath: '/srv/master-a/queue-claimed.nbt',
    sha256: queueFile.sha256
  })
  assert.equal(result.response.status, 200)
  assert.equal(result.body.item.fileId, queueFile.fileId)

  result = await request(`/api/files/${queueFile.fileId}/download?botName=slave-a&hostLabel=node-a`)
  assert.equal(result.response.status, 403)
  result = await request(`/api/files/${queueFile.fileId}/download?botName=master-peer&hostLabel=node-a`)
  assert.equal(result.response.status, 403)
  result = await request(`/api/files/${queueFile.fileId}/download?botName=master-a&hostLabel=node-b`)
  assert.equal(result.response.status, 403)
  result = await request(`/api/files/${queueFile.fileId}/download?botName=master-b&hostLabel=node-b`)
  assert.equal(result.response.status, 403)
  result = await request(`/api/files/${queueFile.fileId}/download?hostLabel=node-a`)
  assert.equal(result.response.status, 400)
  result = await request(`/api/files/${queueFile.fileId}/download?botName=master-a`)
  assert.equal(result.response.status, 400)
})

test('node command, log, and config results require the claimed controller identity', async () => {
  const command = store.createCommand({
    targetHostLabel: 'node-a',
    commandType: 'delete-node-file',
    requestedBy: 'test'
  })
  assert.equal(store.claimNextNodeCommand('node-a', 'master-a').commandId, command.commandId)

  let result = await jsonRequest(`/api/nodes/node-a/commands/${command.commandId}/result`, {
    status: 'succeeded'
  })
  assert.equal(result.response.status, 400)
  result = await jsonRequest(`/api/nodes/node-a/commands/${command.commandId}/result`, {
    botName: 'slave-a',
    status: 'succeeded'
  })
  assert.equal(result.response.status, 403)
  result = await jsonRequest(`/api/nodes/node-a/commands/${command.commandId}/result`, {
    botName: 'master-peer',
    status: 'succeeded'
  })
  assert.equal(result.response.status, 403)
  result = await jsonRequest(`/api/nodes/node-b/commands/${command.commandId}/result`, {
    botName: 'master-a',
    status: 'succeeded'
  })
  assert.equal(result.response.status, 403)
  result = await jsonRequest(`/api/nodes/node-a/commands/${command.commandId}/result`, {
    botName: 'master-a',
    status: 'succeeded'
  })
  assert.equal(result.response.status, 200)

  const logCommand = store.createCommand({
    targetHostLabel: 'node-a',
    commandType: 'download-node-log',
    requestedBy: 'test'
  })
  assert.equal(store.claimNextNodeCommand('node-a', 'master-a').commandId, logCommand.commandId)
  result = await jsonRequest(`/api/nodes/node-a/logs/${logCommand.commandId}/result`, {
    botName: 'master-peer',
    fileName: 'runtime.log',
    contentBase64: Buffer.from('log').toString('base64')
  })
  assert.equal(result.response.status, 403)
  result = await jsonRequest(`/api/nodes/node-a/logs/${logCommand.commandId}/result`, {
    botName: 'master-a',
    fileName: 'runtime.log',
    contentBase64: Buffer.from('log').toString('base64')
  })
  assert.equal(result.response.status, 200)
  assert.equal(store.getNodeLogDownload(logCommand.commandId).botName, 'master-a')
  store.completeNodeCommand('node-a', logCommand.commandId, 'succeeded', null, 'master-a')

  const configCommand = store.createCommand({
    targetHostLabel: 'node-a',
    commandType: 'download-node-config',
    requestedBy: 'test'
  })
  assert.equal(store.claimNextNodeCommand('node-a', 'master-a').commandId, configCommand.commandId)
  result = await jsonRequest(`/api/nodes/node-a/config/${configCommand.commandId}/result`, {
    fileName: 'runtime.json',
    contentBase64: Buffer.from('{}').toString('base64')
  })
  assert.equal(result.response.status, 400)
  result = await jsonRequest(`/api/nodes/node-a/config/${configCommand.commandId}/result`, {
    botName: 'master-a',
    fileName: 'runtime.json',
    contentBase64: Buffer.from('{}').toString('base64')
  })
  assert.equal(result.response.status, 200)
  assert.equal(store.getNodeLogDownload(configCommand.commandId).botName, 'master-a')
})
