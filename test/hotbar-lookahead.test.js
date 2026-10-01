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

test('hotbar swaps bypass clickWindow so no burst pays a server round trip', () => {
  // Regression: bot.clickWindow() awaits confirmTransaction on 1.17+ (~150ms at
  // 6b6t ping) and sleeps up to DIG_CLICK_TIMEOUT (500ms) after a recent dig.
  // Awaiting it inside a 5-block burst stalled the sprint and dropped carpets.
  const start = source.indexOf('function silentHotbarSwap(')
  assert.ok(start >= 0, 'silentHotbarSwap must exist')
  const end = source.indexOf('\nasync function prepareHotbarForBatch(', start)
  const helper = source.slice(start, end)

  assert.match(helper, /bot\._client\.write\('window_click'/)
  assert.match(helper, /mode: 2/)
  assert.match(helper, /bot\.lastDigTime = null/)
  assert.doesNotMatch(helper, /await/)
  assert.doesNotMatch(helper, /clickWindow/)
  // The cursor must be serialized by the registry: a hand-rolled object fails on
  // the component protocol ("Serialization error for play.toServer : SizeOf
  // error for undefined"), desyncs the server transaction and drops the session.
  assert.match(helper, /prismarineItem\(bot\.version\)\.toNotch\(window\.selectedItem \|\| null\)/)
  assert.doesNotMatch(helper, /cursorItem: \{/)

  // And the serialized shape must be what this protocol version expects.
  const prismarineItem = require('prismarine-item')
  assert.deepEqual(prismarineItem('26.1.2').toNotch(null), { itemCount: 0, components: [], removeComponents: [] })
  assert.deepEqual(prismarineItem('1.20').toNotch(null), { present: false })

  // Every hotbar-swap site routes through the helper.
  const selectStart = source.indexOf('async function selectHotbarMaterial(')
  const selectEnd = source.indexOf('\nfunction ', selectStart + 10)
  assert.match(source.slice(selectStart, selectEnd), /silentHotbarSwap\(bot, source\.slot, hotbarIndex\)/)

  const prepareStart = source.indexOf('async function prepareHotbarForBatch(')
  const prepareEnd = source.indexOf('\nasync function equipMaterial(', prepareStart)
  const prepare = source.slice(prepareStart, prepareEnd)
  assert.doesNotMatch(prepare, /clickWindow/)
  assert.equal((prepare.match(/silentHotbarSwap\(/g) || []).length, 2)
})

test('a resume seeds the confirmed-placement ledger so restarts do not re-place the map', () => {
  // Regression: the ledger is in-memory, so after a restart every previously
  // placed carpet read as client-world "missing" and repair pass 1 inflated
  // 203 real errors into 1348 by re-walking the whole canvas.
  assert.match(source, /if \(resumeFrom > 0\) \{/)
  assert.match(source, /if \(!\(bot\.__nervConfirmedPlaced instanceof Set\)\) bot\.__nervConfirmedPlaced = new Set\(\)/)
  assert.match(source, /Seeded \$\{bot\.__nervConfirmedPlaced\.size\} confirmed placement\(s\) from saved progress/)

  // Seed must run before the pending slice is derived from resumeFrom.
  const seed = source.indexOf('Seeded ${bot.__nervConfirmedPlaced.size}')
  const pending = source.indexOf('const pending = orderedTargets.slice(resumeFrom)')
  assert.ok(seed >= 0 && pending >= 0, 'both markers must exist')
  assert.ok(seed < pending, 'the ledger must be seeded before pending targets are derived')
})

test('selectedMaterialMatches requires the selected slot and heldItem to agree', () => {
  // bot.heldItem is a live getter over inventory.slots[36 + quickBarSlot], so it
  // never lags a predicted swap. An earlier fallback that trusted the selected
  // slot alone masked real desyncs instead of catching them.
  const start = source.indexOf('function selectedMaterialMatches(')
  const body = source.slice(start, source.indexOf('\nasync function waitForSelectedMaterialReady(', start))

  assert.match(body, /return selectedMatches && heldMatches/)
  assert.doesNotMatch(body, /bot\.heldItem == null/)
  assert.doesNotMatch(body, /The predicted selected slot is the authoritative signal/)
})
