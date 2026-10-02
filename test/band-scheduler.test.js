'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { compileBandPlan } = require(path.join(__dirname, '..', 'src', 'nerv-printer', 'band-scheduler.js'))

const Y = 100

// Serpentine route over `lanes` rows of `len` cells along +x, lane k at z = k,
// entered from the x=0 side. Stop waypoints at entry, each lane end, and exit.
function serpentineRoute (len, lanes, { uTurn = false } = {}) {
  const route = [{ x: -2, y: Y, z: 0, action: 'entry' }]
  for (let lane = 0; lane < lanes; lane += 1) {
    const toX = lane % 2 === 0 ? len - 1 : 0
    route.push({ x: toX, y: Y, z: lane, action: 'laneEnd' })
    if (lane + 1 < lanes) route.push({ x: toX, y: Y, z: lane + 1, action: lane + 1 === lanes - 1 && uTurn ? 'uTurn' : undefined })
  }
  route.push({ x: 0, y: Y, z: lanes - 1, action: 'exit' })
  return route
}

function bandTargets (len, lanes, colourOf) {
  const targets = []
  for (let lane = 0; lane < lanes; lane += 1) {
    for (let x = 0; x < len; x += 1) {
      targets.push({ position: { x, y: Y, z: lane }, blockName: colourOf(x, lane) })
    }
  }
  return targets
}

const OPTIONS = { placeRange: 5, serverLagBlocks: 1.4, blocksPerTick: 5, hotbarCapacity: 7, stackSize: 64 }

function assertInvariants (plan, targets) {
  // 1. Every scheduled emission sits inside its reach window.
  for (const cell of plan.cells) {
    assert.ok(cell.enter <= cell.emitTick && cell.emitTick <= cell.exit, `emit ${cell.emitTick} outside window [${cell.enter},${cell.exit}] for ${cell.key}`)
    if (cell.attempt2Tick >= 0) {
      assert.ok(cell.attempt2Tick > cell.emitTick && cell.attempt2Tick <= cell.exit, `retry outside window for ${cell.key}`)
    }
  }
  // 2. Per-tick emission never exceeds blocksPerTick (attempts included).
  const perTick = new Map()
  for (const cell of plan.cells) {
    perTick.set(cell.emitTick, (perTick.get(cell.emitTick) || 0) + 1)
    if (cell.attempt2Tick >= 0) perTick.set(cell.attempt2Tick, (perTick.get(cell.attempt2Tick) || 0) + 1)
  }
  for (const [tick, count] of perTick) assert.ok(count <= OPTIONS.blocksPerTick, `tick ${tick} emits ${count}`)
  // 3. Nothing silently dropped: scheduled + infeasible == targets.
  assert.equal(plan.cells.length + plan.infeasible.length, targets.length)
  // 4. Swaps only at stop ticks.
  for (const swap of plan.swaps) assert.ok(plan.stopTicks.includes(swap.tick), `swap at non-stop tick ${swap.tick}`)
}

test('friendly band: full coverage, zero infeasible, slack present', () => {
  const len = 32
  const lanes = 5
  const targets = bandTargets(len, lanes, (x, lane) => ['red_carpet', 'blue_carpet', 'green_carpet', 'white_carpet'][(x + lane) % 4])
  const plan = compileBandPlan({ targets, route: serpentineRoute(len, lanes), options: OPTIONS })

  assert.equal(plan.infeasible.length, 0)
  assertInvariants(plan, targets)
  assert.ok(plan.cells.length === targets.length)
  assert.ok(plan.stats.slackCells > targets.length * 0.5, 'most cells should carry a retry slot')
})

test('colour runs are contiguous and selects match switches exactly', () => {
  const targets = bandTargets(24, 3, (x) => (x % 6 < 3 ? 'red_carpet' : 'blue_carpet'))
  const plan = compileBandPlan({ targets, route: serpentineRoute(24, 3), options: OPTIONS })

  for (let i = 1; i < plan.runs.length; i += 1) {
    assert.notEqual(plan.runs[i].colour, plan.runs[i - 1].colour, 'adjacent runs must differ')
  }
  assert.equal(plan.selects.length, plan.runs.length - 1)
  for (const select of plan.selects) {
    const run = plan.runs.find((r) => r.colour === select.colour && r.firstEmitTick === select.tick)
    assert.ok(run, `select at ${select.tick} must match a run head`)
  }
})

test('a 9-colour band forces synthetic stops and never exceeds hotbar capacity per interval', () => {
  const targets = bandTargets(36, 3, (x) => `c${x % 9}_carpet`)
  const plan = compileBandPlan({ targets, route: serpentineRoute(36, 3), options: OPTIONS })

  assert.equal(plan.infeasible.length, 0)
  assertInvariants(plan, targets)
  const bounds = plan.bounds
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const colours = new Set(
      plan.cells.filter((c) => c.emitTick >= bounds[i] && c.emitTick < bounds[i + 1]).map((c) => c.blockName)
    )
    assert.ok(colours.size <= OPTIONS.hotbarCapacity, `interval ${i} needs ${colours.size} colours`)
  }
  // The lane's natural stops alone (entry, laneEnds, exit) can't hold 9 colours
  // across one long lane, so at least one synthetic stop must exist.
  assert.ok(plan.stats.stops > 5, `expected synthetic stops, got ${plan.stats.stops}`)
})

test('belady eviction removes the never-used-again colour first', () => {
  // Lane 1 ends with purple used once early and never again; later the band
  // needs more colours than slots at that stop.
  const targets = bandTargets(30, 3, (x, lane) => {
    if (lane === 0 && x < 3) return 'purple_carpet'
    return ['red_carpet', 'blue_carpet', 'green_carpet', 'white_carpet', 'yellow_carpet', 'black_carpet', 'gray_carpet', 'orange_carpet'][(x + lane) % 8]
  })
  const plan = compileBandPlan({ targets, route: serpentineRoute(30, 3), options: OPTIONS })
  const evictions = plan.swaps.filter((s) => s.outColour === 'purple_carpet' && s.reason === 'never-used-again')
  assert.ok(evictions.length >= 1, 'purple must be evicted as never-used-again')
  for (const swap of plan.swaps) assert.ok(plan.stopTicks.includes(swap.tick))
})

test('duplicate staging fires when one interval needs more than a stack', () => {
  // 100 red cells inside a single short lane: demand > 64 between stops.
  const targets = bandTargets(100, 1, () => 'red_carpet')
  const plan = compileBandPlan({ targets, route: serpentineRoute(100, 1), options: { ...OPTIONS, hotbarCapacity: 7 } })
  const dup = plan.swaps.filter((s) => s.reason === 'duplicate-stack')
  const refill = plan.refills.filter((r) => r.colour === 'red_carpet')
  assert.ok(dup.length >= 1 || refill.length >= 1, 'demand>64 must trigger duplicate staging or a refill op')
  assert.equal(plan.infeasible.length, 0)
  assertInvariants(plan, targets)
})

test('a never-reachable cell is flagged infeasible, never silently dropped', () => {
  const targets = bandTargets(20, 2, () => 'red_carpet')
  targets.push({ position: { x: 500, y: Y, z: 500 }, blockName: 'red_carpet' }) // far away
  const plan = compileBandPlan({ targets, route: serpentineRoute(20, 2), options: OPTIONS })

  assert.equal(plan.infeasible.length, 1)
  assert.equal(plan.infeasible[0].reason, 'never-in-reach')
  assert.equal(plan.infeasible[0].target.position.x, 500)
  assert.equal(plan.cells.length, targets.length - 1)
})

test('a cell only reachable on the return leg is scheduled then', () => {
  // Route walks straight past a pocket and returns along a parallel lane;
  // the pocket cell is out of reach on the outbound pass, in reach on return.
  const route = [
    { x: 0, y: Y, z: 0, action: 'entry' },
    { x: 20, y: Y, z: 0, action: 'laneEnd' },
    { x: 20, y: Y, z: 2, action: 'uTurn' },
    { x: 0, y: Y, z: 2, action: 'exit' }
  ]
  const targets = bandTargets(21, 1, () => 'red_carpet') // outbound lane z=0
  for (let x = 0; x <= 20; x += 1) targets.push({ position: { x, y: Y, z: 2 }, blockName: 'blue_carpet' }) // return lane
  // A cell deep off-lane: 3.5 blocks lateral of the return lane at x=10.
  targets.push({ position: { x: 10, y: Y, z: 5 }, blockName: 'green_carpet' })
  const plan = compileBandPlan({ targets, route, options: { ...OPTIONS, placeRange: 5, serverLagBlocks: 0.1 } })

  assert.equal(plan.infeasible.length, 0)
  const pocket = plan.cells.find((c) => c.key === `10:${Y}:5`)
  assert.ok(pocket, 'pocket cell must be scheduled')
  assertInvariants(plan, targets)
})

test('pacing marks dense intervals as walk', () => {
  const targets = bandTargets(20, 2, () => 'red_carpet')
  const plan = compileBandPlan({ targets, route: serpentineRoute(20, 2), options: OPTIONS })
  assert.ok(Array.isArray(plan.pacing) && plan.pacing.length >= 1)
  for (const segment of plan.pacing) {
    assert.ok(segment.pace === 'sprint' || segment.pace === 'walk')
    assert.ok(segment.toTick > segment.fromTick)
  }
})

test('a plan compiles fast enough to recompile mid-band on drift', () => {
  const targets = bandTargets(128, 5, (x, lane) => `c${(x + lane) % 8}_carpet`)
  const t0 = Date.now()
  const plan = compileBandPlan({ targets, route: serpentineRoute(128, 5), options: OPTIONS })
  const ms = Date.now() - t0
  assert.equal(plan.infeasible.length, 0)
  assert.ok(ms < 500, `compile took ${ms}ms for a full 640-cell band`)
})

// --- Executor wiring (source-level, mirrors the runtime gate) ---

const fs = require('node:fs')
const cliSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js'), 'utf8')

test('the executor is opt-in and falls back to the heuristic scan', () => {
  assert.match(cliSource, /bandSchedulerEnabled: false/, 'flag must default off')
  assert.match(cliSource, /advanced\.bandSchedulerEnabled === true/, 'gate must require the flag')
  assert.match(cliSource, /require\('\.\/band-scheduler'\)/)
  assert.match(cliSource, /\[BAND-PLAN-ERR\]/, 'a compile failure must fall back, not crash')
})

test('schedule-driven emission replaces the scan only when a plan exists', () => {
  const batchStart = cliSource.indexOf('async function runNervTimeWorkloadPlacementBatch')
  const batchEnd = cliSource.indexOf('\nasync function ', batchStart + 10)
  const batch = cliSource.slice(batchStart, batchEnd)

  const planBranch = batch.indexOf('if (bandPlan) {')
  const scanBranch = batch.indexOf('burstTargets = collectNervScannerCandidates(')
  assert.ok(planBranch >= 0 && scanBranch > planBranch, 'planned branch first, heuristic in else')

  // Due-filter semantics: emission honors the scheduled tick, the window with
  // a grace, and the shared parking bookkeeping.
  assert.match(batch, /cell\.emitTick > planTick \|\| planTick > cell\.exit \+ 10/, 'due = scheduled tick reached and window still open')
  assert.match(batch, /burstExcluded\.has\(cell\.key\)/, 'parked cells are never re-offered by the plan')

  // Planned-vs-actual telemetry before any repair phase.
  assert.match(batch, /\[BAND-EXEC\] scheduled=/)
  assert.match(batch, /lateWindow=/)

  // The plan state is per-band: reset in the finally so the next band recompiles.
  assert.match(batch, /bot\.__nervBandPlanActive = false/)
})

test('step 3: no inventory mutation inside the emission window', () => {
  // The mid-burst cross-inventory swap is banned under a plan.
  const equipAt = cliSource.indexOf('bot.__nervInventorySwapActive = true')
  const equip = cliSource.slice(equipAt, equipAt + 1400)
  assert.match(equip, /if \(bot\.__nervBandPlanActive === true\) return false/, 'equipMaterial must decline cross-inventory swaps under a plan')

  // The swap's local slot prediction is a lie whenever the server can reject
  // the click: under a plan, slots are server-truth (set_slot echo) only.
  const swapAt = cliSource.indexOf('function silentHotbarSwap(')
  const swap = cliSource.slice(swapAt, cliSource.indexOf('\nfunction ', swapAt))
  assert.match(swap, /bot\.__nervBandPlanActive !== true && Array\.isArray\(slots\)/, 'slot prediction must be skipped under a plan')

  // Deferrals are explicit, cheap, and never counted as desyncs.
  assert.match(cliSource, /plan-not-staged-/)
  assert.match(cliSource, /startsWith\('plan-not-staged-'\)/)
})

test('step 3: scheduled staging executes at plan stops', () => {
  const batchStart = cliSource.indexOf('async function runNervTimeWorkloadPlacementBatch')
  const batchEnd = cliSource.indexOf('\nasync function ', batchStart + 10)
  const batch = cliSource.slice(batchStart, batchEnd)

  assert.match(batch, /for \(const op of bandPlan\.swaps\)/, 'the loop must execute planned swap ops')
  assert.match(batch, /\[BAND-STAGE\]/)
  assert.match(batch, /__nervSwapWaitUntil/, 'swaps are paced, not machine-gunned')
  // Staging uses the wire swap; refills stay on the existing machinery.
  assert.match(batch, /silentHotbarSwap\(bot, source\.slot, dest\)/)
})

test('step 4: position-derived plan clock and live reach gate', () => {
  const batchStart = cliSource.indexOf('async function runNervTimeWorkloadPlacementBatch')
  const batchEnd = cliSource.indexOf('\nasync function ', batchStart + 10)
  const batch = cliSource.slice(batchStart, batchEnd)

  // The plan's clock is the bot's position, not wall time: pauses (drains,
  // checkpoints, turns) cannot make the schedule outrun the bot.
  assert.match(batch, /const currentPlanTick = \(\) => \{/, 'position-derived plan tick must exist')
  assert.match(batch, /bandPlan\.pacing\.find\(\(s\) => planTick >= s\.fromTick && planTick < s\.toTick\)/)
  assert.match(batch, /const slowNow = planPaceWalk \|\|/)
  // Every planned emission passes a live reach gate before the packet goes
  // out (schedule says when, eye-range confirms now).
  const dueAt = batch.indexOf('cell.emitTick > planTick')
  assert.ok(dueAt >= 0)
  assert.match(batch.slice(dueAt, dueAt + 1600), /liveReach2/, 'due cells must pass the live reach gate')
})
