const test = require('node:test')
const assert = require('node:assert/strict')
const { isTargetStatusFresh, shouldEatAtStation } = require('../src/nerv-printer/delivery/mission')

test('delivery target readiness requires a heartbeat no older than 20 seconds', () => {
  const now = Date.parse('2026-06-13T04:30:00.000Z')
  assert.equal(isTargetStatusFresh('2026-06-13T04:29:41.000Z', 20000, now), true)
  assert.equal(isTargetStatusFresh('2026-06-13T04:29:39.000Z', 20000, now), false)
  assert.equal(isTargetStatusFresh(null, 20000, now), false)
})

test('delivery station food check triggers at health or hunger 12 and below', () => {
  const station = { anchor: { x: 21, y: 86, z: -854 }, radius: 25, yTolerance: 16 }
  const position = { x: 17, y: 86, z: -852 }

  assert.equal(shouldEatAtStation({ position, station, health: 12, hunger: 19 }), true)
  assert.equal(shouldEatAtStation({ position, station, health: 20, hunger: 12 }), true)
  assert.equal(shouldEatAtStation({ position, station, health: 13, hunger: 13 }), false)
  assert.equal(shouldEatAtStation({ position, station, health: 12, hunger: 20 }), false)
  assert.equal(shouldEatAtStation({ position: { x: 100, y: 86, z: -852 }, station, health: 5, hunger: 5 }), false)
})
