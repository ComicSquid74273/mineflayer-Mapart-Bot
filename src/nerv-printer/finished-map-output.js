'use strict'

function toNonNegativeInteger(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return Math.max(0, Math.floor(Number(fallback) || 0))
  return Math.max(0, Math.floor(number))
}

function inspectFinishedMapChestCapacity(container, rawSlotHasItem = null) {
  const slots = Array.isArray(container?.slots) ? container.slots : []
  const totalSlots = Number.isFinite(Number(container?.inventoryStart))
    ? Math.min(slots.length, toNonNegativeInteger(container.inventoryStart, 0))
    : 0
  let occupiedSlots = 0

  for (let slot = 0; slot < totalSlots; slot += 1) {
    const parsedOccupied = Boolean(slots[slot])
    const rawOccupied = typeof rawSlotHasItem === 'function' && rawSlotHasItem(slot) === true
    if (parsedOccupied || rawOccupied) occupiedSlots += 1
  }

  return {
    totalSlots,
    occupiedSlots,
    freeSlots: Math.max(0, totalSlots - occupiedSlots),
    full: totalSlots <= 0 || occupiedSlots >= totalSlots
  }
}

function extendDeadlineForHold(deadline, holdMs) {
  const durationMs = Math.max(0, Number(holdMs) || 0)
  if (!deadline?.enabled || !Number.isFinite(Number(deadline.deadlineAt)) || durationMs <= 0) return false
  deadline.deadlineAt = Number(deadline.deadlineAt) + durationMs
  return true
}

module.exports = {
  extendDeadlineForHold,
  inspectFinishedMapChestCapacity
}
