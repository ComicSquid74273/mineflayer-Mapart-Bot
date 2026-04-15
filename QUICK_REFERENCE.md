# Quick Reference Card

## 🎯 Feature Quick Reference

### State Management
```javascript
// Track: phase → state → target → stats
BOT_STATES = {
  PRINTING_START, PRINTING_BATCH, PRINTING_LINEEND_CHECK,
  REPAIR_START, REPAIR_PASS,
  RESCAN_START, RESCAN_FULL, RESCAN_ANALYSIS,
  POST_PRINT_START, POST_PRINT_WORKFLOW, POST_PRINT_DONE,
  CLEANUP, FINISHED
}

// Use: const mgr = new StateManager('./logs/nerv-printer-progress.json')
// mgr.transitionTo(phase, state, details)
// mgr.updateProgress(placed, skipped, already, processedCount)
// mgr.recordError(target, ERROR_TYPES.MISSING, details)
```

### Rescan Module
```javascript
// Run full scan: const results = await performFullRescan(bot, allTargets, config)
// Results: { totalScanned, correctBlocks, missingBlocks, wrongBlocks, summary }

// Analyze: const analysis = analyzeRescanResults(results, config)
// Analysis: { accuracy, totalIssues, missingByBlock, wrongByBlock, recommendations }

// Log: logRescanAnalysis(results, analysis, config)
```

### Verification Module
```javascript
// Check duplicate: verifyNoDuplicatePlacement(bot, target)
// Check carpet: verifyMisplacedCarpetDetection(bot, target)
// Check support: verifySupportDetection(bot, target)
// Full test: await runBehaviorVerificationTest(bot, testTargets, config)
```

---

## ⚙️ Configuration Quick Reference

```json
"advanced": {
  "rescanEnabled": true,              // Enable/disable
  "rescanAfterPrinting": true,       // When to run
  "rescanRepairMissingBlocks": true, // Auto-repair missing
  "rescanBreakMisplacedCarpets": true, // Auto-fix misplaced
  "rescanVerifySupport": true        // Check support
}
```

---

## 📊 State Flow Quick Reference

```
START → PRINTING (+ state saves)
        ↓ crash? resume from target N
      → REPAIR (+ error list)
        ↓ crash? resume repair
      → RESCAN (+ accuracy report)
        ↓ crash? redo rescan
      → POST-PRINT
        ↓ crash? resume post-print
      → FINISHED
```

---

## 📁 File Locations Quick Reference

```
State file:        logs/nerv-printer-progress.json
State history:     logs/nerv-printer-progress-history.json
Log file:          logs/nerv-printer.log
Config file:       nerv-printer-config.json

State Manager:     state-manager.js
Rescan Module:     rescan-module.js
Verify Module:     verify-module.js
```

---

## 🔍 Key Verification Guarantees

| Guarantee | How Verified | Result |
|-----------|--------------|--------|
| No duplicate placement | Layer 1 check before place | ✓ Provably safe |
| Only break wrong carpets | .endsWith('_carpet') check | ✓ Can't break stone |
| Won't place floating | Support check below block | ✓ No floating blocks |
| Crash recovery works | Load/resume state | ✓ No data loss |
| Accuracy known | 100% rescan | ✓ Exact % reported |

---

## 🚀 One-Liner Commands

```bash
# Check current state
jq . logs/nerv-printer-progress.json

# Get accuracy from last scan
jq .rescanResults logs/nerv-printer-progress.json

# View all crashes (crashCount)
jq .crashCount logs/nerv-printer-progress.json

# Get error breakdown
jq .errorsByType logs/nerv-printer-progress.json

# View history changes
jq '.[-5:] | .[] | {timestamp, phase, processed}' logs/nerv-printer-progress-history.json

# Watch rescan output
grep RESCAN logs/nerv-printer.log

# Watch state transitions
grep '\[STATE\]' logs/nerv-printer.log

# Count errors by type
grep '\[ERROR' logs/nerv-printer.log | sort | uniq -c
```

---

## 📝 Error Types Reference

```
MISSING              - Block is air where carpet should be
WRONG_BLOCK          - Completely different block (stone, etc)
MISPLACED_CARPET     - Wrong carpet color/type
SUPPORT_MISSING      - No block below to support placement
INVENTORY_FULL       - Can't hold more material
MATERIAL_UNAVAILABLE - Material not found in chests
PLACEMENT_FAILED     - Mineflayer couldn't place block
PATHFINDING_FAILED   - Can't path to location
UNKNOWN              - Unknown error type
```

---

## 💡 True/False Checklist

- [ ] Rescan enabled in config? → `"rescanEnabled": true`
- [ ] Auto-repair enabled? → `"rescanRepairMissingBlocks": true`
- [ ] State tracking working? → Check `logs/nerv-printer-progress.json`
- [ ] Rescan ran? → Search logs for `[RESCAN-COMPLETE]`
- [ ] Accuracy good? → Check `rescanResults.summary.accuracyPercent`
- [ ] Crash recovery tested? → Stop bot mid-print, restart
- [ ] No duplicates placed? → Stats show high `already` count

---

## 🎓 Learn More

| Topic | File |
|-------|------|
| State system overview | STATE_MANAGEMENT.md |
| Implementation guide | INTEGRATION_GUIDE.md |
| Verification details | VERIFICATION_GUIDE.md |
| Complete summary | IMPLEMENTATION_SUMMARY.md |
| Quick start | NEW_FEATURES_README.md |

---

## ✅ Success Indicators

```
✓ State file created at logs/nerv-printer-progress.json
✓ State updates every 10 targets (check timestamps)
✓ Logs show [STATE] transitions
✓ Bot resumes after crash (check processedTargets)
✓ Rescan shows [RESCAN-COMPLETE] in logs
✓ Accuracy > 95% (normal for carpet printing)
✓ Missing/wrong block counts in rescan report
✓ Auto-repair runs if enabled
✓ Final accuracy = 100% after repair
```

---

## 🐛 Common Issues & Fixes

| Issue | Fix |
|-------|-----|
| Won't resume | Clear: `rm logs/nerv-printer-progress.json` and restart |
| Rescan too slow | Normal - check progress every 256 blocks |
| Too many error logs | Set `"errorHandling": { "logErrors": false }` |
| State file not updating | Check write permissions on logs/ folder |
| Breaks wrong blocks | Report bug - shouldn't happen |

---

## 📊 Example Output

```
[RESCAN-COMPLETE] Scanned 16384 blocks in 45231ms
[RESCAN-RESULTS] Correct=16350 (99.8%) Missing=20 Wrong=14
[RESCAN-ANALYSIS] DETAILED RESULTS
  Accuracy: 99.8% (16350/16384)
  Issues: 34 total
  - Missing: 20
  - Wrong: 14
  Scan Time: 45231ms

[MISSING-BY-BLOCK]
  red_carpet: 12 missing
  blue_carpet: 8 missing

[WRONG-BY-BLOCK]
  red_carpet->white_carpet: 14 misplaced

[RECOMMENDATIONS]
  • MISSING: 20 blocks need to be placed
  • WRONG: 14 incorrect blocks need to be replaced
  • Running final repair...

[REPAIR-PASS] Starting repair pass for 34 error(s).
[SWEEP-FINAL] placed=20 already=0 skipped=0 ErrorCount=0
```

---

**Save this card for quick reference!** 📌

---

Version: 1.0 | Last Updated: 2026-04-15 | Status: ✓ Production Ready
