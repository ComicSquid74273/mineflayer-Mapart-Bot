'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  extendDeadlineForHold,
  inspectFinishedMapChestCapacity
} = require('../src/nerv-printer/finished-map-output')

test('finished-map chest capacity requires an actually empty server slot', () => {
  const container = {
    inventoryStart: 4,
    slots: [{ name: 'filled_map' }, null, { name: 'filled_map' }, null, { name: 'player_item' }]
  }
  const rawOccupied = new Set([1])
  const capacity = inspectFinishedMapChestCapacity(container, (slot) => rawOccupied.has(slot))

  assert.deepEqual(capacity, {
    totalSlots: 4,
    occupiedSlots: 3,
    freeSlots: 1,
    full: false
  })
})

test('finished-map chest reports full when parsed and raw slots cover every chest slot', () => {
  const container = {
    inventoryStart: 3,
    slots: [{ name: 'filled_map' }, null, { name: 'filled_map' }]
  }
  const capacity = inspectFinishedMapChestCapacity(container, (slot) => slot === 1)

  assert.equal(capacity.freeSlots, 0)
  assert.equal(capacity.full, true)
})

test('finished-map output hold extends only an enabled finite post-print deadline', () => {
  const deadline = { enabled: true, deadlineAt: 10000 }

  assert.equal(extendDeadlineForHold(deadline, 4500), true)
  assert.equal(deadline.deadlineAt, 14500)
  assert.equal(extendDeadlineForHold({ enabled: false, deadlineAt: 10000 }, 4500), false)
  assert.equal(extendDeadlineForHold({ enabled: true, deadlineAt: Infinity }, 4500), false)
})
