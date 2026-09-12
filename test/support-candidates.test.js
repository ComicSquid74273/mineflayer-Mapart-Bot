'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const {
  normalizeSupportCandidates,
  prioritizeSupportCandidates,
  summarizeRequiredStockAttempts,
  trySupportCandidates
} = require('../src/nerv-printer/support-candidates')

const primary = {
  blockPos: { x: -624, y: -7, z: -966 },
  openPos: { x: -624, y: -8, z: -962 }
}
const fallback = {
  position: { x: -638, y: -9, z: -964 },
  accessPosition: { x: -637, y: -8, z: -962 }
}

test('plural support candidates stay ordered and append singular fallback once', () => {
  assert.deepEqual(
    normalizeSupportCandidates([primary, fallback], fallback),
    [
      { enabled: true, position: primary.blockPos, accessPosition: primary.openPos },
      { enabled: true, position: fallback.position, accessPosition: fallback.accessPosition }
    ]
  )
})

test('singular-only support configuration remains compatible', () => {
  assert.deepEqual(normalizeSupportCandidates(fallback), [
    { enabled: true, position: fallback.position, accessPosition: fallback.accessPosition }
  ])
})

test('successful source is prioritized for returning unused stock', () => {
  const candidates = normalizeSupportCandidates(primary, fallback)
  assert.deepEqual(prioritizeSupportCandidates(candidates, fallback), [
    candidates[1],
    candidates[0]
  ])
})

test('ordered attempts fall back after a confirmed empty primary', async () => {
  const visited = []
  const result = await trySupportCandidates([primary, fallback], async (_candidate, index) => {
    visited.push(index)
    if (index === 0) return { ready: false, verified: true, shortage: true }
    return { ready: true, verified: true, shortage: false, value: 'fallback-stock' }
  })

  assert.deepEqual(visited, [0, 1])
  assert.equal(result.ready, true)
  assert.equal(result.fallback, true)
  assert.equal(result.value, 'fallback-stock')
})

test('ordered attempts fall back after an unavailable primary', async () => {
  const result = await trySupportCandidates([primary, fallback], async (_candidate, index) => {
    if (index === 0) throw new Error('primary unavailable')
    return { ready: true, verified: true, shortage: false }
  })

  assert.equal(result.ready, true)
  assert.equal(result.candidateIndex, 1)
  assert.match(result.attempts[0].error, /primary unavailable/)
})

test('a verified empty candidate keeps refill polling active when another candidate is unavailable', () => {
  const confirmed = summarizeRequiredStockAttempts([
    { verified: true, shortage: true },
    { verified: true, shortage: true }
  ], 'food')
  const mixed = summarizeRequiredStockAttempts([
    { verified: true, shortage: true },
    { verified: false, shortage: false, error: 'fallback could not open' }
  ], 'food')

  assert.equal(confirmed.shortage, true)
  assert.equal(confirmed.verified, true)
  assert.equal(confirmed.degraded, false)
  assert.equal(mixed.shortage, true)
  assert.equal(mixed.verified, true)
  assert.equal(mixed.degraded, true)
  assert.match(mixed.error, /fallback could not open/)
})

test('below-minimum anvil candidate falls back to the next pillar', async () => {
  const pillarCounts = [2, 5]
  const result = await trySupportCandidates([primary, fallback], async (_candidate, index) => {
    if (pillarCounts[index] < 3) {
      return { ready: false, verified: true, shortage: true, error: 'pillar below minimum' }
    }
    return { ready: true, verified: true, shortage: false }
  })

  assert.equal(result.ready, true)
  assert.equal(result.candidateIndex, 1)
})

test('active legacy layout contains only relative primary support coordinates', () => {
  const configPath = path.join(__dirname, '..', 'nerv-printer-config', '_configs', 'legacy-nerv-carpet-printer-config.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

  assert.deepEqual(config.foodChests[0], primary)
  assert.deepEqual(config.anvils[0], {
    blockPos: { x: -620, y: -8, z: -965 },
    openPos: { x: -620, y: -8, z: -962 }
  })
  assert.deepEqual(config.xpBottleChests[0], {
    blockPos: { x: -616, y: -7, z: -966 },
    openPos: { x: -616, y: -8, z: -962 }
  })
  assert.equal(config.foodChests.length, 1)
  assert.equal(config.xpBottleChests.length, 1)
  assert.equal(config.anvils.length, 1)
  assert.equal(Object.hasOwn(config, 'foodChest'), false)
  assert.equal(Object.hasOwn(config, 'anvil'), false)

  for (const value of JSON.stringify({
    foodChests: config.foodChests,
    anvils: config.anvils,
    xpBottleChests: config.xpBottleChests
  }).match(/-?\d+(?:\.\d+)?/g).map(Number)) {
    assert.ok(Math.abs(value) < 10000)
  }
})
