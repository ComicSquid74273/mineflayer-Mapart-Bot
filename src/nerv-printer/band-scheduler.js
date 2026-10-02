'use strict'

// Band scheduler compiler: turns a deterministic U-traversal into a complete
// print plan before the first packet is sent. Pure module — no bot, no
// mineflayer, no I/O. Design: docs/BOT20-BAND-SCHEDULER-PLAN.md.
//
// Coverage guarantee: every target that is ever inside reach along the route
// gets an emission slot inside its reach window (with a second-attempt retry
// slot when capacity allows). Cells never reachable land in `infeasible` —
// flagged, never silently dropped.

const STOP_ACTIONS = new Set(['entry', 'uTurn', 'exit', 'laneEnd', 'staging'])

function num (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function dist2 (ax, ay, az, bx, by, bz) {
  const dx = ax - bx
  const dy = ay - by
  const dz = az - bz
  return dx * dx + dy * dy + dz * dz
}

// Walk the waypoint route at per-segment pace, recording the bot position at
// every tick plus the arrival tick of each stop waypoint.
function simulateRoute (route, options) {
  const tickMs = num(options.tickMs, 50)
  const positions = [{ x: route[0].x, y: route[0].y, z: route[0].z, pace: route[0].pace || 'sprint' }]
  const arrivalTicks = new Map([[0, 0]])
  let cur = { ...route[0] }
  let w = 1
  for (let t = 1; w < route.length; t += 1) {
    if (t > 100000) throw new Error('route simulation did not converge')
    const waypoint = route[w]
    const bps = waypoint.pace === 'walk' ? num(options.walkBps, 4.3) : num(options.sprintBps, 7.192)
    const step = bps * tickMs / 1000
    const remaining = Math.sqrt(dist2(cur.x, cur.y, cur.z, waypoint.x, waypoint.y, waypoint.z))
    if (remaining <= step) {
      cur = { x: waypoint.x, y: waypoint.y, z: waypoint.z }
      arrivalTicks.set(w, t)
      w += 1
    } else {
      const f = step / remaining
      cur = { x: cur.x + (waypoint.x - cur.x) * f, y: cur.y + (waypoint.y - cur.y) * f, z: cur.z + (waypoint.z - cur.z) * f }
    }
    positions.push({ ...cur, pace: waypoint.pace || 'sprint' })
    if (w >= route.length) break
  }
  return { positions, arrivalTicks }
}

function compileBandPlan (input) {
  const startedAt = Date.now()
  const { targets, route } = input
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('compileBandPlan: targets required')
  if (!Array.isArray(route) || route.length < 2) throw new Error('compileBandPlan: route required')

  const options = input.options || {}
  const tickMs = num(options.tickMs, 50)
  const blocksPerTick = Math.max(1, Math.trunc(num(options.blocksPerTick, 5)))
  const placeRange = num(options.placeRange, 5)
  const serverLagBlocks = num(options.serverLagBlocks, 1.4)
  const eyeHeight = num(options.eyeHeight, 1.62)
  // All nine hotbar slots are one dynamic pool: residency is decided per band
  // by demand, staging uses whatever is free. No fixed scratch reservation.
  const hotbarCapacity = Math.max(1, Math.trunc(num(options.hotbarCapacity, 9)))
  const stackSize = Math.max(1, Math.trunc(num(options.stackSize, 64)))
  const attempt2DelayTicks = Math.max(1, Math.trunc(num(options.attempt2DelayTicks, 5)))
  const capacityPerSec = blocksPerTick * 1000 / tickMs
  const reachLimit = Math.max(1, placeRange - serverLagBlocks)
  const reachLimit2 = reachLimit * reachLimit

  const compileAt = (forcedWalk) => {
    const simOptions = forcedWalk ? { ...options, sprintBps: num(options.walkBps, 4.3) } : options
    const { positions, arrivalTicks } = simulateRoute(route, simOptions)
    const totalTicks = positions.length

    // 1. Reach windows (from the eye to the placed cell's centre).
    const cells = []
    for (const target of targets) {
      const p = target.position
      let enter = -1
      let exit = -1
      for (let t = 0; t < totalTicks; t += 1) {
        const pos = positions[t]
        if (dist2(pos.x, pos.y + eyeHeight, pos.z, p.x + 0.5, p.y + 0.5, p.z + 0.5) > reachLimit2) continue
        if (enter < 0) enter = t
        exit = t
      }
      if (enter < 0) continue
      cells.push({ target, key: `${p.x}:${p.y}:${p.z}`, blockName: target.blockName, enter, exit, emitTick: -1, attempt2Tick: -1 })
    }
    const infeasible = targets
      .filter((target) => !cells.some((cell) => cell.key === `${target.position.x}:${target.position.y}:${target.position.z}`))
      .map((target) => ({ target, reason: 'never-in-reach' }))

    // 2. Emission assignment: sweep ticks, most-urgent-window-first.
    const capacity = new Array(totalTicks).fill(blocksPerTick)
    const pending = cells.slice()
    for (let t = 0; t < totalTicks && pending.length > 0; t += 1) {
      const open = pending.filter((cell) => cell.enter <= t && t <= cell.exit)
      if (open.length === 0) continue
      const pos = positions[t]
      open.sort((a, b) => a.exit - b.exit || dist2(pos.x, pos.y + eyeHeight, pos.z, a.target.position.x + 0.5, a.target.position.y + 0.5, a.target.position.z + 0.5) - dist2(pos.x, pos.y + eyeHeight, pos.z, b.target.position.x + 0.5, b.target.position.y + 0.5, b.target.position.z + 0.5))
      for (const cell of open) {
        if (capacity[t] <= 0) break
        cell.emitTick = t
        capacity[t] -= 1
        pending.splice(pending.indexOf(cell), 1)
      }
    }
    for (const cell of pending) infeasible.push({ target: cell.target, reason: 'window-closed-before-capacity' })

    // 3. Second-attempt slack (retry headroom inside the window).
    let slackCells = 0
    for (const cell of cells) {
      const t2 = Math.min(cell.exit, cell.emitTick + attempt2DelayTicks)
      if (t2 > cell.emitTick && capacity[t2] > 0) {
        cell.attempt2Tick = t2
        capacity[t2] -= 1
        slackCells += 1
      }
    }

    // 4. Colour runs along emission order.
    const scheduled = cells.slice().sort((a, b) => a.emitTick - b.emitTick || a.key.localeCompare(b.key))
    const runs = []
    for (const cell of scheduled) {
      const last = runs[runs.length - 1]
      if (last && last.colour === cell.blockName) {
        last.lastEmitTick = cell.emitTick
        last.cells += 1
      } else {
        runs.push({ colour: cell.blockName, firstEmitTick: cell.emitTick, lastEmitTick: cell.emitTick, cells: 1 })
      }
    }
    const selects = []
    for (let i = 1; i < runs.length; i += 1) {
      if (runs[i].colour !== runs[i - 1].colour) selects.push({ tick: runs[i].firstEmitTick, colour: runs[i].colour })
    }

    // 5. Stops (route stop waypoints) plus synthetic stops whenever an
    // interval needs more distinct colours than the hotbar can hold.
    const stopTicks = []
    route.forEach((waypoint, w) => {
      if (STOP_ACTIONS.has(String(waypoint.action || '')) && arrivalTicks.has(w)) stopTicks.push(arrivalTicks.get(w))
    })
    stopTicks.sort((a, b) => a - b)
    // Interval membership is by CELLS, not run heads: a run can straddle a
    // stop boundary, and its colour must stay resident until its last cell.
    const intervalCells = (from, to) => scheduled.filter((cell) => cell.emitTick >= from && cell.emitTick < to)
    const distinctColours = (cells) => new Set(cells.map((cell) => cell.blockName))
    // Dedupe and drop zero-length intervals (entry arrives at tick 0; close
    // waypoints can arrive on the same tick).
    const bounds = [0, ...stopTicks, totalTicks].filter((v, i, arr) => i === 0 || v > arr[i - 1])
    for (let i = 0; i < bounds.length - 1; i += 1) {
      let guard = 0
      let cellsIn = intervalCells(bounds[i], bounds[i + 1])
      while (distinctColours(cellsIn).size > hotbarCapacity && guard < 20) {
        guard += 1
        // Cut before the cell that introduces colour capacity+1.
        const kept = new Set()
        let cutCell = null
        for (const cell of cellsIn) {
          kept.add(cell.blockName)
          if (kept.size > hotbarCapacity) {
            cutCell = cell
            break
          }
        }
        if (!cutCell) break
        const cutTick = Math.max(cutCell.emitTick, bounds[i] + 1)
        if (cutTick >= bounds[i + 1]) break // single-tick interval cannot be split further
        stopTicks.push(cutTick)
        stopTicks.sort((a, b) => a - b)
        bounds.splice(i + 1, 0, cutTick)
        cellsIn = intervalCells(bounds[i], bounds[i + 1])
      }
    }

    // 6. Hotbar plan per interval: exact Bélády eviction (farthest next use
    // in true emission order), duplicate staging, refill top-ups.
    const swaps = []
    const refills = []
    const residents = new Map() // colour -> slot (2..8)
    const freeSlots = () => {
      const used = new Set(residents.values())
      const free = []
      for (let slot = 0; slot < Math.min(9, hotbarCapacity); slot += 1) if (!used.has(slot)) free.push(slot)
      return free
    }
    const nextUseTick = (colour, fromTick) => {
      for (const cell of scheduled) {
        if (cell.blockName === colour && cell.emitTick >= fromTick) return cell.emitTick
      }
      return -1
    }
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const stopTick = bounds[i]
      const list = intervalCells(bounds[i], bounds[i + 1])
      const needed = [...distinctColours(list)]
      // Evict first so slots free up deterministically.
      for (const colour of [...residents.keys()]) {
        if (needed.includes(colour)) continue
        const use = nextUseTick(colour, stopTick)
        if (use < 0 || use >= bounds[i + 1]) {
          swaps.push({ tick: stopTick, outColour: colour, reason: use < 0 ? 'never-used-again' : 'farthest-next-use' })
          residents.delete(colour)
        }
      }
      for (const colour of needed) {
        if (residents.has(colour)) continue
        let free = freeSlots()
        if (free.length === 0) {
          // Bélády victim: resident with the farthest next use from here.
          let victim = null
          let victimUse = -2
          for (const resident of residents.keys()) {
            const use = nextUseTick(resident, stopTick)
            const effective = use < 0 ? Number.POSITIVE_INFINITY : use
            if (effective > victimUse) {
              victimUse = effective
              victim = resident
            }
          }
          if (victim == null) break
          swaps.push({ tick: stopTick, outColour: victim, inColour: colour, reason: 'belady' })
          residents.delete(victim)
          free = freeSlots()
        }
        residents.set(colour, free[0])
        swaps.push({ tick: stopTick, inColour: colour, intoSlot: free[0], reason: 'stage' })
      }
      // Duplicate staging + refills from per-colour interval demand.
      for (const colour of needed) {
        const demand = list.filter((cell) => cell.blockName === colour).length
        if (demand > stackSize) {
          const dupSlots = freeSlots()
          if (dupSlots.length > 0) swaps.push({ tick: stopTick, inColour: colour, intoSlot: dupSlots[0], reason: 'duplicate-stack' })
        }
        const nextBound = bounds[i + 1]
        const rest = scheduled.filter((cell) => cell.blockName === colour && cell.emitTick >= stopTick && cell.emitTick < nextBound).length
        if (rest > stackSize) refills.push({ tick: stopTick, colour, amount: rest - stackSize, reason: 'demand-exceeds-stack' })
      }
    }

    // 7. Pacing: any interval whose demand exceeds 80% of sustained capacity
    // walks (windows widen; emission keeps ahead of feet).
    const pacing = []
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const cellsInInterval = scheduled.filter((cell) => cell.emitTick >= bounds[i] && cell.emitTick < bounds[i + 1]).length
      const seconds = (bounds[i + 1] - bounds[i]) * tickMs / 1000
      const neededPerSec = seconds > 0 ? cellsInInterval / seconds : 0
      pacing.push({ fromTick: bounds[i], toTick: bounds[i + 1], cells: cellsInInterval, pace: neededPerSec > 0.8 * capacityPerSec ? 'walk' : 'sprint' })
    }

    return {
      cells, infeasible, runs, selects, swaps, refills, pacing, stopTicks, bounds, positions,
      slackCells, totalTicks,
      stats: {
        cells: cells.length, runs: runs.length, switches: selects.length,
        stops: stopTicks.length, slackCells, infeasible: infeasible.length
      }
    }
  }

  // ponytail: whole-route walk fallback for infeasible cells; per-segment
  // pacing stretch is the upgrade if real canvases ever need finer control.
  const plan = compileAt(false)
  if (plan.infeasible.length > 0) {
    const walked = compileAt(true)
    if (walked.infeasible.length < plan.infeasible.length) {
      walked.stats.fellBackToWalk = true
      return { ...walked, compileMs: Date.now() - startedAt }
    }
  }
  return { ...plan, compileMs: Date.now() - startedAt }
}

module.exports = { compileBandPlan, simulateRoute, STOP_ACTIONS }
