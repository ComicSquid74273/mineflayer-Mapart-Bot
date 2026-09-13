const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { configurePlayerJoinMessaging } = require('../scripts/configure-player-join-messaging')

test('deployment helper toggles only join messaging and preserves existing config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-messaging-config-'))
  const configPath = path.join(dir, 'config.json')
  try {
    fs.writeFileSync(configPath, JSON.stringify({ bot: { username: 'ExampleBot' }, playerJoinMessaging: { intervalMs: 15000 } }))
    const result = configurePlayerJoinMessaging(configPath, true)
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(result.enabled, true)
    assert.equal(saved.playerJoinMessaging.intervalMs, 15000)
    assert.equal(saved.bot.username, 'ExampleBot')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
