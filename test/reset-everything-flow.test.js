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

test('idle cleanup does not treat a missing print generation as generation zero', () => {
  const runtimeGuard = sourceBetween('function assertRuntimeContinue(', 'function placementNoiseLogsEnabled(')
  assert.match(runtimeGuard, /getRuntimeWorldGenerationBoundary\(config\)/)
  assert.match(runtimeGuard, /runGeneration != null/)
  assert.doesNotMatch(runtimeGuard, /Number\(config\?\.__runtimeWorldGenerationAtRun\)/)
})

test('reset preflight intentionally spans its backend world transition', () => {
  const preflight = sourceBetween('async function runPlatformResetPreflight(', 'async function parkAtCartographyAccessForPause(')
  const suspendBoundary = preflight.indexOf('config.__runtimeWorldGenerationAtRun = null')
  const resetInteraction = preflight.indexOf("interactWithConfiguredBlock(bot, config, resetConfig, 'reset-block')")
  const verifiedPlatform = preflight.indexOf("waitForPlatformReady(bot, config, `${reason}-after-reset`)")
  const clearPending = preflight.indexOf('bot.__nervRuntimeWorldChangePending = false')
  const restoreBoundary = preflight.indexOf('completed ? getRuntimeWorldGeneration(bot) : inheritedWorldGeneration')

  assert.ok(suspendBoundary >= 0)
  assert.ok(resetInteraction > suspendBoundary)
  assert.ok(verifiedPlatform > resetInteraction)
  assert.ok(clearPending > verifiedPlatform)
  assert.ok(restoreBoundary > clearPending)
})

test('reset everything clears stale dashboard errors around successful cleanup', () => {
  const managedLoop = sourceBetween('async function runDashboardManagedPrintLoop(', 'function createBot(')
  const cleanupRequest = managedLoop.indexOf('consumePlatformCleanupRequest?.() === true')
  const firstClear = managedLoop.indexOf('clearLastError?.()', cleanupRequest)
  const preflight = managedLoop.indexOf("runPlatformResetPreflight(bot, config, 'reset-everything')", firstClear)
  const secondClear = managedLoop.indexOf('clearLastError?.()', preflight)

  assert.ok(cleanupRequest >= 0)
  assert.ok(firstClear > cleanupRequest)
  assert.ok(preflight > firstClear)
  assert.ok(secondClear > preflight)
})
