'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  DEFAULT_LOBBY_HOST_FAILOVER_REGION,
  DEFAULT_LOBBY_HOST_FAILOVER_REGIONS,
  DEFAULT_LOBBY_HOST_FAILOVER_REGION_DEFINITIONS,
  DEFAULT_LOBBY_HOST_FAILOVER_TIMEOUT_MS,
  DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION,
  createHostConnectionFailureSession,
  createPersistedHostState,
  getLobbyHostFailoverSettings,
  hostListSignature,
  isHostConnectionError,
  isHostFailoverSession,
  nextHostIndex,
  resolvePersistedHostIndex,
  updateLobbyHostFailoverState
} = require('../src/nerv-printer/connection/host-failover')

test('persisted host follows its hostname when the configured list is reordered', () => {
  const oldHosts = ['8b8t.org', '6b6t.me', 'alt.6b6t.org', 'alt3.6b6t.org']
  const state = createPersistedHostState(oldHosts, 2, 1234)
  const reorderedHosts = ['8b8t.org', 'alt.6b6t.org', 'alt1.6b6t.org', 'alt3.6b6t.org']

  assert.equal(state.currentHost, 'alt.6b6t.org')
  assert.equal(resolvePersistedHostIndex(state, reorderedHosts), 1)
})

test('legacy index-only state is rejected after a host-list deployment', () => {
  const hosts = ['8b8t.org', 'alt.6b6t.org', 'alt1.6b6t.org']
  assert.equal(resolvePersistedHostIndex({ timestamp: 1234, currentIndex: 2 }, hosts), -1)
})

test('signed numeric state remains compatible when its host list is unchanged', () => {
  const hosts = ['alt.6b6t.org', 'alt1.6b6t.org']
  const state = {
    timestamp: 1234,
    currentIndex: 1,
    hostListSignature: hostListSignature(hosts)
  }
  assert.equal(resolvePersistedHostIndex(state, hosts), 1)
})

test('next host selection advances and wraps', () => {
  const hosts = ['alt.6b6t.org', 'alt1.6b6t.org', 'alt3.6b6t.org']
  assert.equal(nextHostIndex(hosts, 0), 1)
  assert.equal(nextHostIndex(hosts, 2), 0)
  assert.equal(nextHostIndex(hosts, -1), 0)
})

test('observed lobby becomes a host failure after 60 seconds of continuous residence', () => {
  const settings = getLobbyHostFailoverSettings({})
  assert.equal(settings.regionName, DEFAULT_LOBBY_HOST_FAILOVER_REGION)
  assert.deepEqual(settings.regionNames, DEFAULT_LOBBY_HOST_FAILOVER_REGIONS)
  assert.equal(settings.timeoutMs, DEFAULT_LOBBY_HOST_FAILOVER_TIMEOUT_MS)

  let state = updateLobbyHostFailoverState({}, DEFAULT_LOBBY_HOST_FAILOVER_REGION, 1000, settings)
  assert.equal(state.timedOut, false)
  state = updateLobbyHostFailoverState(state, DEFAULT_LOBBY_HOST_FAILOVER_REGION, 60999, settings)
  assert.equal(state.timedOut, false)
  state = updateLobbyHostFailoverState(state, DEFAULT_LOBBY_HOST_FAILOVER_REGION, 61000, settings)
  assert.equal(state.timedOut, true)
  assert.equal(state.elapsedMs, 60000)
})

test('low lobby becomes a host failure after 60 seconds of continuous residence', () => {
  const settings = getLobbyHostFailoverSettings({})
  const lowLobby = DEFAULT_LOBBY_HOST_FAILOVER_REGION_DEFINITIONS[0]

  let state = updateLobbyHostFailoverState({}, lowLobby.name, 5000, settings)
  state = updateLobbyHostFailoverState(state, lowLobby.name, 64999, settings)
  assert.equal(state.timedOut, false)
  state = updateLobbyHostFailoverState(state, lowLobby.name, 65000, settings)
  assert.equal(state.timedOut, true)
  assert.equal(state.regionName, lowLobby.name)
})

test('explicit plural lobby failover regions replace the default monitored list', () => {
  const settings = getLobbyHostFailoverSettings({
    advanced: { lobbyHostFailoverRegions: ['custom-lobby'] }
  })
  assert.deepEqual(settings.regionNames, ['custom-lobby'])
  assert.equal(settings.regionName, 'custom-lobby')
})

test('overworld origin stall requires 60 seconds without meaningful movement', () => {
  const settings = getLobbyHostFailoverSettings({})
  let state = updateLobbyHostFailoverState(
    {},
    DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION,
    1000,
    settings,
    { position: { x: 1, y: -34, z: 5 } }
  )
  state = updateLobbyHostFailoverState(
    state,
    DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION,
    60999,
    settings,
    { position: { x: 1.5, y: -60, z: 5.5 } }
  )
  assert.equal(state.timedOut, false)
  state = updateLobbyHostFailoverState(
    state,
    DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION,
    61000,
    settings,
    { position: { x: 1.5, y: 3, z: 5.5 } }
  )
  assert.equal(state.timedOut, true)
})

test('meaningful movement inside the overworld origin area resets the stall timer', () => {
  const settings = getLobbyHostFailoverSettings({})
  let state = updateLobbyHostFailoverState(
    {},
    DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION,
    1000,
    settings,
    { position: { x: 1, y: 20, z: 1 } }
  )
  state = updateLobbyHostFailoverState(
    state,
    DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION,
    50000,
    settings,
    { position: { x: 4, y: 20, z: 1 } }
  )
  assert.equal(state.enteredAt, 50000)
  state = updateLobbyHostFailoverState(
    state,
    DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION,
    100000,
    settings,
    { position: { x: 4, y: 20, z: 1 } }
  )
  assert.equal(state.timedOut, false)
})

test('leaving the observed lobby resets the residence timer', () => {
  const settings = getLobbyHostFailoverSettings({})
  let state = updateLobbyHostFailoverState({}, DEFAULT_LOBBY_HOST_FAILOVER_REGION, 1000, settings)
  state = updateLobbyHostFailoverState(state, 'login-portal-neg999', 50000, settings)
  assert.equal(state.enteredAt, 0)
  state = updateLobbyHostFailoverState(state, DEFAULT_LOBBY_HOST_FAILOVER_REGION, 60000, settings)
  assert.equal(state.enteredAt, 60000)
  assert.equal(state.timedOut, false)
})

test('SOCKS HostUnreachable becomes a retryable failed-startup session', () => {
  const error = new Error('Socks5 proxy rejected connection - HostUnreachable')
  assert.equal(isHostConnectionError(error), true)
  const session = createHostConnectionFailureSession(error)
  assert.equal(session.successfulStartup, false)
  assert.match(session.endReason, /host-connection-error/i)
  assert.match(session.lastError, /HostUnreachable/)
})

test('SOCKS proxy timeout becomes a retryable failed-startup session', () => {
  const error = new Error('Proxy connection timed out')
  assert.equal(isHostConnectionError(error), true)
  assert.equal(isHostFailoverSession({
    endReason: 'socketClosed',
    lastError: error.message
  }), true)
})

test('nested connection errors and emitted session errors force host failover', () => {
  const aggregate = new AggregateError([new Error('connect ECONNREFUSED')], 'all connections failed')
  assert.equal(isHostConnectionError(aggregate), true)
  assert.equal(isHostFailoverSession({
    endReason: 'socketClosed',
    lastError: 'Socks5 proxy rejected connection - HostUnreachable'
  }), true)
})

test('unrelated runtime errors are not converted into host failures', () => {
  assert.equal(isHostConnectionError(new Error('NBT palette is invalid')), false)
})

test('runtime lobby timeout feeds the existing reconnect loop and host rotation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js'), 'utf8')
  assert.match(source, /host-failover-lobby-timeout:/)
  assert.match(source, /getMatchedLobbyHostFailoverRegion\(/)
  assert.match(source, /bot\?\.game\?\.dimension/)
  assert.match(source, /\{ position: bot\?\.entity\?\.position \}/)
  assert.match(source, /return regions\.filter\(\(region\) => region\?\.enabled !== false\)/)
  assert.match(source, /lobbyHostFailoverState\.regionName/)
  assert.match(source, /shouldForceReconnectForHostFailure\(session, sessionConfig\)/)
  assert.match(source, /runtimeHostIndex = nextHostIndex\(runtimeHosts, runtimeHostIndex\)/)
  assert.match(source, /runSingleSessionWithHostFailure\(sessionConfig, attempt\)/)
  assert.match(source, /!successfulStartup && isHostConnectionError\(err\)[\s\S]*settle\(hostFailure\.endReason\)/)
})

test('canonical 6b6t configs retain but disable spawn portal movement', () => {
  for (const relativeFile of [
    'nerv-printer-config.json',
    'nerv-printer-config-premium-1.json',
    'delivery-bot-config.json'
  ]) {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nerv-printer-config', '_configs', relativeFile), 'utf8'))
    const regions = config.connection.profiles['6b6t'].bot.lobbyPortal.lobbyRegions
    const spawnPortal = regions.find((region) => region.name === 'spawn-portal-overworld-0')
    const lowLobby = regions.find((region) => region.name === 'observed-2026-09-low-lobby')
    assert.ok(spawnPortal, `${relativeFile} should retain the spawn portal definition`)
    assert.equal(spawnPortal.enabled, false)
    assert.equal(config.connection.profiles['6b6t'].bot.lobbyPortal.spawnDisk.enabled, false)
    assert.ok(lowLobby, `${relativeFile} should include the low lobby`)
    assert.equal(lowLobby.type, 'sphere')
    assert.deepEqual(lowLobby.center, { x: 32.5, y: 15, z: -4.5 })
    assert.equal(lowLobby.radius, 10)
    assert.equal(lowLobby.yTolerance, 10)
  }
})
