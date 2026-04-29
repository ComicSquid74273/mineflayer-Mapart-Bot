# Mapart Bot Complete Guide

This repository has two entrypoints:

1. `index.js` for general bot logic.
2. `nerv-printer.js` for Nerv-style carpet printing.

Both root files are compatibility wrappers. The actual source now lives under `src/`:

- `src/nerv-printer/cli.js` - main NERV printer runtime.
- `src/nerv-printer/placement/` - placement workload helpers.
- `src/nerv-printer/diagnostics/` - rescan, state, and verification helpers.
- `src/broadcast/cli.js` - general/broadcast bot runtime.
- `src/broadcast/test-cli.js` - broadcast test runner.
- `docs/` - notes such as 6b6t and anchor information.
- `assets/schematics/` - schematic/litematic assets.

This guide documents `nerv-printer.js` from setup to full configuration reference.

Desktop dashboard workflow guide: `docs/DESKTOP-DASHBOARD-SETUP.md`

## Quick Start (2 Minutes)

1. Install dependencies:

```bash
npm install
```

2. Ensure imported machine file exists:

- `nerv-printer-config/_configs/carpet-printer-config.json`

3. Put your map file:

- Add `.nbt` into `nerv-printer-config/`

4. Tune local behavior in `nerv-printer-config/_configs/nerv-printer-config.json`:

- `printer.printOffset`
- `files.resumeProgress`
- `printer.linesPerRun`

5. Start printer:

```bash
npm run start:nerv
```

For 6b6t:

```bash
npm run start:nerv:6b6t
```

For file-only logs with no bot logs printed to the terminal:

```bash
node nerv-printer.js --connection=6b6t --disable-logs
```

Aliases: `--disableLogs`, `--no-terminal-logs`, `--log-to-file-only`, `--silent`, `--quiet`.

For localhost explicitly:

```bash
npm run start:nerv:local
```

6. Check logs:

- `logs/nerv-printer.log`
- active `.log` files rotate every 12 hours by default and archived `.log` files older than 72 hours are pruned
- `logs/nerv-printer-progress.json` is not part of log cleanup and is kept for resume state

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

- `nerv-printer-config/_configs/nerv-printer-config.json`

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
- rotated archives stay in `logs/` as `nerv-printer-YYYYMMDD-HHMMSSZ.log`
- `logs/nerv-printer-progress.json` (if resume is enabled)

## 2. Config Source Rules

When `nerv-printer-config/_configs/carpet-printer-config.json` exists:

1. Machine/platform/chest data comes from the imported carpet file.
2. Non-machine overrides come from `nerv-printer-config/_configs/nerv-printer-config.json`.

When imported carpet file does not exist:

1. `nerv-printer-config/_configs/nerv-printer-config.json` is used directly.
2. The legacy root path `nerv-printer-config.json` is still accepted as a fallback.

Do not duplicate machine coordinates in local config when imported carpet config is present.

## 3. Complete Local Config Reference

All fields below are from `nerv-printer-config/_configs/nerv-printer-config.json`. Values shown are the current working config values in this repo, not universal defaults.

Tuning rule of thumb:

1. For skipped blocks while printing, start with `scannerLineEndSettleMs`, `scannerPlaceDelayMs`, `scannerAdaptive*`, and `checkpointBuffer`.
2. For inventory/refill/dump issues, start with `inventoryRefillRows`, `dumpUnneededBeforeRefill`, `inventoryMaxMaterialTypes`, and the restock delays.
3. For repair behavior, start with `repairSprintMode`, `repairBatchSize`, `repairMoveTimeoutMs`, and `repairTestMaxPasses`.
4. For multibot stability, start with `multiUser.heartbeatMs`, `multiUser.staleStateMs`, and per-bot `joinDelayMs` / `startDelayMs`.

### 3.1 `bot`

Connection and Mineflayer session settings.

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `bot.host` | `127.0.0.1` | Server host/IP. | Use LAN/server IP for remote server. |
| `bot.port` | `54321` | Minecraft server port. | Must match server/proxy port. |
| `bot.usernames` | account list | Simple account roster. Entries can be strings or account objects. | This is the easiest place to enter accounts. |
| `bot.usernames[].name` | `MapartBot` | Account username/email for one roster entry. | Use your Microsoft account identity for 6b6t. |
| `bot.usernames[].enabled` | `true` / `false` | Whether this account is active. | Single-bot mode picks the first enabled account; multibot uses all enabled accounts. |
| `bot.usernames[].auth` | optional | `offline` or `microsoft` per account. | Useful when some accounts are local/offline and some are Microsoft. |
| `bot.usernames[].profilesFolder` | optional | Per-account auth cache folder. | Usually `./auth-cache`; can split folders if needed. |
| `bot.usernames[].loginPassword` | optional | Cracked/offline 6b6t `/login` password. | Used only by the 6b6t chat-login helper for offline accounts. |
| `bot.username` | fallback only | Legacy single/default username if `bot.usernames` is missing. | Prefer `bot.usernames`; no need to set both. |
| `bot.auth` | `offline` | `offline`, `microsoft`. | Use `offline` for local/offline test server. |
| `bot.version` | `1.21.8` | Exact MC version or sometimes `auto`. | Exact version is safer with Mineflayer. |
| `bot.profilesFolder` | `./auth-cache` | Auth/session cache folder. | Only relevant for authenticated accounts. |
| `bot.viewDistance` | `normal` | `tiny`, `short`, `normal`, `far`. | Higher can help chunk visibility but uses more resources. |
| `bot.checkTimeoutInterval` | `60000` | Mineflayer timeout interval in ms. | Leave unless disconnect detection is weird. |
| `bot.reconnect.enabled` | `true` | Reconnect after disconnect/kick/end. | Keep `true` for autonomous multibot. |
| `bot.reconnect.delayMs` | `15000` | Delay before reconnect attempt. | Higher is safer on public servers that dislike fast reconnects. |
| `bot.reconnect.maxAttempts` | `25` | Max reconnect sessions. | Higher keeps long autonomous runs alive through restarts/kicks. |

### 3.1.1 `connection`

Named connection profiles. The selected profile overrides `bot` connection fields after normal config loading, so you can switch between localhost and 6b6t without editing the main bot block.

Selection order:

1. CLI: `--connection=6b6t` or `--server=6b6t`
2. Environment: `NERV_CONNECTION=6b6t`
3. Config: `connection.active`

Username override order:

1. CLI: `--usernames=Account1,Account2` or `--username=Account1`
2. Environment: `NERV_USERNAMES=Account1,Account2` or `NERV_USERNAME=Account1`
3. Config: `bot.usernames`
4. Fallback: `bot.username`

Connection/auth precedence:

1. Start with the selected `connection` profile.
2. Apply the enabled `bot.usernames[]` account entry.
3. Only account auth fields like `auth` and `profilesFolder` win over the profile.
4. Host, port, version, view distance, timeout, and reconnect stay in the selected `connection` profile.

Available scripts:

```bash
npm run start:nerv:local
npm run start:nerv:6b6t
```

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `connection.active` | `local` | Default profile when no CLI/env selection is provided. | Keep `local` for testing; use `--connection=6b6t` for public server. |
| `connection.profiles.local.bot.host` | `127.0.0.1` | Localhost server address. | Use this for your local test server/proxy. |
| `connection.profiles.local.bot.port` | `54321` | Localhost server port. | Must match your local server. |
| `connection.profiles.local.bot.auth` | `offline` | Local auth mode. | `offline` is fastest for local tests. |
| `connection.profiles.local.bot.version` | `1.21.8` | Local server version. | Keep exact for local testing. |
| `connection.profiles.local.bot.profilesFolder` | `./auth-cache` | Auth cache folder. | Mostly relevant if local auth is not offline. |
| `connection.profiles.local.bot.viewDistance` | `normal` | Local view distance. | Raise/lower depending on local performance. |
| `connection.profiles.local.bot.checkTimeoutInterval` | `60000` | Local timeout in ms. | Fine for local server. |
| `connection.profiles.local.bot.reconnect.enabled` | `true` | Local reconnect enabled. | Keep enabled for testing restarts. |
| `connection.profiles.local.bot.reconnect.delayMs` | `15000` | Local reconnect delay. | Lower if you want faster local reconnects. |
| `connection.profiles.local.bot.reconnect.maxAttempts` | `25` | Local reconnect attempt count. | Raise for long unattended tests. |
| `connection.profiles.6b6t.bot.host` | `alt.6b6t.org` | 6b6t endpoint. | Change if your 6b6t connection/proxy uses a different address. |
| `connection.profiles.6b6t.bot.port` | `25565` | 6b6t port. | Default Minecraft port. |
| `connection.profiles.6b6t.bot.auth` | `microsoft` | Microsoft auth for public server. | Make sure `bot.usernames` contains the accounts you want to launch. |
| `connection.profiles.6b6t.bot.version` | `1.20` | Server protocol version for 6b6t. | Use exact version when `auto` does not join reliably. |
| `connection.profiles.6b6t.bot.profilesFolder` | `./auth-cache` | Microsoft auth cache folder. | Keep stable so accounts stay logged in. |
| `connection.profiles.6b6t.bot.viewDistance` | `normal` | 6b6t view distance. | Lower reduces network load; raise only if chunk visibility is too low. |
| `connection.profiles.6b6t.bot.checkTimeoutInterval` | `90000` | 6b6t timeout in ms. | Higher tolerates public-server lag spikes. |
| `connection.profiles.6b6t.bot.requiredSpawnCountBeforeStartup` | `2` | Wait for multiple spawn events before starting. | Helps with proxy/backend handoff on public servers. |
| `connection.profiles.6b6t.bot.requiredSpawnFallbackSeconds` | `25` | If the second spawn event never arrives, continue startup after this many seconds. | Prevents hanging forever on servers that emit only one spawn event. |
| `connection.profiles.6b6t.bot.spawnPositionTimeoutSeconds` | `180` | Max wait for real non-zero coordinates after spawn. | If coords never load, bot reconnects instead of starting at fake `0,0`. |
| `connection.profiles.6b6t.bot.waitForPlatformPositionOnSpawn` | `true` | Wait until spawn coordinates are inside the configured platform bounds. | Prevents temporary proxy coords like `500,500` from making the bot idle too early. |
| `connection.profiles.6b6t.bot.seedPositionFromPlatformOnSpawn` | `true` | If Mineflayer position stays NaN/null after spawn but the player is on-platform, seed internal coords from the platform config. | Handles proxy/server-restored sessions where Mineflayer never updates its local position. |
| `connection.profiles.6b6t.bot.reconnect.enabled` | `true` | 6b6t reconnect enabled. | Keep enabled for queue/kick/restart recovery. |
| `connection.profiles.6b6t.bot.reconnect.delayMs` | `30000` | Slower reconnect for public server. | Helps avoid reconnect spam/anti-bot flags. |
| `connection.profiles.6b6t.bot.reconnect.maxAttempts` | `50` | 6b6t reconnect attempt count. | Higher for long unattended runs. |
| `connection.profiles.6b6t.multiUser.joinStaggerMs` | `15000` | 6b6t default bot join spacing. | Helps avoid login bursts. |
| `connection.profiles.6b6t.multiUser.startStaggerMs` | `6000` | 6b6t default work start spacing. | Reduces startup lag spikes. |
| `connection.profiles.6b6t.multiUser.staleStateMs` | `60000` | 6b6t stale heartbeat timeout. | Higher avoids false stale marks during lag. |
| `connection.profiles.6b6t.multiUser.heartbeatMs` | `4000` | 6b6t heartbeat write interval. | Lower notices status changes faster. |

### 3.2 `files`

Input files, progress files, and finished-file handling.

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `files.inputMode` | `nbt` | `auto`, `json`, `nbt`. | Use `nbt` for NERV map files. |
| `files.planFile` | `./mapart-plan.json` | JSON plan path. | Used only for JSON mode. |
| `files.machineConfigProfile` | `carpet` | Imported machine profile name. | Keep `carpet` for carpet printer layout. |
| `files.machineConfigFile` | `./nerv-printer-config/_configs/legacy-nerv-carpet-printer-config.json` | Machine/platform/chest coordinate file. | Do not put speed tuning here. |
| `files.resumeProgress` | `true` | Resume from progress JSON after crash/reconnect. | Keep `true` for autonomous runs. |
| `files.progressFile` | `./logs/nerv-printer-progress.json` | Single-bot progress path. Multibot creates per-bot progress files. | Usually do not edit manually. |
| `files.progressSaveEvery` | `10` | Save every N targets in non-fast paths. | Lower is safer for crash recovery; higher is less disk chatter. |
| `files.moveToFinishedFolder` | `true` | Move completed input file after successful job. | Master only in multibot. |
| `files.finishedFolder` | `./finished-maps` | Destination for finished input files. | Ensure folder is writable. |
| `files.disableOnFinished` | `true` | Logs finished/disabled state after job. | Keep `true`; it does not stop the process by itself in reconnect flow. |

### 3.3 `printer`

Print movement, placement, and row/batch behavior.

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `printer.startOnSpawn` | `true` | Auto-start after spawn. | Set `false` for manual/debug idle. |
| `printer.startDelayMs` | `1500` | Wait after spawn before starting. | Increase if chunks/login are slow. |
| `printer.allowJump` | `false` | Enables jump/parkour pathing if `true`. | Keep `false` on flat printer platforms. |
| `printer.placeWhileSprinting` | `true` | Allows placing during movement. | Keep `true` for NERV-style continuous placement. |
| `printer.postPrintTestOnly` | `false` | Skip printing and run post-print workflow only. | For CLI testing, `npm run test:post-print` disables reset/center; `npm run test:post-print:full:6b6t` includes reset and center on 6b6t. |
| `printer.printOffset.x/y/z` | `0,0,-1` | Shift all print targets. | Wrong offset causes full-map misalignment. |
| `printer.linesPerRun` | `3` | Width of one print run in map columns/lines. | Higher is faster but can skip more; `3` is stable. |
| `printer.placeRange` | `5` | Placement scan/range radius. | Higher sees more targets; too high can pick awkward targets. |
| `printer.minPlaceDistance` | `0.8` | Avoid placing too close to feet. | Increase if bot glitches into carpets; lower if it misses near targets. |
| `printer.ignoredBlocks` | `[]` | Block names to skip, e.g. `["air"]` or carpet names. | Usually empty. |
| `printer.placeDelayMs` | `0` | Delay after standard `placeTarget` placements. | Fast workload uses `advanced.scannerPlaceDelayMs`. |
| `printer.rotate` | `false` | Rotate/look before placement in slower paths. | `false` is faster for packet/generic placement. |
| `printer.northToSouth` | `true` | Initial row direction. | Flip only if map traversal starts wrong side. |
| `printer.mapFillSquareSize` | `1` | Map fill stepping scale. | Leave `1`. |
| `printer.sprintMode` | `off` | `off`, `notPlacing`, `always`. Controls print movement sprint. | `off` is slower/safer; repair has separate `repairSprintMode`. |
| `printer.fastTraversalEnabled` | `true` | Uses scanner/workload placement while moving. | Must be `true` for current NERV-style print. |
| `printer.fastTraversalTickMs` | `20` | Fixed scanner loop interval. | Lower is faster CPU/placement pressure; higher is calmer. |
| `printer.fastTraversalCheckpointEveryRows` | `8` | Legacy fast traversal checkpoint grouping. | Mostly legacy; leave unless using older fast path. |
| `printer.fastTraversalCatchupPasses` | `2` | Legacy catch-up pass count. | Not the adaptive workload catch-up; leave. |
| `printer.fastTraversalCatchupStallMs` | `4000` | Fallback/settle time used by traversal logic. | Similar spirit to line-end settle. |
| `printer.maxPlacementsPerTick` | `10` | Max placement attempts per scan tick in fixed mode/repair fallback. | Lower if server drops packets; higher if CPU/server can handle it. |

### 3.4 `advanced`

Advanced is grouped by behavior because this section has many tuning knobs.

#### 3.4.0 Network And Hunger

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.antiHunger.enabled` | `true` | Enables Meteor-style AntiHunger packet spoofing. | On by default; set `false` only for debugging movement/server issues. |
| `advanced.antiHunger.sprint` | `true` | Cancels outgoing start-sprinting action packets. | Reduces hunger from sprint packet state. |
| `advanced.antiHunger.onGround` | `true` | Spoofs movement packet ground flag while safely on ground. | First ground packet after landing is preserved so fall damage is not suppressed incorrectly. |
| `advanced.autoEatEnabled` | `true` | Enables pre-traversal food checks. | Disable only if food should be handled manually. |
| `advanced.autoEatMinHunger` | `12` | Eat before a traversal batch when hunger is below this value. | Raise for more buffer; lower to visit the food chest less often. |
| `advanced.autoEatFoodItem` | `cooked_beef` | Item pulled from `machine.foodChest` and consumed. | `cooked_beef` is Minecraft steak. |
| `advanced.autoEatReturnUnusedFood` | `true` | Return leftover pulled food to `machine.foodChest` after hunger is sufficient. | Set `false` to keep spare food in inventory. |
| `advanced.supportStockDashboardWarningsEnabled` | `true` | Sends once-per-map-run dashboard warnings for support stock only. | Checks food, XP bottles, empty maps, and glass panes; carpet stock warnings are not sent. |
| `advanced.supportStockFoodMinStacks` | `5` | Minimum food stacks expected in `machine.foodChest`. | Dashboard warns if the combined count is lower. |
| `advanced.supportStockXpBottleMinStacks` | `5` | Minimum XP bottle stacks expected across XP bottle chests/dispenser. | Supports legacy `xpBottleChests`, `machine.xpBottleChest`, and `machine.xpDispenser`. |
| `advanced.supportStockEmptyMapMinStacks` | `1` | Minimum empty map stacks expected across `mapMaterialChests`. | Used before each map run. |
| `advanced.supportStockGlassPaneMinStacks` | `1` | Minimum glass pane stacks expected across `mapMaterialChests`. | Used before each map run. |
| `advanced.anvilPillarMinCount` | `3` | Minimum anvils expected in the vertical pillar at `machine.anvil`. | Dashboard warns when visible anvils drop below this. |
| `advanced.anvilPillarScanLimit` | `16` | Max vertical blocks to scan upward from `machine.anvil`. | Raise only if the pillar is taller than 16 anvils. |
| `advanced.platformWatchdogEnabled` | `true` | Pauses pathing/placing if the bot leaves platform bounds or enters limbo coords. | Keep enabled on public servers/restarts. |
| `advanced.platformWatchdogPollMs` | `1000` | How often the runtime platform watchdog checks position. | Lower reacts faster; higher is calmer. |
| `advanced.platformHoldLogMs` | `5000` | Log interval while waiting in platform hold. | Raise if logs are too noisy during restarts. |
| `advanced.startupSupportProbeEnabled` | `true` | Wait for platform support blocks to be visible before restock/print starts. | Prevents `support=0/64` from running inventory logic too early. |
| `advanced.startupSupportMinRatio` | `0.5` | Minimum startup support ratio required to continue. | `0.5` means at least half the sampled supports must be loaded. |
| `advanced.startupSupportPollMs` | `5000` | Wait between startup support rechecks. | Raise on very laggy servers. |
| `advanced.startupSupportLogMs` | `15000` | Log interval while waiting for startup support. | Raise to reduce log noise. |

#### 3.4.1 Inventory, Restock, And Dump

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.preRestockDelayMs` | `80` | Delay before restock interaction. | Increase if chest opens before bot is ready. |
| `advanced.inventoryActionDelayMs` | `35` | Delay between inventory clicks/actions. | Increase if item transfers are unreliable. |
| `advanced.postRestockDelayMs` | `120` | Delay after restock. | Increase if inventory update arrives late. |
| `advanced.restockPostCloseInventorySyncMs` | `2000` | Max wait after closing a restock chest for local inventory/hotbar to show the moved stack. | Prevents printing from resuming from chest-window state before the bot can actually select the item. |
| `advanced.restockFailureCooldownMs` | `250` | Cooldown after failed material restock. | Increase if bot loops too fast on empty chests. |
| `advanced.predictiveRestock` | `true` | Plan inventory before placement window. | Keep `true`; prevents mid-row emergency refill. |
| `advanced.dumpUnneededBeforeRefill` | `true` | Dump residue/unneeded carpets before refill. | Keep `true` for map changes and residue cleanup. |
| `advanced.inventoryRefillRows` | `2` | Number of logical `linesPerRun` groups planned for inventory. | `2` means enough for roughly two print chunks. |
| `advanced.inventoryMaxMaterialTypes` | `16` | Max carpet colors allowed in inventory plan. | `16` matches Minecraft carpet colors. |
| `advanced.inventoryPlanUseWorldState` | `false` | Use live world state when planning required items. | Usually `false`; live scans can be expensive/incomplete. |
| `advanced.sneakOnDispenserOnly` | `true` | Sneak only when placing against dispensers. | Keep `true`; avoids unnecessary slowdown. |

#### 3.4.2 Reset, Rescan, And Post-Print

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.resetChestWaitMs` | `2000` | How long the reset chest stays open. | Keep `2000` for reset circuits that need a longer trapped-chest pulse. |
| `advanced.resetChestCloseSettleMs` | `0` | Wait after closing the reset chest before moving to center. | Usually `0`; raise only if redstone needs time after close. |
| `advanced.rescanEnabled` | `true` | Enables rescan/repair support features. | Keep `true` for autonomous accuracy. |
| `advanced.rescanAfterPrinting` | `true` | Scan after printing. | Keep `true`; finds skipped blocks. |
| `advanced.rescanRepairMissingBlocks` | `true` | Repair air/missing blocks. | Keep `true`. |
| `advanced.rescanBreakMisplacedCarpets` | `true` | Break wrong carpets and replace. | Set `false` only if you never want destructive repair. |
| `advanced.rescanVerifySupport` | `true` | Check support/platform before repair. | Keep `true` to avoid unsafe placement. |
| `advanced.postPrintWorkflowEnabled` | `true` | Master switch for post-print workflow. | Master only in multibot. |
| `advanced.postPrintFillMapEnabled` | `true` | Fill/activate map after printing. | Disable to stop after carpet print. |
| `advanced.postPrintUseCartographyEnabled` | `true` | Use cartography table/glass pane. | Disable if manually locking/copying maps. |
| `advanced.postPrintStoreFinishedMapEnabled` | `true` | Store final map in finished chest. | Disable for manual collection. |
| `advanced.postPrintResetEnabled` | `true` | Run reset after post-print. | Disable if reset machine is not configured. |
| `advanced.postPrintXpRefillEnabled` | `true` | Refill/handle XP for post-print actions. | Useful when cartography/rename needs XP. |
| `advanced.postPrintRenameMapEnabled` | `true` | Rename map during post-print. | Disable if anvil/name flow is not wanted. |
| `advanced.postPrintRequireRenameBeforeStore` | `false` | If `true`, do not deposit filled maps unless rename is verified. If `false`, store anyway after rename retries fail. | Keep `false` for fully autonomous runs; use `true` only when unrenamed maps must never enter finished chest. |
| `advanced.postPrintRenameAttempts` | `3` | Number of anvil rename attempts before holding the map for retry. | Raise on laggy servers if rename verification is late. |
| `advanced.postPrintMinXpLevel` | `2` | Minimum XP before refill behavior. | Raise if rename costs more. |
| `advanced.postPrintTargetXpLevel` | `3` | Desired XP target after refill. | Raise for repeated post-print actions. |
| `advanced.postPrintXpBottlePullStacks` | `1` | XP bottle stacks to pull from the configured XP chest/source when below minimum XP. | Used before anvil rename; leftover bottles are returned by default. |
| `advanced.postPrintXpBottleMaxThrows` | `64` | Maximum XP bottles to throw during one post-print XP refill. | Safety cap for laggy XP pickup. |
| `advanced.postPrintReturnUnusedXpBottles` | `true` | Return unused XP bottles to the XP chest/source after reaching the minimum level. | Set `false` only if you want leftovers kept in inventory. |
| `advanced.postPrintSkipResetInteraction` | `false` | Skip reset interaction while keeping workflow. | Useful for testing post-print without resetting. |
| `advanced.postPrintWalkToCenter` | `true` | Walk to map center during fill. | Disable if fill path is handled externally. |
| `advanced.postPrintCenterWaitMs` | `20000` | Wait at center during map fill. | Increase if map fill is incomplete. |
| `advanced.postPrintInteractionDelayMs` | `200` | Delay around post-print clicks. | Increase for laggy servers. |
| `advanced.postPrintMapSettleDelayMs` | `200` | Wait after map actions. | Increase if map item updates late. |
| `advanced.postPrintCartographyAccessRange` | `0.85` | Max distance from cartography access point before opening the table. | Keep slightly above pathfinder settle drift; `0.6` was too strict on 6b6t. |

#### 3.4.3 Dump Station

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.dumpAimSettleMs` | `150` | Wait after aiming at dump station. | Increase if toss direction is inconsistent. |
| `advanced.dumpYawInvert` | `false` | Invert configured dump yaw. | Only change if yaw is mirrored. |
| `advanced.dumpPitchInvert` | `false` | Invert configured dump pitch. | Only change if pitch is mirrored. |
| `advanced.dumpTestStationWaitMs` | `7000` | Wait at each station in dump test. | Test-only. |
| `advanced.dumpTestTossAtEachStation` | `true` | Toss test item at every dump station. | Test-only. |
| `advanced.dumpPathThinkTimeoutMs` | `5000` | Pathfinder think timeout for dump station. | Increase if dump path fails. |
| `advanced.dumpAlreadyNearRange` | `4` | If within this range, do not path exactly to dump position. | Higher avoids getting stuck at dump. |
| `advanced.dumpGoalRange` | `2` | Goal radius for dump path. | Higher is more forgiving; too high may aim badly. |
| `advanced.multiDumpLockStaleMs` | `45000` | Multibot dump lock stale timeout. | Prevents bots dumping at same time forever. |
| `advanced.dumpReaimEveryStacks` | `2` | Re-aim after N tossed stacks; `0` disables. | Set `1` or `2` if toss aim drifts. |

#### 3.4.4 Isolated Tests

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.movingPlaceTestTargetCount` | `32` | Target count for moving-place test. | Used by `npm run test:moving-place`. |
| `advanced.movingPlaceTestCheckpointEveryRows` | `8` | Test checkpoint spacing. | Test-only. |
| `advanced.movingPlaceTestWaitAfterMs` | `5000` | Wait before logout after moving-place test. | Test-only. |
| `advanced.nervScannerTestLineGroups` | `2` | Number of line groups for scanner test. | Test-only. |
| `advanced.nervScannerTestWaitAfterMs` | `5000` | Wait after scanner test. | Test-only. |
| `advanced.nervWorkloadTestLineGroups` | `2` | Number of line groups for workload test. | Test-only. |
| `advanced.nervWorkloadTestWaitAfterMs` | `5000` | Wait after workload test. | Test-only. |
| `advanced.inventoryCycleTestWaitAfterMs` | `5000` | Wait after inventory cycle test. | Test-only. |
| `advanced.inventoryCycleTestRows` | `2` | Rows/chunks selected for inventory cycle test. | Test-only. |
| `advanced.repairTestWaitAfterMs` | `5000` | Wait after repair test. | Test-only. |
| `advanced.repairTestMaxPasses` | `3` | Max passes in repair test and live repair. | Increase if repair needs more passes. |

#### 3.4.5 Scanner / Time Workload Printing

These are the main knobs for skipped blocks while printing.

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.scannerPlaceDelayMs` | `6` | Time-based workload placement delay. Lower means faster. | Increase to `8` or `10` if packets are dropped/skips remain. |
| `advanced.scannerMaxCatchupPlacements` | `10` | Max placements allowed in one workload burst. | Lower to `8` if server dislikes bursts. |
| `advanced.scannerWorkloadPollMs` | `6` | Poll interval for time workload. | Lower is more responsive but more CPU. |
| `advanced.scannerWorkloadLogEveryMs` | `1000` | Test workload progress log interval. | Mostly test/debug. |
| `advanced.scannerLineEndSettleMs` | `4500` | Wait at line end while placement loop continues. | Increase if `missing` remains high; decrease if stable and too slow. |
| `advanced.scannerAdaptiveSlowdown` | `true` | Automatically slows down when a batch misses too much. | Keep `true` for multibot tuning. |
| `advanced.scannerAdaptiveMissingThreshold` | `8` | Missing count that triggers slowdown. | Lower reacts faster; higher tolerates skips. |
| `advanced.scannerAdaptiveRecoverThreshold` | `2` | Missing count that allows speed recovery. | Lower makes recovery stricter. |
| `advanced.scannerAdaptiveSettleStepMs` | `750` | Amount to add/subtract from line-end settle. | Use `500` for gentler tuning, `1000` for faster reaction. |
| `advanced.scannerAdaptiveMaxSettleMs` | `9000` | Max adaptive line-end wait. | Raise only if server is very laggy. |
| `advanced.scannerAdaptiveMinSettleMs` | `2500` | Min adaptive line-end wait. | Lower for speed, higher for accuracy. |
| `advanced.scannerAdaptivePlaceDelayStepMs` | `2` | Amount to add/subtract from place delay. | Keep small; placement delay is sensitive. |
| `advanced.scannerAdaptiveMaxPlaceDelayMs` | `18` | Max adaptive placement delay. | Raise if server is dropping many packets. |
| `advanced.scannerAdaptiveMinPlaceDelayMs` | `6` | Min adaptive placement delay. | Keep at least `6` on servers with lag. |
| `advanced.scannerRetryCooldownMs` | `35` | Delay before retrying an unconfirmed placement. | Increase if duplicate/too-fast retries happen. |
| `advanced.scannerPlaceConfirmMs` | `80` | Confirmation window used by non-optimistic placement paths. | Litematic workload stays optimistic for smooth movement. |
| `advanced.scannerPlaceConfirmPollMs` | `15` | Poll interval while waiting for placement confirmation. | Keep small; this is only used by confirming placement paths. |
| `advanced.workloadCheckpointMoveTimeoutMs` | `30000` | Hard timeout for moving to the next workload checkpoint. | Prevents silent standing forever after refill/pathfinder stalls. |
| `advanced.placementStallTimeoutMs` | `5000` | Marks a local stuck area after this long without real block-world placement progress. | Set `0` to disable; skipped areas are left for final repair. |
| `advanced.placementStallRecoveryMs` | `2000` | Starts a local slow confirmed recovery after this long without real block-world progress. | Runs before stall skip. |
| `advanced.placementStallRecoveryAttempts` | `3` | Slow confirmed placements to try during local stall recovery. | Set `0` to skip straight to stall skip. |
| `advanced.placementStallRecoveryConfirmMs` | `180` | Confirmation window for stall recovery placement attempts. | Raise if recovery logs show late confirmations. |
| `advanced.placementStallEmergencyRestock` | `true` | Trigger emergency restock/refresh if slow stall recovery cannot confirm placement. | Experimental recovery for 6b6t placement refusal windows. |
| `advanced.emergencyRestockReturnRange` | `3` | Range used when returning to the stalled print target after emergency restock. | Keep near `placeRange - 1`; lower is more exact but can path more. |
| `advanced.placementStallSkipRadiusBlocks` | `5` | Radius around the stalled target to skip in the main print pass. | Keep near `placeRange + 1`; final repair handles skipped blocks. |
| `advanced.scannerPreSwapDelayMs` | `10` | Delay before item swap in scanner placement. | Increase if held item updates late. |
| `advanced.scannerPostSwapDelayMs` | `50` | Required stable selected-material window after scanner item swap. | Increase only if `held-item-desync-*` appears despite inventory. |
| `advanced.scannerWorkloadMode` | `time` | `time` or `fixed`. | Use `time` for lag-aware workload; `fixed` is older scanner tick mode. |

Important workload logs:

```text
[NERV-WORKLOAD-BATCH] placed=... seen=... missing=... hardStops=... rawAllowed=... capped=...
[NERV-WORKLOAD-STALL-RECOVER] start recovery=... stalledMs=... attempts=... optimistic=... target=x y z confirmMs=...
[NERV-WORKLOAD-STALL-RECOVER] attempt=... target=x y z result=... confirmed=... before=... after=... held=... selected=...
[NERV-WORKLOAD-STALL-SKIP] buffer=... skipped=... lastTarget=x y z stalledMs=... attempts=... optimistic=...
[NERV-WORKLOAD-ADAPT-SLOW] missing=... placeDelayMs=... lineEndSettleMs=...
[NERV-WORKLOAD-ADAPT-RECOVER] missing=... placeDelayMs=... lineEndSettleMs=...
```

`missing` is the number to drive tuning. `hardStops` often means item swaps or placement errors interrupted bursts.

#### 3.4.6 Repair

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.repairSprintMode` | `always` | `always`, `off`, or other non-off values. | `always` repairs air while moving quickly. |
| `advanced.repairGoalRange` | `3.25` | Pathing radius for stop-place repair. | Lower is more exact; higher avoids stuck pathing. |
| `advanced.repairTargetSettleMs` | `0` | Wait between stop-place repair targets. | Increase if repair clicks are too fast. |
| `advanced.repairMoveTimeoutMs` | `30000` | Max movement time during repair before warning/fallback. | Increase for long paths from chests. |
| `advanced.repairProgressLogMs` | `5000` | Progress log interval during repair. | Lower for more visibility. |
| `advanced.repairFallbackToStopPlace` | `true` | If moving repair stalls, fallback to stop-place. | Keep `true`; prevents idle repair. |
| `advanced.repairStallEmergencyRestock` | `true` | Trigger emergency restock/refresh if repair has no confirmed progress or repeated transient placement failures. | Experimental recovery for stale inventory/server refusal during repair. |
| `advanced.repairEmergencyRestockTransientHits` | `3` | Transient repair failures before emergency restock/refresh. | Lower reacts faster; higher avoids restocking on brief lag. |
| `advanced.repairVerifySettleMs` | `180` | Wait before verifying repaired batch. | Increase if server updates blocks late. |
| `advanced.repairMaxMismatchRatio` | `0.25` | Warning threshold only; no hard abort. | Logs warning above 25 percent mismatches. |
| `advanced.repairMaxMismatchCount` | `512` | Warning count threshold only; no hard abort. | Logs warning when both count and ratio are high. |
| `advanced.useMapCornerYForNbtCarpets` | `true` | Use machine/map-corner Y for NBT carpets. | Keep `true` for this platform. |
| `advanced.repairBatchSize` | `256` | Number of repair targets per batch. | Lower for cautious repair; higher for fewer restocks. |
| `advanced.repairRestockMode` | `fast` | `fast`, `nerv`. | `fast` uses repair-focused restock; `nerv` uses normal material planner. |

Repair behavior:

1. Air/missing blocks are repaired while walking/sprinting.
2. Wrong/occupied blocks use stop-and-fix.
3. High mismatch count logs warnings, but autonomous mode continues.

#### 3.4.7 Miscellaneous

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.postBuildDelayMs` | `0` | Delay after build before post-print. | Usually `0`. |
| `advanced.retryInteractTimeoutMs` | `800` | Timeout for retrying interactions. | Increase if chest/block interactions are delayed. |
| `advanced.checkpointBuffer` | `0.35` | Goal radius around print checkpoints. | Higher reaches line end faster; lower is more exact. |
| `advanced.breakCarpetAboveReset` | `false` | Break carpet above reset area if configured. | Leave `false` unless reset needs clearing. |
| `advanced.pingDiagnosticsEnabled` | `true` | Logs ping breadcrumbs around desync/stall events and high-ping placement loops. | Set `false` only if the logs get too noisy. |
| `advanced.pingDiagnosticsThresholdMs` | `30` | Ping warning threshold in milliseconds. | `30` catches small 6b6t latency spikes during placement. |
| `advanced.pingDiagnosticsLogEveryMs` | `5000` | Throttle for live high-ping placement-loop logs. | Event-specific desync/stall ping logs are still printed immediately. |
| `advanced.debugPrints` | `false` | Extra verbose logs. | Use briefly; logs get noisy. |

### 3.5 `errorHandling`

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `errorHandling.logErrors` | `true` | Logs placement, repair, move, and skip details. | Keep `true` while tuning. |
| `errorHandling.errorAction` | `repair` | `repair` enables final repair passes. Other values skip repair. | Keep `repair` for autonomous accuracy. |

### 3.6 `multiUser`

File-based master/slave coordination. No in-game DM/chat system is required.

Simple rule:

1. Put all accounts in `bot.usernames`.
2. Set `enabled: true` for accounts you want active.
3. If `multiUser.enabled` is `false`, the printer uses the first enabled account only.
4. If `multiUser.enabled` is `true`, 2+ enabled accounts automatically use multibot.
5. `multiUser` is mostly timing/coordination settings. You usually do not need to edit `multiUser.bots`.

Examples:

```json
"bot": {
  "usernames": [
    {
      "name": "MyMainAccount",
      "enabled": true,
      "auth": "microsoft"
    },
    { "name": "MyAlt1", "enabled": false },
    { "name": "MyAlt2", "enabled": false }
  ]
}
```

```json
"bot": {
  "usernames": [
    { "name": "MyMainAccount", "enabled": true, "auth": "microsoft" },
    { "name": "MyAlt1", "enabled": true, "auth": "microsoft" },
    { "name": "MyAlt2", "enabled": true, "auth": "microsoft" }
  ]
}
```

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `multiUser.enabled` | `true` | Allows multibot when `bot.usernames` has 2+ names. | You can leave this `true`; one username still runs single-bot mode. |
| `multiUser.mode` | `file` | Currently `file`. | Uses JSON files in `syncFolder`. |
| `multiUser.syncFolder` | `./logs/nerv-printer-sync` | Folder for master/slave state files. | Can delete for a fresh coordination state. |
| `multiUser.requireAllReady` | `true` | Master waits for slaves before starting. | Keep `true` to avoid uneven starts. |
| `multiUser.recoveryMarginBlocks` | `20` | Distance margin for recovery/stale logic. | Reserved/coordination hint. |
| `multiUser.recoveryDelayMs` | `2000` | Delay before recovery actions. | Reserved/coordination hint. |
| `multiUser.staleStateMs` | `45000` | State older than this is considered stale. | Increase if bots lag/reconnect slowly. |
| `multiUser.heartbeatMs` | `5000` | State heartbeat write interval. | Lower detects stale faster; higher writes less. |
| `multiUser.resumeExistingJob` | `true` | Reuse existing job/progress after restart. | Keep `true` for autonomous recovery. |
| `multiUser.startAllOnMasterReady` | `true` | Start all workers when master releases job. | Keep `true`. |
| `multiUser.joinStaggerMs` | `12000` | Default join spacing. | Increase to avoid server anti-bot/DDOS warnings. |
| `multiUser.startStaggerMs` | `5000` | Default print start spacing. | Increase if startup causes lag spikes. |
| `multiUser.launchFromSingleProcess` | `true` | One Node process launches all configured bots. | Current supported mode. |

Legacy advanced roster: each entry in `multiUser.bots`.

This still works, but `bot.usernames` is simpler and preferred.

| Key | Meaning | Options / Hint |
|---|---|---|
| `multiUser.bots[].name` | Minecraft username for that bot. | Must be unique. |
| `multiUser.bots[].role` | `master` or `slave`. | Master performs post-print workflow after slaves finish. |
| `multiUser.bots[].enabled` | Include this bot in plan. | Set `false` to temporarily remove a bot. |
| `multiUser.bots[].joinDelayMs` | Delay before this bot joins. | Stagger joins to avoid server warnings. |
| `multiUser.bots[].startDelayMs` | Extra delay before this bot starts work. | Stagger starts to reduce lag. |

Intervals are assigned automatically across the 128 map columns. With 3 bots, current plan is roughly:

```text
MapartBot  -> columns 0-41
MapartBot1 -> columns 42-84
MapartBot2 -> columns 85-127
```

Verify without connecting:

```bash
npm run test:multi-user-plan
```

### 3.7 `dashboard`

Use this only when running the separate `dashboard-service` project.

This is a compact operator integration layer, not a full Mineflayer web inspector.

When `dashboard-service` is running, open `http://127.0.0.1:4080/` for the browser dashboard UI.

Current behavior:

1. The bot posts compact status snapshots to the dashboard service.
2. The bot polls the dashboard service for `start`, `stop`, and `assign-nbt` commands.
3. Assigned NBT files are downloaded into `files.nbtFolder`.
4. In direct mode, start and stop control the print loop for an already running bot process.
5. Starting a fully stopped process still requires an external supervisor or later host-agent layer.
6. Use `npm run start:nerv:wait` or `npm run start:nerv:6b6t:wait` to launch the process, connect, and wait idle for dashboard or terminal `start` and `stop` commands.

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `dashboard.enabled` | `false` | Enable direct bot-to-dashboard integration. | Keep `false` unless the dashboard service is running. |
| `dashboard.serviceUrl` | `http://127.0.0.1:4080` | Base URL of the dashboard service. | Point this to your deployed dashboard host. |
| `dashboard.hostLabel` | empty | Logical host label sent with status updates. | Set this on multi-host deployments so operators can distinguish machines. |
| `dashboard.heartbeatMs` | `5000` | Status POST interval in ms. | Lower gives fresher status; higher reduces traffic. |
| `dashboard.commandPollMs` | `3000` | Command polling interval in ms. | Lower reacts faster to operator actions. |
| `dashboard.idleWindowMs` | `15000` | Idle classification window in ms. | Raise if the bot often pauses briefly between phases. |
| `dashboard.staleMs` | `20000` | Stale classification window in ms. | Raise if public-server lag causes long apparent inactivity. |

### 3.8 `anchorTranslation` Diamond Block

Use this to relocate the full fixed machine layout by one anchor delta.

> NOTE: If anchor values are wrong, all translated machine positions will be wrong (map corner, dump spots, chest access, reset/xp/cartography interactions). Keep `sourceAnchor` correct for the base layout and only move `targetAnchor` for relocation.

The bot computes:

1. `delta.x = targetAnchor.x - sourceAnchor.x`
2. `delta.y = targetAnchor.y - sourceAnchor.y`
3. `delta.z = targetAnchor.z - sourceAnchor.z`

Then applies that delta to all machine coordinates loaded from the carpet config (map corner, dump stations, utility blocks, material chests, and material dict chest positions).

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `anchorTranslation.enabled` | `true` | Enable coordinate translation from source to target anchor. | Keep `true` when relocating imported machine layout. |
| `anchorTranslation.sourceAnchor.x/y/z` | `-706,-9,-962` | Anchor of the source/reference machine layout. | Do not change unless the imported machine config source changed. |
| `anchorTranslation.targetAnchor.x/y/z` | `-706,-9,-962` | Anchor of your current machine location. | Change this to move the whole machine coordinate set. |

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

## 5. Connection Overrides And `config.test.json`

If present, the first bot in `config.test.json` can override local bot connection values:

1. `host`
2. `port`
3. `username`
4. `auth`
5. `version`
6. `profilesFolder`
7. `viewDistance`
8. `checkTimeoutInterval`

After that, the selected `connection` profile is applied. This means:

1. `npm run start:nerv` uses `connection.active`, currently `local`.
2. `npm run start:nerv:local` forces localhost.
3. `npm run start:nerv:6b6t` forces 6b6t and overrides `config.test.json` connection values.
4. You can also run `node nerv-printer.js --connection=6b6t`.
5. Use `--config` to load a separate config file without changing the default `nerv-printer-config.json`.
   Example: `node nerv-printer.js --config=nerv-printer-config/_configs/nerv-printer-config-premium-1.json`

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
- per-bot files: `logs/nerv-printer-<bot>.log`
- archived `.log` files are rotated every `logging.rotateHours` hours and pruned after `logging.retentionHours` hours

Useful tags:

1. `[CONFIG]` config source and merge mode
2. `[STARTUP]` startup config summary (offset/reconnect/jump/input mode)
3. `[PLAN]` selected input and target count
4. `[RESUME]` resumed checkpoint position
5. `[PROBE]` startup support score
6. `[START]` nearest-corner start decision
7. `[NERV-WORKLOAD-BATCH]` time workload placement result for one row/chunk
8. `[NERV-WORKLOAD-ADAPT-SLOW]` adaptive slowdown after too many missing targets
9. `[NERV-WORKLOAD-ADAPT-RECOVER]` adaptive speed recovery after stable batches
10. `[NERV-SCANNER-SKIP]` skipped scanner placement and reason
11. `[NERV-DUMP]` dump plan and tossed slots
12. `[NERV-RESTOCK]` restock material choice
13. `[RESTOCK-PULL]` chest pull result
14. `[REPAIR-PASS]` repair pass summary
15. `[REPAIR-WARN]` repair warning that does not hard-stop autonomous mode
16. `[MULTI-*]` multibot plan, worker, ready, stale, and recovery messages
17. `[SESSION]` end status and retryability for reconnect loop
18. `[RECONNECT]` reconnect loop decisions (retry/wait/stop)

## 9. Scripts

From `package.json`:

1. `npm run start` runs `index.js`
2. `npm run start:nerv` runs `nerv-printer.js`
3. `npm run start:nerv:local` runs `nerv-printer.js --connection=local`
4. `npm run start:nerv:6b6t` runs `nerv-printer.js --connection=6b6t`
5. `npm run start:broadcast` runs quote broadcast mode in `index.js`
6. `npm run clean` removes install/auth caches
7. `npm run clean:install` clean install cycle

## 10. Minimal Example `nerv-printer-config/_configs/nerv-printer-config.json`

```json
{
  "bot": {
    "host": "127.0.0.1",
    "port": 54321,
    "usernames": [
      {
        "name": "MapartBot",
        "enabled": true,
        "auth": "offline"
      },
      {
        "name": "MapartBot1",
        "enabled": false,
        "auth": "microsoft"
      }
    ],
    "auth": "offline",
    "version": "1.21.8",
    "profilesFolder": "./auth-cache",
    "viewDistance": "normal",
    "checkTimeoutInterval": 60000
  },
  "connection": {
    "active": "local",
    "profiles": {
      "local": {
        "bot": {
          "host": "127.0.0.1",
          "port": 54321,
          "auth": "offline",
          "version": "1.21.8"
        }
      },
      "6b6t": {
        "bot": {
          "host": "alt.6b6t.org",
          "port": 25565,
          "auth": "microsoft",
          "version": "auto",
          "reconnect": {
            "enabled": true,
            "delayMs": 30000,
            "maxAttempts": 50
          }
        }
      }
    }
  },
  "files": {
    "inputMode": "nbt",
    "planFile": "./mapart-plan.json",
    "machineConfigProfile": "carpet",
    "machineConfigFile": "./nerv-printer-config/_configs/legacy-nerv-carpet-printer-config.json",
    "resumeProgress": true,
    "progressFile": "./logs/nerv-printer-progress.json",
    "progressSaveEvery": 10,
    "moveToFinishedFolder": true,
    "finishedFolder": "./finished-maps",
    "disableOnFinished": true
  },
  "printer": {
    "startOnSpawn": true,
    "startDelayMs": 1500,
    "allowJump": false,
    "placeWhileSprinting": true,
    "postPrintTestOnly": false,
    "printOffset": { "x": 0, "y": 0, "z": -1 },
    "linesPerRun": 3,
    "placeRange": 5,
    "minPlaceDistance": 0.8,
    "ignoredBlocks": [],
    "placeDelayMs": 0,
    "rotate": false,
    "northToSouth": true,
    "mapFillSquareSize": 1,
    "sprintMode": "off",
    "fastTraversalEnabled": true,
    "fastTraversalTickMs": 20,
    "maxPlacementsPerTick": 10
  },
  "advanced": {
    "preRestockDelayMs": 80,
    "inventoryActionDelayMs": 35,
    "postRestockDelayMs": 120,
    "predictiveRestock": true,
    "dumpUnneededBeforeRefill": true,
    "inventoryRefillRows": 2,
    "inventoryMaxMaterialTypes": 16,
    "postPrintWorkflowEnabled": true,
    "postPrintFillMapEnabled": true,
    "postPrintUseCartographyEnabled": true,
    "postPrintStoreFinishedMapEnabled": true,
    "postPrintResetEnabled": true,
    "postPrintInteractionDelayMs": 200,
    "dumpAlreadyNearRange": 4,
    "dumpGoalRange": 2,
    "scannerWorkloadMode": "time",
    "scannerPlaceDelayMs": 6,
    "scannerMaxCatchupPlacements": 10,
    "scannerLineEndSettleMs": 4500,
    "scannerAdaptiveSlowdown": true,
    "scannerAdaptiveMissingThreshold": 8,
    "scannerAdaptiveMinPlaceDelayMs": 6,
    "repairSprintMode": "always",
    "repairBatchSize": 256,
    "repairRestockMode": "fast",
    "retryInteractTimeoutMs": 800,
    "checkpointBuffer": 0.35
  },
  "errorHandling": {
    "logErrors": true,
    "errorAction": "repair"
  },
  "multiUser": {
    "enabled": true,
    "mode": "file",
    "syncFolder": "./logs/nerv-printer-sync",
    "requireAllReady": true,
    "staleStateMs": 45000,
    "heartbeatMs": 5000,
    "resumeExistingJob": true,
    "joinStaggerMs": 12000,
    "startStaggerMs": 5000
  },
  "anchorTranslation": {
    "enabled": true,
    "sourceAnchor": { "x": -706, "y": -9, "z": -962 },
    "targetAnchor": { "x": -706, "y": -9, "z": -962 }
  }
}
```
