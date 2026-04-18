# Dashboard Service

This is a separate dashboard service for operating mapart bots.

For the full Windows desktop workflow, see `docs/DESKTOP-DASHBOARD-SETUP.md` from the repo root.

## Scope

Version 1 is intentionally narrow:

- start and stop print-work commands for already running bots
- compact per-bot status
- NBT upload and assignment
- bot command polling and result reporting
- browser UI for operators

This service does not include raw Mineflayer inspection or arbitrary file system access.

Important: this service does not cold-start a stopped Node.js process by itself. Start the bot process first, ideally in wait mode, then use the dashboard to start or stop printing.

## Storage

The service stores JSON metadata under `data/` and uploaded NBT files under `data/files/`.

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

## Bot-facing API

- `POST /api/bots/status`
- `GET /api/bots/:botName/commands`
- `POST /api/bots/:botName/commands/:commandId/claim`
- `POST /api/bots/:botName/commands/:commandId/result`
- `GET /api/bots/:botName/files/next`
- `GET /api/files/:fileId/download`
- `POST /api/bots/:botName/files/:fileId/result`

## Operator API

- `GET /api/dashboard/bots`
- `GET /api/dashboard/bots/:botName`
- `POST /api/dashboard/commands/start-all`
- `POST /api/dashboard/commands/stop-all`
- `POST /api/dashboard/bots/:botName/commands/start`
- `POST /api/dashboard/bots/:botName/commands/stop`
- `POST /api/dashboard/files`
- `POST /api/dashboard/files/:fileId/assign`
- `GET /api/dashboard/files`

## Operator UI

- `GET /` - browser dashboard
- live bot cards with start-print and stop-print controls
- start-all and stop-all print controls for known bots
- NBT upload form
- NBT assignment form

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