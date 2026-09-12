## graphify

This project has a graphify knowledge graph at `graphify-out/`.

Rules:
- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` first for the current hubs, communities, and cross-module links.
- Treat `src/nerv-printer/cli.js` as the main runtime entrypoint, with `nerv-printer.js` as a compatibility wrapper.
- Use Graphify first for questions about startup flow, print flow, post-print/cartography flow, config loading, repair logic, diagnostics, and 6b6t/local connection behavior.
- When a question spans modules, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over raw grep because this repo has a large single-file runtime plus helper modules.
- Focus Graphify exploration on these relationships:
- `nerv-printer.js` -> `src/nerv-printer/cli.js`
- `src/nerv-printer/cli.js` -> `src/nerv-printer/placement/workload.js`
- `src/nerv-printer/cli.js` -> `src/nerv-printer/diagnostics/*.js`
- `src/broadcast/cli.js` -> shared helpers and config normalization in `src/nerv-printer/cli.js`
- runtime code -> `nerv-printer-config/_configs/*.json` -> `README.md` and `docs/`
- If `graphify-out/wiki/index.md` exists, navigate it before reading large raw files directly.
- After modifying code, docs, config, or dashboard files, run `npm run graphify:refresh` so Codex and Claude Code keep using the augmented project graph instead of code-only updates.
