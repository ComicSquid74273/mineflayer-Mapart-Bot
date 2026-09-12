#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

try {
  const graphPath = path.join(process.cwd(), 'graphify-out', 'graph.json');
  if (fs.existsSync(graphPath)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'graphify: Knowledge graph exists. Read graphify-out/GRAPH_REPORT.md for god nodes and community structure before searching raw files.'
      }
    }));
    process.stdout.write('\n');
  }
} catch {
  // Hooks should add context opportunistically, never block tool use.
}

process.exit(0);
