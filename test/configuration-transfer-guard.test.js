'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const {
  installConfigurationTransferGuard,
  waitForConfigurationTransferWorldSettle
} = require('../src/nerv-printer/connection/configuration-transfer-guard')

function makeBot (physicsEnabled = true) {
  const bot = new EventEmitter()
  const client = new EventEmitter()
  const writes = []
  const controls = []
  const pathfinderStops = []
  client.state = 'play'
  client.write = (name, packet) => {
    writes.push({ name, packet })
    return writes.length
  }
  bot._client = client
  bot.physicsEnabled = physicsEnabled
  bot.clearControlStates = () => controls.push('cleared')
  bot.pathfinder = {
    stop: () => pathfinderStops.push('stop'),
    setGoal: (goal) => pathfinderStops.push(goal == null ? 'clear-goal' : 'set-goal')
  }
  return { bot, client, writes, controls, pathfinderStops }
}

test('blocks play packets and cancels stale navigation throughout a backend configuration transfer', () => {
  const { bot, client, writes, controls, pathfinderStops } = makeBot()
  const logs = []
  const guard = installConfigurationTransferGuard(bot, { logger: (line) => logs.push(line) })

  client.write('position', { x: 1 })
  client.emit('packet', {}, { name: 'start_configuration', state: 'play' })
  client.emit('packet', {}, { name: 'start_configuration', state: 'configuration' })
  client.write('configuration_acknowledged', {})
  client.write('settings', {})
  client.write('position', { x: 2 })
  client.write('entity_action', { actionId: 1 })

  assert.equal(bot.physicsEnabled, false)
  assert.equal(bot.__nervConfigurationTransferActive, true)
  assert.equal(bot.__nervRuntimeWorldGeneration, 1)
  assert.equal(bot.__nervPathfinderAbortGeneration, 1)
  assert.equal(bot.__nervRuntimeWorldChangePending, true)
  assert.deepEqual(controls, ['cleared', 'cleared'])
  assert.deepEqual(pathfinderStops, ['stop', 'clear-goal', 'stop', 'clear-goal'])
  assert.deepEqual(writes.map((entry) => entry.name), [
    'position',
    'configuration_acknowledged',
    'settings'
  ])
  assert.equal(guard.state.blockedPackets, 2)

  client.emit('packet', {}, { name: 'finish_configuration', state: 'configuration' })
  client.write('position_look', { x: 3 })
  assert.equal(guard.state.blockedPackets, 3)
  assert.equal(bot.physicsEnabled, false)

  client.state = 'play'
  client.emit('packet', {}, { name: 'position', state: 'play' })
  client.write('position_look', { x: 4 })

  assert.equal(bot.physicsEnabled, true)
  assert.equal(bot.__nervConfigurationTransferActive, false)
  assert.ok(Number.isFinite(bot.__nervConfigurationTransferPlayResumedAt))
  assert.equal(bot.__nervConfigurationTransferPlayResumedAt, guard.state.lastPlayResumeAt)
  assert.equal(bot.__nervRuntimeWorldGeneration, 1)
  assert.equal(writes.at(-1).name, 'position_look')
  assert.match(logs.at(-1), /blockedPackets=3/)
  assert.match(logs.at(-1), /entity_action,position,position_look/)
})

test('holds machine work through the destination worker settle window without reconnecting', async () => {
  const { bot, client } = makeBot()
  installConfigurationTransferGuard(bot)
  let nowMs = 10_000
  const waits = []
  const reports = []

  client.emit('packet', {}, { name: 'start_configuration', state: 'play' })
  const pending = waitForConfigurationTransferWorldSettle(bot, {
    settleMs: 4000,
    pollMs: 500,
    now: () => nowMs,
    wait: async (ms) => {
      waits.push(ms)
      nowMs += ms
      if (bot.__nervConfigurationTransferActive) {
        client.state = 'play'
        client.emit('packet', {}, { name: 'position', state: 'play' })
        bot.__nervConfigurationTransferPlayResumedAt = nowMs
      }
    },
    onWait: (entry) => reports.push(entry)
  })

  const result = await pending
  assert.equal(bot.__nervConfigurationTransferActive, false)
  assert.equal(result.waitedMs, 4500)
  assert.deepEqual(waits, [500, 500, 500, 500, 500, 500, 500, 500, 500])
  assert.equal(reports.length, 1)
  assert.equal(reports[0].active, true)
})

test('increments the runtime world generation for each distinct backend switch', () => {
  const { bot, client } = makeBot()
  installConfigurationTransferGuard(bot)

  client.emit('packet', {}, { name: 'start_configuration', state: 'play' })
  client.state = 'play'
  client.emit('packet', {}, { name: 'position', state: 'play' })
  client.emit('packet', {}, { name: 'start_configuration', state: 'play' })

  assert.equal(bot.__nervRuntimeWorldGeneration, 2)
})

test('preserves an intentionally disabled physics setting', () => {
  const { bot, client } = makeBot(false)
  installConfigurationTransferGuard(bot)

  client.emit('packet', {}, { name: 'start_configuration', state: 'play' })
  client.state = 'play'
  client.emit('packet', {}, { name: 'position', state: 'play' })

  assert.equal(bot.physicsEnabled, false)
})

test('records a valid server transfer target without exposing packet contents', () => {
  const { bot, client } = makeBot()
  const logs = []
  const guard = installConfigurationTransferGuard(bot, { logger: (line) => logs.push(line) })

  client.emit('transfer', { host: 'backend.example', port: 25566, secret: 'do-not-log' })

  assert.deepEqual(guard.state.transferTarget, { host: 'backend.example', port: 25566 })
  assert.deepEqual(bot.__nervServerTransferTarget, { host: 'backend.example', port: 25566 })
  assert.match(logs.at(-1), /backend\.example:25566/)
  assert.doesNotMatch(logs.join('\n'), /do-not-log/)
})

test('repairs alternate nested container slots without discarding window inventory', () => {
  const { bot, client } = makeBot()
  const logs = []
  const parser = require('minecraft-protocol/src/transforms/serializer').createDeserializer({
    state: 'play',
    isServer: false,
    version: '26.1.2',
    noErrorLogging: true
  })
  client.deserializer = parser
  installConfigurationTransferGuard(bot, { logger: (line) => logs.push(line) })

  client.emit('packet', {}, { name: 'start_configuration', state: 'play' })
  client.state = 'play'
  client.emit('packet', {}, { name: 'position', state: 'play' })

  const malformed = Buffer.from([
    0x12, // window_items
    0x01, // window id
    0x01, // state id
    0x01, // one top-level item
    0x01, 0xc8, 0x04, 0x01, 0x00, // count=1, item=584, one component
    0x4b, 0x02, // container component with two entries
    0x01, 0xd0, 0x09, 0x40, 0x00, 0x00, // present, item=1232, count=64
    0x00, // empty embedded entry
    0x00 // empty carried item
  ])
  assert.throws(() => parser.proto.parsePacketBuffer('packet', malformed), /array|PartialRead|buffer|read/i)

  const result = parser.parsePacketBuffer(malformed)
  const container = result.data.params.items[0].components[0]

  assert.equal(result.data.name, 'window_items')
  assert.equal(result.data.params.items.length, 1)
  assert.equal(result.data.params.carriedItem.itemCount, 0)
  assert.equal(container.type, 'container')
  assert.equal(container.data.contents.length, 2)
  assert.equal(container.data.contents[0].itemCount, 64)
  assert.equal(container.data.contents[0].itemId, 1232)
  assert.equal(container.data.contents[1].itemCount, 0)
  assert.equal(result.metadata.nervRepaired, true)
  assert.match(logs.at(-1), /continuing the same connection/)
  assert.match(logs.at(-1), /embedded item/)
})

test('keeps unrelated protocol parse errors fatal and attaches bounded diagnostics', () => {
  const { bot, client } = makeBot()
  const parser = {
    parsePacketBuffer () {
      throw new Error('different protocol failure')
    }
  }
  client.deserializer = parser
  installConfigurationTransferGuard(bot)

  client.emit('packet', {}, { name: 'start_configuration', state: 'play' })
  client.state = 'play'
  client.emit('packet', {}, { name: 'position', state: 'play' })

  assert.throws(
    () => parser.parsePacketBuffer(Buffer.from([0x05, 0xaa, 0xbb])),
    (error) => {
      assert.equal(error.message, 'different protocol failure')
      assert.equal(error.nervPacketId, 5)
      assert.deepEqual(error.buffer, Buffer.from([0x05, 0xaa, 0xbb]))
      return true
    }
  )
})
