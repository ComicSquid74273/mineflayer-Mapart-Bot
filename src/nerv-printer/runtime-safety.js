'use strict'

const SERVER_INVENTORY_EVENT = '__nervServerInventoryPacket'

function supportsFeature(bot, name) {
  try {
    return typeof bot?.supportFeature === 'function' && bot.supportFeature(name) === true
  } catch {
    return false
  }
}

function installServerInventoryTracker(bot) {
  if (bot?.__nervServerInventoryTracker) return bot.__nervServerInventoryTracker

  const tracker = {
    sequence: 0,
    stateIdByWindow: new Map(),
    rawSlotsByWindow: new Map(),
    windowItemsSequenceByWindow: new Map(),
    rawCursorItem: undefined,
    cursorSequence: null,
    recentEvents: [],
    dispose: () => {}
  }
  if (!bot) return tracker

  bot.__nervServerInventoryTracker = tracker
  const client = bot._client
  if (!client || typeof client.on !== 'function') return tracker

  const record = (type, packet = {}) => {
    const windowId = Number(packet.windowId)
    const stateId = Number(packet.stateId)
    tracker.sequence += 1
    if (Number.isFinite(windowId) && Number.isFinite(stateId)) {
      tracker.stateIdByWindow.set(windowId, stateId)
    }
    if (Number.isFinite(windowId)) {
      if (type === 'window_items' && Array.isArray(packet.items)) {
        tracker.rawSlotsByWindow.set(
          windowId,
          new Map(packet.items.map((item, slot) => [slot, item]))
        )
        tracker.windowItemsSequenceByWindow.set(windowId, tracker.sequence)
        if (Object.prototype.hasOwnProperty.call(packet, 'carriedItem')) {
          tracker.rawCursorItem = packet.carriedItem
          tracker.cursorSequence = tracker.sequence
        }
      } else if (type === 'set_slot' && Number.isFinite(Number(packet.slot))) {
        const slots = tracker.rawSlotsByWindow.get(windowId) || new Map()
        slots.set(Number(packet.slot), packet.item)
        tracker.rawSlotsByWindow.set(windowId, slots)
        if (windowId === -1 && Number(packet.slot) === -1) {
          tracker.rawCursorItem = packet.item
          tracker.cursorSequence = tracker.sequence
        }
      }
    }
    tracker.recentEvents.push({
      type,
      sequence: tracker.sequence,
      windowId,
      stateId,
      slot: Number(packet.slot),
      at: Date.now()
    })
    if (tracker.recentEvents.length > 32) tracker.recentEvents.splice(0, tracker.recentEvents.length - 32)
    if (typeof bot.emit === 'function') {
      bot.emit(SERVER_INVENTORY_EVENT, {
        type,
        packet,
        sequence: tracker.sequence,
        windowId,
        stateId
      })
    }
  }

  const onSetSlot = (packet) => record('set_slot', packet)
  const onWindowItems = (packet) => record('window_items', packet)
  client.on('set_slot', onSetSlot)
  client.on('window_items', onWindowItems)

  tracker.dispose = () => {
    client.removeListener?.('set_slot', onSetSlot)
    client.removeListener?.('window_items', onWindowItems)
  }
  bot.once?.('end', tracker.dispose)
  return tracker
}

function getAuthoritativeWindowSnapshotSequence(bot, window) {
  const tracker = installServerInventoryTracker(bot)
  const sequence = Number(tracker.windowItemsSequenceByWindow.get(Number(window?.id)))
  return Number.isFinite(sequence) ? sequence : null
}

function hasRawWindowSlotItem(bot, window, slot) {
  const tracker = installServerInventoryTracker(bot)
  const rawItem = getRawWindowSlotItem(bot, window, slot)
  if (rawItem === null || rawItem === undefined || rawItem?.present === false) return false
  if (Object.prototype.hasOwnProperty.call(rawItem, 'itemCount') && Number(rawItem.itemCount) <= 0) return false
  if (Object.prototype.hasOwnProperty.call(rawItem, 'count') && Number(rawItem.count) <= 0) return false
  return true
}

function getRawWindowSlotItem(bot, window, slot) {
  const tracker = installServerInventoryTracker(bot)
  return tracker.rawSlotsByWindow.get(Number(window?.id))?.get(Number(slot))
}

function rawInventoryItemIsPresent(rawItem) {
  if (rawItem === null || rawItem === undefined || rawItem?.present === false) return false
  if (Number(rawItem?.itemId) === -1 || Number(rawItem?.blockId) === -1) return false
  if (Object.prototype.hasOwnProperty.call(rawItem, 'itemCount') && Number(rawItem.itemCount) <= 0) return false
  if (Object.prototype.hasOwnProperty.call(rawItem, 'count') && Number(rawItem.count) <= 0) return false
  return true
}

function rawInventoryItemMatches(rawItem, itemId, count) {
  if (!rawInventoryItemIsPresent(rawItem)) return false
  const rawItemId = Number(rawItem?.itemId ?? rawItem?.blockId ?? rawItem?.type)
  const rawCount = Number(rawItem?.itemCount ?? rawItem?.count)
  return Number.isFinite(rawItemId) &&
    rawItemId === Number(itemId) &&
    Number.isFinite(rawCount) &&
    rawCount === Number(count)
}

function getAuthoritativeInventoryCursorState(bot) {
  const tracker = installServerInventoryTracker(bot)
  const sequence = Number(tracker.cursorSequence)
  const known = Number.isFinite(sequence)
  return {
    known,
    sequence: known ? sequence : null,
    empty: known ? !rawInventoryItemIsPresent(tracker.rawCursorItem) : false,
    rawItem: tracker.rawCursorItem
  }
}

async function clickWindowWithTrackedState(bot, window, slot, mouseButton = 0, mode = 0, options = {}) {
  if (typeof bot?.clickWindow !== 'function') throw new Error('Inventory click is unavailable.')

  const windowId = Number(window?.id)
  const tracker = installServerInventoryTracker(bot)
  const requestedStateId = Number(options.stateId)
  const trackedStateId = Number.isFinite(requestedStateId)
    ? requestedStateId
    : (Number.isFinite(windowId) ? Number(tracker.stateIdByWindow.get(windowId)) : NaN)
  const client = bot?._client
  if (
    !supportsFeature(bot, 'stateIdUsed') ||
    !Number.isFinite(trackedStateId) ||
    !client ||
    typeof client.write !== 'function'
  ) {
    const result = await bot.clickWindow(slot, mouseButton, mode)
    return { result, corrected: false, trackedStateId: null, outgoingStateId: null }
  }

  // Mineflayer keeps one module-level state id for every window. A player
  // inventory packet can therefore overwrite the id belonging to an open chest.
  // Scope the override to this single click and this exact window only.
  const originalWrite = client.write
  let corrected = false
  let outgoingStateId = null
  let outgoingChangedSlots = []
  const trackedWrite = function (name, params, ...rest) {
    if (name === 'window_click' && Number(params?.windowId) === windowId) {
      outgoingStateId = Number(params?.stateId)
      // A correct client prediction can be accepted silently, which leaves no
      // authoritative packet for the printer to prove that a logistics action
      // actually happened. The reference Nerv client deliberately sends its
      // predicted click with a stale revision so the server executes it and
      // replies with a full inventory state. Keep the exact prediction, but use
      // state -1 whenever the caller requires that authoritative response.
      const sentStateId = options.forceFullSync === true
        ? -1
        : (options.preserveOutgoingStateId === true ? outgoingStateId : trackedStateId)
      corrected = outgoingStateId !== sentStateId
      const changedSlotItems = options.changedSlotItems instanceof Map ? options.changedSlotItems : null
      const changedSlots = options.omitChangedSlots === true
        ? []
        : (Array.isArray(params.changedSlots)
            ? params.changedSlots.map((entry) => changedSlotItems?.has(Number(entry?.location))
              ? { ...entry, item: changedSlotItems.get(Number(entry.location)) }
              : entry)
            : params.changedSlots)
      outgoingChangedSlots = Array.isArray(changedSlots)
        ? changedSlots.map((entry) => Number(entry?.location)).filter(Number.isFinite)
        : []
      const nextParams = {
        ...params,
        stateId: sentStateId,
        changedSlots
      }
      if (Object.prototype.hasOwnProperty.call(options, 'cursorItem')) {
        nextParams.cursorItem = options.cursorItem
      }
      return originalWrite.call(client, name, nextParams, ...rest)
    }
    return originalWrite.call(client, name, params, ...rest)
  }

  client.write = trackedWrite
  try {
    const result = await bot.clickWindow(slot, mouseButton, mode)
    return { result, corrected, trackedStateId, outgoingStateId, outgoingChangedSlots }
  } finally {
    if (client.write === trackedWrite) client.write = originalWrite
  }
}

async function moveWindowSlotItemWithTrackedState(bot, window, sourceSlot, destinationSlot, options = {}) {
  const tracker = installServerInventoryTracker(bot)
  const windowId = Number(window?.id)
  const baselineSequence = tracker.sequence
  const ackWaitMs = Math.max(50, Number(options.ackWaitMs) || 750)
  const interClickDelayMs = Math.max(0, Number(options.interClickDelayMs) || 0)
  const rawSourceItem = options.preserveRawItem === true
    ? tracker.rawSlotsByWindow.get(windowId)?.get(Number(sourceSlot))
    : undefined
  let timer = null
  let onPacket = null
  const nextStatePromise = new Promise((resolve) => {
    const finish = (event = null) => {
      if (timer) clearTimeout(timer)
      timer = null
      if (onPacket) bot?.removeListener?.(SERVER_INVENTORY_EVENT, onPacket)
      onPacket = null
      resolve(event)
    }
    onPacket = (event) => {
      if (!event || event.sequence <= baselineSequence) return
      if (event.windowId !== windowId && event.windowId !== -1) return
      finish(event)
    }
    bot?.on?.(SERVER_INVENTORY_EVENT, onPacket)
    timer = setTimeout(() => finish(null), ackWaitMs)
  })

  try {
    const sourceClick = await clickWindowWithTrackedState(
      bot,
      window,
      sourceSlot,
      Number(options.sourceMouseButton) === 1 ? 1 : 0,
      0,
      {
        ...(rawSourceItem === undefined ? {} : { cursorItem: rawSourceItem }),
        forceFullSync: options.forceFullSync === true,
        omitChangedSlots: options.omitChangedSlots === true
      }
    )
    const nextStateEvent = await nextStatePromise
    // Some servers send the source-slot and cursor acknowledgements as separate
    // packets. Give the entire acknowledgement burst time to arrive before the
    // placement click, both to avoid click-throttle rejection and to use the
    // newest state id from that burst.
    if (interClickDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, interClickDelayMs))
    }
    const latestTrackedStateId = Number(tracker.stateIdByWindow.get(windowId))
    const acknowledgedStateId = Number(nextStateEvent?.stateId)
    const serverNextStateId = Number.isFinite(latestTrackedStateId) && latestTrackedStateId !== sourceClick.trackedStateId
      ? latestTrackedStateId
      : acknowledgedStateId
    // A correctly predicted container click may be accepted without any
    // set_slot/window_items response. Callers can choose whether that server
    // advances silent clicks; any observed acknowledgement remains authoritative.
    const fallbackNextStateId = Number.isFinite(sourceClick.trackedStateId) && options.advanceStateIdOnSilentAck === true
      ? sourceClick.trackedStateId + 1
      : sourceClick.trackedStateId
    const nextStateId = Number.isFinite(serverNextStateId) ? serverNextStateId : fallbackNextStateId
    const destinationClick = await clickWindowWithTrackedState(
      bot,
      window,
      destinationSlot,
      Number(options.destinationMouseButton) === 1 ? 1 : 0,
      0,
      {
        stateId: nextStateId,
        forceFullSync: options.forceFullSync === true,
        omitChangedSlots: options.omitChangedSlots === true,
        ...(rawSourceItem === undefined
          ? {}
          : { changedSlotItems: new Map([[Number(destinationSlot), rawSourceItem]]) })
      }
    )
    const observedEvents = tracker.recentEvents.filter((event) => event.sequence > baselineSequence)
    return {
      sourceClick,
      destinationClick,
      nextStateEvent,
      nextStateId,
      observedEvents,
      preservedRawItem: rawSourceItem !== undefined
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (onPacket) bot?.removeListener?.(SERVER_INVENTORY_EVENT, onPacket)
  }
}

async function quickMoveWindowSlotItemWithTrackedState(bot, window, sourceSlot, destinationSlot, options = {}) {
  const tracker = installServerInventoryTracker(bot)
  const windowId = Number(window?.id)
  const baselineSequence = tracker.sequence
  const rawSourceItem = options.preserveRawItem === true
    ? tracker.rawSlotsByWindow.get(windowId)?.get(Number(sourceSlot))
    : undefined
  const click = await clickWindowWithTrackedState(
    bot,
    window,
    sourceSlot,
    0,
    1,
    rawSourceItem === undefined
      ? {
          forceFullSync: options.forceFullSync === true,
          preserveOutgoingStateId: options.preserveOutgoingStateId === true,
          omitChangedSlots: options.omitChangedSlots === true
        }
      : {
          forceFullSync: options.forceFullSync === true,
          changedSlotItems: new Map([[Number(destinationSlot), rawSourceItem]]),
          preserveOutgoingStateId: options.preserveOutgoingStateId === true,
          omitChangedSlots: options.omitChangedSlots === true
        }
  )
  const observedEvents = tracker.recentEvents.filter((event) => event.sequence > baselineSequence)
  return {
    click,
    observedEvents,
    preservedRawItem: rawSourceItem !== undefined
  }
}

function createServerInventoryConfirmation(bot, options = {}) {
  const tracker = installServerInventoryTracker(bot)
  const expectedWindowId = Number(options.windowId ?? options.window?.id)
  const relevantSlots = new Set(
    (Array.isArray(options.slots) ? options.slots : [])
      .map(Number)
      .filter(Number.isFinite)
  )
  const timeoutMs = Math.max(50, Number(options.timeoutMs) || 3000)
  const label = String(options.label || 'inventory-action')
  const predicate = typeof options.predicate === 'function' ? options.predicate : () => true
  const baselineSequence = tracker.sequence
  const baselineStateId = Number.isFinite(expectedWindowId)
    ? tracker.stateIdByWindow.get(expectedWindowId)
    : undefined
  const requireStateIdChange = options.requireStateIdChange !== false &&
    supportsFeature(bot, 'stateIdUsed') &&
    Number.isFinite(baselineStateId)

  let done = false
  let timer = null
  let resolvePromise
  let rejectPromise

  const cleanup = () => {
    if (timer) clearTimeout(timer)
    timer = null
    bot?.removeListener?.(SERVER_INVENTORY_EVENT, onPacket)
  }
  const finishResolve = (value) => {
    if (done) return
    done = true
    cleanup()
    resolvePromise(value)
  }
  const finishReject = (error) => {
    if (done) return
    done = true
    cleanup()
    rejectPromise(error)
  }
  const packetMatches = (event) => {
    if (!event || event.sequence <= baselineSequence) return false
    // Cursor acknowledgements are sent as set_slot(windowId=-1, slot=-1),
    // independently from the open container slot update. A predicate that
    // proves both the container stack and an empty cursor must be re-evaluated
    // for that second authoritative packet or a successful click is reported
    // as a timeout. Keep this opt-in and accept only the protocol cursor slot;
    // unrelated player-inventory updates must not satisfy container actions.
    const isIncludedCursorUpdate = options.includeCursorUpdate === true &&
      event.type === 'set_slot' &&
      event.windowId === -1 &&
      Number(event.packet?.slot) === -1
    if (Number.isFinite(expectedWindowId) && event.windowId !== expectedWindowId && !isIncludedCursorUpdate) return false
    if (event.type === 'set_slot' && relevantSlots.size > 0 && !isIncludedCursorUpdate) {
      const slot = Number(event.packet?.slot)
      if (!relevantSlots.has(slot)) return false
    }
    if (requireStateIdChange && Number.isFinite(event.stateId) && event.stateId === baselineStateId) {
      return false
    }
    return true
  }
  const onPacket = (event) => {
    if (!packetMatches(event)) return
    queueMicrotask(() => {
      if (done) return
      try {
        if (predicate(event)) finishResolve(event)
      } catch (err) {
        finishReject(err)
      }
    })
  }

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  bot?.on?.(SERVER_INVENTORY_EVENT, onPacket)
  const startTimeout = () => {
    if (done || timer) return
    timer = setTimeout(() => {
      finishReject(new Error(`${label}: no matching server inventory update within ${timeoutMs}ms`))
    }, timeoutMs)
  }
  if (options.deferTimeout !== true) startTimeout()

  return {
    promise,
    startTimeout,
    cancel: () => {
      if (done) return
      done = true
      cleanup()
    }
  }
}

async function runWithServerInventoryConfirmation(bot, options, action) {
  const predicate = typeof options?.predicate === 'function' ? options.predicate : () => true

  // Older protocol versions have an explicit transaction response which Mineflayer
  // already waits for before clickWindow resolves.
  if (supportsFeature(bot, 'transactionPacketExists')) {
    await action()
    if (!predicate()) {
      throw new Error(`${options?.label || 'inventory-action'}: confirmed transaction did not reach the expected state`)
    }
    return { type: 'transaction' }
  }

  if (!bot?._client || typeof bot._client.on !== 'function' || typeof bot?.on !== 'function') {
    await action()
    if (!predicate()) {
      throw new Error(`${options?.label || 'inventory-action'}: expected inventory state was not reached`)
    }
    return { type: 'local-fallback' }
  }

  const confirmation = createServerInventoryConfirmation(bot, { ...options, deferTimeout: true })
  const actionTimeoutMs = Math.max(
    Number(options?.timeoutMs) || 3000,
    Number(options?.actionTimeoutMs) || 60000
  )
  let actionTimer = null
  try {
    const actionPromise = Promise.resolve().then(action)
    actionPromise.catch(() => {})
    await Promise.race([
      actionPromise,
      new Promise((resolve, reject) => {
        actionTimer = setTimeout(() => {
          reject(new Error(`${options?.label || 'inventory-action'}: action did not finish within ${actionTimeoutMs}ms`))
        }, actionTimeoutMs)
      })
    ])
    if (actionTimer) clearTimeout(actionTimer)
    actionTimer = null
    confirmation.startTimeout()
    return await confirmation.promise
  } catch (err) {
    if (actionTimer) clearTimeout(actionTimer)
    confirmation.cancel()
    throw err
  }
}

function getWindowInventorySlotIndices(window) {
  const slots = Array.isArray(window?.slots) ? window.slots : []
  const start = Number.isFinite(window?.inventoryStart) ? Math.max(0, window.inventoryStart) : 0
  const end = Number.isFinite(window?.inventoryEnd)
    ? Math.min(slots.length, window.inventoryEnd)
    : slots.length
  const result = []
  for (let slot = start; slot < end; slot += 1) result.push(slot)
  return result
}

function getBotInventorySlotForWindowSlot(window, inventory, windowSlot) {
  const sourceSlot = Number(windowSlot)
  const windowStart = Number(window?.inventoryStart)
  const windowEnd = Number(window?.inventoryEnd)
  const inventoryStart = Number(inventory?.inventoryStart)
  const inventoryEnd = Number(inventory?.inventoryEnd)
  if (![sourceSlot, windowStart, windowEnd, inventoryStart, inventoryEnd].every(Number.isFinite)) return -1
  if (sourceSlot < windowStart || sourceSlot >= windowEnd) return -1

  const targetSlot = inventoryStart + (sourceSlot - windowStart)
  if (targetSlot < inventoryStart || targetSlot >= inventoryEnd) return -1
  return targetSlot
}

// A container window is the most recent server-owned view of the player's inventory.
// Mineflayer can occasionally leave bot.inventory metadata stale after an anvil rename,
// even though the corresponding window slot already contains the server-confirmed name.
function reconcileWindowInventorySlot(bot, window, windowSlot, options = {}) {
  const authoritative = window?.slots?.[windowSlot]
  const inventory = bot?.inventory
  const botSlot = getBotInventorySlotForWindowSlot(window, inventory, windowSlot)
  if (!authoritative || botSlot < 0 || !Array.isArray(inventory?.slots)) {
    return { reconciled: false, botSlot }
  }

  const current = inventory.slots[botSlot]
  const sameItem = !current || (
    (current.type === authoritative.type || current.name === authoritative.name) &&
    Number(current.count) === Number(authoritative.count)
  )
  if (!sameItem && options.allowAuthoritativeReplacement !== true) {
    return { reconciled: false, botSlot }
  }

  // Window.updateSlot/copyInventory can consider two filled maps equal when
  // their type/count match even though their component-backed map_id changed.
  // Bypass that equality shortcut for this server-confirmed stack and give it
  // the player-inventory slot Mineflayer will use after the window closes.
  authoritative.slot = botSlot
  inventory.slots[botSlot] = authoritative
  return { reconciled: true, botSlot, item: authoritative }
}

function getConfiguredPlatformBounds(config) {
  const corner = config?.machine?.mapCorner
  const finiteNumber = (value) => value !== null && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null
  const cx = finiteNumber(corner?.x)
  const cy = finiteNumber(corner?.y)
  const cz = finiteNumber(corner?.z)
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) return null

  const width = finiteNumber(config?.machine?.mapSize?.width) ?? 128
  const height = finiteNumber(config?.machine?.mapSize?.height) ?? 128
  const margin = Math.max(0, finiteNumber(config?.advanced?.platformHorizontalMargin) ?? 30)
  const below = Math.max(0, finiteNumber(config?.advanced?.platformVerticalToleranceBelow) ?? 8)
  const above = Math.max(0, finiteNumber(config?.advanced?.platformVerticalToleranceAbove) ?? 12)

  return {
    minX: Math.min(cx, cx + width, cx - width) - margin,
    maxX: Math.max(cx, cx + width, cx - width) + margin,
    minY: Number.isFinite(cy) ? cy - below : null,
    maxY: Number.isFinite(cy) ? cy + above : null,
    minZ: Math.min(cz, cz + height, cz - height) - margin,
    maxZ: Math.max(cz, cz + height, cz - height) + margin
  }
}

function isPositionInsideBounds(pos, bounds) {
  if (!bounds || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return false
  if (pos.x < bounds.minX || pos.x > bounds.maxX || pos.z < bounds.minZ || pos.z > bounds.maxZ) return false
  if (Number.isFinite(bounds.minY) && (!Number.isFinite(pos.y) || pos.y < bounds.minY)) return false
  if (Number.isFinite(bounds.maxY) && (!Number.isFinite(pos.y) || pos.y > bounds.maxY)) return false
  return true
}

function areAllItemsVerified(items, predicate) {
  return Array.isArray(items) && items.length > 0 && items.every(predicate)
}

function getMissingFinishedMapRecovery() {
  return {
    failedStep: 'withdraw',
    postPrintCartographyComplete: false
  }
}

function getMachineAccessPathTimeoutMs(distance, configuredTimeoutMs) {
  const blocks = Number.isFinite(Number(distance)) ? Math.max(0, Number(distance)) : 0
  const distanceAwareDefault = Math.max(30000, Math.min(60000, 10000 + Math.ceil(blocks * 500)))
  const configured = Number(configuredTimeoutMs)
  return Math.max(5000, Number.isFinite(configured) ? configured : distanceAwareDefault)
}

function getWorkloadCheckpointMoveTimeoutMs(distance, configuredTimeoutMs, options = {}) {
  const blocks = Number.isFinite(Number(distance)) ? Math.max(0, Number(distance)) : 0
  const configured = Number(configuredTimeoutMs)
  const baseTimeoutMs = Math.max(1000, Number.isFinite(configured) ? configured : 30000)
  const configuredOverhead = Number(options.overheadMs)
  const configuredMsPerBlock = Number(options.msPerBlock)
  const configuredMaxTimeout = Number(options.maxTimeoutMs)
  const overheadMs = Math.max(0, Number.isFinite(configuredOverhead) ? configuredOverhead : 10000)
  const msPerBlock = Math.max(100, Number.isFinite(configuredMsPerBlock) ? configuredMsPerBlock : 500)
  const maxTimeoutMs = Math.max(baseTimeoutMs, Number.isFinite(configuredMaxTimeout) ? configuredMaxTimeout : 120000)
  const distanceAwareTimeoutMs = overheadMs + Math.ceil(blocks * msPerBlock)
  return Math.max(baseTimeoutMs, Math.min(maxTimeoutMs, distanceAwareTimeoutMs))
}

function shouldUseStraightWorkloadCheckpoint(action, enabled = true) {
  if (enabled === false) return false
  const normalizedAction = String(action || '')
  return normalizedAction === '' ||
    normalizedAction === 'inline-repair' ||
    normalizedAction === 'lineEnd' ||
    normalizedAction === 'sprint'
}

function normalizeCarpetSurfacePosition(bot, options = {}) {
  const position = bot?.entity?.position
  const Vec3 = position?.constructor
  if (!Vec3 || typeof bot?.blockAt !== 'function') return null
  if (![position.x, position.y, position.z].every(Number.isFinite)) return null

  const blockY = Math.floor(position.y)
  let block = null
  try {
    block = bot.blockAt(new Vec3(Math.floor(position.x), blockY, Math.floor(position.z)))
  } catch {
    return null
  }
  const name = String(block?.name || '')
  if (name !== 'carpet' && !name.endsWith('_carpet')) return null

  const surfaceY = blockY + Math.max(0.01, Number(options.carpetHeight) || (1 / 16))
  const tolerance = Math.max(0.001, Number(options.tolerance) || 0.002)
  if (position.y >= surfaceY - tolerance || position.y < blockY - tolerance) return null

  const previousY = position.y
  position.y = surfaceY
  if (bot.entity.velocity && Number(bot.entity.velocity.y) < 0) {
    bot.entity.velocity.y = 0
  }
  return {
    block,
    previousY,
    surfaceY
  }
}

function getLoadedBlock(bot, Vec3, x, y, z) {
  try {
    return bot.blockAt(new Vec3(x, y, z), false)
  } catch {
    return null
  }
}

function isAirBlockName(name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function isCarpetBlockName(name) {
  return name === 'carpet' || name.endsWith('_carpet')
}

function isLiquidOrLiftBlockName(name) {
  return name === 'water' || name === 'lava' || name === 'bubble_column'
}

function isLoadedSolidSupport(block) {
  const name = String(block?.name || '').replace(/^minecraft:/, '')
  if (!name || isAirBlockName(name) || isLiquidOrLiftBlockName(name) || isCarpetBlockName(name)) return false
  return block.boundingBox == null || block.boundingBox === 'block'
}

function isLoadedPassableCell(block) {
  const name = String(block?.name || '').replace(/^minecraft:/, '')
  if (!name || isLiquidOrLiftBlockName(name)) return false
  return isAirBlockName(name) || isCarpetBlockName(name) || block.boundingBox === 'empty'
}

/**
 * Resolve one safe cardinal step down from a server-settled /home position at
 * machine Y + 1. The current cell may be a full home pad, air over the normal
 * platform floor, or carpet. The destination must be a loaded passable cell
 * at machine Y with solid support and two blocks of headroom.
 */
function findSupportedUpperPlatformEgress(bot, expectedY, options = {}) {
  const position = bot?.entity?.position
  const Vec3 = position?.constructor
  const targetY = Number(expectedY)
  if (!Vec3 || typeof bot?.blockAt !== 'function' || !Number.isFinite(targetY)) return null
  if (![position.x, position.y, position.z].every(Number.isFinite)) return null
  if (bot.entity.onGround !== true) return null

  const heightTolerance = Math.max(0.01, Number(options.heightTolerance) || 0.125)
  if (Math.abs(position.y - (targetY + 1)) > heightTolerance) return null

  const x = Math.floor(position.x)
  const z = Math.floor(position.z)
  const floorY = Math.floor(targetY)
  const surface = getLoadedBlock(bot, Vec3, x, floorY, z)
  const support = getLoadedBlock(bot, Vec3, x, floorY - 1, z)
  const currentSurfaceIsSafe = isLoadedSolidSupport(surface) ||
    (isLoadedPassableCell(surface) && isLoadedSolidSupport(support))
  if (!currentSurfaceIsSafe) return null

  const currentFeet = getLoadedBlock(bot, Vec3, x, floorY + 1, z)
  const currentHead = getLoadedBlock(bot, Vec3, x, floorY + 2, z)
  if (!isLoadedPassableCell(currentFeet) || !isLoadedPassableCell(currentHead)) return null

  const preferred = options.preferredPoint
  const candidates = [
    { x: x + 1, z },
    { x: x - 1, z },
    { x, z: z + 1 },
    { x, z: z - 1 }
  ]
  if (Number.isFinite(Number(preferred?.x)) && Number.isFinite(Number(preferred?.z))) {
    candidates.sort((a, b) => {
      const distanceA = (a.x + 0.5 - Number(preferred.x)) ** 2 + (a.z + 0.5 - Number(preferred.z)) ** 2
      const distanceB = (b.x + 0.5 - Number(preferred.x)) ** 2 + (b.z + 0.5 - Number(preferred.z)) ** 2
      return distanceA - distanceB
    })
  }

  for (const candidate of candidates) {
    const point = { x: candidate.x + 0.5, y: targetY, z: candidate.z + 0.5 }
    if (typeof options.isCandidateAllowed === 'function' && !options.isCandidateAllowed(point)) continue

    const foot = getLoadedBlock(bot, Vec3, candidate.x, floorY, candidate.z)
    const landingSupport = getLoadedBlock(bot, Vec3, candidate.x, floorY - 1, candidate.z)
    const head = getLoadedBlock(bot, Vec3, candidate.x, floorY + 1, candidate.z)
    const head2 = getLoadedBlock(bot, Vec3, candidate.x, floorY + 2, candidate.z)
    if (!isLoadedPassableCell(foot) || !isLoadedSolidSupport(landingSupport)) continue
    if (!isLoadedPassableCell(head) || !isLoadedPassableCell(head2)) continue

    return {
      surface,
      support,
      egress: { point, foot, support: landingSupport, head, head2 },
      currentY: position.y,
      expectedY: targetY,
      verticalDistance: Math.abs(position.y - targetY)
    }
  }

  return null
}

function getIncompleteCartographyResumeStep(resumeStep, hasFilledMap, postPrintSteps = []) {
  const steps = Array.isArray(postPrintSteps) ? postPrintSteps : []
  const resumeIndex = steps.indexOf(resumeStep)
  const cartographyIndex = steps.indexOf('cartography')
  if (resumeIndex < 0 || cartographyIndex < 0 || resumeIndex < cartographyIndex) return resumeStep
  return hasFilledMap ? 'cartography' : 'withdraw'
}

function buildPostPrintRuntimeCheckpoint(postPrintStep, action = 'post-print-active', meta = {}, postPrintStartedAt = null) {
  const checkpointMeta = {
    ...(meta && typeof meta === 'object' ? meta : {}),
    postPrintStep: String(postPrintStep || 'withdraw')
  }
  if (postPrintStartedAt) checkpointMeta.postPrintStartedAt = postPrintStartedAt
  return {
    phase: 'post_print',
    action: String(action || 'post-print-active'),
    meta: checkpointMeta
  }
}

function normalizeMachineAccessSprintMode(value) {
  if (value === true) return 'enabled'
  if (value === false) return 'disabled'

  const mode = String(value ?? '').trim().toLowerCase()
  if (['enabled', 'enable', 'on', 'always', 'true'].includes(mode)) return 'enabled'
  if (['disabled', 'disable', 'off', 'never', 'false'].includes(mode)) return 'disabled'
  return 'automatic'
}

function createMachinePathSprintRecovery(options = {}) {
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
  const initialDistance = Math.max(0, numberOr(options.initialDistance, 0))
  const readyDistance = Math.max(0, numberOr(options.readyDistance, 2.25))
  const progressStep = Math.max(0.1, numberOr(options.progressStep, 1))
  const sprintStallMs = Math.max(500, numberOr(options.sprintStallMs, 5000))
  const walkStallMs = Math.max(500, numberOr(options.walkStallMs, 8000))
  const walkRetestAfterMs = Math.max(500, numberOr(options.walkRetestAfterMs, 4000))
  const walkRetestProgress = Math.max(progressStep, numberOr(options.walkRetestProgress, 6))
  const sprintTestMs = Math.max(500, numberOr(options.sprintTestMs, 3500))
  const sprintTestProgress = Math.max(progressStep, numberOr(options.sprintTestProgress, 3))
  const sprintRetestMinRemaining = Math.max(0, numberOr(options.sprintRetestMinRemaining, 6))
  const sprintAllowed = options.sprintAllowed !== false
  const startedAt = numberOr(options.now, Date.now())

  let mode = sprintAllowed && options.startWithSprint !== false ? 'sprint' : 'walk'
  let modeStartedAt = startedAt
  let modeStartDistance = initialDistance
  let progressAnchorDistance = initialDistance
  let lastProgressAt = startedAt

  const snapshot = () => ({
    mode,
    modeStartedAt,
    modeStartDistance,
    progressAnchorDistance,
    lastProgressAt
  })

  const transition = (nextMode, distance, now, action, reason, details = {}) => {
    const previousMode = mode
    mode = nextMode
    modeStartedAt = now
    modeStartDistance = distance
    progressAnchorDistance = distance
    lastProgressAt = now
    return {
      action,
      reason,
      previousMode,
      mode,
      distance,
      ...details
    }
  }

  const sample = (distanceValue, nowValue = Date.now(), context = {}) => {
    const distance = Number(distanceValue)
    const now = numberOr(nowValue, Date.now())
    if (!Number.isFinite(distance)) return { action: 'none', mode }
    if (distance <= readyDistance) return { action: 'none', mode }

    if (distance <= progressAnchorDistance - progressStep) {
      progressAnchorDistance = distance
      lastProgressAt = now
    }

    const modeElapsedMs = Math.max(0, now - modeStartedAt)
    const noProgressMs = Math.max(0, now - lastProgressAt)
    const netProgress = Math.max(0, modeStartDistance - distance)

    if (mode === 'sprint' && noProgressMs >= sprintStallMs) {
      return transition('walk', distance, now, 'restart-walk', 'sprint-no-net-progress', {
        noProgressMs,
        netProgress
      })
    }

    if (mode === 'walk') {
      const sprintAvailable = context.sprintAvailable !== false
      const enoughRouteRemaining = distance > readyDistance + sprintRetestMinRemaining
      if (
        sprintAllowed &&
        sprintAvailable &&
        enoughRouteRemaining &&
        modeElapsedMs >= walkRetestAfterMs &&
        netProgress >= walkRetestProgress
      ) {
        return transition('sprint-test', distance, now, 'restart-sprint-test', 'walk-progress-sprint-retest', {
          modeElapsedMs,
          netProgress
        })
      }

      if (noProgressMs >= walkStallMs) {
        return transition('walk', distance, now, 'restart-walk', 'walk-no-net-progress', {
          noProgressMs,
          netProgress
        })
      }
    }

    if (mode === 'sprint-test' && modeElapsedMs >= sprintTestMs) {
      if (netProgress >= sprintTestProgress) {
        return transition('sprint', distance, now, 'keep-sprint', 'sprint-test-progress', {
          modeElapsedMs,
          netProgress
        })
      }
      return transition('walk', distance, now, 'restart-walk', 'sprint-test-no-net-progress', {
        modeElapsedMs,
        netProgress
      })
    }

    return {
      action: 'none',
      mode,
      distance,
      modeElapsedMs,
      noProgressMs,
      netProgress
    }
  }

  return {
    sample,
    getState: snapshot
  }
}

function getPathfinderAbortGeneration(bot) {
  const value = Number(bot?.__nervPathfinderAbortGeneration)
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function interruptPathfinder(bot) {
  const generation = getPathfinderAbortGeneration(bot) + 1
  if (bot) bot.__nervPathfinderAbortGeneration = generation
  try { bot?.pathfinder?.stop?.() } catch { }
  try { bot?.pathfinder?.setGoal?.(null) } catch { }
  return generation
}

function resolvePathGoalBeforeInterrupt(resolve, bot) {
  resolve()
  queueMicrotask(() => interruptPathfinder(bot))
}

function pathfinderRunWasAborted(bot, startingGeneration) {
  return getPathfinderAbortGeneration(bot) !== Number(startingGeneration)
}

function isPathfinderStoppedError(error) {
  const name = String(error?.name || '').toLowerCase()
  const message = String(error?.message || error || '').toLowerCase()
  return name === 'pathstopped' || message.includes('path was stopped before it could be completed')
}

function pathfinderStopWasUnowned(bot, startingGeneration, error) {
  return isPathfinderStoppedError(error) && !pathfinderRunWasAborted(bot, startingGeneration)
}

function getRuntimeWorldGenerationBoundary(config) {
  const rawGeneration = config?.__runtimeWorldGenerationAtRun
  if (rawGeneration == null || rawGeneration === '') return null
  const generation = Number(rawGeneration)
  return Number.isFinite(generation) ? Math.max(0, Math.floor(generation)) : null
}

function hasPendingRuntimeWorldChange(bot, config) {
  if (bot?.__nervRuntimeWorldChangePending === true) return true
  const runGeneration = getRuntimeWorldGenerationBoundary(config)
  const currentGeneration = Number(bot?.__nervRuntimeWorldGeneration)
  return runGeneration != null &&
    Number.isFinite(currentGeneration) &&
    runGeneration !== Math.floor(currentGeneration)
}

function isServerInventoryConfirmationTimeout(error, label = '') {
  const message = String(error?.message || error || '').toLowerCase()
  const expectedLabel = String(label || '').trim().toLowerCase()
  if (!message.includes('no matching server inventory update within')) return false
  return !expectedLabel || message.includes(`${expectedLabel}:`)
}

function isPlatformStallRecoveryExcluded(progress) {
  const text = [
    progress?.phase,
    progress?.state,
    progress?.action,
    progress?.postPrintStep
  ].map((value) => String(value || '').trim().toLowerCase()).join('|')
  return [
    'waiting-food-stock',
    'waiting-map-pane-stock',
    'waiting-material-restock',
    'waiting-finished-map-chest-space',
    'required-stock',
    'multi-',
    'barrier',
    'operator',
    'paused',
    'platform-recovery',
    'waiting-platform'
  ].some((token) => text.includes(token))
}

function getPlatformStallRecoveryReason(progress, stalledMs, options = {}) {
  if (!progress || isPlatformStallRecoveryExcluded(progress)) return null
  const elapsedMs = Math.max(0, Number(stalledMs) || 0)
  const blockedTimeoutMs = Math.max(1000, Number(options.blockedTimeoutMs) || 120000)
  const activeTimeoutMs = Math.max(blockedTimeoutMs, Number(options.activeTimeoutMs) || 300000)
  const fields = [progress.state, progress.action, progress.postPrintStep]
    .map((value) => String(value || '').trim().toLowerCase())
  const blocked = fields.find((value) => value.startsWith('blocked-'))
  if (blocked && elapsedMs >= blockedTimeoutMs) {
    return `platform-stall-${blocked.replace(/[^a-z0-9-]+/g, '-')}`
  }
  const phase = String(progress.phase || '').trim().toLowerCase().replace('-', '_')
  if (['printing', 'repair', 'post_print'].includes(phase) && elapsedMs >= activeTimeoutMs) {
    return 'platform-stall-active-work'
  }
  return null
}

function getPostPrintTravelSafety(healthValue, hungerValue, options = {}) {
  const clamp = (value, fallback) => {
    const parsed = value == null ? NaN : Number(value)
    return Math.max(0, Math.min(20, Number.isFinite(parsed) ? parsed : fallback))
  }
  const healthThreshold = clamp(options.healthThreshold, 12)
  const hungerThreshold = clamp(options.hungerThreshold, 12)
  const health = healthValue == null ? NaN : Number(healthValue)
  const hunger = hungerValue == null ? NaN : Number(hungerValue)
  const lowHealth = Number.isFinite(health) && health <= healthThreshold
  const lowHunger = Number.isFinite(hunger) && hunger <= hungerThreshold
  return {
    safe: !lowHealth && !lowHunger,
    lowHealth,
    lowHunger,
    health: Number.isFinite(health) ? health : null,
    hunger: Number.isFinite(hunger) ? hunger : null,
    healthThreshold,
    hungerThreshold
  }
}

function shouldResumeBlockedPostPrintAfterFood(failureCode, foodReady, safety) {
  return failureCode === 'food-travel-safety' &&
    foodReady === true &&
    safety?.health != null &&
    safety?.hunger != null &&
    safety?.safe === true
}

module.exports = {
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
  getWindowInventorySlotIndices,
  getBotInventorySlotForWindowSlot,
  reconcileWindowInventorySlot,
  getConfiguredPlatformBounds,
  isPositionInsideBounds,
  areAllItemsVerified,
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
}
