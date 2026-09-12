const test = require('node:test')
const assert = require('node:assert/strict')
const {
  resolveStation,
  isAtStation,
  getTargetGeometry,
  buildPlatformBounds,
  isInsideBounds
} = require('../src/nerv-printer/delivery/station')

test('derives station nodes from the default anchor offsets', () => {
  const station = resolveStation({ station: { anchor: { x: 21, y: 86, z: -854 } } })

  assert.deepEqual(station.anchor, { x: 21, y: 86, z: -854 })
  assert.deepEqual(station.enderChest, { x: 19, y: 87, z: -854 })
  assert.deepEqual(station.dropChest, { x: 17, y: 87, z: -854 })
  assert.deepEqual(station.bundlesChest, { x: 16, y: 87, z: -854 })
  assert.deepEqual(station.foodChest, { x: 14, y: 87, z: -853 })
  assert.deepEqual(station.openPosition, { x: 17, y: 86, z: -852 })
  assert.equal(station.radius, 25)
  assert.equal(station.homeName, 'platform')
})

test('dashboard anchor overrides config anchor and re-derives nodes', () => {
  const station = resolveStation(
    { station: { anchor: { x: 21, y: 86, z: -854 } } },
    { anchor: { x: 100, y: 70, z: 200 }, radius: 30, homeName: 'delivery' }
  )

  assert.deepEqual(station.anchor, { x: 100, y: 70, z: 200 })
  assert.deepEqual(station.dropChest, { x: 96, y: 71, z: 200 })
  assert.deepEqual(station.foodChest, { x: 93, y: 71, z: 201 })
  assert.equal(station.radius, 30)
  assert.equal(station.homeName, 'delivery')
})

test('explicit config node overrides derived value', () => {
  const station = resolveStation({
    station: {
      anchor: { x: 21, y: 86, z: -854 },
      dropChest: { x: 0, y: 64, z: 0 }
    }
  })

  assert.deepEqual(station.dropChest, { x: 0, y: 64, z: 0 })
  assert.deepEqual(station.bundlesChest, { x: 16, y: 87, z: -854 })
})

test('isAtStation respects radius and y tolerance', () => {
  const station = resolveStation({ station: { anchor: { x: 21, y: 86, z: -854 }, radius: 25 } })

  assert.equal(isAtStation({ x: 21, y: 86, z: -854 }, station), true)
  assert.equal(isAtStation({ x: 41, y: 87, z: -854 }, station), true)
  assert.equal(isAtStation({ x: 60, y: 86, z: -854 }, station), false)
  assert.equal(isAtStation({ x: 21, y: 150, z: -854 }, station), false)
  assert.equal(isAtStation(null, station), false)
})

test('computes target chest positions from a deployed anchor', () => {
  // Using the legacy machine itself: anchor == legacy source anchor means
  // chest positions must equal the raw legacy blockPos coordinates.
  const geometry = getTargetGeometry({ x: -706, y: -9, z: -962 })

  assert.equal(geometry.chests.length, 3)
  assert.deepEqual(geometry.chests.map((chest) => chest.key), ['upper', 'middle', 'lowest'])
  assert.deepEqual(geometry.chests[0].position, { x: -645, y: -7, z: -966 })
  assert.deepEqual(geometry.chests[1].position, { x: -645, y: -8, z: -965 })
  assert.deepEqual(geometry.chests[2].position, { x: -645, y: -9, z: -964 })
  assert.equal(Math.round(geometry.openPosition.x * 100) / 100, -644.34)
  assert.deepEqual(geometry.mapCorner, { x: -704, y: -8, z: -960 })
})

test('translates chest positions for a real deployed platform anchor', () => {
  const geometry = getTargetGeometry({ x: -834, y: 65, z: -194 })

  assert.deepEqual(geometry.chests[0].position, { x: -773, y: 67, z: -198 })
  assert.deepEqual(geometry.chests[1].position, { x: -773, y: 66, z: -197 })
  assert.deepEqual(geometry.chests[2].position, { x: -773, y: 65, z: -196 })
  assert.equal(isInsideBounds({ x: -773, y: 66, z: -197 }, geometry.platformBounds), true)
  assert.equal(isInsideBounds({ x: 21, y: 86, z: -854 }, geometry.platformBounds), false)
})

test('platform bounds mirror the cli getPlatformBounds math', () => {
  const bounds = buildPlatformBounds({ x: -704, y: -8, z: -960 }, { width: 128, height: 128 })

  assert.deepEqual(bounds, { minX: -862, maxX: -546, minY: -16, maxY: 4, minZ: -1118, maxZ: -802 })
  assert.equal(isInsideBounds({ x: -704, y: -40, z: -960 }, bounds), false)
})

test('respects configured chest order', () => {
  const geometry = getTargetGeometry({ x: 0, y: 0, z: 0 }, { order: ['lowest', 'upper'] })

  assert.deepEqual(geometry.chests.map((chest) => chest.key), ['lowest', 'upper'])
})
