const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { configurePlayerJoinMessaging } = require('../scripts/configure-player-join-messaging')

test('deployment helper migrates the old default once and preserves later custom intervals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-messaging-config-'))
  const configPath = path.join(dir, 'config.json')
  try {
    fs.writeFileSync(configPath, JSON.stringify({ bot: { username: 'ExampleBot' }, playerJoinMessaging: { intervalMs: 10000 } }))
    const result = configurePlayerJoinMessaging(configPath, true)
    assert.equal(result.enabled, true)
    assert.equal(result.version, 2)
    assert.equal(result.intervalMs, 3000)

    const custom = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    custom.playerJoinMessaging.intervalMs = 15000
    fs.writeFileSync(configPath, JSON.stringify(custom))
    assert.equal(configurePlayerJoinMessaging(configPath, true).intervalMs, 15000)
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).bot.username, 'ExampleBot')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
