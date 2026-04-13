# Fast Traversal Implementation README

This document tracks the implementation plan for speeding up `nerv-printer.js` by moving from stop-and-place behavior to checkpoint traversal with continuous placement.

## Goal

Increase practical print throughput while keeping placement accuracy and repair stability.

Expected gain target: 20% to 35%.

## Scope

- Keep current stable flow as fallback.
- Add an opt-in fast traversal mode.
- Update error handling so errors are collected at lineEnd only.
- Repair from the lineEnd error list after sweep when repair mode is enabled.

## Implementation Phases

### Phase A: Baseline and Safety

1. Add metrics:
   - sweep start/end time
   - placed/already/skipped/repaired counters
   - blocks per minute
2. Add fast mode feature flag (default off).
3. Ensure logs can compare baseline vs fast mode.

Exit criteria:
- Three baseline runs with consistent metrics.

### Phase B: Checkpoint Path Builder

1. Build checkpoints per column batch.
2. Preserve serpentine traversal order.
3. Keep checkpoint tolerance configurable via buffer.

Exit criteria:
- Batch traversal works without per-target goto in the fast path.

### Phase C: Continuous Placement Loop

1. While moving toward checkpoints, scan nearby targets in active batch window.
2. Place nearest valid targets within range and constraints.
3. Add placement budget per cycle based on `placeDelayMs` and a max-per-tick cap.

Exit criteria:
- Bot moves continuously and places during movement.

### Phase D: LineEnd Error List and Repair

1. Update error list only at lineEnd scan for completed batch.
2. Record both missing and wrong blocks.
3. If `errorAction=repair`, run post-sweep repair pass from that list.

Exit criteria:
- Injected errors are detected at lineEnd and repaired after sweep.

### Phase E: Inventory and Dump with Fast Path

1. Keep predictive restock before each batch.
2. Dump unneeded carpets based on lookahead window.
3. Avoid chest detours during active movement unless required.

Exit criteria:
- No material starvation stalls in long runs.

### Phase F: Sprint Mode Parity

1. Implement sprint behavior by action type:
   - `always`
   - `notPlacing`
   - `off`
2. Apply sprint transitions in fast traversal cycle.

Exit criteria:
- Sprint behavior matches configured mode and remains stable.

### Phase G: Hardening and Rollout

1. Test matrix:
   - clean platform
   - pre-filled map
   - missing materials
   - wrong block injection
   - reconnect mid-run
2. Compare baseline and fast metrics.
3. Keep fallback path available.

Exit criteria:
- Speed increases without major reliability regression.

## Config Keys (Planned)

Under `printer`:

- `fastTraversalEnabled` (boolean, default `false`)
- `fastTraversalTickMs` (number, default `50`)
- `maxPlacementsPerTick` (number, default `1`)

## Suggested Rollout Sequence

1. Land metrics and flags only.
2. Land checkpoint planner and fast loop behind flag.
3. Enable fast mode on a small map and tune.
4. Land lineEnd-only error list and repair pass.
5. Finalize sprint behavior and hardening tests.

## Notes

- Keep all existing stable post-print workflow steps unchanged during speed work.
- Avoid changing too many subsystems at once.
- Prefer incremental commits by phase.
