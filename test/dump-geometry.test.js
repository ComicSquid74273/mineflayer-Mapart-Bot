'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  getDumpRetreatPoint,
  getDumpStationStandPoint
} = require('../src/nerv-printer/dump-geometry')

test('centers a negative captured dump coordinate in its intended block cell', () => {
  assert.deepEqual(
    getDumpStationStandPoint({ x: -183.964100227, y: 106, z: 188.509163346 }),
    { x: -183.5, y: 106, z: 188.5 }
  )
})

test('retreats opposite Mineflayer yaw zero without changing elevation', () => {
  assert.deepEqual(
    getDumpRetreatPoint({ x: -10.96, y: 64, z: 20.51 }, 0, 3),
    { x: -10.5, y: 64, z: 23.5 }
  )
})

test('retreat direction follows Mineflayer yaw for non-cardinal stations', () => {
  const point = getDumpRetreatPoint({ x: 4.1, y: 70, z: 8.9 }, Math.PI / 2, 2)
  assert.ok(Math.abs(point.x - 6.5) < 1e-9)
  assert.ok(Math.abs(point.z - 8.5) < 1e-9)
})
