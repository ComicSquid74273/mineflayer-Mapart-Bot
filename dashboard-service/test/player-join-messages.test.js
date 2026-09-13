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

test('store increments message-list version only when content changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-join-messages-'))
  try {
    const store = createStore(dir)
    assert.deepEqual(store.getPlayerJoinMessages(), { version: 0, fileName: null, messages: [], updatedAt: null })
    assert.equal(store.updatePlayerJoinMessages({ fileName: 'a.csv', messages: ['one'] }).version, 1)
    assert.equal(store.updatePlayerJoinMessages({ fileName: 'renamed.csv', messages: ['one'] }).version, 1)
    const changed = store.updatePlayerJoinMessages({ fileName: 'b.csv', messages: ['two'] })
    assert.equal(changed.version, 2)
    assert.deepEqual(changed.messages, ['two'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
