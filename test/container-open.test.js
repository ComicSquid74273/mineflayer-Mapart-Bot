'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const { Vec3 } = require('vec3')

const {
  CONTAINER_PROTOCOL_READ_ERROR_CODE,
  assertLoadedBlockTarget,
  assertLoadedContainerTarget,
  getSupportStockBlockReachLimit,
  getReferenceBlockInteraction,
  isContainerProtocolReadError,
  openBlockContainerFast,
  shouldAllowContainerBlockReach,
  shouldAllowSupportStockBlockReach
} = require('../src/nerv-printer/container-open')

function makeBot(activate) {
  const bot = new EventEmitter()
  bot.activateBlock = activate || (async () => {})
  return bot
}

test('recognizes the slot component PartialReadError from container packets', () => {
  const error = new Error('Missing characters in string while reading SlotComponent')
  error.name = 'PartialReadError'
  error.partialReadError = true
  assert.equal(isContainerProtocolReadError(error), true)
})

test('loaded station preflight rejects air or water before navigation', () => {
  const position = new Vec3(10, 64, 10)
  for (const name of ['air', 'water']) {
    assert.throws(
      () => assertLoadedContainerTarget({ name, position }, position, ['chest', 'barrel']),
      (error) => error.code === 'CONFIGURED_CONTAINER_MISSING' &&
        error.message.includes(`found=${name}`)
    )
  }
})

test('loaded station preflight accepts configured containers and defers unloaded chunks', () => {
  const position = new Vec3(10, 64, 10)
  const chest = { name: 'chest', position }
  assert.equal(assertLoadedContainerTarget(chest, position, ['chest', 'barrel']), chest)
  assert.equal(assertLoadedContainerTarget(null, position, ['chest', 'barrel']), null)
})

test('container access can require the captured checkpoint instead of edge-of-reach fallback', () => {
  assert.equal(shouldAllowContainerBlockReach({ strictAccess: true }), true)
  assert.equal(shouldAllowContainerBlockReach({ strictAccess: true, allowBlockReach: true }), true)
  assert.equal(shouldAllowContainerBlockReach({ strictAccess: true, allowBlockReach: false }), false)
  assert.equal(shouldAllowContainerBlockReach({ strictAccess: false, allowBlockReach: true }), false)
})

test('support stock uses verified reachable sides with a tight food and XP limit', () => {
  assert.equal(shouldAllowSupportStockBlockReach('map'), true)
  assert.equal(shouldAllowSupportStockBlockReach('pane'), true)
  assert.equal(shouldAllowSupportStockBlockReach('food'), true)
  assert.equal(shouldAllowSupportStockBlockReach('xp'), true)
  assert.equal(shouldAllowSupportStockBlockReach('unknown'), false)
  assert.equal(getSupportStockBlockReachLimit('map'), null)
  assert.equal(getSupportStockBlockReachLimit('pane'), null)
  assert.equal(getSupportStockBlockReachLimit('food'), 2.25)
  assert.equal(getSupportStockBlockReachLimit('xp'), 2.25)
  assert.equal(getSupportStockBlockReachLimit('unknown'), null)
})

test('loaded block preflight validates cartography and anvil targets', () => {
  const position = new Vec3(10, 64, 10)
  const table = { name: 'cartography_table', position }
  assert.equal(assertLoadedBlockTarget(table, position, ['cartography_table']), table)
  assert.equal(assertLoadedBlockTarget(null, position, ['cartography_table']), null)
  assert.throws(
    () => assertLoadedBlockTarget({ name: 'water', position }, position, ['anvil', 'chipped_anvil']),
    (error) => error.code === 'CONFIGURED_BLOCK_MISSING' && error.message.includes('found=water')
  )
})

test('opens from the authoritative windowOpen event and removes temporary listeners', async () => {
  const window = { type: 'minecraft:generic_9x6', inventoryStart: 54 }
  const bot = makeBot(async () => {
    setImmediate(() => bot.emit('windowOpen', window))
  })

  const opened = await openBlockContainerFast(bot, { name: 'chest' }, { timeoutMs: 250 })
  assert.equal(opened, window)
  assert.equal(bot.listenerCount('windowOpen'), 0)
  assert.equal(bot.listenerCount('error'), 0)
  assert.equal(bot.listenerCount('end'), 0)
})

test('uses the reference closest block face with a cursor on that face', async () => {
  const block = { name: 'chest', position: new Vec3(10, 64, 10) }
  let activation = null
  const bot = makeBot(async (...args) => {
    activation = args
    setImmediate(() => bot.emit('windowOpen', { type: 'minecraft:generic_9x6', inventoryStart: 54 }))
  })
  bot.entity = { position: new Vec3(10.5, 64, 13), eyeHeight: 1.62 }

  const interaction = getReferenceBlockInteraction(bot, block)
  assert.equal(interaction.face, 3)
  assert.deepEqual(interaction.direction, new Vec3(0, 0, 1))
  assert.deepEqual(interaction.cursorPos, new Vec3(0.5, 0.5, 0.999))

  await openBlockContainerFast(bot, block, { timeoutMs: 250 })
  assert.equal(activation[0], block)
  assert.deepEqual(activation[1], new Vec3(0, 0, 1))
  assert.deepEqual(activation[2], new Vec3(0.5, 0.5, 0.999))
})

test('rejects a malformed container packet immediately and does not leave a window waiter', async () => {
  const bot = makeBot(async () => {
    setImmediate(() => {
      const error = new Error('Missing characters in string; SlotComponent anonymousNbt')
      error.name = 'PartialReadError'
      bot.emit('error', error)
    })
  })

  await assert.rejects(
    openBlockContainerFast(bot, { name: 'chest' }, { timeoutMs: 5000 }),
    (error) => error.code === CONTAINER_PROTOCOL_READ_ERROR_CODE
  )
  assert.equal(bot.listenerCount('windowOpen'), 0)
  assert.equal(bot.listenerCount('error'), 0)
  assert.equal(bot.listenerCount('end'), 0)
})

test('uses a bounded open timeout and cleans up after a silent server', async () => {
  const bot = makeBot()
  await assert.rejects(
    openBlockContainerFast(bot, { name: 'chest' }, { timeoutMs: 20 }),
    /open-container-timeout-20ms/
  )
  assert.equal(bot.listenerCount('windowOpen'), 0)
  assert.equal(bot.listenerCount('error'), 0)
  assert.equal(bot.listenerCount('end'), 0)
})
