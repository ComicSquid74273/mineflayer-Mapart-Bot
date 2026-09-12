'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.resolve(__dirname, '../src/nerv-printer/cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `missing source marker: ${startMarker}`)
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

test('runPrint no longer performs a startup/per-NBT support-stock circuit', () => {
  const runPrint = sourceBetween('async function runPrint(', 'function createBot(')
  assert.doesNotMatch(runPrint, /checkSupportStockWarningsOnce|__supportStockWarningsCheckedForRun/)
  assert.doesNotMatch(source, /async function checkSupportStockWarningsOnce/)
})

test('food chest access remains behind the live hunger/health gate', () => {
  const foodState = sourceBetween('function getFoodTraversalState(', 'function foodChestTraversalNeeded(')
  assert.match(foodState, /const lowHunger = options\.inclusiveTrigger === true \? hunger <= hungerThreshold : hunger < hungerThreshold/)
  assert.match(foodState, /const needed = enabled && hunger != null && triggered && hunger < targetHunger && Boolean\(foodItem\)/)

  const ensureFood = sourceBetween('async function ensureFoodBeforeTraversal(', 'async function refillXpForPostPrint(')
  const satisfiedReturn = ensureFood.indexOf('if (!foodState.needed) return true')
  const stockPull = ensureFood.indexOf('pullFoodStackFromChest(')
  assert.ok(satisfiedReturn >= 0)
  assert.ok(stockPull > satisfiedReturn)
  assert.doesNotMatch(ensureFood, /returnUnusedFoodToChest\(/)
  assert.match(ensureFood, /if \(!bot\.inventory\.items\(\)\.some\(\(entry\) => entry\.name === foodItem\)\)/)
})

test('a delayed food success resumes only the saved food-blocked post-print checkpoint', () => {
  const loop = sourceBetween('async function runDashboardManagedPrintLoop(', 'function createBot(')
  const blockedWait = loop.indexOf("ensureFoodBeforeTraversal(bot, config, 'postprint-blocked-wait'")
  const recoveryGate = loop.indexOf('shouldResumeBlockedPostPrintAfterFood(postPrintBlockedFailureCode, foodReady, travelSafety)', blockedWait)
  const scheduleResume = loop.indexOf('pendingStart = true', recoveryGate)
  assert.ok(blockedWait >= 0)
  assert.ok(recoveryGate > blockedWait)
  assert.ok(scheduleResume > recoveryGate)
  assert.match(loop, /postPrintBlockedFailureCode = String\(runInfo\?\.postPrintFailureCode \|\| ''\) \|\| null/)
  assert.equal((source.match(/postPrintFailureCode: postPrint(?:Only)?Result\?\.failureCode \|\| null/g) || []).length, 3)

  const postPrint = sourceBetween('async function runPostPrintWorkflow(', 'async function runPostPrintWorkflowWithRecovery(')
  assert.match(postPrint, /'food-travel-safety'/)
  assert.doesNotMatch(postPrint, /Food was unavailable while preparing to return to center safely/)
})

test('consume timeout checks authoritative hunger before reporting failure', () => {
  const eat = sourceBetween('async function eatConfiguredFoodUntilReady(', 'async function pullFoodStackFromChest(')
  const catchStart = eat.indexOf('} catch (err) {')
  const settle = eat.indexOf('await delay(settleMs)', catchStart)
  const hungerRead = eat.indexOf('hunger = getBotHunger(bot)', settle)
  const failure = eat.indexOf('return false', hungerRead)
  assert.ok(catchStart >= 0)
  assert.ok(settle > catchStart)
  assert.ok(hungerRead > settle)
  assert.ok(failure > hungerRead)
})

test('map and pane stock acquisition is scoped to post-print point-of-use steps', () => {
  const postPrint = sourceBetween('async function runPostPrintWorkflow(', 'async function runPostPrintWorkflowWithRecovery(')
  const helper = postPrint.indexOf('const ensureRequiredPostPrintMapMaterials = async')
  const withdrawStep = postPrint.indexOf("if (shouldRunStep('withdraw'))")
  const withdrawUse = postPrint.indexOf("ensureRequiredPostPrintMapMaterials('withdraw', targetEmptyMaps, 1)")
  assert.ok(helper >= 0)
  assert.ok(withdrawStep > helper)
  assert.ok(withdrawUse > withdrawStep)
  assert.doesNotMatch(sourceBetween('async function runPrint(', 'function createBot('), /withdrawRequiredPostPrintMapMaterialsOnce\(/)
})

test('map and pane one-item withdrawal accepts an authoritative returned remainder without a cursor echo', () => {
  const takeOne = sourceBetween('async function takeOneChestItemToInventory(', 'async function topUpPartialInventoryStackFromChest(')
  assert.match(takeOne, /rawInventoryItemMatches\(/)
  assert.match(takeOne, /sourceCount - 1/)
  assert.doesNotMatch(takeOne, /includeCursorUpdate|cursorSequenceBeforeReturn/)
})

test('XP storage is skipped at sufficient level and otherwise used only before rename', () => {
  const refill = sourceBetween('async function refillXpForPostPrint(', 'function sendAnvilItemName(')
  const sufficientLevel = refill.indexOf('if (toNumber(bot.experience?.level, 0) >= minLevel)')
  const chestWithdraw = refill.indexOf('withdrawHalfStackFromSupportChests(')
  assert.ok(sufficientLevel >= 0)
  assert.ok(chestWithdraw > sufficientLevel)
  assert.match(refill, /await bot\.look\(bot\.entity\.yaw \|\| 0, -Math\.PI \/ 2, true\)/)

  const postPrint = sourceBetween('async function runPostPrintWorkflow(', 'async function runPostPrintWorkflowWithRecovery(')
  const renameStep = postPrint.indexOf("if (shouldRunStep('rename_store') && cartographySucceeded)")
  const refillCall = postPrint.indexOf('refillXpForPostPrint(')
  assert.ok(renameStep >= 0)
  assert.ok(refillCall > renameStep)
})

test('deployed printer configs enable infinite refill-aware holds without a food stock quota', () => {
  for (const fileName of ['nerv-printer-config.json', 'nerv-printer-config-premium-1.json']) {
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../nerv-printer-config/_configs/${fileName}`), 'utf8'))
    assert.equal(config.advanced.requiredStockRefillRetryMs, 5000)
    assert.equal(config.advanced.requiredStockRefillLogEveryMs, 30000)
    assert.equal(Object.hasOwn(config.advanced, 'supportStockFoodMinStacks'), false)
    assert.equal(config.advanced.autoEatReturnUnusedFood, false)
  }
})

test('support stock uses half-stack cursor transfers and keeps leftovers protected', () => {
  const halfMove = sourceBetween('async function moveHalfChestStackToInventory(', 'function formatWindowStack(')
  assert.match(halfMove, /sourceMouseButton: 1/)
  assert.match(halfMove, /Math\.floor\(stackSize \/ 2\)/)

  const foodPull = sourceBetween('async function pullFoodStackFromSingleChestUnlocked(', 'async function ensureFoodBeforeTraversal(')
  assert.match(foodPull, /moveHalfChestStackToInventory\(/)
  assert.match(foodPull, /isServerInventoryConfirmationTimeout\(error, transferLabel\)/)
  assert.match(foodPull, /transfer-reconcile/)
  assert.match(foodPull, /authoritative chest reopen confirmed delayed/)

  const xpRefill = sourceBetween('async function refillXpForPostPrint(', 'function sendAnvilItemName(')
  assert.match(xpRefill, /withdrawHalfStackFromSupportChests\(/)
  assert.doesNotMatch(xpRefill, /Returned .*unused XP bottle/)

  const protection = sourceBetween('function isProtectedInventoryItem(', 'function isDumpableInventoryItem(')
  assert.match(protection, /advanced\.autoEatFoodItem/)
  assert.match(protection, /'experience_bottle'/)
})

test('repair checks survival food during batches, active movement, and material refill', () => {
  const repairBatch = sourceBetween('async function repairTargetsInBatches(', 'async function runContinuousPlacementBatch(')
  assert.match(repairBatch, /ensureFoodBeforeTraversal\(bot, config, `repair-batch-/)
  assert.match(repairBatch, /chooseNearestWorkloadEntrySide\(/)
  assert.match(repairBatch, /prepareWorkloadBatchEntry\(/)
  assert.match(repairBatch, /if \(!foodReady\)/)
  assert.match(repairBatch, /if \(result\.foodRequeue && stillWrong\.length > 0\)/)
  assert.match(repairBatch, /without consuming a repair attempt/)
  assert.doesNotMatch(repairBatch, /inclusiveTrigger: true/)

  const movingRepair = sourceBetween('async function repairTargetsWhileMovingWithStops(', 'async function repairTargetsInBatches(')
  assert.match(movingRepair, /await ensureRepairFoodReady\(\)/)
  assert.match(movingRepair, /'repair-active'/)
  assert.match(movingRepair, /FOOD-REQUEUE/)
  assert.match(movingRepair, /const foodState = getFoodTraversalState\(bot, config\)/)
  assert.match(movingRepair, /if \(!foodState\.needed\) return true/)
  assert.match(movingRepair, /foodState\.chestTraversalNeeded/)
  assert.match(movingRepair, /return \{ placed, already, skipped, foodRequeue: true \}/)
  assert.match(movingRepair, /if \(!await ensureRepairFoodReady\(\)\) break/)
  assert.doesNotMatch(movingRepair, /hunger <= hungerThreshold/)

  const repairRestock = sourceBetween('async function ensureRepairMaterialsForTargets(', 'async function dumpUnneededCarpets(')
  assert.match(repairRestock, /'repair-material-refill'/)
  assert.match(repairRestock, /\{ ensureFood: true \}/)
})

test('imported support stations ignore stale local food, XP, and anvil overrides', () => {
  const merge = sourceBetween('} else if (allowMachineNodeOverrides) {', '} else if (allowMapCornerOnly) {')
  assert.match(merge, /normalizeSupportCandidates\(base\.machine\.foodChests, base\.machine\.foodChest\)/)
  assert.match(merge, /normalizeSupportCandidates\(base\.machine\.xpBottleChests, base\.machine\.xpBottleChest\)/)
  assert.match(merge, /normalizeSupportCandidates\(base\.machine\.anvils, base\.machine\.anvil\)/)
  assert.doesNotMatch(merge, /loaded\.machine\?\.(?:foodChests|foodChest|xpBottleChests|xpBottleChest|anvils|anvil)/)
})

test('a non-stock failure retries locally and then recycles the saved checkpoint', () => {
  const hold = sourceBetween('async function holdForRequiredStock(', 'function getDashboardConfig(')
  assert.match(hold, /if \(!result\.ready && result\.operationalFailure\)/)
  assert.match(hold, /clearDashboardAlert\(config, alertCategory\)/)
  assert.match(hold, /requiredStockOperationalRetryAttempts/)
  assert.match(hold, /options\.onOperationalFailure/)
  assert.match(hold, /recycleRuntimeSessionForCheckpoint\(bot, config, reason/)
})

test('food operational retries do not leave stale missing-stock warnings', () => {
  const foodPull = sourceBetween('async function pullFoodStackFromChestUnlocked(', 'async function pullFoodStackFromSingleChestUnlocked(')
  assert.match(foodPull, /Food chest access failed:/)
  assert.doesNotMatch(foodPull, /Food chest fallback failed:/)
  assert.match(foodPull, /options\.reportOperationalWarning !== false/)

  const ensureFood = sourceBetween('async function ensureFoodBeforeTraversal(', 'async function refillXpForPostPrint(')
  assert.match(ensureFood, /reportOperationalWarning: false/)
  assert.match(ensureFood, /onOperationalFailure:/)
  assert.match(ensureFood, /clearDashboardWarning\(config, 'food-supply'\)/)
})

test('cartography output timeouts reconcile late locked-map proof before recycling', () => {
  const postPrint = sourceBetween('async function runPostPrintWorkflow(', 'async function runPostPrintWorkflowWithRecovery(')
  assert.match(postPrint, /isServerInventoryConfirmationTimeout\(err, 'cartography-output'\)/)
  assert.match(postPrint, /postPrintCartographyRecoveryWaitMs/)
  assert.match(postPrint, /cartography-late-output-recovered/)
  assert.match(postPrint, /checkpoint-recovery:cartography-output/)
})
