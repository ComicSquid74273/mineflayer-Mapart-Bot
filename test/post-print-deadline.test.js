'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assertPostPrintDeadline,
  createPostPrintDeadline,
  isPostPrintDeadlineExceededError,
  remainingPostPrintDeadlineMs
} = require('../src/nerv-printer/post-print-deadline')

test('post-print deadline uses one continuous bounded run window', () => {
  const deadline = createPostPrintDeadline({
    advanced: {
      postPrintWorkflowTimeoutEnabled: true,
      postPrintWorkflowTimeoutMs: 60000
    }
  }, 1000)

  assert.deepEqual(deadline, {
    enabled: true,
    startedAt: 1000,
    timeoutMs: 60000,
    deadlineAt: 61000
  })
  assert.equal(remainingPostPrintDeadlineMs(deadline, 11000), 50000)
  assert.doesNotThrow(() => assertPostPrintDeadline(deadline, 'fill_map', {}, 60999))
})

test('post-print deadline identifies the exact failed step and preserved handoff', () => {
  const deadline = createPostPrintDeadline({
    advanced: { postPrintWorkflowTimeoutMs: 60000 }
  }, 1000)

  assert.throws(
    () => assertPostPrintDeadline(deadline, 'rename_store', {
      postPrintCartographyComplete: true,
      postPrintSourceMapId: 456
    }, 61000),
    (error) => {
      assert.equal(isPostPrintDeadlineExceededError(error), true)
      assert.equal(error.step, 'rename_store')
      assert.equal(error.timeoutMs, 60000)
      assert.equal(error.postPrintCartographyComplete, true)
      assert.equal(error.postPrintSourceMapId, 456)
      assert.match(error.message, /without retrying/)
      return true
    }
  )
})

test('disabled post-print deadline never expires', () => {
  const deadline = createPostPrintDeadline({
    advanced: { postPrintWorkflowTimeoutEnabled: false }
  }, 1000)

  assert.equal(deadline.enabled, false)
  assert.equal(remainingPostPrintDeadlineMs(deadline, Number.MAX_SAFE_INTEGER), Number.POSITIVE_INFINITY)
  assert.doesNotThrow(() => assertPostPrintDeadline(deadline, 'cartography', {}, Number.MAX_SAFE_INTEGER))
})
