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
