'use strict'

// Some Velocity/ViaVersion backend handoffs advertise the 26.1.2 PLAY schema
// but encode items nested inside a container component as:
//   present, itemId, itemCount, addedComponents, removedComponents
// The normal Slot schema is:
//   itemCount, itemId, addedComponents, removedComponents
//
// This is most visible with named shulker boxes in a window_items snapshot. A
// normal ProtoDef decode then treats itemCount as a component count, destroys
// the parser stream, and leaves the bot with no authoritative inventory. The
// repair below is packet- and structure-specific and succeeds only when the
// complete frame can be decoded without trailing bytes.

const WINDOW_ITEMS_PACKET_ID_26_1_2 = 0x12
const MAX_WINDOW_ITEMS = 1024
const MAX_SLOT_COMPONENTS = 256
const MAX_CONTAINER_CONTENTS = 256
const MAX_EMBEDDED_ITEM_COUNT = 127

function readVarInt (buffer, offset) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer')
  let value = 0
  let shift = 0
  let cursor = offset
  while (cursor < buffer.length && shift <= 28) {
    const byte = buffer[cursor]
    cursor += 1
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, size: cursor - offset }
    }
    shift += 7
  }
  throw new Error('invalid or incomplete VarInt')
}

function readProto (parser, buffer, offset, type) {
  const result = parser?.proto?.read?.(buffer, offset, type)
  if (!result || !Number.isInteger(result.size) || result.size <= 0 || offset + result.size > buffer.length) {
    throw new Error(`invalid ${type} result at offset ${offset}`)
  }
  return result
}

function readCount (buffer, offset, label, maximum) {
  const result = readVarInt(buffer, offset)
  if (result.value > maximum) throw new Error(`${label} exceeds ${maximum}: ${result.value}`)
  return result
}

function makeSlotValue (itemCount, itemId, addedComponentCount, removedComponentCount, components, removeComponents) {
  if (itemCount === 0) return { itemCount: 0 }
  return {
    itemCount,
    itemId,
    addedComponentCount,
    removedComponentCount,
    components,
    removeComponents
  }
}

function readCompatibleComponent (parser, buffer, offset, stats, depth) {
  try {
    return readProto(parser, buffer, offset, 'SlotComponent')
  } catch (standardError) {
    const typeResult = readProto(parser, buffer, offset, 'SlotComponentType')
    if (typeResult.value !== 'container') throw standardError
    return readAlternateContainerComponent(parser, buffer, offset, typeResult, stats, depth)
  }
}

function readComponentLists (parser, buffer, offset, addedComponentCount, removedComponentCount, stats, depth) {
  const components = []
  const removeComponents = []
  let cursor = offset

  for (let index = 0; index < addedComponentCount; index += 1) {
    const component = readCompatibleComponent(parser, buffer, cursor, stats, depth)
    components.push(component.value)
    cursor += component.size
  }
  for (let index = 0; index < removedComponentCount; index += 1) {
    const componentType = readProto(parser, buffer, cursor, 'SlotComponentType')
    removeComponents.push({ type: componentType.value })
    cursor += componentType.size
  }

  return { components, removeComponents, cursor }
}

function readAlternateEmbeddedSlot (parser, buffer, offset, stats, depth) {
  if (depth > 8) throw new Error('nested container compatibility depth exceeded')
  const present = readVarInt(buffer, offset)
  let cursor = offset + present.size
  if (present.value === 0) {
    return { value: { itemCount: 0 }, size: present.size }
  }
  if (present.value !== 1) throw new Error(`invalid embedded-slot presence value: ${present.value}`)

  const itemId = readVarInt(buffer, cursor)
  cursor += itemId.size
  const itemCount = readCount(buffer, cursor, 'embedded item count', MAX_EMBEDDED_ITEM_COUNT)
  cursor += itemCount.size
  if (itemCount.value === 0) throw new Error('present embedded slot has zero item count')

  const added = readCount(buffer, cursor, 'embedded added component count', MAX_SLOT_COMPONENTS)
  cursor += added.size
  const removed = readCount(buffer, cursor, 'embedded removed component count', MAX_SLOT_COMPONENTS)
  cursor += removed.size
  const lists = readComponentLists(parser, buffer, cursor, added.value, removed.value, stats, depth + 1)
  cursor = lists.cursor
  stats.embeddedItems += 1

  return {
    value: makeSlotValue(
      itemCount.value,
      itemId.value,
      added.value,
      removed.value,
      lists.components,
      lists.removeComponents
    ),
    size: cursor - offset
  }
}

function readAlternateContainerComponent (parser, buffer, offset, typeResult, stats, depth) {
  let cursor = offset + typeResult.size
  const count = readCount(buffer, cursor, 'container content count', MAX_CONTAINER_CONTENTS)
  cursor += count.size
  const contents = []
  for (let index = 0; index < count.value; index += 1) {
    const slot = readAlternateEmbeddedSlot(parser, buffer, cursor, stats, depth + 1)
    contents.push(slot.value)
    cursor += slot.size
  }
  stats.containerComponents += 1
  return {
    value: {
      type: 'container',
      data: { contents }
    },
    size: cursor - offset
  }
}

function readCompatibleTopLevelSlot (parser, buffer, offset, stats) {
  try {
    return readProto(parser, buffer, offset, 'Slot')
  } catch (standardError) {
    let cursor = offset
    const itemCount = readVarInt(buffer, cursor)
    cursor += itemCount.size
    if (itemCount.value === 0) throw standardError

    const itemId = readVarInt(buffer, cursor)
    cursor += itemId.size
    const added = readCount(buffer, cursor, 'added component count', MAX_SLOT_COMPONENTS)
    cursor += added.size
    const removed = readCount(buffer, cursor, 'removed component count', MAX_SLOT_COMPONENTS)
    cursor += removed.size
    const lists = readComponentLists(parser, buffer, cursor, added.value, removed.value, stats, 0)
    cursor = lists.cursor

    return {
      value: makeSlotValue(
        itemCount.value,
        itemId.value,
        added.value,
        removed.value,
        lists.components,
        lists.removeComponents
      ),
      size: cursor - offset
    }
  }
}

function repairWindowItemsPacket (parser, buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  let cursor = 0
  const packetId = readVarInt(buffer, cursor)
  cursor += packetId.size
  if (packetId.value !== WINDOW_ITEMS_PACKET_ID_26_1_2) return null

  const stats = { containerComponents: 0, embeddedItems: 0 }
  const windowId = readProto(parser, buffer, cursor, 'ContainerID')
  cursor += windowId.size
  const stateId = readVarInt(buffer, cursor)
  cursor += stateId.size
  const itemCount = readCount(buffer, cursor, 'window item count', MAX_WINDOW_ITEMS)
  cursor += itemCount.size

  const items = []
  for (let index = 0; index < itemCount.value; index += 1) {
    const slot = readCompatibleTopLevelSlot(parser, buffer, cursor, stats)
    items.push(slot.value)
    cursor += slot.size
  }
  const carriedItem = readCompatibleTopLevelSlot(parser, buffer, cursor, stats)
  cursor += carriedItem.size

  if (stats.containerComponents === 0) return null
  if (cursor !== buffer.length) {
    throw new Error(`repaired window_items left ${buffer.length - cursor} trailing byte(s)`)
  }

  return {
    packet: {
      data: {
        name: 'window_items',
        params: {
          windowId: windowId.value,
          stateId: stateId.value,
          items,
          carriedItem: carriedItem.value
        }
      },
      metadata: { size: buffer.length, nervRepaired: true },
      buffer: buffer.slice(0),
      fullBuffer: buffer
    },
    stats
  }
}

module.exports = {
  WINDOW_ITEMS_PACKET_ID_26_1_2,
  readVarInt,
  repairWindowItemsPacket
}
