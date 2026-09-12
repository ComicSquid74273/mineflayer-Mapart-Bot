'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const serverSource = fs.readFileSync(path.join(repoRoot, 'dashboard-service', 'src', 'server.js'), 'utf8')

test('dashboard accepts at least ten thousand stored NBTs', () => {
  assert.match(serverSource, /const MAX_TOTAL_NBTS = Math\.max\(10000,/)
  assert.match(serverSource, /printerConfigDashboard\.maxTotalNbts \|\| 10000/)
  assert.match(serverSource, /exceeds the total limit of \$\{MAX_TOTAL_NBTS\}/)

  for (const fileName of ['nerv-printer-config.json', 'delivery-bot-config.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'nerv-printer-config', '_configs', fileName), 'utf8'))
    assert.equal(config.dashboard.maxTotalNbts, 10000)
  }
})

test('dashboard accepts ZIP uploads containing up to five thousand entries', () => {
  assert.match(serverSource, /const MAX_ZIP_ENTRIES = Math\.max\(5000,/)
  assert.match(serverSource, /printerConfigDashboard\.maxZipEntries \|\| 5000/)
  assert.match(serverSource, /zip contains too many entries \(\$\{entryCount\}\/\$\{MAX_ZIP_ENTRIES\}\)/)
  assert.match(serverSource, /error: errors\[0\]\?\.error \|\| 'no files were queued'/)

  for (const fileName of ['nerv-printer-config.json', 'delivery-bot-config.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'nerv-printer-config', '_configs', fileName), 'utf8'))
    assert.equal(config.dashboard.maxZipEntries, 5000)
  }
})
