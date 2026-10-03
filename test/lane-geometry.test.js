'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

function loadCheckpointBuilder() {
  const start = source.indexOf('function buildNervUCheckpoints(')
  assert.ok(start >= 0, 'buildNervUCheckpoints must exist')
  const end = source.indexOf('\nfunction chooseNearestWorkloadEntrySide(', start)
  const body = source.slice(start, end)
  const toNumber = 'function toNumber(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d }'
  const factory = new Function(`${toNumber}\n${body}\nreturn buildNervUCheckpoints`)
  return factory()
}

const band = (minZ, maxZ, cols) => {
  const targets = []
  for (let z = minZ; z <= maxZ; z += 1) {
    for (const col of cols) targets.push({ col, blockName: 'black_carpet', position: { x: 1000 + col, y: 64, z } })
  }
  return targets
}

test('entry stands one block BEFORE the first row in travel direction', () => {
  const build = loadCheckpointBuilder()
  const targets = band(0, 127, [0, 1, 2, 3])
  const southbound = build(targets, true, 0)
  assert.equal(southbound[0].position.z, -0.5, 'southbound entry is one before minZ, never ON the first row')
  const northbound = build(targets, false, 0)
  assert.equal(northbound[0].position.z, 127.5, 'northbound entry is one past maxZ')
})

test('a wide batch walks a serpentine: every column group within one reach diameter', () => {
  const build = loadCheckpointBuilder()
  // 14 columns spanning ~52 blocks in x -- the live 08:31 band shape where
  // the old single-line route left 280/511 cells beyond reach (neverSent
  // walk-past). Coordinates here are synthetic, not the real map.
  const cols = []
  for (let x = 2000; x <= 2052; x += 4) cols.push(x)
  const targets = []
  for (const col of cols) {
    for (let z = 0; z <= 31; z += 1) targets.push({ col, blockName: 'black_carpet', position: { x: col, y: 64, z } })
  }
  const route = build(targets, true, 12, { lateralCoverBlocks: 6 })

  // Multi-pass: more than one walk line, each column within the reach sphere
  // of its pass's line (reach ~3.4).
  const walkXs = [...new Set(route.map((cp) => cp.position.x))]
  assert.ok(walkXs.length >= 2, `expected a multi-pass route, got lines [${walkXs}]`)
  for (const col of cols) {
    const nearest = Math.min(...walkXs.map((wx) => Math.abs(wx - col)))
    assert.ok(nearest <= 3.5, `column x=${col} has no route line within reach (nearest ${nearest})`)
  }
  // Only the FINAL checkpoint is a lineEnd (intermediate pass ends are plain
  // walk-throughs -- lineEnd triggers the drain and the swap-ban expiry).
  const lineEnds = route.filter((cp) => cp.action === 'lineEnd')
  assert.equal(lineEnds.length, 1)
  assert.equal(route[route.length - 1].action, 'lineEnd')
})

test('the early turn pulls the exit back from the lane end', () => {
  const build = loadCheckpointBuilder()
  const targets = band(0, 127, [0, 1, 2, 3])
  const southbound = build(targets, true, 0, { turnEarlyBlocks: 3 })
  assert.equal(southbound[southbound.length - 1].position.z, 124.5, 'southbound exit = maxZ + 0.5 - turnEarly')
  const northbound = build(targets, false, 0, { turnEarlyBlocks: 3 })
  assert.equal(northbound[northbound.length - 1].position.z, 2.5, 'northbound exit = minZ - 0.5 + turnEarly')
  // turnEarly 0 keeps the one-past-the-end exit that already worked.
  assert.equal(build(targets, true, 0)[1].position.z, 127.5)
  assert.equal(build(targets, false, 0)[1].position.z, -0.5)
})

test('the candidate scan never offers a cell overlapping the player bounding box', () => {
  const start = source.indexOf('function collectNervScannerCandidates(')
  const fn = source.slice(start, source.indexOf('\nfunction findNervScannerCandidate(', start))
  assert.match(fn, /botX - 0\.3 < target\.position\.x \+ 1 && botX \+ 0\.3 > target\.position\.x/)
  assert.match(fn, /botY < target\.position\.y \+ 1 && botY \+ playerHeight > target\.position\.y/)
})

test('ahead-of-travel candidates are held back by the forward-edge margin', () => {
  const start = source.indexOf('function collectNervScannerCandidates(')
  const fn = source.slice(start, source.indexOf('\nfunction findNervScannerCandidate(', start))
  assert.match(fn, /scannerForwardEdgeMargin/)
  assert.match(fn, /aheadBlocks > 0/)
  assert.match(fn, /placeRange - forwardEdgeMargin/)
})

test('the uTurn leg prints: gate, bonus cells, and no mid-turn emergency stop', () => {
  const workloadAt = source.indexOf('async function runNervTimeWorkloadPlacementBatch(')
  const batch = source.slice(workloadAt, source.indexOf('\nfunction probeStartupSupport(', workloadAt))

  assert.match(batch, /currentAction === 'uTurn'/)
  assert.match(batch, /options\.uTurnTargets/)
  assert.match(batch, /action: 'uTurn',/)
  assert.match(batch, /if \(currentAction === 'uTurn'\) \{[\s\S]{0,200}pendingUntil\.set\(key, Date\.now\(\) \+ optimisticRetryMs\)/)

  // The band loop hands the next band's entry and head-row cells to the batch.
  const bandLoop = source.slice(source.indexOf('const batchOptions = { windowTargets: inventoryWindow.targets }'))
  assert.match(bandLoop.slice(0, 2200), /batchOptions\.uTurnPosition = nextEntry/)
  assert.match(bandLoop.slice(0, 2200), /batchOptions\.uTurnTargets = nextBatchTargets\.filter/)
})

test('miss recovery counts exhausted retries and trailing one-send drops, not echo lag', () => {
  const workloadAt = source.indexOf('async function runNervTimeWorkloadPlacementBatch(')
  const batch = source.slice(workloadAt, source.indexOf('\nfunction probeStartupSupport(', workloadAt))
  const missAt = batch.indexOf('const repairRadius')
  const miss = batch.slice(missAt, missAt + 1800)

  // A checkpoint repairs only misses within the repair radius; beyond it,
  // misses are recorded for the line-end repair (never walked back for).
  assert.match(miss, /checkpointRepairRadiusBlocks/, 'the repair radius knob must drive the gate')
  assert.match(miss, /if \(dxy <= repairRadius\)/)
  assert.match(miss, /recordedBeyondRadius/)
  assert.match(miss, /MISS-RECORDED/)
  // Parked cells (echo window live) are lag, not misses.
  assert.match(miss, /pendingExpiry !== undefined && pendingExpiry > Date\.now\(\)\) continue/)
})

test('adaptive slow-down is wired: backlog engages walk, clear resumes sprint', () => {
  const workloadAt = source.indexOf('async function runNervTimeWorkloadPlacementBatch(')
  const batch = source.slice(workloadAt, source.indexOf('\nfunction probeStartupSupport(', workloadAt))

  assert.match(batch, /scannerAdaptiveSlowdown === true/)
  assert.match(batch, /__nervTraversalSlow/)
  assert.match(batch, /__nervTraversalWantSprint/)
  assert.match(batch, /TRAVERSAL-SLOW/)
  // The checkpoint sprint assertion honours the slow flag and stores the intent.
  assert.match(batch, /bot\.__nervTraversalWantSprint = shouldSprint/)
  assert.match(batch, /shouldSprint && bot\.__nervTraversalSlow !== true/)
})

test('per-band phase accounting and the silent-pause reason log exist', () => {
  const workloadAt = source.indexOf('async function runNervTimeWorkloadPlacementBatch(')
  const batch = source.slice(workloadAt, source.indexOf('\nfunction probeStartupSupport(', workloadAt))

  assert.match(batch, /\[LANE-PHASE\] targets=\$\{batchTargets\.length\}/)
  assert.match(batch, /walkMs=|drainMs=|backtrackMs=|repairMs=/)
  assert.match(batch, /unresolvedIn=/)
  assert.match(batch, /WORKLOAD-PLACEMENT-PAUSED/)
  assert.match(batch, /worldChangePending=/)
  assert.match(batch, /LANE-EDGE-VERIFY/)
})

test('duplicate staging is skipped when a merge already covers the demand', () => {
  const start = source.indexOf('function runProactiveHotbarMaintenance(')
  const fn = source.slice(start, source.indexOf('\nfunction ', start + 10))
  assert.match(fn, /mergeCeiling >= demand\) continue/)
})
