'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

test('workload batch entry returns through verified machine navigation after restock or food access', () => {
  const helperStart = source.indexOf('async function prepareWorkloadBatchEntry')
  const helperEnd = source.indexOf('\nasync function runNervScannerPlacementBatch', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)

  const helper = source.slice(helperStart, helperEnd)
  assert.match(helper, /buildNervUCheckpoints\(batchTargets, startOnNorthSide/)
  assert.match(helper, /await gotoConfiguredAccess\(/)
  assert.match(helper, /'workload-batch-entry-return'/)
  assert.match(helper, /strict: false/)
  assert.match(helper, /allowVerifiedGaps: false/)
})

test('both workload modes stage before food access and return after it before traversal', () => {
  const litematicFood = source.indexOf('await ensureFoodBeforeTraversal(bot, config, `litematic-batch')
  const litematicEntryBefore = source.lastIndexOf('await prepareWorkloadBatchEntry(bot, config, batchTargets, batchStartOnNorthSide)', litematicFood)
  const litematicEntryAfter = source.indexOf('await prepareWorkloadBatchEntry(bot, config, batchTargets, batchStartOnNorthSide)', litematicFood)
  const litematicRun = source.indexOf('const result = await runNervTimeWorkloadPlacementBatch', litematicEntryAfter)
  assert.ok(litematicEntryBefore >= 0 && litematicEntryBefore < litematicFood)
  assert.ok(litematicFood < litematicEntryAfter && litematicEntryAfter < litematicRun)

  const fastFood = source.indexOf('await ensureFoodBeforeTraversal(bot, config, `fast-batch')
  const fastEntryBefore = source.lastIndexOf('await prepareWorkloadBatchEntry(bot, config, batchTargets, batchStartOnNorthSide)', fastFood)
  const fastEntryAfter = source.indexOf('await prepareWorkloadBatchEntry(bot, config, batchTargets, batchStartOnNorthSide)', fastFood)
  const fastRun = source.indexOf("const result = scannerWorkloadMode === 'time'", fastEntryAfter)
  assert.ok(fastEntryBefore >= 0 && fastEntryBefore < fastFood)
  assert.ok(fastFood < fastEntryAfter && fastEntryAfter < fastRun)

  const repairStart = source.indexOf('async function repairTargetsInBatches')
  const repairEnd = source.indexOf('\nasync function runContinuousPlacementBatch', repairStart)
  assert.ok(repairStart >= 0 && repairEnd > repairStart)
  const repair = source.slice(repairStart, repairEnd)
  const repairFood = repair.indexOf('await ensureFoodBeforeTraversal(bot, config, `repair-batch-')
  const repairEntryBefore = repair.lastIndexOf('await prepareWorkloadBatchEntry(bot, config, batch, batchStartOnNorthSide)', repairFood)
  const repairEntryAfter = repair.indexOf('await prepareWorkloadBatchEntry(bot, config, batch, batchStartOnNorthSide)', repairFood)
  const repairRun = repair.indexOf('const result = await repairTargetsWhileMovingWithStops', repairEntryAfter)
  assert.ok(repairEntryBefore >= 0 && repairEntryBefore < repairFood)
  assert.ok(repairFood < repairEntryAfter && repairEntryAfter < repairRun)
})

test('inventory windows preserve U traversal direction without a second parity flip', () => {
  const runPrintStart = source.indexOf('async function runPrint(bot, config, dashboardRuntime = null)')
  const runPrintEnd = source.indexOf('\nfunction createBot(', runPrintStart)
  assert.ok(runPrintStart >= 0 && runPrintEnd > runPrintStart)

  const runPrint = source.slice(runPrintStart, runPrintEnd)
  assert.match(runPrint, /const inventoryRowOrder = startOnNorthSide \? sortedRowsAsc/)
  assert.match(runPrint, /let batchStartOnNorthSide = startOnNorthSide/)
  assert.match(runPrint, /startOnNorthSide = batchStartOnNorthSide/)
  assert.doesNotMatch(runPrint, /chunkStartOnNorthSide|isEvenBatch/)
})

test('staged ingress breaks long-distance non-strict access into 24-block segments', () => {
  const gotoStart = source.indexOf('async function gotoConfiguredAccess(')
  const gotoEnd = source.indexOf('\nasync function openBlockWindowAt(', gotoStart)
  assert.ok(gotoStart >= 0 && gotoEnd > gotoStart)

  const gotoCode = source.slice(gotoStart, gotoEnd)
  assert.match(gotoCode, /ingressDistance > 32/)
  assert.match(gotoCode, /const segmentLength = 24/)
  assert.match(gotoCode, /staged-ingress/)
})


test('the final sweep trusts the confirmed-placement ledger instead of the silent client world', () => {
  // Paper never echoes block_change to the placing client, so a client-only
  // world snapshot reports every accepted carpet as air and floods the repair
  // pass with false positives.
  const scanStart = source.indexOf('function scanPlacementErrors(')
  const scanEnd = source.indexOf('\nfunction ', scanStart + 10)
  assert.ok(scanStart >= 0 && scanEnd > scanStart)

  const scan = source.slice(scanStart, scanEnd)
  assert.match(scan, /const confirmed = options\.confirmedPlaced instanceof Set/)
  assert.match(scan, /if \(confirmed && confirmed\.has\(`\$\{target\.position\.x\}:\$\{target\.position\.y\}:\$\{target\.position\.z\}`\)\) continue/)

  // The ledger is filled by the workload pass and consumed by both verification passes.
  assert.match(source, /const confirmedPlaced = options\.confirmedPlaced instanceof Set/)
  assert.match(source, /const markTargetPlacedInWorld = \(target, key = getTargetKey\(target\)\) => \{[\s\S]*?confirmedPlaced\.add\(key\)/)
  assert.match(source, /confirmedPlaced: bot\.__nervConfirmedPlaced/)
  assert.match(source, /if \(bot\.__nervConfirmedPlaced instanceof Set && bot\.__nervConfirmedPlaced\.has\(key\)\) continue/)
})

test('every post-placement verification path honours the confirmed-placement ledger', () => {
  // Regression: post-repair verification reported MORE errors (1621) than the
  // first pass (597) because it re-read a client world the server never updates.
  const verifyScan = /scanPlacementErrors\(bot, orderedTargets, \{[\s\S]{0,400}?confirmedPlaced: bot\.__nervConfirmedPlaced/g
  const scans = source.match(verifyScan) || []
  assert.ok(scans.length >= 2, `expected both REPAIR-VERIFY scans to use the ledger, found ${scans.length}`)

  assert.match(source, /for \(const target of orderedTargets\) \{[\s\S]*?dashboard-stop-during-final-scan[\s\S]*?__nervConfirmedPlaced\.has\(`\$\{target\.position\.x\}/)
  assert.match(source, /dashboard-stop-during-verification[\s\S]*?__nervConfirmedPlaced\.has\(`\$\{target\.position\.x\}/)

  // placeTarget must record acceptance too, otherwise repair placements re-enter the ledger blind.
  const placeEnd = source.indexOf('\nfunction isTargetAlreadyResolved(')
  const placeTarget = source.slice(source.indexOf('async function placeTarget('), placeEnd)
  assert.match(placeTarget, /bot\.__nervConfirmedPlaced\.add\(`\$\{target\.position\.x\}:\$\{target\.position\.y\}:\$\{target\.position\.z\}`\)/)
})

test('band retry and missing-count consult the ledger instead of the silent client world', () => {
  // Regression: every placement re-read as air, so each emergency restock re-placed
  // the whole 640-target band and the reported missing count only grew (77 -> 106).
  const retryFilters = source.match(/batchTargets\.filter\(\(target\) => \{\r?\n\s*\/\/ Paper never echoes block_change[\s\S]{0,400}?__nervConfirmedPlaced\.has\(`\$\{target\.position\.x\}:\$\{target\.position\.y\}:\$\{target\.position\.z\}`\)\) return false/g) || []
  assert.equal(retryFilters.length, 3, `expected all three band-retry filters to consult the ledger, found ${retryFilters.length}`)

  assert.match(source, /let missing = 0\r?\n\s*for \(const target of batchTargets\) \{\r?\n\s*const key = getTargetKey\(target\)\r?\n\s*if \(confirmedPlaced\.has\(key\)\) continue/)
})

test('a fast-confirm repair placement accepts the written packet when the client world can never confirm it', () => {
  // Regression: `block=red_carpet has 38 in inventory; falling back to stop-place`
  // repeated as `unconfirmed-place` because waitForTargetBlockPlaced polls a
  // client world Paper never updates, so the same block was re-placed forever.
  const placeEnd = source.indexOf('\nfunction isTargetAlreadyResolved(')
  const placeTarget = source.slice(source.indexOf('async function placeTarget('), placeEnd)
  assert.match(placeTarget, /if \(requiresFastConfirmation && bot\.__nervAcceptUnconfirmedPlacement === true\) \{\r?\n\s*placedSuccessfully = true\r?\n\s*break\r?\n\s*\}/)

  assert.match(source, /repairAcceptUnconfirmedPlacement: true,/)
  const mixedStart = source.indexOf('async function repairTargetsWhileMovingWithStops(')
  const mixed = source.slice(mixedStart, mixedStart + 700)
  assert.match(mixed, /bot\.__nervAcceptUnconfirmedPlacement = \(config\.advanced \|\| \{\}\)\.repairAcceptUnconfirmedPlacement === true/)
})

test('the placement burst collects and sorts once, closest-first, with a reach-exit tiebreak', () => {
  // Regression: the loop re-scanned the reach grid per placement (capping us near
  // 1 block/tick) and a large rowPriority let a forward block outrank a closer
  // trailing one. The reference printer sorts once, then emits blocks-per-tick.
  const collectEnd = source.indexOf('\nfunction findNervScannerCandidate(')
  const collect = source.slice(source.indexOf('function collectNervScannerCandidates('), collectEnd)

  assert.match(collect, /scored\.sort\(\(left, right\) => left\.score - right\.score\)/)
  // Distance must dominate; the row schedule is only a tiebreak.
  assert.match(collect, /score: repairPriority \+ distance2 \* 1000 - rowTiebreak/)
  assert.doesNotMatch(collect, /rowPriority/)
  // The grid walk happens once and world reads happen after the sort.
  assert.ok(collect.indexOf('scored.push') < collect.indexOf('scored.sort'))

  const loopStart = source.indexOf('const placementLoop = observeBackgroundTask', source.indexOf('async function runNervTimeWorkloadPlacementBatch'))
  const loop = source.slice(loopStart, loopStart + 12000)
  assert.match(loop, /const burstTargets = collectNervScannerCandidates\(/)
  assert.match(loop, /for \(let i = 0; i < burstTargets\.length; i \+= 1\)/)
  // One call per tick, not one per placement slot.
  assert.equal((loop.match(/collectNervScannerCandidates\(/g) || []).length, 1)

  // The burst provisions every material it needs rather than deferring the swap
  // to placeTarget, which stalled the sprint once per new colour.
  assert.match(loop, /Goal lookahead: provision every material this burst needs/)
  assert.match(loop, /silentHotbarSwap\(bot, source\.slot, destIndex\)/)
  assert.doesNotMatch(loop, /if \(countInventoryItems\(bot, blockName\) > 0\) continue/)
})
