# State Management System Documentation

## Overview

The Mapart Bot now includes a comprehensive state management system to ensure crash recovery and detailed progress tracking. The bot can resume from any phase if interrupted.

## Bot Phases

The bot lifecycle is divided into distinct phases:

### 1. **PRINTING PHASE** (`printing_start`, `printing_batch`, `printing_lineend_check`)
   - **Status**: Active printing of carpets to the world
   - **Recovery**: Bot can resume from the last processed target index
   - **States**:
     - `printing_start` - Initializing the printing phase
     - `printing_batch` - Placing a batch of targets
     - `printing_lineend_check` - Verifying the completed line/column

### 2. **REPAIR PHASE** (`repair_start`, `repair_pass`)
   - **Status**: Fixing missed or incorrectly placed blocks from the printing phase
   - **Recovery**: Bot resumes repair with the collected error list
   - **States**:
     - `repair_start` - Initializing the repair phase
     - `repair_pass` - Attempting to repair collected errors

### 3. **RESCAN PHASE** (`rescan_start`, `rescan_full`, `rescan_analysis`)
   - **Status**: Performing comprehensive post-printing verification
   - **Recovery**: Bot resumes from the beginning of rescan
   - **States**:
     - `rescan_start` - Initializing the rescan phase
     - `rescan_full` - Scanning all targets against world state
     - `rescan_analysis` - Analyzing and reporting rescan results

### 4. **POST_PRINT PHASE** (`post_print_start`, `post_print_workflow`, `post_print_done`)
   - **Status**: Running post-print workflow (fill map, cartography, rename, store, reset, XP refill)
   - **Recovery**: Bot resumes post-print workflow
   - **States**:
     - `post_print_start` - Initializing post-print phase
     - `post_print_workflow` - Running workflow steps
     - `post_print_done` - Post-print completed

### 5. **CLEANUP PHASE** (`cleanup`, `finished`)
   - **Status**: Final cleanup and completion
   - **States**:
     - `cleanup` - Moving files, clearing state
     - `finished` - Job fully completed

## Crash Recovery Mechanism

### How It Works

1. **State Persistence**: On every significant state change, the bot writes its current progress to `logs/nerv-printer-progress.json`

2. **Resume Detection**: When the bot starts:
   - It checks if a progress file exists
   - Verifies the input file hasn't changed (sourceType, sourceName, total targets match)
   - Loads the last known state and phase

3. **Resume Points**:
   - **Printing**: Resumes from `processedTargets` index
   - **Repair**: Resumes with the previously collected error list
   - **Rescan**: Resumes full rescan from beginning
   - **Post-Print**: Skips to post-print workflow

### State File Example

```json
{
  "currentPhase": "printing",
  "currentState": "printing_batch",
  "startTime": 1234567890,
  "lastUpdateTime": 1234567900,
  "processedTargets": 2048,
  "totalTargets": 16384,
  "stats": {
    "placed": 1500,
    "already": 400,
    "skipped": 148,
    "errors": 48
  },
  "errors": [],
  "errorsByType": {
    "missing": 30,
    "wrong_block": 18
  },
  "sourceType": "nbt",
  "sourceName": "001-03_0_4.nbt",
  "sourcePath": "./nerv-printer-config/001-03_0_4.nbt",
  "crashCount": 2,
  "lastSuccessfulTarget": {
    "position": {"x": 100, "y": 0, "z": 200},
    "blockName": "red_carpet",
    "col": 5,
    "row": 10
  }
}
```

## Error Types Classification

The system tracks errors by type for better analysis:

- `MISSING`: Block should be there but is air
- `WRONG_BLOCK`: Different block placed instead of expected
- `MISPLACED_CARPET`: Wrong carpet color/type placed
- `SUPPORT_MISSING`: No block below to support placement
- `INVENTORY_FULL`: Inventory ran out of space
- `MATERIAL_UNAVAILABLE`: Required material couldn't be found
- `PLACEMENT_FAILED`: Failed to place block in world
- `PATHFINDING_FAILED`: Couldn't path to location
- `UNKNOWN`: Uncategorized error

## State History

The system maintains a history log (`logs/nerv-printer-progress-history.json`) with up to 1000 recent state transitions. Each entry includes:

```json
{
  "timestamp": "2026-04-15T10:30:45.123Z",
  "phase": "printing",
  "state": "printing_batch",
  "processed": 2048,
  "stats": {
    "placed": 1500,
    "already": 400,
    "skipped": 148,
    "errors": 48
  },
  "details": {
    "batchSize": 256,
    "placed": 240,
    "skipped": 16
  }
}
```

## Rescan Feature

### What It Does

After main printing completes, before post-print workflow:

1. **Full Scan**: Scans every target position in the world
2. **Classification**: Categorizes each block as:
   - ✓ Correct (expected block present)
   - ✗ Missing (air or no block)
   - ✗ Wrong (different block present)

3. **Analysis**: 
   - Calculates accuracy percentage
   - Groups issues by block type
   - Identifies problematic areas

4. **Repair** (if enabled):
   - Automatically repairs missing blocks
   - Breaks and replaces misplaced carpets

### Configuration

In `nerv-printer-config.json` `advanced` section:

```json
"rescanEnabled": true,                    // Master switch for rescan
"rescanAfterPrinting": true,             // Run rescan after main print
"rescanRepairMissingBlocks": true,       // Automatically repair missing blocks
"rescanBreakMisplacedCarpets": true,     // Break and replace misplaced carpets
"rescanVerifySupport": true              // Verify support blocks exist
```

### Rescan Output

```
[RESCAN-PROGRESS] 256/16384 blocks checked (240 correct, 10 missing, 6 wrong)
...
[RESCAN-COMPLETE] Scanned 16384 blocks in 45231ms
[RESCAN-RESULTS] Correct=16350 (99.8%) Missing=20 Wrong=14

============================================================
[RESCAN-ANALYSIS] DETAILED RESULTS
============================================================

Accuracy: 99.8% (16350/16384)
Issues: 34 total
  - Missing: 20
  - Wrong: 14
Scan Time: 45231ms

[MISSING-BY-BLOCK]
  red_carpet: 12 missing
  blue_carpet: 8 missing

[WRONG-BY-BLOCK]
  red_carpet->white_carpet: 14 misplaced

[RECOMMENDATIONS]
  • MISSING: 20 blocks need to be placed
  • WRONG: 14 incorrect blocks need to be replaced
  • Running final repair...
```

## Duplicate Placement Prevention

### How It Works

The bot checks before placing every block:

```
if (blockAtTarget?.name === target.blockName) {
  return { state: 'already' }  // Don't place again
}
```

- **Logged as**: `'already'` counter in stats
- **Not counted as placement**: Avoids wasted effort
- **Counted in accuracy**: Shows map was already correct

### Verification

The `verify-module.js` provides a test to confirm this behavior:

```javascript
const verification = verifyNoDuplicatePlacement(bot, target)
// Result: { 
//   position, blockName, blockAtTarget, 
//   isDuplicate: true/false, 
//   result: 'PASS' / 'FAIL' 
// }
```

## Carpet Break Logic During Repairs

### How It Works

When a misplaced carpet is found during repair:

```
if (blockAtTarget && blockAtTarget.name !== 'air') {
  if (String(blockAtTarget.name).endsWith('_carpet')) {
    // This IS a carpet (just wrong color)
    if (errorAction === 'repair') {
      await bot.dig(blockAtTarget, true)  // Break it with drops
    }
  }
}
```

**Key Points**:
- ✓ Only breaks carpets (checks `.endsWith('_carpet')`)
- ✓ Preserves drops (`true` param maintains drops)
- ✓ Respects `errorAction` setting
- ✓ Won't break non-carpet blocks (safety)

### Verification

The `verify-module.js` provides detection test:

```javascript
const detection = verifyMisplacedCarpetDetection(bot, target)
// Result: {
//   position, expectedBlock, actualBlock,
//   isMisplacedCarpet: true/false,
//   shouldBreak: true/false,
//   result: 'DETECTED' / 'NOT_FOUND'
// }
```

### Configuration for Repair Behavior

```json
"errorHandling": {
  "logErrors": true,
  "errorAction": "repair"  // "repair" or "skip"
}
```

- `"repair"`: Break misplaced carpets and re-place correctly
- `"skip"`: Don't modify misplaced carpets, log error

## State Queries

### Check Current State

```javascript
const stateManager = new StateManager('./logs/nerv-printer-progress.json')
console.log(stateManager.getSummary())
// Output:
// {
//   phase: 'printing',
//   state: 'printing_batch',
//   progress: '2048/16384',
//   stats: { placed: 1500, already: 400, skipped: 148, errors: 48 },
//   errorsByType: { missing: 30, wrong_block: 18 },
//   crashes: 2,
//   uptime: '1234s',
//   lastUpdate: '2026-04-15T10:30:45.123Z'
// }
```

### View History

```bash
# View state transitions
tail -f logs/nerv-printer-progress-history.json
```

## Configuration Defaults

All rescan features are **enabled by default**. To disable:

```json
"rescanEnabled": false,
"rescanAfterPrinting": false,
"rescanRepairMissingBlocks": false,
"rescanBreakMisplacedCarpets": false,
```

## Troubleshooting

### Bot Won't Resume

**Problem**: Bot starts from scratch despite crash file existing

**Solutions**:
1. Check if input file matches: `sourceType`, `sourceName`, `totalTargets`
2. If input changed, clear state: `rm logs/nerv-printer-progress.json`
3. Check logs for state loading errors: `grep STATE-MGR logs/nerv-printer.log`

### State File Growing Large

**Problem**: `logs/nerv-printer-progress-history.json` getting too large

**Solution**: History is auto-trimmed to 1000 entries. Can manually clear:
```bash
rm logs/nerv-printer-progress-history.json
```

### Too Many Errors Logged

**Problem**: Too much error output in console

**Solution**:
```json
"errorHandling": {
  "logErrors": false  // Silence error logs
}
```

---

**Version**: 1.0  
**Last Updated**: 2026-04-15
