'use strict'

const crypto = require('crypto')

const DEFAULT_LOBBY_HOST_FAILOVER_REGION = 'observed-2026-06-new-lobby'
const DEFAULT_SECONDARY_LOBBY_HOST_FAILOVER_REGION = 'observed-2026-09-low-lobby'
const DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION = 'observed-2026-09-overworld-origin-stall'
const DEFAULT_LOBBY_HOST_FAILOVER_REGIONS = Object.freeze([
  DEFAULT_LOBBY_HOST_FAILOVER_REGION,
  DEFAULT_SECONDARY_LOBBY_HOST_FAILOVER_REGION,
  DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION
])
const DEFAULT_LOBBY_HOST_FAILOVER_REGION_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: DEFAULT_SECONDARY_LOBBY_HOST_FAILOVER_REGION,
    type: 'sphere',
    center: Object.freeze({ x: 32.5, y: 15, z: -4.5 }),
    radius: 10,
    yTolerance: 10
  }),
  Object.freeze({
    name: DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION,
    type: 'disk',
    centerX: 0,
    centerZ: 0,
    radius: 50,
    dimension: 'overworld',
    stationaryOnly: true,
    stationaryTolerance: 1.5
  })
])
const DEFAULT_LOBBY_HOST_FAILOVER_TIMEOUT_MS = 60 * 1000
const DEFAULT_LOBBY_HOST_FAILOVER_POLL_MS = 1000

function normalizeHosts(hosts) {
  return Array.isArray(hosts)
    ? hosts.map((host) => String(host || '').trim()).filter(Boolean)
    : []
}

function hostListSignature(hosts) {
  return crypto.createHash('sha256').update(normalizeHosts(hosts).join('\n')).digest('hex')
}

function createPersistedHostState(hosts, currentIndex, timestamp = Date.now()) {
  const normalizedHosts = normalizeHosts(hosts)
  const safeIndex = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < normalizedHosts.length
    ? currentIndex
    : 0
  return {
    timestamp,
    currentIndex: safeIndex,
    currentHost: normalizedHosts[safeIndex] || '',
    hostListSignature: hostListSignature(normalizedHosts)
  }
}

function resolvePersistedHostIndex(state, hosts) {
  const normalizedHosts = normalizeHosts(hosts)
  if (!state || !normalizedHosts.length) return -1

  const currentHost = String(state.currentHost || '').trim()
  if (currentHost) return normalizedHosts.indexOf(currentHost)

  if (state.hostListSignature !== hostListSignature(normalizedHosts)) return -1
  const currentIndex = Number(state.currentIndex)
  return Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < normalizedHosts.length
    ? currentIndex
    : -1
}

function nextHostIndex(hosts, currentIndex) {
  const normalizedHosts = normalizeHosts(hosts)
  if (!normalizedHosts.length) return 0
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= normalizedHosts.length) return 0
  return (currentIndex + 1) % normalizedHosts.length
}

function normalizeRegionNames(value) {
  const values = Array.isArray(value) ? value : [value]
  return [...new Set(values.map((name) => String(name || '').trim()).filter(Boolean))]
}

function getLobbyHostFailoverSettings(config) {
  const advanced = config?.advanced || {}
  const configuredRegionNames = normalizeRegionNames(advanced.lobbyHostFailoverRegions)
  const legacyRegionNames = normalizeRegionNames(advanced.lobbyHostFailoverRegion)
  const regionNames = configuredRegionNames.length
    ? configuredRegionNames
    : (legacyRegionNames.length
        ? [...new Set([
            ...legacyRegionNames,
            DEFAULT_SECONDARY_LOBBY_HOST_FAILOVER_REGION,
            DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION
          ])]
        : [...DEFAULT_LOBBY_HOST_FAILOVER_REGIONS])
  const configuredRegionDefinitions = Array.isArray(advanced.lobbyHostFailoverRegionDefinitions)
    ? advanced.lobbyHostFailoverRegionDefinitions.filter((region) => region && typeof region === 'object')
    : []
  return {
    enabled: advanced.lobbyHostFailoverEnabled !== false,
    regionName: regionNames[0] || DEFAULT_LOBBY_HOST_FAILOVER_REGION,
    regionNames,
    regionDefinitions: [...DEFAULT_LOBBY_HOST_FAILOVER_REGION_DEFINITIONS, ...configuredRegionDefinitions],
    timeoutMs: Math.max(1000, Number(advanced.lobbyHostFailoverTimeoutMs) || DEFAULT_LOBBY_HOST_FAILOVER_TIMEOUT_MS),
    pollMs: Math.max(250, Number(advanced.lobbyHostFailoverPollMs) || DEFAULT_LOBBY_HOST_FAILOVER_POLL_MS)
  }
}

function resetLobbyHostFailoverState() {
  return { enteredAt: 0, elapsedMs: 0, timedOut: false, regionName: '' }
}

function normalizeObservedPosition(position) {
  if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.z))) return null
  return {
    x: Number(position.x),
    y: Number.isFinite(Number(position.y)) ? Number(position.y) : null,
    z: Number(position.z)
  }
}

function positionMovedBeyondTolerance(anchor, position, tolerance) {
  if (!anchor || !position) return true
  return Math.max(
    Math.abs(Number(position.x) - Number(anchor.x)),
    Math.abs(Number(position.z) - Number(anchor.z))
  ) > tolerance
}

function updateLobbyHostFailoverState(previousState, matchedRegionName, now = Date.now(), settings = getLobbyHostFailoverSettings({}), observation = {}) {
  const previous = previousState && typeof previousState === 'object' ? previousState : {}
  const regionName = String(matchedRegionName || '')
  const monitoredRegionNames = normalizeRegionNames(settings.regionNames?.length ? settings.regionNames : settings.regionName)
  if (!settings.enabled || !monitoredRegionNames.includes(regionName)) {
    return resetLobbyHostFailoverState()
  }

  const regionDefinition = (Array.isArray(settings.regionDefinitions) ? settings.regionDefinitions : [])
    .find((region) => String(region?.name || '') === regionName)
  const stationaryOnly = regionDefinition?.stationaryOnly === true
  const position = normalizeObservedPosition(observation.position)
  const stationaryTolerance = Math.max(0.1, Number(regionDefinition?.stationaryTolerance) || 1.5)
  const sameResidence = previous.regionName === regionName && Number.isFinite(Number(previous.enteredAt)) && Number(previous.enteredAt) > 0
  const moved = stationaryOnly && (!position || positionMovedBeyondTolerance(previous.anchorPosition, position, stationaryTolerance))
  const enteredAt = sameResidence && !moved
    ? Number(previous.enteredAt)
    : Number(now)
  const elapsedMs = Math.max(0, Number(now) - enteredAt)
  return {
    enteredAt,
    elapsedMs,
    timedOut: elapsedMs >= settings.timeoutMs,
    regionName,
    ...(stationaryOnly ? { anchorPosition: moved || !sameResidence ? position : previous.anchorPosition } : {})
  }
}

function isHostConnectionError(error) {
  const nestedErrors = Array.isArray(error?.errors) ? error.errors : []
  const values = [error, error?.cause, ...nestedErrors]
  const text = values
    .filter(Boolean)
    .map((value) => String(value?.stack || value?.message || value || ''))
    .join(' ')
    .toLowerCase()
  const hints = [
    'hostunreachable',
    'host unreachable',
    'ehostunreach',
    'enetunreach',
    'econnrefused',
    'econnreset',
    'enotfound',
    'eai_again',
    'connect timeout',
    'connection timeout',
    'connection timed out',
    'proxy connection timed out',
    'socks5 proxy rejected connection'
  ]
  return hints.some((hint) => text.includes(hint))
}

function createHostConnectionFailureSession(error) {
  const lastError = String(error?.message || error || 'host connection failed')
  return {
    endReason: 'host-connection-error',
    lastError,
    kickedReason: '',
    successfulStartup: false,
    verificationCode: '',
    verificationUrl: '',
    tokenVerification: false
  }
}

function isHostFailoverSession(session) {
  const endReason = String(session?.endReason || '').toLowerCase()
  if (endReason === 'host-connection-error' || endReason.startsWith('host-failover-')) return true
  return isHostConnectionError(`${session?.lastError || ''} ${session?.kickedReason || ''}`)
}

module.exports = {
  DEFAULT_LOBBY_HOST_FAILOVER_POLL_MS,
  DEFAULT_LOBBY_HOST_FAILOVER_REGION,
  DEFAULT_LOBBY_HOST_FAILOVER_REGIONS,
  DEFAULT_LOBBY_HOST_FAILOVER_REGION_DEFINITIONS,
  DEFAULT_ORIGIN_STALL_HOST_FAILOVER_REGION,
  DEFAULT_LOBBY_HOST_FAILOVER_TIMEOUT_MS,
  createHostConnectionFailureSession,
  createPersistedHostState,
  getLobbyHostFailoverSettings,
  hostListSignature,
  isHostConnectionError,
  isHostFailoverSession,
  nextHostIndex,
  resolvePersistedHostIndex,
  updateLobbyHostFailoverState
}
