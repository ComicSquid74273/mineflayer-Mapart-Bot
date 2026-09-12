const test = require('node:test')
const assert = require('node:assert/strict')

const { targetsFromNbt } = require('../src/nerv-printer/nbt-targets')
const { computeWorkerIntervals, validateMultiTargets } = require('../src/nerv-printer/multi-coordinator')

const palette = [
  { Name: 'minecraft:white_carpet' },
  { Name: 'minecraft:red_carpet' },
  { Name: 'minecraft:cobblestone' }
]

function carpetPlane({ width = 128, height = 128, startX = 10, startY = 4, startZ = 20 } = {}) {
  const blocks = []
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      blocks.push({ state: (row + col) % 2, pos: [startX + col, startY, startZ + row] })
    }
  }
  return blocks
}

function noobline({ startX = 10, startY = 4, z = 19 } = {}) {
  return Array.from({ length: 128 }, (_, col) => ({
    state: 2,
    pos: [startX + col, startY, z]
  }))
}

function config(overrides = {}) {
  return {
    machine: { mapCorner: { x: 100, y: 64, z: 200 } },
    printer: {
      ignoredBlocks: [],
      northToSouth: true,
      printOffset: { x: 2, y: 1, z: -1 },
      ...(overrides.printer || {})
    },
    advanced: {
      useMapCornerYForNbtCarpets: true,
      ...(overrides.advanced || {})
    }
  }
}

test('standard 128 by 128 NBT carpets normalize to map rows and columns 0 through 127', () => {
  const targets = targetsFromNbt({ palette, blocks: carpetPlane() }, config())

  assert.equal(targets.length, 128 * 128)
  assert.deepEqual(targets[0], {
    row: 0,
    col: 0,
    symbol: 'white_carpet',
    blockName: 'white_carpet',
    position: { x: 102, y: 65, z: 199 }
  })
  assert.equal(targets.at(-1).row, 127)
  assert.equal(targets.at(-1).col, 127)
})

test('a leading cobblestone noobline does not shift 128 carpet rows to 1 through 128', () => {
  const blocks = [...noobline({ z: 19 }), ...carpetPlane({ startZ: 20 })]
  const targets = targetsFromNbt({ palette, blocks }, config())

  assert.equal(targets.length, 128 * 128)
  assert.equal(Math.min(...targets.map((target) => target.row)), 0)
  assert.equal(Math.max(...targets.map((target) => target.row)), 127)
  assert.equal(targets.some((target) => target.blockName === 'cobblestone'), false)
})

test('a trailing cobblestone noobline is ignored when row traversal is reversed', () => {
  const blocks = [...carpetPlane({ startZ: 20 }), ...noobline({ z: 148 })]
  const targets = targetsFromNbt({ palette, blocks }, config({ printer: { northToSouth: false } }))

  assert.equal(targets.length, 128 * 128)
  assert.equal(targets[0].row, 127)
  assert.equal(targets.at(-1).row, 0)
  assert.equal(Math.max(...targets.map((target) => target.row)), 127)
})

test('129 genuine carpet rows remain rejected instead of being clipped', () => {
  assert.throws(
    () => targetsFromNbt({ palette, blocks: carpetPlane({ height: 129 }) }, config()),
    /NBT_TARGET_OUT_OF_BOUNDS: carpet target .* has row 128; expected 0-127/
  )
})

test('ignored carpet colors preserve the original printable geometry', () => {
  const blocks = [
    { state: 0, pos: [10, 4, 20] },
    { state: 1, pos: [11, 4, 20] }
  ]
  const targets = targetsFromNbt({ palette, blocks }, config({ printer: { ignoredBlocks: ['minecraft:white_carpet'] } }))

  assert.equal(targets.length, 1)
  assert.equal(targets[0].col, 1)
  assert.deepEqual(targets[0].position, { x: 103, y: 65, z: 199 })
})

test('one shared 128 by 128 target plan splits only by master and slave columns', () => {
  const targets = targetsFromNbt({ palette, blocks: carpetPlane() }, config())
  validateMultiTargets(targets, 128, 128)
  const [masterInterval, slaveInterval] = computeWorkerIntervals(2, 128)
  const masterTargets = targets.filter((target) => target.col >= masterInterval.start && target.col <= masterInterval.end)
  const slaveTargets = targets.filter((target) => target.col >= slaveInterval.start && target.col <= slaveInterval.end)

  assert.deepEqual(masterInterval, { start: 0, end: 63 })
  assert.deepEqual(slaveInterval, { start: 64, end: 127 })
  assert.equal(masterTargets.length, 128 * 64)
  assert.equal(slaveTargets.length, 128 * 64)
  assert.equal(masterTargets.length + slaveTargets.length, targets.length)
  assert.equal(masterTargets.every((target) => target.col <= 63), true)
  assert.equal(slaveTargets.every((target) => target.col >= 64), true)
})
