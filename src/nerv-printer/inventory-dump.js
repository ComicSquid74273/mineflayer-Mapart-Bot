'use strict'

function toCount (value) {
  const count = Number(value)
  return Number.isFinite(count) ? Math.max(0, count) : 0
}

function getInventorySlotBounds (inventory) {
  const slots = Array.isArray(inventory?.slots) ? inventory.slots : []
  const start = Number.isFinite(inventory?.inventoryStart) ? inventory.inventoryStart : 9
  const end = Number.isFinite(inventory?.inventoryEnd) ? inventory.inventoryEnd : slots.length
  return {
    start: Math.max(0, start),
    end: Math.max(Math.max(0, start), Math.min(slots.length, end))
  }
}

function captureInventorySnapshot (bot) {
  const inventory = bot?.inventory || {}
  const slots = Array.isArray(inventory.slots) ? inventory.slots : []
  const { start, end } = getInventorySlotBounds(inventory)
  const countsByName = new Map()
  let emptySlots = 0

  for (let slot = start; slot < end; slot += 1) {
    const stack = slots[slot]
    if (!stack || toCount(stack.count) <= 0) {
      emptySlots += 1
      continue
    }
    const name = String(stack.name || '')
    if (!name) continue
    countsByName.set(name, (countsByName.get(name) || 0) + toCount(stack.count))
  }

  return { emptySlots, countsByName }
}

function countFullyRemovedStacks (candidates, before, after) {
  const stacksByName = new Map()
  for (const stack of candidates || []) {
    const name = String(stack?.name || '')
    const count = toCount(stack?.count)
    if (!name || count <= 0) continue
    const counts = stacksByName.get(name) || []
    counts.push(count)
    stacksByName.set(name, counts)
  }

  let removedStacks = 0
  for (const [name, stackCounts] of stacksByName.entries()) {
    let removedItems = Math.max(
      0,
      toCount(before?.countsByName?.get(name)) - toCount(after?.countsByName?.get(name))
    )
    // A net item decrease proves only this much inventory was actually
    // discarded. Count the smallest candidate stacks first so the result never
    // claims more fully freed slots than the observed item delta can support.
    for (const stackCount of stackCounts.sort((a, b) => a - b)) {
      if (removedItems < stackCount) break
      removedItems -= stackCount
      removedStacks += 1
    }
  }
  return removedStacks
}

function evaluateDumpInventoryChange (bot, before, candidates) {
  const after = captureInventorySnapshot(bot)
  return {
    after,
    emptySlotGain: Math.max(0, after.emptySlots - toCount(before?.emptySlots)),
    removedStackCount: countFullyRemovedStacks(candidates, before, after)
  }
}

async function waitForSettledDumpInventory (bot, before, candidates, options = {}) {
  const pollMs = Math.max(25, Number(options.pollMs) || 50)
  const stableMs = Math.max(pollMs, Number(options.stableMs) || 2500)
  const timeoutMs = Math.max(stableMs, Number(options.timeoutMs) || (stableMs + 3500))
  const minEmptySlotGain = Math.max(0, Number(options.minEmptySlotGain) || 0)
  const minRemovedStacks = Math.max(0, Number(options.minRemovedStacks) || 0)
  const startedAt = Date.now()
  let qualifyingSince = 0
  let latest = evaluateDumpInventoryChange(bot, before, candidates)

  while (Date.now() - startedAt <= timeoutMs) {
    latest = evaluateDumpInventoryChange(bot, before, candidates)
    const qualifies = latest.emptySlotGain >= minEmptySlotGain &&
      latest.removedStackCount >= minRemovedStacks
    if (qualifies) {
      if (!qualifyingSince) qualifyingSince = Date.now()
      if (Date.now() - qualifyingSince >= stableMs) {
        return { ...latest, confirmed: true, durationMs: Date.now() - startedAt }
      }
    } else {
      qualifyingSince = 0
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  return { ...latest, confirmed: false, durationMs: Date.now() - startedAt }
}

module.exports = {
  captureInventorySnapshot,
  countFullyRemovedStacks,
  evaluateDumpInventoryChange,
  waitForSettledDumpInventory
}
