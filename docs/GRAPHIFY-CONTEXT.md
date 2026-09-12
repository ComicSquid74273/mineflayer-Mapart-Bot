# Graphify Context For `mapart-bot`

This file is the human-maintained context layer that supplements Graphify's code-first extraction for this repository.

## Main Runtime

- `nerv-printer.js` is the compatibility wrapper for the main printer runtime.
- `src/nerv-printer/cli.js` is the primary runtime for NERV-style carpet printing.
- `src/nerv-printer/placement/workload.js` contains placement workload helpers.
- `src/nerv-printer/diagnostics/` contains rescan, verification, movement, and state helpers.

## Broadcast Runtime

- `src/broadcast/cli.js` is the broadcast/general bot runtime.
- `src/broadcast/test-cli.js` is the broadcast test runner.

## Dashboard Service

- `dashboard-service/src/server.js` is the dashboard API/server.
- `dashboard-service/src/store.js` persists dashboard state.
- `dashboard-service/public/index.html`, `dashboard-service/public/assets/app.js`, and `dashboard-service/public/assets/styles.css` provide the dashboard UI.
- Dashboard runtime data and operator credentials are local-only and ignored by Git and Graphify.

## Config And Inputs

- `nerv-printer-config/_configs/*.json` defines printer behavior, imported machine config, and connection-specific settings.
- Print inputs and generated spatial scans are local-only because they may contain private world data.

## Operational Documentation

- `README.md` is the main operational and configuration guide.
- `docs/DESKTOP-DASHBOARD-SETUP.md` explains dashboard workflow and setup.
- `docs/nerv-printer.service.example` is a deployment/service example.

## Assets

- `assets/schematics/*.litematic` are machine/layout artifacts.
- `assets/MeteorSpatialFileGenerator.jar` is a supporting tooling artifact for spatial workflows.

## Graphify Intent

The goal of the augmented graph is to let assistants answer not just code questions, but also:

- which configs drive the printer runtime
- which docs explain a subsystem
- how the dashboard service connects to printer operations
- which artifacts support spatial awareness and machine layout
