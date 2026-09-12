// Bundle and chest transfer operations for the delivery bot.
//
// Zero-loss rules enforced here:
// - every window click is verified by re-reading slots/cursor afterwards,
// - map movement is counted from verified chest-slot deltas,
// - the cursor must be empty before any window is closed,
// - no drop/toss API is ever used.
//
// Bundle click semantics used by the EvMod mapart keybind:
// pick up a bundle, then click map slots with the bundle on the cursor.
// Mineflayer can mispredict this special case, so every click is verified and
// bundle/map swaps are undone before the window may close.

const FILLED_MAP = 'filled_map'
const EMPTY_MAP = 'map'
const BUNDLE_CONTENT_COMPONENT_IDS = new Set(['30', '40', '41', '48'])

function stripNamespace(name) {
  return String(name || '').replace(/^minecraft:/, '')
}

function simplifyNbtNode(node) {
  if (node == null) return null
  if (typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(simplifyNbtNode)
  if ('type' in node && 'value' in node) {
    if (node.type === 'list') return simplifyNbtNode(node.value?.value ?? node.value)
    if (node.type === 'compound') return simplifyNbtNode(node.value)
    return simplifyNbtNode(node.value)
  }
  const out = {}
  for (const key of Object.keys(node)) out[key] = simplifyNbtNode(node[key])
  return out
}

function registryItemName(registry, id) {
  if (!registry || id == null) return ''
  const numeric = Number(id)
  if (!Number.isFinite(numeric)) return ''
  return stripNamespace(registry.items?.[numeric]?.name || '')
}

function storedItemName(stored, registry) {
  const candidates = [
    stored?.name,
    stored?.id,
    stored?.itemName,
    stored?.itemId,
    stored?.type,
    stored?.item?.name,
    stored?.item?.id,
    stored?.item?.itemName,
    stored?.item?.itemId,
    stored?.item?.type
  ]
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue
    if (typeof candidate === 'number') {
      const fromRegistry = registryItemName(registry, candidate)
      if (fromRegistry) return fromRegistry
      continue
    }
    const text = stripNamespace(candidate)
    if (/^\d+$/.test(text)) {
      const fromRegistry = registryItemName(registry, Number(text))
      if (fromRegistry) return fromRegistry
    }
    if (text) return text
  }
  return ''
}

function storedItemCount(stored) {
  return Number(stored?.itemCount ?? stored?.count ?? stored?.Count ?? stored?.item?.itemCount ?? stored?.item?.count ?? 1) || 1
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value
  }
  return null
}

function componentDataList(component) {
  if (!component) return null
  const data = component.data
  const value = component.value
  return firstArray(
    data?.contents,
    data?.value?.contents,
    data?.value,
    data?.items,
    data,
    value?.contents,
    value?.value?.contents,
    value?.value,
    value?.items,
    value,
    component.contents,
    component.items
  )
}

function bundleContentsComponents(item) {
  const components = []
  if (item?.componentMap?.get) {
    const mapped = item.componentMap.get('bundle_contents') || item.componentMap.get('minecraft:bundle_contents')
    if (mapped) components.push(mapped)
    for (const id of BUNDLE_CONTENT_COMPONENT_IDS) {
      const numericMapped = item.componentMap.get(Number(id)) || item.componentMap.get(id)
      if (numericMapped) components.push(numericMapped)
    }
    try {
      for (const component of item.componentMap.values()) components.push(component)
    } catch { }
  }
  if (Array.isArray(item?.components)) components.push(...item.components)
  return components
}

function isBundleContentsComponent(component) {
  const type = component?.type ?? component?.name ?? component?.id
  const text = stripNamespace(type)
  return text === 'bundle_contents' || BUNDLE_CONTENT_COMPONENT_IDS.has(text)
}

// Returns [{ name, count }] for the items stored inside a bundle item stack.
function readBundleContents(item, registry = null) {
  if (!item) return []

  // 1.20.5+ component format. Nested bundle contents are protocol Slot
  // objects, so itemId is numeric and needs the bot registry to resolve names.
  for (const component of bundleContentsComponents(item)) {
    if (!isBundleContentsComponent(component)) continue
    const list = componentDataList(component)
    if (Array.isArray(list)) {
      return list
        .map((stored) => ({
          name: storedItemName(stored, registry) || 'unknown',
          count: storedItemCount(stored)
        }))
        .filter((stored) => stored.count > 0)
    }
  }

  const nbt = simplifyNbtNode(item.nbt)
  const items = nbt?.Items || nbt?.items
  if (!Array.isArray(items)) return []
  return items
    .map((stored) => ({
      name: storedItemName({ id: stored?.id || stored?.item }, registry) || 'unknown',
      count: Number(stored?.Count ?? stored?.count ?? 1) || 1
    }))
    .filter((stored) => stored.count > 0)
}

function countBundleItems(item, registry = null) {
  return readBundleContents(item, registry).reduce((sum, stored) => sum + stored.count, 0)
}

function countBundleMaps(item, registry = null) {
  return readBundleContents(item, registry)
    .filter((stored) => stored.name === FILLED_MAP)
    .reduce((sum, stored) => sum + stored.count, 0)
}

function bundleContainsOnlyMaps(item, registry = null) {
  const contents = readBundleContents(item, registry)
  return contents.every((stored) => stored.name === FILLED_MAP)
}

function isBundleItem(item, bundleItemName = 'bundle') {
  if (!item) return false
  const name = stripNamespace(item.name)
  return name === bundleItemName || name.endsWith('_bundle')
}

function isEmptyBundle(item, bundleItemName = 'bundle', registry = null) {
  return isBundleItem(item, bundleItemName) && countBundleItems(item, registry) === 0
}

// filled_map stacks to 64 -> weight 1 per map -> capacity == 64 per bundle.
// Unknown contents are counted with weight 1 too (conservative).
function bundleFreeCapacity(item, capacity = 64, registry = null) {
  const max = Math.max(1, Number(capacity) || 64)
  return Math.max(0, max - countBundleItems(item, registry))
}

function windowContainerRange(window) {
  const start = Number.isFinite(window?.inventoryStart) ? window.inventoryStart : 0
  return { start: 0, end: Math.max(0, start - 1) }
}

function windowInventoryRange(window) {
  const start = Number.isFinite(window?.inventoryStart) ? window.inventoryStart : 0
  const end = Number.isFinite(window?.inventoryEnd) ? window.inventoryEnd : (window?.slots?.length || 1) - 1
  return { start, end }
}

function findContainerSlots(window, predicate) {
  const { start, end } = windowContainerRange(window)
  const found = []
  for (let i = start; i <= end; i += 1) {
    const stack = window?.slots?.[i]
    if (stack && Number(stack.count) > 0 && predicate(stack)) found.push(i)
  }
  return found
}

function findInventorySlots(window, predicate) {
  const { start, end } = windowInventoryRange(window)
  const found = []
  for (let i = start; i <= end; i += 1) {
    const stack = window?.slots?.[i]
    if (stack && Number(stack.count) > 0 && predicate(stack)) found.push(i)
  }
  return found
}

function countWindowContainerItems(window, itemName) {
  return findContainerSlots(window, (stack) => stripNamespace(stack.name) === itemName)
    .reduce((sum, slot) => sum + Number(window.slots[slot].count || 0), 0)
}

function countEmptyInventorySlotsInWindow(window) {
  const { start, end } = windowInventoryRange(window)
  let empty = 0
  for (let i = start; i <= end; i += 1) {
    const stack = window?.slots?.[i]
    if (!stack || Number(stack.count) <= 0) empty += 1
  }
  return empty
}

// Inventory-wide map census without an open container (uses bot.inventory).
function countCarriedMaps(bot, bundleItemName = 'bundle') {
  let loose = 0
  let inBundles = 0
  for (const item of bot?.inventory?.items?.() || []) {
    if (stripNamespace(item.name) === FILLED_MAP) loose += Number(item.count) || 0
    else if (isBundleItem(item, bundleItemName)) inBundles += countBundleMaps(item, bot?.registry)
  }
  return { loose, inBundles, total: loose + inBundles }
}

function countCarriedBundles(bot, bundleItemName = 'bundle', capacity = 64) {
  let empty = 0
  let filled = 0
  let withFreeSpace = 0
  for (const item of bot?.inventory?.items?.() || []) {
    if (!isBundleItem(item, bundleItemName)) continue
    const bundleCount = Math.max(1, Number(item.count) || 1)
    const used = countBundleItems(item, bot?.registry)
    if (used === 0) empty += bundleCount
    else filled += bundleCount
    if (bundleFreeCapacity(item, capacity, bot?.registry) > 0) withFreeSpace += bundleCount
  }
  return { empty, filled, total: empty + filled, withFreeSpace }
}

function createBundleOps(deps) {
  const {
    toNumber,
    delay,
    openContainerAt,
    waitForWindowSlot,
    assertWindowCursorEmpty,
    waitForWindowCursorEmpty,
    getWindowCursorItem,
    waitBotTicks,
    log = console.log
  } = deps

  const CONTAINER_NAMES = ['chest', 'trapped_chest', 'barrel']

  function settings(config) {
    const bundles = config?.delivery?.bundles || {}
    const chests = config?.delivery?.chests || {}
    const stowButtonText = String(bundles.stowMouseButton || '').toLowerCase()
    const stowMouseButton = stowButtonText === 'right' ? 1 : (stowButtonText === 'left' ? 0 : (toNumber(bundles.stowMouseButton, 0) === 1 ? 1 : 0))
    return {
      bundlesEnabled: bundles.enabled !== false,
      bundleItemName: stripNamespace(bundles.itemName || 'bundle'),
      mapsPerBundle: Math.max(1, toNumber(bundles.mapsPerBundle, 64)),
      maxBundlesToCarry: Math.max(1, toNumber(bundles.maxBundlesToCarry, 18)),
      minEmptyBundles: Math.max(0, toNumber(bundles.minEmptyBundles, 4)),
      restockTo: Math.max(1, toNumber(bundles.restockTo, 8)),
      bundlesPerTarget: Math.max(1, toNumber(bundles.bundlesPerTarget, 5)),
      allowLooseMapDeposit: bundles.allowLooseMapDeposit === true || bundles.depositLooseMaps === true,
      stowMouseButton,
      openTimeoutMs: Math.max(1000, toNumber(chests.openTimeoutMs, 8000)),
      openAttempts: Math.max(1, toNumber(chests.openAttempts, 4)),
      actionDelayMs: Math.max(30, toNumber(chests.actionDelayMs, 120)),
      verifyTimeoutMs: Math.max(500, toNumber(chests.verifyTimeoutMs, 4000)),
      verifyPollMs: Math.max(25, toNumber(chests.verifyPollMs, 100))
    }
  }

  function bundleBudget(opts, options = {}) {
    const targetCount = Math.max(0, Math.floor(toNumber(options.targetCount, 0)))
    const targetBudget = targetCount > 0 ? targetCount * opts.bundlesPerTarget : opts.restockTo
    const desired = Math.max(opts.minEmptyBundles, targetBudget)
    return Math.max(1, Math.min(opts.maxBundlesToCarry, desired))
  }

  function countWindowInventoryBundles(window, opts, registry = null) {
    let empty = 0
    let filled = 0
    let withFreeSpace = 0
    for (const slot of findInventorySlots(window, (stack) => isBundleItem(stack, opts.bundleItemName))) {
      const stack = window.slots[slot]
      const bundleCount = Math.max(1, toNumber(stack?.count, 1))
      const used = countBundleItems(stack, registry)
      if (used === 0) empty += bundleCount
      else filled += bundleCount
      if (bundleFreeCapacity(stack, opts.mapsPerBundle, registry) > 0) withFreeSpace += bundleCount
    }
    return { empty, filled, total: empty + filled, withFreeSpace }
  }

  function countSingleUsableBundleSlots(window, opts, registry = null) {
    return findInventorySlots(window, (stack) => {
      if (!isBundleItem(stack, opts.bundleItemName)) return false
      if (Math.max(1, toNumber(stack.count, 1)) !== 1) return false
      if (!bundleContainsOnlyMaps(stack, registry)) return false
      return bundleFreeCapacity(stack, opts.mapsPerBundle, registry) > 0
    }).length
  }

  function inventoryEmptySlots(window) {
    const { start, end } = windowInventoryRange(window)
    const slots = []
    for (let i = start; i <= end; i += 1) {
      const stack = window?.slots?.[i]
      if (!stack || toNumber(stack.count, 0) <= 0) slots.push(i)
    }
    return slots
  }

  async function openStationChest(bot, position, openPosition, options = {}) {
    return await openContainerAt(bot, position, openPosition, {
      expectedNames: CONTAINER_NAMES,
      timeoutMs: options.timeoutMs,
      attempts: options.attempts,
      blockWaitMs: Math.max(5000, toNumber(options.timeoutMs, 8000)),
      reason: options.reason || 'delivery-chest',
      // Never pass config here: gotoConfiguredAccess would run the printer
      // platform assertion, which does not apply to delivery navigation.
      config: null
    })
  }

  async function closeWindow(bot, window, reason) {
    await assertWindowCursorEmpty(window, reason)
    try { window.close() } catch { }
    try { if (bot.currentWindow === window) bot.closeWindow(window) } catch { }
  }

  async function waitForCursorBundle(window, opts, reason) {
    const cursor = await (async () => {
      let elapsed = 0
      const timeout = Math.max(500, opts.verifyTimeoutMs)
      const poll = Math.max(25, opts.verifyPollMs)
      while (elapsed <= timeout) {
        const item = getWindowCursorItem(window)
        if (isBundleItem(item, opts.bundleItemName)) return item
        await delay(poll)
        elapsed += poll
      }
      return getWindowCursorItem(window)
    })()
    if (!isBundleItem(cursor, opts.bundleItemName)) {
      throw new Error(`${reason}: expected bundle on cursor, found ${cursor?.name || 'empty'}`)
    }
    return cursor
  }

  async function returnHeldBundle(bot, window, bundleSlot, opts, reason) {
    const cursor = getWindowCursorItem(window)
    if (!isBundleItem(cursor, opts.bundleItemName)) return

    const candidates = [bundleSlot, ...inventoryEmptySlots(window).filter((slot) => slot !== bundleSlot)]
    for (const targetSlot of candidates.slice(0, 3)) {
      const target = window.slots?.[targetSlot]
      if (target && toNumber(target.count, 0) > 0) continue

      await bot.clickWindow(targetSlot, 0, 0)
      await waitBotTicks(bot, 3)
      const returned = await waitForWindowSlot(
        window,
        targetSlot,
        (entry) => isBundleItem(entry, opts.bundleItemName) && !getWindowCursorItem(window),
        opts.verifyTimeoutMs,
        opts.verifyPollMs
      )
      if (returned && !getWindowCursorItem(window)) return
    }

    throw new Error(`${reason}: delivery-safety-bundle-cursor-stuck after return attempts`)
  }

  async function moveOneBundleStackItem(bot, window, sourceSlot, targetSlot, opts, reason) {
    const source = window.slots?.[sourceSlot]
    if (!isEmptyBundle(source, opts.bundleItemName, bot?.registry)) {
      throw new Error(`${reason}: source slot ${sourceSlot} is not an empty bundle stack`)
    }
    const target = window.slots?.[targetSlot]
    if (target && toNumber(target.count, 0) > 0) {
      throw new Error(`${reason}: target slot ${targetSlot} is not empty`)
    }
    const beforeSource = Math.max(0, toNumber(source.count, 0))
    if (beforeSource <= 0) return false

    await assertWindowCursorEmpty(window, `${reason}:pickup`)
    await bot.clickWindow(sourceSlot, 0, 0)
    await waitBotTicks(bot, 2)
    if (!isBundleItem(getWindowCursorItem(window), opts.bundleItemName)) {
      throw new Error(`${reason}: expected bundle stack on cursor after pickup`)
    }

    if (beforeSource === 1) {
      await bot.clickWindow(targetSlot, 0, 0)
    } else {
      await bot.clickWindow(targetSlot, 1, 0)
      await waitBotTicks(bot, 2)
      await waitForWindowSlot(
        window,
        targetSlot,
        (entry) => isEmptyBundle(entry, opts.bundleItemName, bot?.registry) && toNumber(entry.count, 0) === 1,
        opts.verifyTimeoutMs,
        opts.verifyPollMs
      )
      await bot.clickWindow(sourceSlot, 0, 0)
    }

    await waitBotTicks(bot, 2)
    const cursorEmpty = await waitForWindowCursorEmpty(window, opts.verifyTimeoutMs, opts.verifyPollMs)
    if (!cursorEmpty) throw new Error(`${reason}: cursor not empty after moving one bundle`)

    const expectedSource = beforeSource - 1
    await waitForWindowSlot(
      window,
      sourceSlot,
      (entry) => expectedSource <= 0
        ? (!entry || toNumber(entry.count, 0) <= 0)
        : isEmptyBundle(entry, opts.bundleItemName, bot?.registry) && toNumber(entry.count, 0) === expectedSource,
      opts.verifyTimeoutMs,
      opts.verifyPollMs
    )
    await waitForWindowSlot(
      window,
      targetSlot,
      (entry) => isEmptyBundle(entry, opts.bundleItemName, bot?.registry) && toNumber(entry.count, 0) === 1,
      opts.verifyTimeoutMs,
      opts.verifyPollMs
    )
    return true
  }

  async function splitEmptyBundleStacks(bot, window, opts, desiredSingleSlots) {
    let split = 0
    while (countSingleUsableBundleSlots(window, opts, bot?.registry) < desiredSingleSlots) {
      const emptyTargets = inventoryEmptySlots(window)
      if (!emptyTargets.length) break
      const stackSlot = findInventorySlots(window, (stack) => {
        if (!isEmptyBundle(stack, opts.bundleItemName, bot?.registry)) return false
        return toNumber(stack.count, 0) > 1
      })[0]
      if (stackSlot == null) break
      const moved = await moveOneBundleStackItem(bot, window, stackSlot, emptyTargets[0], opts, `delivery-split-bundle slot=${stackSlot}`)
      if (!moved) break
      split += 1
      await delay(opts.actionDelayMs)
    }
    return split
  }

  async function returnEmptyBundleStackToChest(bot, window, slot, opts) {
    const before = Math.max(0, toNumber(window.slots?.[slot]?.count, 0))
    if (before <= 0) return 0
    await assertWindowCursorEmpty(window, `delivery-return-extra-bundles slot=${slot}`)
    await bot.clickWindow(slot, 0, 1)
    await waitForWindowSlot(
      window,
      slot,
      (entry) => !entry || toNumber(entry.count, 0) < before,
      opts.verifyTimeoutMs,
      opts.verifyPollMs
    )
    const after = Math.max(0, toNumber(window.slots?.[slot]?.count, 0))
    if (after >= before) {
      log('[DELIVERY-WARN] bundles chest is full; keeping extra empty bundles in delivery inventory')
      return 0
    }
    await waitForWindowCursorEmpty(window, opts.verifyTimeoutMs, opts.verifyPollMs)
    return before - after
  }

  async function trimEmptyBundlesToBudget(bot, window, opts, desiredEmpty) {
    let returned = 0
    while (countWindowInventoryBundles(window, opts, bot?.registry).empty > desiredEmpty) {
      const slots = findInventorySlots(window, (stack) => isEmptyBundle(stack, opts.bundleItemName, bot?.registry))
        .sort((a, b) => toNumber(window.slots?.[b]?.count, 0) - toNumber(window.slots?.[a]?.count, 0))
      if (!slots.length) break
      const moved = await returnEmptyBundleStackToChest(bot, window, slots[0], opts)
      if (moved <= 0) break
      returned += moved
      await delay(opts.actionDelayMs)
    }
    return returned
  }

  async function recoverBundlesFromContainer(bot, window, opts, reason) {
    let recovered = 0
    while (true) {
      const sourceSlot = findContainerSlots(window, (stack) => isBundleItem(stack, opts.bundleItemName))[0]
      if (sourceSlot == null) break
      const targetSlot = inventoryEmptySlots(window)[0]
      if (targetSlot == null) {
        throw new Error(`${reason}: bundle found in source chest but inventory has no empty slot for recovery`)
      }
      await assertWindowCursorEmpty(window, `${reason}:recover-bundle slot=${sourceSlot}`)
      const before = Math.max(0, toNumber(window.slots?.[sourceSlot]?.count, 0))
      await bot.clickWindow(sourceSlot, 0, 0)
      await waitBotTicks(bot, 2)
      if (!isBundleItem(getWindowCursorItem(window), opts.bundleItemName)) {
        throw new Error(`${reason}: failed to pick up bundle from source chest slot ${sourceSlot}`)
      }
      await bot.clickWindow(targetSlot, 0, 0)
      await waitBotTicks(bot, 2)
      const cursorEmpty = await waitForWindowCursorEmpty(window, opts.verifyTimeoutMs, opts.verifyPollMs)
      if (!cursorEmpty) throw new Error(`${reason}: cursor not empty after bundle recovery`)
      await waitForWindowSlot(
        window,
        sourceSlot,
        (entry) => !entry || toNumber(entry.count, 0) < before,
        opts.verifyTimeoutMs,
        opts.verifyPollMs
      )
      await waitForWindowSlot(
        window,
        targetSlot,
        (entry) => isBundleItem(entry, opts.bundleItemName),
        opts.verifyTimeoutMs,
        opts.verifyPollMs
      )
      recovered += before
      await delay(opts.actionDelayMs)
    }
    return recovered
  }

  async function undoBundleMapSwap(bot, window, mapSlot, opts, reason) {
    const cursor = getWindowCursorItem(window)
    if (stripNamespace(cursor?.name) !== FILLED_MAP) return false
    if (!isBundleItem(window.slots?.[mapSlot], opts.bundleItemName)) return false
    await bot.clickWindow(mapSlot, 0, 0)
    await waitBotTicks(bot, 3)
    await waitForCursorBundle(window, opts, reason)
    const restored = window.slots?.[mapSlot]
    if (stripNamespace(restored?.name) !== FILLED_MAP) {
      throw new Error(`${reason}: failed to restore map slot ${mapSlot} after bundle/map swap`)
    }
    return true
  }

  // EvMod-style stow: pick up the bundle, then click map slots with the bundle
  // cursor. Returns { moved, capacityFull } based on chest-slot deltas.
  async function stowMapsIntoBundleFromWindow(bot, window, bundleSlot, opts) {
    const bundleStack = window.slots?.[bundleSlot]
    if (toNumber(bundleStack?.count, 0) !== 1) {
      throw new Error(`delivery-bundle-stow: bundle slot ${bundleSlot} has stack count ${toNumber(bundleStack?.count, 0)}; expected 1`)
    }
    if (!bundleContainsOnlyMaps(bundleStack, bot?.registry)) {
      throw new Error(`delivery-bundle-stow: bundle slot ${bundleSlot} contains non-map items`)
    }

    const bundleBefore = countBundleMaps(bundleStack, bot?.registry)
    let moved = 0
    let bundleHeld = false

    await assertWindowCursorEmpty(window, `delivery-bundle-pickup slot=${bundleSlot}`)
    await bot.clickWindow(bundleSlot, 0, 0)
    await waitBotTicks(bot, 3)
    await waitForCursorBundle(window, opts, `delivery-bundle-pickup slot=${bundleSlot}`)
    bundleHeld = true

    try {
      while (bundleBefore + moved < opts.mapsPerBundle) {
        const mapSlots = findContainerSlots(window, (stack) => stripNamespace(stack.name) === FILLED_MAP)
        if (!mapSlots.length) break

        const slot = mapSlots[0]
        const before = Math.max(0, toNumber(window.slots?.[slot]?.count, 0))
        if (before <= 0) break

        const cursorBeforeClick = getWindowCursorItem(window)
        await bot.clickWindow(slot, opts.stowMouseButton, 0)
        await waitBotTicks(bot, 3)
        // Mineflayer first predicts this special bundle click as a normal swap.
        // Ignore that temporary bundle-in-chest state and wait for the server's
        // authoritative map-count change before deciding that recovery is needed.
        await waitForWindowSlot(
          window,
          slot,
          (entry) => {
            if (!entry) return true
            if (isBundleItem(entry, opts.bundleItemName)) return false
            if (stripNamespace(entry.name) !== FILLED_MAP) return true
            return Math.max(0, toNumber(entry.count, 0)) < before
          },
          opts.verifyTimeoutMs,
          opts.verifyPollMs
        )

        const slotAfterClick = window.slots?.[slot]
        if (isBundleItem(slotAfterClick, opts.bundleItemName)) {
          if (await undoBundleMapSwap(bot, window, slot, opts, `delivery-bundle-swap-undo slot=${slot}`)) {
            // The authoritative response never arrived. Restore the original
            // map and bundle positions, then stop this chest attempt safely.
            break
          }
          throw new Error(`delivery-bundle-stow slot=${slot}: bundle entered source chest`)
        }

        const cursorAfterClick = getWindowCursorItem(window)
        if (!isBundleItem(cursorAfterClick, opts.bundleItemName)) {
          if (isBundleItem(cursorBeforeClick, opts.bundleItemName)) {
            // The server accepted the bundle insert, but Mineflayer's generic
            // inventory prediction still thinks the cursor holds the map.
            window.selectedItem = cursorBeforeClick
          } else {
            throw new Error(`delivery-bundle-stow slot=${slot}: cursor became ${cursorAfterClick?.name || 'empty'}`)
          }
        }

        const after = Math.max(0, toNumber(window.slots?.[slot]?.count, 0))
        const delta = Math.max(0, before - after)
        if (delta <= 0) break
        moved += delta
        await waitForCursorBundle(window, opts, `delivery-bundle-stow slot=${slot}`)
        await delay(opts.actionDelayMs)
      }
    } finally {
      if (bundleHeld) await returnHeldBundle(bot, window, bundleSlot, opts, 'delivery-bundle-return')
    }

    return { moved, capacityFull: bundleBefore + moved >= opts.mapsPerBundle }
  }

  // Core transfer: move every filled_map from an open chest window into carried bundles.
  // Returns { moved, chestEmpty, capacityFull }.
  async function collectMapsFromWindow(bot, window, config) {
    const opts = settings(config)
    let moved = 0

    if (!opts.bundlesEnabled) {
      // Loose mode: shift-click map stacks straight into the player inventory.
      while (true) {
        const mapSlots = findContainerSlots(window, (stack) => stripNamespace(stack.name) === FILLED_MAP)
        if (!mapSlots.length) return { moved, chestEmpty: true, capacityFull: false }
        if (countEmptyInventorySlotsInWindow(window) <= 0) return { moved, chestEmpty: false, capacityFull: true }
        const slot = mapSlots[0]
        const count = Math.max(0, toNumber(window.slots?.[slot]?.count, 0))
        await assertWindowCursorEmpty(window, `delivery-loose-collect slot=${slot}`)
        await bot.clickWindow(slot, 0, 1) // shift-click into inventory
        const settled = await waitForWindowSlot(
          window,
          slot,
          (entry) => !entry || toNumber(entry.count, 0) < count,
          opts.verifyTimeoutMs,
          opts.verifyPollMs
        )
        const after = Math.max(0, toNumber(window.slots?.[slot]?.count, 0))
        const taken = Math.max(0, count - after)
        if (taken <= 0) {
          // Shift-click no-op: inventory is full.
          return { moved, chestEmpty: false, capacityFull: true }
        }
        moved += taken
        void settled
        await delay(opts.actionDelayMs)
      }
    }

    while (true) {
      const mapSlots = findContainerSlots(window, (stack) => stripNamespace(stack.name) === FILLED_MAP)
      if (!mapSlots.length) return { moved, chestEmpty: true, capacityFull: false }

      const bundleSlots = findInventorySlots(window, (stack) => isBundleItem(stack, opts.bundleItemName))
        .filter((slot) => toNumber(window.slots[slot]?.count, 0) === 1)
        .filter((slot) => bundleContainsOnlyMaps(window.slots[slot], bot?.registry))
        .filter((slot) => bundleFreeCapacity(window.slots[slot], opts.mapsPerBundle, bot?.registry) > 0)
      if (!bundleSlots.length) return { moved, chestEmpty: false, capacityFull: true }

      // Fill the bundle that is already the most used first so partially-filled
      // bundles get topped off before a fresh one is started.
      bundleSlots.sort((a, b) => countBundleItems(window.slots[b], bot?.registry) - countBundleItems(window.slots[a], bot?.registry))

      const result = await stowMapsIntoBundleFromWindow(bot, window, bundleSlots[0], opts)
      moved += result.moved
      if (result.moved === 0) {
        if (result.capacityFull) return { moved, chestEmpty: false, capacityFull: true }
        throw new Error('delivery-bundle-stow: click moved 0 maps while source chest still has maps')
      }
      await delay(opts.actionDelayMs)
    }
  }

  async function collectMapsFromChest(bot, config, chestDef) {
    const opts = settings(config)
    const window = await openStationChest(bot, chestDef.position, chestDef.openPosition, {
      timeoutMs: opts.openTimeoutMs,
      attempts: opts.openAttempts,
      reason: `delivery-collect-${chestDef.key || 'chest'}`
    })
    try {
      await delay(opts.actionDelayMs)
      const before = countWindowContainerItems(window, FILLED_MAP)
      const result = await collectMapsFromWindow(bot, window, config)
      const after = countWindowContainerItems(window, FILLED_MAP)
      const actualMoved = before - after
      if (actualMoved < 0) {
        throw new Error(`delivery-ledger: chest ${chestDef.key} gained maps during collection before=${before} after=${after}`)
      }
      if (actualMoved !== result.moved) {
        log(`[DELIVERY-WARN] chest ${chestDef.key} verified delta=${actualMoved} but click loop counted=${result.moved}; using verified delta`)
      }
      return { ...result, moved: actualMoved, clickMoved: result.moved, before, after }
    } finally {
      await recoverBundlesFromContainer(bot, window, opts, `delivery-collect-${chestDef.key || 'chest'}-close`)
      await closeWindow(bot, window, `delivery-collect-${chestDef.key || 'chest'}-close`)
    }
  }

  // Withdraws exact single empty bundles from the station bundles chest.
  async function restockEmptyBundles(bot, config, station, options = {}) {
    const opts = settings(config)
    const desiredEmpty = bundleBudget(opts, options)
    const preflight = countCarriedBundles(bot, opts.bundleItemName, opts.mapsPerBundle)
    if (preflight.empty === desiredEmpty) {
      return {
        withdrawn: 0,
        returned: 0,
        split: 0,
        desired: desiredEmpty,
        carried: preflight,
        skipped: 'sufficient-empty-bundles'
      }
    }
    const window = await openStationChest(bot, station.bundlesChest, station.openPosition, {
      timeoutMs: opts.openTimeoutMs,
      attempts: opts.openAttempts,
      reason: 'delivery-restock-bundles'
    })
    try {
      await delay(opts.actionDelayMs)
      const returned = await trimEmptyBundlesToBudget(bot, window, opts, desiredEmpty)
      const split = await splitEmptyBundleStacks(bot, window, opts, desiredEmpty)
      let withdrawn = 0
      while (true) {
        const carried = countWindowInventoryBundles(window, opts, bot?.registry)
        if (carried.total >= opts.maxBundlesToCarry) break
        if (carried.empty >= desiredEmpty) break
        const targetSlot = inventoryEmptySlots(window)[0]
        if (targetSlot == null) break
        const sourceSlots = findContainerSlots(window, (stack) => isEmptyBundle(stack, opts.bundleItemName, bot?.registry))
        if (!sourceSlots.length) break
        const slot = sourceSlots[0]
        const moved = await moveOneBundleStackItem(bot, window, slot, targetSlot, opts, `delivery-restock slot=${slot}`)
        if (!moved) break
        withdrawn += 1
        await delay(opts.actionDelayMs)
      }
      await splitEmptyBundleStacks(bot, window, opts, desiredEmpty)
      return {
        withdrawn,
        returned,
        split,
        desired: desiredEmpty,
        carried: countWindowInventoryBundles(window, opts, bot?.registry)
      }
    } finally {
      await closeWindow(bot, window, 'delivery-restock-bundles-close')
    }
  }

  // Deposits only map-carrying bundles into the station drop chest.
  // Empty bundles and loose maps stay in the inventory; loose maps halt the
  // mission in strict mode so the operator can recover them safely.
  async function depositAtStation(bot, config, station) {
    const opts = settings(config)
    const window = await openStationChest(bot, station.dropChest, station.openPosition, {
      timeoutMs: opts.openTimeoutMs,
      attempts: opts.openAttempts,
      reason: 'delivery-deposit'
    })
    try {
      await delay(opts.actionDelayMs)
      let depositedMaps = 0
      let depositedBundles = 0
      let chestFull = false

      const looseMapSlots = findInventorySlots(window, (stack) => {
        const name = stripNamespace(stack.name)
        return name === FILLED_MAP || name === EMPTY_MAP
      })
      const looseMapCount = looseMapSlots.reduce((sum, slot) => sum + Math.max(0, toNumber(window.slots?.[slot]?.count, 0)), 0)
      if (looseMapCount > 0 && !opts.allowLooseMapDeposit) {
        throw new Error(`delivery-safety-loose-map-deposit-blocked: looseMaps=${looseMapCount}`)
      }

      const unsafeBundleSlots = findInventorySlots(window, (stack) => {
        if (!isBundleItem(stack, opts.bundleItemName)) return false
        if (countBundleItems(stack, bot?.registry) <= 0) return false
        return toNumber(stack.count, 0) !== 1 || !bundleContainsOnlyMaps(stack, bot?.registry)
      })
      if (unsafeBundleSlots.length) {
        throw new Error(`delivery-safety-unsafe-bundle-deposit-blocked: slots=${unsafeBundleSlots.join(',')}`)
      }

      while (true) {
        const slots = findInventorySlots(window, (stack) => {
          if (!isBundleItem(stack, opts.bundleItemName)) return false
          if (toNumber(stack.count, 0) !== 1) return false
          if (!bundleContainsOnlyMaps(stack, bot?.registry)) return false
          return countBundleMaps(stack, bot?.registry) > 0
        })
        if (!slots.length) break

        const slot = slots[0]
        const stack = window.slots[slot]
        const isBundle = isBundleItem(stack, opts.bundleItemName)
        const mapCount = isBundle ? countBundleMaps(stack, bot?.registry) : Math.max(0, toNumber(stack?.count, 0))
        const beforeCount = Math.max(0, toNumber(stack?.count, 0))

        await assertWindowCursorEmpty(window, `delivery-deposit slot=${slot}`)
        await bot.clickWindow(slot, 0, 1) // shift-click into the chest
        await waitForWindowSlot(
          window,
          slot,
          (entry) => !entry || toNumber(entry.count, 0) < beforeCount,
          opts.verifyTimeoutMs,
          opts.verifyPollMs
        )
        const after = Math.max(0, toNumber(window.slots?.[slot]?.count, 0))
        if (after >= beforeCount) {
          chestFull = true
          break
        }
        depositedMaps += mapCount
        if (isBundle) depositedBundles += beforeCount
        await delay(opts.actionDelayMs)
      }

      return { depositedMaps, depositedBundles, chestFull, looseMapCount }
    } finally {
      await closeWindow(bot, window, 'delivery-deposit-close')
    }
  }

  function carriedState(bot, config) {
    const opts = settings(config)
    const maps = countCarriedMaps(bot, opts.bundleItemName)
    const bundles = countCarriedBundles(bot, opts.bundleItemName, opts.mapsPerBundle)
    return { maps, bundles }
  }

  function hasCollectCapacity(bot, config) {
    const opts = settings(config)
    if (!opts.bundlesEnabled) {
      const used = (bot?.inventory?.items?.() || []).length
      const size = 36
      return used < size
    }
    return countCarriedBundles(bot, opts.bundleItemName, opts.mapsPerBundle).withFreeSpace > 0
  }

  void log
  return {
    settings,
    openStationChest,
    collectMapsFromWindow,
    collectMapsFromChest,
    restockEmptyBundles,
    depositAtStation,
    carriedState,
    hasCollectCapacity
  }
}

module.exports = {
  FILLED_MAP,
  EMPTY_MAP,
  stripNamespace,
  readBundleContents,
  countBundleItems,
  countBundleMaps,
  bundleContainsOnlyMaps,
  isBundleItem,
  isEmptyBundle,
  bundleFreeCapacity,
  countCarriedMaps,
  countCarriedBundles,
  createBundleOps
}
