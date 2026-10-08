'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js'), 'utf8')

test('the emergency restock return walk uses staged machine navigation, not a raw goto', () => {
  const start = source.indexOf('const returnToEmergencyRestockAnchor = async () => {')
  assert.ok(start >= 0, 'returnToEmergencyRestockAnchor must exist')
  const body = source.slice(start, source.indexOf('const isTransientPlacementReason', start))

  // The bug (bot11, 2026-10-07/08): a raw bot.pathfinder.goto could not
  // cross a single 1-block obsidian step in the machine corridor -- first
  // "Took to long to decide path" under stale restricted Movements, then
  // hop-in-place thrash that reset the stall timer every ~5s so the
  // watchdog never fired. Multi-hour restock-loop stall.
  assert.doesNotMatch(body, /await bot\.pathfinder\.goto\(/, 'no raw goto as the primary walk')

  // Primary: the same staged machine navigation every other long walk on
  // the machine uses (24-block ingress staging, loaded frontiers, verified
  // flat routes) -- the dump-station walk crosses this corridor fine.
  assert.match(body, /gotoConfiguredAccess\(bot, pos, pos, anchorRange, config, 'restock-return'/)

  // Fallback: jump-enabled movements + a hard think budget, so a
  // pathological compute fails in seconds instead of wedging the bot.
  assert.match(body, /configurePathfinderMovements\(bot, config, \{ allowJump: true \}\)/)
  assert.match(body, /gotoWithTemporaryThinkTimeout\(bot, walkGoal\(\)/)
  assert.match(body, /emergencyRestockReturnThinkTimeoutMs/)
})
