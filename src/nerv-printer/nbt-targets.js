const MAP_WIDTH = 128
const MAP_HEIGHT = 128

function toNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeBlockName(value) {
  return String(value || '').replace(/^minecraft:/, '')
}

function createNbtTargetError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function collectCarpetBlocks(nbtData) {
  const palette = Array.isArray(nbtData?.palette) ? nbtData.palette : []
  const blocks = Array.isArray(nbtData?.blocks) ? nbtData.blocks : []
  const carpets = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const stateIndex = toNumber(block?.state, -1)
    if (!Number.isInteger(stateIndex) || stateIndex < 0 || stateIndex >= palette.length) continue

    const blockName = normalizeBlockName(palette[stateIndex]?.Name)
    if (!blockName.endsWith('_carpet')) continue

    const localPos = Array.isArray(block?.pos) ? block.pos : []
    const coordinates = localPos.map(Number)
    if (coordinates.length !== 3 || coordinates.some((coordinate) => !Number.isInteger(coordinate))) {
      throw createNbtTargetError('NBT_INVALID_CARPET_POSITION', `carpet block ${index} has invalid position ${JSON.stringify(localPos)}`)
    }

    carpets.push({
      blockName,
      localX: coordinates[0],
      localY: coordinates[1],
      localZ: coordinates[2]
    })
  }

  return carpets
}

function targetsFromNbt(nbtData, config = {}) {
  const machine = config.machine || {}
  const printer = config.printer || {}
  const printOffset = printer.printOffset || {}
  const corner = {
    x: toNumber(machine.mapCorner?.x, 0),
    y: toNumber(machine.mapCorner?.y, 64),
    z: toNumber(machine.mapCorner?.z, 0)
  }
  const offsets = {
    x: toNumber(printOffset.x, 0),
    y: toNumber(printOffset.y, 0),
    z: toNumber(printOffset.z, 0)
  }
  const ignored = new Set((printer.ignoredBlocks || []).map(normalizeBlockName))
  const northToSouth = printer.northToSouth !== false
  const carpets = collectCarpetBlocks(nbtData)
  if (!carpets.length) return []

  const minLocalX = Math.min(...carpets.map((block) => block.localX))
  const minLocalY = Math.min(...carpets.map((block) => block.localY))
  const minLocalZ = Math.min(...carpets.map((block) => block.localZ))
  const mapWidth = Math.max(1, toNumber(machine.mapSize?.width, 128))
  const mapHeight = Math.max(1, Math.floor(toNumber(machine.mapSize?.height, 128)))
  const rowMap = new Map()

  for (let index = 0; index < carpets.length; index += 1) {
    const carpet = carpets[index]
    const col = carpet.localX - minLocalX
    const row = carpet.localZ - minLocalZ
    if (col < 0 || col >= mapWidth) {
      throw createNbtTargetError('NBT_TARGET_OUT_OF_BOUNDS', `carpet target ${index} has column ${col}; expected 0-${mapWidth - 1}`)
    }
    if (row < 0 || row >= mapHeight) {
      throw createNbtTargetError('NBT_TARGET_OUT_OF_BOUNDS', `carpet target ${index} has row ${row}; expected 0-${mapHeight - 1}`)
    }
    if (ignored.has(carpet.blockName)) continue

    const x = corner.x + col + offsets.x
    const y = config.advanced?.useMapCornerYForNbtCarpets !== false
      ? corner.y + offsets.y
      : corner.y + (carpet.localY - minLocalY) + offsets.y
    const z = corner.z + row + offsets.z
    const target = {
      row,
      col,
      symbol: carpet.blockName,
      blockName: carpet.blockName,
      position: { x, y, z }
    }

    if (!rowMap.has(row)) rowMap.set(row, [])
    rowMap.get(row).push(target)
  }

  const rows = Array.from(rowMap.keys()).sort((left, right) => left - right)
  if (!northToSouth) rows.reverse()

  const targets = []
  for (const row of rows) {
    const line = rowMap.get(row).sort((left, right) => left.col - right.col)
    targets.push(...line)
  }
  return targets
}

module.exports = {
  MAP_HEIGHT,
  MAP_WIDTH,
  targetsFromNbt
}
