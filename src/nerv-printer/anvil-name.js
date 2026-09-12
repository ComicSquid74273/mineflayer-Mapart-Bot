'use strict'

const path = require('path')

const MINECRAFT_ANVIL_NAME_MAX_LENGTH = 50

function buildAnvilRenameTarget(sourceName) {
  return String(path.parse(sourceName || 'map').name || 'map')
    .slice(0, MINECRAFT_ANVIL_NAME_MAX_LENGTH)
}

module.exports = {
  MINECRAFT_ANVIL_NAME_MAX_LENGTH,
  buildAnvilRenameTarget
}
