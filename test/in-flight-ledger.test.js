'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const cliPath = path.resolve(__dirname, '../src/nerv-printer/cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

function loadLedger() {
  const start = source.indexOf('function installInFlightLedger (bot) {')
  const end = source.indexOf('\n// Effective count of the currently held stack', start)
  assert.ok(start >= 0, 'installInFlightLedger must exist')
  assert.ok(end > start, 'ledger block must terminate')
  const factory = new Function(
    'const getHotbarWindowSlot = (index) => 36 + index;\n' +
    `${source.slice(start, end)}\nreturn installInFlightLedger`
  )
  return factory()
}

function makeBot(stackCount = 18) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.inventory = { slots: new Array(46).fill(null) }
  bot.inventory.slots[38] = { name: 'black_carpet', count: stackCount }
  return bot
}

test('an un-echoed send storm must not starve a healthy stack (reserve cap)', () => {
  // Live regression: 6b6t never echoes per-placement set_slot, so `sent`
  // only decayed via the 800ms window; effectiveCount pinned at <=0 and the
  // emitter refused an entire colour (3608 stack-in-flight-black skips).
  const install = loadLedger()
  const bot = makeBot(18)
  const ledger = install(bot)
  for (let i = 0; i < 50; i += 1) ledger.noteSend(2)
  const effective = ledger.effectiveCount(2)
  assert.ok(Number.isFinite(effective) && effective > 0, `mid-stack effective must stay positive, got ${effective}`)
  assert.equal(effective, 18 - ledger.reserveCap)
})

test('the boundary guard still bites on the last items of a stack', () => {
  const install = loadLedger()
  const bot = makeBot(3)
  const ledger = install(bot)
  for (let i = 0; i < 10; i += 1) ledger.noteSend(2)
  const effective = ledger.effectiveCount(2)
  assert.ok(effective <= 0, `near-empty stack must be guarded, got ${effective}`)
})

test('a held-slot set_slot echo decrements the reservation', () => {
  const install = loadLedger()
  const bot = makeBot(4)
  const ledger = install(bot)
  ledger.noteSend(2)
  bot._client.emit('set_slot', { windowId: 0, slot: 38 })
  // echo arrived: reservation releases even at the boundary
  const effective = ledger.effectiveCount(2)
  assert.ok(effective == null || effective > 0, `echo must clear the reservation, got ${effective}`)
})

test('an authoritative window snapshot re-bases the ledger', () => {
  const install = loadLedger()
  const bot = makeBot(3)
  const ledger = install(bot)
  for (let i = 0; i < 10; i += 1) ledger.noteSend(2)
  bot._client.emit('window_items', { windowId: 0 })
  assert.equal(ledger.effectiveCount(2), null)
})
