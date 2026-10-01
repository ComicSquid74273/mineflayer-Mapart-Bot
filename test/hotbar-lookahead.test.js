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
  const toNumber = 'function toNumber(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d }'
  const body = source.slice(start, end)

  // The quantity helpers live beside the ranker and are exercised for real below.
  const availStart = source.indexOf('function buildMaterialAvailability(')
  const availEnd = source.indexOf('// Eviction rank for one hotbar slot')
  const availability = source.slice(availStart, availEnd)

  const factory = new Function(`
    ${hotbarSlot}
    ${toNumber}
    ${helpers}
    ${availability}
    ${body}
    return {
      rank: rankHotbarEvictionCandidates,
      buildMaterialAvailability,
      burstMaterialsReady,
      countUpcomingDemand
    }
  `)
  const loaded = factory()
  rankHotbarEvictionCandidates = loaded.rank
  buildMaterialAvailability = loaded.buildMaterialAvailability
  burstMaterialsReady = loaded.burstMaterialsReady
  countUpcomingDemand = loaded.countUpcomingDemand
  return loaded.rank
}

let rankHotbarEvictionCandidates = null
let buildMaterialAvailability = null
let burstMaterialsReady = null
let countUpcomingDemand = null

function loadMaterialHelpers() {
  loadRanker()
  return { buildMaterialAvailability, burstMaterialsReady, countUpcomingDemand }
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
  // With no main-inventory stock, red's 3 carpets cannot cover 8 placements: the
  // colour is short even with everything, so it is protected (rank 3) and a restock
  // is the correct response, not an eviction.
  assert.equal(red.rank, 3, 'a colour short even with main stock is protected')
  assert.equal(green.rank, 1)
  assert.equal(ranked[0].name, 'green_carpet')
})

test('main-inventory stock downgrades a protected colour to evictable', () => {
  const ranker = loadRanker()
  // Same shape as the protected case, but red has 20 carpets waiting in the main
  // inventory. Losing the hotbar slot now costs one staging packet rather than a
  // restock trip, so red drops from protected (3) to rank 2.
  const slots = makeSlots([
    [0, 'red_carpet', 3],
    [1, 'green_carpet', 64]
  ])
  const window = targetsFor([
    'green_carpet',
    'red_carpet', 'red_carpet', 'red_carpet', 'red_carpet',
    'red_carpet', 'red_carpet', 'red_carpet', 'red_carpet'
  ])
  const ranked = ranker(slots, window, countOf({ 0: 3, 1: 64 }), (name) => (name === 'red_carpet' ? 20 : 0))

  const red = ranked.find((entry) => entry.name === 'red_carpet')
  assert.equal(red.rank, 2, 'main stock covers the gap, so only a staging packet stands in the way')
})

test('a duplicated colour with spare stock is cheaper to evict than a sole copy', () => {
  const ranker = loadRanker()
  const slots = makeSlots([
    [0, 'red_carpet', 8],
    [1, 'red_carpet', 8],
    [2, 'green_carpet', 2]
  ])
  // Both hotbar red stacks together hold 16 for a horizon needing 2, so a red
  // slot is rank 1 (spare). green's only stack holds 2 for 5 placements and there
  // is none in the main inventory, so it is protected (rank 3).
  const ranked = ranker(
    slots,
    targetsFor(['red_carpet', 'red_carpet', 'green_carpet', 'green_carpet', 'green_carpet', 'green_carpet', 'green_carpet']),
    countOf({ 0: 8, 1: 8, 2: 2 })
  )

  const dupRed = ranked.filter((entry) => entry.name === 'red_carpet')
  const green = ranked.find((entry) => entry.name === 'green_carpet')
  assert.equal(dupRed.every((entry) => entry.rank === 1), true)
  assert.equal(green.rank, 3)
  assert.equal(ranked[0].name, 'red_carpet')
})

test('an empty slot is never evicted by the ranker', () => {
  const ranker = loadRanker()
  const slots = makeSlots([[0, 'red_carpet', 64]])
  const ranked = ranker(slots, targetsFor(['red_carpet']), countOf({ 0: 64 }))
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].index, 0)
})

test('two hotbar slots are reserved so staging always has a destination', () => {
  // A window can carry more distinct materials than free slots: production logs show
  // materials=10/16 against a 9-slot hotbar. Without a reserve every new colour evicts
  // a live one on the spot, which is the thrash. Hold two back from the residency plan
  // and keep them out of every eviction path.
  assert.match(source, /hotbarReservedSlots: 2/)
  assert.match(source, /function getReservedHotbarSlotCount\(\)/)
  assert.match(source, /function getBuildHotbarSlotIndices\(\)/)

  // The reserve is applied at the top of the file, so chooseMaterialHotbarIndex (defined
  // after it) can call it.
  const reserveAt = source.indexOf('function getBuildHotbarSlotIndices(')
  const chooseAt = source.indexOf('function chooseMaterialHotbarIndex(')
  assert.ok(reserveAt >= 0 && reserveAt < chooseAt, 'the reserve helper must be defined before its callers')

  const chooseStart = chooseAt
  const chooseEnd = source.indexOf('\nfunction ', chooseStart + 10)
  const choose = source.slice(chooseStart, chooseEnd)

  // Empty-slot search is scoped to the build slots.
  assert.match(choose, /for \(const index of getBuildHotbarSlotIndices\(\)\)/)
  // Ranked eviction is filtered to build slots, so a reserved slot is never a victim.
  assert.match(choose, /const buildSlots = new Set\(getBuildHotbarSlotIndices\(\)\)/)
  assert.match(choose, /ranked\.find\(\(entry\) => buildSlots\.has\(entry\.index\)\)/)
  // And the no-window fallback cannot reach into the reserve either.
  assert.match(choose, /for \(const index of buildSlots\)/)
  assert.doesNotMatch(choose, /for \(let index = 0; index < 9; index \+= 1\) \{[\s\S]{0,120}getHotbarWindowSlot\(index\)/)

  // Duplicate reuse is also scoped, so it cannot hand back a reserved slot.
  const dupStart = source.indexOf('function findThinnestDuplicateHotbarIndex(')
  const dup = source.slice(dupStart, source.indexOf('\nfunction ', dupStart + 10))
  assert.match(dup, /for \(const index of buildSlots\)/)
})

test('eviction ranks on coverage after removal, not on stack exhaustion', () => {
  // The failure this prevents: hotbar holds 64 red + 20 red against 80 red of demand.
  // Keying on when a stack itself empties makes the 64 look safe to lose until the 64th
  // placement, but removing it leaves only 20 -- the shortage starts at the 21st. The
  // duplicate is the one to keep and the full stack is the one to evict.
  const ranker = loadRanker()
  const slots = makeSlots([
    [0, 'red_carpet', 64],
    [1, 'red_carpet', 20]
  ])
  const window = targetsFor(Array.from({ length: 80 }, () => 'red_carpet'))
  const ranked = ranker(slots, window, countOf({ 0: 64, 1: 20 }))

  const full = ranked.find((entry) => entry.index === 0)
  const dup = ranked.find((entry) => entry.index === 1)
  // Removing the 20-stack leaves 64 usable -> gap at the 65th red placement.
  // Removing the 64-stack leaves 20 usable -> gap at the 21st.
  assert.equal(dup.gapAt, 64)
  assert.equal(full.gapAt, 20)
  // We lose the stack whose removal leaves the LATEST gap. Losing the 20-stack keeps 64
  // usable for 64 placements; losing the 64-stack leaves only 20. So the duplicate is
  // the cheaper sacrifice and the full stack is kept -- the opposite of ranking on when
  // each stack individually empties, which would have discarded the 64.
  assert.equal(ranked[0].index, 1, 'the duplicate is evicted first; the full stack covers far longer')
})

test('readiness compares usable hotbar quantity against burst demand, not presence', () => {
  // A stack of 3 covers two placements but not five. Presence-only checks treat both
  // as ready, which is how a burst starts short and the carpet is silently missed.
  const { buildMaterialAvailability: avail, burstMaterialsReady: ready } = loadMaterialHelpers()
  const availability = new Map([
    ['red_carpet', { hotbar: 3, main: 64, reserved: 0, available: 3 }]
  ])
  const short = ready(availability, null, [
    { blockName: 'red_carpet' }, { blockName: 'red_carpet' }, { blockName: 'red_carpet' },
    { blockName: 'red_carpet' }, { blockName: 'red_carpet' }
  ])
  assert.equal(short.ready, false)
  assert.equal(short.missing[0].blockName, 'red_carpet')
  assert.equal(short.missing[0].short, 2)
  assert.equal(short.missing[0].mainCovered, true, 'main inventory can bridge it without a chest trip')

  const ok = ready(availability, null, [{ blockName: 'red_carpet' }, { blockName: 'red_carpet' }])
  assert.equal(ok.ready, true, '3 available covers a 2-target burst')
})

test('readiness keeps nearest-first: a short colour blocks the burst, never skips the target', () => {
  // Skipping the nearest target because its colour is unavailable and printing a
  // farther target instead is the failure this whole change exists to prevent.
  const { burstMaterialsReady: ready } = loadMaterialHelpers()
  const availability = new Map([
    ['gray_carpet', { hotbar: 0, main: 0, reserved: 0, available: 0 }],
    ['cyan_carpet', { hotbar: 64, main: 0, reserved: 0, available: 64 }]
  ])
  const result = ready(availability, null, [{ blockName: 'gray_carpet' }, { blockName: 'cyan_carpet' }])
  assert.equal(result.ready, false)
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].blockName, 'gray_carpet')
})

test('pending reservations are subtracted exactly once and never below zero', () => {
  const { buildMaterialAvailability: avail } = loadMaterialHelpers()
  assert.equal(avail(10, 64, 4).available, 6)
  assert.equal(avail(2, 0, 5).available, 0, 'over-reserved clamps to zero rather than going negative')
})

test('replenishment prefers a whole-stack swap and returns merge leftovers to the cursor', () => {
  // hotbar 3 / main 64 -> SWAP gives hotbar 64 and never touches the cursor.
  // hotbar 3 / main 40 -> merge gives hotbar 43 and the cursor ends empty.
  // hotbar 3 / main 64 -> merge gives hotbar 64 but the cursor would hold 3 unless a
  // third click returns it; printing must never resume with an occupied cursor.
  const start = source.indexOf('function replenishHotbarSlot(')
  assert.ok(start >= 0, 'replenishHotbarSlot must exist')
  const body = source.slice(start, source.indexOf('\nasync function prepareHotbarForBatch(', start))

  assert.match(body, /if \(sourceCount >= stackSize \|\| destCount === 0\) \{/)
  assert.match(body, /silentHotbarSwap\(bot, sourceSlot, destHotbarIndex\)/)
  assert.match(body, /const leftover = destCount \+ sourceCount - merged/)
  assert.match(body, /if \(leftover > 0\)/)
  assert.match(body, /window\.selectedItem = null/)
  assert.match(body, /slots\[sourceSlot\] = \{ name: blockName, count: leftover, slot: sourceSlot \}/)
  assert.match(body, /operation: 'merge'/)
  assert.match(body, /operation: 'swap'/)

  // Colour identity must be checked before any PICKUP: a mismatch swaps instead of
  // merging, which would park the hotbar stack back in the main inventory.
  assert.match(body, /if \(destStack\?\.name !== blockName\) return \{ ok: false/)
  assert.match(body, /if \(sourceStack\?\.name !== blockName\) return \{ ok: false/)
})

test('hotbar selection prefers the fullest stack, so a drained slot is covered by its duplicate', () => {
  // Regression: findHotbarIndexForItem returned the FIRST slot with count > 0. With a
  // staged duplicate (1 red left in slot 2, 20 red in slot 5) it kept selecting slot 2
  // until it emptied and only then moved on -- so the duplicate sat unused right up to
  // the moment a real swap could least afford to happen. Selecting is one
  // held_item_slot packet and moves no items, so the fuller stack must win.
  const start = source.indexOf('function findHotbarIndexForItem(')
  assert.ok(start >= 0)
  const body = source.slice(start, source.indexOf('\nfunction ', start + 10))

  assert.match(body, /if \(count > bestCount\) \{/)
  assert.match(body, /bestCount = count/)
  assert.doesNotMatch(body, /return index\s*\n\s*\}\s*\n\s*return -1/)

  // And the selection path must reach the resident-slot branch before any staging.
  const selStart = source.indexOf('async function selectHotbarMaterial(')
  assert.ok(selStart >= 0)
  const sel = source.slice(selStart, source.indexOf('\nfunction ', selStart + 10))
  const residentAt = sel.indexOf('const existingHotbar = findHotbarIndexForItem(bot, blockName)')
  const sourceAt = sel.indexOf('findBestInventorySlotForItem(bot, blockName)')
  assert.ok(residentAt >= 0, 'the resident-slot lookup must exist')
  assert.ok(residentAt < sourceAt, 'a resident slot must be used before considering a swap')
  assert.match(sel, /if \(existingHotbar >= 0\) \{\s*\n\s*setSelectedHotbar\(existingHotbar\)/)

  // The burst pre-selects its first colour the same way, before any swap is considered.
  const loopStart = source.indexOf('const placementLoop = observeBackgroundTask', source.indexOf('async function runNervTimeWorkloadPlacementBatch'))
  const loop = source.slice(loopStart, loopStart + 14000)
  assert.match(loop, /const primaryColor = burstColors\[0\]/)
  assert.match(loop, /bot\.setQuickBarSlot\(resident\)/)
  const selectAt = loop.indexOf('const primaryColor = burstColors[0]')
  const swapAt = loop.indexOf('silentHotbarSwap(bot, source.slot, destIndex)')
  assert.ok(selectAt >= 0 && selectAt < swapAt, 'selection must be attempted before staging a swap')

  // The multi-slot lookup the planner needs.
  assert.match(source, /function findHotbarIndexesForItem\(bot, blockName\)/)
})

test('an inventory swap does not stop the sprint or zero velocity', () => {
  // The swap used to clear forward/sprint and zero velocity.x/z because the old
  // bot.clickWindow() path awaited a server round trip and the bot had to stand
  // still to transact. silentHotbarSwap writes one packet and predicts locally, so
  // nothing waits: stopping only walked us away from the targets being placed.
  const start = source.indexOf('async function selectHotbarMaterial(')
  assert.ok(start >= 0)
  const end = source.indexOf('\nfunction ', start + 10)
  const body = source.slice(start, end)

  assert.doesNotMatch(body, /setControlState\('forward', false\)/)
  assert.doesNotMatch(body, /setControlState\('sprint', false\)/)
  assert.doesNotMatch(body, /velocity\.x = 0/)
  assert.doesNotMatch(body, /velocity\.z = 0/)
  // The swap-active marker is still set and cleared around the write.
  assert.match(body, /bot\.__nervInventorySwapActive = true/)
  assert.match(body, /bot\.__nervInventorySwapActive = false/)
})

test('hotbar swaps bypass clickWindow so no burst pays a server round trip', () => {
  // Regression: bot.clickWindow() awaits confirmTransaction on 1.17+ (~150ms at
  // 6b6t ping) and sleeps up to DIG_CLICK_TIMEOUT (500ms) after a recent dig.
  // Awaiting it inside a 5-block burst stalled the sprint and dropped carpets.
  const start = source.indexOf('function silentHotbarSwap(')
  assert.ok(start >= 0, 'silentHotbarSwap must exist')
  // Bound at the next function: replenishHotbarSlot legitimately uses mouseButton 0
  // for its PICKUP clicks, so only the swap's own body may be asserted here.
  const end = source.indexOf('\n// Replenish a hotbar slot', start)
  assert.ok(end > start, 'the swap helper must be delimited so the merge path is not asserted against')
  const helper = source.slice(start, end)

  assert.match(helper, /bot\._client\.write\('window_click'/)
  assert.match(helper, /mode: 2/)
  assert.match(helper, /bot\.lastDigTime = null/)
  assert.doesNotMatch(helper, /await/)
  assert.doesNotMatch(helper, /clickWindow/)

  // mode 2 is SWAP and the button carries the HOTBAR INDEX to swap against. Sending a
  // constant made the server swap into hotbar 0 while we predicted destHotbarIndex, so
  // bot.heldItem then described a different block than the server had selected and the
  // bot placed the wrong colour (occupied-by=black_carpet expected=gray_carpet).
  assert.match(helper, /mouseButton: Math\.max\(0, Math\.min\(8, destHotbarIndex\)\)/)
  assert.doesNotMatch(helper, /mouseButton: 0,/)

  // stateId must be the live window revision, not a constant. mineflayer tracks it
  // from window_items/set_slot (lib/plugins/inventory.js:33-35) and sends the tracked
  // value on every real click (:611); a hardcoded 0 is a stale revision that the server
  // rejects, which is exactly what a held-item-desync is. The tracking lives in a
  // shared helper now, so both the swap and the merge path read the same revision.
  assert.doesNotMatch(helper, /stateId: 0/)
  assert.match(helper, /getWindowStateId\(bot\)/)

  const trackerStart = source.indexOf('function getWindowStateId(')
  assert.ok(trackerStart >= 0, 'getWindowStateId must exist')
  const tracker = source.slice(trackerStart, source.indexOf('\nfunction ', trackerStart + 10))
  assert.match(tracker, /bot\.__nervWindowStateId/)
  assert.match(tracker, /bot\._client\.on\('window_items'/)
  assert.match(tracker, /bot\._client\.on\('set_slot'/)
  // The cursor must be serialized by the registry: a hand-rolled object fails on
  // the component protocol ("Serialization error for play.toServer : SizeOf
  // error for undefined"), desyncs the server transaction and drops the session.
  assert.match(helper, /serializeCursorItem\(bot, window\)/)
  assert.doesNotMatch(helper, /cursorItem: \{/)

  const serializerStart = source.indexOf('function serializeCursorItem(')
  assert.ok(serializerStart >= 0, 'serializeCursorItem must exist')
  const serializer = source.slice(serializerStart, source.indexOf('\nfunction ', serializerStart + 10))
  assert.match(serializer, /prismarineItem\(bot\.version\)\.toNotch\(window\.selectedItem \|\| null\)/)
  assert.doesNotMatch(serializer, /cursorItem: \{/)

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
