'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { hasActiveRequiredStockAlert, isLongRuntimeStalled } = require('../src/runtime-alerts')

const NOW = Date.parse('2026-08-31T08:30:00.000Z')
const options = {
  now: NOW,
  runtimeDurationMs: 30 * 60 * 1000,
  progressStaleMs: 5 * 60 * 1000
}

function bot(overrides = {}) {
  return {
    online: true,
    phase: 'printing',
    statusDetail: 'waiting-material-restock',
    currentNbt: 'map.nbt',
    currentNbtStartedAt: '2026-08-31T07:45:00.000Z',
    progress: { processed: 8192, total: 16384, updatedAt: '2026-08-31T08:29:30.000Z' },
    ...overrides
  }
}

test('does not call a progressing print stalled merely because it exceeds 30 minutes', () => {
  assert.equal(isLongRuntimeStalled(bot(), options), false)
})

test('does not treat an old checkpoint error as an active block after newer progress', () => {
  assert.equal(isLongRuntimeStalled(bot({
    lastError: 'nerv-workload-checkpoint-timeout-30000ms',
    lastErrorAt: '2026-08-31T08:10:00.000Z',
    progress: { processed: 9728, total: 16384, updatedAt: '2026-08-31T08:29:30.000Z' }
  }), options), false)
})

test('treats an error newer than progress as an active block', () => {
  assert.equal(isLongRuntimeStalled(bot({
    lastError: 'nerv-workload-checkpoint-timeout-30000ms',
    lastErrorAt: '2026-08-31T08:29:45.000Z',
    progress: { processed: 9728, total: 16384, updatedAt: '2026-08-31T08:29:30.000Z' }
  }), options), true)
})

test('alerts when a long job explicitly reports blocked-awaiting-operator', () => {
  assert.equal(isLongRuntimeStalled(bot({
    phase: 'post-print',
    statusDetail: 'blocked-awaiting-operator'
  }), options), true)
})

test('alerts when a long job has made no progress for the stale window', () => {
  assert.equal(isLongRuntimeStalled(bot({
    progress: { processed: 8192, total: 16384, updatedAt: '2026-08-31T08:23:00.000Z' }
  }), options), true)
})

test('does not alert before the total runtime threshold', () => {
  assert.equal(isLongRuntimeStalled(bot({
    currentNbtStartedAt: '2026-08-31T08:05:00.000Z',
    statusDetail: 'blocked-awaiting-operator'
  }), options), false)
})

test('required stock holds use their dedicated alert instead of a duplicate NBT-stalled alert', () => {
  const held = bot({
    phase: 'post-print',
    statusDetail: 'waiting-map-pane-stock',
    progress: { processed: 16384, total: 16384, updatedAt: '2026-08-31T08:00:00.000Z' },
    alerts: [{ category: 'required-stock-map-pane', active: true, level: 'error' }]
  })

  assert.equal(hasActiveRequiredStockAlert(held), true)
  assert.equal(isLongRuntimeStalled(held, options), false)
})

test('resolved required stock alerts no longer suppress genuine stall detection', () => {
  const stalled = bot({
    phase: 'post-print',
    statusDetail: 'postprint-withdraw',
    progress: { processed: 16384, total: 16384, updatedAt: '2026-08-31T08:00:00.000Z' },
    alerts: [{ category: 'required-stock-map-pane', active: false, level: 'error' }]
  })

  assert.equal(hasActiveRequiredStockAlert(stalled), false)
  assert.equal(isLongRuntimeStalled(stalled, options), true)
})
