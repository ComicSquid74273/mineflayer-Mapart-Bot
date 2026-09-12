'use strict'

// Live 6b6t validation proved that even a geometrically clear multi-cell gap
// can fail under server physics and drop the bot. Keep the hard safety limit
// at one unsupported floor cell regardless of configuration.
const MAX_VERIFIED_MACHINE_GAP_CELLS = 1

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function horizontalDistance(position, target) {
  if (!position || !target) return Number.POSITIVE_INFINITY
  const dx = Number(position.x) - Number(target.x)
  const dz = Number(position.z) - Number(target.z)
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return Number.POSITIVE_INFINITY
  return Math.sqrt((dx * dx) + (dz * dz))
}

function stopHorizontalControls(bot) {
  for (const control of ['forward', 'back', 'left', 'right', 'sprint']) {
    try { bot?.setControlState?.(control, false) } catch { }
  }
}

function createStepElevationExclusion(minStepY, maxStepY) {
  const minY = Number(minStepY)
  const maxY = Number(maxStepY)
  return (block) => {
    const y = Number(block?.position?.y)
    if (!Number.isFinite(y)) return 100
    if (Number.isFinite(minY) && y < minY) return 100
    if (Number.isFinite(maxY) && y > maxY) return 100
    return 0
  }
}

function addLiquidBlocksToAvoid(movements, registry) {
  if (!(movements?.blocksToAvoid instanceof Set)) return 0
  let added = 0
  for (const name of ['water', 'flowing_water', 'bubble_column']) {
    const id = Number(registry?.blocksByName?.[name]?.id)
    if (!Number.isInteger(id) || movements.blocksToAvoid.has(id)) continue
    movements.blocksToAvoid.add(id)
    added += 1
  }
  return added
}

function createLiquidProximityExclusion(bot, radius = 1) {
  const safeRadius = Math.max(0, Math.floor(Number(radius) || 0))
  const hazardous = new Set(['water', 'flowing_water', 'bubble_column', 'lava', 'flowing_lava'])
  return (block) => {
    const position = block?.position
    const Vec3 = position?.constructor
    if (typeof Vec3 !== 'function' || typeof bot?.blockAt !== 'function') return 0
    for (let dx = -safeRadius; dx <= safeRadius; dx += 1) {
      for (let dz = -safeRadius; dz <= safeRadius; dz += 1) {
        const nearby = bot.blockAt(new Vec3(position.x + dx, position.y, position.z + dz), false)
        if (hazardous.has(String(nearby?.name || '').toLowerCase())) return 100
      }
    }
    return 0
  }
}

function isWalkableFloorCover(block) {
  const name = String(block?.name || '').toLowerCase()
  if (name === 'carpet' || name.endsWith('_carpet')) return true
  if (!name.endsWith('_slab')) return false

  let slabType = ''
  try {
    slabType = String(block?.getProperties?.()?.type || '').toLowerCase()
  } catch { }
  if (slabType && slabType !== 'bottom') return false

  // Mineflayer reports slabs with boundingBox="block" even though a bottom
  // slab occupies only the lower half of the feet cell. Treat that collision
  // shape as walkable floor cover; top and double slabs still obstruct the
  // planned foot level and must be rejected.
  const shapes = Array.isArray(block?.shapes) ? block.shapes : []
  if (shapes.length > 0) {
    return shapes.every((shape) => (
      Array.isArray(shape) &&
      shape.length >= 6 &&
      Number.isFinite(Number(shape[1])) &&
      Number.isFinite(Number(shape[4])) &&
      Number(shape[1]) >= -0.001 &&
      Number(shape[4]) > Number(shape[1]) &&
      Number(shape[4]) <= 0.501
    ))
  }
  return slabType === 'bottom'
}

function distanceToBlockInteraction(position, blockPosition, options = {}) {
  const eyeHeight = Math.max(0, Number(options.eyeHeight) || 1.62)
  const px = Number(position?.x)
  const py = Number(position?.y) + eyeHeight
  const pz = Number(position?.z)
  const bx = Number(blockPosition?.x)
  const by = Number(blockPosition?.y)
  const bz = Number(blockPosition?.z)
  if (![px, py, pz, bx, by, bz].every(Number.isFinite)) return Number.POSITIVE_INFINITY

  const axisDistance = (value, min, max) => value < min ? min - value : (value > max ? value - max : 0)
  const dx = axisDistance(px, bx, bx + 1)
  const dy = axisDistance(py, by, by + 1)
  const dz = axisDistance(pz, bz, bz + 1)
  return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz))
}

function getSafeBlockInteractionPointForCell(bot, x, z, expectedY, blockPosition, options = {}) {
  if (!blockPosition) return null
  const Vec3 = bot?.entity?.position?.constructor || blockPosition?.constructor
  if (typeof Vec3 !== 'function') return null
  const inset = Math.max(0.35, Math.min(0.49, Number(options.interactionCellInset) || 0.355))
  const blockCenterX = Number(blockPosition.x) + 0.5
  const blockCenterZ = Number(blockPosition.z) + 0.5
  const feetY = Math.floor(Number(expectedY))
  const feetBlock = bot?.blockAt?.(new Vec3(x, feetY, z), false)
  const coverShapes = isWalkableFloorCover(feetBlock) && Array.isArray(feetBlock?.shapes)
    ? feetBlock.shapes
    : []
  const coverTop = coverShapes.reduce((highest, shape) => (
    Array.isArray(shape) && Number.isFinite(Number(shape[4]))
      ? Math.max(highest, Number(shape[4]))
      : highest
  ), 0)
  // A carpet or bottom slab in the configured feet cell raises the server's
  // actual standing/eye position. Reach planning at expectedY can therefore
  // select a waypoint that looks valid on paper but can never satisfy the live
  // interaction predicate. Use the collision-surface top for both selection
  // and the final waypoint so the planned distance matches the settled player.
  const standingY = coverTop > 0 ? feetY + coverTop : Number(expectedY)
  const point = new Vec3(
    Math.max(x + inset, Math.min(x + 1 - inset, blockCenterX)),
    standingY,
    Math.max(z + inset, Math.min(z + 1 - inset, blockCenterZ))
  )
  try {
    assertSafeDirectMachineRoutePoint(bot, point, point, {
      expectedY,
      verticalTolerance: options.verticalTolerance,
      liquidProximityRadius: options.liquidProximityRadius,
      horizontalClearance: Math.max(0.3, inset - 0.01)
    })
  } catch {
    return null
  }
  const distance = distanceToBlockInteraction(point, blockPosition, options)
  const maxDistance = Math.max(0.5, Number(options.interactionReach) || 4.4)
  return distance <= maxDistance ? { point, distance } : null
}

function assertSafeDirectMachineRoutePoint(bot, position, target, options = {}) {
  const expectedY = Number(options.expectedY ?? target?.y)
  const verticalTolerance = Math.max(0.1, Number(options.verticalTolerance) || 0.75)
  const currentY = Number(position?.y)
  if (!Number.isFinite(expectedY) || !Number.isFinite(currentY) || Math.abs(currentY - expectedY) > verticalTolerance) {
    throw new Error(
      `direct-machine-route-left-elevation current=${Number.isFinite(currentY) ? currentY.toFixed(2) : 'unknown'} ` +
      `expected=${Number.isFinite(expectedY) ? expectedY.toFixed(2) : 'unknown'} max=${verticalTolerance.toFixed(2)}`
    )
  }

  const Vec3 = position?.constructor
  if (typeof Vec3 !== 'function' || typeof bot?.blockAt !== 'function') {
    throw new Error('direct-machine-route-world-unavailable')
  }

  const dx = Number(target?.x) - Number(position?.x)
  const dz = Number(target?.z) - Number(position?.z)
  const distance = Math.sqrt((dx * dx) + (dz * dz))
  const probes = distance > 0.01 ? [0, Math.min(1.25, distance)] : [0]
  const hazardous = new Set(['water', 'flowing_water', 'bubble_column', 'lava', 'flowing_lava', 'fire', 'soul_fire'])
  const proximityHazards = new Set(['water', 'flowing_water', 'bubble_column', 'lava', 'flowing_lava'])
  const liquidProximityRadius = Math.max(0, Math.floor(Number(options.liquidProximityRadius) || 0))
  // A standing player is 0.6 blocks wide. Use the real 0.3-block half-width
  // here: the previous 0.35 safety padding treated a nearby chest as if it
  // overlapped the player even when the server had already settled the player
  // just outside its collision box. Hazard/liquid cells are still rejected as
  // soon as an actual hitbox corner reaches their block.
  const configuredHorizontalClearance = Number(options.horizontalClearance)
  const horizontalClearance = Number.isFinite(configuredHorizontalClearance)
    ? Math.max(0.3, configuredHorizontalClearance)
    : 0.3
  const feetY = Math.floor(expectedY)

  for (const probe of probes) {
    const ratio = distance > 0.01 ? probe / distance : 0
    const x = Math.floor(Number(position.x) + (dx * ratio))
    const z = Math.floor(Number(position.z) + (dz * ratio))
    const floor = bot.blockAt(new Vec3(x, feetY - 1, z), false)
    const feet = bot.blockAt(new Vec3(x, feetY, z), false)
    const head = bot.blockAt(new Vec3(x, feetY + 1, z), false)
    if (!floor || !feet || !head) {
      throw new Error(`direct-machine-route-unloaded at ${x},${feetY},${z}`)
    }
    for (const block of [floor, feet, head]) {
      if (hazardous.has(String(block.name || '').toLowerCase())) {
        throw new Error(`direct-machine-route-hazard ${block.name} at ${block.position?.x ?? x},${block.position?.y ?? '?'},${block.position?.z ?? z}`)
      }
    }
    for (let nearbyX = x - liquidProximityRadius; nearbyX <= x + liquidProximityRadius; nearbyX += 1) {
      for (let nearbyZ = z - liquidProximityRadius; nearbyZ <= z + liquidProximityRadius; nearbyZ += 1) {
        for (const nearbyY of [feetY - 1, feetY, feetY + 1]) {
          const nearby = bot.blockAt(new Vec3(nearbyX, nearbyY, nearbyZ), false)
          if (!nearby) {
            throw new Error(`direct-machine-route-proximity-unloaded at ${nearbyX},${nearbyY},${nearbyZ}`)
          }
          if (proximityHazards.has(String(nearby.name || '').toLowerCase())) {
            throw new Error(
              `direct-machine-route-liquid-proximity ${nearby.name} at ` +
              `${nearby.position?.x ?? nearbyX},${nearby.position?.y ?? nearbyY},${nearby.position?.z ?? nearbyZ}`
            )
          }
        }
      }
    }
    const feetFloorCover = isWalkableFloorCover(feet)
    if (floor.boundingBox !== 'block' && !feetFloorCover) {
      throw new Error(
        `direct-machine-route-missing-floor ${floor.name || 'unknown'} at ${x},${feetY - 1},${z} ` +
        `feet=${feet.name || 'unknown'}`
      )
    }
    const feetBlocked = feet.boundingBox === 'block' && !feetFloorCover
    if (feetBlocked || head.boundingBox === 'block') {
      const blocked = feetBlocked ? feet : head
      throw new Error(`direct-machine-route-obstructed ${blocked.name || 'unknown'} at ${blocked.position?.x ?? x},${blocked.position?.y ?? '?'},${blocked.position?.z ?? z}`)
    }

    // A player is 0.6 blocks wide. Check the four hitbox corners instead of
    // banning every adjacent cell: a centered player can safely use a narrow
    // corridor beside a lift, while actual edge drift into water or a solid
    // block is rejected before the movement controller advances farther.
    const probeX = Number(position.x) + (dx * ratio)
    const probeZ = Number(position.z) + (dz * ratio)
    for (const offsetX of [-horizontalClearance, horizontalClearance]) {
      for (const offsetZ of [-horizontalClearance, horizontalClearance]) {
        const cornerX = Math.floor(probeX + offsetX)
        const cornerZ = Math.floor(probeZ + offsetZ)
        const cornerFeet = bot.blockAt(new Vec3(cornerX, feetY, cornerZ), false)
        const cornerHead = bot.blockAt(new Vec3(cornerX, feetY + 1, cornerZ), false)
        if (!cornerFeet || !cornerHead) {
          throw new Error(`direct-machine-route-hitbox-unloaded at ${cornerX},${feetY},${cornerZ}`)
        }
        for (const corner of [cornerFeet, cornerHead]) {
          if (hazardous.has(String(corner.name || '').toLowerCase())) {
            throw new Error(
              `direct-machine-route-hitbox-hazard ${corner.name} at ` +
              `${corner.position?.x ?? cornerX},${corner.position?.y ?? '?'},${corner.position?.z ?? cornerZ}`
            )
          }
        }
        const cornerFeetBlocked = cornerFeet.boundingBox === 'block' && !isWalkableFloorCover(cornerFeet)
        if (cornerFeetBlocked || cornerHead.boundingBox === 'block') {
          const blocked = cornerFeetBlocked ? cornerFeet : cornerHead
          throw new Error(
            `direct-machine-route-hitbox-obstructed ${blocked.name || 'unknown'} at ` +
            `${blocked.position?.x ?? cornerX},${blocked.position?.y ?? '?'},${blocked.position?.z ?? cornerZ}`
          )
        }
      }
    }
  }
}

function classifySafeLiquidMachineEgressCell(bot, position, options = {}) {
  const expectedY = Number(options.expectedY ?? position?.y)
  const verticalTolerance = Math.max(0.1, Number(options.verticalTolerance) || 0.75)
  const currentY = Number(position?.y)
  const Vec3 = position?.constructor
  if (typeof Vec3 !== 'function' || typeof bot?.blockAt !== 'function') {
    throw new Error('liquid-machine-egress-world-unavailable')
  }
  if (!Number.isFinite(expectedY) || !Number.isFinite(currentY) || Math.abs(currentY - expectedY) > verticalTolerance) {
    throw new Error('liquid-machine-egress-left-elevation')
  }

  try {
    assertSafeDirectMachineRoutePoint(bot, position, position, {
      expectedY,
      verticalTolerance,
      liquidProximityRadius: options.liquidProximityRadius
    })
    return { kind: 'dry', liquid: null }
  } catch { }

  const x = Math.floor(Number(position.x))
  const z = Math.floor(Number(position.z))
  const feetY = Math.floor(expectedY)
  const floor = bot.blockAt(new Vec3(x, feetY - 1, z), false)
  const feet = bot.blockAt(new Vec3(x, feetY, z), false)
  const head = bot.blockAt(new Vec3(x, feetY + 1, z), false)
  if (!floor || !feet || !head || floor.boundingBox !== 'block') {
    throw new Error(`liquid-machine-egress-unsupported ${x},${feetY},${z}`)
  }

  const recoverable = new Set(['water', 'flowing_water'])
  const prohibited = new Set(['water', 'flowing_water', 'bubble_column', 'lava', 'flowing_lava', 'fire', 'soul_fire'])
  const feetName = String(feet.name || '').toLowerCase()
  const headName = String(head.name || '').toLowerCase()
  if (!recoverable.has(feetName) || prohibited.has(headName) || head.boundingBox === 'block') {
    throw new Error(`liquid-machine-egress-not-shallow-water ${x},${feetY},${z}`)
  }
  return { kind: 'liquid', liquid: feetName }
}

/**
 * Resolve a bounded cardinal route out of shallow water at machine elevation.
 * The normal flat-route planner must reject a hazardous start cell, but a bot
 * that reconnects while the reset flow is passing over a supported platform
 * cell otherwise has no way to reach the already-safe route beside it.
 *
 * This deliberately accepts only one-block-deep water with clear headroom,
 * requires solid loaded support below every cell, and fully validates the dry
 * destination with the ordinary strict route guard. It does not recover from
 * holes, fire, lava, bubble columns, unloaded terrain, or deep water.
 */
function findSafeLiquidMachineEgress(bot, position, target, options = {}) {
  const expectedY = Number(options.expectedY ?? target?.y)
  const verticalTolerance = Math.max(0.1, Number(options.verticalTolerance) || 0.75)
  const currentY = Number(position?.y)
  const Vec3 = position?.constructor
  if (typeof Vec3 !== 'function' || typeof bot?.blockAt !== 'function') return null
  if (!Number.isFinite(expectedY) || !Number.isFinite(currentY)) return null
  if (Math.abs(currentY - expectedY) > verticalTolerance) return null

  const startX = Math.floor(Number(position.x))
  const startZ = Math.floor(Number(position.z))
  const feetY = Math.floor(expectedY)
  if (![startX, startZ, feetY].every(Number.isFinite)) return null

  let startClassification
  try {
    startClassification = classifySafeLiquidMachineEgressCell(bot, position, {
      expectedY,
      verticalTolerance,
      liquidProximityRadius: options.liquidProximityRadius
    })
  } catch {
    return null
  }
  if (startClassification.kind !== 'liquid') return null

  const maxSteps = Math.max(1, Math.min(64, Math.floor(Number(options.maxSteps) || 24)))
  const maxNodes = Math.max(16, Math.floor(Number(options.maxNodes) || 2048))
  const keyFor = (x, z) => `${x}:${z}`
  const startKey = keyFor(startX, startZ)
  const queue = [{ x: startX, z: startZ, depth: 0, key: startKey }]
  const visited = new Set([startKey])
  const parents = new Map()
  const cells = new Map([[startKey, { x: startX, z: startZ, kind: 'liquid', liquid: startClassification.liquid }]])

  while (queue.length > 0 && visited.size <= maxNodes) {
    const current = queue.shift()
    if (current.depth >= maxSteps) continue
    const candidates = [
      { x: current.x + 1, z: current.z },
      { x: current.x - 1, z: current.z },
      { x: current.x, z: current.z + 1 },
      { x: current.x, z: current.z - 1 }
    ]
    if (Number.isFinite(Number(target?.x)) && Number.isFinite(Number(target?.z))) {
      candidates.sort((a, b) => (
        horizontalDistance({ x: a.x + 0.5, z: a.z + 0.5 }, target) -
        horizontalDistance({ x: b.x + 0.5, z: b.z + 0.5 }, target)
      ))
    }

    for (const candidate of candidates) {
      const key = keyFor(candidate.x, candidate.z)
      if (visited.has(key)) continue
      visited.add(key)
      if (visited.size > maxNodes) break
      const point = new Vec3(candidate.x + 0.5, expectedY, candidate.z + 0.5)
      let classification
      try {
        classification = classifySafeLiquidMachineEgressCell(bot, point, {
          expectedY,
          verticalTolerance,
          liquidProximityRadius: options.liquidProximityRadius
        })
      } catch {
        continue
      }
      parents.set(key, current.key)
      cells.set(key, { x: candidate.x, z: candidate.z, ...classification })
      const depth = current.depth + 1
      if (classification.kind === 'dry') {
        const reversed = []
        let cursor = key
        while (cursor !== startKey) {
          const cell = cells.get(cursor)
          reversed.push({
            point: new Vec3(cell.x + 0.5, expectedY, cell.z + 0.5),
            cell: { x: cell.x, z: cell.z },
            kind: cell.kind,
            liquid: cell.liquid || null
          })
          cursor = parents.get(cursor)
        }
        const steps = reversed.reverse()
        return {
          point: steps[steps.length - 1].point,
          steps,
          startCell: { x: startX, z: startZ },
          destinationCell: { x: candidate.x, z: candidate.z },
          sourceLiquid: startClassification.liquid,
          liquidSteps: steps.filter((step) => step.kind === 'liquid').length,
          checkedCells: visited.size
        }
      }
      if (depth < maxSteps) queue.push({ x: candidate.x, z: candidate.z, depth, key })
    }
  }
  return null
}

/**
 * Walk a shallow-water egress route while treating server-driven drift as a
 * route change, not an unsafe failure. Water currents can move the player into
 * a different supported shallow-water cell between physics packets. Every
 * observed cell is still validated with the strict egress guard; only a safe
 * liquid cell may trigger a bounded replan.
 */
async function walkSafeLiquidMachineEgress(bot, target, options = {}) {
  const expectedY = Number(options.expectedY ?? target?.y)
  const verticalTolerance = Math.max(0.1, Number(options.verticalTolerance) || 0.75)
  const liquidProximityRadius = Math.max(0, Math.floor(Number(options.liquidProximityRadius) || 0))
  const configuredMaxReplans = Number(options.maxReplans)
  const maxReplans = Number.isFinite(configuredMaxReplans)
    ? Math.max(0, Math.min(32, Math.floor(configuredMaxReplans)))
    : 8
  const assertContinue = typeof options.assertContinue === 'function' ? options.assertContinue : () => {}
  const findEgress = typeof options.findEgress === 'function' ? options.findEgress : findSafeLiquidMachineEgress
  const classifyCell = typeof options.classifyCell === 'function' ? options.classifyCell : classifySafeLiquidMachineEgressCell
  const walkToPoint = typeof options.walkToPoint === 'function' ? options.walkToPoint : walkToPreciseAccessPoint
  const classifyOptions = { expectedY, verticalTolerance, liquidProximityRadius }
  const planOptions = {
    ...classifyOptions,
    maxSteps: options.maxSteps,
    maxNodes: options.maxNodes
  }
  const classifyCurrent = () => classifyCell(bot, bot?.entity?.position, classifyOptions)
  const findCurrentPlan = () => findEgress(bot, bot?.entity?.position, target, planOptions)

  let plan = findCurrentPlan()
  if (!plan) {
    try {
      if (classifyCurrent().kind === 'dry') {
        return { initialPlan: null, finalPlan: null, replans: 0, walkedSteps: 0, reachedDry: true }
      }
    } catch { }
    return null
  }
  const initialPlan = plan
  let replans = 0
  let walkedSteps = 0
  options.onPlan?.({ plan, replans, initial: true })

  while (plan) {
    let replanRequested = false
    for (const step of plan.steps) {
      assertContinue()
      try {
        await walkToPoint(bot, step.point, {
          tolerance: Math.max(0.05, Number(options.tolerance) || 0.1),
          settledTolerance: Math.max(0.05, Number(options.settledTolerance) || 0.1),
          maxStartDistance: Math.max(0.5, Number(options.maxStartDistance) || 1.75),
          timeoutMs: Math.max(250, Number(options.timeoutMs) || 6000),
          settleMs: Math.max(0, Number(options.settleMs) || 50),
          validatePosition: (positionNow) => {
            classifyCell(bot, positionNow, classifyOptions)
            classifyCell(bot, step.point, classifyOptions)
          }
        })
        walkedSteps += 1
      } catch (error) {
        // Replanning is allowed only when the authoritative position remains
        // a supported, clear, one-block-deep water cell. Unsafe drift keeps
        // the original hard failure.
        let current
        try {
          current = classifyCurrent()
        } catch {
          throw error
        }
        if (current.kind === 'dry') {
          return { initialPlan, finalPlan: plan, replans, walkedSteps, reachedDry: true }
        }
        if (replans >= maxReplans) {
          throw new Error(`liquid-machine-egress-replan-exhausted-${maxReplans}: ${error?.message || error}`)
        }
        const nextPlan = findCurrentPlan()
        if (!nextPlan) throw error
        replans += 1
        options.onReplan?.({ error, plan: nextPlan, replans, position: bot?.entity?.position })
        plan = nextPlan
        replanRequested = true
        break
      }
    }

    if (replanRequested) continue
    const current = classifyCurrent()
    if (current.kind === 'dry') {
      return { initialPlan, finalPlan: plan, replans, walkedSteps, reachedDry: true }
    }
    if (replans >= maxReplans) {
      throw new Error(`liquid-machine-egress-replan-exhausted-${maxReplans}: route ended in shallow water`)
    }
    const nextPlan = findCurrentPlan()
    if (!nextPlan) throw new Error('liquid-machine-egress-route-ended-without-dry-cell')
    replans += 1
    options.onReplan?.({ error: null, plan: nextPlan, replans, position: bot?.entity?.position })
    plan = nextPlan
  }

  throw new Error('liquid-machine-egress-route-unavailable')
}

function getVerifiedMachineGapGeometry(from, landing, requiredKind = null) {
  const fromX = Math.floor(Number(from?.x))
  const fromZ = Math.floor(Number(from?.z))
  const landingX = Math.floor(Number(landing?.x))
  const landingZ = Math.floor(Number(landing?.z))
  const dx = landingX - fromX
  const dz = landingZ - fromZ
  let kind = null
  let gapCells = null

  const cardinalDistance = dx === 0 ? Math.abs(dz) : (dz === 0 ? Math.abs(dx) : 0)
  if (cardinalDistance >= 2) {
    const stepX = Math.sign(dx)
    const stepZ = Math.sign(dz)
    gapCells = Array.from({ length: cardinalDistance - 1 }, (_, index) => ({
      x: fromX + (stepX * (index + 1)),
      z: fromZ + (stepZ * (index + 1))
    }))
    kind = gapCells.length === 1 ? 'cardinal-one-cell' : 'cardinal-multi-cell'
  } else if (Math.abs(dx) === 1 && Math.abs(dz) === 1) {
    // Two orthogonal empty cells can separate diagonally touching machine
    // islands. This is not ordinary diagonal walking: the player must jump
    // across their shared corner and land on the verified diagonal cell.
    kind = 'diagonal-corner'
    gapCells = [
      { x: fromX + dx, z: fromZ },
      { x: fromX, z: fromZ + dz }
    ]
  }

  if (!kind || (requiredKind && kind !== requiredKind)) {
    const label = requiredKind === 'diagonal-corner'
      ? 'machine-gap-invalid-diagonal-crossing'
      : 'machine-gap-invalid-cardinal-crossing'
    throw new Error(label)
  }
  return { kind, fromX, fromZ, landingX, landingZ, dx, dz, gapCells }
}

function assertVerifiedMachineGap(bot, from, landing, options = {}) {
  const expectedY = Number(options.expectedY ?? from?.y)
  const geometry = getVerifiedMachineGapGeometry(from, landing, options.requiredKind || null)
  const { kind, fromX, fromZ, landingX, landingZ, gapCells } = geometry
  if (![expectedY, fromX, fromZ, landingX, landingZ].every(Number.isFinite)) {
    throw new Error('machine-gap-position-unavailable')
  }

  const Vec3 = from?.constructor || landing?.constructor || bot?.entity?.position?.constructor
  if (typeof Vec3 !== 'function' || typeof bot?.blockAt !== 'function') {
    throw new Error('machine-gap-world-unavailable')
  }
  const verticalTolerance = Math.max(0.1, Number(options.verticalTolerance) || 0.75)
  const liquidProximityRadius = Math.max(0, Math.floor(Number(options.liquidProximityRadius) || 0))
  const configuredMaxGapCells = Number(options.maxGapCells)
  const allowedGapCells = Math.min(
    MAX_VERIFIED_MACHINE_GAP_CELLS,
    Number.isFinite(configuredMaxGapCells)
      ? Math.max(1, Math.floor(configuredMaxGapCells))
      : MAX_VERIFIED_MACHINE_GAP_CELLS
  )
  if (gapCells.length > allowedGapCells) {
    throw new Error(
      `machine-gap-too-wide cells=${gapCells.length} max=${allowedGapCells}`
    )
  }
  const fromCenter = new Vec3(fromX + 0.5, expectedY, fromZ + 0.5)
  const landingCenter = new Vec3(landingX + 0.5, expectedY, landingZ + 0.5)
  assertSafeDirectMachineRoutePoint(bot, fromCenter, fromCenter, {
    expectedY,
    verticalTolerance,
    liquidProximityRadius
  })
  assertSafeDirectMachineRoutePoint(bot, landingCenter, landingCenter, {
    expectedY,
    verticalTolerance,
    liquidProximityRadius
  })

  const feetY = Math.floor(expectedY)
  const airNames = new Set(['air', 'cave_air', 'void_air'])
  const hazardous = new Set(['water', 'flowing_water', 'bubble_column', 'lava', 'flowing_lava', 'fire', 'soul_fire'])
  const verifiedGapCells = []
  for (const cell of gapCells) {
    const floor = bot.blockAt(new Vec3(cell.x, feetY - 1, cell.z), false)
    const feet = bot.blockAt(new Vec3(cell.x, feetY, cell.z), false)
    const head = bot.blockAt(new Vec3(cell.x, feetY + 1, cell.z), false)
    if (!floor || !feet || !head) throw new Error(`machine-gap-unloaded at ${cell.x},${feetY},${cell.z}`)
    if (!airNames.has(String(floor.name || '').toLowerCase()) || floor.boundingBox === 'block') {
      throw new Error(`machine-gap-floor-not-air ${floor.name || 'unknown'} at ${cell.x},${feetY - 1},${cell.z}`)
    }
    for (const block of [feet, head]) {
      const name = String(block.name || '').toLowerCase()
      if (!airNames.has(name) || hazardous.has(name) || block.boundingBox === 'block') {
        throw new Error(`machine-gap-obstructed ${name || 'unknown'} at ${block.position?.x ?? cell.x},${block.position?.y ?? '?'},${block.position?.z ?? cell.z}`)
      }
    }
    verifiedGapCells.push(new Vec3(cell.x + 0.5, expectedY, cell.z + 0.5))
  }

  // Wide cardinal gaps need momentum, but the run-up must never be improvised
  // over unknown map pixels. Verify a short same-level runway behind the
  // takeoff cell before the executor is allowed to enable sprint.
  const sprintRequired = kind === 'cardinal-multi-cell'
  const runUpBlocks = sprintRequired ? Math.min(2, Math.max(1, gapCells.length - 1)) : 0
  let runUpCenter = null
  if (runUpBlocks > 0) {
    const stepX = Math.sign(landingX - fromX)
    const stepZ = Math.sign(landingZ - fromZ)
    for (let offset = 1; offset <= runUpBlocks; offset += 1) {
      const runUpPoint = new Vec3(
        fromX + 0.5 - (stepX * offset),
        expectedY,
        fromZ + 0.5 - (stepZ * offset)
      )
      assertSafeDirectMachineRoutePoint(bot, runUpPoint, runUpPoint, {
        expectedY,
        verticalTolerance,
        liquidProximityRadius
      })
      runUpCenter = runUpPoint
    }
  }

  return {
    kind,
    fromCenter,
    landingCenter,
    gapCells: verifiedGapCells,
    sprintRequired,
    runUpBlocks,
    runUpCenter,
    middle: kind === 'cardinal-one-cell'
      ? verifiedGapCells[0]
      : new Vec3((fromCenter.x + landingCenter.x) / 2, expectedY, (fromCenter.z + landingCenter.z) / 2)
  }
}

function assertVerifiedOneBlockGap(bot, from, landing, options = {}) {
  return assertVerifiedMachineGap(bot, from, landing, {
    ...options,
    requiredKind: 'cardinal-one-cell'
  })
}

function assertVerifiedDiagonalCornerGap(bot, from, landing, options = {}) {
  return assertVerifiedMachineGap(bot, from, landing, {
    ...options,
    requiredKind: 'diagonal-corner'
  })
}

async function walkAcrossVerifiedMachineGap(bot, from, landing, options = {}) {
  const expectedY = Number(options.expectedY ?? from?.y)
  const timeoutMs = Math.max(750, Number(options.timeoutMs) || 2200)
  const pollMs = Math.max(20, Number(options.pollMs) || 25)
  const jumpHoldMs = Math.max(150, Math.min(timeoutMs, Number(options.jumpHoldMs) || 500))
  const startTolerance = Math.max(0.1, Number(options.startTolerance) || 0.4)
  const landingTolerance = Math.max(0.2, Number(options.landingTolerance) || 0.45)
  const verticalTolerance = Math.max(0.1, Number(options.verticalTolerance) || 0.75)
  const wait = typeof options.wait === 'function' ? options.wait : delay
  const verified = assertVerifiedMachineGap(bot, from, landing, options)
  const startDistance = horizontalDistance(bot?.entity?.position, verified.fromCenter)
  if (startDistance > startTolerance) {
    throw new Error(`machine-gap-start-not-centered distance=${startDistance.toFixed(2)} max=${startTolerance.toFixed(2)}`)
  }

  const start = Date.now()
  const directionX = verified.landingCenter.x - verified.fromCenter.x
  const directionZ = verified.landingCenter.z - verified.fromCenter.z
  const length = Math.sqrt((directionX * directionX) + (directionZ * directionZ))
  const unitX = directionX / length
  const unitZ = directionZ / length
  try { bot?.pathfinder?.stop?.() } catch { }
  try { bot?.pathfinder?.setGoal?.(null) } catch { }
  stopHorizontalControls(bot)
  try { bot?.setControlState?.('jump', false) } catch { }

  try {
    const Vec3 = verified.fromCenter.constructor
    const eyeHeight = Number(bot?.entity?.eyeHeight)
    if (verified.runUpCenter) {
      const moveToRunUp = typeof options.moveToRunUp === 'function'
        ? options.moveToRunUp
        : async (point) => await walkToPreciseAccessPoint(bot, point, {
            tolerance: 0.2,
            settledTolerance: 0.3,
            maxStartDistance: verified.runUpBlocks + 0.75,
            timeoutMs: Math.max(750, Math.min(timeoutMs - 500, Number(options.runUpTimeoutMs) || 3000)),
            settleMs: 0,
            wait,
            validatePosition: (positionNow, targetNow) => assertSafeDirectMachineRoutePoint(
              bot,
              positionNow,
              targetNow,
              { expectedY, verticalTolerance, liquidProximityRadius: options.liquidProximityRadius }
            )
          })
      await moveToRunUp(verified.runUpCenter)
      const runUpDistance = horizontalDistance(bot?.entity?.position, verified.runUpCenter)
      if (runUpDistance > 0.35) {
        throw new Error(`machine-gap-run-up-incomplete distance=${runUpDistance.toFixed(2)} max=0.35`)
      }
    }
    await bot.lookAt(new Vec3(
      verified.landingCenter.x,
      expectedY + (Number.isFinite(eyeHeight) ? eyeHeight : 1.62),
      verified.landingCenter.z
    ), true)
    bot.setControlState('sprint', verified.sprintRequired)
    bot.setControlState('forward', true)
    let jumpStartedAt = verified.sprintRequired ? 0 : Date.now()
    if (!verified.sprintRequired) bot.setControlState('jump', true)

    while (Date.now() - start < timeoutMs) {
      const position = bot?.entity?.position
      const x = Number(position?.x)
      const y = Number(position?.y)
      const z = Number(position?.z)
      if (![x, y, z].every(Number.isFinite)) throw new Error('machine-gap-position-unavailable')
      const relativeX = x - verified.fromCenter.x
      const relativeZ = z - verified.fromCenter.z
      const along = (relativeX * unitX) + (relativeZ * unitZ)
      const cross = Math.abs((relativeX * unitZ) - (relativeZ * unitX))
      if (y < expectedY - verticalTolerance || y > expectedY + 1.8) {
        throw new Error(`machine-gap-left-elevation current=${y.toFixed(2)} expected=${expectedY.toFixed(2)}`)
      }
      if (along < -(verified.runUpBlocks + 0.75) || along > length + 0.9 || cross > 0.65) {
        throw new Error(`machine-gap-server-correction along=${along.toFixed(2)} cross=${cross.toFixed(2)}`)
      }
      if (verified.sprintRequired && !jumpStartedAt && along >= -0.15) {
        jumpStartedAt = Date.now()
        bot.setControlState('jump', true)
      }
      if (verified.sprintRequired && !jumpStartedAt && along > 0.65) {
        throw new Error('machine-gap-missed-takeoff')
      }
      if (jumpStartedAt && Date.now() - jumpStartedAt >= jumpHoldMs) bot.setControlState('jump', false)

      const landingDistance = horizontalDistance(position, verified.landingCenter)
      if (landingDistance <= landingTolerance && Math.abs(y - expectedY) <= verticalTolerance && bot?.entity?.onGround !== false) {
        stopHorizontalControls(bot)
        try { bot?.setControlState?.('jump', false) } catch { }
        assertSafeDirectMachineRoutePoint(bot, position, verified.landingCenter, {
          expectedY,
          verticalTolerance,
          liquidProximityRadius: options.liquidProximityRadius
        })
        return {
          kind: verified.kind,
          gapCellCount: verified.gapCells.length,
          sprintUsed: verified.sprintRequired,
          runUpBlocks: verified.runUpBlocks,
          startDistance,
          landingDistance,
          elapsedMs: Date.now() - start
        }
      }
      await wait(pollMs)
    }
  } finally {
    stopHorizontalControls(bot)
    try { bot?.setControlState?.('jump', false) } catch { }
  }
  throw new Error(`machine-gap-timeout-${timeoutMs}ms`)
}

async function walkAcrossVerifiedOneBlockGap(bot, from, landing, options = {}) {
  return await walkAcrossVerifiedMachineGap(bot, from, landing, {
    ...options,
    requiredKind: 'cardinal-one-cell'
  })
}

/**
 * Mineflayer's general path planner can exhaust its planning budget on a
 * partially filled 128x128 map even when the nearby machine row is a simple
 * flat surface. Build a small, loaded-world-only route for that final area.
 * Every cell must have either solid support or a walkable thin surface such as
 * carpet at the configured foot level, plus legal head room and no liquid/fire.
 * Four-way movement keeps the route from cutting diagonally across true holes.
 */
function planSafeFlatMachineRoute(bot, position, target, options = {}) {
  const expectedY = Number(options.expectedY ?? target?.y)
  const startX = Math.floor(Number(position?.x))
  const startZ = Math.floor(Number(position?.z))
  const goalX = Math.floor(Number(target?.x))
  const goalZ = Math.floor(Number(target?.z))
  if (![expectedY, startX, startZ, goalX, goalZ].every(Number.isFinite)) {
    throw new Error('flat-machine-route-position-unavailable')
  }

  const padding = Math.max(2, Math.floor(Number(options.padding) || 8))
  const maxNodes = Math.max(64, Math.floor(Number(options.maxNodes) || 4096))
  const goalTolerance = Math.max(0, Number(options.goalTolerance) || 0)
  const allowPartial = options.allowPartial === true
  const configuredGapLimit = Number(options.maxVerifiedGaps ?? options.maxOneBlockGaps)
  const maxOneBlockGaps = Number.isFinite(configuredGapLimit)
    ? Math.max(0, Math.floor(configuredGapLimit))
    : (options.allowOneBlockGap === true ? 1 : 0)
  const allowDiagonalCornerGap = options.allowDiagonalCornerGap === true
  const maxVerifiedGapWidth = Math.min(
    MAX_VERIFIED_MACHINE_GAP_CELLS,
    Math.max(1, Math.floor(Number(options.maxVerifiedGapWidth) || 1))
  )
  const minPartialProgress = Math.max(0.1, Number(options.minPartialProgress) || 0.5)
  const interactionBlock = options.interactionBlock || null
  const minX = Math.min(startX, goalX) - padding
  const maxX = Math.max(startX, goalX) + padding
  const minZ = Math.min(startZ, goalZ) - padding
  const maxZ = Math.max(startZ, goalZ) + padding
  const keyFor = (x, z) => `${x}:${z}`
  const cellSafety = new Map()
  const cellFailures = new Map()
  let closestInteraction = null
  let closestGoal = null
  const isSafeCell = (x, z) => {
    const key = keyFor(x, z)
    if (cellSafety.has(key)) return cellSafety.get(key)
    const Vec3 = position?.constructor
    if (typeof Vec3 !== 'function') throw new Error('flat-machine-route-world-unavailable')
    const cell = new Vec3(x + 0.5, expectedY, z + 0.5)
    let safe = true
    try {
      assertSafeDirectMachineRoutePoint(bot, cell, cell, {
        expectedY,
        verticalTolerance: options.verticalTolerance,
        liquidProximityRadius: options.liquidProximityRadius
      })
    } catch (err) {
      safe = false
      cellFailures.set(key, String(err?.message || err || 'unsafe'))
    }
    cellSafety.set(key, safe)
    return safe
  }

  if (!isSafeCell(startX, startZ)) throw new Error(`flat-machine-route-unsafe-start ${startX},${expectedY},${startZ}`)
  if (goalTolerance <= 0 && !interactionBlock && !isSafeCell(goalX, goalZ)) {
    throw new Error(
      `flat-machine-route-unsafe-goal ${goalX},${expectedY},${goalZ}: ` +
      `${cellFailures.get(keyFor(goalX, goalZ)) || 'unsafe'}`
    )
  }

  const startKey = keyFor(startX, startZ)
  const considerClosestGoal = (x, z, key) => {
    const distance = horizontalDistance({ x: x + 0.5, z: z + 0.5 }, target)
    if (!Number.isFinite(distance)) return
    if (!closestGoal || distance < closestGoal.distance) {
      closestGoal = { x, z, key, distance }
    }
  }
  const resolveGoal = (x, z) => {
    const reachesConfiguredGoal = goalTolerance <= 0
      ? x === goalX && z === goalZ
      : horizontalDistance({ x: x + 0.5, z: z + 0.5 }, target) <= goalTolerance
    if (reachesConfiguredGoal) return { interactionReady: false, point: null, interactionDistance: null }
    const interaction = getSafeBlockInteractionPointForCell(bot, x, z, expectedY, interactionBlock, options)
    if (!interaction && interactionBlock) {
      const candidate = getSafeBlockInteractionPointForCell(bot, x, z, expectedY, interactionBlock, {
        ...options,
        interactionReach: Number.POSITIVE_INFINITY
      })
      if (candidate && (!closestInteraction || candidate.distance < closestInteraction.distance)) {
        closestInteraction = { ...candidate, x, z }
      }
    }
    if (!interaction) return null
    return {
      interactionReady: true,
      point: interaction.point,
      interactionDistance: interaction.distance
    }
  }
  // A route that reaches the same physical cell with more gap crossings is
  // always dominated by the lower-gap route: both have the same possible
  // continuations, while the latter is safer and leaves more of the crossing
  // budget available. Use a lexicographic Dijkstra cost (gaps first, then
  // walked cells) so each physical cell has one best state instead of being
  // duplicated once per allowed crossing.
  const cellCountBound = ((maxX - minX + 1) * (maxZ - minZ + 1))
  const gapPenalty = cellCountBound + 1
  const heap = []
  const pushHeap = (entry) => {
    heap.push(entry)
    let index = heap.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (heap[parent].cost <= heap[index].cost) break
      ;[heap[parent], heap[index]] = [heap[index], heap[parent]]
      index = parent
    }
  }
  const popHeap = () => {
    if (heap.length === 0) return null
    const first = heap[0]
    const last = heap.pop()
    if (heap.length > 0) {
      heap[0] = last
      let index = 0
      while (true) {
        const left = (index * 2) + 1
        const right = left + 1
        let smallest = index
        if (left < heap.length && heap[left].cost < heap[smallest].cost) smallest = left
        if (right < heap.length && heap[right].cost < heap[smallest].cost) smallest = right
        if (smallest === index) break
        ;[heap[index], heap[smallest]] = [heap[smallest], heap[index]]
        index = smallest
      }
    }
    return first
  }
  const best = new Map([[startKey, { cost: 0, gapCrossings: 0, steps: 0 }]])
  const previous = new Map([[startKey, null]])
  const visited = new Set()
  pushHeap({ x: startX, z: startZ, gapCrossings: 0, steps: 0, cost: 0, key: startKey })
  let resolvedGoal = null
  let resolvedGoalKey = null
  while (heap.length > 0 && visited.size < maxNodes && resolvedGoalKey == null) {
    const current = popHeap()
    const known = best.get(current.key)
    if (!known || known.cost !== current.cost || visited.has(current.key)) continue
    visited.add(current.key)
    considerClosestGoal(current.x, current.z, current.key)
    const currentGoal = resolveGoal(current.x, current.z)
    if (currentGoal) {
      resolvedGoal = currentGoal
      resolvedGoalKey = current.key
      break
    }

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = current.x + dx
      const z = current.z + dz
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue
      const normalKey = keyFor(x, z)
      const normalSafe = isSafeCell(x, z)
      if (normalSafe) {
        const steps = current.steps + 1
        const cost = (current.gapCrossings * gapPenalty) + steps
        const prior = best.get(normalKey)
        if (!prior || cost < prior.cost) {
          best.set(normalKey, { cost, gapCrossings: current.gapCrossings, steps })
          previous.set(normalKey, { previousKey: current.key, gap: null })
          pushHeap({ x, z, gapCrossings: current.gapCrossings, steps, cost, key: normalKey })
        }
        continue
      }

      if (current.gapCrossings >= maxOneBlockGaps) continue
      for (let gapWidth = 1; gapWidth <= maxVerifiedGapWidth; gapWidth += 1) {
        const landingDistance = gapWidth + 1
        const landingX = current.x + (dx * landingDistance)
        const landingZ = current.z + (dz * landingDistance)
        if (landingX < minX || landingX > maxX || landingZ < minZ || landingZ > maxZ) break
        const nextGapCrossings = current.gapCrossings + 1
        const landingKey = keyFor(landingX, landingZ)
        if (!isSafeCell(landingX, landingZ)) continue
        const Vec3 = position.constructor
        let verifiedGap = null
        try {
          verifiedGap = assertVerifiedMachineGap(
            bot,
            new Vec3(current.x + 0.5, expectedY, current.z + 0.5),
            new Vec3(landingX + 0.5, expectedY, landingZ + 0.5),
            {
              expectedY,
              verticalTolerance: options.verticalTolerance,
              liquidProximityRadius: options.liquidProximityRadius,
              maxGapCells: maxVerifiedGapWidth
            }
          )
        } catch { }
        if (!verifiedGap) continue
        const steps = current.steps + landingDistance
        const cost = (nextGapCrossings * gapPenalty) + steps
        const prior = best.get(landingKey)
        if (prior && prior.cost <= cost) continue
        best.set(landingKey, { cost, gapCrossings: nextGapCrossings, steps })
        previous.set(landingKey, {
          previousKey: current.key,
          gap: {
            kind: verifiedGap.kind,
            from: verifiedGap.fromCenter,
            middle: verifiedGap.middle,
            gapCells: verifiedGap.gapCells,
            landing: verifiedGap.landingCenter
          }
        })
        pushHeap({
          x: landingX,
          z: landingZ,
          gapCrossings: nextGapCrossings,
          steps,
          cost,
          key: landingKey
        })
      }
    }

    if (allowDiagonalCornerGap && current.gapCrossings < maxOneBlockGaps) {
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const landingX = current.x + dx
        const landingZ = current.z + dz
        if (landingX < minX || landingX > maxX || landingZ < minZ || landingZ > maxZ) continue

        // Never turn ordinary diagonal walking into a jump. Both cardinal
        // neighbours must be unsafe and the verifier below must prove that
        // they are specifically empty floor cells with a clear jump arc.
        if (isSafeCell(current.x + dx, current.z) || isSafeCell(current.x, current.z + dz)) continue
        const landingKey = keyFor(landingX, landingZ)
        if (!isSafeCell(landingX, landingZ)) continue

        const Vec3 = position.constructor
        let verifiedGap = null
        try {
          verifiedGap = assertVerifiedDiagonalCornerGap(
            bot,
            new Vec3(current.x + 0.5, expectedY, current.z + 0.5),
            new Vec3(landingX + 0.5, expectedY, landingZ + 0.5),
            {
              expectedY,
              verticalTolerance: options.verticalTolerance,
              liquidProximityRadius: options.liquidProximityRadius
            }
          )
        } catch { }
        if (!verifiedGap) continue

        const nextGapCrossings = current.gapCrossings + 1
        const steps = current.steps + 2
        const cost = (nextGapCrossings * gapPenalty) + steps
        const prior = best.get(landingKey)
        if (prior && prior.cost <= cost) continue
        best.set(landingKey, { cost, gapCrossings: nextGapCrossings, steps })
        previous.set(landingKey, {
          previousKey: current.key,
          gap: {
            kind: verifiedGap.kind,
            from: verifiedGap.fromCenter,
            middle: verifiedGap.middle,
            gapCells: verifiedGap.gapCells,
            landing: verifiedGap.landingCenter
          }
        })
        pushHeap({
          x: landingX,
          z: landingZ,
          gapCrossings: nextGapCrossings,
          steps,
          cost,
          key: landingKey
        })
      }
    }
  }

  if (resolvedGoalKey == null && allowPartial && closestGoal) {
    const startDistance = horizontalDistance({ x: startX + 0.5, z: startZ + 0.5 }, target)
    const progress = startDistance - closestGoal.distance
    if (closestGoal.key !== startKey && progress >= minPartialProgress) {
      resolvedGoal = {
        interactionReady: false,
        point: null,
        interactionDistance: null,
        partial: true,
        progress
      }
      resolvedGoalKey = closestGoal.key
    }
  }

  if (resolvedGoalKey == null) {
    const nearest = closestInteraction
      ? ` nearestInteraction=${closestInteraction.distance.toFixed(2)}@${closestInteraction.x},${closestInteraction.z}`
      : ''
    const closestBoundaryCell = closestInteraction || closestGoal
    const nearestGoal = closestGoal
      ? ` nearestGoal=${closestGoal.distance.toFixed(2)}@${closestGoal.x},${closestGoal.z}`
      : ''
    const boundary = closestBoundaryCell
      ? [...new Set([[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([dx, dz]) => cellFailures.get(keyFor(closestBoundaryCell.x + dx, closestBoundaryCell.z + dz)))
          .filter(Boolean))]
          .slice(0, 2)
          .join(' | ')
      : ''
    throw new Error(
      `flat-machine-route-unavailable start=${startX},${startZ} goal=${goalX},${goalZ} ` +
      `tolerance=${goalTolerance.toFixed(2)} checked=${visited.size} discovered=${best.size} ` +
      `maxGaps=${maxOneBlockGaps}${nearest}${nearestGoal}` +
      (boundary ? ` boundary=${boundary}` : '')
    )
  }

  const routeStates = []
  let key = resolvedGoalKey
  while (key != null) {
    const [x, z] = key.split(':').map(Number)
    const transition = previous.get(key)
    routeStates.push({ x, z, gap: transition?.gap || null })
    key = transition?.previousKey ?? null
  }
  routeStates.reverse()
  const cells = routeStates.map(({ x, z }) => ({ x, z }))
  const gapCrossings = []
  for (let index = 1; index < routeStates.length; index += 1) {
    if (routeStates[index].gap) gapCrossings.push({ index, ...routeStates[index].gap })
  }

  // Reduce a cell-by-cell route to its turn points. The live movement guard
  // still validates every step and 1.25 blocks ahead while traversing each
  // straight segment.
  const Vec3 = position.constructor
  const waypoints = []
  const steps = []
  const addWalkPoint = (point) => {
    const last = waypoints[waypoints.length - 1]
    if (last && last.x === point.x && last.z === point.z) return
    waypoints.push(point)
    steps.push({ type: 'walk', point })
  }
  const appendWalkRange = (startIndex, endIndex, finalPoint) => {
    let previousDirection = null
    for (let index = startIndex + 1; index <= endIndex; index += 1) {
      const direction = {
        x: cells[index].x - cells[index - 1].x,
        z: cells[index].z - cells[index - 1].z
      }
      if (previousDirection && (direction.x !== previousDirection.x || direction.z !== previousDirection.z)) {
        const turn = cells[index - 1]
        addWalkPoint(new Vec3(turn.x + 0.5, expectedY, turn.z + 0.5))
      }
      previousDirection = direction
    }
    addWalkPoint(finalPoint)
  }
  const terminal = cells[cells.length - 1]
  const finalWaypoint = resolvedGoal?.interactionReady
    ? resolvedGoal.point
    : (resolvedGoal?.partial === true || goalTolerance > 0
        ? new Vec3(terminal.x + 0.5, expectedY, terminal.z + 0.5)
        : new Vec3(Number(target.x), expectedY, Number(target.z)))
  let segmentStart = 0
  for (const crossing of gapCrossings) {
    appendWalkRange(segmentStart, crossing.index - 1, crossing.from)
    steps.push({
      type: 'gap',
      kind: crossing.kind,
      from: crossing.from,
      middle: crossing.middle,
      gapCells: crossing.gapCells,
      landing: crossing.landing
    })
    const last = waypoints[waypoints.length - 1]
    if (!last || last.x !== crossing.landing.x || last.z !== crossing.landing.z) {
      waypoints.push(crossing.landing)
    }
    segmentStart = crossing.index
  }
  appendWalkRange(segmentStart, cells.length - 1, finalWaypoint)
  return {
    cells,
    steps,
    waypoints,
    gapCrossings,
    checkedCells: visited.size,
    discoveredCells: best.size,
    goalTolerance,
    partial: resolvedGoal?.partial === true,
    progress: Number(resolvedGoal?.progress) || 0,
    interactionReady: resolvedGoal?.interactionReady === true,
    interactionDistance: resolvedGoal?.interactionDistance ?? null
  }
}

/**
 * Reproduce the reference addon's final checkpoint approach. Its action loop
 * keeps walking until the horizontal distance from the captured openPos is
 * below checkpointBuffer (0.2 blocks). Pathfinder GoalNear works on integer
 * nodes and can finish more than two blocks from that fractional point, so it
 * is only used for the long route; this bounded final walk uses ordinary
 * client movement controls and server-authoritative physics packets.
 */
async function walkToPreciseAccessPoint(bot, target, options = {}) {
  const tolerance = Math.max(0.05, Number(options.tolerance) || 0.2)
  const settledTolerance = Math.max(tolerance, Number(options.settledTolerance) || 0.35)
  const maxStartDistance = Math.max(settledTolerance, Number(options.maxStartDistance) || Number.POSITIVE_INFINITY)
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || 6000)
  const pollMs = Math.max(20, Number(options.pollMs) || 50)
  const configuredSettleMs = Number(options.settleMs)
  const settleMs = Math.max(0, Number.isFinite(configuredSettleMs) ? configuredSettleMs : 150)
  const wait = typeof options.wait === 'function' ? options.wait : delay
  const validatePosition = typeof options.validatePosition === 'function'
    ? options.validatePosition
    : null
  const isComplete = typeof options.isComplete === 'function'
    ? options.isComplete
    : null
  const requireCompletionPredicate = isComplete != null && options.requireCompletionPredicate === true
  const startedAt = Date.now()
  const startDistance = horizontalDistance(bot?.entity?.position, target)
  let reachedDistance = startDistance

  if (!Number.isFinite(startDistance)) {
    throw new Error('precise-access-position-unavailable')
  }
  if (startDistance > maxStartDistance) {
    throw new Error(
      `precise-access-route-too-long start=${startDistance.toFixed(2)} ` +
      `max=${maxStartDistance.toFixed(2)}`
    )
  }
  if (validatePosition) validatePosition(bot?.entity?.position, target, 'start')
  if (isComplete?.(bot?.entity?.position, target) === true) {
    stopHorizontalControls(bot)
    if (settleMs > 0) await wait(settleMs)
    if (validatePosition) validatePosition(bot?.entity?.position, target, 'predicate-settled')
    const finalDistance = horizontalDistance(bot?.entity?.position, target)
    if (isComplete?.(bot?.entity?.position, target) === true) {
      return {
        moved: false,
        startDistance,
        reachedDistance: startDistance,
        finalDistance,
        completedBy: 'predicate'
      }
    }
  }
  if (!requireCompletionPredicate && startDistance <= tolerance) {
    stopHorizontalControls(bot)
    return { moved: false, startDistance, reachedDistance: startDistance, finalDistance: startDistance }
  }

  // mineflayer-pathfinder's stop() only arms stopPathing; the flag is cleared
  // when a path reset runs. Pair it with setGoal(null) before taking direct
  // movement ownership so the next goto cannot inherit a latent path_stop.
  try { bot?.pathfinder?.stop?.() } catch { }
  try { bot?.pathfinder?.setGoal?.(null) } catch { }
  stopHorizontalControls(bot)

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const position = bot?.entity?.position
      const distance = horizontalDistance(position, target)
      if (!Number.isFinite(distance)) throw new Error('precise-access-position-unavailable')
      if (validatePosition) validatePosition(position, target, 'moving')
      if (isComplete?.(position, target) === true) {
        reachedDistance = distance
        stopHorizontalControls(bot)
        if (settleMs > 0) await wait(settleMs)
        if (validatePosition) validatePosition(bot?.entity?.position, target, 'predicate-settled')
        const finalDistance = horizontalDistance(bot?.entity?.position, target)
        if (isComplete?.(bot?.entity?.position, target) === true) {
          return {
            moved: true,
            startDistance,
            reachedDistance,
            finalDistance,
            completedBy: 'predicate'
          }
        }
        continue
      }
      // The server can settle the authoritative position a fraction outside
      // the reference client's 0.2-block checkpoint buffer. Accept that
      // stable pose within the separately bounded settle allowance instead
      // of walking against the same collision edge until timeout.
      if (!requireCompletionPredicate && distance <= settledTolerance) {
        reachedDistance = distance
        stopHorizontalControls(bot)
        if (settleMs > 0) await wait(settleMs)
        if (validatePosition) validatePosition(bot?.entity?.position, target, 'settled')
        const finalDistance = horizontalDistance(bot?.entity?.position, target)
        if (finalDistance <= settledTolerance) {
          return { moved: true, startDistance, reachedDistance, finalDistance }
        }
        continue
      }

      const Vec3 = position?.constructor
      if (typeof Vec3 !== 'function' || typeof bot?.lookAt !== 'function') {
        throw new Error('precise-access-movement-unavailable')
      }
      const eyeHeight = Number(bot?.entity?.eyeHeight)
      const aimY = Number(position.y) + (Number.isFinite(eyeHeight) ? eyeHeight : 1.62)
      // Never keep forward pressed while Mineflayer asynchronously turns. The
      // old loop left it held between polling iterations, so a slow lookAt
      // could rotate the bot through the target while it continued walking and
      // turn an initially valid 1-block approach into a 5-block divergence.
      stopHorizontalControls(bot)
      await bot.lookAt(new Vec3(Number(target.x), aimY, Number(target.z)), true)
      bot.setControlState('forward', true)
      try {
        await wait(pollMs)
      } finally {
        bot.setControlState('forward', false)
      }
    }
  } finally {
    stopHorizontalControls(bot)
  }

  const finalDistance = horizontalDistance(bot?.entity?.position, target)
  throw new Error(
    `precise-access-timeout-${timeoutMs}ms start=${startDistance.toFixed(2)} ` +
    `final=${Number.isFinite(finalDistance) ? finalDistance.toFixed(2) : 'unavailable'} ` +
    `target=${Number(target.x).toFixed(3)},${Number(target.z).toFixed(3)}`
  )
}

module.exports = {
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
  stopHorizontalControls,
  walkSafeLiquidMachineEgress,
  walkAcrossVerifiedMachineGap,
  walkAcrossVerifiedOneBlockGap,
  walkToPreciseAccessPoint
}
