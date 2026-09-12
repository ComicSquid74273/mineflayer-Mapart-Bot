'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  captureInventorySnapshot,
  countFullyRemovedStacks,
  waitForSettledDumpInventory
} = require('../src/nerv-printer/inventory-dump')

function makeBot () {
  const slots = new Array(12).fill(null)
  slots[9] = { name: 'black_carpet', count: 64, slot: 9 }
  slots[10] = { name: 'white_carpet', count: 32, slot: 10 }
  slots[11] = { name: 'map', count: 1, slot: 11 }
  return {
    inventory: {
      inventoryStart: 9,
      inventoryEnd: 12,
      slots
    }
  }
}

test('counts only candidate stacks supported by the net inventory decrease', () => {
  const before = {
    emptySlots: 0,
    countsByName: new Map([['black_carpet', 128]])
  }
  const after = {
    emptySlots: 1,
    countsByName: new Map([['black_carpet', 64]])
  }

  assert.equal(countFullyRemovedStacks([
    { name: 'black_carpet', count: 64 },
    { name: 'black_carpet', count: 64 }
  ], before, after), 1)
})

test('confirms a tossed stack only after the empty slot remains stable', async () => {
  const bot = makeBot()
  const before = captureInventorySnapshot(bot)
  bot.inventory.slots[9] = null

  const result = await waitForSettledDumpInventory(
    bot,
    before,
    [{ name: 'black_carpet', count: 64 }],
    { minEmptySlotGain: 1, minRemovedStacks: 1, stableMs: 80, timeoutMs: 250, pollMs: 10 }
  )

  assert.equal(result.confirmed, true)
  assert.equal(result.emptySlotGain, 1)
  assert.equal(result.removedStackCount, 1)
})

test('rejects a toss when the dropped stack is picked back up', async () => {
  const bot = makeBot()
  const before = captureInventorySnapshot(bot)
  const carpet = bot.inventory.slots[9]
  bot.inventory.slots[9] = null
  setTimeout(() => { bot.inventory.slots[9] = carpet }, 50)

  const result = await waitForSettledDumpInventory(
    bot,
    before,
    [{ name: 'black_carpet', count: 64 }],
    { minEmptySlotGain: 1, minRemovedStacks: 1, stableMs: 100, timeoutMs: 220, pollMs: 10 }
  )

  assert.equal(result.confirmed, false)
  assert.equal(result.emptySlotGain, 0)
  assert.equal(result.removedStackCount, 0)
})
