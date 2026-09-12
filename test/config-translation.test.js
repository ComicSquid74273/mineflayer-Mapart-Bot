'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { translateMachineNodes, translateMachineSpot } = require('../src/nerv-printer/config-translation')

const legacyMachine = require(path.join('..', 'nerv-printer-config', '_configs', 'legacy-nerv-carpet-printer-config.json'))

test('translateMachineSpot preserves and translates a captured access position', () => {
  assert.deepEqual(
    translateMachineSpot(
      {
        x: -385,
        y: 2,
        z: -965,
        accessPosition: { x: -384.9375, y: 1, z: -961.5 }
      },
      { x: 1000, y: 96, z: 2000 }
    ),
    {
      x: 615,
      y: 98,
      z: 1035,
      accessPosition: { x: 615.0625, y: 97, z: 1038.5 }
    }
  )
})

test('translateMachineSpot keeps plain positions plain', () => {
  assert.deepEqual(
    translateMachineSpot({ x: 1, y: 2, z: 3 }, { x: 10, y: 20, z: 30 }),
    { x: 11, y: 22, z: 33 }
  )
})

test('translateMachineNodes translates ordered support candidates and access positions', () => {
  assert.deepEqual(
    translateMachineNodes(
      [
        {
          enabled: true,
          position: { x: -689, y: -8, z: -965 },
          accessPosition: { x: -689, y: -8, z: -962 }
        },
        {
          enabled: true,
          position: { x: -638, y: -9, z: -964 },
          accessPosition: { x: -637, y: -8, z: -962 }
        }
      ],
      { x: 1000, y: 100, z: 2000 }
    ),
    [
      {
        enabled: true,
        position: { x: 311, y: 92, z: 1035 },
        accessPosition: { x: 311, y: 92, z: 1038 }
      },
      {
        enabled: true,
        position: { x: 362, y: 91, z: 1036 },
        accessPosition: { x: 363, y: 92, z: 1038 }
      }
    ]
  )
})

test('legacy support pillar uses anchor-relative XP, anvil, and food positions', () => {
  const sourceAnchor = { x: -706, y: -9, z: -962 }
  const relativeToAnchor = (point) => ({
    x: point.x - sourceAnchor.x,
    y: point.y - sourceAnchor.y,
    z: point.z - sourceAnchor.z
  })

  assert.deepEqual(relativeToAnchor(legacyMachine.xpBottleChests[0].blockPos), { x: 90, y: 1, z: -3 })
  assert.deepEqual(relativeToAnchor(legacyMachine.anvils[0].blockPos), { x: 86, y: 1, z: -3 })
  assert.deepEqual(relativeToAnchor(legacyMachine.foodChests[0].blockPos), { x: 82, y: 1, z: -3 })

  assert.deepEqual(relativeToAnchor(legacyMachine.xpBottleChests[0].openPos), { x: 90, y: 1, z: 0 })
  assert.deepEqual(relativeToAnchor(legacyMachine.anvils[0].openPos), { x: 86, y: 1, z: 0 })
  assert.deepEqual(relativeToAnchor(legacyMachine.foodChests[0].openPos), { x: 82, y: 1, z: 0 })
})
