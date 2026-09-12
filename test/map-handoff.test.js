'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  selectDistinctMapId,
  selectAddedMapId,
  selectNewestMapIdAfter,
  buildMapRenderTraversalPoints,
  buildMissingMapRenderTraversalPoints,
  settleMapRenderCoverage
} = require('../src/nerv-printer/map-handoff')

test('cartography selects the server output ID after ignoring the client-predicted source ID', () => {
  assert.equal(selectDistinctMapId(612985, [612985, null, 612999]), 612999)
  assert.equal(selectDistinctMapId(612985, [612985, 612985]), null)
})

test('cartography selects the map ID newly added to inventory instead of an older unrelated map', () => {
  assert.equal(
    selectAddedMapId(
      612907,
      [[612718, 612725, 612693], [612718, 612725, 612693]],
      [[612718, 612725, 612693, 613008], [612718, 612725, 612693, 613008]]
    ),
    613008
  )
  assert.equal(selectAddedMapId(612907, [612718], [612718]), null)
})

test('cartography recovery selects only the newest map allocated after its checkpoint', () => {
  assert.equal(selectNewestMapIdAfter(612718, [612693, 612725, 612746, 613008]), 613008)
  assert.equal(selectNewestMapIdAfter(612856, [612693, 612725, 612856]), null)
})

test('map render traversal covers the useful interior instead of a five-block center square', () => {
  const points = buildMapRenderTraversalPoints({
    machine: {
      mapCorner: { x: 1000, y: 91, z: -2000 },
      mapSize: { width: 128, height: 128 }
    },
    printer: { mapFillSquareSize: 5 },
    advanced: { postPrintMapRenderTraversalInset: 16 }
  })

  assert.deepEqual(points[0], { x: 1016, y: 91, z: -1890 })
  assert.deepEqual(points[2], { x: 1110, y: 91, z: -1984 })
  assert.deepEqual(points.at(-1), { x: 1063, y: 91, z: -1937 })
})

test('map render traversal defaults to an eight-block safe edge inset', () => {
  const points = buildMapRenderTraversalPoints({
    machine: {
      mapCorner: { x: 1000, y: 91, z: -2000 },
      mapSize: { width: 128, height: 128 }
    },
    printer: { mapFillSquareSize: 5 }
  })

  assert.deepEqual(points[0], { x: 1008, y: 91, z: -1882 })
  assert.deepEqual(points[2], { x: 1118, y: 91, z: -1992 })
  assert.deepEqual(points.at(-1), { x: 1063, y: 91, z: -1937 })
})

test('missing map packet columns produce bounded completion points along those columns', () => {
  const written = new Uint8Array(128 * 128).fill(1)
  for (let pixelZ = 0; pixelZ < 128; pixelZ += 1) {
    written[(pixelZ * 128) + 6] = 0
    written[(pixelZ * 128) + 7] = 0
  }

  const points = buildMissingMapRenderTraversalPoints({
    machine: {
      mapCorner: { x: 1000, y: 91, z: -2000 },
      mapSize: { width: 128, height: 128 }
    }
  }, written, { bucketSize: 16, maxPoints: 16 })

  assert.equal(points.length, 8)
  assert.equal(points.reduce((total, point) => total + point.missingPixels, 0), 256)
  assert.ok(points.every((point) => point.x === 1008), 'edge targets stay at the configured safe inset')
  assert.deepEqual(points[0].pixelBounds, { minX: 6, maxX: 7, minZ: 0, maxZ: 15 })
  assert.equal(points.at(-1).z, -1881)
})

test('map render settle accepts authoritative completion before coverage movement starts', async () => {
  let nowMs = 0
  let coverage = 16256
  let sleepCount = 0

  const result = await settleMapRenderCoverage({
    getCoverage: () => coverage,
    minPixels: 16384,
    settleMs: 1500,
    pollMs: 100,
    now: () => nowMs,
    sleep: async (waitMs) => {
      sleepCount += 1
      nowMs += waitMs
      if (nowMs >= 600) coverage = 16384
    }
  })

  assert.deepEqual(result, {
    startCoverage: 16256,
    coverage: 16384,
    complete: true
  })
  assert.equal(nowMs, 600)
  assert.equal(sleepCount, 6)
})

test('map render settle does not delay coverage that is already complete', async () => {
  let slept = false
  const result = await settleMapRenderCoverage({
    getCoverage: () => 16384,
    minPixels: 16384,
    settleMs: 1500,
    sleep: async () => { slept = true }
  })

  assert.equal(result.complete, true)
  assert.equal(slept, false)
})

test('map render settle extends past its minimum while authoritative pixels are still arriving', async () => {
  let nowMs = 0
  let coverage = 16000

  const result = await settleMapRenderCoverage({
    getCoverage: () => coverage,
    minPixels: 16384,
    settleMs: 1000,
    quietMs: 500,
    maxSettleMs: 2000,
    pollMs: 100,
    now: () => nowMs,
    sleep: async (waitMs) => {
      nowMs += waitMs
      if (nowMs >= 900) coverage = 16128
      if (nowMs >= 1300) coverage = 16384
    }
  })

  assert.equal(result.complete, true)
  assert.equal(result.coverage, 16384)
  assert.equal(nowMs, 1300)
})
