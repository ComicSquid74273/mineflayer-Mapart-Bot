# Mapart Bot Complete Guide

> This was a test project, Skynet-vibecoded.

## Mapart Showcase

### Michael Jackson – Greatest Hits

![Michael Jackson – Greatest Hits](mapsartsimages/mj.png)

**50x50 Flat Carpet**

Botted on Skynet™ (in less than 3 days) by **ComicSquid74273** & **@𝓣𝔂𝓼𝓸𝓷𝓼𝔁𝔃** on **6b6t**.

### A Friend in Need

![A Friend in Need](mapsartsimages/fin.png)

**18x13 Flat Carpet (botted)**

Made by **@pyrovane** using Skynet.

Original painting: *A Friend in Need* by Cassius Marcellus Coolidge.

> “And so many more” maparts were made using this project.

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

1. Install Node.js 22 or newer (Node.js 24 LTS recommended).
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
| `bot.usernames[].loginPassword` | optional | Cracked/offline 6b6t `/login` password. | Keep tracked configs empty; use `NERV_LOGIN_PASSWORD_<ACCOUNT>` or `NERV_LOGIN_PASSWORD`. |
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
| `connection.profiles.6b6t.bot.version` | `26.1.2` | Server protocol version for 6b6t. | This is the newest stable Minecraft version supported by Mineflayer 4.38.0. |
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
| `printer.postPrintTestRuns` | `1` | Number of post-print-only test loops. CLI override: `--post-print-test-runs=N`; use `0`, `forever`, or `until-stop` to repeat until stopped. | Only applies with `postPrintTestOnly`, `--test-post-print`, or `--test-post-print-full`. |
| `printer.printOffset.x/y/z` | `0,0,-1` | Shift all print targets. | Wrong offset causes full-map misalignment. |
| `printer.linesPerRun` | `3` | Width of one print run in map columns/lines. | Higher is faster but can skip more; `3` is stable. |
| `printer.placeRange` | `5` | Placement scan/range radius. | Higher sees more targets; too high can pick awkward targets. |
| `printer.minPlaceDistance` | `0.8` | Avoid placing too close to feet. | Increase if bot glitches into carpets; lower if it misses near targets. |
| `printer.ignoredBlocks` | `[]` | Block names to skip, e.g. `["air"]` or carpet names. | Usually empty. |
| `printer.placeDelayMs` | `0` | Delay after standard `placeTarget` placements. | Fast workload uses `advanced.scannerPlaceDelayMs`. |
| `printer.rotate` | `false` | Rotate/look before placement in slower paths. | `false` is faster for packet/generic placement. |
| `printer.northToSouth` | `true` | Initial row direction. | Flip only if map traversal starts wrong side. |
| `printer.mapFillSquareSize` | `1` | Minimum center offset used by the map-render coverage route. The runtime expands this to safe interior waypoints across the configured map size. | Keep the default unless a machine needs a larger minimum offset. |
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
| `advanced.machineAccessSprintMode` | `disabled` | `enabled` always uses sprint for configured chest/machine approaches; `disabled` always walks; `automatic` switches modes based on net progress. The aliases `enable`/`disable` and booleans are also accepted. | Keep `disabled` where machine access crosses unfinished map sections; this does not change print traversal sprint. |
| `advanced.machineAccessReadySlack` | `1.25` | Adds fractional-position slack to strict configured access goals after `GoalNear` reaches its block node. | `1.25` keeps the bot inside interaction range while covering the observed 2.47-block block-node settle offset. |
| `advanced.machineAccessPreciseTolerance` | `0.2` | Final horizontal distance required from the configured fractional chest/machine `accessPosition`. | Strict access always performs this alignment even when the long-range path is already within its broader ready allowance. |
| `advanced.machineAccessCarpetRecoveryEnabled` | `true` | When the pathfinder makes no net progress while the bot is standing on carpet, stop that controller and walk directly toward the configured machine access point with normal movement packets. | The fallback is bounded by the original route timeout and never jumps, teleports, reconnects, or replays the inventory action. |
| `advanced.machineAccessCarpetRecoveryMaxDistance` | `3` | Maximum distance for the carpet-only direct movement fallback. | Longer routes remain owned by route-aware pathfinding so this fallback cannot cross the print platform blindly. |
| `advanced.machineAccessPathNodeRange` | `0.75` | Block-node radius used by route-aware pathfinding for strict machine access. | Values below one require the pathfinder to enter the configured access block before final alignment. |
| `advanced.machineAccessPreciseApproachRange` | `1.6` | Maximum remaining horizontal distance that the final direct checkpoint alignment may cover after route-aware pathfinding reaches the configured block. | Covers the maximum sub-block server settle offset while still rejecting the observed two-block unsafe walk. |
| `advanced.machineAccessPreciseVerticalTolerance` | `0.75` | Maximum Y drift allowed throughout a strict machine route and its final alignment. | Stops movement immediately if the bot climbs or falls away from the configured access elevation. |
| `advanced.configurationTransferWorldSettleMs` | `4000` | Minimum same-connection settle time after Velocity resumes destination PLAY before machine navigation or interaction. | Prevents the first chest click from racing the backend worker attachment; it does not retry or reconnect. |
| `advanced.machineAccessInteractionSettleMs` | `300` | Server-stability hold after a verified reachable-side interaction point is reached. | If the server reconciles the position during this hold, the same bounded approach continues before any click. |
| `advanced.machineAccessCarpetRecoveryAttempts` | `2` | Maximum number of direct-controller handoffs during one configured machine route. | A failed direct walk reaches the normal path error instead of cycling the session. |
| Upper `/home` landing | Automatic | Detects a server-settled position one block above machine elevation (including a full home pad or carpet) and selects one loaded cardinal egress with a passable foot cell, solid support, and two blocks of headroom. | The bot performs one bounded walk-only step down in the existing session; it never reconnects, teleports, jumps, crosses a gap, or retries the same failed landing. |
| `advanced.machineAccessThinkTimeoutMs` | `20000` | Maximum Mineflayer planning time for one configured machine route, still bounded by the overall route timeout. | Allows the planner to solve routes around an unfinished map instead of exhausting its 5-second library default. |
| `advanced.machineAccessDirectRoutePadding` | `80` | Search margin for the loaded flat-route handoff when the general planner stops at a nearby canvas frontier. | Large enough to find a perimeter bridge while every candidate cell remains surface/liquid/elevation validated; a carpet block at foot level is a valid walking surface even when its base block is non-solid. |
| `advanced.machineAccessDirectRouteMaxNodes` | `50000` | Maximum unique floor cells examined by one local route plan. | The minimum-gap search visits each physical cell once while covering a partially damaged map floor and bounding CPU work. |
| `advanced.machineAccessDirectRouteMaxTimeoutMs` | `60000` | Maximum movement time for a verified flat-route handoff. | Long detours remain bounded and cannot leave the configured elevation. |
| `advanced.machineAccessDirectFrontierAdvances` | `8` | Maximum number of loaded-floor frontier sections traversed during one machine access route. | Each section is floor, clearance, elevation, and hazard validated before walking; reaching this bound fails the route in place. |
| `advanced.machineAccessDirectFrontierMinProgress` | `0.5` | Minimum target-distance improvement required before a partial loaded-floor frontier may be followed. | Prevents sideways wandering when the next safe platform section is not yet reachable. |
| `advanced.machineAccessVerifiedGapCrossingEnabled` | `false` | Allows an explicit jump across one individually confirmed empty floor cell during a verified flat machine route. | Disabled by default because live server physics can reject an otherwise valid crossing. Multi-cell gaps are always rejected, even when configured wider. |
| `advanced.machineAccessVerifiedDiagonalGapEnabled` | `false` | Legacy compatibility flag for diagonal gap planning. | Diagonal seams require two unsupported cells and are rejected by the runtime one-cell hard limit. |
| `advanced.machineAccessVerifiedGapCrossingMaxPerRoute` | `16` | Legacy upper bound for opt-in one-cell cardinal crossings in one machine route. | Has no effect while verified gap crossing remains disabled; multi-cell and diagonal gaps are always rejected. |
| `advanced.machineAccessVerifiedGapMaxWidth` | `1` | Maximum consecutive true-air floor cells an explicit cardinal crossing may span. | The runtime hard-caps this at one; wider voids fail in place. |
| `advanced.machineAccessVerifiedGapTimeoutMs` | `2200` | Hard limit for each opt-in verified machine gap crossing. | A timeout releases forward, jump, and sprint immediately and fails the route in place. |
| `advanced.machineAccessVerifiedGapJumpHoldMs` | `500` | How long jump remains pressed at the centered start of the opt-in one-cell crossing. | Sprint is never required for this crossing. |
| `advanced.machineAccessLiquidProximityRadius` | `0` | Optional whole-cell liquid exclusion radius in addition to exact liquid avoidance and live 0.35-block hitbox checks. | Keep `0` for narrow machine entrances; increase only where the platform has enough clearance. |
| `advanced.machineAccessBlockInteractionPlanReach` | `4.4` | Maximum eye-to-block distance used to plan a safe reachable-side interaction when the captured standing point is across a floor trench. | Leaves protocol reach margin and keeps the player's hitbox inside the supported cell. |
| `advanced.machineAccessBlockInteractionMaxReach` | `4.45` | Final eye-to-block validation limit for a reachable-side machine interaction. | Must remain below the server's interaction reach; this never permits walking into a gap or lift. |
| `advanced.pauseParkAtCartographyEnabled` | `false` | Moves an operator-paused bot to the cartography access point before idling. | Keep disabled so pause cancels movement and leaves the connected bot in place; enable only on a platform with a verified safe parking route. |
| `advanced.autoEatEnabled` | `true` | Enables demand-driven survival eating. | The food chest is opened only when the bot needs to eat and carries no configured food. |
| `advanced.autoEatMinHunger` | `12` | Eat before a traversal batch when hunger is below this value. | A satisfied bot performs only an in-memory hunger check; a bot that needs chest food stages at a verified workload entry before leaving the active map route. |
| `advanced.autoEatMinHealth` | `12` | Treat health at or below this value as unsafe for machine/post-print travel. | Post-print waits for recovery after eating before carrying a map. |
| `advanced.autoEatTargetHunger` | `20` | Hunger target reached before guarded post-print movement begins. | Keep at `20` so natural health regeneration has full food saturation. |
| `advanced.autoEatFoodItem` | `cooked_beef` | Item pulled from `machine.foodChest` and consumed. | `cooked_beef` is Minecraft steak. |
| `advanced.autoEatReturnUnusedFood` | `false` | Legacy compatibility setting. Printer bots retain leftover survival food in inventory and refill only after it is exhausted. | Keep `false`; food and XP bottles are protected from inventory dumps. |
| `advanced.supportStockDashboardWarningsEnabled` | `true` | Sends low-stock warnings from authoritative chest snapshots captured at the point of use. | No startup/per-NBT support-stock circuit is performed. Food has no extra-stock threshold. |
| `advanced.supportStockXpBottleMinStacks` | `5` | Low-stock warning threshold for XP bottles observed immediately before `rename_store`. | XP storage is not visited when the bot already has the minimum rename level. |
| `advanced.supportStockEmptyMapMinStacks` | `1` | Low-stock warning threshold for empty maps observed during post-print `withdraw`. | The same authoritative snapshot is used to withdraw the required map. |
| `advanced.supportStockGlassPaneMinStacks` | `1` | Low-stock warning threshold for glass panes observed during post-print `withdraw`. | The same authoritative snapshot is used to withdraw the required pane. |
| `advanced.requiredStockRefillRetryMs` | `5000` | Recheck interval after a required food, map/pane, or XP chest is authoritatively confirmed empty. | The bot holds the exact current step until refill and does not reconnect or advance. |
| `advanced.requiredStockRefillLogEveryMs` | `30000` | Throttle for repeated required-stock hold logs. | A red dashboard alert remains active until refill is verified. |
| `advanced.anvilPillarMinCount` | `3` | Minimum anvils expected in the vertical pillar at `machine.anvil`. | Dashboard warns when visible anvils drop below this. |
| `advanced.anvilPillarScanLimit` | `16` | Max vertical blocks to scan upward from `machine.anvil`. | Raise only if the pillar is taller than 16 anvils. |
| `advanced.platformWatchdogEnabled` | `true` | Pauses pathing/placing if the bot leaves platform bounds or enters limbo coords. | Keep enabled on public servers/restarts. |
| `advanced.platformWatchdogPollMs` | `1000` | How often the runtime platform watchdog checks position. | Lower reacts faster; higher is calmer. |
| `advanced.platformHoldLogMs` | `5000` | Log interval while waiting in platform hold. | Raise if logs are too noisy during restarts. |
| `advanced.platformHoldStuckTimeoutMs` | `180000` | Diagnostic interval for a continuously unresolved platform hold. | The bot stays connected and keeps inventory/path work paused; this interval never triggers a reconnect. |
| `advanced.platformHorizontalMargin` | `30` | Extra X/Z blocks included around the configured map footprint for platform classification. | Includes nearby chests and machines. |
| `advanced.platformVerticalToleranceBelow` | `8` | Lowest accepted platform elevation relative to `machine.mapCorner.y`. | Prevents a bot tens of blocks below the platform from being treated as ready only because X/Z match. |
| `advanced.platformVerticalToleranceAbove` | `12` | Highest accepted platform elevation relative to `machine.mapCorner.y`. | Includes elevated platform machines without accepting unrelated terrain. |
| `advanced.highLatencyReconnectEnabled` | `true` | Observe and report ping that stays high for a sustained window without changing the live connection. | Rides with `platformWatchdogEnabled`; despite the legacy key name, this is diagnostic-only. |
| `advanced.highLatencyReconnectThresholdMs` | `500` | Ping (ms) at/above which the sustained-latency timer runs. | Raise if 500ms is too aggressive for your hosts. |
| `advanced.highLatencyReconnectDurationMs` | `300000` | Ping must stay at/above the threshold continuously this long (default 5 min) before the sustained-latency diagnostic is emitted. Any dip below the threshold resets the timer. | This legacy-named setting never reconnects the live session. |
| `advanced.highLatencyReconnectPollMs` | `5000` | How often ping is sampled for this watchdog. | Lower samples more often. |
| `advanced.highLatencyReconnectLogMs` | `30000` | Log interval for the `[HIGH-LATENCY]` countdown while latency is high. | Raise to reduce log noise. |
| `advanced.lobbyHostFailoverEnabled` | `true` | During 6b6t startup, treat a continuous stay in any monitored observed lobby as a failed host session. | Disable only when intentionally testing or holding in those lobbies. |
| `advanced.lobbyHostFailoverRegions` | all built-in observed lobby names | Lobby-region names that trigger startup host failover. | Includes the radius-10 low lobby and the stationary overworld-origin radius-50 guard even when VM-local configs are preserved. |
| `advanced.lobbyHostFailoverRegion` | `observed-2026-06-new-lobby` | Legacy singular lobby-region setting. | It remains compatible and also keeps the built-in low-lobby and origin-stall guards monitored; use the plural setting for an exact custom list. |
| `advanced.lobbyHostFailoverTimeoutMs` | `60000` | Continuous time in one failover lobby before the startup session ends and advances to the next hostname. | Leaving or changing the region resets the timer. |
| `advanced.lobbyHostFailoverPollMs` | `1000` | How often the startup session checks the current lobby region. | Keep below the timeout while avoiding excessive polling. |

The canonical 6b6t profiles retain `spawn-portal-overworld-0` and `spawnDisk` for future portal restoration, but both are disabled. A bot that remains within 50 blocks of the overworld origin without moving meaningfully for 60 seconds is handled as a failed startup host and advances through the existing hostname reconnect rotation.
| `advanced.startupSupportProbeEnabled` | `true` | Wait for platform support blocks to be visible before restock/print starts. | Prevents `support=0/64` from running inventory logic too early. |
| `advanced.startupSupportMinRatio` | `0.5` | Minimum startup support ratio required to continue. | `0.5` means at least half the sampled supports must be loaded. |
| `advanced.startupSupportPollMs` | `5000` | Wait between startup support rechecks. | Raise on very laggy servers. |
| `advanced.startupSupportLogMs` | `15000` | Log interval while waiting for startup support. | Raise to reduce log noise. |

#### 3.4.1 Inventory, Restock, And Dump

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.restockSyncStrategy` | `nerv-window` | `nerv-window` queues full chest stacks from the synced window snapshot; `safe` keeps per-stack confirmation waits. | Use `safe` only if the fast path falls back repeatedly on a laggy server. |
| `advanced.preRestockDelayMs` | `80` | Delay before restock interaction. | Increase if chest opens before bot is ready. |
| `advanced.inventoryActionDelayMs` | `35` | Delay between inventory clicks/actions. | Increase if item transfers are unreliable. |
| `advanced.postRestockDelayMs` | `120` | Delay after restock. | Increase if inventory update arrives late. |
| `advanced.inventoryExtraStateSyncMs` | `0` | Optional extra wait after each Mineflayer window click on state-id versions. | Keep `0`; set `150` to restore the older conservative click wrapper. |
| `advanced.restockFastSettleMs` | `0` | Extra settle wait after a fast restock burst before checking the open window. | Keep `0` with `nerv-window`; raise only if server window updates arrive late. |
| `advanced.restockChestAccessRange` | `1.25` | Max distance from the configured restock `open` point before opening a chest. | Lower if the bot stops just outside reach; raise only if the open point is hard to path to. |
| `advanced.restockChestOpenAttempts` | `3` | Number of bounded chest-open attempts before trying the next chest. Container packet decode errors bypass retries and skip straight to the next chest. | Raise on intermittent server interaction lag. |
| `advanced.restockChestOpenTimeoutMs` | `2500` | Per-attempt fallback for a silent server response; decoded protocol errors fail immediately without waiting for this timeout. | Raise if chest windows appear very late. |
| `advanced.restockPostCloseInventorySyncMs` | `2000` | Max wait after closing a restock chest for local inventory/hotbar to show the moved stack. | Prevents printing from resuming from chest-window state before the bot can actually select the item. |
| `advanced.restockFailureCooldownMs` | `250` | Cooldown after failed material restock. | Increase if bot loops too fast on empty chests. |
| `advanced.containerProtocolReconnectEnabled` | `true` | Reconnect immediately when a container slot/component packet cannot be decoded. | The saved print/post-print checkpoint resumes after a clean session replaces the corrupted window stream. |
| `advanced.containerOpenFailureReconnectThreshold` | `2` | Consecutive fully exhausted container-open calls before reconnecting. `0` disables. | Prevents endless chest scans in a session that no longer opens containers reliably. |
| `advanced.containerSnapshotFailureReconnectThreshold` | `2` | Consecutive opened windows that never receive an authoritative server contents snapshot before reconnecting. `0` disables. | Prevents a delayed empty local window from being mistaken for an empty chest on only the slower bot connections. |
| `advanced.restockChestSnapshotWaitMs` | `2000` | Maximum wait for the server-owned chest contents packet before scanning or withdrawing. | Keep above the slowest proxy round trip; this replaces timing guesses based only on `preRestockDelayMs`. |
| `advanced.restockChestSnapshotStableMs` | `150` | Stability interval after the authoritative contents packet arrives. | Allows closely-following slot updates to settle without slowing healthy chest reads significantly. |
| `advanced.waitForRequiredMaterialRestockEnabled` | `true` | Keep checking every configured chest for a required carpet color when it is empty. | Keep `true` for duper-fed chests so print targets are not skipped. |
| `advanced.waitForRequiredMaterialRetryMs` | `5000` | Wait between full scans of all configured chests for the missing color. | Lower checks dupers more often; higher reduces chest traffic. |
| `advanced.waitForRequiredMaterialLogEveryMs` | `30000` | Throttle for missing-material wait logs. | Keeps long waits readable. |
| `advanced.waitForRequiredMaterialTimeoutMs` | `0` | Max wait for a required material; `0` means wait forever. | Use nonzero only if you prefer the run to eventually continue/fail. |
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
| `advanced.postPrintFillMapMultiAttemptEnabled` | `false` (`true` in the `6b6t` profile) | Withdraw several empty maps and retry activation when a filled map vanishes. One empty map is kept in reserve so each attempt starts with at least two maps in the held stack; unused maps are returned after the finished map is stored. | Enable for the 6b6t single-map disappearance bug. |
| `advanced.postPrintFillMapMaxAttempts` | `6` | Maximum empty-map activation attempts when multi-attempt fill is enabled. The bot withdraws this many maps plus one reserve. | Keep at `6` for the observed 6b6t failure rate. |
| `advanced.postPrintUseCartographyEnabled` | `true` | Use cartography table/glass pane. | Disable if manually locking/copying maps. |
| `advanced.postPrintStoreFinishedMapEnabled` | `true` | Store final map in finished chest. | Disable for manual collection. |
| `advanced.postPrintResetEnabled` | `true` | Run reset after post-print. | Disable if reset machine is not configured. |
| `advanced.postPrintXpRefillEnabled` | `true` | Refill/handle XP for post-print actions. | Useful when cartography/rename needs XP. |
| `advanced.postPrintRenameMapEnabled` | `true` | Rename map during post-print. | Disable if anvil/name flow is not wanted. |
| `advanced.postPrintRequireRenameBeforeStore` | `true` | If `true`, do not deposit a filled map unless the exact renamed map is verified. If verification fails, the live session and checkpoint enter `blocked-awaiting-operator`. | Keep `true` so an unrelated or unrenamed map never enters the finished chest. |
| `advanced.postPrintRenameAttempts` | `3` | Maximum bounded anvil actions within one rename transaction before preserving the map in a safety hold. | This does not reconnect or replay the post-print workflow. |
| `advanced.postPrintFinishedChestReversibleProbeEnabled` | `false` | Opt-in diagnostic that deposits and retrieves one ordinary item to test whether a finished chest is reversible. | Keep `false` for hopper-backed or write-only finished storage. |
| `advanced.postPrintFinishedChestFullRetryMs` | `5000` | Interval between authoritative finished-map chest capacity checks while every configured output chest is full. | Printing and post-print work remain paused; survival eating may still run. |
| `advanced.postPrintFinishedChestOpenAttempts` | `2` | Bounded open attempts per finished-map output chest before moving to the next configured candidate. | Transient 6b6t window-open loss is retried in the same session. |
| `advanced.postPrintFinishedChestOpenRetryDelayMs` | `500` | Delay between bounded finished-map chest open attempts. | The completed map remains in inventory during retry. |
| `advanced.postPrintFinishedChestFullLogEveryMs` | `30000` | Minimum interval for repeated full-output-chest log messages. | The red dashboard alert remains active on every heartbeat until space is verified. |
| Post-print survival gate | Automatic | Before withdraw, fill, cartography, rename/store, reset, and center movement, the bot eats to the configured target and waits above both safety thresholds. | A low-hunger resume cannot carry or lose a finished map; this wait never reconnects or restarts the bot. |
| `advanced.postPrintWorkflowTimeoutEnabled` | `true` | Enforces one active-work hard deadline across withdraw, fill-map, pixel proof, cartography, rename/store, reset, and center. Server-verified finished-output and required-stock refill holds are excluded from this deadline. | Expiry blocks the exact persisted step in the same live session; it never reconnects, restarts, or replays the workflow. |
| `advanced.postPrintWorkflowTimeoutMs` | `600000` | Hard limit for one post-print execution (default 10 min, safely below the 30-minute fault threshold). | The unfinished checkpoint, exact map ID, and cartography-completion proof are preserved for diagnosis. |
| `advanced.postPrintRenameWindowReadyMs` | `5000` | Max wait for the opened anvil window to show the filled map in its inventory slots before renaming. | Prevents "Can't find filled_map in slots" failures on laggy ticks. |
| `advanced.postPrintFillMapWaitMs` | `15000` | Max wait for the activated map to appear as `filled_map` in inventory. | Polls every 100ms and exits early; delayed server inventory updates do not force a checkpoint recycle. |
| `advanced.postPrintMapRenderCheckEnabled` | `true` | Verify all 128x128 map pixels through authoritative map packets before the cartography lock freezes them. | Missing/incomplete proof blocks the handoff; it never silently accepts a blank-edged map. |
| `advanced.postPrintMapRenderMinPixels` | `16384` | Minimum drawn pixels required by the render check. | Lower only if your plans intentionally leave unrendered area. |
| `advanced.postPrintMapRenderWaitMs` | `20000` | Max wait (latency-adjusted) for map pixels to finish rendering while holding the exact map. | The bot performs one deterministic surface-coverage traversal, then requires the server map packet to prove all configured pixels before locking. |
| `advanced.postPrintMapRenderTraversalInset` | `8` | Distance kept inside each configured map edge for the render-coverage waypoints. | `8` keeps the bot safely on the printed surface while loading the outer map chunks on small server view distances. |
| `advanced.postPrintMapRenderCoveragePointSettleMs` | `4000` | Minimum time to hold the exact filled map at the current position before coverage travel and at each reached waypoint. | Covers a full time-sliced map update cycle even when server TPS is low. |
| `advanced.postPrintMapRenderCoverageQuietMs` | `1500` | Required quiet period after the latest authoritative pixel increase at a coverage point. | Keeps receiving a packet burst instead of leaving at a fixed wall-clock boundary. |
| `advanced.postPrintMapRenderCoverageMaxSettleMs` | `8000` | Hard cap for progress-aware settlement at one coverage point. | Bounds post-print time if the server stops sending useful map pixels. |
| `advanced.postPrintMapRenderMissingBucketSize` | `16` | Pixel bucket size used to locate incomplete areas after the whole-surface route. | Converts the server's missing-pixel bitmap into targeted, safe completion locations. |
| `advanced.postPrintMapRenderMissingMaxPoints` | `16` | Maximum targeted missing-pixel completion points. | Prevents an unbounded route while covering narrow missing rows or columns. |
| `advanced.postPrintMapRenderTraversalMoveTimeoutMs` | `60000` | Hard limit for each coverage waypoint movement. | Coverage and final-center movement use a loaded, supported, cardinal flat-floor route with liquids and every floor gap rejected; they never jump, restart, or reconnect. |
| `advanced.postPrintMinXpLevel` | `2` | Minimum XP before refill behavior. | Raise if rename costs more. |
| `advanced.postPrintTargetXpLevel` | `3` | Desired XP target after refill. | Raise for repeated post-print actions. |
| `advanced.postPrintXpBottlePullStacks` | `1` | Legacy compatibility setting. XP refill now takes at most half a stack when no bottles remain in inventory. | XP is acquired only immediately before anvil rename. |
| `advanced.postPrintXpBottleMaxThrows` | `64` | Maximum XP bottles to throw during one post-print XP refill. | Safety cap for laggy XP pickup. |
| `advanced.postPrintReturnUnusedXpBottles` | `false` | Legacy compatibility setting. Unused XP bottles remain protected in inventory for the next rename. | Keep `false` to avoid unnecessary chest trips. |
| `advanced.postPrintSkipResetInteraction` | `false` | Skip reset interaction while keeping workflow. | Useful for testing post-print without resetting. |
| `advanced.postPrintWalkToCenter` | `true` | Walk to map center during fill. | Disable if fill path is handled externally. |
| `advanced.postPrintCenterWaitMs` | `20000` | Wait at center during map fill. | Increase if map fill is incomplete. |
| `advanced.postPrintInteractionDelayMs` | `200` | Delay around post-print clicks. | Increase for laggy servers. |
| `advanced.postPrintChestSyncWaitMs` | `2500` | Maximum wait for an authoritative output/input chest contents snapshot during post-print. | The bot refuses stale local chest state and exposes the failing invariant without reconnecting. |
| `advanced.postPrintChestStableMs` | `150` | Stability interval after the authoritative post-print chest snapshot arrives. | Allows closely-following slot updates to settle before withdrawal or deposit. |
| `advanced.postPrintChestPollMs` | `100` | Poll interval while confirming post-print chest state and item movement. | Lower values react faster but do not bypass server confirmation. |
| `advanced.postPrintMapSettleDelayMs` | `200` | Wait after map actions. | Increase if map item updates late. |
| `advanced.postPrintCartographyAccessRange` | `0.85` | Max distance from cartography access point before opening the table. | Keep slightly above pathfinder settle drift; `0.6` was too strict on 6b6t. |
| `advanced.postPrintCartographyInteractionPlanReach` | `3.75` | Nearest-block reach used while selecting a safe cartography interaction cell. | Leaves margin for the selected face hit-point instead of planning at the generic machine reach edge. |
| `advanced.postPrintCartographyInteractionMaxReach` | `3.8` | Maximum settled nearest-block distance before the first cartography table click. | The map transaction remains single-attempt; an unsafe edge position is rejected before any input is inserted. |
| `advanced.postPrintCartographyRecoveryWaitMs` | `15000` | Bounded wait for a late authoritative locked-map result after an output acknowledgement timeout. | If proof still does not arrive, the current session is recycled and resumes the saved cartography checkpoint. |
| `advanced.requiredStockOperationalRetryAttempts` | `3` | Attempts for transient support-container navigation or protocol failures. | Transient retries stay out of missing-stock warnings; only an exhausted operational failure is reported before the saved checkpoint is recycled. |
| `advanced.requiredStockOperationalRetryMs` | `2000` | Delay between transient support-container verification attempts. | Keep short enough to recover one missed container open without creating a tight loop. |
| `advanced.platformStallActiveRecoveryMs` | `300000` | Maximum unchanged active-work checkpoint time before session recycling. | Explicit stock, coordination, and operator waits are excluded. |

#### 3.4.3 Dump Station

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `advanced.dumpAimSettleMs` | `150` | Wait after aiming at dump station. | Increase if toss direction is inconsistent. |
| `advanced.dumpYawInvert` | `false` | Invert configured dump yaw. | Only change if yaw is mirrored. |
| `advanced.dumpPitchInvert` | `false` | Invert configured dump pitch. | Only change if pitch is mirrored. |
| `advanced.dumpTestStationWaitMs` | `7000` | Wait at each station in dump test. | Test-only. |
| `advanced.dumpTestTossAtEachStation` | `true` | Toss test item at every dump station. | Test-only. |
| `advanced.dumpPathThinkTimeoutMs` | `5000` | Pathfinder think timeout for dump station. | Increase if dump path fails. |
| `advanced.dumpAlreadyNearRange` | `2` | Legacy coarse-arrival setting retained for config compatibility. | Final dump alignment always uses `dumpPreciseTolerance`. |
| `advanced.dumpGoalRange` | `1` | Coarse pathfinder radius before precise dump alignment. | The calibrated point is still reached exactly after pathfinding. |
| `advanced.dumpPreciseTolerance` | `0.2` | Maximum distance from the configured dump point before the bot precisely aligns. | Keep small because dump yaw/pitch is calibrated from this point. |
| `advanced.dumpInventoryStableMs` | `2500` | Time a toss must remain absent from inventory before it is counted as dumped. | Covers the item pickup-delay window so re-collected stacks are never reported as freed space. |
| `advanced.dumpInventoryConfirmTimeoutMs` | `6000` | Maximum time to prove a stable inventory decrease after a dump batch. | Increase only if inventory packets are unusually delayed. |
| `advanced.dumpInventoryPollMs` | `50` | Inventory sampling interval during dump confirmation. | The default is fast enough to observe re-pickup without adding packet traffic. |
| `advanced.dumpRetreatDistance` | `3` | Safe backward distance after tossing a dump batch. | Moves the bot outside the dropped-item pickup area before inventory confirmation. |
| `advanced.dumpRetreatTimeoutMs` | `1800` | Maximum time for the verified post-dump retreat. | Kept below the normal dropped-item pickup delay. |
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
| `advanced.scannerLineEndSettleMs` | `4500` | Wait at line end while placement loop continues before the line-end world-state repair check. | Increase if `missing` remains high; decrease if stable and too slow. |
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
| `advanced.workloadCheckpointTimeoutAcceptExtraRange` | `0.35` | Extra distance accepted when a checkpoint times out but the bot is already effectively at the target. | Prevents near-goal pathfinder hesitation from aborting the run. |
| `advanced.workloadStraightCheckpointMovement` | `true` | Uses Nerv-style forward walking for in-lane workload checkpoints instead of pathfinder. | Keep enabled; pathfinder is still used for restock/start travel. |
| `advanced.workloadStraightCheckpointTickMs` | `50` | Control/look update interval for straight print-lane movement. | Match Minecraft tick pacing unless steering looks choppy. |
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
[NERV-WORKLOAD-LINEEND-REPAIR] unresolved=...; repairing before next traversal leg.
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
| `advanced.repairConfirmFastPlacements` | `true` | Confirm fast moving repair placements before counting them as placed. | Keep `true`; prevents packet-only clicks from hiding missed repairs. |
| `advanced.repairFastConfirmMs` | `180` | Confirmation window for fast repair placement. | Increase if repair clicks are accepted late under lag. |
| `advanced.repairFastConfirmPollMs` | `15` | Poll interval while confirming fast repair placement. | Keep small for responsive repair retries. |
| `advanced.repairVerifySettleMs` | `120` | Wait before verifying repaired batch. | Increase if server updates blocks late. |
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
| `advanced.dashboardResultStageRetryMs` | `5000` | Retry interval when a coordinated master cannot durably stage the dashboard completion result before retiring its NBT. | The exact NBT and team remain live and retry automatically; no manual Start is required. |
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
| `multiUser.resumeExistingJob` | `true` | Reuse the same active job ID, generation, manifest, and per-worker progress after a full service restart. | Keep `true` so workers continue from their saved phase/index instead of republishing or rescanning from target zero. |
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

### 3.6.1 `playerJoinMessaging`

Optional direct messages for newly joined players. Disabled by default. The bot sends only during the exact dashboard `printing` phase, ignores players already online when the runtime becomes ready, coalesces simultaneous joins to the newest player, and uses `/msg <username> <message>`.

The dashboard bot card can start or stop advertising live. The desired state is persisted and reapplied after reconnects; stopping advertising cancels pending sends and message-list polling immediately.

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `playerJoinMessaging.enabled` | `false` | Enables join messaging and dashboard message-list polling. | Enable only on selected bot configs. Disabled bots make no message-list requests. |
| `playerJoinMessaging.masterOnly` | `true` | Prevents multibot slave accounts from sending duplicate messages. | Keep `true` for multi-account nodes. |
| `playerJoinMessaging.joinDelayMs` | `1000` | Wait after the newest join before messaging. | Minimum is one second. |
| `playerJoinMessaging.intervalMs` | `3000` | Minimum time between messages. | Joins during the interval replace the pending target; only the newest receives a message. Successful sends rotate through the list in order. |
| `playerJoinMessaging.messageListPollMs` | `30000` | Dashboard list-version check interval. | The dashboard returns the list only when its version changes. |
| `playerJoinMessaging.defaultMessages` | two messages | Used until a custom CSV exists. | Each one-column CSV upload fully replaces the previous list; no CSV file is retained. |

### 3.7 `dashboard`

Use this only when running the separate `dashboard-service` project.

This is a compact operator integration layer, not a full Mineflayer web inspector.

When `dashboard-service` is running, open `http://127.0.0.1:4080/` for the browser dashboard UI.

Current behavior:

1. The bot posts compact status snapshots to the dashboard service.
2. The bot polls the dashboard service for `start`, `stop`/pause, and `assign-nbt` commands.
3. Assigned NBT files are downloaded into `files.nbtFolder`.
4. In direct mode, start and pause control the print loop for an already running bot process. Pause keeps saved progress and blocks automatic queue/progress resume until start is pressed again.
5. Starting a fully stopped process still requires an external supervisor or later host-agent layer.
6. Use `npm run start:nerv:wait` or `npm run start:nerv:6b6t:wait` to launch the process, connect, and wait idle for dashboard or terminal `start` and `pause`/`stop` commands.
7. `RESETEVERYTHING` stops active work, deletes fresh-start state, opens the configured reset container, waits through the intentional backend world transition, verifies the platform again, and clears the previous dashboard error only after cleanup succeeds.

| Key | Current | Options / Meaning | Tuning hint |
|---|---:|---|---|
| `dashboard.enabled` | `false` | Enable direct bot-to-dashboard integration. | Keep `false` unless the dashboard service is running. |
| `dashboard.serviceUrl` | `http://127.0.0.1:4080` | Base URL of the dashboard service. | Point this to your deployed dashboard host. |
| `dashboard.hostLabel` | empty | Logical host label sent with status updates. | Set this on multi-host deployments so operators can distinguish machines. |
| `dashboard.heartbeatMs` | `5000` | Status POST interval in ms. | Lower gives fresher status; higher reduces traffic. |
| `dashboard.commandPollMs` | `3000` | Command polling interval in ms. | Lower reacts faster to operator actions. |
| `dashboard.queuePrefetchHighWater` | `10` | Maximum dashboard queue NBTs a node keeps locally buffered. | Refilled by batch claim when the local dashboard queue buffer drops below the low-water mark. |
| `dashboard.queuePrefetchLowWater` | `3` | Local dashboard queue buffer threshold that triggers refill. | The dashboard caps batch claims to one file while pending queue depth is below `10 * knownNodes`. |
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
19. `[CONFIG-TRANSFER]` Velocity backend configuration guard activity. During a healthy 6b6t portal transfer this pauses physics, reports blocked play packets, and resumes after the destination position packet.

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
          "version": "26.1.2",
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
    "machineAccessSprintMode": "disabled",
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

Inspired From Nerv-Printer By Julflips. 

