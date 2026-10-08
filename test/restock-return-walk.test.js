'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js'), 'utf8')

test('the emergency restock return walk resets pathfinder rules and fails fast', () => {
  const start = source.indexOf('const returnToEmergencyRestockAnchor = async () => {')
  assert.ok(start >= 0, 'returnToEmergencyRestockAnchor must exist')
  const body = source.slice(start, source.indexOf('const isTransientPlacementReason', start))

  // The bug (bot11, 2026-10-07/08): a raw bot.pathfinder.goto inherited the
  // chest access's restricted Movements (no step-up), could not route past a
  // 1-block obsidian step, and burned the whole think budget -- the bot then
  // stood frozen until the 300s watchdog recycled the session. Multi-hour
  // restock-loop stall.
  assert.doesNotMatch(body, /await bot\.pathfinder\.goto\(/, 'no raw goto: it inherits stale restricted movements')

  // Normal walking rules are reinstalled before every attempt, so 1-block
  // hops (the obsidian) are legal again.
  assert.match(body, /configurePathfinderMovements\(bot, config, \{ allowJump: true \}\)/)

  // The compute has a hard budget, so a pathological search fails in
  // seconds instead of freezing the bot for a watchdog cycle.
  assert.match(body, /gotoWithTemporaryThinkTimeout\(bot, walkGoal\(\)/)
  assert.match(body, /emergencyRestockReturnThinkTimeoutMs/)

  // One retry with a doubled budget before giving the anchor walk up.
  assert.match(body, /for \(let attempt = 1; attempt <= 2; attempt \+= 1\)/)
  assert.match(body, /attempt === 1 \? thinkTimeoutMs : thinkTimeoutMs \* 2/)
})
