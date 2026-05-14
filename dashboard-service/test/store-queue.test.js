const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createStore } = require('../src/store')

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-dashboard-store-'))
  return { dir, store: createStore(dir) }
}

function createQueueFile(store, name, options = {}) {
  return store.createFileUpload({
    originalName: name,
    contentBuffer: Buffer.from(`fake-nbt:${name}`),
    queueMode: true,
    maxAttempts: options.maxAttempts || 3,
    targetHostLabel: options.targetHostLabel || null,
    targetBotName: options.targetBotName || null,
    uploadedBy: 'test'
  })
}

function registerNode(store, hostLabel, botName = `${hostLabel}-bot`) {
  store.upsertBotStatus({
    botName,
    hostLabel,
    online: true,
    phase: 'idle'
  })
}

function upsertRuntimeBot(store, overrides = {}) {
  const startedAt = overrides.currentNbtStartedAt || new Date(Date.now() - 31 * 60 * 1000).toISOString()
  return store.upsertBotStatus({
    botName: 'runtime-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'printing',
    location: 'platform',
    locationDetail: 'platform',
    reconnectState: 'idle',
    currentNbt: 'runtime-test.nbt',
    currentNbtStartedAt: startedAt,
    ...overrides
  })
}

test('failed queue item below maxAttempts returns to pending for auto retry', () => {
  const { store } = makeStore()
  const file = createQueueFile(store, 'below-max.nbt', { maxAttempts: 3 })

  const claimed = store.claimNextQueueFile('node-a', 'bot-a')
  assert.equal(claimed.fileId, file.fileId)

  const failed = store.completeQueueFileDelivery('node-a', 'bot-a', file.fileId, 'failed', 'parse failed')
  assert.equal(failed.queueStatus, 'pending')
  assert.equal(failed.deliveryStatus, 'failed')
  assert.equal(failed.attemptCount, 1)
  assert.equal(failed.claimedByBotName, 'bot-a')

  const claimedAgain = store.claimNextQueueFile('node-a', 'bot-b')
  assert.equal(claimedAgain.fileId, file.fileId)
  assert.equal(claimedAgain.claimedByBotName, 'bot-b')
})

test('failed queue item at maxAttempts becomes failed-final and is not claimable', () => {
  const { store } = makeStore()
  const file = createQueueFile(store, 'final.nbt', { maxAttempts: 1 })

  store.claimNextQueueFile('node-a', 'bot-a')
  const failed = store.completeQueueFileDelivery('node-a', 'bot-a', file.fileId, 'failed', 'fatal print error')
  assert.equal(failed.queueStatus, 'failed-final')
  assert.equal(failed.attemptCount, 1)

  const claimed = store.claimNextQueueFile('node-a', 'bot-b')
  assert.equal(claimed, null)
})

test('individual retry resets failed-final to pending', () => {
  const { store } = makeStore()
  const file = createQueueFile(store, 'retry-one.nbt', { maxAttempts: 1 })

  store.claimNextQueueFile('node-a', 'bot-a')
  store.completeQueueFileDelivery('node-a', 'bot-a', file.fileId, 'failed', 'fatal')

  const retried = store.retryQueueFile(file.fileId, 'operator fixed inventory')
  assert.equal(retried.queueStatus, 'pending')
  assert.equal(retried.deliveryStatus, 'pending')
  assert.equal(retried.attemptCount, 0)
  assert.equal(retried.claimedByBotName, null)
  assert.equal(retried.retryReason, 'operator fixed inventory')

  const claimed = store.claimNextQueueFile('node-a', 'bot-b')
  assert.equal(claimed.fileId, file.fileId)
})

test('retry all resets failed and failed-final only', () => {
  const { store } = makeStore()
  const retryable = createQueueFile(store, 'retryable.nbt', { maxAttempts: 3, targetBotName: 'bot-a' })
  const final = createQueueFile(store, 'final-retry.nbt', { maxAttempts: 1, targetBotName: 'bot-b' })
  const completed = createQueueFile(store, 'completed.nbt', { targetBotName: 'bot-c' })
  const active = createQueueFile(store, 'active.nbt', { targetBotName: 'bot-d' })

  store.claimNextQueueFile('node-a', 'bot-a')
  store.completeQueueFileDelivery('node-a', 'bot-a', retryable.fileId, 'failed', 'temporary')

  store.claimNextQueueFile('node-a', 'bot-b')
  store.completeQueueFileDelivery('node-a', 'bot-b', final.fileId, 'failed', 'fatal')

  store.claimNextQueueFile('node-a', 'bot-c')
  store.completeQueueFileDelivery('node-a', 'bot-c', completed.fileId, 'completed')

  store.claimNextQueueFile('node-a', 'bot-d')
  store.completeQueueFileDelivery('node-a', 'bot-d', active.fileId, 'printing')

  const result = store.retryFailedQueueFiles('bulk retry')
  assert.equal(result.count, 2)

  const byId = new Map(store.listFiles().map((item) => [item.fileId, item]))
  assert.equal(byId.get(retryable.fileId).queueStatus, 'pending')
  assert.equal(byId.get(final.fileId).queueStatus, 'pending')
  assert.equal(byId.get(completed.fileId).queueStatus, 'completed')
  assert.equal(byId.get(active.fileId).queueStatus, 'printing')
})

test('active downloaded and printing queue items cannot be released or claimed by another bot', () => {
  const { store } = makeStore()
  const downloaded = createQueueFile(store, 'downloaded.nbt')
  const printing = createQueueFile(store, 'printing.nbt')

  store.claimNextQueueFile('node-a', 'bot-a')
  store.completeQueueFileDelivery('node-a', 'bot-a', downloaded.fileId, 'downloaded')
  assert.equal(store.releaseQueueFile(downloaded.fileId, 'operator release'), null)

  store.claimNextQueueFile('node-a', 'bot-a')
  store.completeQueueFileDelivery('node-a', 'bot-a', printing.fileId, 'printing')
  assert.equal(store.releaseQueueFile(printing.fileId, 'operator release'), null)

  const otherBotClaim = store.claimNextQueueFile('node-a', 'bot-b')
  assert.equal(otherBotClaim, null)

  const sameBotRefresh = store.claimNextQueueFile('node-a', 'bot-a')
  assert.equal(sameBotRefresh.fileId, downloaded.fileId)
})

test('batch queue claim can reserve up to ten files when pending count is high enough', () => {
  const { store } = makeStore()
  registerNode(store, 'node-a', 'bot-a')
  for (let index = 0; index < 12; index += 1) {
    createQueueFile(store, `batch-${index}.nbt`)
  }

  const claimed = store.claimNextQueueFiles('node-a', 'bot-a', 10)
  assert.equal(claimed.length, 10)
  assert.deepEqual(new Set(claimed.map((item) => item.claimedByBotName)), new Set(['bot-a']))
  assert.deepEqual(new Set(claimed.map((item) => item.queueStatus)), new Set(['claimed']))
})

test('batch queue claim is capped to one when pending count is below ten per known node', () => {
  const { store } = makeStore()
  registerNode(store, 'node-a', 'bot-a')
  registerNode(store, 'node-b', 'bot-b')
  registerNode(store, 'node-c', 'bot-c')
  for (let index = 0; index < 25; index += 1) {
    createQueueFile(store, `low-${index}.nbt`)
  }

  const policy = store.getQueueBatchPolicy(10)
  assert.equal(policy.knownNodeCount, 3)
  assert.equal(policy.pendingQueueCount, 25)
  assert.equal(policy.threshold, 30)
  assert.equal(policy.batchLimited, true)
  const claimed = store.claimNextQueueFiles('node-a', 'bot-a', 10)
  assert.equal(claimed.length, 1)
})

test('same bot can refresh multiple held queue claims in one batch', () => {
  const { store } = makeStore()
  registerNode(store, 'node-a', 'bot-a')
  for (let index = 0; index < 12; index += 1) {
    createQueueFile(store, `held-${index}.nbt`)
  }

  const firstClaim = store.claimNextQueueFiles('node-a', 'bot-a', 10)
  assert.equal(firstClaim.length, 10)
  const refreshed = store.claimNextQueueFiles('node-a', 'bot-a', 10)
  assert.equal(refreshed.length, 10)
  assert.deepEqual(refreshed.map((item) => item.fileId), firstClaim.map((item) => item.fileId))
})

test('long runtime status does not queue reconnect commands', () => {
  const { store } = makeStore()

  upsertRuntimeBot(store)

  const commands = store.listCommands((item) => item.targetBotName === 'runtime-bot' && item.commandType === 'reconnect')
  assert.equal(commands.length, 0)
})

test('bot reconnect count does not reset when a restarted process reports zero', () => {
  const { store } = makeStore()

  store.upsertBotStatus({
    botName: 'reconnect-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'printing',
    reconnectCount: 4,
    reconnectState: 'idle'
  })

  const refreshed = store.upsertBotStatus({
    botName: 'reconnect-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'idle',
    reconnectCount: 0,
    reconnectState: 'idle'
  })

  assert.equal(refreshed.reconnectCount, 4)
  const node = store.listNodes().find((item) => item.hostLabel === 'node-a')
  assert.equal(node.operationalStats.reconnectCount, 4)
})

test('bot reconnect count increments when a known node process restarts', () => {
  const { store } = makeStore()

  store.upsertBotStatus({
    botName: 'restart-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'idle',
    runtimeInstanceId: 'process-a',
    runtimeStartedAt: '2026-05-14T00:00:00.000Z',
    reconnectCount: 0,
    reconnectState: 'idle'
  })

  const restarted = store.upsertBotStatus({
    botName: 'restart-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'idle',
    runtimeInstanceId: 'process-b',
    runtimeStartedAt: '2026-05-14T01:00:00.000Z',
    reconnectCount: 0,
    reconnectState: 'idle'
  })

  assert.equal(restarted.reconnectCount, 1)
  assert.equal(restarted.nodeRestartCount, 1)
  const repeated = store.upsertBotStatus({
    botName: 'restart-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'idle',
    runtimeInstanceId: 'process-b',
    runtimeStartedAt: '2026-05-14T01:00:00.000Z',
    reconnectCount: 0,
    reconnectState: 'idle'
  })
  assert.equal(repeated.reconnectCount, 1)
  assert.equal(repeated.nodeRestartCount, 1)

  const node = store.listNodes().find((item) => item.hostLabel === 'node-a')
  assert.equal(node.operationalStats.reconnectCount, 1)
})

test('paused current run stays held and stops adding active time', () => {
  const { dir, store } = makeStore()

  store.upsertBotStatus({
    botName: 'pause-run-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'printing',
    currentNbt: 'pause-run.nbt',
    currentNbtStartedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    progress: { percent: 42 }
  })

  const activeBeforePause = store.listNodes().find((item) => item.hostLabel === 'node-a')?.timing?.activeRun
  assert.equal(activeBeforePause?.fileName, 'pause-run.nbt')
  assert.equal(activeBeforePause?.activeBotCount, 1)

  const restartedStore = createStore(dir)
  restartedStore.upsertBotStatus({
    botName: 'pause-run-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'paused',
    activeState: 'paused',
    currentNbt: 'pause-run.nbt',
    currentNbtStartedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    progress: { percent: 42 }
  })

  const activeWhilePaused = restartedStore.listNodes().find((item) => item.hostLabel === 'node-a')?.timing?.activeRun
  assert.equal(activeWhilePaused?.fileName, 'pause-run.nbt')
  assert.equal(activeWhilePaused?.activeBotCount, 0)
  assert.equal(activeWhilePaused?.segmentStartedAt, null)
  assert.ok(Number(activeWhilePaused?.elapsedMs || 0) >= 0)
})

test('reset everything preserves total printed map count', () => {
  const { dir, store } = makeStore()
  const now = new Date().toISOString()
  const botsFile = path.join(dir, 'bots.json')
  const inventoryFile = path.join(dir, 'node-inventory.json')

  fs.writeFileSync(botsFile, JSON.stringify({
    'legacy-bot': {
      botName: 'legacy-bot',
      hostLabel: 'node-a',
      online: true,
      phase: 'idle',
      serverStatusAt: now,
      finishedMapCount: 7,
      finishedMapFiles: [{ fileName: 'old-map.nbt' }],
      nodeInventoryAt: now
    }
  }), 'utf8')
  fs.writeFileSync(inventoryFile, JSON.stringify({
    'legacy-bot': {
      botName: 'legacy-bot',
      hostLabel: 'node-a',
      finishedMapCount: 7,
      finishedMapFiles: [{ fileName: 'old-map.nbt' }],
      nodeInventoryAt: now
    }
  }), 'utf8')
  store.invalidateDataFileCache([botsFile, inventoryFile])

  assert.equal(store.listNodes()[0].finishedMapCount, 7)

  const reset = store.resetDashboardForFreshStart()
  assert.equal(reset.clearedNodeInventories, 1)
  assert.equal(reset.clearedBotInventoryFields, 1)
  const node = store.listNodes()[0]
  assert.equal(node.finishedMapCount, 0)
  assert.equal(node.totalCompletedMapCount, 7)
  assert.equal(node.timing.totalCompletedMaps, 7)
})

test('reset everything preserves upload history list', () => {
  const { store } = makeStore()
  const file = createQueueFile(store, 'queued-before-reset.nbt')
  const history = store.appendUploadHistory({
    originalName: 'batch.zip',
    kind: 'zip',
    sizeBytes: 1234,
    uploadedBy: 'test',
    queuedCount: 1,
    extractedCount: 1,
    queuedFileIds: [file.fileId],
    extractedNames: ['queued-before-reset.nbt']
  })

  const reset = store.resetDashboardForFreshStart()
  assert.equal(reset.clearedQueueFiles, 1)
  assert.equal(store.listFiles().length, 0)

  const remainingHistory = store.listUploadHistory()
  assert.equal(remainingHistory.length, 1)
  assert.equal(remainingHistory[0].uploadId, history.uploadId)
  assert.equal(remainingHistory[0].originalName, 'batch.zip')
  assert.deepEqual(remainingHistory[0].extractedNames, ['queued-before-reset.nbt'])
})

test('pause desired keeps original pause start time across repeated pause commands', () => {
  const { store } = makeStore()

  const first = store.setBotPauseDesired('pause-bot', true, 'first pause')
  const second = store.setBotPauseDesired('pause-bot', true, 'second pause')
  const current = store.getBotPauseState('pause-bot')

  assert.equal(second.pausedAt, first.pausedAt)
  assert.equal(current.pausedAt, first.pausedAt)
  assert.equal(current.reason, 'second pause')
})

test('node home platform action can queue chat for every node bot', () => {
  const { store } = makeStore()
  registerNode(store, 'node-a', 'bot-a')
  registerNode(store, 'node-a', 'bot-b')

  const botNames = store.listBotsForHost('node-a').map((item) => item.botName)
  const commands = store.createCommandsForBots(botNames, 'chat', {
    message: '/home platform',
    requestedBy: 'test'
  })

  assert.equal(commands.length, 2)
  assert.deepEqual(commands.map((item) => item.targetBotName).sort(), ['bot-a', 'bot-b'])
  assert.deepEqual(new Set(commands.map((item) => item.message)), new Set(['/home platform']))
})
