const test = require('node:test')
const assert = require('node:assert/strict')
const {
  readBundleContents,
  countBundleMaps,
  countBundleItems,
  bundleContainsOnlyMaps,
  isBundleItem,
  isEmptyBundle,
  bundleFreeCapacity,
  countCarriedMaps,
  countCarriedBundles,
  createBundleOps
} = require('../src/nerv-printer/delivery/bundles')

// Raw prismarine-nbt shape as mineflayer exposes it on item.nbt (1.20 format).
function rawBundleNbt(entries) {
  return {
    type: 'compound',
    name: '',
    value: {
      Items: {
        type: 'list',
        value: {
          type: 'compound',
          value: entries.map(({ id, count }) => ({
            id: { type: 'string', value: id },
            Count: { type: 'byte', value: count }
          }))
        }
      }
    }
  }
}

function bundleItem(entries, name = 'bundle') {
  return { name, count: 1, nbt: entries ? rawBundleNbt(entries) : null }
}

test('reads bundle contents from raw 1.20 NBT', () => {
  const item = bundleItem([
    { id: 'minecraft:filled_map', count: 1 },
    { id: 'minecraft:filled_map', count: 1 },
    { id: 'minecraft:paper', count: 3 }
  ])

  assert.deepEqual(readBundleContents(item), [
    { name: 'filled_map', count: 1 },
    { name: 'filled_map', count: 1 },
    { name: 'paper', count: 3 }
  ])
  assert.equal(countBundleMaps(item), 2)
  assert.equal(countBundleItems(item), 5)
})

test('reads bundle contents from component format (1.20.5+)', () => {
  const item = {
    name: 'bundle',
    components: [
      { type: 'bundle_contents', data: { contents: [{ itemId: 'minecraft:filled_map', itemCount: 4 }] } }
    ]
  }

  assert.equal(countBundleMaps(item), 4)
})

test('resolves numeric component item ids with the bot registry', () => {
  const registry = {
    items: {
      100: { name: 'filled_map' },
      101: { name: 'paper' }
    }
  }
  const item = {
    name: 'bundle',
    components: [
      {
        type: 'bundle_contents',
        data: {
          contents: [
            { itemId: 100, itemCount: 4 },
            { item: { itemId: 101 }, itemCount: 1 }
          ]
        }
      }
    ]
  }

  assert.deepEqual(readBundleContents(item, registry), [
    { name: 'filled_map', count: 4 },
    { name: 'paper', count: 1 }
  ])
  assert.equal(countBundleMaps(item, registry), 4)
  assert.equal(countBundleItems(item, registry), 5)
  assert.equal(bundleContainsOnlyMaps(item, registry), false)
})

test('recognizes numeric bundle content component ids', () => {
  const registry = { items: { 100: { name: 'filled_map' } } }
  const item = {
    name: 'bundle',
    componentMap: new Map([
      [41, { type: 41, data: { contents: [{ itemId: 100, itemCount: 7 }] } }]
    ])
  }

  assert.equal(countBundleMaps(item, registry), 7)
  assert.equal(countBundleItems(item, registry), 7)
  assert.equal(bundleContainsOnlyMaps(item, registry), true)
})

test('counts unknown bundle contents conservatively', () => {
  const item = {
    name: 'bundle',
    components: [
      { type: 'bundle_contents', data: { contents: [{ itemId: 999999, itemCount: 3 }] } }
    ]
  }

  assert.deepEqual(readBundleContents(item), [{ name: 'unknown', count: 3 }])
  assert.equal(countBundleItems(item), 3)
  assert.equal(countBundleMaps(item), 0)
  assert.equal(bundleContainsOnlyMaps(item), false)
  assert.equal(isEmptyBundle(item), false)
})

test('handles empty / missing NBT gracefully', () => {
  assert.deepEqual(readBundleContents(bundleItem(null)), [])
  assert.equal(countBundleMaps(null), 0)
  assert.equal(isEmptyBundle(bundleItem(null)), true)
  assert.equal(isEmptyBundle(bundleItem([{ id: 'minecraft:filled_map', count: 1 }])), false)
})

test('bundle capacity math treats every map as weight one', () => {
  const half = bundleItem(Array.from({ length: 32 }, () => ({ id: 'minecraft:filled_map', count: 1 })))
  assert.equal(bundleFreeCapacity(half, 64), 32)
  const full = bundleItem(Array.from({ length: 64 }, () => ({ id: 'minecraft:filled_map', count: 1 })))
  assert.equal(bundleFreeCapacity(full, 64), 0)
})

test('identifies bundle items including colored bundles', () => {
  assert.equal(isBundleItem({ name: 'bundle' }), true)
  assert.equal(isBundleItem({ name: 'minecraft:bundle' }), true)
  assert.equal(isBundleItem({ name: 'red_bundle' }), true)
  assert.equal(isBundleItem({ name: 'filled_map' }), false)
})

test('counts carried maps across loose stacks and bundles', () => {
  const bot = {
    inventory: {
      items: () => [
        { name: 'filled_map', count: 5, nbt: null },
        bundleItem([{ id: 'minecraft:filled_map', count: 1 }, { id: 'minecraft:filled_map', count: 1 }]),
        bundleItem(null),
        { name: 'bread', count: 32, nbt: null }
      ]
    }
  }

  const maps = countCarriedMaps(bot)
  assert.equal(maps.loose, 5)
  assert.equal(maps.inBundles, 2)
  assert.equal(maps.total, 7)

  const bundles = countCarriedBundles(bot, 'bundle', 64)
  assert.equal(bundles.total, 2)
  assert.equal(bundles.empty, 1)
  assert.equal(bundles.filled, 1)
  assert.equal(bundles.withFreeSpace, 2)
})

test('counts stacked empty bundles by item count, not occupied slot count', () => {
  const bot = {
    inventory: {
      items: () => [
        { name: 'bundle', count: 5, nbt: null },
        bundleItem([{ id: 'minecraft:filled_map', count: 1 }])
      ]
    }
  }

  const bundles = countCarriedBundles(bot, 'bundle', 64)
  assert.equal(bundles.empty, 5)
  assert.equal(bundles.filled, 1)
  assert.equal(bundles.total, 6)
  assert.equal(bundles.withFreeSpace, 6)
})

function componentBundle(mapCount = 0) {
  return {
    name: 'bundle',
    count: 1,
    components: mapCount > 0
      ? [{ type: 'bundle_contents', data: { contents: [{ itemId: 'minecraft:filled_map', itemCount: mapCount }] } }]
      : []
  }
}

function bundleOpsForTest(overrides = {}) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  return createBundleOps({
    toNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    delay,
    openContainerAt: async () => { throw new Error('unexpected chest open') },
    waitForWindowSlot: async (window, slot, predicate, timeoutMs = 200, pollMs = 5) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() <= deadline) {
        const item = window.slots[slot]
        if (predicate(item, window)) return item || true
        await delay(pollMs)
      }
      return null
    },
    assertWindowCursorEmpty: async (window, reason) => {
      assert.equal(window.selectedItem, null, reason)
    },
    waitForWindowCursorEmpty: async (window, timeoutMs = 200, pollMs = 5) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() <= deadline) {
        if (!window.selectedItem) return true
        await delay(pollMs)
      }
      return false
    },
    getWindowCursorItem: (window) => window.selectedItem,
    waitBotTicks: async () => delay(1),
    log: () => {},
    ...overrides
  })
}

test('does not open the bundles chest when five empty bundles are already carried', async () => {
  const ops = bundleOpsForTest()
  const bot = {
    inventory: { items: () => [{ name: 'bundle', count: 5, nbt: null }] }
  }
  const config = {
    delivery: { bundles: { bundlesPerTarget: 5, minEmptyBundles: 4, maxBundlesToCarry: 18 } }
  }

  const result = await ops.restockEmptyBundles(bot, config, {}, { targetCount: 1 })

  assert.equal(result.withdrawn, 0)
  assert.equal(result.desired, 5)
  assert.equal(result.carried.empty, 5)
  assert.equal(result.skipped, 'sufficient-empty-bundles')
})

test('keeps surplus bundles safely when the bundles chest is full', async () => {
  const window = {
    inventoryStart: 1,
    inventoryEnd: 36,
    selectedItem: null,
    slots: Array.from({ length: 37 }, () => ({ name: 'stone', count: 64 })),
    close: () => {}
  }
  window.slots[1] = { name: 'bundle', count: 10, nbt: null }
  const ops = bundleOpsForTest({ openContainerAt: async () => window })
  const clicks = []
  const bot = {
    inventory: { items: () => [{ name: 'bundle', count: 10, nbt: null }] },
    clickWindow: async (slot) => { clicks.push(slot) }
  }
  const config = {
    delivery: {
      bundles: { bundlesPerTarget: 5, minEmptyBundles: 4, maxBundlesToCarry: 18 },
      chests: { verifyTimeoutMs: 500, verifyPollMs: 25 }
    }
  }

  const result = await ops.restockEmptyBundles(bot, config, {
    bundlesChest: { x: 0, y: 0, z: 0 },
    openPosition: { x: 0, y: 0, z: 1 }
  }, { targetCount: 1 })

  assert.equal(result.withdrawn, 0)
  assert.equal(result.returned, 0)
  assert.equal(result.carried.empty, 10)
  assert.deepEqual(clicks, [1])
})

test('waits through Mineflayer bundle-swap prediction before returning the bundle', async () => {
  const ops = bundleOpsForTest()
  const window = {
    inventoryStart: 9,
    inventoryEnd: 44,
    selectedItem: null,
    slots: Array(45).fill(null)
  }
  window.slots[0] = { name: 'filled_map', count: 35 }
  window.slots[9] = componentBundle(0)
  const clicks = []
  const bot = {
    registry: null,
    clickWindow: async (slot) => {
      clicks.push(slot)
      if (slot === 9 && !window.selectedItem) {
        window.selectedItem = window.slots[9]
        window.slots[9] = null
        return
      }
      if (slot === 0 && window.selectedItem?.name === 'bundle') {
        const bundle = window.selectedItem
        const maps = window.slots[0]
        // Generic local prediction: a normal cursor/slot swap.
        window.slots[0] = bundle
        window.selectedItem = maps
        setTimeout(() => {
          // Authoritative server response: maps entered the bundle.
          window.slots[0] = null
          window.selectedItem = componentBundle(35)
        }, 30)
        return
      }
      if (slot === 9 && window.selectedItem?.name === 'bundle') {
        window.slots[9] = window.selectedItem
        window.selectedItem = null
      }
    }
  }
  const config = {
    delivery: {
      bundles: { bundlesPerTarget: 5, mapsPerBundle: 64 },
      chests: { actionDelayMs: 30, verifyTimeoutMs: 250, verifyPollMs: 5 }
    }
  }

  const result = await ops.collectMapsFromWindow(bot, window, config)

  assert.deepEqual(result, { moved: 35, chestEmpty: true, capacityFull: false })
  assert.deepEqual(clicks, [9, 0, 9])
  assert.equal(window.selectedItem, null)
  assert.equal(countBundleMaps(window.slots[9]), 35)
})
