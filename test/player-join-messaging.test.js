const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const {
  createPlayerJoinMessenger,
  getPlayerJoinMessagingSettings
} = require('../src/nerv-printer/player-join-messaging')

function createClock() {
  let current = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => current,
    setTimer(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, dueAt: current + delay })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    async advance(ms) {
      const end = current + ms
      while (true) {
        const next = [...timers.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0]
        if (!next || next[1].dueAt > end) break
        current = next[1].dueAt
        timers.delete(next[0])
        await next[1].callback()
      }
      current = end
    }
  }
}

function createBot(username = 'VulcanB001') {
  const bot = new EventEmitter()
  bot.username = username
  bot.players = { [username]: { username } }
  bot.sent = []
  bot.chat = (message) => bot.sent.push(message)
  return bot
}

test('disabled and slave configs do not create dashboard polling work', () => {
  const disabled = getPlayerJoinMessagingSettings({ playerJoinMessaging: { enabled: false } })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.intervalMs, 3000)
  assert.equal(getPlayerJoinMessagingSettings({
    playerJoinMessaging: { enabled: true, masterOnly: true },
    multiUser: { runtime: { role: 'slave' } }
  }).enabled, false)
})

test('latest joined player receives one delayed message only while printing', async () => {
  const clock = createClock()
  const bot = createBot()
  let phase = 'idle'
  const messenger = createPlayerJoinMessenger({
    bot,
    settings: {
      enabled: true,
      joinDelayMs: 1000,
      intervalMs: 5000,
      messageListPollMs: 30000,
      worldSettleMs: 2000,
      defaultMessages: ['first', 'second']
    },
    isPrinting: () => phase === 'printing',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  messenger.start()
  messenger.arm()

  bot.players.Existing = { username: 'Existing' }
  bot.emit('playerJoined', bot.players.Existing)
  await clock.advance(1500)
  assert.deepEqual(bot.sent, [])

  phase = 'printing'
  for (let index = 1; index <= 20; index += 1) {
    const username = `Player${index}`
    bot.players[username] = { username }
    bot.emit('playerJoined', bot.players[username])
  }
  await clock.advance(999)
  assert.deepEqual(bot.sent, [])
  await clock.advance(1)
  assert.deepEqual(bot.sent, ['/msg Player20 first'])

  bot.players.Player21 = { username: 'Player21' }
  bot.emit('playerJoined', bot.players.Player21)
  await clock.advance(4999)
  assert.equal(bot.sent.length, 1)
  await clock.advance(1)
  assert.deepEqual(bot.sent, ['/msg Player20 first', '/msg Player21 second'])

  phase = 'idle'
  bot.players.Player22 = { username: 'Player22' }
  bot.emit('playerJoined', bot.players.Player22)
  await clock.advance(11000)
  assert.equal(bot.sent.length, 2)
  messenger.stop()
})

test('dashboard messages replace defaults only on a newer version', async () => {
  const clock = createClock()
  const bot = createBot()
  const requestedVersions = []
  const messenger = createPlayerJoinMessenger({
    bot,
    settings: {
      enabled: true,
      joinDelayMs: 1000,
      intervalMs: 1000,
      messageListPollMs: 5000,
      worldSettleMs: 2000,
      defaultMessages: ['default']
    },
    isPrinting: () => true,
    requestMessages: async (version) => {
      requestedVersions.push(version)
      return version === 0
        ? { statusCode: 200, body: { version: 1, messages: ['dashboard'] } }
        : { statusCode: 304, body: null }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  messenger.start()
  messenger.arm()
  await Promise.resolve()

  bot.players.NewPlayer = { username: 'NewPlayer' }
  bot.emit('playerJoined', bot.players.NewPlayer)
  await clock.advance(1000)
  assert.deepEqual(bot.sent, ['/msg NewPlayer dashboard'])
  await clock.advance(5000)
  assert.deepEqual(requestedVersions, [0, 1])
  messenger.stop()
})

test('messages advance in round-robin order after successful sends', async () => {
  const clock = createClock()
  const bot = createBot()
  const messenger = createPlayerJoinMessenger({
    bot,
    settings: {
      enabled: true,
      joinDelayMs: 1000,
      intervalMs: 3000,
      messageListPollMs: 30000,
      worldSettleMs: 2000,
      defaultMessages: ['first', 'second', 'third']
    },
    isPrinting: () => true,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  messenger.start()
  messenger.arm()

  for (const [username, expected] of [['Player1', 'first'], ['Player2', 'second'], ['Player3', 'third'], ['Player4', 'first']]) {
    bot.players[username] = { username }
    bot.emit('playerJoined', bot.players[username])
    await clock.advance(3000)
    assert.equal(bot.sent.at(-1), `/msg ${username} ${expected}`)
  }
  messenger.stop()
})

test('dashboard control enables and disables advertising without polling while stopped', async () => {
  const clock = createClock()
  const bot = createBot()
  const requestedVersions = []
  const messenger = createPlayerJoinMessenger({
    bot,
    settings: {
      enabled: false,
      canEnable: true,
      joinDelayMs: 1000,
      intervalMs: 3000,
      messageListPollMs: 5000,
      worldSettleMs: 2000,
      defaultMessages: ['default']
    },
    isPrinting: () => true,
    requestMessages: async (version) => {
      requestedVersions.push(version)
      return { statusCode: 200, body: { version: 1, messages: ['dashboard'] } }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  messenger.start()
  messenger.arm()
  await Promise.resolve()
  assert.equal(messenger.isEnabled(), false)
  assert.deepEqual(requestedVersions, [])

  assert.equal(messenger.setEnabled(true), true)
  await Promise.resolve()
  await Promise.resolve()
  bot.players.Player1 = { username: 'Player1' }
  bot.emit('playerJoined', bot.players.Player1)
  await clock.advance(1000)
  assert.deepEqual(bot.sent, ['/msg Player1 dashboard'])
  assert.deepEqual(requestedVersions, [0])

  assert.equal(messenger.setEnabled(false), false)
  bot.players.Player2 = { username: 'Player2' }
  bot.emit('playerJoined', bot.players.Player2)
  await clock.advance(6000)
  assert.deepEqual(bot.sent, ['/msg Player1 dashboard'])
  assert.deepEqual(requestedVersions, [0])
  messenger.stop()
})
