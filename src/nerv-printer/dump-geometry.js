'use strict'

function toFiniteNumber (value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function getDumpStationStandPoint (position) {
  const x = toFiniteNumber(position?.x)
  const y = toFiniteNumber(position?.y)
  const z = toFiniteNumber(position?.z)
  if (x == null || y == null || z == null) return null

  // Captured dump positions can sit only a few hundredths inside a block
  // boundary. Route to the center of that same intended cell so collision
  // settlement cannot push different bots onto opposite sides of the station.
  return {
    x: Math.floor(x) + 0.5,
    y,
    z: Math.floor(z) + 0.5
  }
}

function getDumpRetreatPoint (position, mineflayerYawRadians, distance = 3) {
  const stand = getDumpStationStandPoint(position)
  const yaw = toFiniteNumber(mineflayerYawRadians)
  const retreatDistance = Math.max(0, toFiniteNumber(distance) ?? 3)
  if (!stand || yaw == null) return null

  // Mineflayer's horizontal look vector is (-sin(yaw), -cos(yaw)). Moving in
  // the opposite direction leaves dropped items behind without changing the
  // calibrated throw direction.
  return {
    x: stand.x + (Math.sin(yaw) * retreatDistance),
    y: stand.y,
    z: stand.z + (Math.cos(yaw) * retreatDistance)
  }
}

module.exports = {
  getDumpRetreatPoint,
  getDumpStationStandPoint
}
