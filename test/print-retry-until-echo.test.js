'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

test('a sent placement parks for one echo window instead of being ledgered as done', () => {
  // Meteor-printer semantics: the scan re-offers any cell the world still
  // reports as replaceable. The optimistic ledger used to swallow dropped
  // packets -- the cell read "done" on our side and "air" on the server, and
  // the scanner never tried again. The repair walkback was the only thing
  // that could fill the hole.
  const workloadAt = source.indexOf('async function runNervTimeWorkloadPlacementBatch(')
  assert.ok(workloadAt >= 0, 'time workload batch must exist')
  const burstStart = source.indexOf("const result = await placeNervScannerTarget(bot, config, target)", workloadAt)
  assert.ok(burstStart >= 0, 'burst emit must exist inside the time workload batch')
  const burst = source.slice(burstStart, burstStart + 2900)

  assert.match(burst, /if \(result\.state === 'placed'\) \{[\s\S]*?pendingUntil\.set\(key, Math\.max\(existingUntil, Date\.now\(\) \+ echoRetryMs\)\)/)
  // Only the world-confirmed 'already' path may mark the target complete.
  const alreadyAt = burst.indexOf("result.state === 'already'")
  const placedAt = burst.indexOf("result.state === 'placed'")
  assert.ok(alreadyAt > placedAt, 'already branch follows placed branch')
  assert.match(burst.slice(alreadyAt, alreadyAt + 300), /markTargetPlacedInWorld\(target, key\)/)
  assert.match(burst, /advanced\.scannerEchoRetryMs, 250/)
  // The foreground drain helper uses the same parking, never mark-on-send.
  const drainHelper = source.slice(source.indexOf('const placeReachableActiveTargets = async'))
  assert.match(drainHelper.slice(0, 1400), /pendingUntil\.set\(key, Math\.max\(existingUntil, Date\.now\(\) \+ echoRetryMs\)\)/)
})

test('the candidate scan ledgers world-echoed cells, not optimistic sends', () => {
  const collectStart = source.indexOf('function collectNervScannerCandidates(')
  assert.ok(collectStart >= 0)
  const collect = source.slice(collectStart, source.indexOf('\nfunction findNervScannerCandidate(', collectStart))

  const echoAt = collect.indexOf("if (actual?.name === entry.target.blockName) {")
  assert.ok(echoAt >= 0, 'world-echo branch must exist')
  assert.match(collect.slice(echoAt, echoAt + 400), /__nervConfirmedPlaced\.add\(entry\.key\)/)
})

test('the echo window is configurable with a floor', () => {
  assert.match(source, /scannerEchoRetryMs: 250/)
  assert.match(source, /Math\.max\(50, toNumber\(advanced\.scannerEchoRetryMs, 250\)\)/)
})

test('unverified-placement sampling no longer references out-of-scope helpers', () => {
  // The sampler used a bare `bot` and a closure-local getSelectedHotbarName()
  // that do not exist at module scope; every fast placement threw inside the
  // sample call and the diagnostic evidence was silently lost.
  const start = source.indexOf('function noteUnverifiedPlacement(')
  assert.ok(start >= 0)
  const body = source.slice(start, source.indexOf('\nasync function placeTarget(', start))

  assert.match(body, /noteUnverifiedPlacement\(bot, target, attempt, support\)/)
  assert.match(body, /bot\.inventory\?\.slots\?\.\[getHotbarWindowSlot\(selectedIndex\)\]/)
  assert.doesNotMatch(body, /getSelectedHotbarName\(\)/)
  // Both call sites pass the bot now.
  const placeTarget = source.slice(source.indexOf('async function placeTarget('), source.indexOf('\nfunction isTargetAlreadyResolved', source.indexOf('async function placeTarget(')))
  assert.equal((placeTarget.match(/noteUnverifiedPlacement\(bot, target, attempt, support\)/g) || []).length, 2)
  assert.doesNotMatch(placeTarget, /noteUnverifiedPlacement\(target, attempt, support\)/)
})

test('precise approach spin detection is log-only instrumentation', () => {
  const paPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'precise-access.js')
  const pa = fs.readFileSync(paPath, 'utf8')

  assert.match(pa, /PRECISE-APPROACH-SPIN/)
  // Detection must not alter movement: no setControlState or look inside the detector.
  const detectorStart = pa.indexOf('// Spin/orbit detection')
  const detector = pa.slice(detectorStart, pa.indexOf('await wait(pollMs)', detectorStart))
  assert.doesNotMatch(detector, /setControlState|bot\.look|__nervAllowActiveJump/)
  // No absolute positions in the log line.
  assert.doesNotMatch(pa.slice(pa.indexOf('[PRECISE-APPROACH-SPIN]')), /position\.x\.toFixed\(2\), .{0,40}position\.z/)
})
