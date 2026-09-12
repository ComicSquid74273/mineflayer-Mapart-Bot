'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MINECRAFT_ANVIL_NAME_MAX_LENGTH,
  buildAnvilRenameTarget
} = require('../src/nerv-printer/anvil-name')

test('anvil rename keeps the complete NBT basename when it fits Minecraft limit', () => {
  const sourceName = 'Avatar_ The Last Airbender_Skynet_0_3.nbt'

  assert.equal(buildAnvilRenameTarget(sourceName), 'Avatar_ The Last Airbender_Skynet_0_3')
})

test('anvil rename removes the extension and caps names at Minecraft limit', () => {
  const sourceName = `${'a'.repeat(MINECRAFT_ANVIL_NAME_MAX_LENGTH + 5)}.nbt`
  const renameTarget = buildAnvilRenameTarget(sourceName)

  assert.equal(MINECRAFT_ANVIL_NAME_MAX_LENGTH, 50)
  assert.equal(renameTarget, 'a'.repeat(50))
  assert.equal(renameTarget.length, 50)
})

test('anvil rename falls back to map for a missing source name', () => {
  assert.equal(buildAnvilRenameTarget(), 'map')
})
