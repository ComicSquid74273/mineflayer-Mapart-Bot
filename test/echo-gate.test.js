'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const cliPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

const toNumber = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }

function loadGate() {
  const start = source.indexOf('function installEchoGate(')
  assert.ok(start >= 0, 'installEchoGate must exist')
  const end = source.indexOf('\n// Effective count of the currently held stack', start)
  assert.ok(end > start)
  const body = source.slice(start, end)
  const factory = new Function('toNumber', `${body}\nreturn { installEchoGate, noteAuthoritativeWrite, echoGateOpen, waitForEchoGateOpen }`)
  return factory(toNumber)
}

function makeBot() {
  return { _client: new EventEmitter(), __nervConfig: { advanced: { echoGateHardTimeoutMs: 600 } } }
}

test('an authoritative write closes the gate until its window_items echo lands', () => {
  const gate = loadGate()
  const bot = makeBot()
  gate.installEchoGate(bot)
  assert.equal(gate.echoGateOpen(bot), true, 'installed-but-idle gate is open')

  gate.noteAuthoritativeWrite(bot)
  assert.equal(gate.echoGateOpen(bot), false, 'a pending echo closes the gate')

  bot._client.emit('window_items', { windowId: 0 })
  assert.equal(gate.echoGateOpen(bot), true, 'the echo reopens the gate')
})

test('each write needs its own echo; foreign windows do not count', () => {
  const gate = loadGate()
  const bot = makeBot()

  gate.noteAuthoritativeWrite(bot)
  gate.noteAuthoritativeWrite(bot)

  bot._client.emit('window_items', { windowId: 3 }) // chest snapshot: not ours
  assert.equal(gate.echoGateOpen(bot), false)

  bot._client.emit('window_items', { windowId: 0 })
  assert.equal(gate.echoGateOpen(bot), false, 'one echo settles one write')

  bot._client.emit('window_items', { windowId: 0 })
  assert.equal(gate.echoGateOpen(bot), true)
})

test('a dropped echo cannot deadlock staging: the hard timeout reopens the gate', () => {
  const gate = loadGate()
  const bot = makeBot()
  gate.noteAuthoritativeWrite(bot)
  assert.equal(gate.echoGateOpen(bot), false)
  bot.__nervEchoGate.hardUntil = Date.now() - 1 // simulate timeout elapsed
  assert.equal(gate.echoGateOpen(bot), true)
})

test('waitForEchoGateOpen resolves once the echo lands', async () => {
  const gate = loadGate()
  const bot = makeBot()
  gate.noteAuthoritativeWrite(bot)

  const waiting = gate.waitForEchoGateOpen(bot, 2000)
  setTimeout(() => bot._client.emit('window_items', { windowId: 0 }), 60)
  const t0 = Date.now()
  await waiting
  assert.ok(Date.now() - t0 < 1000, 'resolved on the echo, not the timeout')
})

test('every authoritative write bumps the gate', () => {
  const swap = source.slice(
    source.indexOf('function silentHotbarSwap('),
    source.indexOf('\n// Replenish a hotbar slot')
  )
  assert.match(swap, /noteAuthoritativeWrite\(bot\)/)

  const resync = source.slice(
    source.indexOf('function refreshInventoryAuthoritatively('),
    source.indexOf('\nfunction ', source.indexOf('function refreshInventoryAuthoritatively(') + 10)
  )
  assert.match(resync, /noteAuthoritativeWrite\(bot\)/)

  // The offhand-pair sends TWO -1 clicks: both echoes must be tracked.
  const pairAt = source.indexOf('reason=offhand-pair')
  const pair = source.slice(pairAt - 900, pairAt)
  assert.match(pair, /noteAuthoritativeWrite\(bot\)\s*\n\s*noteAuthoritativeWrite\(bot\)/)

  // Raw offhand hops gate themselves AND bump.
  const hopAt = source.indexOf('[EQUIP-OFFHAND-HOP] ${blockName} only in offhand')
  const hop = source.slice(hopAt - 400, hopAt + 100)
  assert.match(hop, /echoGateOpen\(bot\)/)
  assert.match(hop, /noteAuthoritativeWrite\(bot\)/)
})

test('every in-band mutation site waits for the echo, not a timer', () => {
  const batchStart = source.indexOf('async function runNervTimeWorkloadPlacementBatch')
  const batch = source.slice(batchStart, source.indexOf('\nasync function ', batchStart + 10))

  // Handover, deferred-restage and the readiness replenish loop still gate
  // on the echo (they re-derive slots from the live view). The PLAN ops loop
  // pipelines instead: disjoint-slot swaps may overlap (16-colour bands need
  // ~127 switches in one walk; serial echo-gated swaps cannot fit).
  const gated = batch.match(/\|\| !echoGateOpen\(bot\)\) break/g) || []
  assert.ok(gated.length >= 3, `expected >=3 gated wake loops, found ${gated.length}`)
  const opsLoop = batch.slice(batch.indexOf('for (const op of bandPlan.swaps)'), batch.indexOf('// §8.C gapless handover'))
  assert.match(opsLoop, /pendingSwapSlots/)
  assert.match(opsLoop, /pendingSwapSlots\.length >= 3\) break/)
  assert.match(opsLoop, /p\.slots\.includes\(source\.slot\)/)
  assert.match(opsLoop, /silentHotbarSwap\(bot, source\.slot, dest, true\)/, 'plan swaps keep the selection so emission prints through them')

  // The offhand pair must not fire while an echo is pending.
  assert.match(batch, /&& echoGateOpen\(bot\)\) \{\s*\n\s*const offhandCandidate/)

  // The repair loop's inline restage too.
  const restage = source.slice(source.indexOf('A plan-not-staged deferral in the REPAIR loop'))
  assert.match(restage.slice(0, 2000), /echoGateOpen\(bot\) && silentHotbarSwap/)

  // Lane-entry staging runs to completion rather than skipping mid-echo.
  const prep = source.slice(
    source.indexOf('async function prepareHotbarForBatch('),
    source.indexOf('\nasync function equipMaterial(')
  )
  const awaits = prep.match(/await waitForEchoGateOpen\(bot\)/g) || []
  assert.equal(awaits.length, 2, 'both staging loops wait for the echo')
})

test('the per-wake emission cap resets every wake (the 90%-miss band bug)', () => {
  // planEmittedThisTick lives at closure scope; without a per-wake reset the
  // first wake spent the bucket's 5 starting tokens and every later wake
  // broke on its first cell -- emission offered nothing for the whole band
  // (sched=5 then 0 forever, 467/512 neverSent).
  const batchStart = source.indexOf('async function runNervTimeWorkloadPlacementBatch')
  const batch = source.slice(batchStart, source.indexOf('\nasync function ', batchStart + 10))
  const capAt = batch.indexOf('const perTickCap = Math.floor(emissionTokens)')
  const resetAt = batch.indexOf('planEmittedThisTick = 0', capAt)
  assert.ok(capAt >= 0, 'the per-tick cap computation must exist')
  assert.ok(resetAt > capAt, 'the per-wake reset follows the cap computation')
  assert.match(batch, /rej=exp:/, 'PLAN-DEBT logs emission reject reasons')
})

test('offhand stock is availability, not a reason to unpair it', () => {
  // The readiness availability must count slot 45 as hotbar-equivalent: the
  // offhand prints select-free, and counting it as zero made the replenish
  // loop swap the pair OUT of the offhand (pair/unpair churn).
  const availAt = source.indexOf('for (const blockName of burstColors) {')
  const avail = source.slice(availAt, availAt + 900)
  assert.match(avail, /slots\?\.\[45\]/)
  assert.match(avail, /hotbar \+= Math\.max\(0, toNumber\(offHandAvail\.count, 0\)\)/)

  // equipMaterial must not gate on items() (blind to 45) -- an offhand-only
  // colour fell through to restock-wait instead of the hop that reaches it.
  const equip = source.slice(
    source.indexOf('async function equipMaterial('),
    source.indexOf('\nasync function ', source.indexOf('async function equipMaterial(') + 10)
  )
  assert.match(equip, /findBestInventorySlotForItem\(bot, blockName\)/)
  assert.doesNotMatch(equip, /bot\.inventory\.items\(\)\.find/)

  // Same for the desync recover gate.
  const recover = source.slice(
    source.indexOf('async function recoverMissingItemInventoryDesync('),
    source.indexOf('\nasync function ', source.indexOf('async function recoverMissingItemInventoryDesync(') + 10)
  )
  assert.match(recover, /offHandDesync/)
})
