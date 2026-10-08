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

  // When even the staged walk cannot path out of the pocket, a NO-PATHFINDER
  // sidestep escape runs first: straight-walk (jump on, plain physics) to a
  // point past the lone solid block via the walkable sides, then retry the
  // staged walk from open ground; the long straight leg is the last resort
  // before the goto.
  assert.match(body, /walkStraightToPointWithHardTimeout\(bot, escapePoint, 0\.9, 6000, 'restock-return-sidestep', \{ config, jump: true \}\)/)
  assert.match(body, /'restock-return-escaped'/, 'staged walk retried from the escaped position')
  assert.match(body, /'restock-return-straight', \{ config, sprint: true, jump: true \}/)

  // And the wedge point reports its actual surroundings, so the next
  // occurrence shows the world state instead of another inference chain.
  assert.match(body, /dumpRestockReturnSurroundings\(bot\)/)
  assert.match(source, /function dumpRestockReturnSurroundings\(bot\)/)
  assert.match(source, /\[RESTOCK-RETURN-SURROUNDINGS\]/)
})

test('machine navigation never leaks restricted Movements to later raw gotos (root cause)', () => {
  // The corridor wedges (bot11, hours across three walk primitives) all
  // traced to one root: strict machine access installs restricted
  // Movements globally and left them installed. gotoConfiguredAccess now
  // wraps its implementation and ALWAYS restores normal walking rules
  // (1-block hops legal) and clears sprint suppression on exit.
  const wrapperAt = source.indexOf('async function gotoConfiguredAccess(bot, position, accessPosition, range = 2, config = null, reason = \'configured-access\', options = {}) {')
  assert.ok(wrapperAt >= 0, 'the public wrapper must exist')
  const wrapper = source.slice(wrapperAt, source.indexOf('async function gotoConfiguredAccessInner', wrapperAt))
  assert.match(wrapper, /return await gotoConfiguredAccessInner\(/)
  assert.match(wrapper, /finally \{/)
  assert.match(wrapper, /configurePathfinderMovements\(bot, config \|\| bot\.__nervConfig \|\| \{\}, \{ allowJump: true \}\)/)
  assert.match(wrapper, /__nervMachinePathSprintSuppressed = false/)
  assert.match(wrapper, /__nervMachinePathSprintForced = false/)
  assert.match(source, /async function gotoConfiguredAccessInner\(/, 'the implementation is renamed and wrapped')

  // Defense in depth: the repair family's raw gotos each reinstall normal
  // walking rules before moving, so even a future leak elsewhere cannot
  // wedge a repair move.
  const guardCount = (source.match(/configurePathfinderMovements\(bot, config, \{ allowJump: true \}\)/g) || []).length
  assert.ok(guardCount >= 4, `expected >=4 allowJump guards (restock fallback + 3 repair gotos), found ${guardCount}`)
})
