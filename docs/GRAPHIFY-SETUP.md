# Graphify Setup For `mapart-bot`

Graphify is installed and integrated for this repo. The repo also includes a project-specific augmentation step so the graph covers more than just code.

## What Is Configured

- Codex integration through `AGENTS.md` and `.codex/hooks.json`
- Claude Code integration through `CLAUDE.md` and `.claude/settings.json`
- Graph output in `graphify-out/`
- Repo-specific augmentation for docs, config files, dashboard metadata, and operational artifacts

## Important CLI Note

This installed Graphify CLI does **not** use `graphify .` as the build command in this environment.

Use these commands instead:

```powershell
graphify update .
graphify watch .
graphify cluster-only .
```

In this repo, the recommended command is:

```powershell
npm run graphify:refresh
```

That runs:

1. `graphify update .` for the code graph
2. `node scripts/graphify-augment.js` for repo-specific docs/config/dashboard context
3. `graphify cluster-only .` to refresh communities, report, and HTML output

## Project Commands

```powershell
npm run graphify:refresh
npm run graphify:update
npm run graphify:context
npm run graphify:cluster
npm run graphify:watch
npm run graphify:report
npm run graphify:codex-install
npm run graphify:claude-install
```

What they do:

- `graphify:refresh` updates the code graph and then augments it with project context
- `graphify:update` is an alias for `graphify:refresh`
- `graphify:context` applies only the repo-specific augmentation layer
- `graphify:cluster` reclusters the current graph and rewrites the report and HTML
- `graphify:watch` watches code files for AST-only rebuilds
- `graphify:report` prints `graphify-out/GRAPH_REPORT.md`
- `graphify:codex-install` writes the Codex integration files
- `graphify:claude-install` writes the Claude Code integration files

## Coverage Model For This Repo

Graphify currently covers this repo in two layers:

1. Native Graphify code extraction
2. Repo-owned context augmentation

Native extraction is strongest for:

- `src/`
- `dashboard-service/src/`
- `dashboard-service/public/assets/app.js`

Repo-owned augmentation adds graph coverage for:

- `README.md`
- `docs/`
- `nerv-printer-config/_configs/*.json`
- `nerv-printer-config/*.nbt`
- `dashboard-service/public/index.html`
- `dashboard-service/public/assets/styles.css`
- package metadata and selected operational artifacts

## Suggested Workflow

After code changes:

```powershell
npm run graphify:refresh
```

After doc or config changes:

```powershell
npm run graphify:refresh
```

During active code work:

```powershell
graphify watch .
```

Then periodically run:

```powershell
npm run graphify:refresh
```

because `watch` is code-first and does not replace the repo-specific augmentation step.

## Good Queries For `mapart-bot`

```powershell
graphify query "how does the nerv printer startup flow work?"
graphify query "what config files affect printer behavior?"
graphify query "how does the dashboard service relate to the printer runtime?"
graphify query "where is post-print cartography handled?"
graphify query "which docs and configs support 6b6t operations?"
graphify explain "src/nerv-printer/cli.js"
graphify explain "nerv-printer-config/_configs/nerv-printer-config.json"
```

## Notes

- The PyPI package name is `graphifyy`, while the CLI command is `graphify`.
- `graphify-out/` is git-ignored.
- The repo-specific context logic lives in `scripts/graphify-augment.js`.
- The human-maintained high-level map for that augmentation lives in `docs/GRAPHIFY-CONTEXT.md`.
