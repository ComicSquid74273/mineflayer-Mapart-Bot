'use strict'

const LEGACY_FINISHED_MAP_CHEST_KEYS = Object.freeze([
  'finishedMapChest',
  'finishedMapChest1',
  'finishedMapChest2',
  'readyToDeliverMapChest'
])

function collectLegacyFinishedMapChests(imported, toBlockPos, toOpenPos) {
  if (typeof toBlockPos !== 'function' || typeof toOpenPos !== 'function') {
    throw new TypeError('Legacy finished-map chest parsers are required.')
  }

  return LEGACY_FINISHED_MAP_CHEST_KEYS
    .map((key) => {
      const entry = imported?.[key]
      const position = toBlockPos(entry)
      if (!position) return null
      return {
        enabled: true,
        role: key,
        position,
        accessPosition: toOpenPos(entry)
      }
    })
    .filter(Boolean)
}

module.exports = {
  LEGACY_FINISHED_MAP_CHEST_KEYS,
  collectLegacyFinishedMapChests
}
