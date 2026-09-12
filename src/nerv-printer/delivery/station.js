// Delivery-station and target-platform geometry. Pure math, no bot access.
//
// The delivery station is described by a single anchor block; every other
// station node (chests, open position) defaults to a fixed offset from that
// anchor so moving the anchor on the dashboard moves the whole station.
//
// Target platforms reuse the printer fleet's anchor-translation scheme:
// world position = legacy layout position + (targetAnchor - legacySourceAnchor).
// The three finished-map chests live in legacy-nerv-carpet-printer-config.json
// at x=-645 stacked y=-7 (upper), y=-8 (middle), y=-9 (lowest).

const { getConfiguredPlatformBounds, isPositionInsideBounds } = require('../runtime-safety')

const DEFAULT_STATION_ANCHOR = { x: 21, y: 86, z: -854 }
const DEFAULT_STATION_RADIUS = 25

const DEFAULT_STATION_OFFSETS = {
  enderChest: { x: -2, y: 1, z: 0 },
  dropChest: { x: -4, y: 1, z: 0 },
  bundlesChest: { x: -5, y: 1, z: 0 },
  foodChest: { x: -7, y: 1, z: 1 },
  openPosition: { x: -4, y: 0, z: 2 }
}

const DEFAULT_LEGACY_SOURCE_ANCHOR = { x: -706, y: -9, z: -962 }

// Offsets of the finished-map chests (and their shared open position) from the
// legacy source anchor, derived from legacy-nerv-carpet-printer-config.json.
const DEFAULT_LEGACY_OFFSETS = {
  upper: { x: 61, y: 2, z: -4 },
  middle: { x: 61, y: 1, z: -3 },
  lowest: { x: 61, y: 0, z: -2 },
  openPos: { x: 61.66, y: 1, z: -0.67 }
}

// Legacy machine mapCorner (-704,-8,-960) relative to the legacy source anchor.
const DEFAULT_LEGACY_MAP_CORNER_OFFSET = { x: 2, y: 1, z: 2 }

const DEFAULT_CHEST_ORDER = ['upper', 'middle', 'lowest']

function toPoint(value) {
  if (!value || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  const z = Number(value.z)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { x, y, z }
}

function addPoints(base, offset) {
  const a = toPoint(base)
  const b = toPoint(offset)
  if (!a || !b) return null
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

function horizontalDistance(a, b) {
  const dx = Number(a?.x) - Number(b?.x)
  const dz = Number(a?.z) - Number(b?.z)
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return Infinity
  return Math.sqrt(dx * dx + dz * dz)
}

// Resolves the full station description.
// Per-node precedence: bot config explicit value > dashboard value > anchor + offset.
// Anchor precedence: dashboard (operator-edited) > bot config > built-in default.
function resolveStation(deliveryConfig = {}, dashboardStation = {}) {
  const stationConfig = deliveryConfig?.station || {}
  const offsets = { ...DEFAULT_STATION_OFFSETS, ...(stationConfig.offsets || {}) }

  const anchor = toPoint(dashboardStation?.anchor) || toPoint(stationConfig.anchor) || { ...DEFAULT_STATION_ANCHOR }

  const radiusCandidates = [dashboardStation?.radius, stationConfig.radius, DEFAULT_STATION_RADIUS]
  let radius = DEFAULT_STATION_RADIUS
  for (const candidate of radiusCandidates) {
    const value = Number(candidate)
    if (Number.isFinite(value) && value > 0) {
      radius = value
      break
    }
  }

  const node = (key) =>
    toPoint(stationConfig[key]) ||
    toPoint(dashboardStation?.[key]) ||
    addPoints(anchor, offsets[key])

  const homeName = String(dashboardStation?.homeName || deliveryConfig?.homeName || 'platform').trim() || 'platform'

  return {
    anchor,
    radius,
    yTolerance: Number.isFinite(Number(stationConfig.yTolerance)) ? Number(stationConfig.yTolerance) : 16,
    enderChest: node('enderChest'),
    dropChest: node('dropChest'),
    bundlesChest: node('bundlesChest'),
    foodChest: node('foodChest'),
    openPosition: node('openPosition'),
    homeName
  }
}

function isAtStation(pos, station) {
  const point = toPoint(pos)
  const anchor = toPoint(station?.anchor)
  if (!point || !anchor) return false
  const radius = Number.isFinite(Number(station?.radius)) && Number(station.radius) > 0 ? Number(station.radius) : DEFAULT_STATION_RADIUS
  const yTolerance = Number.isFinite(Number(station?.yTolerance)) && Number(station.yTolerance) > 0 ? Number(station.yTolerance) : 16
  return horizontalDistance(point, anchor) <= radius && Math.abs(point.y - anchor.y) <= yTolerance
}

// Mirrors the printer's 3D platform classifier.
function buildPlatformBounds(mapCorner, mapSize = {}, advanced = {}) {
  return getConfiguredPlatformBounds({ machine: { mapCorner, mapSize }, advanced })
}

function isInsideBounds(pos, bounds) {
  return isPositionInsideBounds(toPoint(pos), bounds)
}

// Computes a target platform's finished-chest world positions from its anchor.
function getTargetGeometry(targetAnchor, chestsConfig = {}) {
  const anchor = toPoint(targetAnchor)
  if (!anchor) return null

  const legacyOffsets = { ...DEFAULT_LEGACY_OFFSETS, ...(chestsConfig.legacyOffsets || {}) }
  const order = Array.isArray(chestsConfig.order) && chestsConfig.order.length
    ? chestsConfig.order.filter((key) => legacyOffsets[key])
    : DEFAULT_CHEST_ORDER

  const openPosition = addPoints(anchor, legacyOffsets.openPos)
  const chests = order.map((key) => ({
    key,
    position: addPoints(anchor, legacyOffsets[key]),
    openPosition
  }))

  const mapCorner = addPoints(anchor, chestsConfig.legacyMapCornerOffset || DEFAULT_LEGACY_MAP_CORNER_OFFSET)
  const platformBounds = buildPlatformBounds(mapCorner, chestsConfig.mapSize || {}, chestsConfig.platformBounds || {})

  return { anchor, chests, openPosition, mapCorner, platformBounds }
}

module.exports = {
  DEFAULT_STATION_ANCHOR,
  DEFAULT_STATION_RADIUS,
  DEFAULT_STATION_OFFSETS,
  DEFAULT_LEGACY_SOURCE_ANCHOR,
  DEFAULT_LEGACY_OFFSETS,
  DEFAULT_LEGACY_MAP_CORNER_OFFSET,
  DEFAULT_CHEST_ORDER,
  toPoint,
  addPoints,
  horizontalDistance,
  resolveStation,
  isAtStation,
  buildPlatformBounds,
  isInsideBounds,
  getTargetGeometry
}
