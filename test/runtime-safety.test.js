'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const { Vec3 } = require('vec3')

const {
  installServerInventoryTracker,
  getAuthoritativeWindowSnapshotSequence,
  getRawWindowSlotItem,
  hasRawWindowSlotItem,
  rawInventoryItemMatches,
  getAuthoritativeInventoryCursorState,
  clickWindowWithTrackedState,
  moveWindowSlotItemWithTrackedState,
  quickMoveWindowSlotItemWithTrackedState,
  runWithServerInventoryConfirmation,
  areAllItemsVerified,
  getBotInventorySlotForWindowSlot,
  reconcileWindowInventorySlot,
  getConfiguredPlatformBounds,
  isPositionInsideBounds,
  getMissingFinishedMapRecovery,
  getIncompleteCartographyResumeStep,
  buildPostPrintRuntimeCheckpoint,
  getMachineAccessPathTimeoutMs,
  getWorkloadCheckpointMoveTimeoutMs,
  shouldUseStraightWorkloadCheckpoint,
  findSupportedUpperPlatformEgress,
  normalizeCarpetSurfacePosition,
  normalizeMachineAccessSprintMode,
  createMachinePathSprintRecovery,
  getPathfinderAbortGeneration,
  interruptPathfinder,
  resolvePathGoalBeforeInterrupt,
  pathfinderRunWasAborted,
  isPathfinderStoppedError,
  pathfinderStopWasUnowned,
  getRuntimeWorldGenerationBoundary,
  hasPendingRuntimeWorldChange,
  isServerInventoryConfirmationTimeout,
  isPlatformStallRecoveryExcluded,
  getPlatformStallRecoveryReason,
  getPostPrintTravelSafety,
  shouldResumeBlockedPostPrintAfterFood
} = require('../src/nerv-printer/runtime-safety')

test('server inventory confirmation timeouts can be identified by action label', () => {
  const error = new Error('cartography-output: no matching server inventory update within 4000ms')
  assert.equal(isServerInventoryConfirmationTimeout(error), true)
  assert.equal(isServerInventoryConfirmationTimeout(error, 'cartography-output'), true)
  assert.equal(isServerInventoryConfirmationTimeout(error, 'finished-map-output'), false)
})

test('platform stall recovery excludes intentional waits and recycles blocked or inactive work', () => {
  assert.equal(isPlatformStallRecoveryExcluded({ phase: 'post_print', action: 'waiting-food-stock' }), true)
  assert.equal(getPlatformStallRecoveryReason({ phase: 'post_print', action: 'blocked-cartography' }, 120000), 'platform-stall-blocked-cartography')
  assert.equal(getPlatformStallRecoveryReason({ phase: 'printing', action: 'batch-complete' }, 299999), null)
  assert.equal(getPlatformStallRecoveryReason({ phase: 'printing', action: 'batch-complete' }, 300000), 'platform-stall-active-work')
  assert.equal(getPlatformStallRecoveryReason({ phase: 'printing', action: 'waiting-material-restock' }, 900000), null)
})

test('pending runtime world changes survive generation rebases until the managed print loop handles them', () => {
  const bot = {
    __nervRuntimeWorldGeneration: 4,
    __nervRuntimeWorldChangePending: true
  }
  const config = { __runtimeWorldGenerationAtRun: 4 }

  assert.equal(hasPendingRuntimeWorldChange(bot, config), true)
  bot.__nervRuntimeWorldChangePending = false
  assert.equal(hasPendingRuntimeWorldChange(bot, config), false)
  config.__runtimeWorldGenerationAtRun = 3
  assert.equal(hasPendingRuntimeWorldChange(bot, config), true)
})

test('an inactive runtime generation boundary does not fabricate a world change', () => {
  const bot = {
    __nervRuntimeWorldGeneration: 7,
    __nervRuntimeWorldChangePending: false
  }

  assert.equal(getRuntimeWorldGenerationBoundary({ __runtimeWorldGenerationAtRun: null }), null)
  assert.equal(getRuntimeWorldGenerationBoundary({ __runtimeWorldGenerationAtRun: undefined }), null)
  assert.equal(getRuntimeWorldGenerationBoundary({ __runtimeWorldGenerationAtRun: '' }), null)
  assert.equal(hasPendingRuntimeWorldChange(bot, { __runtimeWorldGenerationAtRun: null }), false)
  assert.equal(hasPendingRuntimeWorldChange(bot, { __runtimeWorldGenerationAtRun: undefined }), false)
  assert.equal(hasPendingRuntimeWorldChange(bot, { __runtimeWorldGenerationAtRun: 6 }), true)
})

test('platform bounds reject matching X/Z coordinates at the wrong elevation', () => {
  const config = {
    machine: {
      mapCorner: { x: -1000, y: 105, z: 2000 },
      mapSize: { width: 128, height: 128 }
    },
    advanced: {
      platformVerticalToleranceBelow: 8,
      platformVerticalToleranceAbove: 12
    }
  }
  const bounds = getConfiguredPlatformBounds(config)

  assert.equal(isPositionInsideBounds({ x: -950, y: 105, z: 2050 }, bounds), true)
  assert.equal(isPositionInsideBounds({ x: -950, y: 97, z: 2050 }, bounds), true)
  assert.equal(isPositionInsideBounds({ x: -950, y: 96.99, z: 2050 }, bounds), false)
  assert.equal(isPositionInsideBounds({ x: -950, y: 130, z: 2050 }, bounds), false)
})

test('post-print travel requires both health and hunger above their safety thresholds', () => {
  assert.deepEqual(getPostPrintTravelSafety(12, 20), {
    safe: false,
    lowHealth: true,
    lowHunger: false,
    health: 12,
    hunger: 20,
    healthThreshold: 12,
    hungerThreshold: 12
  })
  assert.equal(getPostPrintTravelSafety(20, 12).safe, false)
  assert.equal(getPostPrintTravelSafety(13, 13).safe, true)
  assert.equal(getPostPrintTravelSafety(null, null).safe, true)
})

test('tracked cursor move can split a chest stack with a right-click pickup', async () => {
  const bot = makeBot()
  const clicks = []
  bot.clickWindow = async (slot, mouseButton, mode) => {
    clicks.push({ slot, mouseButton, mode })
  }

  await moveWindowSlotItemWithTrackedState(
    bot,
    { id: 5 },
    4,
    36,
    { sourceMouseButton: 1, ackWaitMs: 50 }
  )

  assert.deepEqual(clicks, [
    { slot: 4, mouseButton: 1, mode: 0 },
    { slot: 36, mouseButton: 0, mode: 0 }
  ])
})

test('only a food travel-safety block resumes after food and live safety recover', () => {
  const safe = getPostPrintTravelSafety(20, 20)
  assert.equal(shouldResumeBlockedPostPrintAfterFood('food-travel-safety', true, safe), true)
  assert.equal(shouldResumeBlockedPostPrintAfterFood('food-travel-safety', false, safe), false)
  assert.equal(shouldResumeBlockedPostPrintAfterFood('food-travel-safety', true, getPostPrintTravelSafety(20, 12)), false)
  assert.equal(shouldResumeBlockedPostPrintAfterFood('food-travel-safety', true, getPostPrintTravelSafety(null, null)), false)
  assert.equal(shouldResumeBlockedPostPrintAfterFood('map-render-unverified', true, safe), false)
  assert.equal(shouldResumeBlockedPostPrintAfterFood(null, true, safe), false)
})

test('raw slot occupancy remains authoritative when a component item is not parsed into the window', () => {
  const bot = makeBot()
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', {
    windowId: 5,
    stateId: 12,
    items: [{ itemId: 42, itemCount: 1, components: [{ type: 5, data: 'raw-name' }] }, null]
  })

  const window = { id: 5, slots: [null, null] }
  assert.equal(hasRawWindowSlotItem(bot, window, 0), true)
  assert.deepEqual(getRawWindowSlotItem(bot, window, 0), { itemId: 42, itemCount: 1, components: [{ type: 5, data: 'raw-name' }] })
  assert.equal(hasRawWindowSlotItem(bot, window, 1), false)
  assert.equal(getAuthoritativeWindowSnapshotSequence(bot, window), 1)
  bot._client.emit('set_slot', { windowId: 5, stateId: 13, slot: 1, item: null })
  assert.equal(getAuthoritativeWindowSnapshotSequence(bot, window), 1)
  bot._client.emit('window_items', { windowId: 5, stateId: 14, items: [null, null] })
  assert.equal(getAuthoritativeWindowSnapshotSequence(bot, window), 3)
})

test('pathfinder stop ownership distinguishes a late internal stop from an explicit abort', () => {
  const bot = {}
  const start = getPathfinderAbortGeneration(bot)
  const stopped = Object.assign(new Error('Path was stopped before it could be completed! Thus, the desired goal was not reached.'), { name: 'PathStopped' })

  assert.equal(isPathfinderStoppedError(stopped), true)
  assert.equal(pathfinderStopWasUnowned(bot, start, stopped), true)
  interruptPathfinder(bot)
  assert.equal(pathfinderStopWasUnowned(bot, start, stopped), false)
})

test('a satisfied bounded goal settles before its pathfinder cancellation rejects navigation', async () => {
  let rejectNavigation
  const navigation = new Promise((resolve, reject) => { rejectNavigation = reject })
  const bot = {
    pathfinder: {
      stop() { rejectNavigation(new Error('The goal was changed before it could be completed!')) },
      setGoal() { }
    }
  }
  const satisfied = new Promise((resolve) => {
    setImmediate(() => resolvePathGoalBeforeInterrupt(resolve, bot))
  })

  await assert.doesNotReject(Promise.race([navigation, satisfied]))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(getPathfinderAbortGeneration(bot), 1)
})

test('authoritative container inventory slots reconcile to the matching bot slot', () => {
  const namedMap = { type: 42, name: 'filled_map', count: 1, customName: 'artwork' }
  const inventory = {
    inventoryStart: 9,
    inventoryEnd: 45,
    slots: new Array(46).fill(null)
  }
  inventory.slots[11] = { type: 42, name: 'filled_map', count: 1 }
  const window = {
    inventoryStart: 3,
    inventoryEnd: 39,
    slots: new Array(39).fill(null)
  }
  window.slots[5] = namedMap

  assert.equal(getBotInventorySlotForWindowSlot(window, inventory, 5), 11)
  const result = reconcileWindowInventorySlot({ inventory }, window, 5)
  assert.equal(result.reconciled, true)
  assert.equal(inventory.slots[11], namedMap)
  assert.equal(namedMap.slot, 11)
})

test('authoritative slot reconciliation replaces a stale component-backed map id', () => {
  const sourceMap = {
    type: 42,
    name: 'filled_map',
    count: 1,
    componentMap: new Map([['map_id', { data: 613738 }]])
  }
  const lockedOutput = {
    type: 42,
    name: 'filled_map',
    count: 1,
    componentMap: new Map([['map_id', { data: 613739 }]])
  }
  const inventory = {
    inventoryStart: 9,
    inventoryEnd: 45,
    slots: new Array(46).fill(null)
  }
  inventory.slots[12] = sourceMap
  const window = {
    inventoryStart: 3,
    inventoryEnd: 39,
    slots: new Array(39).fill(null)
  }
  window.slots[6] = lockedOutput

  const result = reconcileWindowInventorySlot({ inventory }, window, 6)

  assert.equal(result.reconciled, true)
  assert.equal(result.botSlot, 12)
  assert.equal(inventory.slots[12], lockedOutput)
  assert.equal(inventory.slots[12].componentMap.get('map_id').data, 613739)
  assert.equal(inventory.slots[12].slot, 12)
})

test('authoritative slot reconciliation refuses to overwrite a different stack', () => {
  const inventory = {
    inventoryStart: 9,
    inventoryEnd: 45,
    slots: new Array(46).fill(null)
  }
  inventory.slots[9] = { type: 7, name: 'glass_pane', count: 1 }
  const window = {
    inventoryStart: 3,
    inventoryEnd: 39,
    slots: new Array(39).fill(null)
  }
  window.slots[3] = { type: 42, name: 'filled_map', count: 1, customName: 'artwork' }

  const result = reconcileWindowInventorySlot({ inventory }, window, 3)
  assert.equal(result.reconciled, false)
  assert.equal(inventory.slots[9].name, 'glass_pane')
})

test('a raw-proven cartography handoff can replace a different stale client stack', () => {
  const lockedMap = {
    type: 42,
    name: 'filled_map',
    count: 1,
    componentMap: new Map([['map_id', { data: 613885 }]])
  }
  const inventory = {
    inventoryStart: 9,
    inventoryEnd: 45,
    slots: new Array(46).fill(null)
  }
  inventory.slots[39] = { type: 7, name: 'glass_pane', count: 58 }
  const window = {
    inventoryStart: 3,
    inventoryEnd: 39,
    slots: new Array(39).fill(null)
  }
  window.slots[33] = lockedMap

  const result = reconcileWindowInventorySlot({ inventory }, window, 33, {
    allowAuthoritativeReplacement: true
  })

  assert.equal(result.reconciled, true)
  assert.equal(result.botSlot, 39)
  assert.equal(inventory.slots[39], lockedMap)
  assert.equal(inventory.slots[39].slot, 39)
})

function makeBot() {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.supportFeature = (name) => name === 'stateIdUsed'
  return bot
}

test('uses the authoritative state id for one scoped container click', async () => {
  const bot = makeBot()
  const writes = []
  const originalWrite = (name, params) => writes.push({ name, params })
  bot._client.write = originalWrite
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode
    })
  }
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items: [] })

  const result = await clickWindowWithTrackedState(bot, { id: 5 }, 81, 0, 1)

  assert.equal(result.corrected, true)
  assert.equal(result.outgoingStateId, 99)
  assert.equal(result.trackedStateId, 12)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].params.stateId, 12)
  assert.equal(bot._client.write, originalWrite)
})

test('can force a full server inventory sync while preserving the predicted click', async () => {
  const bot = makeBot()
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params })
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 12,
      slot,
      mouseButton,
      mode,
      changedSlots: [
        { location: slot, item: null },
        { location: 0, item: { itemId: 42, itemCount: 1 } }
      ],
      cursorItem: null
    })
  }
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items: [] })

  const result = await clickWindowWithTrackedState(
    bot,
    { id: 5 },
    81,
    0,
    1,
    { forceFullSync: true }
  )

  assert.equal(result.corrected, true)
  assert.equal(result.trackedStateId, 12)
  assert.equal(writes[0].params.stateId, -1)
  assert.equal(writes[0].params.changedSlots.length, 2)
  assert.equal(writes[0].params.changedSlots[1].location, 0)
})

test('paces a two-click move with the server cursor acknowledgement state', async () => {
  const bot = makeBot()
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params: { ...params } })
  let clicks = 0
  bot.clickWindow = async (slot, mouseButton, mode) => {
    clicks += 1
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode
    })
    if (clicks === 1) {
      bot._client.emit('set_slot', { windowId: -1, stateId: 13, slot: -1, item: null })
    }
  }
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items: [] })

  const result = await moveWindowSlotItemWithTrackedState(bot, { id: 5 }, 81, 0)

  assert.equal(writes.length, 2)
  assert.deepEqual(writes.map((entry) => entry.params.stateId), [12, 13])
  assert.deepEqual(writes.map((entry) => entry.params.slot), [81, 0])
  assert.equal(result.nextStateEvent.type, 'set_slot')
  assert.equal(result.nextStateId, 13)
})

test('preserves a server-owned raw component item across a paced move', async () => {
  const bot = makeBot()
  const rawMap = { itemId: 42, itemCount: 1, addedComponentCount: 1, components: [{ type: 5, data: 'raw-name' }] }
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params })
  let clicks = 0
  bot.clickWindow = async (slot, mouseButton, mode) => {
    clicks += 1
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode,
      changedSlots: [{ location: slot, item: clicks === 1 ? null : { itemId: 42, itemCount: 1 } }],
      cursorItem: clicks === 1 ? { itemId: 42, itemCount: 1 } : null
    })
    if (clicks === 1) {
      bot._client.emit('set_slot', { windowId: -1, stateId: 13, slot: -1, item: rawMap })
    }
  }
  installServerInventoryTracker(bot)
  const items = new Array(90).fill(null)
  items[81] = rawMap
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items })

  const result = await moveWindowSlotItemWithTrackedState(
    bot,
    { id: 5 },
    81,
    0,
    { preserveRawItem: true }
  )

  assert.equal(result.preservedRawItem, true)
  assert.equal(writes[0].params.cursorItem, rawMap)
  assert.equal(writes[1].params.changedSlots[0].item, rawMap)
})

test('can omit predictions on both clicks of a raw paced move', async () => {
  const bot = makeBot()
  const rawMap = { itemId: 42, itemCount: 1, components: [{ type: 5, data: 'raw-name' }] }
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params })
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode,
      changedSlots: [{ location: slot, item: null }],
      cursorItem: slot === 81 ? { itemId: 42, itemCount: 1 } : null
    })
    if (slot === 81) {
      bot._client.emit('set_slot', { windowId: -1, stateId: 13, slot: -1, item: rawMap })
    }
  }
  installServerInventoryTracker(bot)
  const items = new Array(90).fill(null)
  items[81] = rawMap
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items })

  const result = await moveWindowSlotItemWithTrackedState(
    bot,
    { id: 5 },
    81,
    0,
    { preserveRawItem: true, omitChangedSlots: true }
  )

  assert.equal(result.preservedRawItem, true)
  assert.deepEqual(writes.map((entry) => entry.params.stateId), [12, 13])
  assert.deepEqual(writes.map((entry) => entry.params.changedSlots), [[], []])
  assert.equal(writes[0].params.cursorItem, rawMap)
})

test('waits between cursor clicks and uses the latest acknowledged window state', async () => {
  const bot = makeBot()
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params })
  let clicks = 0
  bot.clickWindow = async (slot, mouseButton, mode) => {
    clicks += 1
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode,
      changedSlots: [],
      cursorItem: null
    })
    if (clicks === 1) {
      bot._client.emit('set_slot', { windowId: 5, stateId: 13, slot: 81, item: null })
      setTimeout(() => {
        bot._client.emit('set_slot', { windowId: 5, stateId: 14, slot: -1, item: null })
      }, 5)
    }
  }
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items: [] })

  const startedAt = Date.now()
  const result = await moveWindowSlotItemWithTrackedState(
    bot,
    { id: 5 },
    81,
    0,
    { interClickDelayMs: 20 }
  )

  assert.ok(Date.now() - startedAt >= 15)
  assert.equal(result.nextStateEvent.stateId, 13)
  assert.equal(result.nextStateId, 14)
  assert.deepEqual(writes.map((entry) => entry.params.stateId), [12, 14])
})

test('reuses the confirmed window state when the pickup is accepted silently', async () => {
  const bot = makeBot()
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params })
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode,
      changedSlots: [],
      cursorItem: null
    })
  }
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items: [] })

  const result = await moveWindowSlotItemWithTrackedState(
    bot,
    { id: 5 },
    81,
    0,
    { ackWaitMs: 50 }
  )

  assert.equal(result.nextStateEvent, null)
  assert.equal(result.nextStateId, 12)
  assert.equal(writes[0].params.stateId, 12)
  assert.equal(writes[1].params.stateId, 12)
})

test('can advance the menu state after a silently accepted predicted pickup', async () => {
  const bot = makeBot()
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params })
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode,
      changedSlots: [],
      cursorItem: null
    })
  }
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items: [] })

  const result = await moveWindowSlotItemWithTrackedState(
    bot,
    { id: 5 },
    81,
    0,
    { ackWaitMs: 50, advanceStateIdOnSilentAck: true }
  )

  assert.equal(result.nextStateEvent, null)
  assert.equal(result.nextStateId, 13)
  assert.deepEqual(writes.map((entry) => entry.params.stateId), [12, 13])
})

test('quick-moves a raw component item in one tracked transaction', async () => {
  const bot = makeBot()
  const rawMap = { itemId: 42, itemCount: 1, addedComponentCount: 1, components: [{ type: 5, data: 'raw-name' }] }
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params })
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode,
      changedSlots: [
        { location: slot, item: null },
        { location: 0, item: { itemId: 42, itemCount: 1 } }
      ],
      cursorItem: null
    })
  }
  installServerInventoryTracker(bot)
  const items = new Array(90).fill(null)
  items[81] = rawMap
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items })

  const result = await quickMoveWindowSlotItemWithTrackedState(
    bot,
    { id: 5 },
    81,
    0,
    { preserveRawItem: true }
  )

  assert.equal(result.preservedRawItem, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].params.mode, 1)
  assert.equal(writes[0].params.stateId, 12)
  assert.equal(writes[0].params.changedSlots[1].item, rawMap)
})

test('can preserve the outgoing state for a raw atomic quick-move', async () => {
  const bot = makeBot()
  const rawMap = { itemId: 42, itemCount: 1, components: [{ type: 5, data: 'raw-name' }] }
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params })
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode,
      changedSlots: [
        { location: slot, item: null },
        { location: 0, item: { itemId: 42, itemCount: 1 } }
      ],
      cursorItem: null
    })
  }
  installServerInventoryTracker(bot)
  const items = new Array(90).fill(null)
  items[81] = rawMap
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items })

  const result = await quickMoveWindowSlotItemWithTrackedState(
    bot,
    { id: 5 },
    81,
    0,
    { preserveRawItem: true, preserveOutgoingStateId: true }
  )

  assert.equal(result.click.corrected, false)
  assert.equal(result.click.trackedStateId, 12)
  assert.equal(writes[0].params.stateId, 99)
  assert.equal(writes[0].params.changedSlots[1].item, rawMap)
})

test('can combine authoritative state correction with omitted atomic predictions', async () => {
  const bot = makeBot()
  const rawMap = { itemId: 42, itemCount: 1, components: [{ type: 5, data: 'raw-name' }] }
  const writes = []
  bot._client.write = (name, params) => writes.push({ name, params })
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot._client.write('window_click', {
      windowId: 5,
      stateId: 99,
      slot,
      mouseButton,
      mode,
      changedSlots: [
        { location: slot, item: null },
        { location: 0, item: { itemId: 42, itemCount: 1 } }
      ],
      cursorItem: null
    })
  }
  installServerInventoryTracker(bot)
  const items = new Array(90).fill(null)
  items[81] = rawMap
  bot._client.emit('window_items', { windowId: 5, stateId: 12, items })

  const result = await quickMoveWindowSlotItemWithTrackedState(
    bot,
    { id: 5 },
    81,
    0,
    { preserveRawItem: true, omitChangedSlots: true }
  )

  assert.equal(result.click.corrected, true)
  assert.equal(result.click.trackedStateId, 12)
  assert.equal(writes[0].params.stateId, 12)
  assert.deepEqual(writes[0].params.changedSlots, [])
})

test('does not accept Mineflayer local inventory prediction without a server packet', async () => {
  const bot = makeBot()
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 5, stateId: 10, items: [] })

  const window = { id: 5, slots: new Array(20).fill(null) }
  await assert.rejects(
    runWithServerInventoryConfirmation(
      bot,
      {
        window,
        windowId: 5,
        slots: [12],
        timeoutMs: 60,
        label: 'predicted-only',
        predicate: () => window.slots[12]?.name === 'map'
      },
      async () => {
        window.slots[12] = { name: 'map', count: 1 }
      }
    ),
    /no matching server inventory update/
  )
})

test('accepts the expected slot only after a new server state id arrives', async () => {
  const bot = makeBot()
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 7, stateId: 20, items: [] })

  const window = { id: 7, slots: new Array(20).fill(null) }
  const result = await runWithServerInventoryConfirmation(
    bot,
    {
      window,
      windowId: 7,
      slots: [11],
      timeoutMs: 250,
      label: 'server-confirmed',
      predicate: () => window.slots[11]?.name === 'glass_pane'
    },
    async () => {
      window.slots[11] = { name: 'glass_pane', count: 1 }
      setImmediate(() => {
        bot._client.emit('set_slot', { windowId: 7, stateId: 20, slot: 11, item: null })
        bot._client.emit('set_slot', { windowId: 7, stateId: 21, slot: 4, item: null })
        bot._client.emit('set_slot', { windowId: 7, stateId: 21, slot: 11, item: null })
      })
    }
  )

  assert.equal(result.type, 'set_slot')
  assert.equal(result.stateId, 21)
  assert.equal(result.packet.slot, 11)
})

test('accepts an authoritative returned remainder without requiring a redundant cursor echo', async () => {
  const bot = makeBot()
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 7, stateId: 20, items: [] })

  const window = { id: 7, slots: new Array(20).fill(null) }
  bot._client.emit('set_slot', {
    windowId: -1,
    stateId: 20,
    slot: -1,
    item: { itemId: 42, itemCount: 63 }
  })
  const cursorBefore = getAuthoritativeInventoryCursorState(bot)
  assert.equal(cursorBefore.empty, false)
  const result = await runWithServerInventoryConfirmation(
    bot,
    {
      window,
      windowId: 7,
      slots: [4],
      timeoutMs: 250,
      label: 'return-remainder',
      predicate: (event) => {
        if (event?.windowId !== 7 || (event.type !== 'window_items' && event.packet?.slot !== 4)) return false
        return rawInventoryItemMatches(getRawWindowSlotItem(bot, window, 4), 42, 63)
      }
    },
    async () => {
      setImmediate(() => {
        bot._client.emit('set_slot', {
          windowId: 7,
          stateId: 21,
          slot: 4,
          item: { itemId: 42, itemCount: 63 }
        })
      })
    }
  )

  assert.equal(result.type, 'set_slot')
  assert.equal(result.windowId, 7)
  assert.equal(result.packet.slot, 4)
  assert.equal(getAuthoritativeInventoryCursorState(bot).sequence, cursorBefore.sequence)
  assert.equal(getAuthoritativeInventoryCursorState(bot).empty, false)
})

test('tracks the authoritative cursor carried by a full window snapshot', () => {
  const bot = makeBot()
  installServerInventoryTracker(bot)

  bot._client.emit('window_items', {
    windowId: 5,
    stateId: 12,
    items: [],
    carriedItem: { itemId: 42, itemCount: 7 }
  })
  assert.deepEqual(getAuthoritativeInventoryCursorState(bot), {
    known: true,
    sequence: 1,
    empty: false,
    rawItem: { itemId: 42, itemCount: 7 }
  })

  bot._client.emit('window_items', {
    windowId: 5,
    stateId: 13,
    items: [],
    carriedItem: null
  })
  assert.equal(getAuthoritativeInventoryCursorState(bot).empty, true)
})

test('does not treat an unrelated player-inventory update as the included cursor update', async () => {
  const bot = makeBot()
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 7, stateId: 20, items: [] })

  await assert.rejects(
    runWithServerInventoryConfirmation(
      bot,
      {
        windowId: 7,
        slots: [4],
        includeCursorUpdate: true,
        timeoutMs: 60,
        label: 'unrelated-player-slot',
        predicate: () => true
      },
      async () => {
        setImmediate(() => {
          bot._client.emit('set_slot', { windowId: -1, stateId: 21, slot: 12, item: null })
        })
      }
    ),
    /no matching server inventory update/
  )
})

test('accepts a server-confirmed container destination when the player source was predicted', async () => {
  const bot = makeBot()
  installServerInventoryTracker(bot)
  bot._client.emit('window_items', { windowId: 9, stateId: 30, items: [] })

  const window = { id: 9, slots: new Array(90).fill(null) }
  window.slots[81] = { name: 'filled_map', count: 1 }
  const result = await runWithServerInventoryConfirmation(
    bot,
    {
      window,
      windowId: 9,
      slots: [81, ...Array.from({ length: 54 }, (_, index) => index)],
      requireStateIdChange: false,
      timeoutMs: 250,
      label: 'deposit-destination-confirmed',
      predicate: () => window.slots[81] == null
    },
    async () => {
      // Mineflayer predicts the source removal, while this server acknowledges
      // the shift-click only by updating the destination chest slot.
      window.slots[81] = null
      setImmediate(() => {
        bot._client.emit('set_slot', { windowId: 9, stateId: 30, slot: 7, item: { name: 'filled_map', count: 1 } })
      })
    }
  )

  assert.equal(result.type, 'set_slot')
  assert.equal(result.packet.slot, 7)
})

test('zero maps can never pass rename verification', () => {
  const named = (item) => item.named === true
  assert.equal(areAllItemsVerified([], named), false)
  assert.equal(areAllItemsVerified([{ named: true }], named), true)
  assert.equal(areAllItemsVerified([{ named: true }, { named: false }], named), false)
})

test('a missing cartography result rewinds to withdraw and clears completion', () => {
  assert.deepEqual(getMissingFinishedMapRecovery(), {
    failedStep: 'withdraw',
    postPrintCartographyComplete: false
  })
})

test('machine access timeout is bounded but allows legitimate long platform routes', () => {
  assert.equal(getMachineAccessPathTimeoutMs(10), 30000)
  assert.equal(getMachineAccessPathTimeoutMs(68), 44000)
  assert.equal(getMachineAccessPathTimeoutMs(200), 60000)
  assert.equal(getMachineAccessPathTimeoutMs(200, 12000), 12000)
})

test('workload checkpoint timeout scales with route distance instead of expiring at 30 seconds', () => {
  assert.equal(getWorkloadCheckpointMoveTimeoutMs(10), 30000)
  assert.equal(getWorkloadCheckpointMoveTimeoutMs(80), 50000)
  assert.equal(getWorkloadCheckpointMoveTimeoutMs(300), 120000)
  assert.equal(getWorkloadCheckpointMoveTimeoutMs(80, 60000), 60000)
  assert.equal(getWorkloadCheckpointMoveTimeoutMs(80, 30000, {
    overheadMs: 0,
    msPerBlock: 1000,
    maxTimeoutMs: 70000
  }), 70000)
})

test('all flat workload traversal checkpoints use direct movement when enabled', () => {
  assert.equal(shouldUseStraightWorkloadCheckpoint('', true), true)
  assert.equal(shouldUseStraightWorkloadCheckpoint('inline-repair', true), true)
  assert.equal(shouldUseStraightWorkloadCheckpoint('lineEnd', true), true)
  assert.equal(shouldUseStraightWorkloadCheckpoint('sprint', true), true)
  assert.equal(shouldUseStraightWorkloadCheckpoint('unknown', true), false)
  assert.equal(shouldUseStraightWorkloadCheckpoint('', false), false)
})

test('post-print runtime checkpoints follow the latest completed workflow boundary', () => {
  assert.deepEqual(
    buildPostPrintRuntimeCheckpoint(
      'rename_store',
      'cartography-complete',
      {
        postPrintCartographyComplete: true,
        postPrintSourceMapId: 614765
      },
      '2026-08-30T16:39:00.000Z'
    ),
    {
      phase: 'post_print',
      action: 'cartography-complete',
      meta: {
        postPrintCartographyComplete: true,
        postPrintSourceMapId: 614765,
        postPrintStep: 'rename_store',
        postPrintStartedAt: '2026-08-30T16:39:00.000Z'
      }
    }
  )
})

test('an incomplete cartography checkpoint without its filled map rewinds even at the cartography step', () => {
  const steps = ['withdraw', 'fill_map', 'cartography', 'rename_store', 'reset', 'center', 'done']

  assert.equal(getIncompleteCartographyResumeStep('cartography', false, steps), 'withdraw')
  assert.equal(getIncompleteCartographyResumeStep('cartography', true, steps), 'cartography')
  assert.equal(getIncompleteCartographyResumeStep('rename_store', false, steps), 'withdraw')
  assert.equal(getIncompleteCartographyResumeStep('fill_map', false, steps), 'fill_map')
})

test('machine access normalizes a transfer position embedded in a carpet collision surface', () => {
  const bot = {
    entity: {
      position: new Vec3(100.4, 91, 200.6),
      velocity: new Vec3(0, -0.08, 0)
    },
    blockAt(position) {
      assert.deepEqual(position, new Vec3(100, 91, 200))
      return { name: 'black_carpet', position }
    }
  }

  const normalized = normalizeCarpetSurfacePosition(bot)

  assert.equal(normalized.previousY, 91)
  assert.equal(normalized.surfaceY, 91.0625)
  assert.equal(bot.entity.position.y, 91.0625)
  assert.equal(bot.entity.velocity.y, 0)
  assert.equal(normalizeCarpetSurfacePosition(bot), null)
})

test('machine elevation resolves a safe cardinal egress from a one-block-upper /home pad', () => {
  const blocks = new Map([
    ['100:91:200', { name: 'obsidian', boundingBox: 'block', position: new Vec3(100, 91, 200) }],
    ['100:90:200', { name: 'stone', boundingBox: 'block', position: new Vec3(100, 90, 200) }],
    ['100:92:200', { name: 'air', boundingBox: 'empty', position: new Vec3(100, 92, 200) }],
    ['100:93:200', { name: 'air', boundingBox: 'empty', position: new Vec3(100, 93, 200) }],
    ['101:90:200', { name: 'stone', boundingBox: 'block', position: new Vec3(101, 90, 200) }],
    ['101:91:200', { name: 'air', boundingBox: 'empty', position: new Vec3(101, 91, 200) }],
    ['101:92:200', { name: 'air', boundingBox: 'empty', position: new Vec3(101, 92, 200) }],
    ['101:93:200', { name: 'air', boundingBox: 'empty', position: new Vec3(101, 93, 200) }]
  ])
  const bot = {
    entity: { position: new Vec3(100.4, 92, 200.6), onGround: true },
    blockAt(position) {
      return blocks.get(`${position.x}:${position.y}:${position.z}`) || null
    }
  }

  const landing = findSupportedUpperPlatformEgress(bot, 91, { preferredPoint: { x: 200, z: 200 } })
  assert.equal(landing.surface.name, 'obsidian')
  assert.deepEqual(landing.egress.point, { x: 101.5, y: 91, z: 200.5 })
  assert.equal(landing.verticalDistance, 1)

  blocks.set('101:90:200', { name: 'water', boundingBox: 'empty', position: new Vec3(101, 90, 200) })
  assert.equal(findSupportedUpperPlatformEgress(bot, 91), null)

  blocks.set('101:90:200', { name: 'stone', boundingBox: 'block', position: new Vec3(101, 90, 200) })
  bot.entity.onGround = false
  assert.equal(findSupportedUpperPlatformEgress(bot, 91), null)
})

test('machine elevation accepts a loaded passable mechanism cell over solid platform support', () => {
  const blocks = new Map([
    ['100:91:200', { name: 'tripwire_hook', boundingBox: 'empty', position: new Vec3(100, 91, 200) }],
    ['100:90:200', { name: 'netherite_block', boundingBox: 'block', position: new Vec3(100, 90, 200) }],
    ['100:92:200', { name: 'air', boundingBox: 'empty', position: new Vec3(100, 92, 200) }],
    ['100:93:200', { name: 'air', boundingBox: 'empty', position: new Vec3(100, 93, 200) }],
    ['101:90:200', { name: 'netherite_block', boundingBox: 'block', position: new Vec3(101, 90, 200) }],
    ['101:91:200', { name: 'air', boundingBox: 'empty', position: new Vec3(101, 91, 200) }],
    ['101:92:200', { name: 'air', boundingBox: 'empty', position: new Vec3(101, 92, 200) }],
    ['101:93:200', { name: 'air', boundingBox: 'empty', position: new Vec3(101, 93, 200) }]
  ])
  const bot = {
    entity: {
      position: new Vec3(100.4, 92, 200.6),
      onGround: true
    },
    blockAt(position) {
      return blocks.get(`${position.x}:${position.y}:${position.z}`) || null
    }
  }

  const landing = findSupportedUpperPlatformEgress(bot, 91)
  assert.equal(landing.surface.name, 'tripwire_hook')
  assert.deepEqual(landing.egress.point, { x: 101.5, y: 91, z: 200.5 })

  blocks.set('100:91:200', { name: 'water', boundingBox: 'empty', position: new Vec3(100, 91, 200) })
  assert.equal(findSupportedUpperPlatformEgress(bot, 91), null)
})

test('machine elevation does not treat arbitrary upper positions as supported landings', () => {
  const bot = {
    entity: { position: new Vec3(100.4, 92.3, 200.6), onGround: true },
    blockAt(position) {
      if (position.y === 91) return { name: 'black_carpet', position }
      return { name: 'stone', position }
    }
  }

  assert.equal(findSupportedUpperPlatformEgress(bot, 91), null)
})

test('machine access sprint mode normalizes config values without unsafe ambiguity', () => {
  assert.equal(normalizeMachineAccessSprintMode(undefined), 'automatic')
  assert.equal(normalizeMachineAccessSprintMode('automatic'), 'automatic')
  assert.equal(normalizeMachineAccessSprintMode('AUTO'), 'automatic')
  assert.equal(normalizeMachineAccessSprintMode('enabled'), 'enabled')
  assert.equal(normalizeMachineAccessSprintMode('enable'), 'enabled')
  assert.equal(normalizeMachineAccessSprintMode(true), 'enabled')
  assert.equal(normalizeMachineAccessSprintMode('disabled'), 'disabled')
  assert.equal(normalizeMachineAccessSprintMode('disable'), 'disabled')
  assert.equal(normalizeMachineAccessSprintMode(false), 'disabled')
  assert.equal(normalizeMachineAccessSprintMode('invalid-value'), 'automatic')
})

test('machine path ignores position jitter and falls back to walking on no net goal progress', () => {
  const startedAt = 1000
  const recovery = createMachinePathSprintRecovery({
    initialDistance: 68,
    now: startedAt
  })

  assert.equal(recovery.getState().mode, 'sprint')
  assert.equal(recovery.sample(67.4, startedAt + 4000).action, 'none')

  const decision = recovery.sample(68.2, startedAt + 5100)
  assert.equal(decision.action, 'restart-walk')
  assert.equal(decision.reason, 'sprint-no-net-progress')
  assert.equal(recovery.getState().mode, 'walk')
})

test('machine path retests sprint after walking progress and keeps it when the test advances', () => {
  const startedAt = 2000
  const recovery = createMachinePathSprintRecovery({
    initialDistance: 68,
    now: startedAt
  })

  recovery.sample(68, startedAt + 5100)
  const retest = recovery.sample(61, startedAt + 9200)
  assert.equal(retest.action, 'restart-sprint-test')
  assert.equal(recovery.getState().mode, 'sprint-test')

  const keep = recovery.sample(56, startedAt + 12800)
  assert.equal(keep.action, 'keep-sprint')
  assert.equal(keep.reason, 'sprint-test-progress')
  assert.equal(recovery.getState().mode, 'sprint')
})

test('machine path turns sprint back off when the sprint retest still has no net progress', () => {
  const startedAt = 3000
  const recovery = createMachinePathSprintRecovery({
    initialDistance: 68,
    now: startedAt
  })

  recovery.sample(68, startedAt + 5100)
  recovery.sample(61, startedAt + 9200)
  const fallback = recovery.sample(60, startedAt + 12800)

  assert.equal(fallback.action, 'restart-walk')
  assert.equal(fallback.reason, 'sprint-test-no-net-progress')
  assert.equal(recovery.getState().mode, 'walk')
})

test('machine path finishes a short walking route without an unnecessary sprint retest', () => {
  const startedAt = 4000
  const recovery = createMachinePathSprintRecovery({
    initialDistance: 12,
    startWithSprint: false,
    readyDistance: 2.25,
    now: startedAt
  })

  const decision = recovery.sample(5, startedAt + 5000)
  assert.equal(decision.action, 'none')
  assert.equal(recovery.getState().mode, 'walk')
})

test('intentional path interruption invalidates the active goto generation', () => {
  let stops = 0
  let clears = 0
  const bot = {
    pathfinder: {
      stop: () => { stops += 1 },
      setGoal: (goal) => {
        assert.equal(goal, null)
        clears += 1
      }
    }
  }

  const startedAt = getPathfinderAbortGeneration(bot)
  assert.equal(pathfinderRunWasAborted(bot, startedAt), false)
  const next = interruptPathfinder(bot)

  assert.equal(next, startedAt + 1)
  assert.equal(pathfinderRunWasAborted(bot, startedAt), true)
  assert.equal(stops, 1)
  assert.equal(clears, 1)
})
