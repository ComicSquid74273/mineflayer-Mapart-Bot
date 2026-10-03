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

  // Scheduled staging, handover, deferred-restage and the readiness
  // replenish loop: four wake loops that used to re-swap off a stale view
  // once their 150ms timer expired mid-echo.
  const gated = batch.match(/\|\| !echoGateOpen\(bot\)\) break/g) || []
  assert.ok(gated.length >= 4, `expected >=4 gated wake loops, found ${gated.length}`)

  // The offhand pair must not fire while an echo is pending.
  assert.match(batch, /&& echoGateOpen\(bot\)\) \{\s*\n\s*const offhandCandidate/)

  // The repair loop's inline restage too.
  const restage = source.slice(source.indexOf('A plan-not-staged deferral in the REPAIR loop'))
  assert.match(restage.slice(0, 1400), /echoGateOpen\(bot\) && silentHotbarSwap/)

  // Lane-entry staging runs to completion rather than skipping mid-echo.
  const prep = source.slice(
    source.indexOf('async function prepareHotbarForBatch('),
    source.indexOf('\nasync function equipMaterial(')
  )
  const awaits = prep.match(/await waitForEchoGateOpen\(bot\)/g) || []
  assert.equal(awaits.length, 2, 'both staging loops wait for the echo')
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
