# Desktop Dashboard Setup

This guide is for running the dashboard service and one or more bot processes from a desktop machine.

Use this setup when:

- the dashboard UI runs on a desktop or workstation
- bots run on the same desktop or another allowed private host
- you want bots to connect first and wait idle
- you want the dashboard or terminal to control start and pause of printing work

This guide does not cover EC2 or systemd deployment. For server deployment, see `docs/EC2-DEPLOY.md`.

## What This Desktop Setup Does

Current desktop behavior:

1. Start the `dashboard-service` process.
2. Open the browser UI at `http://127.0.0.1:4080/`.
3. Start bot processes in wait mode.
4. Bots connect to Minecraft, post status to the dashboard, and remain idle.
5. Use the dashboard UI or the bot terminal to start or stop printing.

Important limits:

- The dashboard does not cold-start a stopped Node.js process.
- `Start Print` means start the print loop on a bot process that is already running.
- `Pause Print` means pause work and return to idle. It does not kill the process.
- Paused bots keep their saved progress and do not auto-resume from queued NBTs or unfinished progress until `Start Print` / `Start Printing All` is pressed.
- Existing reconnect logic is still handled by the bot runtime.

## Prerequisites

Desktop requirements:

- Windows desktop or workstation
- Node.js 20.x
- repo cloned locally
- `npm install` already run in the repo root
- Minecraft server reachable from the desktop
- dashboard host reachable from each bot process

Repo paths used in this guide:

- root: `D:\Projects\mapart-bot`
- dashboard service: `D:\Projects\mapart-bot\dashboard-service`
- main runtime config: `nerv-printer-config/_configs/nerv-printer-config.json`

## Architecture On Desktop

Recommended layout:

1. One terminal for the dashboard service.
2. One terminal per bot process.
3. One browser tab open to the dashboard UI.

Typical desktop flow:

- dashboard-service listens on port `4080`
- bots send status to `http://127.0.0.1:4080` if everything is local
- if bots run on another machine, use the desktop machine IP instead of `127.0.0.1`

## Dashboard Service Setup

From the repo root:

```powershell
Set-Location "D:\Projects\mapart-bot\dashboard-service"
npm start
```

Or without changing directory:

```powershell
npm --prefix "D:\Projects\mapart-bot\dashboard-service" start
```

Open the UI:

```text
http://127.0.0.1:4080/
```

Useful dashboard endpoints:

- `http://127.0.0.1:4080/health`
- `http://127.0.0.1:4080/api/dashboard/bots`
- `http://127.0.0.1:4080/api/dashboard/files`

Environment variables supported by the dashboard service:

- `DASHBOARD_PORT` default `4080`
- `DASHBOARD_HOST` default `0.0.0.0`
- `DASHBOARD_DATA_DIR` default `dashboard-service/data`

## Bot Desktop Setup

### 1. Enable Dashboard Integration

You can enable dashboard mode either through config or environment variables.

Fastest desktop approach is environment variables in the bot terminal:

```powershell
Set-Location "D:\Projects\mapart-bot"
$env:NERV_DASHBOARD_ENABLED="true"
$env:NERV_DASHBOARD_URL="http://127.0.0.1:4080"
```

If the dashboard service runs on another machine, replace `127.0.0.1` with that machine's LAN IP or hostname.

Optional host label:

```powershell
$env:NERV_DASHBOARD_HOST_LABEL="desktop-main"
```

### 2. Start Bot In Wait Mode

Local profile:

```powershell
Set-Location "D:\Projects\mapart-bot"
npm run start:nerv:local:wait
```

6b6t profile:

```powershell
Set-Location "D:\Projects\mapart-bot"
npm run start:nerv:6b6t:wait
```

Generic default profile:

```powershell
Set-Location "D:\Projects\mapart-bot"
npm run start:nerv:wait
```

Wait mode means:

- bot process starts
- bot connects normally
- bot reports status to the dashboard
- bot remains idle until you issue `Start Print`

### 3. Optional Config-Based Setup

You can also set dashboard options in `nerv-printer-config/_configs/nerv-printer-config.json`.

Relevant config block:

```json
{
  "dashboard": {
    "enabled": true,
    "serviceUrl": "http://127.0.0.1:4080",
    "hostLabel": "desktop-main",
    "heartbeatMs": 5000,
    "commandPollMs": 3000,
    "idleWindowMs": 15000,
    "staleMs": 20000
  }
}
```

If you always want desktop-managed mode, combine that with wait mode startup commands.

## Using The Dashboard UI

Open:

```text
http://127.0.0.1:4080/
```

The UI currently supports:

- bot cards with online/offline state
- phase display
- health and hunger
- location and idle state
- reconnect and recovery state
- current NBT name
- `Start Print` for one bot
- `Pause Print` for one bot
- `Start Printing All`
- `Pause Printing All`
- NBT upload
- NBT assignment to a bot

What the buttons mean:

- `Start Print`: begin the print loop on a running idle bot
- `Pause Print`: pause work and return the bot to idle
- `Start Printing All`: queue print start for all known bots
- `Pause Printing All`: queue print pause for all known bots

## Terminal Commands For Running Bots

When the bot process is running interactively, these commands are available in the bot terminal:

```text
status
start
stop
verified
refresh
```

Relevant desktop control commands:

- `status` shows current runtime status
- `start` starts printing work
- `stop` stops printing work and returns to idle

This is useful if the dashboard UI is open but you also want local operator control from the desktop terminal.

## Reconnect And Disconnect Behavior

Current behavior:

- reconnect is already implemented in the bot runtime
- reconnect is automatic when `bot.reconnect.enabled` is true
- kicks and disconnects are reported to the dashboard as status changes and last error text
- `reconnectState` is included in dashboard status
- there is no separate dashboard button for manual disconnect or manual reconnect right now

Operational meaning:

- if a bot is kicked or loses connection, the runtime reconnect loop handles recovery
- if you press `Pause Print`, the process does not disconnect; it stays online and idle

## NBT Workflow On Desktop

There are two ways to feed NBT files to bots.

### Option 1: Put Files In The Local NBT Folder

Place `.nbt` files into the configured input folder, usually:

- `nerv-printer-config/`

### Option 2: Upload Through The Dashboard

Use the dashboard UI:

1. Upload the `.nbt` file.
2. Assign it to a bot.
3. The bot downloads it into `files.nbtFolder`.

## Recommended Desktop Startup Sequence

On a single desktop host:

1. Start the dashboard service.
2. Open the dashboard browser UI.
3. Start each bot terminal in wait mode.
4. Confirm bots appear in the dashboard.
5. Upload or place NBT files.
6. Use `Start Print` from the UI or `start` from the bot terminal.

## Troubleshooting

### Port 4080 Already In Use

If starting the dashboard service shows `EADDRINUSE`, another process is already using port `4080`.

That often means the dashboard service is already running.

Check the UI directly:

```text
http://127.0.0.1:4080/
```

### Started Wrong Server Command

These commands fail from the repo root because there is no root `src/server.js`:

```powershell
node src/server.js
node .\src\server.js
```

Use the dashboard-service path instead:

```powershell
node "D:\Projects\mapart-bot\dashboard-service\src\server.js"
```

Or:

```powershell
npm --prefix "D:\Projects\mapart-bot\dashboard-service" start
```

### Bot Does Not Show In Dashboard

Check:

1. bot process is running
2. `NERV_DASHBOARD_ENABLED=true`
3. `NERV_DASHBOARD_URL` points to the real dashboard host
4. dashboard service is reachable on port `4080`
5. bot is started in wait mode or normal mode and reaches the connected state

### Start Print Does Nothing

Check:

1. bot process is already running
2. bot is connected or reconnecting
3. dashboard command polling is enabled through dashboard integration
4. bot is idle and not already busy with another print run

### Pause Print Does Not Exit The Process

That is expected.

`Pause Print` is a work-control action, not a process-kill action.

## Files Related To Desktop Setup

- `dashboard-service/README.md`
- `dashboard-service/src/server.js`
- `dashboard-service/public/index.html`
- `dashboard-service/public/assets/app.js`
- `src/nerv-printer/cli.js`
- `nerv-printer-config/_configs/nerv-printer-config.json`

## Short Command Reference

Dashboard service:

```powershell
npm --prefix "D:\Projects\mapart-bot\dashboard-service" start
```

Bot wait mode, local:

```powershell
Set-Location "D:\Projects\mapart-bot"
$env:NERV_DASHBOARD_ENABLED="true"
$env:NERV_DASHBOARD_URL="http://127.0.0.1:4080"
npm run start:nerv:local:wait
```

Bot wait mode, 6b6t:

```powershell
Set-Location "D:\Projects\mapart-bot"
$env:NERV_DASHBOARD_ENABLED="true"
$env:NERV_DASHBOARD_URL="http://127.0.0.1:4080"
npm run start:nerv:6b6t:wait
```
