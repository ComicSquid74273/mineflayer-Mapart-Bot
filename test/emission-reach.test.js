'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.resolve(__dirname, '../src/nerv-printer/cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

function emissionBlock() {
  const start = source.indexOf('const planLagBlocks = Math.max(0, toNumber(advanced.bandSchedulerLagBlocks, 1.4))')
  const end = source.indexOf('eligible.sort(', start)
  assert.ok(start >= 0, 'plan emission reach block must exist')
  assert.ok(end > start, 'eligible sort must follow the reach block')
  return source.slice(start, end)
}

test('plan emission reach is position-aware: trailing or leash-held cells get full placeRange', () => {
  const block = emissionBlock()
  assert.match(block, /const fullReach2 = placeRange \* placeRange/)
  assert.match(block, /const aheadReach2 = Math\.max\(1, placeRange - planLagBlocks\) \*\* 2/)
  assert.match(block, /const trailing = \(tp\.z - bot\.entity\.position\.z\) \* leashDir <= 0\.5/)
  assert.match(block, /const reach2 = \(trailing \|\| leash\.hold\) \? fullReach2 : aheadReach2/)
  assert.match(block, /if \(d2 > reach2\) continue/)
})

test('the deadlock geometry is reachable only with full reach on trailing cells', () => {
  // Observed live: a lane cell 2.2 blocks behind the travel line and ~4
  // blocks lateral, eye 1.18 above the block centre. placeRange 5, lag 1.4.
  const dx = 4.0
  const dz = 2.2
  const dy = 1.18
  const d2 = dx * dx + dz * dz + dy * dy
  const fullReach2 = 5 * 5
  const aheadReach2 = (5 - 1.4) ** 2
  assert.ok(d2 <= fullReach2, 'deadlock cell must be inside full reach')
  assert.ok(d2 > aheadReach2, 'deadlock cell must be outside the lag-reduced reach')
})

test('the movement leash never gates repair movement and self-releases when emission cannot offer the cell', () => {
  assert.match(source, /const leashHolding = leash\.hold === true && !String\(currentAction \|\| ''\)\.includes\('repair'\) && !leashNoEmission/, 'any repair action (inline-repair, lineEnd-repair) keeps navigation authority; a no-emission hold releases')
  const start = source.indexOf('bot.__nervTraversalHold = leashHolding')
  assert.ok(start >= 0, 'hold flag must be wired to the exempted computation')
  // The release is driven by a send clock refreshed on every placed emission.
  assert.match(source, /leashNoEmissionSince > 0/)
  assert.match(source, /Date\.now\(\) - leashNoEmissionSince >= leashNoEmissionReleaseMs/)
})
