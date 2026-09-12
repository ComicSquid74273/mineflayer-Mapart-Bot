'use strict'

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

class PostPrintDeadlineExceededError extends Error {
  constructor(step, timeoutMs, meta = {}) {
    const normalizedStep = String(step || 'unknown')
    const normalizedTimeoutMs = Math.max(0, finiteNumber(timeoutMs) ?? 0)
    super(
      `Post-print workflow exceeded its ${Math.round(normalizedTimeoutMs / 1000)}s hard limit ` +
      `at step=${normalizedStep}; preserving the live session and checkpoint without retrying.`
    )
    this.name = 'PostPrintDeadlineExceededError'
    this.code = 'POST_PRINT_DEADLINE_EXCEEDED'
    this.step = normalizedStep
    this.timeoutMs = normalizedTimeoutMs
    this.postPrintCartographyComplete = meta.postPrintCartographyComplete === true
    this.postPrintSourceMapId = Number.isFinite(Number(meta.postPrintSourceMapId))
      ? Number(meta.postPrintSourceMapId)
      : null
  }
}

function createPostPrintDeadline(config, startedAt = Date.now()) {
  const advanced = config?.advanced || {}
  const enabled = advanced.postPrintWorkflowTimeoutEnabled !== false
  const timeoutMs = Math.max(
    60000,
    finiteNumber(advanced.postPrintWorkflowTimeoutMs) ?? 600000
  )
  const normalizedStartedAt = finiteNumber(startedAt) ?? Date.now()
  return {
    enabled,
    startedAt: normalizedStartedAt,
    timeoutMs,
    deadlineAt: enabled ? normalizedStartedAt + timeoutMs : Number.POSITIVE_INFINITY
  }
}

function assertPostPrintDeadline(deadline, step, meta = {}, now = Date.now()) {
  if (!deadline?.enabled) return
  const deadlineAt = finiteNumber(deadline.deadlineAt)
  if (deadlineAt == null || now < deadlineAt) return
  throw new PostPrintDeadlineExceededError(step, deadline.timeoutMs, meta)
}

function isPostPrintDeadlineExceededError(error) {
  return error?.code === 'POST_PRINT_DEADLINE_EXCEEDED' || error instanceof PostPrintDeadlineExceededError
}

function remainingPostPrintDeadlineMs(deadline, now = Date.now()) {
  if (!deadline?.enabled) return Number.POSITIVE_INFINITY
  const deadlineAt = finiteNumber(deadline.deadlineAt)
  if (deadlineAt == null) return Number.POSITIVE_INFINITY
  return Math.max(0, deadlineAt - now)
}

module.exports = {
  PostPrintDeadlineExceededError,
  assertPostPrintDeadline,
  createPostPrintDeadline,
  isPostPrintDeadlineExceededError,
  remainingPostPrintDeadlineMs
}
