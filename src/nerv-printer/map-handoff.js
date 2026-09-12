'use strict'

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function selectDistinctMapId(sourceMapId, candidates = []) {
  const source = finiteNumber(sourceMapId)
  if (source === null) return null
  for (const candidate of candidates.flat(Infinity)) {
    const mapId = finiteNumber(candidate)
    if (mapId !== null && mapId !== source) return mapId
  }
  return null
}

function selectAddedMapId(sourceMapId, beforeCandidates = [], afterCandidates = []) {
  const source = finiteNumber(sourceMapId)
  if (source === null) return null

  const beforeCounts = new Map()
  for (const candidate of beforeCandidates.flat(Infinity)) {
    const mapId = finiteNumber(candidate)
    if (mapId === null) continue
    beforeCounts.set(mapId, (beforeCounts.get(mapId) || 0) + 1)
  }

  const seenAfter = new Map()
  for (const candidate of afterCandidates.flat(Infinity)) {
    const mapId = finiteNumber(candidate)
    if (mapId === null || mapId === source) continue
    const seen = (seenAfter.get(mapId) || 0) + 1
    seenAfter.set(mapId, seen)
    if (seen > (beforeCounts.get(mapId) || 0)) return mapId
  }
  return null
}

function selectNewestMapIdAfter(checkpointMapId, candidates = []) {
  const checkpoint = finiteNumber(checkpointMapId)
  if (checkpoint === null) return null
  let newest = null
  for (const candidate of candidates.flat(Infinity)) {
    const mapId = finiteNumber(candidate)
    if (mapId === null || mapId <= checkpoint) continue
    if (newest === null || mapId > newest) newest = mapId
  }
  return newest
}

function buildMapRenderTraversalPoints(config = {}) {
  const corner = config.machine?.mapCorner || {}
  const width = Math.max(1, Math.floor(finiteNumber(config.machine?.mapSize?.width, 128)))
  const height = Math.max(1, Math.floor(finiteNumber(config.machine?.mapSize?.height, 128)))
  const center = {
    x: finiteNumber(corner.x, 0) + Math.floor((width - 1) / 2),
    y: finiteNumber(corner.y, 64),
    z: finiteNumber(corner.z, 0) + Math.floor((height - 1) / 2)
  }
  const configuredRadius = Math.max(0, finiteNumber(config.printer?.mapFillSquareSize, 0))
  // Stay safely inside the printed surface while still loading the outer map
  // chunks. A 16-block inset can leave the final edge rows outside a small
  // server view distance even though the bot visited every quadrant.
  const inset = Math.max(1, Math.floor(finiteNumber(config.advanced?.postPrintMapRenderTraversalInset, 8)))
  const maxRadiusX = Math.max(0, Math.floor((width - 1) / 2))
  const maxRadiusZ = Math.max(0, Math.floor((height - 1) / 2))
  const radiusX = Math.min(maxRadiusX, Math.max(configuredRadius, Math.max(0, maxRadiusX - inset)))
  const radiusZ = Math.min(maxRadiusZ, Math.max(configuredRadius, Math.max(0, maxRadiusZ - inset)))

  if (radiusX <= 0 && radiusZ <= 0) return [center]
  return [
    { x: center.x - radiusX, y: center.y, z: center.z + radiusZ },
    { x: center.x + radiusX, y: center.y, z: center.z + radiusZ },
    { x: center.x + radiusX, y: center.y, z: center.z - radiusZ },
    { x: center.x - radiusX, y: center.y, z: center.z - radiusZ },
    center
  ]
}

function buildMissingMapRenderTraversalPoints(config = {}, written = [], options = {}) {
  const corner = config.machine?.mapCorner || {}
  const width = Math.max(1, Math.min(128, Math.floor(finiteNumber(config.machine?.mapSize?.width, 128))))
  const height = Math.max(1, Math.min(128, Math.floor(finiteNumber(config.machine?.mapSize?.height, 128))))
  const bucketSize = Math.max(1, Math.min(64, Math.floor(finiteNumber(options.bucketSize, 16))))
  const maxPoints = Math.max(1, Math.min(64, Math.floor(finiteNumber(options.maxPoints, 16))))
  const inset = Math.max(0, Math.floor(finiteNumber(config.advanced?.postPrintMapRenderTraversalInset, 8)))
  const maxLocalX = width - 1
  const maxLocalZ = height - 1
  const safeMinX = Math.min(inset, maxLocalX)
  const safeMaxX = Math.max(safeMinX, maxLocalX - inset)
  const safeMinZ = Math.min(inset, maxLocalZ)
  const safeMaxZ = Math.max(safeMinZ, maxLocalZ - inset)
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))
  const groups = new Map()

  for (let pixelZ = 0; pixelZ < height; pixelZ += 1) {
    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      // Map packets always use a 128-pixel row stride, even when a test or a
      // custom machine config describes a smaller useful surface.
      if (Number(written?.[(pixelZ * 128) + pixelX]) > 0) continue
      const bucketX = Math.floor(pixelX / bucketSize)
      const bucketZ = Math.floor(pixelZ / bucketSize)
      const key = `${bucketX}:${bucketZ}`
      const group = groups.get(key) || {
        bucketX,
        bucketZ,
        count: 0,
        sumX: 0,
        sumZ: 0,
        minX: pixelX,
        maxX: pixelX,
        minZ: pixelZ,
        maxZ: pixelZ
      }
      group.count += 1
      group.sumX += pixelX
      group.sumZ += pixelZ
      group.minX = Math.min(group.minX, pixelX)
      group.maxX = Math.max(group.maxX, pixelX)
      group.minZ = Math.min(group.minZ, pixelZ)
      group.maxZ = Math.max(group.maxZ, pixelZ)
      groups.set(key, group)
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.bucketZ - b.bucketZ || a.bucketX - b.bucketX)
    .slice(0, maxPoints)
    .map((group) => {
      const localX = clamp(Math.round(group.sumX / group.count), safeMinX, safeMaxX)
      const localZ = clamp(Math.round(group.sumZ / group.count), safeMinZ, safeMaxZ)
      return {
        x: finiteNumber(corner.x, 0) + localX,
        y: finiteNumber(corner.y, 64),
        z: finiteNumber(corner.z, 0) + localZ,
        missingPixels: group.count,
        pixelBounds: {
          minX: group.minX,
          maxX: group.maxX,
          minZ: group.minZ,
          maxZ: group.maxZ
        }
      }
    })
}

async function settleMapRenderCoverage(options = {}) {
  const getCoverage = typeof options.getCoverage === 'function' ? options.getCoverage : () => 0
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : async (waitMs) => await new Promise((resolve) => setTimeout(resolve, waitMs))
  const now = typeof options.now === 'function' ? options.now : Date.now
  const minPixels = Math.max(1, Math.min(16384, finiteNumber(options.minPixels, 16384)))
  const settleMs = Math.max(0, finiteNumber(options.settleMs, 0))
  const quietMs = Math.max(0, finiteNumber(options.quietMs, 0))
  const maxSettleMs = Math.max(settleMs, finiteNumber(options.maxSettleMs, settleMs))
  const pollMs = Math.max(1, finiteNumber(options.pollMs, 100))
  const deadlineAt = finiteNumber(options.deadlineAt)
  const readCoverage = () => Math.max(0, finiteNumber(getCoverage(), 0))
  const startCoverage = readCoverage()
  let coverage = startCoverage
  const startedAt = now()
  const minimumSettleUntil = startedAt + settleMs
  const maximumSettleUntil = startedAt + maxSettleMs
  let lastProgressAt = startedAt

  while (coverage < minPixels) {
    const sampledAt = now()
    const quietUntil = lastProgressAt + quietMs
    if (sampledAt >= maximumSettleUntil) break
    if (sampledAt >= minimumSettleUntil && sampledAt >= quietUntil) break
    options.assertDeadline?.()
    options.assertContinue?.()
    const requiredUntil = Math.min(
      maximumSettleUntil,
      Math.max(minimumSettleUntil, quietUntil)
    )
    const remainingSettleMs = Math.max(1, requiredUntil - sampledAt)
    const remainingWorkflowMs = deadlineAt === null
      ? pollMs
      : Math.max(1, deadlineAt - sampledAt)
    await sleep(Math.min(pollMs, remainingSettleMs, remainingWorkflowMs))
    const nextCoverage = readCoverage()
    if (nextCoverage > coverage) lastProgressAt = now()
    coverage = nextCoverage
  }
  options.assertDeadline?.()

  return {
    startCoverage,
    coverage,
    complete: coverage >= minPixels
  }
}

module.exports = {
  selectDistinctMapId,
  selectAddedMapId,
  selectNewestMapIdAfter,
  buildMapRenderTraversalPoints,
  buildMissingMapRenderTraversalPoints,
  settleMapRenderCoverage
}
