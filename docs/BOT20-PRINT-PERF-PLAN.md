# BOT20 Print Performance Plan — 15-Minute Jobs, 4 Blocks/Tick, 7.12 bps, Zero First-Pass Misses

Status: PLANNED (implement on `dev`, deploy to bot20 only via `/usr/local/sbin/mapart-bot20-update`)
Scope guard: **Only bot20.** Never touch bot01–bot19, 3proxy, dashboard-service. Never commit coordinates, IPs, passwords, passkeys, proxy details, credentials, raw logs, or private NBTs. Repair and post-print logic are **frozen** — they are the safety fallback, not the fix.

---

## 0. Goal

One full job (print + post-print + ~60s cleanup) reliably under **900 s**, with:

- First-pass print completeness: **0 misses** during the initial sprint; repair never triggers on a clean run (but stays enabled).
- Placement rate: **max 4 blocks/tick** (never more).
- Sprint speed: **7.12 blocks/sec** sustained flat sprint, no jump inputs (`allowJump: false`).
- No stops for hotbar/inventory management mid-lane: hotbar is replenished **proactively** (refill when a needed colour's hotbar stack ≤ 15), dominant colours hold ≥ 2 stacks in hotbar.
- Dump happens **once**, not in repeated walk-away-wait-return cycles.
- No 360° spin when navigating to `openpos` access points, no stuck states with speed boost + step height.

## 0.1 Verified current state (all facts checked in source on `dev` @ `508335c`)

| # | Fact | Evidence |
|---|---|---|
| F1 | **Speed is capped at 5.612 bps, not 7.123.** `maxSafeBps = allowJump ? 7.192 : 5.612`; bot20 has `allowJump: false`. | `src/nerv-printer/cli.js:1106-1108` |
| F2 | Placement burst cap is already effectively 4/tick (`tpsBurstCap = tps>=19 ? 4 : 3`, catchup min'd against it) and there is **no inter-placement sleep**. | `cli.js:18760-18782`, `18967-18969` |
| F3 | Candidate selection is already closest-first (eye-position distance) with reach-exit tiebreak; the old forward-row bias is gone. | `cli.js:22199-22289` |
| F4 | Hotbar replenishment is **reactive only**: it fires when `burstMaterialsReady` reports a shortfall for the *current burst*. There is **no** refill-at-threshold-15 and **no mid-lane duplicate re-staging**. | `cli.js:18820-18891`, `6929`, `7408` |
| F5 | Duplicate staging exists **only at lane entry** (`prepareHotbarForBatch` fills all 9 slots incl. backups). | `cli.js:7493-7580`, called at `20379`/`20476` |
| F6 | Fast-path swap still pays `scannerPreSwapDelayMs=10` + `scannerPostSwapDelayMs=10` (bot20 VM config). THM does the same swap with **zero** delay, same tick. | `cli.js:7264-7267`, `7286-7288`; THM `InventoryManager.java:389,526` |
| F7 | Emergency restock still happens live (gray_carpet hit 0 inventory mid-lane → full stop, walk, refill, return). | VM log `NERV-WORKLOAD-EMERGENCY-RESTOCK` |
| F8 | Lane end: `lineEnd` action drains pending columns with budget `max(400, scannerLineEndSettleMs)` (bot20 VM: 6000 ms), then sneak-backtrack 3, then line-end repair. | `cli.js:19125-19240`; VM cfg `scannerLineEndSettleMs=6000` |
| F9 | Paper never echoes `block_change` for bot placements → world reads can't confirm; the placement ledger (`__nervConfirmedPlaced`) is the source of truth. | `cli.js:19295-19297`, `16760-16762` |
| F10 | Latency safe mode: bot20 VM `latencySafeModeEnterMs=300` (default 90). Live ping ~149 ms constant. At 90 it would permanently trip; at 300 it doesn't. | VM cfg; log `PING-WARN ping=149ms` |
| F11 | Dump = per-restock-cycle `dumpNervInventorySlots`/`dumpCarpetStacks` visits with per-stack `tossStackWithTimeout` (≤1600 ms) + `inventoryActionDelayMs=100` per stack + `retreatAfterDumpBatch` (3 blocks) + `dumpInventoryStableMs=2500` settle. Repeats across restocks → the "dump, walk, wait, dump again" pattern. | `cli.js:15783-15845`, `15732-15776`, `16186-16210` |
| F12 | Step height already 1.21 (`configureStepHeight` clamps 0.6–1.25). | `src/nerv-printer/runtime-safety.js:618-624` |
| F13 | Log flood (137k PING-WARN lines/log) is **intentional test instrumentation** — do NOT touch logging. Never use journalctl for bot logs. | user directive |
| F14 | `src/nerv-printer/placement/workload.js` is dead code (constructed at `cli.js:207`, never called). Do not "fix" it. | grep `placementWorkload` = 1 hit |
| F15 | Update script `/usr/local/sbin/mapart-bot20-update` defaults to `dev`, preserves config/whitelist/NBTs, restarts bot20 at the end. | VM script head |

## 0.2 Reference mechanics (from `reference/`, read-only)

- **THM swap** = ONE `ClickSlotC2SPacket` with `SlotActionType.SWAP`, `button = hotbar index`, fire-and-forget, no movement stop, swap→place→swap-back same tick. Slot selection = `UpdateSelectedSlotC2SPacket` sent directly, deduped vs a `serverSlot` mirror. (`THM-Addons/.../InventoryManager.java:142-179, 389, 420, 526`)
- **Staircase hard lesson**: swapping into an *occupied* buffer slot and placing immediately → **wrong-material placements** (server hadn't applied the swap). Buffer must be empty or placement defers one tick. (`RasterMaterialHotbarPolicy.java:84-90`)
- **Staircase authoritative swap confirm**: rewrite the click's revision to `-1` so the server answers with a full inventory snapshot; confirm = both slots' revisions advanced. Optional technique for desync healing. (`ClientPlayerInteractionManagerMixin.java:30-88`, `AuthoritativeInventorySwapGate.java`)
- **meteor-litematica-printer**: scans `±(range+1)` every tick, places whatever is in range (`closerThan(pos, range)`), `bpt` per burst, delay resets per placed block, `usedSlot` memo for the current material. (`Printer.java:204-329, 382-457`)
- **Placement packet**: raw `PlayerInteractBlockC2SPacket` + swing, hit = neighbour centre + opposite side · 0.5. Our `_genericPlace` with `forceLook:'ignore'` already equals this (2 packets, 0 awaits), and `installBlockInteractionGuard` already fixes `sequence`. (`PlacementUtils.java:47-74`)
- **CarpetPrinter victim order** (for eviction): empty slot → never-used-again colour → lowest remaining frequency → farthest next use. Ours (gap-based ranking) is already this or better.

---

## 1. Root cause → symptom map

| Symptom | Root cause | Fix (workstream) |
|---|---|---|
| Sprint visibly slower than 7.12 bps; job over budget | F1: `maxSafeBps` gated on `allowJump` | **W1** |
| Mid-lane full stop + walk to chest (emergency restock) | F4+F7: no proactive refill/inventory pull; burst gate reacts only when already short | **W2, W3** |
| Carpets missing at north/south lane ends | Trailing targets exit reach during sprint; lineEnd drain budget consumed by pendingUntil cooldowns; U-turn switches `activeCols` to the next band while previous band's tail is unplaced | **W4** |
| Hotbar slot exhausts → prints from "next slot" not happening instantly | F4: no threshold-15 top-up, no duplicate guarantee mid-lane | **W3** |
| Dump takes forever, walks away and back repeatedly | F11: per-restock dump visits, per-stack settle, retreat per batch | **W5** |
| 360° spin at openpos / stuck with speed+step | Precise-approach pathfinder loop + speed boost fighting pathfinder; yaw thrash between goal and look targets | **W6** (instrument first, then fix) |
| Wrong-colour placements (historical) | Fixed by `d8e9a88` (SWAP `mouseButton` = hotbar idx) — keep, and respect the Staircase empty-buffer rule in new code paths | guard in **W3** |

---

## 2. Workstreams

### W1 — Unclamp sprint speed (code, `cli.js`)

1. `installVanillaSpeed` (cli.js:1106-1113):
   - `const maxSafeBps = 7.192` — unconditional (README §5.1 exact spec).
   - Keep `vanillaSpeedBps` target default 7.123; bot20 VM already sets 7.192.
   - TPS throttle per README §5.3: `tps >= 19 → maxSafeBps`; `tps < 17 → 5.6`; between → retain previous mode (hysteresis, store on `bot.__nervSpeedThrottleState`). Replace current `>=19 / <14 / else 5.0` ladder.
2. Keep: setback cooldown, platform-only gate, sneak/liquid skips, step height 1.21 (F12). `allowJump` stays `false` — boost must not require jump.
3. Verify with a `move-test`-style run on local or via one observed bot20 lane: sustained horizontal bps ≈ 7.1x, no `[SERVER-SETBACK]` spam.

### W2 — Proactive hotbar management (code, `cli.js`) — the core

New per-tick hook inside the background placement loop (right after the availability rebuild at cli.js:18820-18852), running **every tick** regardless of burst state:

1. **Threshold-15 refill** (`hotbarRefillThreshold`, new config, default 15):
   - For each colour needed within `hotbarLookaheadHorizon` targets of the remaining lane:
     - Let `hot` = total count of that colour across hotbar slots 0–8, `main` = count in main inventory.
     - If `hot <= threshold` **and** `main > 0`: top up now via `replenishHotbarSlot` (PICKUP merge into the existing stack; whole-stack SWAP when dest empty). Do NOT wait for a burst shortfall.
   - Rate-limit: at most one top-up per tick (they cost 1–3 window clicks each); the loop's 4/tick placement budget is untouched.
2. **Dominant-colour duplicate guarantee** (mid-lane re-staging):
   - Compute per-colour demand over the remaining lane (already available: `countUpcomingDemand` / `bot.__nervActiveBatchTargets`).
   - If a colour's remaining demand > (largest hotbar stack of that colour) and main inventory still holds that colour → ensure a **second** hotbar slot holds it (stage via the reserved staging slots 0–1 first, evicting by `rankHotbarEvictionCandidates` if needed).
   - User contract: "if same color carpet is used it will at least have 2 stacks in hotbar".
3. **Reserved slots**: keep `hotbarReservedSlots = 2` (slots 0–1 staging, residency in 2–8) — prior user directive. All 9 slots still carpet-only.
4. **Empty-buffer rule** (Staircase lesson): any SWAP that stages into a slot must either target an empty slot or deliberately evict (current `silentHotbarSwap` does evict — fine). Never place in the same tick a swap was issued **into a slot that wasn't empty and wasn't the evicted-victim path** — the burst gate already re-reads live slots before emitting; keep that invariant in new code.
5. **Zero swap latency**: set bot20 VM `scannerPreSwapDelayMs=0`, `scannerPostSwapDelayMs=0` (config-only; code fast path already returns immediately at 0 — cli.js:7264-7272, 7286).
6. **Off-hand stays food.** `equipFoodItem` → off-hand only. XP: exactly 1 main-inventory stack retained, never staged to hotbar during printing (already the contract; add an assert-style guard in the staging victim ranking: never evict INTO the XP slot, never select it as source).
7. Inventory budget: 32 carpet slots (9 hotbar + 23 main) + 1 XP + off-hand food. Restock pulls sized to cover **current lane + next lane** (see W3) so mid-lane inventory never hits 0 for a needed colour.

### W3 — Predictive restock sizing (code, `cli.js`)

- `ensureMaterialsForTargets` / `buildNervInventoryPlan` horizon: extend from current-batch to **current + next batch** targets (the U-traversal pair `L1+L2` per README §3).
- Pull from the duper-group chest so that per-colour `hotbar + main >= remaining lane demand + next-lane demand` (cap 32 slots / stack limits; dump overflow colours only when capacity forces it — see W5).
- Keep `placementStallEmergencyRestock` and `waitForRequiredMaterialRestock` untouched as fallbacks.

### W4 — Lane-end completeness / autoprint-in-reach (code, `cli.js`)

1. **Trailing-priority is already in** (F3). Extend the emission gate (cli.js:18784) so placement is also allowed during `'workload-lateral-u-turn'` and any straight-walk between checkpoints — any in-range pending target gets placed regardless of `currentAction` (meteor-printer semantics: "print as soon as in reach"). Exception: keep placement disabled only during container interactions and food eating.
2. **Dual-band window at U-turns**: when the batch flips `batchStartOnNorthSide`, the previous band's tail targets are still pending behind the bot. Allow `activeCols` to include the previous band's columns until its pending count reaches 0 or the bot is > `placeRange + 2` from any of them (they'll be caught by the next pass or repair — but with W2/W4.1 they should be placed in-reach before that).
3. **Line-end drain**: keep `drainActiveColumnTargets` but make the budget adaptive: exit early when pending-for-this-band = 0; hard cap stays `max(400, scannerLineEndSettleMs)`. Tune bot20 VM `scannerLineEndSettleMs` 6000 → 2500 after W4.1/W4.2 land (the drain should finish in <1 s when nothing is pending).
4. **Miss-recovery sneak-backtrack stays** (3 blocks) — it is cheap and only fires on real misses.
5. `minPlaceDistance` stays 0.8 (bot20 VM). Blocks directly under the bot are placed on the next row pass — verify with logs that no target permanently sits under `minPlaceDistance2` (if seen, the U-checkpoint 0.5 offsets at cli.js:17884-17887 are the knob, not the distance filter).

### W5 — Single-visit dump (code, `cli.js`) + dump speed

1. Aggregate **all** dumpable slots for the whole restock cycle up-front (unwanted colours for the remaining job + `plan.dumpSlots`), then **one** `dumpCarpetStacks` visit:
   - Toss all stacks back-to-back; keep the per-toss confirm only as a timeout guard (no 100 ms `inventoryActionDelayMs` between tosses on the fast path).
   - ONE `waitForSettledDumpInventory` at the end (keep `dumpInventoryStableMs`, lower bot20 VM value to 1200).
   - ONE `retreatAfterDumpBatch` at the very end (or skip when the next navigation walks away anyway).
2. Never dump: food, XP bottles, maps, glass panes (existing guards — keep).
3. Keep the multi-user dump lock (`withMultiDumpLock`).

### W6 — Access-point 360° spin + stuck-with-speed (investigate → fix, `cli.js`)

1. **Instrument first** (test round only): in `gotoConfiguredAccess` precise-approach phase, log every yaw change > 15° within 500 ms and every pathfinder re-plan when horizontal distance < `preciseApproachRange` (1.6). One job's log will show whether the spin is (a) pathfinder GoalNear orbiting the access block because the bot's own collision occupies it, (b) look-target thrash between goal and chest, or (c) staged-ingress recursion re-entering.
2. Likely fixes (apply what the log confirms):
   - (a) When horizontal distance < 2 blocks: skip pathfinder entirely, use `walkStraightToPointWithHardTimeout` to the exact fractional checkpoint (already exists for workload traversal).
   - (b) Suppress look updates during the final approach except the final chest-facing aim.
   - (c) Mark staged segments `staged: true` (already) and don't recurse from a stage into another stage.
3. **Stuck with speed+step**: the physics boost (W1) moves the entity faster than pathfinder expects. Rule: speed boost stays active only during workload traversal and straight-walk segments (it already skips when not moving / off platform); ensure machine-access pathfinder segments run with `vanillaSpeedPlatformOnly` behaviour unchanged but the precise approach uses straight-walk (see a). Do NOT touch `configureStepHeight`.

### W7 — Config changes (bot20 VM only, via `.local-tools/edit-bot20-config.py` pattern)

| Key | Now | → |
|---|---|---|
| `printer.maxPlacementsPerTick` | 5 | **4** |
| `advanced.scannerPreSwapDelayMs` | 10 | **0** |
| `advanced.scannerPostSwapDelayMs` | 10 | **0** |
| `advanced.scannerLineEndSettleMs` | 6000 | **2500** (after W4 lands) |
| `advanced.hotbarRefillThreshold` | — | **15** (new) |
| `printer.placeRange` | 5 | 5 (user: reach 5 on 6b6t; do not lower) |
| `advanced.latencySafeModeEnterMs` | 300 | 300 (keep; live ping ~149) |
| `printer.allowJump` | false | false |
| `advanced.vanillaSpeedBps` | 7.192 | 7.192 |

No fleet/shared defaults change. Repo `createDefaultConfig()` gains `hotbarRefillThreshold: 15` default so the VM override and code default agree.

### W8 — Tests (local, before deploy)

1. `node --test test/*.test.js` must pass before every deploy (includes `repository-privacy.test.js` — the no-coordinates guard).
2. Extend `test/hotbar-lookahead.test.js`:
   - threshold-15 refill triggers exactly when `hot <= 15 && main > 0` for horizon-needed colours, and does nothing otherwise;
   - dominant-colour second-stack staging picks the reserved staging slot first and evicts by gap ranking;
   - XP slot / off-hand never chosen as source or victim;
   - merge-vs-whole-swap decision (`replenishHotbarSlot`) unchanged by W2 (regression).
3. New `test/print-speed-clamp.test.js` (source-extract style like the others): assert `maxSafeBps` is NOT gated on `allowJump`, and TPS ladder has 19/17 hysteresis.
4. New `test/single-visit-dump.test.js`: assert `dumpCarpetStacks` is called once per restock cycle with the aggregated slot list (source-order assertions on the new aggregation call site).
5. Extend `test/workload-entry-return.test.js`: placement gate now allows lateral-u-turn action; dual-band activeCols window present.

### W9 — Deploy & 50-job validation (bot20 only)

1. Commit to `dev` (reviewed files only, `git status` clean of untracked junk), push.
2. `node .local-tools/b20-deploy.js dev` → runs `/usr/local/sbin/mapart-bot20-update dev` (backs up config, resets to `origin/dev`, restores config/whitelist/NBTs, restarts bot20).
3. Apply W7 config edits (backup + full-diff verification, as `edit-bot20-config.py` does).
4. Watch logs read-only via `.local-tools/b20-inspect.js` (never journalctl for bot logs).
5. Acceptance per job: `[LANE-VERIFY] missing=0` every lane; no `NERV-WORKLOAD-EMERGENCY-RESTOCK`; no `REPAIR-PASS` on clean runs; job wall time < 900 s (measure phase timings from existing logs; add a `[JOB-TIMING]` line at job end summarizing phase durations — logging addition only, no behaviour).
6. 50-job ledger (sanitized): job id, duration, misses, emergency-restock count, TPS min, dump visits. Keep it in the untracked runtime area on the VM, never commit it.

---

## 3. Edge cases (design answers, so implementers don't guess)

1. **16 colours vs 9 hotbar slots**: residency is chosen at lane entry by `prepareHotbarForBatch` urgency (first-use × 1000 − frequency); mid-lane eviction uses gap ranking over the 50-target horizon; staging always through slots 0–1.
2. **Colour needed by both current and next lane**: counted in both horizons; the W3 pull sizes for the sum.
3. **Hotbar stack at exactly 15 with main = 0**: no top-up possible → this is W3's signal (pull from chest at next entry). Log once per colour per lane, don't spam.
4. **Ping spike mid-burst (> 300 ms)**: latency safe mode engages (one-by-one confirmed placement, movement stop) — unchanged behaviour, correct fallback. Hysteresis keeps it from flapping.
5. **Server setback (rubberband)**: existing 60 s VM cooldown pauses the boost; candidate ledger means re-placed targets dedupe. Unchanged.
6. **Reconnect mid-lane**: ledger seeds from progress file (existing). New proactive refill must rebuild availability from live slots on resume — it already reads live slots each tick (F4 rebuild), so no extra state to persist.
7. **Swap-then-place same tick**: server processes `window_click` before `block_place` (packet order); `mouseButton` carries the destination hotbar index (d8e9a88). Never stage into a slot the server may not have applied AND place from that slot in the same tick unless the slot was empty or the evicted path — burst gate re-reads live slots before emit; keep.
8. **Held-item desync** (`held-item-desync-*` skips exist): `getWindowStateId` tracks the live stateId; `silentHotbarSwap` predicts locally. If desync repeats > 3× per lane, fall back to one authoritative snapshot (Staircase revision=-1 trick) — implement only if logs show it.
9. **Dump station contention**: multi-bot lock exists (`withMultiDumpLock`, stale 45 s). Single-visit dump holds the lock shorter, reducing contention.
10. **Bot standing on its own next target**: `minPlaceDistance 0.8` blocks the under-foot cell; U-checkpoint +0.5/−0.5 offsets exist so the first/last carpet sits in front. If a target is permanently under-foot, it's placed on the return pass of the U (next lane covers same columns? No — lanes are disjoint). Mitigation: W4.1 in-reach placement during U-turn transit catches it from the side; else line-end repair (1 target, cheap).
11. **TPS < 17 sustained**: speed 5.6, burst cap 3 (existing tpsBurstCap already 3 below 17? — current code: `tps<19 → not 4`; verify exact ladder in W1 rewrite and keep burst cap 3 when throttled).
12. **Food**: auto-eat from off-hand only; eating pauses placement via action gate (existing). Do not let W2 staging touch slot 45.
13. **Half-slab boundary obsidian (Y+1)**: step 1.21 handles it; `allowJump` false. If pathfinder still routes around, it's W6(a) straight-walk territory.
14. **Empty hotbar slot + evictable candidate both available**: staging prefers empty (rank 0) — ranking already orders this.
15. **Duplicate staging when hotbar already has 2+ stacks of the colour and demand still exceeds**: don't stage a 3rd; the threshold-15 top-up covers it (merge refills the stacks in place).
16. **Two colours both below threshold same tick**: one top-up per tick (W2.1 rate limit); next tick handles the second — at 20 tps and 4 carpets/tick consumption, a 64-stack drains in ~2.7 s of pure one-colour sprinting, so 1 top-up/tick is plenty (worst case: 9 colours × merge = 9 ticks = 450 ms, far under drain time).

## 4. Non-goals / frozen

- Repair (`repairTargets*`, inline repair, stall recovery): untouched.
- Post-print workflow, cartography, anvil, reset, cleanup timing: untouched.
- Logging verbosity: untouched (test instrumentation, auto-deletes; disable later only on user's word).
- `placement/workload.js` dead module: leave it (deletion is a separate cleanup; do not "fix" it).
- No changes to other bots, shared configs, 3proxy, dashboard-service. No journalctl. No coordinates/secrets in commits (`repository-privacy.test.js` enforces).

## 5. Execution order

1. W1 (2 lines + TPS ladder) + W7 speed-adjacent config → test → this alone should drop sprint-time ~21%.
2. W2 + W3 (core inventory) + W7 remainder → tests → deploy → observe 3 jobs.
3. W4 (lane ends) → tests → deploy → observe 3 jobs.
4. W5 + W6 (dump + spin/stuck; W6 starts with instrumentation in the same deploy as W2/W3 if convenient) → deploy → observe 3 jobs.
5. W9 50-job validation run; ledger; report phase timings.
