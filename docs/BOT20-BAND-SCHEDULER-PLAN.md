# BOT20 Band Scheduler — Deterministic Print Plan, Zero First-Pass Misses

Status: PLANNED (implement on `dev`, bot20 only, deploy via `mapart-bot20-update`)

Replaces the current online heuristics (closest-first scan + Bélády-against-lane-order +
mid-burst fastSwap) with one precompiled schedule per band. Repair/post-print stay frozen
as the safety net, untouched.

---

## 0. Why this is the right shape

Today three subsystems each guess the future differently:

| Subsystem | Assumes order is… | Actually is… |
|---|---|---|
| Candidate scan (4fe1beb) | — | closest-first by live geometry |
| Hotbar lookahead (W2 Bélády) | lane/array index order | fiction — causes mid-burst swaps |
| Restock sizing (W3) | lane order | same fiction |

The mismatch is the mid-burst `fastSwap` window-click: locally-predicted slots, zero delay
(W2.5), place-in-same-tick — the Staircase wrong-material race, live today
(647 `held-item-desync` events; the 3-wide-lane stall).

**The U-traversal is deterministic.** Entry side, lane order, U-turn, exit, walk speed,
reach — all known before the first packet. So the attempt order is not a prediction
problem. It is a compilation problem. Compute the schedule once per band; every
subsystem consumes the same artifact; the hotbar planner becomes *exact* Bélády
(farthest-next-use in the true order), swaps exist only at scheduled zero-velocity
stops, and mid-burst nothing happens except `held_item_slot` selects and
`block_place` emissions.

---

## 1. The Band Plan Compiler (pure function, fully unit-testable)

Input: band targets (positions + colours), traversal side, geometry constants
(placeRange 5, eye height, sprint bps 7.19 / walk bps ~4.3, linesPerRun, entry offset,
turn-early 3, uTurn bonus cells opt-in).

Output (`BandPlan`):

```
BandPlan {
  route:   [RouteStop]        // walk waypoints incl. entry, lane walks, uTurn, exit
  stops:   [StagingStop]      // zero-velocity points where window_click swaps are legal
  runs:    [ColourRun]        // colour sequence along emission order { colour, cells, firstTick, lastTick }
  cells:   [CellSlot]         // EVERY target, in emission order
  selects: [SelectEvent]      // held_item_slot events { tick, slot } (one per run switch)
  swaps:   [SwapOp]           // window_click ops { stopId, slotFrom→slotTo } — stops only
  refill:  [RefillOp]         // threshold-15 top-ups { tick, slot } (PICKUP merges at stops;
                             //  mid-run refills only when a run outlives its stack AND a stop exists in-window)
  pacing:  [PaceSegment]      // sprint/walk per route segment so emission keeps ahead of feet
  infeasible: [CellSlot]      // cells that could not be scheduled (must be empty on healthy bands)
}
```

CellSlot: `{ target, emitTick, reachEnterTick, reachExitTick, attemptsAllowed }`.

### 1.1 Reach windows

For each cell, simulate the walk at tick resolution (50 ms, 0.36 b/tick sprint):
- `reachEnterTick` = first tick eye→cell-center distance ≤ placeRange − serverLagMargin
  (serverLagMargin ≈ 0.36 + RTT·bps ≈ 1.4 blocks, from measured server-side reach rejects)
- `reachExitTick` = last such tick before the route carries the bot out of reach
  (U-return pass included: a cell may get a second window on the return leg — use both).

### 1.2 Emission assignment (the coverage guarantee)

Greedy sweep in walk order; per tick, emit up to `blocksPerTick` (5) cells whose window
is open, earliest `reachExitTick` first (classic scheduling: most-urgent-window-first).
Slack: each cell gets `attemptsAllowed = 2` emission slots inside its window when
capacity permits (retry headroom for the residual server drops).

**Invariant (unit-tested, per band):**
1. every target has ≥1 emission slot within its reach window, else it lands in
   `infeasible` (and the compiler *adjusts pacing* first: stretch the segment walk so
   windows widen; only if still impossible → infeasible);
2. per-tick emission count ≤ blocksPerTick, always;
3. swap ops only at `stops`, and a slot is never emitted-from between its swap tick and
   swap+confirm (see §2.3);
4. colour switches (selects) only when the run actually changes — no flapping.

This is the "perfect guarantee" part: completeness is proven at compile time, not hoped
for at runtime. On a healthy band `infeasible` must be empty — CI runs the compiler over
real band geometries (both entry parities, odd/even linesPerRun, uTurn on/off).

### 1.3 Colour runs and the 7-slot constraint

Hotbar residency = slots 2–8 (7 colours), staging = 0–1. Along the emission order,
count distinct colours between consecutive stops:
- ≤ 7 → one resident set per stop-interval; exact Bélády eviction at the stop
  (victim = farthest next-use in emission order, ties → smallest remaining demand —
  "consumable quantity awareness": never evict a colour whose in-window demand exceeds
  what the surviving stacks hold, if an alternative victim exists).
- > 7 → the compiler **inserts an extra staging stop** at the optimal run boundary
  (minimizes stop count; a stop costs ~0.3–0.5 s at walk pace, and only when the canvas
  actually needs >7 colours between natural stops).
- Dominant colour with demand > 64 within a stop-interval → duplicate stack staged into
  the second staging slot at the same stop (pre-planned, never mid-run).

### 1.4 Restock sizing

Per band entry: pull from duper chest so `hotbar + main ≥ schedule demand` for
current band + next band (U-pair), per existing W3 sizing but computed from the
schedule's demand (exact, not horizon-approximated).

---

## 2. The Executor (runtime, replaces the per-wake heuristic scan)

### 2.1 Emission loop

Per physics tick:
1. advance `planTick` (drift-corrected, §2.4);
2. pop cells scheduled for ≤ planTick whose window is open and not yet world-confirmed;
3. ensure held slot = the run's resident slot (select event — atomic, ordered, race-free);
4. emit `block_place` for each (≤5/tick), no swing, no look — unchanged packet shape;
5. never any `window_click` here. A cell whose colour is not resident-and-confirmed is
   deferred to its second attempt slot; if both are spent, it flows to the lane-end
   drain → repair (frozen paths) — provably rare (§1.2 slack).

### 2.2 Retry policy (ack oracle stays, async)

Sent-but-unconfirmed cells re-emit at their second attempt slot (~1 RTT + 75 ms later,
inside the window) when the ack settle reported absent. `ackOk`/`ackReject` counters
remain in `[LANE-PHASE]`. No synchronous waiting anywhere.

### 2.3 Slot confirmation (kills the race class entirely)

A hotbar slot is *emittable* only when our view of it is server-confirmed:
- after `held_item_slot` select: always (atomic, wire-ordered);
- after a stop's `window_click` swap: only once the slot's `set_slot` echo arrives
  (or RTT elapses with no corrective echo). Staircase empty-buffer rule generalized;
  zero artificial delays, zero prediction trust.
- drift heal (pre-planned W2 edge #8, trigger long since met): >3 `held-item-desync`
  in a band → one authoritative snapshot (revision −1 → full `window_items`),
  `[SWAP-RESYNC]` logged, plan continues.

### 2.4 Drift handling

- `planTick` tracks the bot's real progress: on walk-phase deviation (setback,
  adaptive slowdown engaged), recompute the remaining schedule from current position
  (compiler is O(targets), ~1 ms — safe mid-band).
- Every emission still checks live reach at emit time (belt-and-braces: schedule says
  when, geometry gate confirms now). A cell failing the live check moves to its retry
  slot, not the void.

### 2.5 Pacing controller

`pacing` segments keep emission ahead of feet: print-ahead margin target ≈ 2 rows.
If actual confirms lag margin > 1 row (server intake dips), walk instead of sprint for
that segment (reuses `__nervTraversalSlow` plumbing, now schedule-driven instead of
backlog-heuristic). Sprint stays 7.19 bps wherever capacity allows.

---

## 3. What is explicitly NOT changing

- Packet shape (no swing, no look, 5/tick), speed boost, entry/uTurn checkpoints.
- Repair, lane-end drain, post-print, cartography, dump: frozen fallbacks, kept.
- Restock/emergency paths: kept as fallbacks; the schedule makes them rare.
- Logging philosophy: same style, plus new lines below.
- Scope: bot20 only, dev branch, update-script deploys, no secrets in commits.

---

## 4. Telemetry

- `[BAND-PLAN] cells= runs= switches= stops= slackCells= infeasible= compileMs=` at band
  start — the compile-time guarantee, visible per band.
- `[BAND-EXEC] emitted= retried= confirmedByAck= confirmedByEcho= lateWindow= driftReschedules=`
  at band end — planned vs actual, one line, before any repair.
- Existing `[LANE-PHASE]` line unchanged (acks/ackOk/ackReject stay).

Acceptance for the 50-job ledger: `infeasible=0`, `lateWindow=0`, first-pass missing = 0
(world-verified), repair never fires on clean runs, job wall < 900 s.

---

## 5. Implementation order (each step ships green, tests first)

1. **Compiler + tests** (pure, no bot needed): reach-window sim, emission assignment,
   run/stop/select/swap/refill derivation, invariant checks over both parities ×
   uTurn on/off × a >7-colour synthetic band. Nothing runtime touches yet.
2. **Executor swap-in behind a flag** (`advanced.bandSchedulerEnabled`, default false):
   schedule-driven emission + select-only hotbar; old path intact for instant rollback.
   One instrumented job: compare `[BAND-EXEC]` vs `[LANE-PHASE]`.
3. **Staging stops + slot confirmation** (+ desync heal): swaps leave the burst entirely.
   Observe 3 jobs: `held-item-desync` → 0, wrong-material → 0.
4. **Pacing + drift reschedule** on; then remove the flag (old path deleted in a
   separate commit, marked for easy revert).
5. **50-job validation ledger** (sanitized, VM-local, never committed).

Rollback story: every step is one revert; step 2's flag flips behavior without a deploy.

---

## 6. Worst-case matrix — every failure has exactly one funnel

Design principle: the scheduler is **strictly additive** over today's safety net. No cell
can ever be silently dropped, and the terminal state of every failure path is one of:
**(a)** fixed in-window, **(b)** fixed by lane-end drain, **(c)** fixed by the frozen
repair pass — i.e. worst case equals today's behavior, never worse. The per-band ledger
(`[BAND-EXEC]` + existing `[LANE-PHASE]`) makes each funnel's traffic visible.

| # | Failure | Detection | Reaction | Terminal fallback |
|---|---|---|---|---|
| 1 | **Misprint: wrong colour lands** (residual race, bad select) | expected-vs-world colour on confirm (schedule knows the truth) | existing raw-dig insta-fix + re-place from second attempt slot, **while still in reach** | late misprint → per-band world verify (existing) → frozen repair |
| 2 | Server drops a send (residual rate) | ack settle: no ack/echo by RTT+75ms | second attempt slot in-window; global 5/tick cap still applies (retry never storms) | window closed → lane-end drain → repair |
| 3 | Server judges-rejects (ackReject) | ack oracle | immediate retry slot; **>3 rejects on one cell → stop feeding it** (never blast a limiter), defer | drain → repair; ledger marks it |
| 4 | Cell occupied by foreign block (grief, leftover) | live replaceable check at emit | skip; never dig foreign blocks automatically | repair flags it; surfaces in ledger (`occupied-foreign`) |
| 5 | Hotbar slot empties mid-run (inventory miscount) | server-confirmed slot view shows 0 | **unplanned zero-coasting stop**: halt at next safe cell, restage from main (max 2/band) | beyond budget → existing emergency restock (frozen) |
| 6 | Held-item desync persists | >3 `held-item-desync`/band | authoritative snapshot (revision −1); retry ×2 with backoff | still broken → pause band, walk-to-chest full restage from server truth |
| 7 | Setback / rubberband | position teleports behind route | freeze planTick, recompile remaining schedule from actual position (~1 ms) | repeated setbacks → existing speed cooldown + repair |
| 8 | TPS collapse / ping > 300ms | existing latency-safe trip | freeze planTick; existing one-by-one confirmed mode runs the drain; reschedule on exit | unchanged frozen behavior |
| 9 | Emergency restock (chest empty / miscount) | existing material wait | existing path verbatim; scheduler pauses and reschedules after return | unchanged frozen behavior |
| 10 | Disconnect / crash mid-band | progress file + world scan | recompile from **world truth**, not memory (world-first gate already exists) | resume already battle-tested |
| 11 | Compiler emits `infeasible > 0` (hostile geometry) | at compile, before first packet | pacing stretch first; if still impossible those cells go straight to the repair set with `[BAND-PLAN]` flag — never silently dropped | frozen repair |
| 12 | uTurn/entry-offset cells missed by window sim | invariant tests + live reach gate at emit | live-gate failure → retry slot, never void | drain → repair |

**Hard invariants that hold in every failure mode:**
- ≤5 `block_place`/tick globally, retries included.
- No `window_click` ever inside the emission loop (stops only).
- No placement from a slot that is not server-confirmed.
- Every cell ends the band in exactly one ledger state: `placed` / `repaired` / `flagged` —
  nothing disappears silently.
- Frozen subsystems (repair, drain, post-print, restock) are never bypassed or weakened;
  the scheduler only stops *feeding* them on clean runs.

---

## 7. Emergency restock — the decision ladder

Today emergency restock is one blunt move: colour hits 0 mid-lane → hard stop, walk to
the duper chest, refill, walk back to a captured anchor, resume. That is minutes of
cost and it fired because pull sizing was horizon-approximated. Under the scheduler it
becomes a **three-level ladder, cheapest first**, and level C should read ~0 on healthy
runs of the 50-job ledger:

### Level A — fix in place, never leave the band (target: ~all cases)
- **Trigger**: server-confirmed slot count hits 0 for a scheduled colour (server truth,
  not predicted inventory — prediction misses are exactly what caused the old
  full-stop restocks).
- **Move**: one **unplanned zero-coasting stop** (§6.5): halt at the next safe cell,
  restage from main inventory (which the entry pull sized for band + next band), slot
  confirm, reschedule remaining ticks, resume. Cost ≈ 1–2 s. Budget: 2/band.

### Level B — defer, restock at the next natural stop
- **Trigger**: Level A exhausted (main also empty for that colour) **but** the starved
  cells still have a future reach window (U-return leg re-opens reach, or band entry of
  the paired lane is close).
- **Move**: mark those cells `deferred-with-window`, keep printing every other colour
  (no stop at all), pull the colour at the **next scheduled staging stop** or band
  entry — where the bot is standing still anyway. Cost ≈ 0.

### Level C — walk-away (today's path, kept verbatim as last resort)
- **Trigger**: no window remains and both hotbar+main are empty.
- **Move**: the existing sequence, unchanged in mechanics but scheduler-integrated:
  freeze `planTick` → `captureEmergencyRestockAnchor` (exists) → walk to chest → pull
  **exact remaining-schedule demand + next band** (schedule-computed, not horizon
  estimate) → return to anchor → recompile remaining schedule from world truth → resume.
- **Empty chest / dupe-group wait**: existing `waitForRequiredMaterialRestock` /
  `REQUIRED-MATERIAL-WAIT-OBSERVED` path verbatim (another bot may hold the group
  chest); ledger records it.

### Prevention (why A should be rare and C ~never)
- Entry pulls sized from the **schedule's exact demand** (band + U-paired next band),
  not a horizon guess — the class of "gray_carpet hit 0 mid-lane" (F7) is a sizing bug
  the compiler removes.
- Threshold-15 top-ups and duplicate-stack staging are pre-planned at stops (§1.3), so
  a healthy colour never reaches 0 between stops.

### Telemetry
`[ERESTOCK] level=A|B|C colour=X reason=server-slot-empty|main-empty|chest-wait costMs=N`
— one line per event; the 50-job ledger tallies levels. Acceptance: C = 0, B small,
A bounded by budget, and zero full-stop restocks on clean runs.

Ledger-state rule from §6 still holds: deferred cells end `placed` (window used) or
`repaired`/`flagged` — never silently dropped.
