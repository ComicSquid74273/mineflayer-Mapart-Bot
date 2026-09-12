'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')

const {
  addLiquidBlocksToAvoid,
  assertSafeDirectMachineRoutePoint,
  assertVerifiedDiagonalCornerGap,
  assertVerifiedMachineGap,
  assertVerifiedOneBlockGap,
  createLiquidProximityExclusion,
  createStepElevationExclusion,
  distanceToBlockInteraction,
  classifySafeLiquidMachineEgressCell,
  findSafeLiquidMachineEgress,
  horizontalDistance,
  planSafeFlatMachineRoute,
  walkSafeLiquidMachineEgress,
  walkAcrossVerifiedMachineGap,
  walkAcrossVerifiedOneBlockGap,
  walkToPreciseAccessPoint
} = require('../src/nerv-printer/precise-access')

class TestVec3 {
  constructor(x, y, z) {
    this.x = x
    this.y = y
    this.z = z
  }
}

function routeBlock(name, x, y, z, boundingBox = 'empty') {
  return { name, boundingBox, position: new TestVec3(x, y, z) }
}

function flatRouteBot(overrides = new Map()) {
  return {
    blockAt(position) {
      const key = `${position.x}:${position.y}:${position.z}`
      if (overrides.has(key)) return overrides.get(key)
      return position.y === 96
        ? routeBlock('stone', position.x, position.y, position.z, 'block')
        : routeBlock('air', position.x, position.y, position.z)
    }
  }
}

test('strict machine routes exclude water and bubble lifts without changing ordinary movement', () => {
  const movements = { blocksToAvoid: new Set([1]) }
  const registry = {
    blocksByName: {
      water: { id: 2 },
      flowing_water: { id: 3 },
      bubble_column: { id: 4 }
    }
  }

  assert.equal(addLiquidBlocksToAvoid(movements, registry), 3)
  assert.deepEqual([...movements.blocksToAvoid], [1, 2, 3, 4])
  assert.equal(addLiquidBlocksToAvoid(movements, registry), 0)
})

test('direct machine corridor accepts loaded flat floor and rejects a bubble lift ahead', () => {
  const position = new TestVec3(100.5, 97, 200.5)
  const target = new TestVec3(100.5, 97, 210.5)
  assert.doesNotThrow(() => assertSafeDirectMachineRoutePoint(flatRouteBot(), position, target))

  const bubble = new Map([
    ['100:97:201', routeBlock('bubble_column', 100, 97, 201)]
  ])
  assert.throws(
    () => assertSafeDirectMachineRoutePoint(flatRouteBot(bubble), position, target),
    /direct-machine-route-hazard bubble_column/
  )
})

test('post-print route resolves one safe supported step out of reconnect water', () => {
  const water = new Map([
    ['100:97:200', routeBlock('water', 100, 97, 200)]
  ])
  const egress = findSafeLiquidMachineEgress(
    flatRouteBot(water),
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(110.5, 97, 200.5),
    { expectedY: 97 }
  )

  assert.equal(egress.sourceLiquid, 'water')
  assert.deepEqual(egress.startCell, { x: 100, z: 200 })
  assert.deepEqual(egress.destinationCell, { x: 101, z: 200 })
  assert.deepEqual(egress.point, new TestVec3(101.5, 97, 200.5))
  assert.equal(egress.steps.length, 1)
  assert.equal(egress.liquidSteps, 0)
})

test('post-print liquid egress refuses unsupported starts and bounded liquid surroundings', () => {
  const unsupported = new Map([
    ['100:96:200', routeBlock('air', 100, 96, 200)],
    ['100:97:200', routeBlock('water', 100, 97, 200)]
  ])
  assert.equal(findSafeLiquidMachineEgress(
    flatRouteBot(unsupported),
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(110.5, 97, 200.5),
    { expectedY: 97 }
  ), null)

  const surrounded = new Map([
    ['100:97:200', routeBlock('water', 100, 97, 200)],
    ['101:97:200', routeBlock('water', 101, 97, 200)],
    ['99:97:200', routeBlock('water', 99, 97, 200)],
    ['100:97:201', routeBlock('water', 100, 97, 201)],
    ['100:97:199', routeBlock('water', 100, 97, 199)]
  ])
  assert.equal(findSafeLiquidMachineEgress(
    flatRouteBot(surrounded),
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(110.5, 97, 200.5),
    { expectedY: 97, maxSteps: 1 }
  ), null)
})

test('post-print route crosses only supported shallow water to the nearest dry cell', () => {
  const water = new Map()
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      if (Math.abs(dx) + Math.abs(dz) <= 2) {
        water.set(`${100 + dx}:97:${200 + dz}`, routeBlock('water', 100 + dx, 97, 200 + dz))
      }
    }
  }
  const bot = flatRouteBot(water)
  const egress = findSafeLiquidMachineEgress(
    bot,
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(100.5, 97, 210.5),
    { expectedY: 97, maxSteps: 8 }
  )

  assert.deepEqual(egress.steps.map((step) => step.cell), [
    { x: 100, z: 201 },
    { x: 100, z: 202 },
    { x: 100, z: 203 }
  ])
  assert.deepEqual(egress.steps.map((step) => step.kind), ['liquid', 'liquid', 'dry'])
  assert.equal(egress.liquidSteps, 2)
  assert.deepEqual(classifySafeLiquidMachineEgressCell(bot, egress.point, { expectedY: 97 }), {
    kind: 'dry',
    liquid: null
  })
})

test('post-print liquid egress replans from safe server-driven sideways drift', async () => {
  const water = new Map()
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      if (Math.abs(dx) + Math.abs(dz) <= 2) {
        water.set(`${100 + dx}:97:${200 + dz}`, routeBlock('water', 100 + dx, 97, 200 + dz))
      }
    }
  }
  const bot = {
    ...flatRouteBot(water),
    entity: { position: new TestVec3(100.5, 97, 200.5) }
  }
  let walkCalls = 0
  const replans = []
  const result = await walkSafeLiquidMachineEgress(bot, new TestVec3(100.5, 97, 210.5), {
    expectedY: 97,
    maxReplans: 3,
    walkToPoint: async (_bot, target) => {
      walkCalls += 1
      if (walkCalls === 1) {
        bot.entity.position = new TestVec3(102.5, 97, 200.5)
        throw new Error('water-current-drift')
      }
      bot.entity.position = new TestVec3(target.x, target.y, target.z)
    },
    onReplan: ({ replans: count }) => replans.push(count)
  })

  assert.equal(result.reachedDry, true)
  assert.equal(result.replans, 1)
  assert.deepEqual(replans, [1])
  assert.equal(classifySafeLiquidMachineEgressCell(bot, bot.entity.position, { expectedY: 97 }).kind, 'dry')
})

test('post-print liquid egress never replans from unsupported drift', async () => {
  const water = new Map([
    ['100:97:200', routeBlock('water', 100, 97, 200)],
    ['102:96:200', routeBlock('air', 102, 96, 200)],
    ['102:97:200', routeBlock('water', 102, 97, 200)]
  ])
  const bot = {
    ...flatRouteBot(water),
    entity: { position: new TestVec3(100.5, 97, 200.5) }
  }

  await assert.rejects(
    walkSafeLiquidMachineEgress(bot, new TestVec3(110.5, 97, 200.5), {
      expectedY: 97,
      walkToPoint: async () => {
        bot.entity.position = new TestVec3(102.5, 97, 200.5)
        throw new Error('unsafe-water-current-drift')
      }
    }),
    /unsafe-water-current-drift/
  )
})

test('machine path step exclusion keeps the player hitbox one block from liquid lifts', () => {
  const water = new Map([
    ['101:97:200', routeBlock('water', 101, 97, 200)]
  ])
  const exclude = createLiquidProximityExclusion(flatRouteBot(water), 1)
  assert.equal(exclude(routeBlock('air', 100, 97, 200)), 100)
  assert.equal(exclude(routeBlock('air', 99, 97, 200)), 0)
})

test('direct machine corridor permits a centered adjacent cell but rejects hitbox drift into a lift', () => {
  const water = new Map([
    ['101:97:200', routeBlock('bubble_column', 101, 97, 200)]
  ])
  const bot = flatRouteBot(water)
  assert.doesNotThrow(() => assertSafeDirectMachineRoutePoint(
    bot,
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(100.5, 97, 200.5)
  ))
  assert.throws(
    () => assertSafeDirectMachineRoutePoint(
      bot,
      new TestVec3(100.7, 97, 200.5),
      new TestVec3(100.7, 97, 200.5)
    ),
    /direct-machine-route-hitbox-hazard bubble_column/
  )
})

test('direct machine corridor does not inflate the player hitbox into an adjacent chest', () => {
  const chestX = -217
  const chestY = 96
  const chestZ = 235
  const nearbyChest = new Map([
    [`${chestX}:${chestY}:${chestZ}`, routeBlock('chest', chestX, chestY, chestZ, 'block')]
  ])
  const bot = {
    blockAt(position) {
      const key = `${position.x}:${position.y}:${position.z}`
      if (nearbyChest.has(key)) return nearbyChest.get(key)
      return position.y === chestY - 1
        ? routeBlock('stone', position.x, position.y, position.z, 'block')
        : routeBlock('air', position.x, position.y, position.z)
    }
  }

  assert.doesNotThrow(() => assertSafeDirectMachineRoutePoint(
    bot,
    new TestVec3(-216.33, 96, 236.31),
    new TestVec3(-216.49, 96, 237.82),
    { expectedY: 96 }
  ))
})

test('direct machine corridor rejects missing floor and elevation drift', () => {
  const position = new TestVec3(100.5, 97, 200.5)
  const target = new TestVec3(100.5, 97, 210.5)
  const missingFloor = new Map([
    ['100:96:201', routeBlock('air', 100, 96, 201)]
  ])
  assert.throws(
    () => assertSafeDirectMachineRoutePoint(flatRouteBot(missingFloor), position, target),
    /direct-machine-route-missing-floor/
  )
  assert.throws(
    () => assertSafeDirectMachineRoutePoint(flatRouteBot(), new TestVec3(100.5, 99, 200.5), target),
    /direct-machine-route-left-elevation/
  )
})

test('direct machine corridor accepts carpet as a thin walkable floor cover', () => {
  const carpet = new Map([
    ['100:97:200', routeBlock('black_carpet', 100, 97, 200, 'block')],
    ['100:97:201', routeBlock('black_carpet', 100, 97, 201, 'block')]
  ])
  assert.doesNotThrow(() => assertSafeDirectMachineRoutePoint(
    flatRouteBot(carpet),
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(100.5, 97, 201.5)
  ))
})

test('direct machine corridor accepts a carpet-only walking surface over air', () => {
  const floatingCarpet = new Map([
    ['100:96:200', routeBlock('air', 100, 96, 200)],
    ['100:96:201', routeBlock('air', 100, 96, 201)],
    ['100:97:200', routeBlock('black_carpet', 100, 97, 200)],
    ['100:97:201', routeBlock('black_carpet', 100, 97, 201)]
  ])

  assert.doesNotThrow(() => assertSafeDirectMachineRoutePoint(
    flatRouteBot(floatingCarpet),
    new TestVec3(100.5, 97.0625, 200.5),
    new TestVec3(100.5, 97.0625, 201.5),
    { expectedY: 97 }
  ))
})

test('flat machine route traverses connected carpet-only cells but still rejects true air gaps', () => {
  const carpetOnly = new Map()
  for (let z = 200; z <= 202; z += 1) {
    carpetOnly.set(`100:96:${z}`, routeBlock('air', 100, 96, z))
    carpetOnly.set(`100:97:${z}`, routeBlock('black_carpet', 100, 97, z))
  }
  const carpetOnlyBot = {
    blockAt(position) {
      return carpetOnly.get(`${position.x}:${position.y}:${position.z}`) ||
        routeBlock('air', position.x, position.y, position.z)
    }
  }

  const route = planSafeFlatMachineRoute(
    carpetOnlyBot,
    new TestVec3(100.5, 97.0625, 200.5),
    new TestVec3(100.5, 97.0625, 202.5),
    { expectedY: 97, padding: 2 }
  )
  assert.deepEqual(route.cells.map((cell) => [cell.x, cell.z]), [
    [100, 200],
    [100, 201],
    [100, 202]
  ])

  carpetOnly.delete('100:97:201')
  assert.throws(
    () => planSafeFlatMachineRoute(
      carpetOnlyBot,
      new TestVec3(100.5, 97.0625, 200.5),
      new TestVec3(100.5, 97.0625, 202.5),
      { expectedY: 97, padding: 2 }
    ),
    /flat-machine-route-unavailable/
  )
})

test('direct machine corridor accepts bottom slabs but rejects slabs obstructing the foot level', () => {
  const bottomSlab = (x, z) => ({
    ...routeBlock('cherry_slab', x, 97, z, 'block'),
    shapes: [[0, 0, 0, 1, 0.5, 1]],
    getProperties: () => ({ type: 'bottom' })
  })
  const bottomSlabs = new Map([
    ['100:97:200', bottomSlab(100, 200)],
    ['100:97:201', bottomSlab(100, 201)]
  ])
  assert.doesNotThrow(() => assertSafeDirectMachineRoutePoint(
    flatRouteBot(bottomSlabs),
    new TestVec3(100.5, 97.5, 200.5),
    new TestVec3(100.5, 97, 201.5),
    { expectedY: 97 }
  ))

  const topSlab = {
    ...routeBlock('cherry_slab', 100, 97, 200, 'block'),
    shapes: [[0, 0.5, 0, 1, 1, 1]],
    getProperties: () => ({ type: 'top' })
  }
  assert.throws(
    () => assertSafeDirectMachineRoutePoint(
      flatRouteBot(new Map([['100:97:200', topSlab]])),
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(100.5, 97, 200.5)
    ),
    /direct-machine-route-obstructed cherry_slab/
  )
})

test('flat machine route goes around a floor gap instead of crossing it', () => {
  const gap = new Map([
    ['101:96:200', routeBlock('air', 101, 96, 200)]
  ])
  const route = planSafeFlatMachineRoute(
    flatRouteBot(gap),
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(102.5, 97, 200.5),
    { padding: 2 }
  )

  assert.ok(route.cells.length > 3)
  assert.equal(route.cells.some((cell) => cell.x === 101 && cell.z === 200), false)
  assert.deepEqual(route.waypoints.at(-1), new TestVec3(102.5, 97, 200.5))
})

test('flat machine route supports a full post-print traverse and refuses a spanning floor break', () => {
  const start = new TestVec3(100.5, 97, 200.5)
  const target = new TestVec3(227.5, 97, 200.5)
  const route = planSafeFlatMachineRoute(flatRouteBot(), start, target, {
    padding: 2,
    maxNodes: 50000,
    maxOneBlockGaps: 0
  })

  assert.equal(route.cells.length, 128)
  assert.equal(route.gapCrossings.length, 0)

  const spanningBreak = new Map()
  for (let z = 198; z <= 202; z += 1) {
    spanningBreak.set(`164:96:${z}`, routeBlock('air', 164, 96, z))
  }
  assert.throws(
    () => planSafeFlatMachineRoute(flatRouteBot(spanningBreak), start, target, {
      padding: 2,
      maxNodes: 50000,
      maxOneBlockGaps: 0
    }),
    /flat-machine-route-unavailable/
  )
})

test('flat machine route keeps a one-block margin from a liquid lift', () => {
  const lift = new Map([
    ['101:97:199', routeBlock('bubble_column', 101, 97, 199)]
  ])
  const route = planSafeFlatMachineRoute(
    flatRouteBot(lift),
    new TestVec3(99.5, 97, 200.5),
    new TestVec3(103.5, 97, 200.5),
    { padding: 3, liquidProximityRadius: 1 }
  )

  assert.equal(route.cells.some((cell) => cell.x === 101 && cell.z === 200), false)
  for (const cell of route.cells) {
    assert.ok(Math.abs(cell.x - 101) > 1 || Math.abs(cell.z - 199) > 1)
  }
})

test('flat machine ingress stops at a safe cell inside the requested goal corridor', () => {
  const unsafeGoal = new Map([
    ['104:96:200', routeBlock('air', 104, 96, 200)]
  ])
  const target = new TestVec3(104.5, 97, 200.5)
  const route = planSafeFlatMachineRoute(
    flatRouteBot(unsafeGoal),
    new TestVec3(100.5, 97, 200.5),
    target,
    { padding: 2, goalTolerance: 1.6 }
  )

  assert.equal(route.cells.at(-1).x, 103)
  assert.ok(horizontalDistance(route.waypoints.at(-1), target) <= 1.6)
})

test('flat machine ingress advances to the nearest loaded safe frontier without crossing unloaded cells', () => {
  const unloadedBoundary = new Map()
  for (let z = 198; z <= 202; z += 1) {
    unloadedBoundary.set(`103:96:${z}`, null)
  }
  const target = new TestVec3(105.5, 97, 200.5)
  const route = planSafeFlatMachineRoute(
    flatRouteBot(unloadedBoundary),
    new TestVec3(100.5, 97, 200.5),
    target,
    { padding: 2, allowPartial: true, minPartialProgress: 0.5 }
  )

  assert.equal(route.partial, true)
  assert.equal(route.progress, 2)
  assert.deepEqual(route.cells.at(-1), { x: 102, z: 200 })
  assert.deepEqual(route.waypoints.at(-1), new TestVec3(102.5, 97, 200.5))
  assert.equal(route.cells.some((cell) => cell.x === 103), false)
})

test('flat machine ingress refuses a partial route that cannot make target progress', () => {
  const unloadedBoundary = new Map()
  for (let z = 198; z <= 202; z += 1) {
    unloadedBoundary.set(`101:96:${z}`, null)
  }
  assert.throws(
    () => planSafeFlatMachineRoute(
      flatRouteBot(unloadedBoundary),
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(105.5, 97, 200.5),
      { padding: 2, allowPartial: true, minPartialProgress: 0.5 }
    ),
    /nearestGoal=5\.00@100,200.*boundary=direct-machine-route-unloaded/
  )
})

test('flat machine route marks one explicit verified gap crossing instead of enabling parkour', () => {
  const gap = new Map([
    ['101:96:200', routeBlock('air', 101, 96, 200)]
  ])
  for (let z = 198; z <= 202; z += 1) {
    if (z !== 200) gap.set(`101:96:${z}`, null)
  }
  const route = planSafeFlatMachineRoute(
    flatRouteBot(gap),
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(103.5, 97, 200.5),
    { padding: 2, allowOneBlockGap: true }
  )

  assert.equal(route.gapCrossings.length, 1)
  assert.deepEqual(route.cells.slice(0, 3), [
    { x: 100, z: 200 },
    { x: 102, z: 200 },
    { x: 103, z: 200 }
  ])
  assert.deepEqual(route.steps.map((step) => step.type), ['walk', 'gap', 'walk'])
  assert.deepEqual(route.gapCrossings[0].middle, new TestVec3(101.5, 97, 200.5))
})

test('flat machine route permits several separately verified one-cell crossings', () => {
  const gaps = new Map([
    ['101:96:200', routeBlock('air', 101, 96, 200)],
    ['103:96:200', routeBlock('air', 103, 96, 200)]
  ])
  for (let z = 198; z <= 202; z += 1) {
    if (z === 200) continue
    gaps.set(`101:96:${z}`, null)
    gaps.set(`103:96:${z}`, null)
  }
  const route = planSafeFlatMachineRoute(
    flatRouteBot(gaps),
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(105.5, 97, 200.5),
    { padding: 2, maxOneBlockGaps: 2 }
  )

  assert.equal(route.gapCrossings.length, 2)
  assert.deepEqual(route.cells.slice(0, 4), [
    { x: 100, z: 200 },
    { x: 102, z: 200 },
    { x: 104, z: 200 },
    { x: 105, z: 200 }
  ])
  assert.deepEqual(route.steps.map((step) => step.type), ['walk', 'gap', 'gap', 'walk'])
})

test('flat machine route enforces the configured verified crossing limit', () => {
  const gaps = new Map([
    ['101:96:200', routeBlock('air', 101, 96, 200)],
    ['103:96:200', routeBlock('air', 103, 96, 200)]
  ])
  for (let z = 198; z <= 202; z += 1) {
    if (z === 200) continue
    gaps.set(`101:96:${z}`, null)
    gaps.set(`103:96:${z}`, null)
  }

  assert.throws(
    () => planSafeFlatMachineRoute(
      flatRouteBot(gaps),
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(105.5, 97, 200.5),
      { padding: 2, maxOneBlockGaps: 1 }
    ),
    /flat-machine-route-unavailable/
  )
})

test('flat machine route hard-rejects multi-cell voids even when configured wider', () => {
  const gaps = new Map()
  for (let x = 101; x <= 103; x += 1) {
    for (let z = 198; z <= 202; z += 1) {
      gaps.set(`${x}:96:${z}`, z === 200
        ? routeBlock('air', x, 96, z)
        : null)
    }
  }
  const bot = flatRouteBot(gaps)
  for (const configuredWidth of [1, 2, 3, 20]) {
    assert.throws(
      () => planSafeFlatMachineRoute(
        bot,
        new TestVec3(100.5, 97, 200.5),
        new TestVec3(105.5, 97, 200.5),
        { padding: 2, maxOneBlockGaps: 1, maxVerifiedGapWidth: configuredWidth }
      ),
      /flat-machine-route-unavailable/
    )
  }
})

test('flat machine route does not duplicate physical cells for every crossing count', () => {
  const trench = new Map()
  for (let x = 103; x <= 104; x += 1) {
    for (let z = 190; z <= 210; z += 1) {
      trench.set(`${x}:96:${z}`, routeBlock('air', x, 96, z))
    }
  }

  let message = ''
  try {
    planSafeFlatMachineRoute(
      flatRouteBot(trench),
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(107.5, 97, 200.5),
      { padding: 5, maxNodes: 500, maxOneBlockGaps: 16 }
    )
    assert.fail('expected the two-cell trench to remain uncrossable')
  } catch (err) {
    message = String(err?.message || err)
  }

  const counts = message.match(/checked=(\d+) discovered=(\d+) maxGaps=16/)
  assert.ok(counts, message)
  assert.ok(Number(counts[1]) < 500, message)
  assert.ok(Number(counts[2]) <= 198, message)
})

test('verified gap geometry rejects liquid or obstructed intermediate cells', () => {
  const bubbleGap = new Map([
    ['101:96:200', routeBlock('air', 101, 96, 200)],
    ['101:97:200', routeBlock('bubble_column', 101, 97, 200)]
  ])
  assert.throws(
    () => assertVerifiedOneBlockGap(
      flatRouteBot(bubbleGap),
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(102.5, 97, 200.5)
    ),
    /machine-gap-obstructed bubble_column/
  )
})

test('verified machine geometry hard-rejects three unsupported cells', () => {
  const blocks = new Map()
  for (let x = 101; x <= 103; x += 1) {
    blocks.set(`${x}:96:200`, routeBlock('air', x, 96, 200))
  }
  assert.throws(
    () => assertVerifiedMachineGap(
      flatRouteBot(blocks),
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(104.5, 97, 200.5),
      { maxGapCells: 3 }
    ),
    /machine-gap-too-wide cells=3 max=1/
  )
})

test('verified machine geometry rejects four unsupported cells even when configured wider', () => {
  const blocks = new Map()
  for (let x = 101; x <= 104; x += 1) {
    blocks.set(`${x}:96:200`, routeBlock('air', x, 96, 200))
  }
  assert.throws(
    () => assertVerifiedMachineGap(
      flatRouteBot(blocks),
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(105.5, 97, 200.5),
      { maxGapCells: 20 }
    ),
    /machine-gap-too-wide cells=4 max=1/
  )
})

test('verified diagonal corner geometry is rejected by the one-cell hard limit', () => {
  const diagonalGap = new Map([
    ['101:96:200', routeBlock('air', 101, 96, 200)],
    ['100:96:201', routeBlock('air', 100, 96, 201)]
  ])
  assert.throws(
    () => assertVerifiedDiagonalCornerGap(
      flatRouteBot(diagonalGap),
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(101.5, 97, 201.5)
    ),
    /machine-gap-too-wide cells=2 max=1/
  )
})

test('flat machine route rejects a diagonal seam even when the legacy option is enabled', () => {
  const blocks = new Map([
    ['100:96:200', routeBlock('stone', 100, 96, 200, 'block')],
    ['101:96:201', routeBlock('stone', 101, 96, 201, 'block')],
    ['101:96:200', routeBlock('air', 101, 96, 200)],
    ['100:96:201', routeBlock('air', 100, 96, 201)]
  ])
  const bot = {
    blockAt(position) {
      const key = `${position.x}:${position.y}:${position.z}`
      if (blocks.has(key)) return blocks.get(key)
      if (position.y === 97 || position.y === 98) {
        return routeBlock('air', position.x, position.y, position.z)
      }
      return null
    }
  }

  assert.throws(
    () => planSafeFlatMachineRoute(
      bot,
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(101.5, 97, 201.5),
      { padding: 2, maxOneBlockGaps: 1 }
    ),
    /flat-machine-route-unavailable/
  )

  assert.throws(
    () => planSafeFlatMachineRoute(
      bot,
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(101.5, 97, 201.5),
      { padding: 2, maxOneBlockGaps: 1, allowDiagonalCornerGap: true }
    ),
    /flat-machine-route-unavailable/
  )
})

test('verified one-cell crossing centers, walks without sprint, and releases movement on landing', async () => {
  const gap = new Map([
    ['101:96:200', routeBlock('air', 101, 96, 200)]
  ])
  const controls = new Map()
  const pathfinderCalls = []
  const bot = {
    ...flatRouteBot(gap),
    entity: {
      position: new TestVec3(100.5, 97, 200.5),
      eyeHeight: 1.62,
      onGround: true
    },
    pathfinder: {
      stop() { pathfinderCalls.push('stop') },
      setGoal(goal) { pathfinderCalls.push(['setGoal', goal]) }
    },
    async lookAt(point) { this.aim = point },
    setControlState(control, value) { controls.set(control, value) }
  }
  let tick = 0
  const result = await walkAcrossVerifiedOneBlockGap(
    bot,
    new TestVec3(100.5, 97, 200.5),
    new TestVec3(102.5, 97, 200.5),
    {
      pollMs: 20,
      timeoutMs: 1000,
      jumpHoldMs: 300,
      wait: async () => {
        tick += 1
        bot.entity.position.x = Math.min(102.5, 100.5 + (tick * 0.25))
        bot.entity.position.y = tick < 8 ? 97.6 : 97
        bot.entity.onGround = tick >= 8
      }
    }
  )

  assert.equal(result.landingDistance, 0)
  assert.equal(controls.get('forward'), false)
  assert.equal(controls.get('jump'), false)
  assert.equal(controls.get('sprint'), false)
  assert.deepEqual(pathfinderCalls, ['stop', ['setGoal', null]])
})

test('verified diagonal crossing executor rejects before applying controls', async () => {
  const diagonalGap = new Map([
    ['101:96:200', routeBlock('air', 101, 96, 200)],
    ['100:96:201', routeBlock('air', 100, 96, 201)]
  ])
  const controls = []
  const bot = {
    ...flatRouteBot(diagonalGap),
    entity: {
      position: new TestVec3(100.5, 97, 200.5),
      eyeHeight: 1.62,
      onGround: true
    },
    pathfinder: {
      stop() {},
      setGoal() {}
    },
    async lookAt(point) { this.aim = point },
    setControlState(control, value) { controls.push([control, value]) }
  }
  await assert.rejects(
    walkAcrossVerifiedMachineGap(
      bot,
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(101.5, 97, 201.5)
    ),
    /machine-gap-too-wide cells=2 max=1/
  )
  assert.deepEqual(controls, [])
})

test('verified crossing executor rejects multi-cell gaps before applying controls', async () => {
  const gaps = new Map()
  for (let x = 101; x <= 103; x += 1) {
    gaps.set(`${x}:96:200`, routeBlock('air', x, 96, 200))
  }
  const controls = []
  const bot = {
    ...flatRouteBot(gaps),
    entity: {
      position: new TestVec3(100.5, 97, 200.5),
      eyeHeight: 1.62,
      onGround: true
    },
    pathfinder: {
      stop() {},
      setGoal() {}
    },
    async lookAt(point) { this.aim = point },
    setControlState(control, value) { controls.push([control, value]) }
  }
  await assert.rejects(
    walkAcrossVerifiedMachineGap(
      bot,
      new TestVec3(100.5, 97, 200.5),
      new TestVec3(104.5, 97, 200.5),
      { maxGapCells: 20 }
    ),
    /machine-gap-too-wide cells=3 max=1/
  )
  assert.deepEqual(controls, [])
})

test('flat machine route uses a safe reachable-side interaction point without crossing a floor trench', () => {
  const trench = new Map([
    ['100:96:101', routeBlock('air', 100, 96, 101)],
    ['100:96:102', routeBlock('air', 100, 96, 102)],
    ['100:96:103', routeBlock('air', 100, 96, 103)]
  ])
  const bot = flatRouteBot(trench)
  const blockPosition = new TestVec3(100, 97, 99)
  const route = planSafeFlatMachineRoute(
    bot,
    new TestVec3(100.5, 97, 104.5),
    new TestVec3(100.5, 97, 101.82),
    {
      padding: 4,
      interactionBlock: blockPosition,
      interactionReach: 4.4
    }
  )

  assert.equal(route.interactionReady, true)
  assert.deepEqual(route.cells, [{ x: 100, z: 104 }])
  assert.equal(route.waypoints[0].z, 104.355)
  assert.ok(distanceToBlockInteraction(route.waypoints[0], blockPosition) <= 4.4)
})

test('flat machine route honors a tight support-stock interaction radius', () => {
  const chest = new TestVec3(100, 97, 200)
  const route = planSafeFlatMachineRoute(
    flatRouteBot(),
    new TestVec3(110.5, 97, 200.5),
    new TestVec3(102, 97, 202),
    {
      padding: 4,
      interactionBlock: chest,
      interactionReach: 2.25
    }
  )

  assert.equal(route.interactionReady, true)
  assert.ok(route.interactionDistance <= 2.25)
  assert.ok(distanceToBlockInteraction(route.waypoints.at(-1), chest) <= 2.25)
})

test('flat machine route keeps a chest-row approach centered outside adjacent hitboxes', () => {
  const blocks = new Map()
  for (let x = 100; x <= 108; x += 1) {
    blocks.set(`${x}:97:105`, routeBlock('chest', x, 97, 105))
  }
  const bot = flatRouteBot(blocks)
  const chest = new TestVec3(100, 97, 105)
  const route = planSafeFlatMachineRoute(
    bot,
    new TestVec3(109.5, 97, 106.5),
    new TestVec3(100.49, 97, 107.82),
    {
      padding: 4,
      interactionBlock: chest,
      interactionReach: 4.4
    }
  )

  assert.equal(route.interactionReady, true)
  assert.ok(route.cells.every((cell) => cell.z >= 106))
  assert.ok(route.waypoints.every((point) => point.z >= 106.35))
  assert.ok(distanceToBlockInteraction(route.waypoints.at(-1), chest) <= 4.4)
})

test('flat machine interaction planning uses the real bottom-slab standing height', () => {
  const slab = (x, y, z) => ({
    ...routeBlock('stone_slab', x, y, z, 'block'),
    shapes: [[0, 0, 0, 1, 0.5, 1]],
    getProperties: () => ({ type: 'bottom' })
  })
  const base = flatRouteBot()
  const bot = {
    blockAt(position) {
      if (position.y === 97) return slab(position.x, position.y, position.z)
      return base.blockAt(position)
    }
  }
  const table = new TestVec3(100, 96, 100)
  const route = planSafeFlatMachineRoute(
    bot,
    new TestVec3(106.5, 97.5, 106.5),
    new TestVec3(100.5, 97, 100.5),
    {
      expectedY: 97,
      verticalTolerance: 0.75,
      padding: 8,
      interactionBlock: table,
      interactionReach: 3.8
    }
  )

  assert.equal(route.interactionReady, true)
  assert.equal(route.waypoints.at(-1).y, 97.5)
  assert.ok(distanceToBlockInteraction(route.waypoints.at(-1), table) <= 3.8)
})

test('unavailable block-reach routes report the nearest safe interaction boundary', () => {
  const trench = new Map()
  for (let x = 96; x <= 104; x += 1) {
    for (let z = 101; z <= 103; z += 1) {
      trench.set(`${x}:96:${z}`, routeBlock('air', x, 96, z))
    }
  }
  assert.throws(
    () => planSafeFlatMachineRoute(
      flatRouteBot(trench),
      new TestVec3(100.5, 97, 104.5),
      new TestVec3(100.5, 97, 101.82),
      {
        padding: 4,
        interactionBlock: new TestVec3(100, 97, 98),
        interactionReach: 4.4
      }
    ),
    /nearestInteraction=5\.39@100,104.*boundary=direct-machine-route-missing-floor/
  )
})

test('machine route elevation exclusion permits the configured foot level and head room only', () => {
  const exclude = createStepElevationExclusion(97, 98)
  assert.equal(exclude({ position: new Vec3(0, 97, 0) }), 0)
  assert.equal(exclude({ position: new Vec3(0, 96, 0) }), 100)
  assert.equal(exclude({ position: new Vec3(0, 98, 0) }), 0)
  assert.equal(exclude({ position: new Vec3(0, 99, 0) }), 100)
  assert.equal(exclude(null), 100)
})

test('precise access uses legal forward movement to reach the server-settled checkpoint allowance', async () => {
  const controls = new Map()
  const pathfinderCalls = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
    pathfinder: {
      stop() { pathfinderCalls.push('stop') },
      setGoal(goal) { pathfinderCalls.push(['setGoal', goal]) }
    },
    async lookAt(point) { this.aim = point },
    setControlState(control, value) { controls.set(control, value) }
  }
  const target = new Vec3(2, 64, 0.5)

  const result = await walkToPreciseAccessPoint(bot, target, {
    tolerance: 0.2,
    settledTolerance: 0.35,
    pollMs: 20,
    settleMs: 0,
    wait: async () => {
      if (controls.get('forward')) bot.entity.position.x += 0.18
    }
  })

  assert.equal(result.moved, true)
  assert.ok(horizontalDistance(bot.entity.position, target) <= 0.35)
  assert.equal(controls.get('forward'), false)
  assert.deepEqual(bot.aim, new Vec3(2, 65.62, 0.5))
  assert.deepEqual(pathfinderCalls, ['stop', ['setGoal', null]])
})

test('precise access is stationary during every asynchronous reorientation', async () => {
  const controls = new Map()
  const lookForces = []
  const bot = {
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 },
    pathfinder: { stop() {}, setGoal() {} },
    async lookAt(point, force) {
      assert.equal(controls.get('forward'), false, 'forward must be released before turning')
      lookForces.push(force)
      await new Promise((resolve) => setImmediate(resolve))
      this.aim = point
    },
    setControlState(control, value) { controls.set(control, value) }
  }
  const target = new Vec3(0.8, 64, 0)

  const result = await walkToPreciseAccessPoint(bot, target, {
    tolerance: 0.05,
    requireCompletionPredicate: true,
    isComplete: (position) => position.x >= 0.7,
    pollMs: 20,
    settleMs: 0,
    wait: async () => {
      if (controls.get('forward')) bot.entity.position.x += 0.25
    }
  })

  assert.ok(lookForces.length >= 2)
  assert.ok(lookForces.every((force) => force === true))
  assert.equal(result.completedBy, 'predicate')
  assert.equal(controls.get('forward'), false)
})

test('precise access does not move when already inside the reference buffer', async () => {
  let controlWrites = 0
  const bot = {
    entity: { position: new Vec3(2.1, 64, 3.1), eyeHeight: 1.62 },
    setControlState() { controlWrites += 1 }
  }

  const result = await walkToPreciseAccessPoint(bot, new Vec3(2, 64, 3), {
    tolerance: 0.2,
    settleMs: 0
  })

  assert.equal(result.moved, false)
  assert.ok(result.finalDistance < 0.2)
  assert.equal(controlWrites, 5)
})

test('precise access stops at a live interaction condition before chasing an exact sub-cell point', async () => {
  let controlWrites = 0
  const bot = {
    entity: { position: new Vec3(2.2, 64, 3.2), eyeHeight: 1.62 },
    setControlState() { controlWrites += 1 }
  }

  const result = await walkToPreciseAccessPoint(bot, new Vec3(2, 64, 3), {
    tolerance: 0.05,
    settleMs: 0,
    isComplete: (position) => horizontalDistance(position, new Vec3(2, 64, 3)) <= 0.3
  })

  assert.equal(result.moved, false)
  assert.equal(result.completedBy, 'predicate')
  assert.ok(result.finalDistance > 0.05)
  assert.equal(controlWrites, 5)
})

test('precise access does not let cell settlement override a required interaction predicate', async () => {
  const controls = new Map()
  let movementPolls = 0
  const bot = {
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 },
    pathfinder: { stop() {}, setGoal() {} },
    async lookAt() {},
    setControlState(control, value) { controls.set(control, value) }
  }
  const target = new Vec3(1, 64, 0)

  const result = await walkToPreciseAccessPoint(bot, target, {
    tolerance: 0.05,
    settledTolerance: 0.45,
    requireCompletionPredicate: true,
    isComplete: (position) => position.x >= 0.8,
    pollMs: 20,
    settleMs: 0,
    wait: async () => {
      movementPolls += 1
      if (controls.get('forward')) bot.entity.position.x = movementPolls === 1 ? 0.64 : 0.82
    }
  })

  assert.equal(movementPolls, 2, 'the 0.36-block cell settlement must not end a chest-interaction route')
  assert.equal(result.completedBy, 'predicate')
  assert.equal(Number(result.finalDistance.toFixed(2)), 0.18)
  assert.equal(controls.get('forward'), false)
})

test('precise access requires a server-stable interaction predicate before returning', async () => {
  const controls = new Map()
  let movementPolls = 0
  let reconciliations = 0
  const bot = {
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 },
    pathfinder: { stop() {}, setGoal() {} },
    async lookAt() {},
    setControlState(control, value) { controls.set(control, value) }
  }
  const target = new Vec3(1, 64, 0)

  const result = await walkToPreciseAccessPoint(bot, target, {
    tolerance: 0.05,
    requireCompletionPredicate: true,
    isComplete: (position) => position.x >= 0.8,
    pollMs: 20,
    settleMs: 100,
    wait: async () => {
      if (controls.get('forward')) {
        movementPolls += 1
        bot.entity.position.x = movementPolls === 1 ? 0.85 : 0.9
      } else if (bot.entity.position.x === 0.85) {
        reconciliations += 1
        bot.entity.position.x = 0.2
      }
    }
  })

  assert.equal(reconciliations, 1, 'the first client-reached position is reconciled by the server')
  assert.equal(movementPolls, 2, 'movement continues within the same bounded approach after reconciliation')
  assert.equal(result.completedBy, 'predicate')
  assert.equal(Number(result.finalDistance.toFixed(2)), 0.1)
  assert.equal(controls.get('forward'), false)
})

test('precise access accepts a stable server-settled pose inside the bounded allowance', async () => {
  const controls = new Map()
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
    pathfinder: { stop() {} },
    async lookAt() {},
    setControlState(control, value) { controls.set(control, value) }
  }
  const target = new Vec3(2, 64, 0.5)

  const result = await walkToPreciseAccessPoint(bot, target, {
    tolerance: 0.2,
    settledTolerance: 0.35,
    pollMs: 20,
    settleMs: 0,
    wait: async () => {
      if (controls.get('forward')) {
        bot.entity.position.x = Math.min(1.68, bot.entity.position.x + 0.59)
      }
    }
  })

  assert.equal(result.moved, true)
  assert.ok(horizontalDistance(bot.entity.position, target) > 0.2)
  assert.ok(horizontalDistance(bot.entity.position, target) <= 0.35)
  assert.equal(controls.get('forward'), false)
})

test('precise access accepts the live 0.36-block post-print cell-center settlement', async () => {
  const controls = new Map()
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
    pathfinder: { stop() {}, setGoal() {} },
    async lookAt() {},
    setControlState(control, value) { controls.set(control, value) }
  }
  const target = new Vec3(2, 64, 0.5)

  const result = await walkToPreciseAccessPoint(bot, target, {
    tolerance: 0.35,
    settledTolerance: 0.45,
    pollMs: 20,
    settleMs: 0,
    wait: async () => {
      if (controls.get('forward')) bot.entity.position.x = 1.64
    }
  })

  assert.equal(result.moved, true)
  assert.equal(Number(horizontalDistance(bot.entity.position, target).toFixed(2)), 0.36)
  assert.ok(result.finalDistance < 0.5, 'the entity center must remain inside the verified route cell')
  assert.equal(controls.get('forward'), false)
})

test('precise access refuses to replace route-aware pathing across a long final gap', async () => {
  let controlWrites = 0
  const bot = {
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 },
    setControlState() { controlWrites += 1 }
  }

  await assert.rejects(
    walkToPreciseAccessPoint(bot, new Vec3(2, 64, 0), {
      maxStartDistance: 1.6,
      settleMs: 0
    }),
    /precise-access-route-too-long/
  )
  assert.equal(controlWrites, 0)
})

test('precise access stops immediately when server position leaves the target elevation', async () => {
  const controls = new Map()
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
    pathfinder: { stop() {}, setGoal() {} },
    async lookAt() {},
    setControlState(control, value) { controls.set(control, value) }
  }

  await assert.rejects(
    walkToPreciseAccessPoint(bot, new Vec3(1, 64, 0.5), {
      maxStartDistance: 0.75,
      pollMs: 20,
      settleMs: 0,
      validatePosition(position) {
        if (Math.abs(position.y - 64) > 0.25) throw new Error('unsafe-vertical-drift')
      },
      wait: async () => {
        if (controls.get('forward')) {
          bot.entity.position.x += 0.1
          bot.entity.position.y -= 0.5
        }
      }
    }),
    /unsafe-vertical-drift/
  )
  assert.equal(controls.get('forward'), false)
})
