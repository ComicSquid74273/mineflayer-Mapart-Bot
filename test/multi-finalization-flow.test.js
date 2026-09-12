const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const cliPath = path.resolve(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

test('multi finalization verifies and journals the source before postprint completion and retirement', () => {
  const helperStart = source.indexOf('const stageSourceRetirement = async () => {')
  const helperEnd = source.indexOf('\n  const completeMultiJobWithoutDashboard', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)
  const helper = source.slice(helperStart, helperEnd)
  assert.ok(helper.includes('finalSourceSha256 = hashFileSha256(input.sourcePath)'))
  assert.ok(helper.includes('await dashboardRuntime?.stageActiveQueueFileResult?.('))
  assert.ok(helper.includes('multiJobId: multiJob?.jobId || null'))
  assert.ok(helper.includes('sourcePath: input.sourcePath'))
  assert.ok(helper.includes('sourceSha256'))
  assert.ok(helper.includes('dashboardResultStageRetryMs'))
  assert.ok(helper.includes('while (!dashboardResultStaged)'))
  assert.ok(helper.includes("clearAlert?.('dashboard-result-stage')"))
  assert.ok(helper.includes("setAlert?.('dashboard-result-stage'"))
  assert.equal(helper.includes("requestTeamPause(multiWorkerName, 'multi-dashboard-result-stage-failed')"), false)
  assert.equal(helper.includes('MULTI_DASHBOARD_RESULT_STAGE_FAILED'), false)

  const orderedFinalizations = source.match(/await stageSourceRetirement\(\)\s*\r?\n\s*markMultiPostPrintComplete\(\)/g) || []
  assert.equal(orderedFinalizations.length, 2)
})

test('staged dashboard completion stays local while the NBT exists and is recoverable after retirement', () => {
  const enqueueStart = source.indexOf('function enqueueQueueResultUnlocked(')
  const flushStart = source.indexOf('async function flushQueueResultOutboxUnlocked()', enqueueStart)
  const normalizeStart = source.indexOf('function normalizeQueueFileInfo(', flushStart)
  assert.ok(enqueueStart >= 0 && flushStart > enqueueStart && normalizeStart > flushStart)

  const enqueue = source.slice(enqueueStart, flushStart)
  const flush = source.slice(flushStart, normalizeStart)
  assert.ok(enqueue.includes('readyToReport: options.readyToReport !== false'))
  assert.ok(flush.includes('if (item.readyToReport === false)'))
  assert.ok(flush.includes('if (fs.existsSync(stagedPath))'))
  assert.ok(flush.includes('if (item.dashboardReportedAt)'))
  assert.ok(flush.includes('completeCoordinatorAfterDashboardResult'))
  assert.ok(flush.includes('dashboardQueueResultIsTerminal'))
  assert.ok(flush.includes('dashboardItem = await reportQueueFileResult'))

  const missingStart = source.indexOf('if (activeQueueFile?.fileId && !activeQueuePath)')
  const missingEnd = source.indexOf('\n    if (!shouldStart)', missingStart)
  const missingHandler = source.slice(missingStart, missingEnd)
  assert.ok(missingHandler.indexOf('resumeStagedActiveQueueFileResult') < missingHandler.indexOf('claimed dashboard queue NBT is missing locally'))
})

test('dashboard queue-result mutations and reports are serialized and atomically persisted', () => {
  const serializerStart = source.indexOf('function serializeQueueResultOutbox(')
  const normalizeStart = source.indexOf('function normalizeQueueFileInfo(', serializerStart)
  assert.ok(serializerStart >= 0 && normalizeStart > serializerStart)
  const outboxFlow = source.slice(serializerStart, normalizeStart)
  assert.ok(outboxFlow.includes('queueResultOutboxSerial.then(action, action)'))
  assert.ok(outboxFlow.includes('serializeQueueResultOutbox(flushQueueResultOutboxUnlocked)'))

  const writeStart = source.indexOf('function writeQueueResultOutbox(')
  const serializerEnd = source.indexOf('function serializeQueueResultOutbox(', writeStart)
  const writer = source.slice(writeStart, serializerEnd)
  assert.ok(writer.includes('fs.writeFileSync(temporaryPath'))
  assert.ok(writer.includes('fs.renameSync(temporaryPath, filePath)'))

  const completeStart = source.indexOf('async completeActiveQueueFile(')
  const completeEnd = source.indexOf('\n    restoreQueueFileForNbt(', completeStart)
  const complete = source.slice(completeStart, completeEnd)
  assert.ok(complete.includes('return serializeQueueResultOutbox(async () => {'))
  assert.ok(complete.includes('enqueueQueueResultUnlocked('))
  assert.ok(complete.includes('recoverActiveQueueFileForNbt'))
})

test('multi finalization recovers exact dashboard identity instead of selecting a prefetched NBT', () => {
  const recoveryStart = source.indexOf('async function recoverActiveQueueFileForNbt(')
  const recoveryEnd = source.indexOf('\n  function restoreActiveQueueFile()', recoveryStart)
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart)
  const recovery = source.slice(recoveryStart, recoveryEnd)
  assert.ok(recovery.includes('/queue/recover-active'))
  assert.ok(recovery.includes('localFileName: safeName'))
  assert.ok(recovery.includes('sha256: sourceSha256'))
  assert.ok(recovery.includes('itemNames.includes(safeName)'))
  assert.ok(recovery.indexOf('const remembered = restoreQueueFileForNbt(safeName)') < recovery.indexOf('if (!fs.existsSync(localPath)) return null'))

  const stageStart = source.indexOf('async stageActiveQueueFileResult(')
  const stageEnd = source.indexOf('\n    async resumeStagedActiveQueueFileResult()', stageStart)
  const stage = source.slice(stageStart, stageEnd)
  assert.ok(stage.includes('options.sourcePath || config.__dashboardQueueNbtPath'))
  assert.ok(!stage.includes('restoreActiveQueueFile()'))
})

test('accepted multi dashboard result is reconciled after coordinator restart once its source is retired', () => {
  const finalizerStart = source.indexOf('function completeCoordinatorAfterDashboardResult(')
  const flushStart = source.indexOf('async function flushQueueResultOutboxUnlocked()', finalizerStart)
  const finalizer = source.slice(finalizerStart, flushStart)
  assert.ok(finalizer.includes('!currentJob || currentJob.jobId !== multiJobId'))
  assert.ok(finalizer.includes('item.dashboardReportedAt && queueResultSourceIsRetired(item)'))
  assert.ok(finalizer.includes('return true'))
})

test('multi queue completion waits for accepted dashboard result before coordinator completion', () => {
  const finalizerStart = source.indexOf('function completeCoordinatorAfterDashboardResult(')
  const flushStart = source.indexOf('async function flushQueueResultOutbox()', finalizerStart)
  assert.ok(finalizerStart >= 0 && flushStart > finalizerStart)
  const finalizer = source.slice(finalizerStart, flushStart)
  assert.ok(finalizer.indexOf("currentJob.status !== 'postprint-complete'") < finalizer.indexOf('coordinator.completeJob('))

  const managedStart = source.indexOf('async function runDashboardManagedPrintLoop(')
  const managedEnd = source.indexOf('\nasync function runDeliveryManagedLoop(', managedStart)
  assert.ok(managedStart >= 0 && managedEnd > managedStart)
  const managed = source.slice(managedStart, managedEnd)
  assert.ok(managed.includes('multiJobId: runInfo?.multiJobId || null'))
  assert.ok(managed.includes('sourcePath: runInfo?.sourcePath || claimedQueueNbt'))
  assert.ok(managed.includes('sourceSha256: runInfo?.sourceSha256 || null'))
  assert.equal(managed.includes('config.__multiCoordinator.completeJob('), false)
})

test('multi dashboard source and launch path always come from the shared coordinator job', () => {
  const dashboardStart = source.indexOf('function createDashboardRuntime(')
  const dashboardEnd = source.indexOf('\nasync function runDashboardManagedPrintLoop(', dashboardStart)
  const dashboardRuntime = source.slice(dashboardStart, dashboardEnd)
  const assignmentSource = dashboardRuntime.indexOf('function currentAssignmentSourceName()')
  const currentSource = dashboardRuntime.indexOf('function currentSourceName()', assignmentSource)
  const currentSourceBody = dashboardRuntime.slice(currentSource, dashboardRuntime.indexOf('\n  function currentRuntimeLocation()', currentSource))
  assert.ok(assignmentSource >= 0)
  assert.match(dashboardRuntime.slice(assignmentSource, currentSource), /config\.__multiCoordinator\?\.getCurrentJob\?\.\(\)/)
  assert.match(currentSourceBody, /currentAssignmentSourceName\(\) \|\| state\.currentNbt/)

  const managedStart = source.indexOf('async function runDashboardManagedPrintLoop(')
  const managedEnd = source.indexOf('\nfunction createBot(', managedStart)
  const managedLoop = source.slice(managedStart, managedEnd)
  assert.match(managedLoop, /await dashboardRuntime\?\.recoverQueueFileForNbt\?\.\(/)
  assert.match(managedLoop, /activeCoordinatedJob\.sourcePath,\s*activeCoordinatedJob\.sourceSha256/)
  assert.match(managedLoop, /const activeQueueFile = coordinatedQueueFile \|\| dashboardRuntime\?\.getActiveQueueFile\?\.\(\)/)
  assert.match(managedLoop, /const nextNbt = activeCoordinatedJob\?\.sourcePath \|\| claimedQueueNbt \|\| \(multiRole === 'slave' \? null : getNextNbtFile\(config\)\)/)
  assert.match(managedLoop, /setCurrentNbt\(activeCoordinatedJob\?\.sourceName \|\|/)
})

test('standby dashboard heartbeat preserves the complete validated multi-bot identity', () => {
  const standbyStart = source.indexOf('async function standbyWaitForReconnect(')
  const standbyEnd = source.indexOf('\nfunction shouldRetryReconnect(', standbyStart)
  assert.ok(standbyStart >= 0 && standbyEnd > standbyStart)
  const standby = source.slice(standbyStart, standbyEnd)
  for (const field of [
    'health:',
    'hunger:',
    'activeState:',
    'location:',
    'idle:',
    'role,',
    'recoveryState:',
    'reconnectState:',
    'currentNbt:'
  ]) {
    assert.ok(standby.includes(field), `standby status is missing ${field}`)
  }
})

test('live multi coordination never installs a retirement or readiness barrier timeout', () => {
  const runPrintStart = source.indexOf('async function runPrint(')
  const runPrintEnd = source.indexOf('\nfunction createBot(', runPrintStart)
  const runPrint = source.slice(runPrintStart, runPrintEnd)
  assert.match(runPrint, /const multiWaitOptions = \{\s*isAlive:/)
  assert.doesNotMatch(runPrint, /multiWaitOptions = \{[\s\S]*?timeoutMs:/)

  const multiStart = source.indexOf('async function runMultiUserLive(')
  const multiEnd = source.indexOf('\nasync function start(', multiStart)
  const multiLive = source.slice(multiStart, multiEnd)
  assert.match(multiLive, /barrierTimeoutMs: null/)
})
