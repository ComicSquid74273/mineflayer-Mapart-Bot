const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { parsePlayerJoinMessagesCsv } = require('../src/player-join-messages')
const { createStore } = require('../src/store')

test('CSV parser preserves internal commas and removes one optional trailing delimiter', () => {
  assert.deepEqual(parsePlayerJoinMessagesCsv('messages.csv', [
    'Get maps, Join today | https://discord.gg/yzNbSgWc7n ,',
    'Need maps, ask us | https://discord.gg/yzNbSgWc7n',
    '',
    'Hey there, welcome to the server!',
  ].join('\n')), [
    'Get maps, Join today | https://discord.gg/yzNbSgWc7n',
    'Need maps, ask us | https://discord.gg/yzNbSgWc7n',
    'Hey there, welcome to the server!'
  ])
  assert.throws(() => parsePlayerJoinMessagesCsv('messages.txt', 'hello'), /\.csv/)
  assert.throws(() => parsePlayerJoinMessagesCsv('messages.csv', ''), /no messages/)
  assert.throws(() => parsePlayerJoinMessagesCsv('messages.csv', 'bad\u0000message'), /control/)
})

test('each CSV upload replaces the prior message list and increments its version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-join-messages-'))
  try {
    const store = createStore(dir)
    assert.deepEqual(store.getPlayerJoinMessages(), { version: 0, fileName: null, messages: [], updatedAt: null })
    assert.equal(store.updatePlayerJoinMessages({ fileName: 'a.csv', messages: ['one'] }).version, 1)
    const replacement = store.updatePlayerJoinMessages({ fileName: 'renamed.csv', messages: ['one'] })
    assert.equal(replacement.version, 2)
    assert.equal(replacement.fileName, 'renamed.csv')
    const changed = store.updatePlayerJoinMessages({ fileName: 'b.csv', messages: ['two'] })
    assert.equal(changed.version, 3)
    assert.equal(changed.fileName, 'b.csv')
    assert.deepEqual(changed.messages, ['two'])
    assert.equal(fs.readdirSync(dir, { recursive: true }).some((fileName) => String(fileName).toLowerCase().endsWith('.csv')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
