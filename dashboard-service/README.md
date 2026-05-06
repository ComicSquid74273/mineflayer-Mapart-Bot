# Dashboard Service

This is a separate dashboard service for operating mapart bots.

For the full Windows desktop workflow, see `docs/DESKTOP-DASHBOARD-SETUP.md` from the repo root.

The dashboard is viewable without authentication. Operator accounts are stored in `data/operators.json`, and role-gated actions plus log downloads require operator authentication.

## Scope

Version 1 is intentionally narrow:

- start and stop print-work commands for already running bots
- compact per-bot status
- NBT upload with individual bot assignment or node/shared-folder assignment
- bot command polling and result reporting
- browser UI for operators

This service does not include raw Mineflayer inspection or arbitrary file system access.

Important: this service does not cold-start a stopped Node.js process by itself. Start the bot process first, ideally in wait mode, then use the dashboard to start or stop printing.

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

Operator model:

- every account has a `role` plus optional explicit `permissions` overrides
- default role presets:
  - `viewer` - log downloads only
  - `operator` - viewer permissions plus bot start/stop and file upload/assignment
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
    "canOperate": true,
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
- `POST /api/dashboard/nodes/:hostLabel/commands/start`
- `POST /api/dashboard/nodes/:hostLabel/commands/stop`
- `POST /api/dashboard/nodes/finished-maps/delete-all`
- `POST /api/dashboard/bots/:botName/commands/start`
- `POST /api/dashboard/bots/:botName/commands/stop`
- `POST /api/dashboard/files`
- `POST /api/dashboard/files/:fileId/assign`
- `GET /api/dashboard/files`

## Operator UI

- `GET /` - browser dashboard
- dashboard viewing is public
- log downloads require an account with `canViewLogs`
- mutating actions require `canOperate`
- dashboard log deletion, data-file deletion, data clear, config edits, and operator management require `canManageOperators`
- destructive node-file deletes require `canDeleteNodeFiles`
- operator management requires `canManageOperators`
- live bot cards with start-print and stop-print controls
- start-all and stop-all print controls for known bots
- start-node and stop-node controls inside each grouped fleet section
- admin-only operator panel for creating, updating, and deleting accounts
- NBT upload form
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

## Node Assignment

When you assign an uploaded NBT to a node, select the node label shown by the bots' `hostLabel` field.

- the dashboard keeps the uploaded file in its own storage
- one bot on the selected node claims that file from the dashboard
- that bot downloads the file into the node's local `nbtFolder`
- all bots on that node then see the file because they share the same machine folder

When you assign an uploaded NBT to a bot, the dashboard creates an `assign-nbt` command for that bot only. This is useful when several bot runtimes share an IP address but should receive different files.
