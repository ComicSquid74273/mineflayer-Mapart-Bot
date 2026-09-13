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

test('direct machine route obstruction holds queue ownership for the same bot to resume', () => {
  const { store } = makeStore()
  const file = createQueueFile(store, 'route-obstructed.nbt')

  store.claimNextQueueFile('node-a', 'bot-a')
  const failed = store.completeQueueFileDelivery(
    'node-a',
    'bot-a',
    file.fileId,
    'failed',
    'direct-machine-route-hitbox-obstructed netherite_block at 1,2,3'
  )

  assert.equal(failed.queueStatus, 'held')
  assert.equal(failed.deliveryStatus, 'held')
  assert.equal(failed.claimedByBotName, 'bot-a')
  assert.equal(store.claimNextQueueFile('node-a', 'bot-b'), null)
})

test('active queue identity is recovered only by exact owner, local name, and sha256', () => {
  const { store } = makeStore()
  const file = createQueueFile(store, 'recover-exact.nbt')
  store.claimNextQueueFile('node-a', 'bot-a')
  store.completeQueueFileDelivery('node-a', 'bot-a', file.fileId, 'printing', null, {
    localFileName: 'recover-exact.nbt',
    localPath: '/srv/bot-a/recover-exact.nbt'
  })

  assert.equal(store.recoverActiveQueueFile('node-a', 'bot-a', {
    localFileName: 'recover-exact.nbt',
    localPath: '/srv/bot-a/recover-exact.nbt',
    sha256: 'wrong-sha'
  }), null)

  const recovered = store.recoverActiveQueueFile('node-a', 'bot-a', {
    localFileName: 'recover-exact.nbt',
    localPath: '/srv/bot-a/recover-exact.nbt',
    sha256: file.sha256
  })
  assert.equal(recovered.fileId, file.fileId)
  assert.equal(recovered.queueStatus, 'printing')
  assert.equal(recovered.claimedByBotName, 'bot-a')
})

test('node list exposes latest runtime metrics from bot heartbeat', () => {
  const { store } = makeStore()

  store.upsertBotStatus({
    botName: 'node-a-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'idle',
    runtimeMetrics: {
      cpuPercent: 12.4,
      rssBytes: 412 * 1024 * 1024,
      heapUsedBytes: 84 * 1024 * 1024,
      heapTotalBytes: 132 * 1024 * 1024,
      uptimeSeconds: 45
    }
  })

  const node = store.listNodes().find((item) => item.hostLabel === 'node-a')
  assert.ok(node)
  assert.deepEqual(node.runtimeMetrics, {
    cpuPercent: 12.4,
    rssBytes: 412 * 1024 * 1024,
    heapUsedBytes: 84 * 1024 * 1024,
    heapTotalBytes: 132 * 1024 * 1024,
    uptimeSeconds: 45
  })
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

test('permanent unprintable NBT failures become failed-final immediately on first attempt', () => {
  const { store } = makeStore()
  const file = createQueueFile(store, 'no-carpets.nbt', { maxAttempts: 3 })

  store.claimNextQueueFile('node-a', 'bot-a')
  const failed = store.completeQueueFileDelivery('node-a', 'bot-a', file.fileId, 'failed', 'MULTI_EMPTY_TARGETS: the master produced no printable carpet targets')
  assert.equal(failed.queueStatus, 'failed-final')
  assert.equal(failed.deliveryStatus, 'failed')
  assert.equal(failed.attemptCount, 3)

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

test('node current run survives process restart without counting restart gap', () => {
  const { dir, store } = makeStore()
  const startedAt = new Date(Date.now() - 180 * 1000).toISOString()
  const firstSeenAt = new Date(Date.now() - 160 * 1000).toISOString()

  store.upsertBotStatus({
    botName: 'restart-run-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'printing',
    currentNbt: 'restart-run.nbt',
    currentNbtStartedAt: startedAt,
    progress: { percent: 25 },
    lastStatusAt: firstSeenAt
  })

  const statsPath = path.join(dir, 'node-stats.json')
  const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'))
  stats['node-a'].activeRun.segmentStartedAt = new Date(Date.now() - 180 * 1000).toISOString()
  stats['node-a'].activeRun.segmentLastSeenAt = new Date(Date.now() - 150 * 1000).toISOString()
  stats['node-a'].activeRun.accumulatedActiveMs = 30000
  fs.writeFileSync(statsPath, JSON.stringify(stats), 'utf8')
  store.invalidateDataFileCache([statsPath])

  const restartedStore = createStore(dir)
  restartedStore.upsertBotStatus({
    botName: 'restart-run-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'printing',
    runtimeInstanceId: 'process-b',
    currentNbt: 'restart-run.nbt',
    currentNbtStartedAt: new Date().toISOString(),
    progress: { percent: 30 }
  })

  const activeRun = restartedStore.listNodes().find((item) => item.hostLabel === 'node-a')?.timing?.activeRun
  assert.equal(activeRun?.fileName, 'restart-run.nbt')
  assert.ok(Number(activeRun?.accumulatedActiveMs || 0) < 120000)
  assert.ok(Number(activeRun?.elapsedMs || 0) < 120000)
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

test('existing queued ZIP uploads backfill upload history on store startup', () => {
  const { dir, store } = makeStore()
  createQueueFile(store, 'direct-before-migration.nbt')
  const zipEntryA = store.createFileUpload({
    originalName: 'zip-a.nbt',
    contentBuffer: Buffer.from('zip-a'),
    queueMode: true,
    batchId: 'legacy-batch',
    source: 'zip:legacy-pack.zip',
    uploadedBy: 'test'
  })
  const zipEntryB = store.createFileUpload({
    originalName: 'zip-b.nbt',
    contentBuffer: Buffer.from('zip-b'),
    queueMode: true,
    batchId: 'legacy-batch',
    source: 'zip:legacy-pack.zip',
    uploadedBy: 'test'
  })
  fs.writeFileSync(path.join(dir, 'upload-history.json'), '[]', 'utf8')
  store.invalidateDataFileCache(path.join(dir, 'upload-history.json'))

  const restartedStore = createStore(dir)
  const history = restartedStore.listUploadHistory(0)
  const directHistory = history.find((item) => item.originalName === 'direct-before-migration.nbt')
  const zipHistory = history.find((item) => item.originalName === 'legacy-pack.zip')

  assert.equal(directHistory, undefined)
  assert.equal(history.length, 1)
  assert.equal(zipHistory?.kind, 'zip')
  assert.equal(zipHistory?.queuedCount, 2)
  assert.equal(zipHistory?.extractedCount, 2)
  assert.deepEqual(zipHistory?.queuedFileIds.sort(), [zipEntryA.fileId, zipEntryB.fileId].sort())
  assert.deepEqual(zipHistory?.extractedNames.sort(), ['zip-a.nbt', 'zip-b.nbt'])
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

test('fleet home platform includes offline bots and stays single while pending or claimed', () => {
  const { store } = makeStore()
  registerNode(store, 'node-a', 'bot-a')
  store.upsertBotStatus({
    botName: 'bot-b',
    hostLabel: 'node-b',
    online: false,
    phase: 'offline'
  })

  const fleetCommands = store.createCommandsForBots(store.listBots().map((bot) => bot.botName), 'home-platform', {
    message: '/home platform',
    requestedBy: 'test'
  })
  const first = fleetCommands.find((item) => item.targetBotName === 'bot-a')
  const duplicatePending = store.createCommand({
    targetBotName: 'bot-a',
    commandType: 'home-platform',
    message: '/home platform',
    requestedBy: 'test-again'
  })
  store.claimCommand('bot-a', first.commandId)
  const duplicateClaimed = store.createCommand({
    targetBotName: 'bot-a',
    commandType: 'home-platform',
    message: '/home platform',
    requestedBy: 'test-third'
  })

  assert.deepEqual(fleetCommands.map((item) => item.targetBotName), ['bot-a', 'bot-b'])
  assert.equal(duplicatePending.commandId, first.commandId)
  assert.equal(duplicateClaimed.commandId, first.commandId)
  assert.equal(store.listCommands((item) => item.targetBotName === 'bot-a' && item.commandType === 'home-platform').length, 1)
})

test('delivery targets require fresh online platform status', () => {
  const { dir, store } = makeStore()

  store.upsertBotStatus({
    botName: 'printer-a',
    runtime: 'nerv-printer',
    hostLabel: 'node-a',
    online: true,
    role: 'single',
    phase: 'idle',
    location: 'platform',
    locationDetail: 'platform',
    platformAnchor: { x: 10, y: 64, z: 20 }
  })

  let target = store.listDeliveryTargets().find((item) => item.botName === 'printer-a')
  assert.ok(target)
  assert.equal(target.online, true)
  assert.equal(target.platformReady, true)
  assert.equal(target.readiness, 'ready')

  store.upsertBotStatus({
    botName: 'printer-a',
    runtime: 'nerv-printer',
    hostLabel: 'node-a',
    online: true,
    role: 'single',
    phase: 'idle',
    location: 'lobby',
    locationDetail: 'lobby-1',
    platformAnchor: { x: 10, y: 64, z: 20 }
  })

  target = store.listDeliveryTargets().find((item) => item.botName === 'printer-a')
  assert.equal(target.online, true)
  assert.equal(target.platformReady, false)
  assert.equal(target.readiness, 'notready')

  const botsFile = path.join(dir, 'bots.json')
  const bots = JSON.parse(fs.readFileSync(botsFile, 'utf8'))
  bots['printer-a'].serverStatusAt = '2000-01-01T00:00:00.000Z'
  bots['printer-a'].lastStatusAt = '2000-01-01T00:00:00.000Z'
  fs.writeFileSync(botsFile, JSON.stringify(bots), 'utf8')
  store.invalidateDataFileCache(botsFile)

  target = store.listDeliveryTargets().find((item) => item.botName === 'printer-a')
  assert.equal(target.online, false)
  assert.equal(target.platformReady, false)
  assert.equal(target.readiness, 'offline')
})

test('delivery station anchor-only update preserves the remaining station settings', () => {
  const { store } = makeStore()

  store.updateDeliveryStation({
    anchor: { x: 21, y: 86, z: -854 },
    radius: 31,
    homeName: 'delivery-home',
    bundlesChest: { x: 16, y: 87, z: -854 }
  })
  const station = store.updateDeliveryStation({ anchor: { x: 100, y: 70, z: 200 } })

  assert.deepEqual(station.anchor, { x: 100, y: 70, z: 200 })
  assert.equal(station.radius, 31)
  assert.equal(station.homeName, 'delivery-home')
  assert.deepEqual(station.bundlesChest, { x: 16, y: 87, z: -854 })
})

test('node list exposes the actual connected hostname from fresh bot heartbeats', () => {
  const { store } = makeStore()

  const stored = store.upsertBotStatus({
    botName: 'node-a-bot',
    hostLabel: 'node-a',
    online: true,
    phase: 'idle',
    connectedHost: 'alt3.6b6t.org'
  })

  assert.equal(stored.connectedHost, 'alt3.6b6t.org')
  const node = store.listNodes().find((item) => item.hostLabel === 'node-a')
  assert.ok(node)
  assert.equal(node.connectedHost, 'alt3.6b6t.org')
  assert.deepEqual(node.connectedHosts, ['alt3.6b6t.org'])
})

test('slave runtime cannot claim or complete dashboard NBT work or node commands', () => {
  const { store } = makeStore()
  store.upsertBotStatus({
    botName: 'VulcanB001',
    hostLabel: 'bot01',
    online: true,
    role: 'master',
    phase: 'idle'
  })
  store.upsertBotStatus({
    botName: 'VulcanB010',
    hostLabel: 'bot01',
    online: true,
    role: 'slave',
    phase: 'idle'
  })

  const queued = createQueueFile(store, 'master-owned.nbt', { targetHostLabel: 'bot01' })
  assert.deepEqual(store.claimNextQueueFiles('bot01', 'VulcanB010', 10), [])
  const masterClaim = store.claimNextQueueFile('bot01', 'VulcanB001')
  assert.equal(masterClaim.fileId, queued.fileId)
  assert.equal(store.completeQueueFileDelivery('bot01', 'VulcanB010', queued.fileId, 'completed'), null)
  assert.equal(store.completeQueueFileDelivery('bot01', 'VulcanB001', queued.fileId, 'completed').queueStatus, 'completed')

  const assigned = store.createFileUpload({
    originalName: 'direct-master-owned.nbt',
    contentBuffer: Buffer.from('fake-nbt'),
    targetBotName: 'VulcanB001',
    uploadedBy: 'test'
  })
  assert.equal(store.getNextAssignedFile('VulcanB010'), null)
  assert.equal(store.completeFileDelivery('VulcanB010', assigned.fileId, 'placed'), null)

  const command = store.createCommand({
    targetHostLabel: 'bot01',
    commandType: 'upload-node-file',
    requestedBy: 'test'
  })
  assert.equal(store.claimNextNodeCommand('bot01', 'VulcanB010'), null)
  assert.equal(store.claimNextNodeCommand('bot01', 'VulcanB001').commandId, command.commandId)
  assert.equal(store.completeNodeCommand('bot01', command.commandId, 'succeeded', null, 'VulcanB010'), null)
})

test('slave status ignores local queue reconciliation and strips node inventory', () => {
  const { dir, store } = makeStore()
  const file = createQueueFile(store, 'reconcile-test.nbt', { targetHostLabel: 'bot01' })

  // Master status with local node file updates inventory and queue
  store.upsertBotStatus({
    botName: 'VulcanB001',
    hostLabel: 'bot01',
    online: true,
    role: 'master',
    currentNbt: 'reconcile-test.nbt',
    nodeFiles: [{ fileName: 'reconcile-test.nbt' }],
    finishedMapFiles: [],
    finishedMapCount: 0
  })
  let node = store.listNodes().find((n) => n.hostLabel === 'bot01')
  assert.ok(node)
  assert.equal(node.nodeFiles.length, 1)

  // Slave status with nodeFiles payload is ignored and stripped
  store.upsertBotStatus({
    botName: 'VulcanB010',
    hostLabel: 'bot01',
    online: true,
    role: 'slave',
    currentNbt: 'reconcile-test.nbt',
    nodeFiles: [{ fileName: 'reconcile-test.nbt' }],
    finishedMapFiles: [],
    finishedMapCount: 0
  })
  const inventory = JSON.parse(fs.readFileSync(path.join(dir, 'node-inventory.json'), 'utf8'))
  assert.equal(inventory['VulcanB010'], undefined)
  const unchangedFile = store.getFile(file.fileId)
  assert.equal(unchangedFile.queueStatus, 'held')
  assert.equal(unchangedFile.claimedByBotName, 'VulcanB001')
})

test('slave cannot complete node file or queue file delivery through store', () => {
  const { store } = makeStore()
  store.upsertBotStatus({ botName: 'VulcanB001', hostLabel: 'bot01', online: true, role: 'master', phase: 'idle' })
  store.upsertBotStatus({ botName: 'VulcanB010', hostLabel: 'bot01', online: true, role: 'slave', phase: 'idle' })

  // Create an assigned file for the master
  const assigned = store.createFileUpload({
    originalName: 'test.nbt',
    contentBuffer: Buffer.from('data'),
    targetBotName: 'VulcanB001',
    uploadedBy: 'test'
  })

  // Slave cannot get next assigned file
  assert.equal(store.getNextAssignedFile('VulcanB010'), null)

  // Slave cannot complete file delivery
  assert.equal(store.completeFileDelivery('VulcanB010', assigned.fileId, 'placed'), null)

  // Slave cannot complete node file delivery
  assert.equal(store.completeNodeFileDelivery('bot01', assigned.fileId, 'placed', null, 'VulcanB010'), null)

  // Master can complete it
  assert.ok(store.completeFileDelivery('VulcanB001', assigned.fileId, 'placed'))
})
