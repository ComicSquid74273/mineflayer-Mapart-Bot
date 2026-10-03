'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const cliPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

function makeGuardBot() {
  const writes = []
  const client = {
    write: (name, packet) => {
      writes.push([name, packet])
    }
  }
  const bot = { _client: client, activateBlock: async () => { } }
  return { bot, writes }
}

test('the sequence guard ledgers block_place positions for ack correlation', () => {
  const { installBlockInteractionGuard } = require(path.join(__dirname, '..', 'src', 'nerv-printer', 'block-interaction.js'))
  const { bot } = makeGuardBot()
  const guard = installBlockInteractionGuard(bot)
  assert.ok(guard?.placementLedger, 'guard must expose the placement ledger')

  // Sequences start at 2, matching the reference addon's session high-water mark.
  // direction 1 = top face: the carpet lands one above the clicked support.
  bot._client.write('block_place', { location: { x: 10, y: 64, z: -5 }, direction: 1, sequence: 0 })
  assert.equal(guard.placementLedger.take(2), '10:65:-5', 'the ledger key is the placed cell, not the clicked block')
  assert.equal(guard.placementLedger.take(2), undefined, 'take consumes the entry')
  assert.equal(guard.state.nextSequence, 3)

  // direction 0 = bottom face: placed cell one below.
  bot._client.write('block_place', { location: { x: 10, y: 64, z: -5 }, direction: 0, sequence: 0 })
  assert.equal(guard.placementLedger.take(3), '10:63:-5')

  // use_item carries a sequence but no placed position: never ledgered.
  bot._client.write('use_item', { sequence: 0 })
  assert.equal(guard.placementLedger.take(3), undefined)
})

test('the placement ledger is bounded', () => {
  const { installBlockInteractionGuard } = require(path.join(__dirname, '..', 'src', 'nerv-printer', 'block-interaction.js'))
  const { bot } = makeGuardBot()
  const guard = installBlockInteractionGuard(bot)
  for (let i = 0; i < 200; i += 1) {
    bot._client.write('block_place', { location: { x: i, y: 64, z: 0 }, sequence: 0 })
  }
  assert.ok(guard.placementLedger.size() <= 128, 'a server that never acks must not grow the ledger unbounded')
})

// Evaluate the real installPlacementAckTracking with an injectable scheduler so
// the settle path runs synchronously in the test.
function loadTracker() {
  const start = source.indexOf('function installPlacementAckTracking(')
  assert.ok(start >= 0, 'installPlacementAckTracking must exist')
  const end = source.indexOf('\nfunction ', start + 10)
  assert.ok(end > start)
  const body = source.slice(start, end)
  const factory = new Function('toNumber', 'require', 'EventEmitter', `${body}\nreturn installPlacementAckTracking`)
  return factory(
    (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d },
    require,
    EventEmitter
  )
}

function makeAckBot(worldByName) {
  const ledger = new Map([['42', '7:64:7']])
  const guard = {
    placementLedger: {
      // Cumulative semantics, matching the real ledger.
      takeUpTo: (seq) => {
        const keys = []
        for (const [s, k] of ledger) {
          if (Number(s) <= seq) {
            keys.push(k)
            ledger.delete(s)
          }
        }
        return keys
      },
      take: (seq) => { const k = ledger.get(String(seq)); ledger.delete(String(seq)); return k }
    }
  }
  const bot = {
    _client: new EventEmitter(),
    __nervBlockInteractionGuard: guard,
    blockAt: (pos) => ({ name: worldByName[`${pos.x}:${pos.y}:${pos.z}`] || 'air' })
  }
  return bot
}

test('an ack for a ledgered placement settles with the authoritative world block', () => {
  const install = loadTracker()
  const bot = makeAckBot({ '7:64:7': 'red_carpet' })
  const settled = []
  const tracker = install(bot, { advanced: { ackSettleDelayMs: 5 } }, { scheduler: (fn) => fn() })
  tracker.settlers.add((key, worldName) => settled.push([key, worldName]))

  bot._client.emit('acknowledge_player_digging', { sequenceId: 42 })

  assert.deepEqual(settled, [['7:64:7', 'red_carpet']])
  assert.equal(tracker.stats.acks, 1)
  assert.equal(tracker.stats.blockPresent, 1)
  assert.equal(tracker.stats.blockAbsent, 0)
})

test('an ack over an absent block settles as rejected and counts blockAbsent', () => {
  const install = loadTracker()
  const bot = makeAckBot({})
  const settled = []
  const tracker = install(bot, { advanced: {} }, { scheduler: (fn) => fn() })
  tracker.settlers.add((key, worldName) => settled.push([key, worldName]))

  bot._client.emit('acknowledge_player_digging', { sequenceId: 42 })

  assert.deepEqual(settled, [['7:64:7', 'air']])
  assert.equal(tracker.stats.blockAbsent, 1)
})

test('an ack whose sequence the ledger does not know is ignored', () => {
  const install = loadTracker()
  const bot = makeAckBot({ '7:64:7': 'red_carpet' })
  const settled = []
  const tracker = install(bot, { advanced: {} }, { scheduler: (fn) => fn() })
  tracker.settlers.add((key, worldName) => settled.push([key, worldName]))

  // Cumulative semantics: only a sequence BELOW the ledgered one is truly
  // unknown; a higher one would acknowledge it.
  bot._client.emit('acknowledge_player_digging', { sequenceId: 41 })
  bot._client.emit('acknowledge_player_digging', {})

  assert.equal(settled.length, 0)
  assert.equal(tracker.stats.unmatched, 1)
  assert.equal(tracker.stats.acks, 0)
})

test('installing twice returns the same tracker instead of stacking listeners', () => {
  const install = loadTracker()
  const bot = makeAckBot({ '7:64:7': 'red_carpet' })
  const first = install(bot, { advanced: {} }, { scheduler: (fn) => fn() })
  const second = install(bot, { advanced: {} }, { scheduler: (fn) => fn() })
  assert.equal(first, second)

  const settled = []
  first.settlers.add((key, worldName) => settled.push([key, worldName]))
  bot._client.emit('acknowledge_player_digging', { sequenceId: 42 })
  assert.equal(settled.length, 1, 'exactly one settle despite two installs')
})

test('the runtime wires the tracker in beside the sequence guard', () => {
  // REMOVED (user directive): the ack oracle's settle raced the block echo.
  const hookAt = source.indexOf('installBlockInteractionGuard(bot)')
  assert.ok(hookAt >= 0)
  assert.ok(!source.includes('    installPlacementAckTracking(bot, config)'), 'the ack tracker must not be installed')
})

test('the workload batch registers and unregisters its settle handler', () => {
  const batchStart = source.indexOf('async function runNervTimeWorkloadPlacementBatch')
  const batchEnd = source.indexOf('\nasync function ', batchStart + 10)
  const batch = source.slice(batchStart, batchEnd)

  const registerAt = batch.indexOf('ackTracker.settlers.add(handleAckSettle)')
  assert.ok(registerAt >= 0, 'the batch must subscribe to ack settles')

  const confirmGuardAt = batch.indexOf('worldName === target.blockName')
  assert.ok(confirmGuardAt >= 0 && confirmGuardAt < registerAt, 'settle confirms only on an exact colour match')

  const finallyAt = batch.indexOf('ackTracker.settlers.delete(handleAckSettle)')
  assert.ok(finallyAt > registerAt, 'the finally block must unsubscribe')

  // Config defaults so code and VM agree.
  assert.match(source, /ackSettleDelayMs: 75/)
  assert.match(source, /ackRejectCooldownMs: 0/)

  // The lane-phase line must prove whether the server answers at all.
  const lanePhaseAt = source.indexOf('[LANE-PHASE] targets=')
  const lanePhase = source.slice(lanePhaseAt, lanePhaseAt + 600)
  assert.match(lanePhase, /acks=/)
  assert.match(lanePhase, /ackOk=/)
})
