'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

// Exercise the real ranking function by evaluating just that definition.
function loadRanker() {
  const start = source.indexOf('function rankHotbarEvictionCandidates(')
  assert.ok(start >= 0, 'rankHotbarEvictionCandidates must exist')
  const end = source.indexOf('\nfunction chooseMaterialHotbarIndex(', start)
  assert.ok(end > start)

  const helpers = source.slice(
    source.indexOf('function countUpcomingTargetsByBlock('),
    source.indexOf('function rankHotbarEvictionCandidates(')
  )
  const hotbarSlot = 'function getHotbarWindowSlot(index) { return 36 + Math.max(0, Math.min(8, Math.floor(Number(index) || 0))) }'
  const body = source.slice(start, end)

  const factory = new Function(`
    ${hotbarSlot}
    ${helpers}
    ${body}
    return rankHotbarEvictionCandidates
  `)
  return factory()
}

function makeSlots(entries) {
  const slots = new Array(46).fill(null)
  entries.forEach(([index, name, count]) => {
    slots[36 + index] = { name, count, slot: 36 + index }
  })
  return slots
}

const targetsFor = (names) => names.map((blockName) => ({ blockName }))
const countOf = (counts) => (index) => counts[index] || 0

test('evicts a colour the horizon never uses before one it needs soon', () => {
  const ranker = loadRanker()
  const slots = makeSlots([
    [0, 'red_carpet', 64],
    [1, 'green_carpet', 64]
  ])
  // green is needed immediately; red is not needed at all in the window.
  const ranked = ranker(slots, targetsFor(['green_carpet', 'green_carpet']), countOf({ 0: 64, 1: 64 }))

  assert.equal(ranked[0].name, 'red_carpet')
  assert.equal(ranked[0].rank, 0)
})

test('evicts the farthest next use when every slot is still needed', () => {
  const ranker = loadRanker()
  const slots = makeSlots([
    [0, 'red_carpet', 64],
    [1, 'green_carpet', 64],
    [2, 'blue_carpet', 64]
  ])
  // blue is needed last, so it is the cheapest to give up.
  const ranked = ranker(
    slots,
    targetsFor(['red_carpet', 'green_carpet', 'green_carpet', 'green_carpet', 'blue_carpet']),
    countOf({ 0: 64, 1: 64, 2: 64 })
  )

  assert.equal(ranked[0].name, 'blue_carpet')
})

test('protects a colour whose stock cannot cover the horizon', () => {
  const ranker = loadRanker()
  // red has a nearly-empty stack and 8 placements ahead, so evicting it would
  // strand those placements mid-sprint. green has a full stack for 1 placement.
  const slots = makeSlots([
    [0, 'red_carpet', 3],
    [1, 'green_carpet', 64]
  ])
  const ranked = ranker(
    slots,
    targetsFor([
      'green_carpet',
      'red_carpet', 'red_carpet', 'red_carpet', 'red_carpet',
      'red_carpet', 'red_carpet', 'red_carpet', 'red_carpet'
    ]),
    countOf({ 0: 3, 1: 64 })
  )

  const red = ranked.find((entry) => entry.name === 'red_carpet')
  const green = ranked.find((entry) => entry.name === 'green_carpet')
  assert.equal(red.rank, 2, 'a colour whose stack cannot cover the horizon is rank 2')
  assert.equal(green.rank, 1)
  assert.equal(ranked[0].name, 'green_carpet')
})

test('a duplicated colour with spare stock is cheaper to evict than a sole copy', () => {
  const ranker = loadRanker()
  const slots = makeSlots([
    [0, 'red_carpet', 8],
    [1, 'red_carpet', 8],
    [2, 'green_carpet', 2]
  ])
  // Both hotbar red stacks together hold 16 for a horizon needing 2, so a red
  // slot is rank 1 (spare). green's only stack holds 2 for 5 placements: rank 2.
  const ranked = ranker(
    slots,
    targetsFor(['red_carpet', 'red_carpet', 'green_carpet', 'green_carpet', 'green_carpet', 'green_carpet', 'green_carpet']),
    countOf({ 0: 8, 1: 8, 2: 2 })
  )

  const dupRed = ranked.filter((entry) => entry.name === 'red_carpet')
  const green = ranked.find((entry) => entry.name === 'green_carpet')
  assert.equal(dupRed.every((entry) => entry.rank === 1), true)
  assert.equal(green.rank, 2)
  assert.equal(ranked[0].name, 'red_carpet')
})

test('an empty slot is never evicted by the ranker', () => {
  const ranker = loadRanker()
  const slots = makeSlots([[0, 'red_carpet', 64]])
  const ranked = ranker(slots, targetsFor(['red_carpet']), countOf({ 0: 64 }))
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].index, 0)
})
