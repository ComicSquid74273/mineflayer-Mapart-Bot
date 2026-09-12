'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')

const {
  getReferenceBlockInteraction,
  getVisibleBlockInteraction,
  installBlockInteractionGuard,
  sendSneakRelease
} = require('../src/nerv-printer/block-interaction')

function makeBot() {
  const writes = []
  const activations = []
  const bot = {
    _client: {
      write(name, packet) { writes.push({ name, packet }) }
    },
    entity: { id: 42, position: new Vec3(10.5, 64, 13), eyeHeight: 1.62 },
    getControlState: () => false,
    setControlState: () => {},
    supportFeature: feature => feature === 'blockPlaceHasInsideBlock',
    async lookAt(point) { this.lastLookAt = point },
    swingArm() {},
    async activateBlock(...args) {
      activations.push(args)
      this._client.write('block_place', { sequence: 0 })
    }
  }
  return { bot, writes, activations }
}

test('guard can be installed after Mineflayer injects activateBlock', async () => {
  const writes = []
  const bot = {
    _client: { write: (name, packet) => writes.push({ name, packet }) },
    entity: { id: 7, eyeHeight: 1.62, position: new Vec3(0.5, 0, 2.5) },
    world: {},
    supportFeature: (name) => name === 'blockPlaceHasInsideBlock',
    lookAt: async () => {},
    swingArm: () => {}
  }

  assert.equal(installBlockInteractionGuard(bot), null)
  bot.activateBlock = async () => {}

  const guard = installBlockInteractionGuard(bot)
  assert.ok(guard)
  await bot.activateBlock({ position: new Vec3(0, 0, 0) })
  assert.equal(writes.at(-1).name, 'block_place')
  assert.equal(guard.state.sentInteractions, 1)
})

test('reference block interaction chooses the neighbouring face closest to the eyes and hits that face', () => {
  const { bot } = makeBot()
  const interaction = getReferenceBlockInteraction(bot, {
    position: new Vec3(10, 64, 10)
  })
  assert.equal(interaction.face, 3)
  assert.deepEqual(interaction.direction, new Vec3(0, 0, 1))
  assert.deepEqual(interaction.cursorPos, new Vec3(0.5, 0.5, 0.999))
})

test('reference block interaction puts an upper-face hit on the exposed top surface', () => {
  const { bot } = makeBot()
  bot.entity.position = new Vec3(10.5, 66, 10.5)
  const interaction = getReferenceBlockInteraction(bot, {
    position: new Vec3(10, 64, 10)
  })
  assert.equal(interaction.face, 1)
  assert.deepEqual(interaction.direction, new Vec3(0, 1, 0))
  assert.deepEqual(interaction.cursorPos, new Vec3(0.5, 0.999, 0.5))
})

test('block interaction guard supplies reference hit data and releases stale sneaking', async () => {
  const { bot, writes, activations } = makeBot()
  installBlockInteractionGuard(bot)
  const block = { position: new Vec3(10, 64, 10) }
  await bot.activateBlock(block)

  assert.equal(activations.length, 0)
  assert.deepEqual(bot.lastLookAt, new Vec3(10.5, 64.5, 10.999))
  assert.equal(writes[0].name, 'entity_action')
  assert.equal(writes[0].packet.actionId, 1)
  assert.equal(writes[1].name, 'block_place')
  assert.equal(writes[1].packet.direction, 3)
  assert.equal(writes[1].packet.cursorZ, 0.999)
  assert.equal(writes[1].packet.sequence, 2)
})

test('sneak release always sends the server packet even when the local control was true', () => {
  const { bot, writes } = makeBot()
  const controls = []
  bot.getControlState = () => true
  bot.setControlState = (name, value) => controls.push({ name, value })

  sendSneakRelease(bot)

  assert.deepEqual(controls, [{ name: 'sneak', value: false }])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].name, 'entity_action')
  assert.equal(writes[0].packet.actionId, 1)
})

test('visible interaction aims at an exposed side when the block center is obstructed', async () => {
  const { bot, writes } = makeBot()
  const block = { position: new Vec3(10, 64, 10) }
  bot.world = {
    raycast(_eye, direction) {
      // Only rays aimed low enough at the exposed south side reach the target;
      // center/top rays represent the glass block above it.
      if (direction.z >= 0 || direction.y > -0.45) {
        return { position: new Vec3(10, 65, 10), face: 3, intersect: new Vec3(10.5, 65, 11) }
      }
      return { position: block.position, face: 3, intersect: new Vec3(10.25, 64.875, 11) }
    }
  }

  const interaction = getVisibleBlockInteraction(bot, block)
  assert.equal(interaction.visible, true)
  assert.equal(interaction.face, 3)
  assert.deepEqual(interaction.direction, new Vec3(0, 0, 1))
  assert.deepEqual(interaction.cursorPos, new Vec3(0.5, 0.5, 0.999))

  installBlockInteractionGuard(bot)
  await bot.activateBlock(block)
  assert.deepEqual(bot.lastLookAt, new Vec3(10.5, 64.5, 10.999))
  assert.equal(writes.at(-1).name, 'block_place')
  assert.equal(writes.at(-1).packet.direction, 3)
  assert.equal(writes.at(-1).packet.cursorZ, 0.999)
})

test('visible interaction avoids a solid neighbour above and selects the exposed side', () => {
  const { bot } = makeBot()
  const block = { position: new Vec3(10, 64, 10) }
  bot.blockAt = (position) => {
    if (position.equals(new Vec3(10, 65, 10))) return { name: 'glass', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  }
  bot.world = {
    raycast() {
      return { position: block.position, face: 1, intersect: new Vec3(10.5, 64.875, 10.75) }
    }
  }

  const interaction = getVisibleBlockInteraction(bot, block)
  assert.equal(interaction.visible, true)
  assert.equal(interaction.face, 3)
  assert.deepEqual(interaction.direction, new Vec3(0, 0, 1))
  assert.deepEqual(interaction.cursorPos, new Vec3(0.5, 0.75, 0.999))
})

test('compact containers prefer a ray-confirmed side over an exposed top face', () => {
  const { bot } = makeBot()
  const block = { name: 'chest', position: new Vec3(10, 64, 10) }
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
  bot.world = {
    raycast() {
      return { position: block.position }
    }
  }

  const interaction = getVisibleBlockInteraction(bot, block)
  assert.equal(interaction.visible, true)
  assert.equal(interaction.face, 3)
  assert.deepEqual(interaction.cursorPos, new Vec3(0.5, 0.75, 0.999))
})

test('block and item use packets share a monotonically increasing interaction sequence', () => {
  const { bot, writes } = makeBot()
  const guard = installBlockInteractionGuard(bot)

  bot._client.write('block_place', { sequence: 0, marker: 'first' })
  bot._client.write('block_place', { sequence: 0, marker: 'second' })
  bot._client.write('use_item', { sequence: 1, marker: 'third' })
  bot._client.write('use_item', { sequence: 9, marker: 'external-high-water' })
  bot._client.write('block_place', { sequence: 0, marker: 'after-high-water' })

  const interactions = writes.filter(({ name }) => name === 'block_place' || name === 'use_item')
  assert.deepEqual(interactions.map(({ packet }) => packet.sequence), [2, 3, 4, 9, 10])
  assert.equal(guard.state.nextSequence, 11)
})
