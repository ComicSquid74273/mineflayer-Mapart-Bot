'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.resolve(__dirname, '../src/nerv-printer/cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

function blockBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `missing marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

test('ladder honesty: a staged stage that did not reach the contract range falls through to the lateral escape', () => {
  // Regression (bot19, 2026-10-11/12): the non-strict staged navigation has
  // a broad internal ready tolerance (chest-era floor 2.25) and returned
  // SUCCESS without moving while the bot stood 1.82 blocks from the entry
  // (required 1.15). The lateral escape -- the stage that actually walks
  // around the obstacle -- only runs when a stage THROWS, so it never ran,
  // and the caller's distance check crashed the process as an unhandled
  // rejection 1578+ times.
  const staged = blockBetween('// 2) STAGED MACHINE NAVIGATION', '// 3) SIDESTEP ESCAPE')
  assert.match(staged, /const stagedDistance = distanceToPoint\(bot\?\.entity\?\.position, target\)/)
  assert.match(staged, /stagedDistance <= rangeW/, 'staged success must be verified against the caller range')
  assert.match(staged, /continuing to lateral escape/, 'an out-of-contract staged return must fall through, not return success')
  const stagedReturns = (staged.match(/return \{ method: 'staged' \}/g) || []).length
  assert.equal(stagedReturns, 1, 'exactly one staged success return, behind the distance gate')
})

test('entry return is retried a bounded number of times before failing', () => {
  const litematic = blockBetween('if (useLitematicRowMode) {', 'await prepareHotbarForBatch(')
  assert.match(litematic, /prepareBatchEntryWithRetry\('pre-food'\)/)
  assert.match(litematic, /prepareBatchEntryWithRetry\('post-food'\)/)
  assert.match(litematic, /workloadEntryReturnMaxAttempts, 3\)/, 'default bounded attempts')
  assert.match(litematic, /NERV-WORKLOAD-ENTRY-RETURN-RETRY/, 'retries are visible in logs')
})

test('an unreachable band entry holds the queue for resume instead of killing the process', () => {
  const factory = new Function(
    `${source.slice(source.indexOf('function shouldHoldQueueFileAfterRuntimeError('), source.indexOf('\nfunction buildProcessRuntimeMetrics('))}\nreturn shouldHoldQueueFileAfterRuntimeError`
  )
  const hold = factory()
  assert.equal(hold('workload-batch-entry-return-incomplete distance=1.82 readyRange=1.15'), true,
    'the exact bot19 error must be held for local resume, never rethrown to the listener')
  assert.equal(hold(''), false)
  assert.equal(hold('some unrelated failure'), false)
})

test('startup event listeners never propagate startAfterSpawn failures as unhandled rejections', () => {
  // The bot.on('spawn')/('nerv-chat-login-success') listeners are async with
  // no awaiter: an error escaping startAfterSpawn there is an
  // unhandledRejection and crashes the process (the bot19 crash path).
  assert.match(source, /const startAfterSpawnSafe = async \(trigger = 'threshold'\) => \{/)
  assert.match(source, /\[STARTUP-LISTENER-ERR\]/)
  // The wrapper must call the REAL startAfterSpawn exactly once -- a wrapper
  // that called itself deployed once and stack-overflowed every startup
  // ("Maximum call stack size exceeded", bot19 2026-10-12).
  const wrapperStart = source.indexOf("const startAfterSpawnSafe = async (trigger = 'threshold') => {")
  const wrapperEnd = source.indexOf('\n    }', wrapperStart)
  const wrapper = source.slice(wrapperStart, wrapperEnd)
  assert.match(wrapper, /await startAfterSpawn\(trigger\)/, 'the wrapper must invoke the real startAfterSpawn')
  assert.doesNotMatch(wrapper, /startAfterSpawnSafe\(/, 'the wrapper must never call itself')
  const mainSession = source.slice(wrapperStart)
  assert.doesNotMatch(mainSession.slice(0, 6000), /bot\.on\(([^)]+),\s*async[^)]*\)\s*=>\s*\{[\s\S]{0,400}?await startAfterSpawn\(/,
    'listener bodies must use the safe wrapper, not the raw startAfterSpawn')
})
