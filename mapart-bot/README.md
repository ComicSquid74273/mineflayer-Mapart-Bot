# Mapart Bot Complete Guide

This repository has two entrypoints:

1. `index.js` for general bot logic.
2. `nerv-printer.js` for Nerv-style carpet printing.

This guide documents `nerv-printer.js` from setup to full configuration reference.

## Quick Start (2 Minutes)

1. Install dependencies:

```bash
npm install
```

2. Ensure imported machine file exists:

- `nerv-printer-config/_configs/carpet-printer-config.json`

3. Put your map file:

- Add `.nbt` into `nerv-printer-config/`

4. Tune local behavior in `nerv-printer-config.json`:

- `printer.printOffset`
- `files.resumeProgress`
- `printer.linesPerRun`

5. Start printer:

```bash
npm run start:nerv
```

6. Check logs:

- `logs/nerv-printer.log`

## 1. Start To Finish Setup

1. Install Node.js 20.x.
2. Install dependencies:

```bash
npm install
```

3. Ensure machine layout file exists:

- `nerv-printer-config/_configs/carpet-printer-config.json`

4. Place your print input:

- NBT mode: put `.nbt` files in `nerv-printer-config/`
- JSON mode: update `mapart-plan.json` and set `files.inputMode` to `json`

5. Tune runtime behavior in:

- `nerv-printer-config.json`

6. Start printer:

```bash
npm run start:nerv
```

or

```bash
node nerv-printer.js
```

7. Watch logs:

- `logs/nerv-printer.log`
- `logs/nerv-printer-progress.json` (if resume is enabled)

## 2. Config Source Rules

When `nerv-printer-config/_configs/carpet-printer-config.json` exists:

1. Machine/platform/chest data comes from the imported carpet file.
2. Non-machine overrides come from `nerv-printer-config.json`.

When imported carpet file does not exist:

1. `nerv-printer-config.json` is used directly.

Do not duplicate machine coordinates in local config when imported carpet config is present.

## 3. Complete Local Config Reference

All fields below are from `nerv-printer-config.json`.

### 3.1 `bot`

| Key | Type | Default | Allowed / Notes |
|---|---|---:|---|
| `bot.host` | string | `127.0.0.1` | Server host/IP |
| `bot.port` | number | `25565` | Minecraft server port |
| `bot.username` | string | `MapartBot` | Bot account name |
| `bot.auth` | string | `offline` | Typical values: `offline`, `microsoft` |
| `bot.version` | string | `1.21.8` | Exact MC version, or `auto` |
| `bot.profilesFolder` | string | `./auth-cache` | Session/auth cache location |
| `bot.viewDistance` | string | `tiny` | Mineflayer view setting, common values: `tiny`, `short`, `normal`, `far` |
| `bot.checkTimeoutInterval` | number | `60000` | Client timeout interval in ms |
| `bot.reconnect.enabled` | boolean | `false` | Enables reconnect loop after disconnect |
| `bot.reconnect.delayMs` | number | `9500` | Wait before reconnect attempt |
| `bot.reconnect.maxAttempts` | number | `5` | Maximum total sessions before stop |

### 3.2 `files`

| Key | Type | Default | Allowed / Notes |
|---|---|---:|---|
| `files.inputMode` | string | `auto` | `auto`, `json`, `nbt` |
| `files.planFile` | string | `./mapart-plan.json` | JSON input plan path |
| `files.nbtFolder` | string | `./nerv-printer-config` | Folder scanned for `.nbt` |
| `files.resumeProgress` | boolean | `true` | Resume from progress file |
| `files.progressFile` | string | `./logs/nerv-printer-progress.json` | Checkpoint file path |
| `files.progressSaveEvery` | number | `64` | Save every N processed targets |
| `files.moveToFinishedFolder` | boolean | `false` | Move consumed input file after job |
| `files.finishedFolder` | string | `./nerv-printer-config/_finished_maps` | Destination folder when moving file |
| `files.disableOnFinished` | boolean | `true` | Logs finished state when done |

### 3.3 `printer`

| Key | Type | Default | Allowed / Notes |
|---|---|---:|---|
| `printer.startOnSpawn` | boolean | `true` | Auto-start print after spawn |
| `printer.startDelayMs` | number | `1500` | Delay before starting print |
| `printer.startCornerMode` | string | `mapCorner` | `mapCorner` or `nearest` |
| `printer.allowJump` | boolean | `true` | `false` prevents jump input and disables parkour paths |
| `printer.placeWhileSprinting` | boolean | `false` | If `true`, avoids row-anchor stops when targets are already in place range |
| `printer.printOffset.x` | number | `0` | Global X shift |
| `printer.printOffset.y` | number | `0` | Global Y shift |
| `printer.printOffset.z` | number | `-1` | Global Z shift |
| `printer.linesPerRun` | number | `3` | Number of columns processed per batch |
| `printer.placeRange` | number | `4` | GoalNear radius for placement movement |
| `printer.minPlaceDistance` | number | `0.8` | Reserved currently |
| `printer.ignoredBlocks` | string[] | `[]` | Carpet block names to skip |
| `printer.placeDelayMs` | number | `50` | Delay after each successful place |
| `printer.rotate` | boolean | `true` | Look-at target before place |
| `printer.northToSouth` | boolean | `true` | Controls row traversal direction |
| `printer.mapFillSquareSize` | number | `1` | Reserved currently |
| `printer.sprintMode` | string | `notPlacing` | Current meaningful value: `always` enables continuous sprint toggle |

### 3.4 `advanced`

| Key | Type | Default | Allowed / Notes |
|---|---|---:|---|
| `advanced.preRestockDelayMs` | number | `500` | Delay before chest withdraw |
| `advanced.inventoryActionDelayMs` | number | `100` | Delay around inventory actions |
| `advanced.postRestockDelayMs` | number | `500` | Delay after chest withdraw |
| `advanced.predictiveRestock` | boolean | `true` | Pre-check row materials and restock before placement |
| `advanced.predictiveRestockMaxPullsPerBlock` | number | `4` | Max chest pulls per block type during pre-check |
| `advanced.predictiveLookaheadRows` | number | `128` | Rows ahead used to estimate upcoming material demand |
| `advanced.postPrintWorkflowEnabled` | boolean | `true` | Master switch for post-print flow (map chest -> map fill -> cartography -> finished chest -> reset) |
| `advanced.postPrintFillMapEnabled` | boolean | `true` | Activates map and runs map-fill walk before cartography |
| `advanced.postPrintUseCartographyEnabled` | boolean | `true` | Uses cartography table with filled map + glass pane |
| `advanced.postPrintStoreFinishedMapEnabled` | boolean | `true` | Deposits produced filled maps into finished map chest |
| `advanced.postPrintResetEnabled` | boolean | `true` | Interacts with reset chest/block after post-print steps |
| `advanced.postPrintInteractionDelayMs` | number | `200` | Delay around post-print interactions |
| `advanced.postBuildDelayMs` | number | `0` | Delay before finish actions |
| `advanced.preSwapDelayMs` | number | `100` | Delay before equipping |
| `advanced.postSwapDelayMs` | number | `100` | Delay after equipping |
| `advanced.retryInteractTimeoutMs` | number | `4000` | Reserved currently |
| `advanced.checkpointBuffer` | number | `0.2` | Reserved currently |
| `advanced.breakCarpetAboveReset` | boolean | `false` | Reserved currently |
| `advanced.debugPrints` | boolean | `false` | Enables detailed debug logs |

### 3.5 `errorHandling`

| Key | Type | Default | Allowed / Notes |
|---|---|---:|---|
| `errorHandling.logErrors` | boolean | `true` | Print move/place/skip details |
| `errorHandling.errorAction` | string | `repair` | `repair` digs wrong carpet and retries; any other value behaves as ignore/skip |

### 3.6 `multiUser`

| Key | Type | Default | Allowed / Notes |
|---|---|---:|---|
| `multiUser.enabled` | boolean | `false` | Currently ignored in single-bot implementation |

### 3.7 `anchorTranslation`

Use this to relocate the full fixed machine layout by one anchor delta.

> NOTE: If anchor values are wrong, all translated machine positions will be wrong (map corner, dump spots, chest access, reset/xp/cartography interactions). Keep `sourceAnchor` correct for the base layout and only move `targetAnchor` for relocation.

The bot computes:

1. `delta.x = targetAnchor.x - sourceAnchor.x`
2. `delta.y = targetAnchor.y - sourceAnchor.y`
3. `delta.z = targetAnchor.z - sourceAnchor.z`

Then applies that delta to all machine coordinates loaded from the carpet config (map corner, dump stations, utility blocks, material chests, and material dict chest positions).

| Key | Type | Default | Allowed / Notes |
|---|---|---:|---|
| `anchorTranslation.enabled` | boolean | `true` | Disable to use raw imported coordinates with no shift |
| `anchorTranslation.sourceAnchor.x` | number | `-450` | Reference machine anchor X |
| `anchorTranslation.sourceAnchor.y` | number | `0` | Reference machine anchor Y |
| `anchorTranslation.sourceAnchor.z` | number | `-962` | Reference machine anchor Z |
| `anchorTranslation.targetAnchor.x` | number | `-450` | New machine anchor X |
| `anchorTranslation.targetAnchor.y` | number | `0` | New machine anchor Y |
| `anchorTranslation.targetAnchor.z` | number | `-962` | New machine anchor Z |

For same-layout relocation, keep `sourceAnchor` fixed to your base machine anchor and only change `targetAnchor`.

## 4. Imported Carpet Config (`carpet-printer-config.json`)

This file is for machine data only.

Used fields include:

1. `mapCorner`
2. `dumpStation.pos`
3. `finishedMapChest`
4. `mapMaterialChests`
5. `materialDict`

Do not move behavior tuning here.

## 5. `config.test.json` Override Behavior

If present, the first bot in `config.test.json` can override local bot connection values:

1. `host`
2. `port`
3. `username`
4. `auth`
5. `version`
6. `profilesFolder`
7. `viewDistance`
8. `checkTimeoutInterval`

## 6. JSON Plan Format (`files.inputMode = json`)

Supported fields in `mapart-plan.json`:

| Key | Type | Default |
|---|---|---:|
| `origin.x` | number | machine map corner x |
| `origin.y` | number | machine map corner y |
| `origin.z` | number | machine map corner z |
| `rowAxis` | string | `z+` |
| `colAxis` | string | `x+` |
| `ignoreChar` | string | `.` |
| `palette` | object | `{}` |
| `rows` | string[] | required |

Axis values:

1. `x+`
2. `x-`
3. `z+`
4. `z-`

## 7. Resume Behavior Details

Resume works when all checks match:

1. Same source type (`nbt` or `json`)
2. Same source name
3. Same total target count

If matched:

1. Bot starts from `processedTargets` index.

On successful completion:

1. Progress file is deleted.

## 8. Logs You Should Watch

Main file:

- `logs/nerv-printer.log`

Useful tags:

1. `[CONFIG]` config source and merge mode
2. `[STARTUP]` startup config summary (offset/reconnect/jump/input mode)
3. `[PLAN]` selected input and target count
4. `[RESUME]` resumed checkpoint position
5. `[PROBE]` startup support score
6. `[START]` nearest-corner start decision
7. `[SKIP]` skipped placements
8. `[PLACE-ERROR]` placement failures
9. `[RETRY-PASS]` unresolved targets after primary sweep
10. `[DONE]` placed/already/skipped summary
11. `[SESSION]` end status and retryability for reconnect loop
12. `[RECONNECT]` reconnect loop decisions (retry/wait/stop)

## 9. Scripts

From `package.json`:

1. `npm run start` runs `index.js`
2. `npm run start:nerv` runs `nerv-printer.js`
3. `npm run start:broadcast` runs quote broadcast mode in `index.js`
4. `npm run clean` removes install/auth caches
5. `npm run clean:install` clean install cycle

## 10. Minimal Example `nerv-printer-config.json`

```json
{
  "bot": {
    "host": "127.0.0.1",
    "port": 54321,
    "username": "MapartBot",
    "auth": "offline",
    "version": "1.21.8",
    "profilesFolder": "./auth-cache",
    "viewDistance": "normal",
    "checkTimeoutInterval": 60000
  },
  "files": {
    "inputMode": "auto",
    "planFile": "./mapart-plan.json",
    "nbtFolder": "./nerv-printer-config",
    "resumeProgress": true,
    "progressFile": "./logs/nerv-printer-progress.json",
    "progressSaveEvery": 64,
    "moveToFinishedFolder": false,
    "finishedFolder": "./finished-maps",
    "disableOnFinished": true
  },
  "printer": {
    "startOnSpawn": true,
    "startDelayMs": 1500,
    "startCornerMode": "mapCorner",
    "allowJump": false,
    "placeWhileSprinting": true,
    "printOffset": { "x": 0, "y": 0, "z": -1 },
    "linesPerRun": 4,
    "placeRange": 4,
    "minPlaceDistance": 0.8,
    "ignoredBlocks": [],
    "placeDelayMs": 1,
    "rotate": false,
    "northToSouth": true,
    "mapFillSquareSize": 1,
    "sprintMode": "always"
  },
  "advanced": {
    "preRestockDelayMs": 10,
    "inventoryActionDelayMs": 10,
    "postRestockDelayMs": 10,
    "predictiveRestock": true,
    "predictiveRestockMaxPullsPerBlock": 4,
    "predictiveLookaheadRows": 128,
    "postPrintWorkflowEnabled": true,
    "postPrintFillMapEnabled": true,
    "postPrintUseCartographyEnabled": true,
    "postPrintStoreFinishedMapEnabled": true,
    "postPrintResetEnabled": true,
    "postPrintInteractionDelayMs": 200,
    "postBuildDelayMs": 0,
    "preSwapDelayMs": 10,
    "postSwapDelayMs": 10,
    "retryInteractTimeoutMs": 4000,
    "checkpointBuffer": 0.2,
    "breakCarpetAboveReset": false,
    "debugPrints": false
  },
  "errorHandling": {
    "logErrors": true,
    "errorAction": "Ignore"
  },
  "multiUser": {
    "enabled": false
  }
}
```
