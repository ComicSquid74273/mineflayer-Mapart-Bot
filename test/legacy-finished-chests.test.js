'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LEGACY_FINISHED_MAP_CHEST_KEYS,
  collectLegacyFinishedMapChests
} = require('../src/nerv-printer/legacy-finished-chests')

test('legacy finished-map outputs include the ready-to-deliver chest last', () => {
  const imported = {
    finishedMapChest: { blockPos: { x: 1, y: 2, z: 3 }, openPos: { x: 4, y: 5, z: 6 } },
    finishedMapChest2: { blockPos: { x: 7, y: 8, z: 9 }, openPos: { x: 10, y: 11, z: 12 } },
    readyToDeliverMapChest: { blockPos: { x: 13, y: 14, z: 15 }, openPos: { x: 16, y: 17, z: 18 } }
  }
  const entries = collectLegacyFinishedMapChests(
    imported,
    (entry) => entry?.blockPos || null,
    (entry) => entry?.openPos || null
  )

  assert.deepEqual(LEGACY_FINISHED_MAP_CHEST_KEYS, [
    'finishedMapChest',
    'finishedMapChest1',
    'finishedMapChest2',
    'readyToDeliverMapChest'
  ])
  assert.deepEqual(entries.map((entry) => entry.role), [
    'finishedMapChest',
    'finishedMapChest2',
    'readyToDeliverMapChest'
  ])
  assert.deepEqual(entries.at(-1), {
    enabled: true,
    role: 'readyToDeliverMapChest',
    position: { x: 13, y: 14, z: 15 },
    accessPosition: { x: 16, y: 17, z: 18 }
  })
})
