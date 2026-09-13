# Dashboard Service

This is a separate dashboard service for operating mapart bots.

For the full Windows desktop workflow, see `docs/DESKTOP-DASHBOARD-SETUP.md` from the repo root.

The dashboard is viewable without authentication. Operator accounts are stored in `data/operators.json`, and role-gated actions plus log downloads require operator authentication.

## Scope

Version 1 is intentionally narrow:

- start and pause print-work commands for already running printer bots
- Delivery Bot process start/stop/reconnect controls for the configured delivery runtime
- compact per-bot status
- NBT upload with individual bot assignment or node/shared-folder assignment
- bot command polling and result reporting
- browser UI for operators

This service does not include raw Mineflayer inspection or arbitrary file system access.

Important: printer fleet controls do not cold-start stopped printer Node.js processes. Start printer bot processes first, ideally in wait mode, then use the dashboard to start or pause printing. The Delivery Bot panel is the exception: its admin-only Start/Stop/Reconnect controls manage the configured delivery process from `nerv-printer-config/_configs/delivery-bot-config.json`. The delivery connection is detected from fresh printer heartbeats or node runtime configs, then falls back to the delivery config's active profile. Pause keeps saved print progress and blocks automatic queue/progress resume until start is pressed again.

## Storage

The service stores JSON metadata under `data/` and uploaded NBT files under `data/files/`.

Operator accounts live in `data/operators.json` as plain JSON records so you can inspect and edit them directly when needed.

Uploaded NBTs can be assigned to individual bots or to nodes by `hostLabel`. Bot assignment is the default and is best when multiple bot runtimes on the same IP should receive separate files. Node assignment is best when bots on that node share the same `nbtFolder`; one bot claims the file and downloads it into that shared folder.

## Run

```bash
cd dashboard-service
npm start
```

Then open:

```text
http://127.0.0.1:4080/
```

Environment variables:

- `DASHBOARD_PORT` - HTTP port, default `4080`
- `DASHBOARD_HOST` - bind host, default `0.0.0.0`
- `DASHBOARD_DATA_DIR` - storage directory, default `dashboard-service/data`
- `DASHBOARD_LOGS_DIR` - directory used for authenticated `.log` downloads, default repo `logs/`; the service also checks `./logs` and the dashboard user's home directory for files such as `dashboard.log`
- `DASHBOARD_NODE_DOWNLOAD_TIMEOUT_MS` - max wait for node log/config download commands, default `60000`
- `DASHBOARD_ADMIN_USERNAME` - first-run admin username when `operators.json` does not exist, default `admin`
- `DASHBOARD_ADMIN_PASSWORD` - first-run admin password when `operators.json` does not exist, default is a generated value written to `operators.json`
- `DASHBOARD_SEED_DEMO_OPERATORS=true` - opt in to legacy demo accounts for local testing only
- `DASHBOARD_TRUST_PROXY_IP_HEADERS=true` - use `CF-Connecting-IP`, `X-Real-IP`, or `X-Forwarded-For` for login/support rate limits when the dashboard is behind a trusted proxy that strips client-supplied spoofed headers
- `DASHBOARD_SMTP_CONFIG_FILE` - optional path to the `/home` support mail config file, default `dashboard-service/smtp-config.env`
- `DASHBOARD_SUPPORT_MAIL_TO` - support-form recipient; required unless `SMTP_TO` is set in the local SMTP config

Copy `dashboard-service/smtp-config.env.example` to the ignored `dashboard-service/smtp-config.env` file and set local values. The `/home` support form saves every valid query to `data/support-queries.json` before mail delivery. It only reports success when SMTP delivery succeeds.

Home page protection limits dashboard login attempts to 5 per IP per 5 minutes and `/home` support queries to 3 per IP per 10 minutes.

Operator model:

- every account has a `role` plus optional explicit `permissions` overrides
- default role presets:
  - `viewer` - log downloads only
  - `bot-controller` - bot chat/start/pause/reconnect/disconnect plus selected monitoring panels, without log downloads or NBT upload/queue operations
  - `operator` - viewer permissions plus bot control, NBT upload/queue operations, and monitoring panels
  - `admin` - operator permissions plus node-file delete and operator management
- explicit permission flags can override the role defaults per account

First-run operator file:

- `data/operators.json` is seeded with one admin account by default
- inspect `data/operators.json` to get or replace the generated password
- legacy demo accounts are only seeded when `DASHBOARD_SEED_DEMO_OPERATORS=true`
- if an existing `operators.json` still contains `admin-demo`, `operator-demo`, or `viewer-demo` with matching demo passwords, replace or delete them before exposing the dashboard

Example record:

```json
{
  "username": "operator-demo",
  "password": "operator-demo",
  "role": "operator",
  "permissions": {
    "canViewLogs": true,
    "canControlBots": true,
    "canOperate": true,
    "canViewNodeFiles": true,
    "canViewBotInventory": true,
    "canViewOperatorLog": true,
    "canViewVmMetrics": true,
    "canViewTeleportWhitelist": true,
    "canDeleteNodeFiles": false,
    "canManageOperators": false
  },
  "createdAt": "2026-04-18T00:00:00.000Z",
  "updatedAt": "2026-04-18T00:00:00.000Z"
}
```

## Bot-facing API

- `POST /api/bots/status`
- `GET /api/bots/:botName/commands`
- `POST /api/bots/:botName/commands/:commandId/claim`
- `POST /api/bots/:botName/commands/:commandId/result`
- `GET /api/bots/:botName/player-join-messages?version=:knownVersion`
- `POST /api/nodes/:hostLabel/files/claim-next`
- `GET /api/files/:fileId/download`
- `POST /api/nodes/:hostLabel/files/:fileId/result`

## Operator API

- `GET /api/dashboard/bots`
- `GET /api/dashboard/nodes`
- `GET /api/dashboard/events`
- `GET /api/dashboard/bots/:botName`
- `GET /api/dashboard/auth/me`
- `GET /api/dashboard/operators`
- `GET /api/dashboard/logs`
- `GET /api/dashboard/logs/:fileName/download`
- `GET /api/dashboard/data`
- `POST /api/dashboard/operators`
- `POST /api/dashboard/operators/:username/delete`
- `POST /api/dashboard/data/clear`
- `POST /api/dashboard/data/:fileName/delete`
- `POST /api/dashboard/logs/:fileName/delete`
- `POST /api/dashboard/commands/start-all`
- `POST /api/dashboard/commands/stop-all`
- `POST /api/dashboard/delivery/process/start`
- `POST /api/dashboard/delivery/process/stop`
- `POST /api/dashboard/delivery/process/reconnect`
- `POST /api/dashboard/nodes/:hostLabel/commands/start`
- `POST /api/dashboard/nodes/:hostLabel/commands/stop`
- `POST /api/dashboard/nodes/finished-maps/delete-all`
- `POST /api/dashboard/bots/:botName/commands/start`
- `POST /api/dashboard/bots/:botName/commands/stop`
- `POST /api/dashboard/files`
- `POST /api/dashboard/files/:fileId/assign`
- `GET /api/dashboard/files`
- `GET /api/dashboard/player-join-messages`
- `POST /api/dashboard/player-join-messages`

## Operator UI

- `GET /` - browser dashboard
- dashboard viewing is public
- log downloads require an account with `canViewLogs`
- chat/start/pause/reconnect/disconnect controls require `canControlBots`
- all Delivery Bot controls, chat, target edits, and station-anchor updates require the `admin` role
- NBT upload, queue/retry/release, current-NBT reset, and reprint operations require `canOperate`
- Node NBT file lists require `canViewNodeFiles`
- bot inventory view and refresh require `canViewBotInventory`; inventory dump still requires the `admin` role
- VM metrics require `canViewVmMetrics`
- operator activity logs require `canViewOperatorLog`
- teleport whitelist viewing requires `canViewTeleportWhitelist`; adding/removing whitelist users still requires the `admin` role
- dashboard log deletion, data-file deletion, data clear, config edits, and operator management require `canManageOperators`
- destructive node-file deletes require `canDeleteNodeFiles`
- operator management requires `canManageOperators`
- live bot cards with start-print and pause-print controls
- start-all and pause-all print controls for known bots
- start-node and pause-node controls inside each grouped fleet section
- admin-only operator panel for creating, updating, and deleting accounts
- NBT upload form
- separate one-column CSV uploader for player join messages; this does not enter the NBT queue
- node/shared-folder and bot-based NBT assignment form
- authenticated log download panel for current and archived `.log` files on the dashboard host
- shared operator audit log showing actions done by authenticated operators

## File Upload Format

`POST /api/dashboard/files` expects JSON:

```json
{
  "originalName": "mario.nbt",
  "contentBase64": "...",
  "uploadedBy": "operator-1",
  "notes": "optional"
}
```

This keeps the first version dependency-free. A later version can switch to multipart upload if needed.

The dashboard accepts up to 5,000 entries in one ZIP upload and stores up to 10,000 NBT queue records by default. `DASHBOARD_MAX_ZIP_ENTRIES` and `DASHBOARD_MAX_TOTAL_NBTS` can raise these capacities, but values below 5,000 and 10,000 respectively are clamped to those minimums.

Player join message uploads accept a one-column `.csv`. Every valid upload atomically replaces the previous filename and full message list, increments the version, and stores no CSV file. Internal commas are preserved; one optional trailing comma is removed. Enabled bots poll by version and receive no message-list body when their current version matches. No uploaded CSV means enabled bots keep their configured default messages.

## Node Assignment

When you assign an uploaded NBT to a node, select the node label shown by the bots' `hostLabel` field.

- the dashboard keeps the uploaded file in its own storage
- one bot on the selected node claims that file from the dashboard
- that bot downloads the file into the node's local `nbtFolder`
- all bots on that node then see the file because they share the same machine folder

When you assign an uploaded NBT to a bot, the dashboard creates an `assign-nbt` command for that bot only. This is useful when several bot runtimes share an IP address but should receive different files.
