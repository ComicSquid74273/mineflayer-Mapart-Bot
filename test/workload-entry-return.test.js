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
  assert.match(helper, /strict: true/)
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

