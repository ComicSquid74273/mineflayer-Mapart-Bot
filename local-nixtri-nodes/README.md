# Local Nixtri Test Nodes

This folder is reserved for local premium-server test node runtime state.

The control script `scripts/nixtri-nodes.ps1` creates one subfolder per bot:

- `ComicBot01` with target anchor `62 173 -194`
- `ComicBot02` with target anchor `318 161 -194`

Each node folder gets its own generated `runtime-config.json`, `nbt`, `logs`,
`finished-maps`, `auth-cache`, and `sync` folders. The generated config is based
on `nerv-printer-config/_configs/nerv-printer-config-premium-1.json` and forces
the `premium-1` connection profile.

Default commands:

```powershell
npm run nixtri:nodes -- prepare
npm run nixtri:dashboard -- start
npm run nixtri:nodes -- start
```

Stop commands:

```powershell
npm run nixtri:nodes -- stop
npm run nixtri:dashboard -- stop
```
