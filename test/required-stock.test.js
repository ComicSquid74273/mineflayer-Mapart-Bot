'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  requiredStockAlertCategory,
  requiredStockStatusDetail,
  waitForRequiredStock
} = require('../src/nerv-printer/required-stock')

test('required stock identifiers are stable and resource-specific', () => {
  assert.equal(requiredStockAlertCategory('Map + Pane'), 'required-stock-map-pane')
  assert.equal(requiredStockStatusDetail('XP Bottle'), 'waiting-xp-bottle-stock')
})

test('confirmed empty stock holds the same step until a refill is observed', async () => {
  let nowMs = 1000
  let attempts = 0
  const shortages = []
  const recovered = []
  const result = await waitForRequiredStock({
    retryMs: 500,
    waitSliceMs: 100,
    now: () => nowMs,
    sleep: async (durationMs) => { nowMs += durationMs },
    attempt: async () => {
      attempts += 1
      return attempts < 3
        ? { ready: false, shortage: true, verified: true, count: 0 }
        : { ready: true, shortage: false, verified: true, count: 64 }
    },
    onShortage: async (context) => shortages.push(context.firstHoldObservation),
    onRecovered: async (context) => recovered.push(context.waitedMs)
  })

  assert.equal(result.ready, true)
  assert.equal(result.attempts, 3)
  assert.deepEqual(shortages, [true, false])
  assert.deepEqual(recovered, [1000])
})

test('unverified or operational failures are not disguised as stock holds', async () => {
  let sleeps = 0
  const result = await waitForRequiredStock({
    attempt: async () => ({ ready: false, shortage: false, verified: false, error: 'window snapshot missing' }),
    sleep: async () => { sleeps += 1 }
  })

  assert.equal(result.ready, false)
  assert.equal(result.operationalFailure, true)
  assert.equal(result.attempts, 1)
  assert.equal(sleeps, 0)
})

test('a technical failure after a verified shortage exits refill polling', async () => {
  let nowMs = 1000
  let attempts = 0
  const result = await waitForRequiredStock({
    retryMs: 500,
    waitSliceMs: 100,
    now: () => nowMs,
    sleep: async (durationMs) => { nowMs += durationMs },
    attempt: async () => {
      attempts += 1
      return attempts === 1
        ? { ready: false, shortage: true, verified: true }
        : { ready: false, shortage: false, verified: false, error: 'window snapshot missing' }
    }
  })

  assert.equal(result.ready, false)
  assert.equal(result.operationalFailure, true)
  assert.equal(result.attempts, 2)
  assert.equal(result.waitedMs, 500)
})

test('stock hold wait remains interruptible between retry slices', async () => {
  let checks = 0
  await assert.rejects(
    waitForRequiredStock({
      retryMs: 1000,
      waitSliceMs: 100,
      attempt: async () => ({ ready: false, shortage: true, verified: true }),
      assertContinue: () => {
        checks += 1
        if (checks >= 4) throw new Error('stop requested')
      },
      sleep: async () => {}
    }),
    /stop requested/
  )
})
