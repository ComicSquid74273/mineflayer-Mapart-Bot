const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const TERMINAL_JOB_STATES = new Set(['completed', 'cancelled'])
const PLATFORM_HOLD_REASONS = [
  'multi-peer-offline',
  'multi-platform-barrier',
  'multi-peer-platform'
]

const FAILURE_HOLD_REASONS = [
  'multi-worker-failed',
  'multi-job-cancelled'
]

const TIMEOUT_HOLD_REASONS = [
  'multi-barrier-timeout',
  'multi-resource-timeout'
]

class MultiCoordinatorError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`)
    this.name = 'MultiCoordinatorError'
    this.code = code
    this.details = details
  }
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function toOptionalTimeoutMs(value, fallback = null) {
  if (value == null || value === false) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1000, Math.floor(parsed)) : fallback
}

function normalizeWorkerName(value) {
  return String(value || '').trim()
}

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase()
}

function canonicalPathKey(value) {
  const resolved = path.normalize(path.resolve(String(value || '').trim()))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function requireGeneration(value, action) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new MultiCoordinatorError('MULTI_INVALID_GENERATION', `${action} requires a positive integer job generation`)
  }
  return value
}

function computeWorkerIntervals(workerCount, width = 128) {
  const count = toPositiveInteger(workerCount, 1)
  const size = toPositiveInteger(width, 128)
  if (count > size) {
    throw new MultiCoordinatorError('MULTI_INVALID_ROSTER', `worker count ${count} exceeds map width ${size}`)
  }

  return Array.from({ length: count }, (_, index) => ({
    start: Math.floor(index * size / count),
    end: Math.floor((index + 1) * size / count) - 1
  }))
}

function validateMultiAssignments(assignments, width = 128) {
  if (!Array.isArray(assignments) || assignments.length < 2) {
    throw new MultiCoordinatorError('MULTI_INVALID_ROSTER', 'multi mode requires at least two enabled workers')
  }

  const size = toPositiveInteger(width, 128)
  const names = new Set()
  const runtimeFiles = new Map()
  let masterCount = 0

  for (const assignment of assignments) {
    const name = normalizeWorkerName(assignment?.name)
    const role = normalizeRole(assignment?.role)
    if (!name) throw new MultiCoordinatorError('MULTI_INVALID_ROSTER', 'every worker requires a non-empty name')
    if (role !== 'master' && role !== 'slave') {
      throw new MultiCoordinatorError('MULTI_INVALID_ROSTER', `${name} has invalid role ${role || '(empty)'}`)
    }
    if (role === 'master') masterCount += 1

    const nameKey = name.toLowerCase()
    if (names.has(nameKey)) {
      throw new MultiCoordinatorError('MULTI_INVALID_ROSTER', `duplicate worker name ${name}`)
    }
    names.add(nameKey)

    for (const [label, value] of [
      ['state file', assignment?.stateFile],
      ['progress file', assignment?.progressFile]
    ]) {
      if (!String(value || '').trim()) continue
      const key = canonicalPathKey(value)
      const previous = runtimeFiles.get(key)
      if (previous) {
        throw new MultiCoordinatorError('MULTI_INVALID_ROSTER', `${label} for ${name} collides with ${previous.label} for ${previous.name}: ${value}`)
      }
      runtimeFiles.set(key, { label, name })
    }
  }

  if (masterCount !== 1) {
    throw new MultiCoordinatorError('MULTI_INVALID_ROSTER', `multi mode requires exactly one master; found ${masterCount}`)
  }

  const sorted = assignments
    .map((assignment) => ({
      name: normalizeWorkerName(assignment.name),
      start: Number(assignment?.interval?.start),
      end: Number(assignment?.interval?.end)
    }))
    .sort((left, right) => left.start - right.start)

  let expectedStart = 0
  for (const interval of sorted) {
    if (typeof interval.start !== 'number' || typeof interval.end !== 'number' || !Number.isInteger(interval.start) || !Number.isInteger(interval.end) || interval.start !== expectedStart || interval.end < interval.start) {
      throw new MultiCoordinatorError(
        'MULTI_INVALID_INTERVALS',
        `worker intervals must cover every column exactly once; ${interval.name} has ${interval.start}-${interval.end}, expected start ${expectedStart}`
      )
    }
    expectedStart = interval.end + 1
  }
  if (expectedStart !== size) {
    throw new MultiCoordinatorError('MULTI_INVALID_INTERVALS', `worker intervals cover 0-${expectedStart - 1}, expected 0-${size - 1}`)
  }

  return true
}

function validateMultiTargets(targets, width = 128, height = 128) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new MultiCoordinatorError('MULTI_EMPTY_TARGETS', 'the master produced no printable carpet targets')
  }

  const mapWidth = toPositiveInteger(width, 128)
  const mapHeight = toPositiveInteger(height, 128)
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]
    const col = target?.col
    const row = target?.row
    if (typeof col !== 'number' || !Number.isInteger(col) || col < 0 || col >= mapWidth) {
      throw new MultiCoordinatorError('MULTI_TARGET_OUT_OF_BOUNDS', `target ${index} has column ${col}; expected 0-${mapWidth - 1}`)
    }
    if (typeof row !== 'number' || !Number.isInteger(row) || row < 0 || row >= mapHeight) {
      throw new MultiCoordinatorError('MULTI_TARGET_OUT_OF_BOUNDS', `target ${index} has row ${row}; expected 0-${mapHeight - 1}`)
    }
    if (!target?.position || typeof target.position.x !== 'number' || typeof target.position.y !== 'number' || typeof target.position.z !== 'number' || !Number.isFinite(target.position.x) || !Number.isFinite(target.position.y) || !Number.isFinite(target.position.z)) {
      throw new MultiCoordinatorError('MULTI_INVALID_TARGET', `target ${index} has an invalid world position`)
    }
    if (!String(target?.blockName || '').trim()) {
      throw new MultiCoordinatorError('MULTI_INVALID_TARGET', `target ${index} has no block name`)
    }
  }
  return true
}

function hashFileSha256(filePath) {
  const resolved = path.resolve(String(filePath || ''))
  return crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
}

function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const temporary = `${resolved}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(temporary, resolved)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(String(error?.code || ''))) throw error
    fs.rmSync(resolved, { force: true })
    fs.renameSync(temporary, resolved)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function readOptionalJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'))
  } catch {
    return null
  }
}

function cloneTarget(target) {
  return {
    row: Number(target.row),
    col: Number(target.col),
    symbol: target.symbol,
    blockName: String(target.blockName),
    position: {
      x: Number(target.position.x),
      y: Number(target.position.y),
      z: Number(target.position.z)
    }
  }
}

function sameInterval(left, right) {
  return Number(left?.start) === Number(right?.start) && Number(left?.end) === Number(right?.end)
}

function createMultiBotCoordinator(options = {}) {
  const assignments = Array.isArray(options.assignments) ? options.assignments.map((entry) => ({
    ...entry,
    name: normalizeWorkerName(entry.name),
    role: normalizeRole(entry.role),
    interval: {
      start: Number(entry?.interval?.start),
      end: Number(entry?.interval?.end)
    }
  })) : []
  const width = toPositiveInteger(options.width, 128)
  const height = toPositiveInteger(options.height, 128)
  validateMultiAssignments(assignments, width)

  const syncFolder = path.resolve(options.syncFolder || './logs/nerv-printer-sync')
  const barrierTimeoutMs = toOptionalTimeoutMs(options.barrierTimeoutMs)
  const pollMs = Math.max(25, Math.min(1000, toPositiveInteger(options.pollMs, 250)))
  const now = typeof options.now === 'function' ? options.now : Date.now
  let launchGeneration = toPositiveInteger(options.generation, now())
  let teamId = String(options.teamId || `team-${launchGeneration}-${crypto.randomBytes(5).toString('hex')}`)
  const resumeExistingJob = options.resumeExistingJob !== false
  const master = assignments.find((entry) => entry.role === 'master')
  const workers = new Map(assignments.map((assignment) => [assignment.name.toLowerCase(), {
    assignment,
    online: false,
    platformReady: false,
    sessionId: null,
    worldGeneration: null,
    position: null,
    phase: 'offline',
    lastHeartbeatAt: 0,
    jobAck: null,
    jobResult: null,
    lastCompletedJobId: null,
    control: null
  }]))
  let sequence = 0
  let currentJob = null
  const teamHolds = new Map()
  const resourceStates = new Map()

  const workerFor = (name) => {
    const worker = workers.get(normalizeWorkerName(name).toLowerCase())
    if (!worker) throw new MultiCoordinatorError('MULTI_UNKNOWN_WORKER', `unknown worker ${name}`)
    return worker
  }

  const assertMaster = (name) => {
    const worker = workerFor(name)
    if (worker.assignment.role !== 'master') {
      throw new MultiCoordinatorError('MULTI_MASTER_ONLY', `${worker.assignment.name} is not the master`)
    }
    return worker
  }

  const assertCurrentSession = (worker, sessionId, action) => {
    if (sessionId == null) return
    if (String(sessionId) !== String(worker.sessionId || '')) {
      throw new MultiCoordinatorError('MULTI_SESSION_MISMATCH', `${worker.assignment.name} ${action} came from a stale Minecraft session`)
    }
  }

  const assertCurrentJobIdentity = (jobId, generation, action) => {
    const expectedGeneration = requireGeneration(generation, action)
    if (!currentJob || String(jobId || '') !== currentJob.jobId) {
      throw new MultiCoordinatorError('MULTI_JOB_MISMATCH', `${action} references an unknown job`)
    }
    if (expectedGeneration !== currentJob.generation) {
      throw new MultiCoordinatorError('MULTI_GENERATION_MISMATCH', `${action} came from stale generation ${expectedGeneration}; current generation is ${currentJob.generation}`)
    }
    return currentJob
  }

  const manifestPath = () => path.join(syncFolder, 'job_manifest.json')
  const statePath = () => path.join(syncFolder, 'team_state.json')

  const publicJob = (job, includeTargets = false) => {
    if (!job) return null
    const copy = {
      teamId: job.teamId,
      launchGeneration: job.launchGeneration,
      jobId: job.jobId,
      generation: job.generation,
      sequence: job.sequence,
      sourceType: job.sourceType,
      sourceName: job.sourceName,
      sourcePath: job.sourcePath,
      sourceSha256: job.sourceSha256,
      targetCount: job.targetCount,
      width: job.width,
      height: job.height,
      assignments: job.assignments.map((assignment) => ({
        ...assignment,
        interval: { ...assignment.interval }
      })),
      status: job.status,
      resumeStatus: job.resumeStatus || null,
      heldReason: job.heldReason || null,
      releaseEpoch: job.releaseEpoch,
      createdAt: job.createdAt,
      releasedAt: job.releasedAt,
      postPrintStartedAt: job.postPrintStartedAt,
      postPrintCompletedAt: job.postPrintCompletedAt,
      completedAt: job.completedAt,
      resetRequested: job.resetRequested === true,
      resetReason: job.resetReason || null,
      resetRequestedAt: job.resetRequestedAt || null,
      resetCompletedAt: job.resetCompletedAt || null,
      cancelledAt: job.cancelledAt || null,
      cancelReason: job.cancelReason || null
    }
    if (includeTargets) copy.targets = job.targets.map(cloneTarget)
    return copy
  }

  const activeHoldReasons = () => [...teamHolds.keys()]

  const snapshot = () => ({
    teamId,
    launchGeneration,
    master: master.name,
    holdReason: activeHoldReasons()[0] || null,
    holdReasons: activeHoldReasons(),
    currentJob: publicJob(currentJob, false),
    workers: assignments.map((assignment) => {
      const worker = workerFor(assignment.name)
      return {
        name: assignment.name,
        role: assignment.role,
        interval: { ...assignment.interval },
        online: worker.online,
        platformReady: worker.platformReady,
        sessionId: worker.sessionId,
        worldGeneration: worker.worldGeneration,
        position: worker.position ? { ...worker.position } : null,
        phase: worker.phase,
        lastHeartbeatAt: worker.lastHeartbeatAt,
        jobAck: worker.jobAck ? { ...worker.jobAck, interval: worker.jobAck.interval ? { ...worker.jobAck.interval } : null } : null,
        jobResult: worker.jobResult ? { ...worker.jobResult, interval: worker.jobResult.interval ? { ...worker.jobResult.interval } : null } : null,
        lastCompletedJobId: worker.lastCompletedJobId
      }
    }),
    updatedAt: new Date(now()).toISOString()
  })

  const persistState = () => writeJsonAtomic(statePath(), snapshot())
  const persistManifest = () => {
    if (currentJob) writeJsonAtomic(manifestPath(), publicJob(currentJob, true))
  }
  const persist = (withManifest = false) => {
    persistState()
    if (withManifest) persistManifest()
  }

  const matchingPersistedAssignments = (persistedAssignments) => {
    if (!Array.isArray(persistedAssignments) || persistedAssignments.length !== assignments.length) return false
    const persistedByName = new Map(persistedAssignments.map((entry) => [normalizeWorkerName(entry?.name).toLowerCase(), entry]))
    return assignments.every((assignment) => {
      const persisted = persistedByName.get(assignment.name.toLowerCase())
      return persisted &&
        normalizeWorkerName(persisted.name) === assignment.name &&
        normalizeRole(persisted.role) === assignment.role &&
        sameInterval(persisted.interval, assignment.interval)
    })
  }

  const matchingPersistedWorkers = (persistedWorkers) => {
    if (!Array.isArray(persistedWorkers) || persistedWorkers.length !== assignments.length) return false
    const persistedByName = new Map(persistedWorkers.map((entry) => [normalizeWorkerName(entry?.name).toLowerCase(), entry]))
    return assignments.every((assignment) => {
      const persisted = persistedByName.get(assignment.name.toLowerCase())
      return persisted &&
        normalizeWorkerName(persisted.name) === assignment.name &&
        normalizeRole(persisted.role) === assignment.role &&
        sameInterval(persisted.interval, assignment.interval)
    })
  }

  const inferredResumeStatus = (job) => {
    if (['preparing', 'running', 'postprint', 'postprint-complete'].includes(job?.resumeStatus)) return job.resumeStatus
    if (job?.postPrintCompletedAt) return 'postprint-complete'
    if (job?.postPrintStartedAt) return 'postprint'
    if (job?.releasedAt) return 'running'
    return 'preparing'
  }

  const persistedStateJobMatchesManifest = (stateJob, manifest) => {
    if (!stateJob || stateJob.jobId !== manifest.jobId || Number(stateJob.generation) !== manifest.generation) return false
    if (stateJob.teamId !== manifest.teamId || Number(stateJob.launchGeneration) !== manifest.launchGeneration) return false
    if (String(stateJob.sourceType || '') !== String(manifest.sourceType || '')) return false
    if (String(stateJob.sourceName || '') !== String(manifest.sourceName || '')) return false
    if (canonicalPathKey(stateJob.sourcePath) !== canonicalPathKey(manifest.sourcePath)) return false
    if (String(stateJob.sourceSha256 || '').toLowerCase() !== String(manifest.sourceSha256 || '').toLowerCase()) return false
    if (Number(stateJob.targetCount) !== Number(manifest.targetCount)) return false
    if (Number(stateJob.width) !== Number(manifest.width) || Number(stateJob.height) !== Number(manifest.height)) return false
    if (String(stateJob.status || '').toLowerCase() !== String(manifest.status || '').toLowerCase()) return false
    if (Number(stateJob.releaseEpoch) !== Number(manifest.releaseEpoch)) return false
    if (!matchingPersistedAssignments(stateJob.assignments)) return false
    return assignments.every((assignment) => {
      const stateAssignment = stateJob.assignments.find((entry) => normalizeWorkerName(entry?.name) === assignment.name)
      const manifestAssignment = manifest.assignments.find((entry) => normalizeWorkerName(entry?.name) === assignment.name)
      return Number(stateAssignment?.targetCount) === Number(manifestAssignment?.targetCount)
    })
  }

  const restoreExistingJob = () => {
    const manifest = readOptionalJson(manifestPath())
    const persistedState = readOptionalJson(statePath())
    if (!manifest || !persistedState) return false
    if (TERMINAL_JOB_STATES.has(String(manifest.status || '').toLowerCase())) return false
    if (!['preparing', 'running', 'held', 'postprint', 'postprint-complete'].includes(String(manifest.status || '').toLowerCase())) return false
    if (!String(manifest.jobId || '').trim()) return false
    if (!Number.isInteger(manifest.generation) || manifest.generation <= 0) return false
    if (!Number.isInteger(manifest.launchGeneration) || manifest.launchGeneration <= 0) return false
    if (!String(manifest.teamId || '').trim() || manifest.teamId !== persistedState.teamId) return false
    if (options.teamId && String(options.teamId) !== manifest.teamId) return false
    if (Number(persistedState.launchGeneration) !== manifest.launchGeneration) return false
    if (persistedState.master !== master.name || !persistedStateJobMatchesManifest(persistedState.currentJob, manifest)) return false
    if (Number(manifest.width) !== width || Number(manifest.height) !== height) return false
    if (!matchingPersistedAssignments(manifest.assignments) || !matchingPersistedWorkers(persistedState.workers)) return false

    const targets = Array.isArray(manifest.targets) ? manifest.targets.map(cloneTarget) : []
    try {
      validateMultiTargets(targets, width, height)
    } catch {
      return false
    }
    if (Number(manifest.targetCount) !== targets.length) return false

    const sourcePath = path.resolve(String(manifest.sourcePath || ''))
    const sourceName = path.basename(String(manifest.sourceName || '').trim())
    const sourceSha256 = String(manifest.sourceSha256 || '').trim().toLowerCase()
    if (!sourceName || path.basename(sourcePath) !== sourceName || !/^[a-f0-9]{64}$/.test(sourceSha256)) return false
    if (!fs.existsSync(sourcePath)) return false
    try {
      if (hashFileSha256(sourcePath) !== sourceSha256) return false
    } catch {
      return false
    }

    const restoredAssignments = assignments.map((assignment) => {
      const persisted = manifest.assignments.find((entry) => normalizeWorkerName(entry?.name) === assignment.name)
      const targetCount = targets.filter((target) => target.col >= assignment.interval.start && target.col <= assignment.interval.end).length
      if (!persisted || Number(persisted.targetCount) !== targetCount) return null
      return {
        name: assignment.name,
        role: assignment.role,
        interval: { ...assignment.interval },
        targetCount
      }
    })
    if (restoredAssignments.some((assignment) => !assignment)) return false

    teamId = manifest.teamId
    launchGeneration = manifest.launchGeneration
    sequence = Math.max(1, Number.isInteger(manifest.sequence) ? manifest.sequence : 1)
    currentJob = {
      teamId,
      launchGeneration,
      jobId: String(manifest.jobId),
      generation: manifest.generation,
      sequence,
      sourceType: String(manifest.sourceType || 'nbt'),
      sourceName,
      sourcePath,
      sourceSha256,
      targetCount: targets.length,
      width,
      height,
      targets,
      assignments: restoredAssignments,
      status: String(manifest.status).toLowerCase(),
      resumeStatus: String(manifest.status).toLowerCase() === 'held' ? inferredResumeStatus(manifest) : (manifest.resumeStatus || null),
      heldReason: manifest.heldReason || null,
      releaseEpoch: Math.max(0, Number.isInteger(manifest.releaseEpoch) ? manifest.releaseEpoch : 0),
      createdAt: manifest.createdAt || new Date(now()).toISOString(),
      releasedAt: manifest.releasedAt || null,
      postPrintStartedAt: manifest.postPrintStartedAt || null,
      postPrintCompletedAt: manifest.postPrintCompletedAt || null,
      completedAt: null,
      resetRequested: manifest.resetRequested === true,
      resetReason: manifest.resetReason || null,
      resetRequestedAt: manifest.resetRequestedAt || null,
      resetCompletedAt: manifest.resetCompletedAt || null,
      cancelledAt: null,
      cancelReason: null
    }

    const persistedWorkers = new Map(persistedState.workers.map((entry) => [normalizeWorkerName(entry?.name).toLowerCase(), entry]))
    for (const assignment of assignments) {
      const worker = workerFor(assignment.name)
      const persistedResult = persistedWorkers.get(assignment.name.toLowerCase())?.jobResult
      const expected = restoredAssignments.find((entry) => entry.name === assignment.name)
      const validCompletedResult =
        persistedResult?.status === 'completed' &&
        persistedResult.jobId === currentJob.jobId &&
        Number(persistedResult.generation) === currentJob.generation &&
        String(persistedResult.sourceSha256 || '').toLowerCase() === currentJob.sourceSha256 &&
        sameInterval(persistedResult.interval, expected.interval) &&
        Number(persistedResult.processedTargets) === expected.targetCount &&
        Number(persistedResult.totalTargets) === expected.targetCount &&
        Number(persistedResult.errorCount) === 0
      if (validCompletedResult) {
        worker.jobResult = {
          jobId: currentJob.jobId,
          generation: currentJob.generation,
          sourceSha256: currentJob.sourceSha256,
          interval: { ...expected.interval },
          processedTargets: expected.targetCount,
          totalTargets: expected.targetCount,
          errorCount: 0,
          status: 'completed',
          sessionId: null,
          completedAt: persistedResult.completedAt || null
        }
      }
    }
    return true
  }

  const holdForTimeout = (description, reason) => {
    if (currentJob && !TERMINAL_JOB_STATES.has(currentJob.status)) {
      if (currentJob.status !== 'held') currentJob.resumeStatus = currentJob.status
      currentJob.status = 'held'
      currentJob.heldReason = `${description} timed out`
    }
    setTeamHold(reason)
    persist(Boolean(currentJob))
  }

  const setTeamHold = (reason, holdOptions = {}) => {
    const normalizedReason = String(reason || 'multi-team-hold')
    const excludedWorkers = new Set((holdOptions.excludedWorkers || [])
      .map((name) => normalizeWorkerName(name).toLowerCase())
      .filter(Boolean))
    teamHolds.set(normalizedReason, { excludedWorkers })
    for (const worker of workers.values()) {
      if (excludedWorkers.has(worker.assignment.name.toLowerCase())) {
        worker.control?.releaseHold?.(normalizedReason)
      } else {
        worker.control?.requestHold?.(normalizedReason)
      }
    }
  }

  const clearTeamHold = (reason) => {
    const normalizedReason = String(reason || 'multi-team-hold')
    if (!teamHolds.delete(normalizedReason)) return false
    for (const worker of workers.values()) worker.control?.releaseHold?.(normalizedReason)
    return true
  }

  const clearTeamHolds = (reasons) => {
    for (const reason of reasons) clearTeamHold(reason)
  }

  const allWorkersPlatformReady = () => assignments.every((assignment) => {
    const worker = workerFor(assignment.name)
    return worker.online && worker.platformReady
  })

  const refreshPlatformHold = (preferredReason = 'multi-platform-barrier') => {
    const unavailableWorkers = assignments
      .map((assignment) => workerFor(assignment.name))
      .filter((worker) => !worker.online || !worker.platformReady)
    clearTeamHolds(PLATFORM_HOLD_REASONS)
    if (!unavailableWorkers.length) return true
    const reason = unavailableWorkers.some((worker) => !worker.online)
      ? 'multi-peer-offline'
      : preferredReason
    setTeamHold(reason, {
      excludedWorkers: unavailableWorkers.map((worker) => worker.assignment.name)
    })
    return false
  }

  const allWorkersAcknowledged = (jobId) => assignments.every((assignment) => {
    const worker = workerFor(assignment.name)
    const acknowledgedInCurrentSession = worker.jobAck?.jobId === jobId && worker.jobAck?.sessionId === worker.sessionId
    const alreadyCompletedJob = worker.jobResult?.jobId === jobId && worker.jobResult.status === 'completed'
    return worker.online && worker.platformReady && (acknowledgedInCurrentSession || alreadyCompletedJob)
  })

  const maybeReleaseJob = () => {
    if (!currentJob || TERMINAL_JOB_STATES.has(currentJob.status)) return false
    if (teamHolds.size > 0) return false
    if (!allWorkersAcknowledged(currentJob.jobId)) return false
    if (!allWorkersPlatformReady()) return false
    const releaseStatus = ['postprint', 'postprint-complete'].includes(currentJob.resumeStatus)
      ? currentJob.resumeStatus
      : (['postprint', 'postprint-complete'].includes(currentJob.status) ? currentJob.status : 'running')
    if (currentJob.status !== releaseStatus || currentJob.releasedAt == null) {
      currentJob.status = releaseStatus
      currentJob.resumeStatus = null
      currentJob.releaseEpoch += 1
      currentJob.releasedAt = new Date(now()).toISOString()
      persist(true)
    }
    return true
  }

  const waitFor = async (predicate, waitOptions = {}) => {
    const startedAt = now()
    const timeoutMs = waitOptions.timeoutMs === false
      ? null
      : toOptionalTimeoutMs(waitOptions.timeoutMs, barrierTimeoutMs)
    const timeoutCode = String(waitOptions.timeoutCode || 'MULTI_BARRIER_TIMEOUT')
    const timeoutHoldReason = waitOptions.timeoutHoldReason === false
      ? null
      : String(waitOptions.timeoutHoldReason || 'multi-barrier-timeout')
    while (true) {
      if (typeof waitOptions.isAlive === 'function' && !waitOptions.isAlive()) {
        throw new MultiCoordinatorError('MULTI_SESSION_ENDED', `${waitOptions.description || 'coordination wait'} ended because the worker session disconnected`)
      }
      const result = predicate()
      if (result) return result
      if (timeoutMs != null && now() - startedAt >= timeoutMs) {
        if (timeoutHoldReason) {
          holdForTimeout(waitOptions.description || 'coordination barrier', timeoutHoldReason)
        } else {
          persistState()
        }
        throw new MultiCoordinatorError(timeoutCode, `${waitOptions.description || 'coordination barrier'} exceeded ${timeoutMs}ms`, {
          timeoutMs,
          snapshot: snapshot()
        })
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  const api = {
    teamId,
    launchGeneration,
    width,
    height,
    masterName: master.name,
    assignments: assignments.map((assignment) => ({ ...assignment, interval: { ...assignment.interval } })),
    syncFolder,
    manifestPath: manifestPath(),
    statePath: statePath(),
    resumedExistingJob: false,

    snapshot,

    registerRuntime(name, control) {
      const worker = workerFor(name)
      worker.control = control || null
      for (const [reason, hold] of teamHolds) {
        if (!hold.excludedWorkers.has(worker.assignment.name.toLowerCase())) {
          worker.control?.requestHold?.(reason)
        }
      }
      persistState()
    },

    unregisterRuntime(name, control = null) {
      const worker = workerFor(name)
      if (!control || worker.control === control) worker.control = null
      persistState()
    },

    markConnecting(name, sessionId) {
      const worker = workerFor(name)
      worker.online = true
      worker.platformReady = false
      worker.sessionId = String(sessionId || `${name}-${now()}`)
      worker.worldGeneration = null
      worker.position = null
      worker.phase = 'connecting'
      worker.lastHeartbeatAt = now()
      worker.jobAck = null
      if (worker.jobResult?.status !== 'completed') worker.jobResult = null
      if (currentJob && !TERMINAL_JOB_STATES.has(currentJob.status)) {
        if (currentJob.status !== 'held') currentJob.resumeStatus = currentJob.status
        currentJob.status = 'held'
        currentJob.heldReason = `${worker.assignment.name}: connecting`
      }
      refreshPlatformHold('multi-platform-barrier')
      persist(Boolean(currentJob))
      return snapshot()
    },

    markPlatformReady(name, details = {}) {
      const worker = workerFor(name)
      assertCurrentSession(worker, details.sessionId, 'platform-ready update')
      if (!worker.online) throw new MultiCoordinatorError('MULTI_WORKER_OFFLINE', `${worker.assignment.name} cannot become ready while offline`)
      worker.platformReady = true
      worker.phase = 'platform-ready'
      worker.worldGeneration = Number.isFinite(Number(details.worldGeneration)) ? Number(details.worldGeneration) : null
      worker.position = details.position && typeof details.position === 'object'
        ? { x: Number(details.position.x), y: Number(details.position.y), z: Number(details.position.z) }
        : null
      worker.lastHeartbeatAt = now()
      refreshPlatformHold('multi-platform-barrier')
      maybeReleaseJob()
      persist(Boolean(currentJob))
      return snapshot()
    },

    markPlatformUnavailable(name, reason = 'off-platform', sessionId = null) {
      const worker = workerFor(name)
      assertCurrentSession(worker, sessionId, 'platform-unavailable update')
      if (!worker.online) return snapshot()
      worker.platformReady = false
      worker.phase = 'platform-recovery'
      worker.lastHeartbeatAt = now()
      if (currentJob && !TERMINAL_JOB_STATES.has(currentJob.status)) {
        if (currentJob.status !== 'held') currentJob.resumeStatus = currentJob.status
        currentJob.status = 'held'
        currentJob.heldReason = `${worker.assignment.name}: ${reason}`
      }
      refreshPlatformHold('multi-peer-platform')
      persist(Boolean(currentJob))
      return snapshot()
    },

    markOffline(name, reason = 'disconnected', sessionId = null) {
      const worker = workerFor(name)
      assertCurrentSession(worker, sessionId, 'offline update')
      worker.online = false
      worker.platformReady = false
      worker.phase = 'offline'
      worker.position = null
      worker.jobAck = null
      if (worker.jobResult?.status !== 'completed') worker.jobResult = null
      worker.lastHeartbeatAt = now()
      if (currentJob && !TERMINAL_JOB_STATES.has(currentJob.status)) {
        if (currentJob.status !== 'held') currentJob.resumeStatus = currentJob.status
        currentJob.status = 'held'
        currentJob.heldReason = `${worker.assignment.name}: ${reason}`
      }
      refreshPlatformHold('multi-peer-offline')
      persist(Boolean(currentJob))
      return snapshot()
    },

    heartbeat(name, phase = null, sessionId = null) {
      const worker = workerFor(name)
      assertCurrentSession(worker, sessionId, 'heartbeat')
      if (!worker.online) throw new MultiCoordinatorError('MULTI_WORKER_OFFLINE', `${worker.assignment.name} cannot heartbeat while offline`)
      worker.lastHeartbeatAt = now()
      if (phase) worker.phase = String(phase)
      persistState()
      return this.getWorkerSnapshot(name)
    },

    getWorkerSnapshot(name) {
      const worker = workerFor(name)
      return snapshot().workers.find((entry) => entry.name === worker.assignment.name)
    },

    publishJob(name, jobInput = {}) {
      assertMaster(name)
      const targets = Array.isArray(jobInput.targets) ? jobInput.targets.map(cloneTarget) : []
      validateMultiTargets(targets, width, height)
      const sourceSha256 = String(jobInput.sourceSha256 || '').trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
        throw new MultiCoordinatorError('MULTI_INVALID_SOURCE_HASH', 'master job requires a SHA-256 source hash')
      }
      const sourceName = path.basename(String(jobInput.sourceName || jobInput.sourcePath || '').trim())
      if (!sourceName) throw new MultiCoordinatorError('MULTI_INVALID_JOB', 'master job requires a source name')

      if (currentJob && !TERMINAL_JOB_STATES.has(currentJob.status)) {
        if (currentJob.sourceSha256 !== sourceSha256 || currentJob.sourceName !== sourceName) {
          throw new MultiCoordinatorError('MULTI_JOB_CONFLICT', `active job ${currentJob.sourceName} must finish before ${sourceName}`)
        }
        return publicJob(currentJob, true)
      }

      clearTeamHolds([...FAILURE_HOLD_REASONS, ...TIMEOUT_HOLD_REASONS, 'multi-reset'])
      sequence += 1
      const generation = Math.max(now(), (currentJob?.generation || 0) + 1)
      const createdAt = new Date(now()).toISOString()
      const jobId = `job-${generation}-${sourceSha256.slice(0, 16)}`
      const jobAssignments = assignments.map((assignment) => {
        const targetCount = targets.filter((target) => target.col >= assignment.interval.start && target.col <= assignment.interval.end).length
        return {
          name: assignment.name,
          role: assignment.role,
          interval: { ...assignment.interval },
          targetCount
        }
      })

      currentJob = {
        teamId,
        launchGeneration,
        jobId,
        generation,
        sequence,
        sourceType: String(jobInput.sourceType || 'nbt'),
        sourceName,
        sourcePath: path.resolve(String(jobInput.sourcePath || sourceName)),
        sourceSha256,
        targetCount: targets.length,
        width,
        height,
        targets,
        assignments: jobAssignments,
        status: 'preparing',
        releaseEpoch: 0,
        createdAt,
        releasedAt: null,
        postPrintStartedAt: null,
        postPrintCompletedAt: null,
        completedAt: null,
        resetRequested: false,
        resetReason: null
      }
      for (const worker of workers.values()) {
        worker.jobAck = null
        worker.jobResult = null
      }
      persist(true)
      return publicJob(currentJob, true)
    },

    getCurrentJob(options = {}) {
      if (!currentJob) return null
      return publicJob(currentJob, options.includeTargets === true)
    },

    async waitForJob(name, waitOptions = {}) {
      const worker = workerFor(name)
      const expectedSessionId = worker.sessionId
      const callerIsAlive = typeof waitOptions.isAlive === 'function' ? waitOptions.isAlive : null
      return await waitFor(() => {
        if (!currentJob || TERMINAL_JOB_STATES.has(currentJob.status)) return null
        return publicJob(currentJob, true)
      }, {
        ...waitOptions,
        description: waitOptions.description || `${worker.assignment.name} waiting for master job manifest`,
        holdJobOnTimeout: false,
        timeoutHoldReason: false,
        isAlive: () => {
          if (expectedSessionId && (!worker.online || worker.sessionId !== expectedSessionId)) return false
          return callerIsAlive ? callerIsAlive() : true
        }
      })
    },

    acknowledgeJob(name, acknowledgement = {}) {
      const worker = workerFor(name)
      if (!currentJob) throw new MultiCoordinatorError('MULTI_NO_ACTIVE_JOB', 'no active master job exists')
      if (TERMINAL_JOB_STATES.has(currentJob.status)) {
        throw new MultiCoordinatorError('MULTI_JOB_TERMINAL', `${worker.assignment.name} cannot acknowledge terminal job ${currentJob.jobId}`)
      }
      if (!worker.online) {
        throw new MultiCoordinatorError('MULTI_WORKER_OFFLINE', `${worker.assignment.name} cannot acknowledge while offline`)
      }
      if (String(acknowledgement.sessionId || '') !== worker.sessionId) {
        throw new MultiCoordinatorError('MULTI_SESSION_MISMATCH', `${worker.assignment.name} acknowledged from a stale Minecraft session`)
      }
      if (String(acknowledgement.jobId || '') !== currentJob.jobId) {
        throw new MultiCoordinatorError('MULTI_JOB_MISMATCH', `${worker.assignment.name} acknowledged the wrong job`)
      }
      assertCurrentJobIdentity(acknowledgement.jobId, acknowledgement.generation, `${worker.assignment.name} acknowledgement`)
      if (String(acknowledgement.sourceSha256 || '').toLowerCase() !== currentJob.sourceSha256) {
        throw new MultiCoordinatorError('MULTI_SOURCE_MISMATCH', `${worker.assignment.name} source hash does not match the master manifest`)
      }
      const expected = currentJob.assignments.find((entry) => entry.name === worker.assignment.name)
      if (!expected || !sameInterval(acknowledgement.interval, expected.interval)) {
        throw new MultiCoordinatorError('MULTI_INTERVAL_MISMATCH', `${worker.assignment.name} acknowledged an unexpected interval`)
      }
      worker.jobAck = {
        jobId: currentJob.jobId,
        generation: currentJob.generation,
        sourceSha256: currentJob.sourceSha256,
        interval: { ...expected.interval },
        targetCount: expected.targetCount,
        sessionId: worker.sessionId,
        acknowledgedAt: new Date(now()).toISOString()
      }
      worker.phase = worker.platformReady ? 'job-ready' : 'platform-recovery'
      maybeReleaseJob()
      persist(true)
      return this.getWorkerSnapshot(name)
    },

    async waitForRelease(name, jobId, generation, waitOptions = {}) {
      const worker = workerFor(name)
      requireGeneration(generation, `${worker.assignment.name} release wait`)
      return await waitFor(() => {
        assertCurrentJobIdentity(jobId, generation, `${worker.assignment.name} release wait`)
        if (currentJob.status === 'cancelled') {
          throw new MultiCoordinatorError('MULTI_JOB_CANCELLED', `job ${jobId} was cancelled`)
        }
        maybeReleaseJob()
        return ['running', 'postprint', 'postprint-complete'].includes(currentJob.status)
          ? publicJob(currentJob, true)
          : null
      }, {
        ...waitOptions,
        description: waitOptions.description || `${worker.assignment.name} waiting for every worker to be platform-ready`
      })
    },

    completeWorker(name, result = {}) {
      const worker = workerFor(name)
      assertCurrentJobIdentity(result.jobId, result.generation, `${worker.assignment.name} completion`)
      if (TERMINAL_JOB_STATES.has(currentJob.status)) {
        throw new MultiCoordinatorError('MULTI_JOB_TERMINAL', `${worker.assignment.name} cannot update terminal job ${currentJob.jobId}`)
      }
      if (!worker.online || String(result.sessionId || '') !== worker.sessionId) {
        throw new MultiCoordinatorError('MULTI_SESSION_MISMATCH', `${worker.assignment.name} completed from a stale Minecraft session`)
      }
      if (worker.jobAck?.jobId !== currentJob.jobId || worker.jobAck?.sessionId !== worker.sessionId) {
        throw new MultiCoordinatorError('MULTI_JOB_NOT_ACKNOWLEDGED', `${worker.assignment.name} did not acknowledge this job in its current Minecraft session`)
      }
      const expected = currentJob.assignments.find((entry) => entry.name === worker.assignment.name)
      const previousResult = worker.jobResult
      if (previousResult?.jobId === currentJob.jobId && previousResult.status === 'completed') {
        return this.getWorkerSnapshot(name)
      }

      const processedTargets = result?.processedTargets
      const totalTargets = result?.totalTargets
      const errorCount = result?.errorCount
      const valid =
        String(result?.sourceSha256 || '').toLowerCase() === currentJob.sourceSha256 &&
        sameInterval(result?.interval, expected?.interval) &&
        typeof processedTargets === 'number' && Number.isInteger(processedTargets) && processedTargets >= 0 &&
        typeof totalTargets === 'number' && Number.isInteger(totalTargets) && totalTargets >= 0 &&
        typeof errorCount === 'number' && Number.isInteger(errorCount) && errorCount >= 0 &&
        totalTargets === expected?.targetCount &&
        processedTargets === totalTargets &&
        errorCount === 0

      worker.jobResult = {
        jobId: currentJob.jobId,
        generation: currentJob.generation,
        sourceSha256: String(result.sourceSha256 || '').toLowerCase(),
        interval: result.interval ? { start: Number(result.interval.start), end: Number(result.interval.end) } : null,
        processedTargets,
        totalTargets,
        errorCount,
        status: valid ? 'completed' : 'failed',
        sessionId: worker.sessionId,
        completedAt: new Date(now()).toISOString()
      }
      worker.phase = valid ? 'print-complete' : 'repair-blocked'
      if (!valid) {
        if (currentJob.status !== 'held') currentJob.resumeStatus = currentJob.status
        currentJob.status = 'held'
        currentJob.heldReason = `${worker.assignment.name} did not complete its assigned interval cleanly`
        setTeamHold('multi-worker-failed')
        persist(true)
        throw new MultiCoordinatorError('MULTI_WORKER_FAILED', currentJob.heldReason, { result: worker.jobResult, expected })
      }
      persist(true)
      return this.getWorkerSnapshot(name)
    },

    async waitForAllWorkersComplete(name, jobId, generation, waitOptions = {}) {
      assertMaster(name)
      requireGeneration(generation, 'master completion wait')
      return await waitFor(() => {
        assertCurrentJobIdentity(jobId, generation, 'master completion wait')
        if (currentJob.status === 'cancelled') {
          throw new MultiCoordinatorError('MULTI_JOB_CANCELLED', `job ${jobId} was cancelled`)
        }
        const failed = assignments
          .map((assignment) => workerFor(assignment.name))
          .find((worker) => worker.jobResult?.jobId === jobId && worker.jobResult.status === 'failed')
        if (failed) {
          throw new MultiCoordinatorError('MULTI_WORKER_FAILED', `${failed.assignment.name} reported an incomplete interval`)
        }
        const done = assignments.every((assignment) => {
          const worker = workerFor(assignment.name)
          return worker.jobResult?.jobId === jobId &&
            worker.jobResult.status === 'completed'
        })
        return done ? snapshot() : null
      }, {
        ...waitOptions,
        description: waitOptions.description || `master waiting for every interval of ${jobId}`
      })
    },

    markPostPrintStarted(name, jobId, generation) {
      assertMaster(name)
      assertCurrentJobIdentity(jobId, generation, 'master postprint start')
      const allComplete = assignments.every((assignment) => workerFor(assignment.name).jobResult?.status === 'completed')
      if (!allComplete) throw new MultiCoordinatorError('MULTI_POSTPRINT_BLOCKED', 'postprint cannot start before every assigned interval completes')
      if (teamHolds.size > 0 || !allWorkersPlatformReady()) {
        throw new MultiCoordinatorError('MULTI_POSTPRINT_BLOCKED', `postprint cannot start while the team is held: ${activeHoldReasons().join(', ') || 'platform-not-ready'}`)
      }
      currentJob.status = 'postprint'
      currentJob.postPrintStartedAt = currentJob.postPrintStartedAt || new Date(now()).toISOString()
      persist(true)
    },

    markPostPrintComplete(name, jobId, generation) {
      assertMaster(name)
      assertCurrentJobIdentity(jobId, generation, 'master postprint completion')
      if (currentJob.status !== 'postprint') {
        throw new MultiCoordinatorError('MULTI_POSTPRINT_BLOCKED', `job ${jobId} is not in master postprint`)
      }
      if (teamHolds.size > 0 || !allWorkersPlatformReady()) {
        throw new MultiCoordinatorError('MULTI_POSTPRINT_BLOCKED', `postprint cannot complete while the team is held: ${activeHoldReasons().join(', ') || 'platform-not-ready'}`)
      }
      currentJob.status = 'postprint-complete'
      currentJob.postPrintCompletedAt = new Date(now()).toISOString()
      persist(true)
    },

    completeJob(name, jobId, generation) {
      assertMaster(name)
      assertCurrentJobIdentity(jobId, generation, 'master job completion')
      if (currentJob.status !== 'postprint-complete') {
        throw new MultiCoordinatorError('MULTI_COMPLETION_BLOCKED', `job ${jobId} cannot complete before master postprint succeeds`)
      }
      currentJob.status = 'completed'
      currentJob.completedAt = new Date(now()).toISOString()
      for (const worker of workers.values()) {
        worker.lastCompletedJobId = jobId
        worker.phase = 'job-complete'
      }
      persist(true)
      return publicJob(currentJob, false)
    },

    async waitForJobComplete(name, jobId, generation, waitOptions = {}) {
      const worker = workerFor(name)
      requireGeneration(generation, `${worker.assignment.name} retirement wait`)
      const result = await waitFor(() => {
        assertCurrentJobIdentity(jobId, generation, `${worker.assignment.name} retirement wait`)
        if (currentJob.status === 'cancelled') {
          throw new MultiCoordinatorError('MULTI_JOB_CANCELLED', `job ${jobId} was cancelled`)
        }
        return currentJob.status === 'completed' ? publicJob(currentJob, false) : null
      }, {
        ...waitOptions,
        description: waitOptions.description || `${worker.assignment.name} waiting for master postprint and job retirement`
      })
      worker.lastCompletedJobId = jobId
      persistState()
      return result
    },

    requestTeamPause(name, reason = 'multi-team-pause') {
      assertMaster(name)
      if (currentJob && !TERMINAL_JOB_STATES.has(currentJob.status)) {
        if (currentJob.status !== 'held') currentJob.resumeStatus = currentJob.status
        currentJob.status = 'held'
        currentJob.heldReason = String(reason || 'multi-team-pause')
      }
      setTeamHold('multi-operator-pause')
      for (const worker of workers.values()) worker.control?.requestStop?.(`coordinator:${reason}`)
      persist(Boolean(currentJob))
    },

    requestTeamStart(name, reason = 'multi-team-start') {
      assertMaster(name)
      if (currentJob?.resetRequested === true) {
        throw new MultiCoordinatorError('MULTI_RESET_PENDING', 'the master must finish the physical platform reset before restarting the team')
      }
      if (currentJob?.status === 'cancelled') {
        throw new MultiCoordinatorError('MULTI_JOB_CANCELLED', `job ${currentJob.jobId} was cancelled`)
      }
      if (teamHolds.has('multi-worker-failed')) {
        throw new MultiCoordinatorError('MULTI_RESET_REQUIRED', 'a worker interval failed; reset the current job before restarting the team')
      }
      clearTeamHolds(['multi-operator-pause', ...TIMEOUT_HOLD_REASONS])
      for (const worker of workers.values()) {
        worker.control?.requestStart?.(`coordinator:${reason}`)
      }
      maybeReleaseJob()
      persist(Boolean(currentJob))
    },

    requestTeamReset(name, reason = 'multi-reset') {
      assertMaster(name)
      if (!currentJob || TERMINAL_JOB_STATES.has(currentJob.status)) {
        throw new MultiCoordinatorError('MULTI_NO_ACTIVE_JOB', 'no active job exists to reset')
      }
      clearTeamHolds(['multi-operator-pause', ...TIMEOUT_HOLD_REASONS, ...FAILURE_HOLD_REASONS])
      currentJob.resumeStatus = 'preparing'
      currentJob.status = 'held'
      currentJob.resetRequested = true
      currentJob.resetReason = String(reason)
      currentJob.resetRequestedAt = new Date(now()).toISOString()
      currentJob.generation = Math.max(now(), currentJob.generation + 1)
      currentJob.releasedAt = null
      for (const worker of workers.values()) {
        worker.jobAck = null
        worker.jobResult = null
        worker.phase = worker.assignment.role === 'master' ? 'reset-master' : 'reset-held'
      }
      setTeamHold('multi-reset', { excludedWorkers: [master.name] })
      persist(true)
      return publicJob(currentJob, false)
    },

    completeTeamReset(name) {
      assertMaster(name)
      if (!currentJob || currentJob.resetRequested !== true) {
        throw new MultiCoordinatorError('MULTI_RESET_NOT_PENDING', 'no team reset is pending')
      }
      currentJob.status = 'preparing'
      currentJob.resumeStatus = null
      currentJob.resetRequested = false
      currentJob.resetCompletedAt = new Date(now()).toISOString()
      for (const worker of workers.values()) {
        worker.jobAck = null
        worker.jobResult = null
        worker.phase = worker.platformReady ? 'platform-ready' : worker.phase
      }
      clearTeamHold('multi-reset')
      refreshPlatformHold('multi-platform-barrier')
      for (const worker of workers.values()) worker.control?.requestStart?.('coordinator:multi-reset-complete')
      maybeReleaseJob()
      persist(true)
      return publicJob(currentJob, false)
    },

    async withResourceLock(name, resourceName, action, waitOptions = {}) {
      const worker = workerFor(name)
      const resource = String(resourceName || '').trim().toLowerCase()
      if (!resource) throw new MultiCoordinatorError('MULTI_INVALID_RESOURCE', 'resource lock requires a name')
      if (typeof action !== 'function') throw new MultiCoordinatorError('MULTI_INVALID_RESOURCE', 'resource lock requires an action')
      const expectedSessionId = worker.sessionId
      if (!worker.online || !expectedSessionId) {
        throw new MultiCoordinatorError('MULTI_SESSION_ENDED', `${worker.assignment.name} cannot acquire ${resource} without a live session`)
      }
      const callerIsAlive = typeof waitOptions.isAlive === 'function' ? waitOptions.isAlive : null
      const state = resourceStates.get(resource) || { owner: null, queue: [] }
      resourceStates.set(resource, state)
      const ticket = {
        id: crypto.randomBytes(12).toString('hex'),
        owner: worker.assignment.name,
        sessionId: expectedSessionId
      }
      state.queue.push(ticket)
      try {
        await waitFor(() => {
          if (state.owner || state.queue[0] !== ticket) return null
          state.queue.shift()
          state.owner = {
            token: ticket.id,
            owner: ticket.owner,
            sessionId: ticket.sessionId,
            acquiredAt: new Date(now()).toISOString()
          }
          return true
        }, {
          ...waitOptions,
          timeoutMs: waitOptions.timeoutMs === undefined ? false : waitOptions.timeoutMs,
          description: waitOptions.description || `${worker.assignment.name} waiting for shared ${resource}`,
          timeoutCode: 'MULTI_RESOURCE_TIMEOUT',
          timeoutHoldReason: false,
          isAlive: () => {
            if (!worker.online || worker.sessionId !== expectedSessionId) return false
            return callerIsAlive ? callerIsAlive() : true
          }
        })
      } catch (error) {
        const queuedIndex = state.queue.indexOf(ticket)
        if (queuedIndex >= 0) state.queue.splice(queuedIndex, 1)
        if (!state.owner && state.queue.length === 0) resourceStates.delete(resource)
        throw error
      }

      const release = () => {
        if (state.owner?.token === ticket.id) state.owner = null
        if (!state.owner && state.queue.length === 0) resourceStates.delete(resource)
      }
      const actionTimeoutMs = Math.max(1000, toPositiveInteger(waitOptions.actionTimeoutMs, waitOptions.timeoutMs || 15 * 60 * 1000))
      return await new Promise((resolve, reject) => {
        let boundarySettled = false
        let timeoutTimer = null
        let sessionTimer = null
        let recoveryTimer = null
        let actionTimeoutError = null
        const settle = (handler, value) => {
          if (boundarySettled) return
          boundarySettled = true
          clearTimeout(timeoutTimer)
          clearTimeout(recoveryTimer)
          clearInterval(sessionTimer)
          release()
          handler(value)
        }
        const actionPromise = Promise.resolve().then(action)
        timeoutTimer = setTimeout(() => {
          actionTimeoutError = new MultiCoordinatorError('MULTI_RESOURCE_ACTION_TIMEOUT', `${worker.assignment.name} shared ${resource} action exceeded ${actionTimeoutMs}ms`, {
            timeoutMs: actionTimeoutMs,
            resource,
            worker: worker.assignment.name,
            sessionId: expectedSessionId
          })
          if (typeof waitOptions.onActionTimeout !== 'function') {
            settle(reject, actionTimeoutError)
            return
          }
          try {
            Promise.resolve(waitOptions.onActionTimeout(actionTimeoutError)).catch(() => {})
          } catch { }
          if (!worker.online || worker.sessionId !== expectedSessionId || (callerIsAlive && !callerIsAlive())) {
            settle(reject, actionTimeoutError)
            return
          }
          const recoveryTimeoutMs = Math.max(1000, toPositiveInteger(waitOptions.actionTimeoutRecoveryMs, 30000))
          recoveryTimer = setTimeout(() => settle(reject, actionTimeoutError), recoveryTimeoutMs)
        }, actionTimeoutMs)
        sessionTimer = setInterval(() => {
          if (worker.online && worker.sessionId === expectedSessionId && (!callerIsAlive || callerIsAlive())) return
          settle(reject, actionTimeoutError || new MultiCoordinatorError('MULTI_SESSION_ENDED', `${worker.assignment.name} shared ${resource} action outlived its Minecraft session`))
        }, pollMs)
        actionPromise.then(
          (value) => {
            if (actionTimeoutError) return
            release()
            settle(resolve, value)
          },
          (error) => {
            if (actionTimeoutError) return
            release()
            settle(reject, error)
          }
        )
      })
    },

    cancelCurrentJob(name, reason = 'cancelled') {
      assertMaster(name)
      if (!currentJob || TERMINAL_JOB_STATES.has(currentJob.status)) return null
      currentJob.status = 'cancelled'
      currentJob.resumeStatus = null
      currentJob.cancelledAt = new Date(now()).toISOString()
      currentJob.cancelReason = String(reason)
      setTeamHold('multi-job-cancelled')
      persist(true)
      return publicJob(currentJob, false)
    },

    clearCancelledJob(name) {
      assertMaster(name)
      if (!currentJob || currentJob.status !== 'cancelled') {
        throw new MultiCoordinatorError('MULTI_JOB_NOT_CANCELLED', 'only a cancelled job can be cleared after platform cleanup')
      }
      const cancelledJobId = currentJob.jobId
      currentJob = null
      for (const worker of workers.values()) {
        worker.jobAck = null
        worker.jobResult = null
        worker.phase = worker.platformReady ? 'platform-ready' : worker.phase
      }
      clearTeamHolds(['multi-job-cancelled', ...TIMEOUT_HOLD_REASONS])
      refreshPlatformHold('multi-platform-barrier')
      fs.rmSync(manifestPath(), { force: true })
      persistState()
      return { jobId: cancelledJobId, cleared: true }
    }
  }

  fs.mkdirSync(syncFolder, { recursive: true })
  api.resumedExistingJob = resumeExistingJob && restoreExistingJob()
  api.teamId = teamId
  api.launchGeneration = launchGeneration
  if (!api.resumedExistingJob) fs.rmSync(manifestPath(), { force: true })
  persist(api.resumedExistingJob)
  return api
}

module.exports = {
  MultiCoordinatorError,
  computeWorkerIntervals,
  createMultiBotCoordinator,
  hashFileSha256,
  validateMultiAssignments,
  validateMultiTargets,
  writeJsonAtomic
}
