'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

function loadLeash() {
  const start = source.indexOf('function computeTraversalLeashState(')
  assert.ok(start >= 0, 'computeTraversalLeashState must exist')
  const end = source.indexOf('\nasync function runNervTimeWorkloadPlacementBatch', start)
  assert.ok(end > start)
  const factory = new Function(`${source.slice(start, end)}\nreturn computeTraversalLeashState`)
  return factory()
}

const cell = (z) => ({ position: { x: 3000, y: 64, z } })
const keyOf = (z) => `3000:64:${z}`

function runLeash(cells, sentKeys, botZ, opts = {}) {
  const leash = loadLeash()
  const seen = new Set(opts.seen || [])
  const stallSkipped = new Set(opts.stallSkipped || [])
  const sentCounts = new Map()
  for (const key of sentKeys || []) sentCounts.set(key, 1)
  return leash({
    targets: cells,
    seen,
    sentCounts,
    stallSkipped,
    botTravelCoord: botZ,
    travelCoordOf: (target) => target.position.z,
    leashBlocks: opts.leashBlocks ?? 2,
    maxEnforceBehind: opts.maxEnforceBehind ?? 8
  })
}

test('all sent or confirmed cells leave the leash open', () => {
  const cells = [cell(0), cell(1), cell(2)]
  assert.equal(runLeash(cells, [keyOf(0), keyOf(1)], 5, { seen: [keyOf(2)] }).hold, false)
})

test('an unsent cell just inside the leash is fine, past it holds', () => {
  const cells = [cell(10)]
  assert.equal(runLeash(cells, [], 12).hold, false, '2 behind = at the limit, open')
  assert.equal(runLeash(cells, [], 12.01).hold, true, 'just past 2 behind holds')
})

test('cells ahead of the bot never hold the walk', () => {
  const cells = [cell(20), cell(25)]
  assert.equal(runLeash(cells, [], 10).hold, false)
})

test('deep-behind damage does not freeze the walk (deadlock guard)', () => {
  const cells = [cell(0), cell(40)]
  const result = runLeash(cells, [], 45)
  assert.equal(result.hold, true, 'the 5-behind cell holds')
  assert.equal(result.behind, 5)
  const deepOnly = runLeash([cell(0)], [], 45)
  assert.equal(deepOnly.hold, false, '45 behind is repair/entry-drain work, not leash work')
})

test('stallSkipped cells count as cleared (the stall watchdog owns them)', () => {
  assert.equal(runLeash([cell(10)], [], 14, { stallSkipped: [keyOf(10)] }).hold, false)
})

test('source wiring: hold flag, pause branch, finally cleanup, telemetry', () => {
  // The pause branch honors the hold with the same semantics as an
  // inventory-swap settle.
  const pauseAt = source.indexOf("if (paused || bot.__nervInventorySwapActive === true || bot.__nervTraversalHold === true)")
  assert.ok(pauseAt >= 0, 'the straight-walk pause branch must include __nervTraversalHold')

  // The placement loop computes the leash every wake from local state only.
  const loopStart = source.indexOf('async function runNervTimeWorkloadPlacementBatch')
  const loop = source.slice(loopStart, source.indexOf('\nasync function ', loopStart + 10))
  assert.match(loop, /computeTraversalLeashState\(\{/)
  assert.match(loop, /bot\.__nervTraversalHold = leash\.hold === true/)
  assert.match(loop, /sendCounts,/, 'the send ledger (not the echo) drives the leash -- and the real variable name is sendCounts; a typo here killed the placement loop on wake 1 (ReferenceError swallowed by observeBackgroundTask)')
  assert.match(loop, /\[TRAVERSAL-LEASH\] engaged/)
  assert.match(loop, /leash=\$\{leash\.hold \? 'hold' : 'open'\}/, 'PLAN-DEBT carries the leash state')
  assert.match(loop, /delete bot\.__nervTraversalHold/, 'the finally block clears the flag')
})

test('mini dry-run: leash pins the walk to the print rate and never passes', () => {
  // 4-column x 128-row lane, travel along +z. Printer budget 30 cells/s,
  // sends the nearest unsent cell while it is within 4.5 blocks of the bot.
  // Bot moves at sprint 7.192 bps while the leash is open, 0 while held.
  const leash = loadLeash()
  const cols = [3000, 3001, 3002, 3003]
  const targets = []
  for (let z = 0; z < 128; z += 1) {
    for (const col of cols) targets.push({ position: { x: col, y: 64, z } })
  }
  const sentCounts = new Map()
  const seen = new Set()
  const stallSkipped = new Set()
  const tickMs = 50
  const tokensPerTick = 30 * tickMs / 1000
  let tokens = 5
  let botZ = -0.5
  let worstViolation = 0
  let doneAtTick = -1
  for (let t = 0; t < 2000; t += 1) {
    if (doneAtTick < 0 && targets.every((target) => sentCounts.get(`${target.position.x}:${target.position.y}:${target.position.z}`) > 0)) {
      doneAtTick = t
      break
    }
    const state = leash({
      targets, seen, sentCounts, stallSkipped,
      botTravelCoord: botZ,
      travelCoordOf: (target) => target.position.z,
      leashBlocks: 2,
      maxEnforceBehind: 8
    })
    if (state.behind > 2) worstViolation = Math.max(worstViolation, state.behind - 2)
    tokens = Math.min(5, tokens + tokensPerTick)
    // Printer: send nearest unsent cells within reach, budget-limited.
    const reachable = targets
      .filter((target) => {
        const key = `${target.position.x}:${target.position.y}:${target.position.z}`
        return !seen.has(key) && !(sentCounts.get(key) > 0) && Math.abs(target.position.z - botZ) <= 4.5
      })
      .sort((a, b) => Math.abs(a.position.z - botZ) - Math.abs(b.position.z - botZ))
    for (const target of reachable) {
      if (tokens < 1) break
      tokens -= 1
      sentCounts.set(`${target.position.x}:${target.position.y}:${target.position.z}`, 1)
    }
    // Movement: sprint while open, dead stop while held.
    if (!state.hold) botZ = Math.min(127.5, botZ + 7.192 * tickMs / 1000)
  }
  const laneSeconds = doneAtTick * tickMs / 1000
  console.log(`[LEASH-DRYRUN] laneSeconds=${laneSeconds.toFixed(1)} worstViolation=${worstViolation.toFixed(2)} finalZ=${botZ.toFixed(1)}`)
  // The guarantee: the bot never exceeded the first-unsent cell + leash.
  assert.ok(worstViolation <= 0.01, `leash violated by ${worstViolation.toFixed(2)} blocks`)
  // The pace: 512 cells at 30 bps ~= 17s; the leash must not cost much more.
  assert.ok(doneAtTick > 0 && laneSeconds <= 22, `lane took ${laneSeconds.toFixed(1)}s (budget floor ~17s)`)
})
