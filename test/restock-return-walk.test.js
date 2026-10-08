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

  // Primary: the shared robust anchor walk -- straight physics first
  // (cannot hang: hard wall-clock budget), staged navigation second,
  // sidestep escape third, think-budgeted goto last.
  assert.match(body, /walkToAnchorRobust\(bot, config, pos, anchorRange, 'restock-return'\)/)
  assert.match(body, /RESTOCK-RETURN-OK\] method=\$\{result\.method\}/)

  // The robust walk itself: every primitive time-bounded, straight first.
  const robustAt = source.indexOf('async function walkToAnchorRobust(')
  assert.ok(robustAt >= 0, 'walkToAnchorRobust must exist')
  const robust = source.slice(robustAt, source.indexOf('\n}', robustAt) + 2)
  assert.match(robust, /walkStraightToPointWithHardTimeout\(bot, target, rangeW, straightBudgetMs/, 'straight walk first, distance-scaled hard timeout')
  assert.match(robust, /gotoConfiguredAccess\(bot, pos, pos, rangeW, config, `\$\{label\}-staged`/, 'staged navigation second')
  assert.match(robust, /'restock-return-sidestep'|\$\{label\}-sidestep/, 'sidestep escape third')
  assert.match(robust, /configurePathfinderMovements\(bot, config\)\n/)
  assert.match(robust, /gotoWithTemporaryThinkTimeout\(/)
  assert.match(robust, /dumpRestockReturnSurroundings\(bot\)/, 'surroundings dumped when a walk layer fails')

  // And the entry return uses the same robust walk before its strict one.
  const entryAt = source.indexOf('async function prepareWorkloadBatchEntry')
  const entryBody = source.slice(entryAt, source.indexOf('async function runNervScannerPlacementBatch', entryAt))
  assert.match(entryBody, /walkToAnchorRobust\(bot, config, entry, entryRange, 'entry-return'\)/)

  // THE LATCH: a stuck sneak edge-clamps the bot -- every primitive failed
  // on an open corridor because sneak never cleared. Both the robust walk
  // and the straight walker clear it before moving.
  assert.match(robust, /bot\.setControlState\('sneak', false\)/, 'robust walk clears sneak')
  assert.match(robust, /forceStopBotSneaking\(bot\)/)
  const walkerAt = source.indexOf('async function walkStraightToPointWithHardTimeout')
  const walker = source.slice(walkerAt, source.indexOf('\n}', source.indexOf("bot.setControlState('jump', jump)", walkerAt)))
  assert.match(walker, /bot\.setControlState\('sneak', false\)/, 'straight walker clears sneak before moving')

  // And the wedge point reports its actual surroundings, so the next
  // occurrence shows the world state instead of another inference chain.
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
  assert.match(wrapper, /configurePathfinderMovements\(bot, config \|\| bot\.__nervConfig \|\| \{\}\) \} catch/, 'wrapper restores CONFIG defaults, never forces capabilities')
  assert.match(wrapper, /__nervMachinePathSprintSuppressed = false/)
  assert.match(wrapper, /__nervMachinePathSprintForced = false/)
  assert.match(source, /async function gotoConfiguredAccessInner\(/, 'the implementation is renamed and wrapped')

  // Defense in depth: the repair family's raw gotos each reinstall normal
  // walking rules before moving, so even a future leak elsewhere cannot
  // wedge a repair move.
  const guardCount = (source.match(/configurePathfinderMovements\(bot, config\)\n/g) || []).length
  assert.ok(guardCount >= 3, `expected >=3 config-honouring movement guards, found ${guardCount}`)

  // The operator sets printer.allowJump=false fleet-wide: NOTHING may force
  // jump capabilities over the config (the walk fixes briefly did, and were
  // reverted -- the escape that actually works is the flat lateral step).
  assert.equal((source.match(/\{ allowJump: true \}/g) || []).length, 0, 'no forced allowJump overrides anywhere')
  const robust2 = source.slice(source.indexOf('async function walkToAnchorRobust('))
  assert.match(robust2, /const jumpAllowed = config\?\.printer\?\.allowJump !== false/, 'straight legs derive jump from config')
  assert.match(robust2, /jump: false\)/, 'the lateral escape never jumps')
})
