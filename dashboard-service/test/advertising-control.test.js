const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createStore } = require('../src/store')

test('advertising desired state persists and requeues the required live command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advertising-control-'))
  try {
    const store = createStore(dir)
    store.upsertBotStatus({ botName: 'bot09', role: 'single', playerJoinMessagingEnabled: true })
    const printCommand = store.createCommand({ targetBotName: 'bot09', commandType: 'start' })

    assert.equal(store.setBotAdvertisingDesired('bot09', false).enabled, false)
    const stopCommand = store.listPendingCommands('bot09').find((item) => item.commandType === 'advertising-stop')
    assert.ok(stopCommand)
    assert.ok(store.getCommand(printCommand.commandId))

    store.completeCommand('bot09', stopCommand.commandId, 'succeeded', 'disabled')
    store.upsertBotStatus({ botName: 'bot09', role: 'single', playerJoinMessagingEnabled: false })
    assert.equal(store.listPendingCommands('bot09').some((item) => item.commandType.startsWith('advertising-')), false)

    const reloaded = createStore(dir)
    assert.equal(reloaded.getBotAdvertisingState('bot09').enabled, false)
    reloaded.setBotAdvertisingDesired('bot09', true)
    assert.equal(reloaded.listPendingCommands('bot09').some((item) => item.commandType === 'advertising-start'), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
