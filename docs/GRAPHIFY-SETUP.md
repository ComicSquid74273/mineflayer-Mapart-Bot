# Graphify Setup For `mapart-bot`

This repo does not currently include Graphify. The setup below prepares `mapart-bot` to work with the Graphify CLI once Python is installed on the machine.

## What Graphify Will Help With Here

For this project, Graphify is most useful for:

- tracing the flow between `nerv-printer.js` and `src/nerv-printer/cli.js`
- understanding the large `src/nerv-printer/cli.js` runtime and its subsystems
- relating runtime code, config files, docs, and dashboard-service files in one graph
- exporting a persistent graph you can query later without rereading the whole repo

## Prerequisites

Graphify's official docs currently list these requirements:

- Python 3.10 or newer
- a working `pip`
- Graphify installed from PyPI as `graphifyy`

This machine currently only exposes the Windows Store `python.exe` shim, so install a real Python runtime first.

## Install Python On Windows

Recommended:

1. Install Python 3.10+ from the official Python installer.
2. Make sure `python --version` works in a new terminal.
3. Make sure `pip --version` works too.

After that, from the repo root:

```powershell
python -m pip install --upgrade pip
python -m pip install graphifyy
graphify install
```

## Project Commands

After Graphify is installed, you can use these repo commands:

```powershell
npm run graphify:build
npm run graphify:update
npm run graphify:watch
npm run graphify:report
npm run graphify:codex-install
```

What they do:

- `graphify:build` builds a graph for the current repo
- `graphify:update` refreshes only changed files into the existing graph
- `graphify:watch` keeps the graph synced while you work
- `graphify:report` prints the generated `GRAPH_REPORT.md`
- `graphify:codex-install` installs Codex-side Graphify integration files

## Suggested First Run For This Repo

From the repo root:

```powershell
graphify . --no-viz
```

Then, if that works:

```powershell
graphify .
```

That should generate:

- `graphify-out/graph.html`
- `graphify-out/graph.json`
- `graphify-out/GRAPH_REPORT.md`

## Good Queries For `mapart-bot`

Once the graph is built, try:

```powershell
graphify query "how does the nerv printer startup flow work?"
graphify query "what config files affect printer behavior?"
graphify query "how does the dashboard service relate to the printer runtime?"
graphify query "where is post-print cartography handled?"
graphify explain "src/nerv-printer/cli.js"
```

## Notes

- Official Graphify docs say the package name is `graphifyy`, while the command remains `graphify`.
- Generated output is ignored in git through `.gitignore`.
- If you want Codex to always have Graphify instructions available in this repo, run `npm run graphify:codex-install` after the CLI is installed.
