const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  computeWorkerIntervals,
  createMultiBotCoordinator,
  hashFileSha256,
  validateMultiAssignments,
  validateMultiTargets
} = require('../src/nerv-printer/multi-coordinator')

function assignments() {
  const intervals = computeWorkerIntervals(2, 128)
  return [
    {
      name: 'VulcanB001',
      role: 'master',
      interval: intervals[0],
      stateFile: 'master_state.json',
      progressFile: './logs/progress-VulcanB001.json'
    },
    {
      name: 'VulcanB010',
      role: 'slave',
      interval: intervals[1],
      stateFile: 'slave_VulcanB010_state.json',
      progressFile: './logs/progress-VulcanB010.json'
    }
  ]
}

function targets() {
  return [
    { row: 0, col: 0, blockName: 'white_carpet', symbol: 'white_carpet', position: { x: 10, y: 82, z: 20 } },
    { row: 0, col: 63, blockName: 'red_carpet', symbol: 'red_carpet', position: { x: 73, y: 82, z: 20 } },
    { row: 0, col: 64, blockName: 'blue_carpet', symbol: 'blue_carpet', position: { x: 74, y: 82, z: 20 } },
    { row: 127, col: 127, blockName: 'black_carpet', symbol: 'black_carpet', position: { x: 137, y: 82, z: 147 } }
  ]
}

function runtimeControl() {
  return {
    held: new Set(),
    starts: 0,
    stops: 0,
    requestHold(reason) { this.held.add(reason) },
    releaseHold(reason) { this.held.delete(reason) },
    requestStart() { this.starts += 1 },
    requestStop() { this.stops += 1 }
  }
}

function withCoordinator(fn) {
  return async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-'))
    try {
      const coordinator = createMultiBotCoordinator({
        assignments: assignments(),
        syncFolder: folder,
        teamId: 'bot01-test-team',
        generation: 100,
        pollMs: 25,
        barrierTimeoutMs: 1000
      })
      await fn(coordinator, folder)
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  }
}

function connectBoth(coordinator) {
  coordinator.markConnecting('VulcanB001', 'master-session-1')
  coordinator.markConnecting('VulcanB010', 'slave-session-1')
  coordinator.markPlatformReady('VulcanB001', { worldGeneration: 1, position: { x: 1, y: 82, z: 1 } })
  coordinator.markPlatformReady('VulcanB010', { worldGeneration: 1, position: { x: 2, y: 82, z: 1 } })
}

function publish(coordinator) {
  return coordinator.publishJob('VulcanB001', {
    sourceType: 'nbt',
    sourceName: 'mapart.nbt',
    sourcePath: path.join(coordinator.syncFolder, 'mapart.nbt'),
    sourceSha256: 'a'.repeat(64),
    targets: targets()
  })
}

function acknowledge(coordinator, workerName, job) {
  const assignment = job.assignments.find((entry) => entry.name === workerName)
  const worker = coordinator.getWorkerSnapshot(workerName)
  return coordinator.acknowledgeJob(workerName, {
    jobId: job.jobId,
    generation: job.generation,
    sourceSha256: job.sourceSha256,
    interval: assignment.interval,
    sessionId: worker.sessionId
  })
}

function completeWorker(coordinator, workerName, job, overrides = {}) {
  const assignment = job.assignments.find((entry) => entry.name === workerName)
  const worker = coordinator.getWorkerSnapshot(workerName)
  return coordinator.completeWorker(workerName, {
    jobId: job.jobId,
    generation: job.generation,
    sourceSha256: job.sourceSha256,
    interval: assignment.interval,
    processedTargets: assignment.targetCount,
    totalTargets: assignment.targetCount,
    errorCount: 0,
    sessionId: worker.sessionId,
    ...overrides
  })
}

function createCoordinator(folder, overrides = {}) {
  return createMultiBotCoordinator({
    assignments: assignments(),
    syncFolder: folder,
    teamId: 'bot01-test-team',
    generation: 100,
    pollMs: 25,
    barrierTimeoutMs: 1000,
    ...overrides
  })
}

function publishRealSource(coordinator, folder, contents = 'restart-safe-nbt') {
  const sourcePath = path.join(folder, 'mapart.nbt')
  fs.writeFileSync(sourcePath, contents)
  return coordinator.publishJob('VulcanB001', {
    sourceType: 'nbt',
    sourceName: path.basename(sourcePath),
    sourcePath,
    sourceSha256: hashFileSha256(sourcePath),
    targets: targets()
  })
}

test('two workers split the 128 columns exactly into 0-63 and 64-127', () => {
  assert.deepEqual(computeWorkerIntervals(2, 128), [
    { start: 0, end: 63 },
    { start: 64, end: 127 }
  ])
})

test('roster validation requires unique workers and exactly one master', () => {
  assert.equal(validateMultiAssignments(assignments(), 128), true)

  const duplicate = assignments()
  duplicate[1].name = duplicate[0].name.toLowerCase()
  assert.throws(() => validateMultiAssignments(duplicate, 128), /MULTI_INVALID_ROSTER: duplicate worker name/i)

  const twoMasters = assignments()
  twoMasters[1].role = 'master'
  assert.throws(() => validateMultiAssignments(twoMasters, 128), /exactly one master/i)
})

test('roster validation canonicalizes state and progress paths before collision checks', () => {
  const sameState = assignments()
  sameState[1].stateFile = path.resolve(sameState[0].stateFile)
  assert.throws(() => validateMultiAssignments(sameState, 128), /collides with state file/i)

  const crossType = assignments()
  crossType[1].progressFile = path.resolve(crossType[0].stateFile)
  assert.throws(() => validateMultiAssignments(crossType, 128), /progress file.*collides with state file/i)
})

test('fresh coordinator removes a stale manifest before exposing team state', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-stale-'))
  try {
    fs.writeFileSync(path.join(folder, 'job_manifest.json'), JSON.stringify({ stale: true }))
    const coordinator = createMultiBotCoordinator({
      assignments: assignments(),
      syncFolder: folder,
      teamId: 'bot01-stale-test',
      generation: 100,
      pollMs: 25,
      barrierTimeoutMs: 1000
    })
    assert.equal(fs.existsSync(coordinator.manifestPath), false)
    assert.equal(fs.existsSync(coordinator.statePath), true)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('multi target validation rejects empty and silently clipped map data', () => {
  assert.throws(() => validateMultiTargets([], 128, 128), /MULTI_EMPTY_TARGETS/)
  assert.throws(() => validateMultiTargets([
    { row: 0, col: 128, blockName: 'white_carpet', position: { x: 0, y: 0, z: 0 } }
  ], 128, 128), /MULTI_TARGET_OUT_OF_BOUNDS/)
})

test('only master can publish the calibrated immutable job manifest', withCoordinator(async (coordinator, folder) => {
  connectBoth(coordinator)
  assert.throws(() => coordinator.publishJob('VulcanB010', {
    sourceName: 'wrong.nbt',
    sourceSha256: 'b'.repeat(64),
    targets: targets()
  }), /MULTI_MASTER_ONLY/)

  const job = publish(coordinator)
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'job_manifest.json'), 'utf8'))
  assert.equal(manifest.jobId, job.jobId)
  assert.equal(manifest.sourceSha256, 'a'.repeat(64))
  assert.deepEqual(manifest.targets, targets())
  assert.deepEqual(manifest.assignments.map((item) => item.targetCount), [2, 2])
}))

test('printing release waits for both platform-ready workers to acknowledge the same job', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  assert.equal(coordinator.getCurrentJob().status, 'preparing')

  assert.throws(() => coordinator.acknowledgeJob('VulcanB010', {
    jobId: job.jobId,
    generation: job.generation,
    sourceSha256: 'b'.repeat(64),
    interval: { start: 64, end: 127 },
    sessionId: coordinator.getWorkerSnapshot('VulcanB010').sessionId
  }), /MULTI_SOURCE_MISMATCH/)

  acknowledge(coordinator, 'VulcanB010', job)
  const released = await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  assert.equal(released.status, 'running')
  assert.equal(released.releaseEpoch, 1)
}))

test('worker acknowledging before platform-ready is accepted and releases once platform-ready is marked', withCoordinator(async (coordinator) => {
  coordinator.markConnecting('VulcanB001', 'master-session-1')
  coordinator.markConnecting('VulcanB010', 'slave-session-1')
  coordinator.markPlatformReady('VulcanB001', { worldGeneration: 1, position: { x: 1, y: 82, z: 1 } })
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  assert.doesNotThrow(() => acknowledge(coordinator, 'VulcanB010', job))
  assert.notEqual(coordinator.getCurrentJob().status, 'running')
  coordinator.markPlatformReady('VulcanB010', { worldGeneration: 1, position: { x: 2, y: 82, z: 1 } })
  const released = await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  assert.equal(released.status, 'running')
}))

test('a disconnect invalidates stale readiness and pauses the connected peer until both return', withCoordinator(async (coordinator) => {
  const masterControl = {
    held: new Set(),
    requestHold(reason) { this.held.add(reason) },
    releaseHold(reason) { this.held.delete(reason) }
  }
  const slaveControl = {
    held: new Set(),
    requestHold(reason) { this.held.add(reason) },
    releaseHold(reason) { this.held.delete(reason) }
  }
  coordinator.registerRuntime('VulcanB001', masterControl)
  coordinator.registerRuntime('VulcanB010', slaveControl)
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  coordinator.markOffline('VulcanB010', 'network error')
  assert.equal(coordinator.getCurrentJob().status, 'held')
  assert.equal(masterControl.held.has('multi-peer-offline'), true)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobAck, null)

  coordinator.markConnecting('VulcanB010', 'slave-session-2')
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobAck, null)
  coordinator.markPlatformReady('VulcanB010', { worldGeneration: 2, position: { x: 2, y: 82, z: 1 } })
  assert.equal(masterControl.held.has('multi-peer-offline'), false)
  assert.equal(coordinator.getCurrentJob().status, 'held')

  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  const rereleased = await coordinator.waitForRelease('VulcanB010', job.jobId, job.generation, { isAlive: () => true })
  assert.equal(rereleased.status, 'running')
  assert.equal(rereleased.releaseEpoch, 2)
}))

test('postprint is blocked until both exact intervals complete with zero errors', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  completeWorker(coordinator, 'VulcanB001', job)
  assert.throws(() => coordinator.markPostPrintStarted('VulcanB001', job.jobId, job.generation), /MULTI_POSTPRINT_BLOCKED/)
  assert.throws(() => completeWorker(coordinator, 'VulcanB010', job, { errorCount: 1 }), /MULTI_WORKER_FAILED/)
  assert.equal(coordinator.getCurrentJob().status, 'held')
}))

test('slave remains incomplete until master postprint and explicit job completion', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  completeWorker(coordinator, 'VulcanB001', job)
  completeWorker(coordinator, 'VulcanB010', job)
  await coordinator.waitForAllWorkersComplete('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  coordinator.markPostPrintStarted('VulcanB001', job.jobId, job.generation)
  assert.throws(() => coordinator.completeJob('VulcanB001', job.jobId, job.generation), /MULTI_COMPLETION_BLOCKED/)
  coordinator.markPostPrintComplete('VulcanB001', job.jobId, job.generation)
  const completed = coordinator.completeJob('VulcanB001', job.jobId, job.generation)
  assert.equal(completed.status, 'completed')
  assert.equal((await coordinator.waitForJobComplete('VulcanB010', job.jobId, job.generation, { isAlive: () => true })).status, 'completed')
}))

test('coordination waits stop immediately when their Minecraft session ends', withCoordinator(async (coordinator) => {
  coordinator.markConnecting('VulcanB010', 'slave-session-1')
  coordinator.markPlatformReady('VulcanB010', { position: { x: 1, y: 82, z: 1 } })
  await assert.rejects(
    coordinator.waitForJob('VulcanB010', { isAlive: () => false }),
    /MULTI_SESSION_ENDED/
  )
}))

test('idle manifest waits time out without creating a job or team hold', withCoordinator(async (coordinator) => {
  coordinator.markConnecting('VulcanB010', 'slave-session-1')
  coordinator.markPlatformReady('VulcanB010', { position: { x: 1, y: 82, z: 1 } })
  await assert.rejects(
    coordinator.waitForJob('VulcanB010', { timeoutMs: 1000, isAlive: () => true }),
    /MULTI_BARRIER_TIMEOUT/
  )
  assert.equal(coordinator.getCurrentJob(), null)
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-barrier-timeout'), false)
}))

test('heartbeats require the current online Minecraft session', withCoordinator(async (coordinator) => {
  coordinator.markConnecting('VulcanB010', 'slave-session-1')
  assert.throws(
    () => coordinator.heartbeat('VulcanB010', 'printing', 'slave-session-old'),
    /MULTI_SESSION_MISMATCH/
  )
  coordinator.heartbeat('VulcanB010', 'printing', 'slave-session-1')
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').phase, 'printing')
  coordinator.markOffline('VulcanB010', 'network error', 'slave-session-1')
  assert.throws(
    () => coordinator.heartbeat('VulcanB010', 'printing', 'slave-session-1'),
    /MULTI_WORKER_OFFLINE/
  )
}))

test('same-session platform recovery preserves acknowledgement and automatically releases the job', withCoordinator(async (coordinator) => {
  const masterControl = runtimeControl()
  const slaveControl = runtimeControl()
  coordinator.registerRuntime('VulcanB001', masterControl)
  coordinator.registerRuntime('VulcanB010', slaveControl)
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  coordinator.markPlatformUnavailable('VulcanB010', 'world changed')
  assert.equal(masterControl.held.has('multi-peer-platform'), true)
  assert.equal(slaveControl.held.has('multi-peer-platform'), false)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobAck.jobId, job.jobId)
  assert.equal(coordinator.getCurrentJob().status, 'held')

  coordinator.markPlatformReady('VulcanB010', { worldGeneration: 2, position: { x: 2, y: 82, z: 1 } })
  assert.equal(masterControl.held.has('multi-peer-platform'), false)
  assert.equal(coordinator.getCurrentJob().status, 'running')
  assert.equal(coordinator.getCurrentJob().releaseEpoch, 2)
}))

test('operator pause survives platform-ready events and only master start releases it', withCoordinator(async (coordinator) => {
  const masterControl = runtimeControl()
  const slaveControl = runtimeControl()
  coordinator.registerRuntime('VulcanB001', masterControl)
  coordinator.registerRuntime('VulcanB010', slaveControl)
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  coordinator.requestTeamPause('VulcanB001', 'operator pause')
  assert.equal(coordinator.getCurrentJob().status, 'held')
  assert.equal(masterControl.held.has('multi-operator-pause'), true)
  assert.equal(slaveControl.held.has('multi-operator-pause'), true)
  coordinator.markPlatformReady('VulcanB001', { position: { x: 1, y: 82, z: 1 } })
  coordinator.markPlatformReady('VulcanB010', { position: { x: 2, y: 82, z: 1 } })
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-operator-pause'), true)
  assert.equal(coordinator.getCurrentJob().status, 'held')

  assert.throws(() => coordinator.requestTeamStart('VulcanB010'), /MULTI_MASTER_ONLY/)
  coordinator.requestTeamStart('VulcanB001', 'operator resume')
  assert.equal(masterControl.held.has('multi-operator-pause'), false)
  assert.equal(slaveControl.held.has('multi-operator-pause'), false)
  assert.equal(coordinator.getCurrentJob().status, 'running')
}))

test('failed interval is sticky until a master reset completes', withCoordinator(async (coordinator) => {
  const masterControl = runtimeControl()
  const slaveControl = runtimeControl()
  coordinator.registerRuntime('VulcanB001', masterControl)
  coordinator.registerRuntime('VulcanB010', slaveControl)
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  completeWorker(coordinator, 'VulcanB001', job)
  assert.throws(() => completeWorker(coordinator, 'VulcanB010', job, { errorCount: 'invalid' }), /MULTI_WORKER_FAILED/)

  coordinator.markPlatformUnavailable('VulcanB010', 'temporary transfer')
  coordinator.markPlatformReady('VulcanB010', { position: { x: 2, y: 82, z: 1 } })
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-worker-failed'), true)
  assert.equal(coordinator.getCurrentJob().status, 'held')
  assert.throws(() => coordinator.requestTeamStart('VulcanB001'), /MULTI_RESET_REQUIRED/)

  coordinator.requestTeamReset('VulcanB001', 'retry failed interval')
  assert.equal(masterControl.held.has('multi-reset'), false)
  assert.equal(slaveControl.held.has('multi-reset'), true)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB001').jobResult, null)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobResult, null)
  coordinator.completeTeamReset('VulcanB001')
  assert.equal(coordinator.snapshot().holdReasons.length, 0)
  assert.equal(coordinator.getCurrentJob().status, 'preparing')
}))

test('stale session results cannot poison a reconnecting worker job', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  const oldSessionId = coordinator.getWorkerSnapshot('VulcanB010').sessionId

  coordinator.markOffline('VulcanB010', 'network error')
  coordinator.markConnecting('VulcanB010', 'slave-session-2')
  coordinator.markPlatformReady('VulcanB010', { position: { x: 2, y: 82, z: 1 } })
  const slaveAssignment = job.assignments.find((entry) => entry.name === 'VulcanB010')
  assert.throws(() => coordinator.completeWorker('VulcanB010', {
    jobId: job.jobId,
    generation: job.generation,
    sourceSha256: job.sourceSha256,
    interval: slaveAssignment.interval,
    processedTargets: slaveAssignment.targetCount,
    totalTargets: slaveAssignment.targetCount,
    errorCount: 0,
    sessionId: oldSessionId
  }), /MULTI_SESSION_MISMATCH/)
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-worker-failed'), false)

  acknowledge(coordinator, 'VulcanB010', job)
  completeWorker(coordinator, 'VulcanB010', job)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobResult.status, 'completed')
}))

test('acknowledgements and completion certificates reject missing or stale generations', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  const master = coordinator.getWorkerSnapshot('VulcanB001')
  const assignment = job.assignments.find((entry) => entry.name === 'VulcanB001')
  const acknowledgement = {
    jobId: job.jobId,
    sourceSha256: job.sourceSha256,
    interval: assignment.interval,
    sessionId: master.sessionId
  }
  assert.throws(() => coordinator.acknowledgeJob('VulcanB001', acknowledgement), /MULTI_INVALID_GENERATION/)
  assert.throws(() => coordinator.acknowledgeJob('VulcanB001', { ...acknowledgement, generation: job.generation - 1 }), /MULTI_GENERATION_MISMATCH/)

  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  const result = {
    jobId: job.jobId,
    sourceSha256: job.sourceSha256,
    interval: assignment.interval,
    processedTargets: assignment.targetCount,
    totalTargets: assignment.targetCount,
    errorCount: 0,
    sessionId: master.sessionId
  }
  assert.throws(() => coordinator.completeWorker('VulcanB001', result), /MULTI_INVALID_GENERATION/)
  assert.throws(() => coordinator.completeWorker('VulcanB001', { ...result, generation: job.generation - 1 }), /MULTI_GENERATION_MISMATCH/)
}))

test('late readiness and offline callbacks from an old session cannot alter the replacement session', withCoordinator(async (coordinator) => {
  coordinator.markConnecting('VulcanB010', 'slave-session-1')
  coordinator.markOffline('VulcanB010', 'network error', 'slave-session-1')
  coordinator.markConnecting('VulcanB010', 'slave-session-2')

  assert.throws(() => coordinator.markPlatformReady('VulcanB010', {
    sessionId: 'slave-session-1',
    position: { x: 2, y: 82, z: 1 }
  }), /MULTI_SESSION_MISMATCH/)
  coordinator.markPlatformReady('VulcanB010', {
    sessionId: 'slave-session-2',
    position: { x: 2, y: 82, z: 1 }
  })
  assert.throws(
    () => coordinator.markPlatformUnavailable('VulcanB010', 'late old-world event', 'slave-session-1'),
    /MULTI_SESSION_MISMATCH/
  )
  assert.throws(
    () => coordinator.markOffline('VulcanB010', 'late socket end', 'slave-session-1'),
    /MULTI_SESSION_MISMATCH/
  )
  const current = coordinator.getWorkerSnapshot('VulcanB010')
  assert.equal(current.sessionId, 'slave-session-2')
  assert.equal(current.online, true)
  assert.equal(current.platformReady, true)
}))

test('completed interval certificate survives reconnect without being overwritten', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  completeWorker(coordinator, 'VulcanB010', job)

  coordinator.markOffline('VulcanB010', 'network error after completion')
  coordinator.markConnecting('VulcanB010', 'slave-session-2')
  coordinator.markPlatformReady('VulcanB010', { position: { x: 2, y: 82, z: 1 } })
  acknowledge(coordinator, 'VulcanB010', job)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobResult.status, 'completed')
  completeWorker(coordinator, 'VulcanB001', job)
  await coordinator.waitForAllWorkersComplete('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
}))

test('public job data cannot mutate coordinator intervals or calibrated targets', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  job.assignments[0].interval.end = 127
  job.targets[0].position.y = -999
  const unchanged = coordinator.getCurrentJob({ includeTargets: true })
  assert.deepEqual(unchanged.assignments[0].interval, { start: 0, end: 63 })
  assert.equal(unchanged.targets[0].position.y, 82)
}))

test('shared resource locks serialize worker access and release after completion', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const events = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const first = coordinator.withResourceLock('VulcanB001', 'material-chest', async () => {
    events.push('master-start')
    await firstGate
    events.push('master-end')
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = coordinator.withResourceLock('VulcanB010', 'material-chest', async () => {
    events.push('slave-start')
    events.push('slave-end')
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(events, ['master-start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(events, ['master-start', 'master-end', 'slave-start', 'slave-end'])
}))

test('a resource waiter from a disconnected session cannot acquire the lock after reconnect', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  let releaseFirst
  let staleActionRan = false
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const first = coordinator.withResourceLock('VulcanB001', 'material-chest', async () => {
    await firstGate
  })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const staleWait = assert.rejects(
    coordinator.withResourceLock('VulcanB010', 'material-chest', async () => {
      staleActionRan = true
    }),
    /MULTI_SESSION_ENDED/
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  coordinator.markOffline('VulcanB010', 'network error')
  coordinator.markConnecting('VulcanB010', 'slave-session-2')
  coordinator.markPlatformReady('VulcanB010', { position: { x: 2, y: 82, z: 1 } })
  await staleWait
  releaseFirst()
  await first
  assert.equal(staleActionRan, false)
}))

test('a startup barrier timeout stays held after the missing worker recovers until master resumes', withCoordinator(async (coordinator) => {
  coordinator.markConnecting('VulcanB001', 'master-session-1')
  coordinator.markPlatformReady('VulcanB001', { position: { x: 1, y: 82, z: 1 } })
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)

  await assert.rejects(
    coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true }),
    /MULTI_BARRIER_TIMEOUT/
  )
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-barrier-timeout'), true)

  coordinator.markConnecting('VulcanB010', 'slave-session-1')
  coordinator.markPlatformReady('VulcanB010', { position: { x: 2, y: 82, z: 1 } })
  acknowledge(coordinator, 'VulcanB010', job)
  assert.equal(coordinator.getCurrentJob().status, 'held')
  coordinator.requestTeamStart('VulcanB001', 'operator reviewed timeout')
  assert.equal(coordinator.getCurrentJob().status, 'running')
}))

test('cancelling a job wakes terminal completion waits with a cancellation error', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  const waiting = assert.rejects(
    coordinator.waitForJobComplete('VulcanB010', job.jobId, job.generation, { isAlive: () => true }),
    /MULTI_JOB_CANCELLED/
  )
  coordinator.cancelCurrentJob('VulcanB001', 'operator cleanup')
  await waiting
  assert.throws(() => acknowledge(coordinator, 'VulcanB010', job), /MULTI_JOB_TERMINAL/)
}))

test('successful platform cleanup clears a cancelled generation for the next master start', withCoordinator(async (coordinator, folder) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  coordinator.cancelCurrentJob('VulcanB001', 'operator cleanup')
  assert.throws(() => coordinator.requestTeamStart('VulcanB001'), /MULTI_JOB_CANCELLED/)
  assert.equal(fs.existsSync(path.join(folder, 'job_manifest.json')), true)

  const cleared = coordinator.clearCancelledJob('VulcanB001')
  assert.deepEqual(cleared, { jobId: job.jobId, cleared: true })
  assert.equal(coordinator.getCurrentJob(), null)
  assert.equal(fs.existsSync(path.join(folder, 'job_manifest.json')), false)
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-job-cancelled'), false)
  assert.doesNotThrow(() => coordinator.requestTeamStart('VulcanB001', 'after cleanup'))
}))

test('disconnect during a resource action releases the lock immediately', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  let releaseMasterAction
  let lockAcquiredBySlave = false
  const masterActionGate = new Promise((resolve) => { releaseMasterAction = resolve })
  const masterHold = assert.rejects(
    coordinator.withResourceLock('VulcanB001', 'shared-chest', async () => {
      await masterActionGate
    }, { actionTimeoutMs: 5000 }),
    /MULTI_SESSION_ENDED/
  )
  await new Promise((resolve) => setTimeout(resolve, 30))

  const slaveWait = coordinator.withResourceLock('VulcanB010', 'shared-chest', async () => {
    lockAcquiredBySlave = true
  }, { timeoutMs: 2000 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  coordinator.markOffline('VulcanB001', 'connection dropped')
  await masterHold
  await new Promise((resolve) => setTimeout(resolve, 75))

  await slaveWait
  assert.equal(lockAcquiredBySlave, true)
  releaseMasterAction()
}))

test('completion certificates reject malformed non-number and non-integer values', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  let job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  assert.throws(() => completeWorker(coordinator, 'VulcanB001', job, { errorCount: null }), /MULTI_WORKER_FAILED/)
  coordinator.requestTeamReset('VulcanB001', 'retry test')
  coordinator.completeTeamReset('VulcanB001')
  job = coordinator.getCurrentJob({ includeTargets: true })
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  assert.throws(() => completeWorker(coordinator, 'VulcanB001', job, { errorCount: '0' }), /MULTI_WORKER_FAILED/)
  coordinator.requestTeamReset('VulcanB001', 'retry test')
  coordinator.completeTeamReset('VulcanB001')
  job = coordinator.getCurrentJob({ includeTargets: true })
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  assert.throws(() => completeWorker(coordinator, 'VulcanB001', job, { processedTargets: 2.5 }), /MULTI_WORKER_FAILED/)
}))
test('operator pause persists through disconnect and reconnect platform-ready events', withCoordinator(async (coordinator) => {
  const masterControl = runtimeControl()
  const slaveControl = runtimeControl()
  coordinator.registerRuntime('VulcanB001', masterControl)
  coordinator.registerRuntime('VulcanB010', slaveControl)
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  coordinator.requestTeamPause('VulcanB001', 'operator requested pause')
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-operator-pause'), true)

  // Disconnect and reconnect slave
  coordinator.markOffline('VulcanB010', 'network error')
  coordinator.markConnecting('VulcanB010', 'slave-session-2')
  coordinator.markPlatformReady('VulcanB010', { worldGeneration: 2, position: { x: 2, y: 82, z: 1 } })

  // Pause must still be active
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-operator-pause'), true)
  assert.equal(coordinator.getCurrentJob().status, 'held')

  // Acknowledge again does not release because pause hold remains
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  assert.equal(coordinator.getCurrentJob().status, 'held')

  // Only explicit team start releases
  coordinator.requestTeamStart('VulcanB001', 'operator resumed')
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-operator-pause'), false)
  assert.equal(coordinator.getCurrentJob().status, 'running')
}))

test('reset-everything cancellation unblocks all coordinator waiters with a terminal error', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  completeWorker(coordinator, 'VulcanB001', job)
  completeWorker(coordinator, 'VulcanB010', job)

  // Slave waits for job complete
  const slaveWait = assert.rejects(
    coordinator.waitForJobComplete('VulcanB010', job.jobId, job.generation, { isAlive: () => true }),
    /MULTI_JOB_CANCELLED/
  )

  // Cancel the job to simulate reset-everything
  coordinator.cancelCurrentJob('VulcanB001', 'reset-everything')
  await slaveWait

  // Job is terminal and cannot be acknowledged
  assert.throws(() => acknowledge(coordinator, 'VulcanB010', job), /MULTI_JOB_TERMINAL/)
}))

test('a late worker result cannot complete a cancelled job', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  completeWorker(coordinator, 'VulcanB001', job)

  coordinator.cancelCurrentJob('VulcanB001', 'operator cleanup')
  assert.throws(() => completeWorker(coordinator, 'VulcanB010', job), /MULTI_JOB_TERMINAL/)
}))

test('zero-target interval produces a valid certificate without entering unsafe code', withCoordinator(async (coordinator) => {
  // Create targets only in master interval (0-63)
  const masterOnlyTargets = [
    { row: 0, col: 0, blockName: 'white_carpet', symbol: 'white_carpet', position: { x: 10, y: 82, z: 20 } },
    { row: 0, col: 32, blockName: 'red_carpet', symbol: 'red_carpet', position: { x: 42, y: 82, z: 20 } },
  ]
  connectBoth(coordinator)
  const job = coordinator.publishJob('VulcanB001', {
    sourceType: 'nbt',
    sourceName: 'sparse.nbt',
    sourcePath: coordinator.syncFolder + '/sparse.nbt',
    sourceSha256: 'b'.repeat(64),
    targets: masterOnlyTargets
  })
  const slaveAssignment = job.assignments.find((a) => a.name === 'VulcanB010')
  assert.equal(slaveAssignment.targetCount, 0)

  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  // Slave completes with zero targets and zero errors
  const slaveWorker = coordinator.getWorkerSnapshot('VulcanB010')
  coordinator.completeWorker('VulcanB010', {
    jobId: job.jobId,
    generation: job.generation,
    sourceSha256: job.sourceSha256,
    interval: slaveAssignment.interval,
    processedTargets: 0,
    totalTargets: 0,
    errorCount: 0,
    sessionId: slaveWorker.sessionId
  })
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobResult.status, 'completed')
}))

test('slave reconnect after completing its interval preserves the valid certificate', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  completeWorker(coordinator, 'VulcanB001', job)
  completeWorker(coordinator, 'VulcanB010', job)

  // Slave disconnects and reconnects
  coordinator.markOffline('VulcanB010', 'network error')
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobResult.status, 'completed')

  coordinator.markConnecting('VulcanB010', 'slave-session-2')
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobResult.status, 'completed')

  coordinator.markPlatformReady('VulcanB010', { worldGeneration: 2, position: { x: 2, y: 82, z: 1 } })
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobResult.status, 'completed')
}))

test('a late conflicting result cannot replace an existing completion certificate', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  completeWorker(coordinator, 'VulcanB001', job)
  const certified = coordinator.getWorkerSnapshot('VulcanB001').jobResult
  const assignment = job.assignments.find((entry) => entry.name === 'VulcanB001')
  const currentSessionId = coordinator.getWorkerSnapshot('VulcanB001').sessionId

  assert.doesNotThrow(() => coordinator.completeWorker('VulcanB001', {
    jobId: job.jobId,
    generation: job.generation,
    sourceSha256: job.sourceSha256,
    interval: assignment.interval,
    processedTargets: 0,
    totalTargets: assignment.targetCount,
    errorCount: 1,
    sessionId: currentSessionId
  }))
  assert.deepEqual(coordinator.getWorkerSnapshot('VulcanB001').jobResult, certified)
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-worker-failed'), false)
}))

test('coordination barriers have no timeout unless one is explicitly configured', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-no-timeout-'))
  let clock = 1
  try {
    const coordinator = createCoordinator(folder, {
      barrierTimeoutMs: null,
      now: () => {
        clock += 3_000_000_000
        return clock
      }
    })
    connectBoth(coordinator)
    const pendingJob = coordinator.waitForJob('VulcanB010', { isAlive: () => true })
    setTimeout(() => publish(coordinator), 60)
    assert.equal((await pendingJob).sourceName, 'mapart.nbt')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('completed slave must reconnect and become platform-ready before master postprint', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  completeWorker(coordinator, 'VulcanB001', job)
  completeWorker(coordinator, 'VulcanB010', job)
  await coordinator.waitForAllWorkersComplete('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  coordinator.markOffline('VulcanB010', 'network error')
  assert.throws(
    () => coordinator.markPostPrintStarted('VulcanB001', job.jobId, job.generation),
    /MULTI_POSTPRINT_BLOCKED/
  )

  coordinator.markConnecting('VulcanB010', 'slave-session-2')
  assert.throws(
    () => coordinator.markPostPrintStarted('VulcanB001', job.jobId, job.generation),
    /MULTI_POSTPRINT_BLOCKED/
  )

  coordinator.markPlatformReady('VulcanB010', { worldGeneration: 2, position: { x: 2, y: 82, z: 1 } })
  assert.doesNotThrow(() => coordinator.markPostPrintStarted('VulcanB001', job.jobId, job.generation))
}))

test('completed workers resume interrupted postprint after platform recovery without re-acknowledging', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  completeWorker(coordinator, 'VulcanB001', job)
  completeWorker(coordinator, 'VulcanB010', job)
  await coordinator.waitForAllWorkersComplete('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  coordinator.markPostPrintStarted('VulcanB001', job.jobId, job.generation)

  coordinator.markPlatformUnavailable('VulcanB001', 'world changed')
  coordinator.markPlatformUnavailable('VulcanB010', 'world changed')
  assert.equal(coordinator.getCurrentJob().status, 'held')
  assert.equal(coordinator.getWorkerSnapshot('VulcanB001').jobAck.jobId, job.jobId)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobAck.jobId, job.jobId)

  coordinator.markPlatformReady('VulcanB001', { worldGeneration: 2, position: { x: 1, y: 82, z: 1 } })
  assert.equal(coordinator.getCurrentJob().status, 'held')
  coordinator.markPlatformReady('VulcanB010', { worldGeneration: 2, position: { x: 2, y: 82, z: 1 } })
  assert.equal(coordinator.getCurrentJob().status, 'postprint')

  coordinator.markPostPrintComplete('VulcanB001', job.jobId, job.generation)
  assert.equal(coordinator.completeJob('VulcanB001', job.jobId, job.generation).status, 'completed')
}))

test('team reset clears all worker acknowledgements and results so a new cycle is required', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  acknowledge(coordinator, 'VulcanB010', job)
  await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

  coordinator.requestTeamReset('VulcanB001', 'platform wipe')
  assert.equal(coordinator.getWorkerSnapshot('VulcanB001').jobAck, null)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobAck, null)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB001').jobResult, null)
  assert.equal(coordinator.getWorkerSnapshot('VulcanB010').jobResult, null)
  assert.equal(coordinator.getCurrentJob().resetRequested, true)

  coordinator.completeTeamReset('VulcanB001')
  assert.equal(coordinator.getCurrentJob().resetRequested, false)
  assert.equal(coordinator.getCurrentJob().status, 'preparing')

  // Re-acknowledge to release
  const resetJob = coordinator.getCurrentJob({ includeTargets: true })
  acknowledge(coordinator, 'VulcanB001', resetJob)
  acknowledge(coordinator, 'VulcanB010', resetJob)
  const released = await coordinator.waitForRelease('VulcanB001', resetJob.jobId, resetJob.generation, { isAlive: () => true })
  assert.equal(released.status, 'running')
}))

test('shared resource waiters acquire in FIFO order', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const events = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const first = coordinator.withResourceLock('VulcanB001', 'chest', async () => {
    events.push('first')
    await firstGate
  })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const second = coordinator.withResourceLock('VulcanB010', 'chest', async () => {
    events.push('second')
  })
  const third = coordinator.withResourceLock('VulcanB001', 'chest', async () => {
    events.push('third')
  })
  await new Promise((resolve) => setTimeout(resolve, 75))
  assert.deepEqual(events, ['first'])

  releaseFirst()
  await Promise.all([first, second, third])
  assert.deepEqual(events, ['first', 'second', 'third'])
}))

test('resource acquisition timeout cleans its queue without holding the team', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  let releaseOwner
  let waiterRan = false
  const ownerGate = new Promise((resolve) => { releaseOwner = resolve })
  const owner = coordinator.withResourceLock('VulcanB001', 'chest', async () => {
    await ownerGate
  }, { actionTimeoutMs: 5000 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  await assert.rejects(
    coordinator.withResourceLock('VulcanB010', 'chest', async () => { waiterRan = true }, { timeoutMs: 1000 }),
    /MULTI_RESOURCE_TIMEOUT/
  )
  assert.equal(waiterRan, false)
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-resource-timeout'), false)
  releaseOwner()
  await owner

  await coordinator.withResourceLock('VulcanB010', 'chest', async () => { waiterRan = true }, { timeoutMs: 1000 })
  assert.equal(waiterRan, true)
}))

test('resource action timeout recycles the owner session and releases the lock without a team hold', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  let releaseTimedOutAction
  let waiterRan = false
  let recycleRequested = false
  const actionGate = new Promise((resolve) => { releaseTimedOutAction = resolve })
  const owner = assert.rejects(
    coordinator.withResourceLock('VulcanB001', 'chest', async () => {
      await actionGate
    }, {
      actionTimeoutMs: 1000,
      onActionTimeout: () => {
        recycleRequested = true
        coordinator.markOffline('VulcanB001', 'resource action timeout', 'master-session-1')
      }
    }),
    /MULTI_RESOURCE_ACTION_TIMEOUT/
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  const waiter = coordinator.withResourceLock('VulcanB010', 'chest', async () => {
    waiterRan = true
  }, { timeoutMs: 3000 })

  await owner
  assert.equal(recycleRequested, true)
  assert.equal(coordinator.snapshot().holdReasons.includes('multi-resource-timeout'), false)
  await waiter
  assert.equal(waiterRan, true)
  releaseTimedOutAction()
}))

test('running job survives coordinator recreation with the same identity and fresh worker sessions', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-restart-'))
  try {
    const coordinator = createCoordinator(folder)
    connectBoth(coordinator)
    const job = publishRealSource(coordinator, folder)
    acknowledge(coordinator, 'VulcanB001', job)
    acknowledge(coordinator, 'VulcanB010', job)
    const running = await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })

    const recreated = createCoordinator(folder, { generation: 999 })
    const resumed = recreated.getCurrentJob({ includeTargets: true })
    assert.equal(recreated.resumedExistingJob, true)
    assert.equal(recreated.teamId, job.teamId)
    assert.equal(recreated.launchGeneration, job.launchGeneration)
    assert.equal(resumed.jobId, job.jobId)
    assert.equal(resumed.generation, job.generation)
    assert.deepEqual(resumed.targets, job.targets)
    assert.equal(resumed.releaseEpoch, running.releaseEpoch)
    for (const workerName of ['VulcanB001', 'VulcanB010']) {
      const worker = recreated.getWorkerSnapshot(workerName)
      assert.equal(worker.online, false)
      assert.equal(worker.platformReady, false)
      assert.equal(worker.sessionId, null)
      assert.equal(worker.jobAck, null)
      assert.equal(worker.jobResult, null)
    }

    connectBoth(recreated)
    acknowledge(recreated, 'VulcanB001', resumed)
    acknowledge(recreated, 'VulcanB010', resumed)
    const rereleased = await recreated.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
    assert.equal(rereleased.status, 'running')
    assert.equal(rereleased.jobId, job.jobId)
    assert.equal(rereleased.generation, job.generation)
    assert.equal(rereleased.releaseEpoch, running.releaseEpoch + 1)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('completed worker certificate survives restart while incomplete workers require a fresh acknowledgement', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-restart-'))
  try {
    const coordinator = createCoordinator(folder)
    connectBoth(coordinator)
    const job = publishRealSource(coordinator, folder)
    acknowledge(coordinator, 'VulcanB001', job)
    acknowledge(coordinator, 'VulcanB010', job)
    await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
    completeWorker(coordinator, 'VulcanB001', job)

    const recreated = createCoordinator(folder)
    const resumed = recreated.getCurrentJob({ includeTargets: true })
    assert.equal(recreated.getWorkerSnapshot('VulcanB001').jobResult?.status, 'completed')
    assert.equal(recreated.getWorkerSnapshot('VulcanB001').jobResult?.sessionId, null)
    assert.equal(recreated.getWorkerSnapshot('VulcanB010').jobResult, null)

    connectBoth(recreated)
    acknowledge(recreated, 'VulcanB010', resumed)
    const released = await recreated.waitForRelease('VulcanB010', job.jobId, job.generation, { isAlive: () => true })
    assert.equal(released.status, 'running')
    completeWorker(recreated, 'VulcanB010', resumed)
    await recreated.waitForAllWorkersComplete('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('post-print phase and completion certificates survive coordinator recreation', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-restart-'))
  try {
    const coordinator = createCoordinator(folder)
    connectBoth(coordinator)
    const job = publishRealSource(coordinator, folder)
    acknowledge(coordinator, 'VulcanB001', job)
    acknowledge(coordinator, 'VulcanB010', job)
    await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
    completeWorker(coordinator, 'VulcanB001', job)
    completeWorker(coordinator, 'VulcanB010', job)
    coordinator.markPostPrintStarted('VulcanB001', job.jobId, job.generation)

    const recreated = createCoordinator(folder)
    const resumed = recreated.getCurrentJob({ includeTargets: true })
    assert.equal(resumed.status, 'postprint')
    assert.ok(resumed.postPrintStartedAt)
    assert.equal(recreated.getWorkerSnapshot('VulcanB001').jobResult?.status, 'completed')
    assert.equal(recreated.getWorkerSnapshot('VulcanB010').jobResult?.status, 'completed')

    connectBoth(recreated)
    const released = await recreated.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
    assert.equal(released.status, 'postprint')
    recreated.markPostPrintComplete('VulcanB001', job.jobId, job.generation)
    assert.equal(recreated.completeJob('VulcanB001', job.jobId, job.generation).status, 'completed')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('changed source content rejects persisted restart state safely', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-restart-'))
  try {
    const coordinator = createCoordinator(folder)
    const job = publishRealSource(coordinator, folder)
    fs.writeFileSync(job.sourcePath, 'changed-after-checkpoint')

    const recreated = createCoordinator(folder)
    assert.equal(recreated.resumedExistingJob, false)
    assert.equal(recreated.getCurrentJob(), null)
    assert.equal(fs.existsSync(path.join(folder, 'job_manifest.json')), false)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('torn team state and manifest identity rejects persisted restart state safely', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-restart-'))
  try {
    const coordinator = createCoordinator(folder)
    publishRealSource(coordinator, folder)
    const statePath = path.join(folder, 'team_state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    state.currentJob.sourceSha256 = 'b'.repeat(64)
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)

    const recreated = createCoordinator(folder)
    assert.equal(recreated.resumedExistingJob, false)
    assert.equal(recreated.getCurrentJob(), null)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('roster mismatch rejects persisted restart state safely', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-restart-'))
  try {
    const coordinator = createCoordinator(folder)
    publishRealSource(coordinator, folder)
    const changedAssignments = assignments()
    changedAssignments[1] = { ...changedAssignments[1], name: 'VulcanB011' }

    const recreated = createCoordinator(folder, { assignments: changedAssignments })
    assert.equal(recreated.resumedExistingJob, false)
    assert.equal(recreated.getCurrentJob(), null)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('resumeExistingJob false discards an active manifest', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-restart-'))
  try {
    const coordinator = createCoordinator(folder)
    publishRealSource(coordinator, folder)

    const recreated = createCoordinator(folder, { resumeExistingJob: false })
    assert.equal(recreated.resumedExistingJob, false)
    assert.equal(recreated.getCurrentJob(), null)
    assert.equal(fs.existsSync(path.join(folder, 'job_manifest.json')), false)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('terminal jobs are not resumed after coordinator recreation', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-multi-restart-'))
  try {
    const coordinator = createCoordinator(folder)
    connectBoth(coordinator)
    const job = publishRealSource(coordinator, folder)
    acknowledge(coordinator, 'VulcanB001', job)
    acknowledge(coordinator, 'VulcanB010', job)
    await coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { isAlive: () => true })
    completeWorker(coordinator, 'VulcanB001', job)
    completeWorker(coordinator, 'VulcanB010', job)
    coordinator.markPostPrintStarted('VulcanB001', job.jobId, job.generation)
    coordinator.markPostPrintComplete('VulcanB001', job.jobId, job.generation)
    coordinator.completeJob('VulcanB001', job.jobId, job.generation)

    const recreated = createCoordinator(folder)
    assert.equal(recreated.resumedExistingJob, false)
    assert.equal(recreated.getCurrentJob(), null)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('generation reset rejects stale release and retirement waiters', withCoordinator(async (coordinator) => {
  connectBoth(coordinator)
  const job = publish(coordinator)
  acknowledge(coordinator, 'VulcanB001', job)
  const releaseWait = assert.rejects(
    coordinator.waitForRelease('VulcanB001', job.jobId, job.generation, { timeoutMs: 3000, isAlive: () => true }),
    /MULTI_GENERATION_MISMATCH/
  )
  const retirementWait = assert.rejects(
    coordinator.waitForJobComplete('VulcanB010', job.jobId, job.generation, { timeoutMs: 3000, isAlive: () => true }),
    /MULTI_GENERATION_MISMATCH/
  )

  await new Promise((resolve) => setTimeout(resolve, 50))
  coordinator.requestTeamReset('VulcanB001', 'new generation')
  await Promise.all([releaseWait, retirementWait])
}))

