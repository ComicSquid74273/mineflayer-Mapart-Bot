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

test('map activation waits for delayed authoritative inventory updates without shrinking the configured timeout', () => {
  const latencyTimeout = sourceBetween('function getLatencyAdjustedTimeoutMs(', 'function stopLagSensitiveMovement(')
  assert.match(latencyTimeout, /Math\.max\(base, min, Math\.min\(state\.settings\.timeoutMaxMs, adjusted\)\)/)

  const postPrint = sourceBetween('async function runPostPrintWorkflow(', 'async function runPostPrintWorkflowWithRecovery(')
  assert.match(postPrint, /Math\.max\(15000, toNumber\(advanced\.postPrintFillMapWaitMs, 15000\)\)/)
  assert.match(postPrint, /const fillDeadline = Date\.now\(\) \+ fillWaitMs/)
})

test('finished-map output retries transient open failures in the same post-print hold', () => {
  const inspect = sourceBetween('async function inspectFinishedMapChestCandidate(', 'async function waitForFinishedMapChestCapacity(')
  assert.match(inspect, /postPrintFinishedChestOpenAttempts, 2/)
  assert.match(inspect, /postPrintFinishedChestOpenRetryDelayMs, 500/)
  assert.match(inspect, /timeoutMs,\s*attempts: openAttempts,\s*retryDelayMs: openRetryDelayMs/)

  const wait = sourceBetween('async function waitForFinishedMapChestCapacity(', 'async function depositToFinishedMapChestCandidates(')
  assert.doesNotMatch(wait, /if \(!allConfirmedFull && waitStartedAt <= 0\) \{\s*return/)
  assert.match(wait, /Finished-map output chest capacity is temporarily unavailable/)
  assert.match(wait, /allConfirmedFull \? 'error' : 'warning'/)
  assert.match(wait, /options\.onHold\?\.\(details\)/)
})
