const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  commandKeysForCooldown,
  extractCommandCooldown,
  extractTeleportWarmup,
  extractHomeFailure,
  extractTargetUnavailable,
  parseDurationMs,
  CooldownManager,
  waitWithAbort,
  sendCommandWithCooldown
} = require('../src/nerv-printer/delivery/cooldowns')

test('parses compact and wordy duration text', () => {
  assert.equal(parseDurationMs('9m 55s'), 595000)
  assert.equal(parseDurationMs('0m 55s'), 55000)
  assert.equal(parseDurationMs('9m55s'), 595000)
  assert.equal(parseDurationMs('15 seconds'), 15000)
  assert.equal(parseDurationMs('1 minute 5 seconds'), 65000)
  assert.equal(parseDurationMs('no numbers here'), 0)
})

test('extracts teleport cooldown from 6b6t response', () => {
  const cooldown = extractCommandCooldown('You have to wait 9m 55s to teleport again.')
  const shortCooldown = extractCommandCooldown('You have to wait 0m 55s to teleport again.')

  assert.deepEqual(cooldown, {
    type: 'teleport',
    waitMs: 595000,
    message: 'You have to wait 9m 55s to teleport again.'
  })
  assert.equal(shortCooldown.waitMs, 55000)
  assert.deepEqual(commandKeysForCooldown('home', cooldown.type), ['home', 'tpa', 'accept'])
  assert.deepEqual(commandKeysForCooldown('tpa', cooldown.type), ['home', 'tpa', 'accept'])
  assert.deepEqual(commandKeysForCooldown('sethome', cooldown.type), ['sethome'])
})

test('ignores non-cooldown chat', () => {
  assert.equal(extractCommandCooldown('PrintingBot01 has accepted your teleport request'), null)
  assert.equal(extractCommandCooldown('Welcome to the server!'), null)
  assert.equal(extractCommandCooldown('wait what'), null)
})

test('extracts teleport warmup from accepted home command', () => {
  const warmup = extractTeleportWarmup('Teleporting to platform in 15 seconds. [Cancel]')

  assert.equal(warmup.type, 'teleport-warmup')
  assert.equal(warmup.waitMs, 15000)
  assert.equal(extractTeleportWarmup('You have to wait 9m 55s to teleport again.'), null)
})

test('detects missing-home failures', () => {
  assert.equal(extractHomeFailure('Home platform does not exist').type, 'home-missing')
  assert.equal(extractHomeFailure("Home platform doesn't exist!").type, 'home-missing')
  assert.equal(extractHomeFailure('You have no homes set').type, 'home-missing')
  assert.equal(extractHomeFailure('Unknown home: platform').type, 'home-missing')
  assert.equal(extractHomeFailure('Teleporting to platform in 5 seconds'), null)
})

test('detects unavailable tpa targets', () => {
  assert.equal(extractTargetUnavailable('Error: Player not found.').type, 'target-unavailable')
  assert.equal(extractTargetUnavailable('Player VulcanB002 is offline.').type, 'target-unavailable')
  assert.equal(extractTargetUnavailable('VulcanB002 has accepted your teleport request.'), null)
})

test('cooldown manager applies fallback duration on markUsed', () => {
  const cooldowns = new CooldownManager({ tpa: 600000 })
  const now = 1000000
  cooldowns.markUsed('delivery', 'tpa', now)
  assert.equal(cooldowns.waitMs('delivery', 'tpa', now), 600000)
  assert.equal(cooldowns.canRun('delivery', 'tpa', now + 600000), true)
})

test('server-learned cooldown overrides fallback in both directions', () => {
  const cooldowns = new CooldownManager({ tpa: 600000 })
  const now = 1000000
  cooldowns.markUsed('delivery', 'tpa', now)
  // Server says only 2 minutes left -> shorter than fallback must win.
  cooldowns.overrideReadyAt('delivery', 'tpa', now + 120000, now)
  assert.equal(cooldowns.waitMs('delivery', 'tpa', now), 120000)
  // Server says longer -> longer wins too.
  cooldowns.overrideReadyAt('delivery', 'tpa', now + 900000, now)
  assert.equal(cooldowns.waitMs('delivery', 'tpa', now), 900000)
})

test('cooldown state round-trips through JSON for mission persistence', () => {
  const cooldowns = new CooldownManager({ home: 600000 })
  const now = 5000000
  cooldowns.markUsed('delivery', 'home', now)
  const restored = new CooldownManager({ home: 600000 }, JSON.parse(JSON.stringify(cooldowns.toJSON())))
  assert.equal(restored.waitMs('delivery', 'home', now + 60000), 540000)
})

test('cooldown wait awaits readiness polling and can abort immediately', async () => {
  let unavailable = false
  let polls = 0
  const finished = await waitWithAbort(5000, {
    tickMs: 50,
    shouldAbort: () => unavailable,
    onTick: async () => {
      await Promise.resolve()
      polls += 1
      unavailable = true
    }
  })

  assert.equal(finished, false)
  assert.equal(polls, 1)
})

test('silent delivery commands use a short anti-spam hold instead of the fallback cooldown', async () => {
  const bot = new EventEmitter()
  const sent = []
  bot.chat = (message) => sent.push(message)
  const cooldowns = new CooldownManager({ tpa: 600000 })
  const keepAlive = setTimeout(() => {}, 50)

  const result = await sendCommandWithCooldown({
    bot,
    cooldowns,
    command: 'tpa',
    message: '/tpa VulcanB002',
    maxChatWaitMs: 5,
    silentRetryMs: 20000,
    assumeFallbackCooldown: false
  })
  clearTimeout(keepAlive)

  assert.equal(result.status, 'sent')
  assert.deepEqual(sent, ['/tpa VulcanB002'])
  assert.ok(cooldowns.waitMs('delivery', 'tpa') > 19000)
  assert.ok(cooldowns.waitMs('delivery', 'tpa') <= 20000)

  const blockedRetry = await sendCommandWithCooldown({
    bot,
    cooldowns,
    command: 'tpa',
    message: '/tpa VulcanB002',
    maxChatWaitMs: 5,
    silentRetryMs: 20000,
    assumeFallbackCooldown: false,
    shouldAbort: () => true
  })
  assert.equal(blockedRetry.status, 'aborted')
  assert.deepEqual(sent, ['/tpa VulcanB002'])
})

test('returns target-unavailable immediately when the server cannot find the tpa target', async () => {
  const bot = new EventEmitter()
  bot.chat = () => bot.emit('messagestr', 'Error: Player not found.')
  const cooldowns = new CooldownManager({ tpa: 600000 })

  const result = await sendCommandWithCooldown({
    bot,
    cooldowns,
    command: 'tpa',
    message: '/tpa VulcanB002',
    maxChatWaitMs: 8000,
    silentRetryMs: 20000,
    assumeFallbackCooldown: false
  })

  assert.deepEqual(result, { status: 'target-unavailable', message: 'Error: Player not found.' })
  assert.ok(cooldowns.waitMs('delivery', 'tpa') > 19000)
})
