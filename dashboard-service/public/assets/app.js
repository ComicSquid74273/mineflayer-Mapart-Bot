const state = {
  bots: [],
  nodes: [],
  logs: [],
  operators: [],
  configs: [],
  dataFiles: [],
  uploadAssignments: [],
  queueSummary: {
    combinedRemaining: 0,
    combinedCompleted: 0,
    combinedTotal: 0,
    remaining: 0,
    pending: 0,
    active: 0,
    retrying: 0,
    requeued: 0,
    attention: 0,
    localNodeFiles: 0,
    managedLocalNodeFiles: 0,
    nodeFinishedMapCount: 0,
    completed: 0,
    eta: null
  },
  alerts: [],
  nbtSearch: '',
  localReprintCommands: [],
  configEditor: { name: null, content: '', dirty: false },
  refreshTimer: null,
  pauseDurationTimer: null,
  refreshIntervalMs: 300000,
  busy: false,
  uploadBusy: false,
  lastInteractionAt: Date.now(),
  dismissedVerify: new Set(),
  renderCache: {
    summary: '',
    bots: '',
    files: '',
    nodes: '',
    logs: '',
    operators: '',
    configs: '',
    dataFiles: '',
    uploadAssignments: '',
    failedQueue: '',
    fleetJump: '',
    queueSummary: '',
    events: '',
    alerts: '',
    auth: ''
  },
  events: [],
  localEvents: [],
  auth: {
    operator: '',
    password: '',
    verified: false,
    role: 'public',
    permissions: {
      canViewLogs: false,
      canOperate: false,
      canDeleteNodeFiles: false,
      canManageOperators: false,
      canAdmin: false
    }
  }
}

const AUTH_STORAGE_KEY = 'mapart-dashboard-operator-auth'
const REFRESH_STORAGE_KEY = 'mapart-dashboard-refresh-ms'
const ALLOWED_REFRESH_INTERVALS = [10000, 20000, 30000, 60000, 300000, 600000]
const UI_ACTIVITY_HOLD_MS = 15000

const elements = {
  authStatus: document.getElementById('authStatus'),
  alertsBar: document.getElementById('alertsBar'),
  backToTopButton: document.getElementById('backToTopButton'),
  botsGrid: document.getElementById('botsGrid'),
  botSummary: document.getElementById('botSummary'),
  eventLog: document.getElementById('eventLog'),
  fileInput: document.getElementById('fileInput'),
  fleetJump: document.getElementById('fleetJump'),
  lastRefresh: document.getElementById('lastRefresh'),
  logsList: document.getElementById('logsList'),
  nbtSearchInput: document.getElementById('nbtSearchInput'),
  nodesGrid: document.getElementById('nodesGrid'),
  operatorForm: document.getElementById('operatorForm'),
  loginButton: document.getElementById('loginButton'),
  logoutButton: document.getElementById('logoutButton'),
  managedPassword: document.getElementById('managedPassword'),
  managedRole: document.getElementById('managedRole'),
  managedUsername: document.getElementById('managedUsername'),
  operatorPassword: document.getElementById('operatorPassword'),
  operatorStatus: document.getElementById('operatorStatus'),
  operatorUsername: document.getElementById('operatorUsername'),
  operatorsList: document.getElementById('operatorsList'),
  permDeleteNodeFiles: document.getElementById('permDeleteNodeFiles'),
  permManageOperators: document.getElementById('permManageOperators'),
  permOperate: document.getElementById('permOperate'),
  permViewLogs: document.getElementById('permViewLogs'),
  refreshButton: document.getElementById('refreshButton'),
  refreshInterval: document.getElementById('refreshInterval'),
  queueRemainingValue: document.getElementById('queueRemainingValue'),
  queueCompletedValue: document.getElementById('queueCompletedValue'),
  queueTotalValue: document.getElementById('queueTotalValue'),
  queueEtaValue: document.getElementById('queueEtaValue'),
  queueOnlineEtaValue: document.getElementById('queueOnlineEtaValue'),
  queueRemainingMeta: document.getElementById('queueRemainingMeta'),
  queueTracker: document.getElementById('queueTracker'),
  serviceStatus: document.getElementById('serviceStatus'),
  startAllButton: document.getElementById('startAllButton'),
  stopAllButton: document.getElementById('stopAllButton'),
  distributeCheckbox: document.getElementById('distributeCheckbox'),
  uploadNodeSelect: document.getElementById('uploadNodeSelect'),
  uploadTargetType: document.getElementById('uploadTargetType'),
  uploadTargetSelectLabel: document.getElementById('uploadTargetSelectLabel'),
  uploadTargetSelectText: document.getElementById('uploadTargetSelectText'),
  distributeLabel: document.getElementById('distributeLabel'),
  uploadForm: document.getElementById('uploadForm'),
  uploadProgress: document.getElementById('uploadProgress'),
  uploadProgressFill: document.getElementById('uploadProgressFill'),
  uploadProgressText: document.getElementById('uploadProgressText'),
  uploadStatus: document.getElementById('uploadStatus'),
  uploadAssignmentsList: document.getElementById('uploadAssignmentsList'),
  failedQueueList: document.getElementById('failedQueueList'),
  retryAllFailedButton: document.getElementById('retryAllFailedButton'),
  clearDataButton: document.getElementById('clearDataButton'),
  configFilesList: document.getElementById('configFilesList'),
  dataFilesList: document.getElementById('dataFilesList'),
  configEditorSection: document.getElementById('configEditorSection'),
  configEditorTitle: document.getElementById('configEditorTitle'),
  configEditorClose: document.getElementById('configEditorClose'),
  configEditorTextarea: document.getElementById('configEditorTextarea'),
  configEditorSave: document.getElementById('configEditorSave'),
  configEditorStatus: document.getElementById('configEditorStatus')
}

function roleDefaults(role) {
  switch (String(role || '').toLowerCase()) {
    case 'admin':
      return {
        canViewLogs: true,
        canOperate: true,
        canDeleteNodeFiles: true,
        canManageOperators: true
      }
    case 'operator':
      return {
        canViewLogs: true,
        canOperate: true,
        canDeleteNodeFiles: false,
        canManageOperators: false
      }
    default:
      return {
        canViewLogs: true,
        canOperate: false,
        canDeleteNodeFiles: false,
        canManageOperators: false
      }
  }
}

function isAdmin() {
  return String(state.auth.role || '').toLowerCase() === 'admin'
}

function hasPermission(permissionName) {
  if (permissionName === 'admin') return isAdmin()
  return Boolean(state.auth.permissions?.[permissionName])
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTime(value) {
  if (!value) return 'n/a'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'n/a'
  return date.toLocaleString()
}

function formatDuration(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return 'n/a'
  if (ms < 1000) return '<1s'

  let totalSeconds = Math.round(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  totalSeconds -= days * 86400
  const hours = Math.floor(totalSeconds / 3600)
  totalSeconds -= hours * 3600
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - (minutes * 60)
  const parts = []

  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (!parts.length || (parts.length < 2 && seconds > 0 && days === 0)) parts.push(`${seconds}s`)
  return parts.slice(0, 2).join(' ')
}

function formatQueueEtaValue(value) {
  if (!value || typeof value !== 'object') return 'n/a'
  if (value.available === true) {
    const ms = Number(value.ms)
    if (!Number.isFinite(ms)) return 'n/a'
    if (ms <= 0) return 'Done'
    return `~${formatDuration(ms)}`
  }
  const reason = String(value.reason || '').toLowerCase()
  if (reason === 'no-online-bots' || reason === 'no-online-nodes') return 'Paused'
  return 'n/a'
}

function formatQueueEta(eta, mode = 'deployed') {
  const value = eta && typeof eta === 'object' ? eta[mode] : null
  return formatQueueEtaValue(value)
}

function describeQueueEta(eta) {
  if (!eta || typeof eta !== 'object') return 'ETA n/a'
  const knownNodes = Math.max(0, Number(eta.knownNodeCount || 0))
  const onlineNodes = Math.max(0, Number(eta.onlineNodeCount || 0))
  const deployedAverageMapMs = Math.max(0, Number(eta.averageMapMs || 0))
  const deployedAverageText = deployedAverageMapMs > 0 ? formatDuration(deployedAverageMapMs) : 'n/a'
  const online = eta.online && typeof eta.online === 'object' ? eta.online : null
  const observedNodes = Math.max(0, Number(online?.observedNodeCount || online?.workerCount || 0))
  const observedAverageMapMs = Math.max(0, Number(online?.averageMapMs || 0))
  const observedAverageText = observedAverageMapMs > 0 ? formatDuration(observedAverageMapMs) : 'n/a'
  return `Deployed ETA uses ${deployedAverageText}/map across ${knownNodes} known node(s); online ETA uses ${observedAverageText}/map from ${observedNodes}/${onlineNodes} online node(s)`
}

function formatFileSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return 'n/a'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function normalizeRefreshInterval(value) {
  const next = Number(value)
  return ALLOWED_REFRESH_INTERVALS.includes(next) ? next : 300000
}

function formatRefreshInterval(ms) {
  const seconds = Math.round(Number(ms) / 1000)
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown'
  if (seconds < 60) return `${seconds} second(s)`
  return `${Math.round(seconds / 60)} minute(s)`
}

function phaseClass(phase) {
  return `phase-${String(phase || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function isActiveNbtRun(bot) {
  const currentNbt = String(bot?.currentNbt || '').trim().toLowerCase()
  return Boolean(bot?.online && currentNbt && currentNbt !== 'none' && bot?.currentNbtStartedAt)
}

function hasResettableCurrentNbt(bot) {
  const currentNbt = String(bot?.currentNbt || '').trim().toLowerCase()
  return Boolean(bot?.online && currentNbt && currentNbt !== 'none')
}

function displayBotPhase(bot) {
  const phase = String(bot?.phase || '').trim().toLowerCase()
  const detail = String(bot?.statusDetail || '').trim()
  if (isActiveNbtRun(bot) && (phase === 'waiting-spawn' || /^spawn-\d+$/i.test(detail))) {
    return 'printing'
  }
  return bot?.phase || 'unknown'
}

function displayBotStatusDetail(bot) {
  const detail = String(bot?.statusDetail || '').trim()
  const phase = displayBotPhase(bot)
  if (isActiveNbtRun(bot) && /^spawn-\d+$/i.test(detail)) {
    return phase
  }
  return detail || phase || 'unknown'
}

function isBotPrinting(bot) {
  return displayBotPhase(bot) === 'printing'
}

function isBotPaused(bot) {
  const phase = String(bot?.phase || '').trim().toLowerCase()
  const detail = String(bot?.statusDetail || '').trim().toLowerCase()
  const active = String(bot?.activeState || '').trim().toLowerCase()
  return bot?.pauseDesired === true || (bot?.online && (phase === 'paused' || detail === 'paused' || detail === 'parking-at-cartography' || detail === 'waiting-platform-to-pause' || active === 'paused'))
}

function getPauseStartedAt(bot) {
  const value = String(bot?.pauseStartedAt || '').trim()
  const ms = new Date(value || 0).getTime()
  return Number.isFinite(ms) && ms > 0 ? value : ''
}

function formatPauseDurationFrom(value) {
  const ms = new Date(value || 0).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return 'n/a'
  return formatDuration(Date.now() - ms)
}

function updatePauseDurationText(root = document) {
  root.querySelectorAll('[data-paused-started-at]').forEach((element) => {
    const startedAt = element.getAttribute('data-paused-started-at') || ''
    element.textContent = formatPauseDurationFrom(startedAt)
  })
}

function formatBotProgress(bot) {
  const progress = bot?.progress || null
  const percent = Number(progress?.percent)
  if (Number.isFinite(percent)) return `${percent}%`

  const processed = Number(progress?.processed)
  const total = Number(progress?.total)
  if (Number.isFinite(processed) && Number.isFinite(total) && total > 0) {
    return `${Number(((processed / total) * 100).toFixed(2))}%`
  }

  return isActiveNbtRun(bot) && isBotPrinting(bot) ? 'working' : 'n/a'
}

function botHealthClass(bot) {
  const phase = displayBotPhase(bot)
  if (!bot.online || phase === 'crashed' || phase === 'stopped') return 'health-red'
  if (bot.tokenWaiting || bot.activeState === 'stale' || bot.reconnectState === 'reconnecting') return 'health-yellow'
  return 'health-green'
}

function pushEvent(level, message) {
  state.localEvents.unshift({
    eventId: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    operator: 'browser',
    action: 'local-notice',
    message,
    createdAt: new Date().toISOString()
  })
  state.localEvents = state.localEvents.slice(0, 18)
  renderEvents()
}

function markUserInteraction() {
  state.lastInteractionAt = Date.now()
}

function hasRecentUserInteraction() {
  return Date.now() - state.lastInteractionAt < UI_ACTIVITY_HOLD_MS
}

function updateSection(sectionName, signature, render) {
  if (state.renderCache[sectionName] === signature) return
  state.renderCache[sectionName] = signature
  render()
}

function authHeaderValue() {
  if (!state.auth.operator || !state.auth.password) return ''
  return `Basic ${btoa(`${state.auth.operator}:${state.auth.password}`)}`
}

function loadStoredAuth() {
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    state.auth.operator = String(parsed.operator || '')
    state.auth.password = String(parsed.password || '')
  } catch {
    // Ignore broken stored auth.
  }
}

function loadStoredRefreshInterval() {
  try {
    const raw = window.localStorage.getItem(REFRESH_STORAGE_KEY)
    if (!raw) return
    state.refreshIntervalMs = normalizeRefreshInterval(raw)
  } catch {
    state.refreshIntervalMs = 300000
  }
}

function persistAuth() {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
    operator: state.auth.operator
  }))
}

function persistRefreshInterval() {
  window.localStorage.setItem(REFRESH_STORAGE_KEY, String(state.refreshIntervalMs))
}

function applyRefreshInterval() {
  if (elements.refreshInterval) {
    elements.refreshInterval.value = String(state.refreshIntervalMs)
  }
  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer)
  }
  state.refreshTimer = window.setInterval(() => {
    void refreshData({ background: true })
  }, state.refreshIntervalMs)
}

function clearAuth() {
  state.auth = {
    operator: '',
    password: '',
    verified: false,
    role: 'public',
    permissions: {
      canViewLogs: false,
      canOperate: false,
      canDeleteNodeFiles: false,
      canManageOperators: false,
      canAdmin: false
    }
  }
  window.localStorage.removeItem(AUTH_STORAGE_KEY)
  renderAuthState()
}

function setManagedOperatorDefaults(role) {
  const defaults = roleDefaults(role)
  elements.permViewLogs.checked = defaults.canViewLogs
  elements.permOperate.checked = defaults.canOperate
  elements.permDeleteNodeFiles.checked = defaults.canDeleteNodeFiles
  elements.permManageOperators.checked = defaults.canManageOperators
}

function renderAuthState() {
  const authSignature = JSON.stringify({
    operator: state.auth.operator,
    verified: state.auth.verified,
    role: state.auth.role,
    permissions: state.auth.permissions
  })
  if (state.renderCache.auth === authSignature) return
  state.renderCache.auth = authSignature

  elements.operatorUsername.value = state.auth.operator || ''
  elements.operatorPassword.value = state.auth.password || ''
  elements.authStatus.textContent = state.auth.verified && state.auth.operator
    ? `${state.auth.role}: ${state.auth.operator}`
    : 'Viewer mode'

  for (const element of document.querySelectorAll('[data-permission-needed]')) {
    element.disabled = !hasPermission(element.dataset.permissionNeeded || '')
  }

  const canOperate = hasPermission('canOperate')
  if (elements.fileInput) elements.fileInput.disabled = !canOperate
  if (elements.uploadNodeSelect) elements.uploadNodeSelect.disabled = !canOperate
  if (elements.uploadTargetType) elements.uploadTargetType.disabled = !canOperate
  if (elements.distributeCheckbox) elements.distributeCheckbox.disabled = !canOperate
  if (elements.operatorForm) {
    const disabled = !hasPermission('canManageOperators')
    for (const element of [
      elements.managedUsername,
      elements.managedPassword,
      elements.managedRole,
      elements.permViewLogs,
      elements.permOperate,
      elements.permDeleteNodeFiles,
      elements.permManageOperators
    ]) {
      if (element) element.disabled = disabled
    }
    const submit = elements.operatorForm.querySelector('button[type="submit"]')
    if (submit) submit.disabled = disabled
  }
}

function updateBackToTopVisibility() {
  if (!elements.backToTopButton) return
  elements.backToTopButton.classList.toggle('hidden', window.scrollY <= 360)
}

async function requestJson(url, options = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {})
  }
  if (options.requireAuth === true) {
    const authValue = authHeaderValue()
    if (authValue) headers.authorization = authValue
  }

  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers,
    ...options
  })

  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(body?.error || `Request failed: ${response.status}`)
  }
  return body
}

function applyAuthResult(result) {
  state.auth.verified = result?.ok === true
  state.auth.operator = String(result?.operator || state.auth.operator || '')
  state.auth.role = String(result?.role || 'viewer')
  state.auth.permissions = result?.permissions || {
    canViewLogs: false,
    canOperate: false,
    canDeleteNodeFiles: false,
    canManageOperators: false,
    canAdmin: false
  }
  state.auth.password = ''
  persistAuth()
  renderAuthState()
}

async function verifyOperatorAuth() {
  try {
    const result = await requestJson('/api/dashboard/auth/me', { requireAuth: true })
    applyAuthResult(result)
    return state.auth.verified
  } catch {
    state.auth.verified = false
    state.auth.role = 'public'
    state.auth.permissions = {
      canViewLogs: false,
      canOperate: false,
      canDeleteNodeFiles: false,
      canManageOperators: false,
      canAdmin: false
    }
    renderAuthState()
    return false
  }
}

async function downloadLogFile(fileName) {
  const response = await fetch(`/api/dashboard/logs/${encodeURIComponent(fileName)}/download`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      authorization: authHeaderValue()
    }
  })
  if (!response.ok) {
    let message = `Request failed: ${response.status}`
    try {
      const body = await response.json()
      if (body?.error) message = body.error
    } catch {
      // Ignore parse failure.
    }
    throw new Error(message)
  }

  const blob = await response.blob()
  const url = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.URL.revokeObjectURL(url)
}

async function downloadNodeLogFile(hostLabel, fileName) {
  const response = await fetch(`/api/dashboard/nodes/${encodeURIComponent(hostLabel)}/logs/${encodeURIComponent(fileName)}/download`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      authorization: authHeaderValue()
    }
  })
  if (!response.ok) {
    let message = `Request failed: ${response.status}`
    try {
      const body = await response.json()
      if (body?.error) message = body.error
    } catch {
      // Ignore parse failure.
    }
    throw new Error(message)
  }

  const blob = await response.blob()
  const url = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${hostLabel || 'node'}-${fileName}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.URL.revokeObjectURL(url)
}

async function downloadConfigFile(fileName) {
  const response = await fetch(`/api/dashboard/config/${encodeURIComponent(fileName)}/download`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      authorization: authHeaderValue()
    }
  })
  if (!response.ok) {
    let message = `Request failed: ${response.status}`
    try {
      const body = await response.json()
      if (body?.error) message = body.error
    } catch {
      // Ignore parse failure.
    }
    throw new Error(message)
  }

  const blob = await response.blob()
  const url = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.URL.revokeObjectURL(url)
}

async function downloadNodeConfigFile(hostLabel, fileName) {
  const response = await fetch(`/api/dashboard/nodes/${encodeURIComponent(hostLabel)}/config/${encodeURIComponent(fileName)}/download`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      authorization: authHeaderValue()
    }
  })
  if (!response.ok) {
    let message = `Request failed: ${response.status}`
    try {
      const body = await response.json()
      if (body?.error) message = body.error
    } catch {
      // Ignore parse failure.
    }
    throw new Error(message)
  }

  const blob = await response.blob()
  const url = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${hostLabel || 'node'}-${fileName}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.URL.revokeObjectURL(url)
}

function activeElementInsideForm() {
  const active = document.activeElement
  return Boolean(active && (
    elements.uploadForm.contains(active)
    || elements.operatorForm.contains(active)
  ))
}

function captureFormState() {
  return {
    uploadNode: elements.uploadNodeSelect.value,
    distribute: elements.distributeCheckbox.checked,
    targetType: elements.uploadTargetType?.value || 'node'
  }
}

function restoreFormState(snapshot) {
  if (!snapshot) return
  if (snapshot.targetType && elements.uploadTargetType) {
    elements.uploadTargetType.value = snapshot.targetType
  }
  if (snapshot.uploadNode && Array.from(elements.uploadNodeSelect.options).some((option) => option.value === snapshot.uploadNode)) {
    elements.uploadNodeSelect.value = snapshot.uploadNode
  }
  const distribute = snapshot.distribute !== false
  elements.distributeCheckbox.checked = distribute
  elements.uploadTargetSelectLabel.style.display = distribute ? 'none' : ''
  elements.uploadNodeSelect.required = !distribute
}

function nodeAnchorId(hostLabel, index = 0) {
  const fallback = `node-${index + 1}`
  const raw = String(hostLabel || fallback).trim() || fallback
  const encoded = encodeURIComponent(raw)
    .replace(/%/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '_')
  return `fleet-node-${encoded || fallback}`
}

function compareNodeLabels(left, right) {
  return String(left?.hostLabel || '').localeCompare(String(right?.hostLabel || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  })
}

function nodeShortcutLabel(hostLabel, index = 0) {
  const text = String(hostLabel || '').trim()
  const match = text.match(/(\d+)\s*$/)
  return match ? match[1] : String(index + 1)
}

function renderFleetJump() {
  if (!elements.fleetJump) return
  const knownNodes = (Array.isArray(state.nodes) ? state.nodes : []).slice().sort(compareNodeLabels)
  const signature = JSON.stringify({
    nodes: knownNodes.map((node) => [
      node.hostLabel,
      Number(node.onlineCount || 0),
      Number(node.botCount || 0)
    ]),
    bots: state.bots.map((bot) => [
      bot.botName,
      bot.hostLabel,
      bot.online,
      bot.phase,
      bot.statusDetail,
      bot.currentNbt,
      bot.currentNbtStartedAt,
      bot.idle,
      bot.activeState,
      bot.pauseDesired,
      bot.pauseStartedAt
    ])
  })
  if (state.renderCache.fleetJump === signature) return
  state.renderCache.fleetJump = signature

  if (!knownNodes.length) {
    elements.fleetJump.innerHTML = ''
    elements.fleetJump.classList.add('hidden')
    return
  }

  elements.fleetJump.classList.remove('hidden')
  elements.fleetJump.innerHTML = `
    <div class="fleet-jump-head">
      <span>Known nodes</span>
    </div>
    <div class="fleet-jump-buttons">
      ${knownNodes.map((node, index) => {
        const onlineCount = Number(node.onlineCount || 0)
        const botCount = Number(node.botCount || 0)
        const hostLabel = String(node.hostLabel || `Node-${index + 1}`).trim() || `Node-${index + 1}`
        const nodeBots = state.bots.filter((bot) => String(bot.hostLabel || '').trim() === hostLabel)
        const printing = nodeBots.filter((bot) => isBotPrinting(bot)).length
        const paused = nodeBots.filter((bot) => isBotPaused(bot)).length
        const pauseStartedTimes = nodeBots
          .filter((bot) => isBotPaused(bot))
          .map((bot) => getPauseStartedAt(bot))
          .filter(Boolean)
          .map((value) => new Date(value).getTime())
          .filter((value) => Number.isFinite(value) && value > 0)
        const nodePauseStartedAt = pauseStartedTimes.length ? new Date(Math.min(...pauseStartedTimes)).toISOString() : ''
        const stale = nodeBots.filter((bot) => bot.online && bot.activeState === 'stale').length
        const idle = nodeBots.filter((bot) => bot.online && bot.idle && !isBotPaused(bot)).length
        const shortcutLabel = nodeShortcutLabel(hostLabel, index)
        const statusText = paused > 0 ? `${paused} paused`
          : (onlineCount <= 0 ? 'Offline'
            : (printing > 0 ? `${printing} printing`
              : (stale > 0 ? `${stale} stale`
                : (idle > 0 ? `${idle} idle` : 'Online'))))
        const displayStatusText = paused > 0 && nodePauseStartedAt
          ? `${statusText} ${formatPauseDurationFrom(nodePauseStartedAt)}`
          : statusText
        const onlineClass = paused > 0 ? 'fleet-jump-paused' : (onlineCount > 0 ? 'fleet-jump-online' : 'fleet-jump-offline')
        return `
          <button class="fleet-jump-button ${onlineClass}" type="button" data-action="jump-node" data-node-target="${escapeHtml(nodeAnchorId(hostLabel, index))}" title="${escapeHtml(`${hostLabel}: ${onlineCount}/${botCount} online, ${displayStatusText}`)}" aria-label="${escapeHtml(`Jump to ${hostLabel}`)}">
            <strong>${escapeHtml(shortcutLabel)}</strong>
            <span>${escapeHtml(statusText)}${nodePauseStartedAt ? ` <span data-paused-started-at="${escapeHtml(nodePauseStartedAt)}">${escapeHtml(formatPauseDurationFrom(nodePauseStartedAt))}</span>` : ''}</span>
          </button>
        `
      }).join('')}
    </div>
  `
}

function renderSummary() {
  const summarySignature = JSON.stringify({
    botCount: state.bots.length,
    nodeCount: state.nodes.length,
    online: state.bots.filter((item) => item.online).length,
    printing: state.bots.filter((item) => isBotPrinting(item)).length,
    paused: state.bots.filter((item) => isBotPaused(item)).length,
    stale: state.bots.filter((item) => item.activeState === 'stale').length,
    idle: state.bots.filter((item) => item.idle && !isBotPaused(item)).length
  })
  if (state.renderCache.summary === summarySignature) return
  state.renderCache.summary = summarySignature

  const online = state.bots.filter((item) => item.online).length
  const printing = state.bots.filter((item) => isBotPrinting(item)).length
  const paused = state.bots.filter((item) => isBotPaused(item)).length
  const stale = state.bots.filter((item) => item.activeState === 'stale').length
  const idle = state.bots.filter((item) => item.idle && !isBotPaused(item)).length
  const nodeCount = state.nodes.length

  elements.botSummary.innerHTML = [
    ['Known Nodes', nodeCount],
    ['Known Bots', state.bots.length],
    ['Online', online],
    ['Printing', printing],
    ['Paused', paused],
    ['Idle', idle],
    ['Stale', stale]
  ].map(([label, value]) => `
    <article class="summary-card">
      <span class="hint">${escapeHtml(label)}</span>
      <span class="summary-value">${escapeHtml(value)}</span>
    </article>
  `).join('')
}

function formatAlertNodeBotDetails(alert) {
  const details = alert?.details && typeof alert.details === 'object' ? alert.details : {}
  const entries = []
  const addEntry = (hostLabel, botName) => {
    const host = String(hostLabel || '').trim()
    const bot = String(botName || '').trim()
    const label = host && bot ? `${host}/${bot}` : (host || bot)
    if (label && !entries.includes(label)) entries.push(label)
  }

  if (Array.isArray(details.bots)) {
    for (const item of details.bots) {
      addEntry(item?.hostLabel, item?.botName)
    }
  }

  if (Array.isArray(details.files)) {
    for (const item of details.files) {
      addEntry(item?.hostLabel, item?.botName)
    }
  }

  if (!entries.length && Array.isArray(details.hostLabels)) {
    const hosts = details.hostLabels.map((item) => String(item || '').trim()).filter(Boolean)
    if (hosts.length) entries.push(`nodes: ${hosts.slice(0, 6).join(', ')}${hosts.length > 6 ? ` +${hosts.length - 6} more` : ''}`)
  }

  if (!entries.length && Array.isArray(details.botNames)) {
    const bots = details.botNames.map((item) => String(item || '').trim()).filter(Boolean)
    if (bots.length) entries.push(`bots: ${bots.slice(0, 6).join(', ')}${bots.length > 6 ? ` +${bots.length - 6} more` : ''}`)
  }

  if (!entries.length) return ''
  const visible = entries.slice(0, 8)
  const extra = entries.length > visible.length ? ` +${entries.length - visible.length} more` : ''
  return `${visible.join(', ')}${extra}`
}

function renderAlerts() {
  if (!elements.alertsBar) return
  const sig = JSON.stringify(state.alerts || [])
  if (state.renderCache.alerts === sig) return
  state.renderCache.alerts = sig

  if (!state.alerts.length) {
    elements.alertsBar.innerHTML = ''
    elements.alertsBar.classList.add('hidden')
    return
  }

  elements.alertsBar.classList.remove('hidden')
  elements.alertsBar.innerHTML = state.alerts.slice(0, 8).map((alert) => {
    const level = String(alert.level || 'info').toLowerCase()
    const className = level === 'critical' || level === 'error' ? 'alert-critical'
      : (level === 'warn' ? 'alert-warn' : 'alert-info')
    const nodeBotDetails = formatAlertNodeBotDetails(alert)
    return `
      <article class="alert-item ${className}">
        <div>
          <strong>${escapeHtml(alert.title || alert.category || 'Alert')}</strong>
          <p>${escapeHtml(alert.message || '')}</p>
          ${nodeBotDetails ? `<p class="alert-meta">${escapeHtml(nodeBotDetails)}</p>` : ''}
        </div>
        <span class="tag ${className === 'alert-critical' ? 'status-offline' : 'status-neutral'}">${escapeHtml(alert.category || level)}</span>
      </article>`
  }).join('')
}

function renderNodeTimingMetrics(node) {
  const timing = node.timing || {}
  const activeRun = timing.activeRun || node.currentRun || null
  const completed = Math.max(
    Number(node.finishedMapCount || 0),
    Number(node.totalCompletedMapCount || 0),
    Number(timing.totalCompletedMaps || 0)
  )
  const averageSamples = Number(timing.totalCompletedMaps || 0)
  const averageDurationMs = Number(timing.averageDurationMs || 0)
  const average = averageSamples > 0 && averageDurationMs > 0 ? formatDuration(averageDurationMs) : 'n/a'
  const currentRunElapsed = activeRun?.elapsedMs ? formatDuration(Number(activeRun.elapsedMs)) : 'none'
  const currentRunFile = activeRun?.fileName || ''
  const currentRunBots = Array.isArray(activeRun?.botNames) && activeRun.botNames.length
    ? ` | ${activeRun.botNames.join(', ')}`
    : ''
  const assignmentStats = node.assignmentStats || {}
  const operationalStats = node.operationalStats || {}
  const assigned = Number(assignmentStats.assignedTotal || 0)
  const remaining = Number(operationalStats.remainingMaps || 0)
  const reconnects = Number(operationalStats.reconnectCount || 0)
  return `
    <div class="node-timing-strip">
      <div class="metric metric-compact metric-wide">
        Current Run<strong>${escapeHtml(currentRunElapsed)}</strong>
        ${currentRunFile ? `<span class="metric-subtle" title="${escapeHtml(currentRunFile)}">${escapeHtml(currentRunFile)}${escapeHtml(currentRunBots)}</span>` : ''}
      </div>
      <div class="metric metric-compact">
        Avg Map Time<strong>${escapeHtml(average)}</strong>
      </div>
      <div class="metric metric-compact">
        Completed<strong>${escapeHtml(completed)}</strong>
      </div>
      <div class="metric metric-compact">
        Assigned<strong>${escapeHtml(assigned)}</strong>
      </div>
      <div class="metric metric-compact">
        Remaining<strong>${escapeHtml(remaining)}</strong>
      </div>
      <div class="metric metric-compact">
        Reconnects<strong>${escapeHtml(reconnects)}</strong>
      </div>
    </div>
  `
}

function renderNodeOperationalTags(node) {
  const stats = node.operationalStats || {}
  const assignmentStats = node.assignmentStats || {}
  const tags = []
  if (Number(assignmentStats.assignedPending || 0) > 0) tags.push(['status-neutral', `Pending ${assignmentStats.assignedPending}`])
  if (Number(assignmentStats.assignedFailed || 0) > 0) tags.push(['status-offline', `Failed ${assignmentStats.assignedFailed}`])
  if (Number(stats.staleBotCount || 0) > 0) tags.push(['status-neutral', `Stale ${stats.staleBotCount}`])
  if (Number(stats.reconnectingCount || 0) > 0) tags.push(['status-neutral', `Reconnecting ${stats.reconnectingCount}`])
  if (Number(stats.errorCount || 0) > 0) tags.push(['status-offline', `Errors ${stats.errorCount}`])
  if (!tags.length) return ''
  return `<div class="node-alert-strip">${tags.map(([className, label]) => `<span class="tag ${className}">${escapeHtml(label)}</span>`).join('')}</div>`
}

function renderBotCard(bot) {
  const statusDetail = displayBotStatusDetail(bot)
  const locationText = bot.locationDetail || bot.location || 'unknown'
  const progress = formatBotProgress(bot)
  const activeNbtRun = isActiveNbtRun(bot)
  const resettableCurrentNbt = hasResettableCurrentNbt(bot)
  const currentRunElapsed = bot.currentNbtStartedAt
    ? formatDuration(Date.now() - new Date(bot.currentNbtStartedAt).getTime())
    : 'n/a'
  const showVerify = bot.tokenWaiting && !state.dismissedVerify.has(bot.botName)
  const verifyBanner = showVerify ? `
    <div class="verify-banner">
      <div class="verify-info">
        <span class="verify-label">Verification Required</span>
        <div class="verify-detail">
          <span class="verify-field">Bot: <strong>${escapeHtml(bot.botName)}</strong></span>
          <span class="verify-field">Code: <strong class="verify-code">${escapeHtml(bot.verificationCode || 'loading...')}</strong></span>
          <span class="verify-field">IP: <strong>${escapeHtml(bot.botIp || 'unknown')}</strong></span>
        </div>
      </div>
      <div class="verify-actions">
        <button class="accent-button small-button" type="button" data-action="verify-done" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}">Verified</button>
        <button class="ghost-button small-button" type="button" data-action="verify-refresh" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}">Resend</button>
        <button class="ghost-button small-button" type="button" data-action="verify-close" data-bot-name="${escapeHtml(bot.botName)}" title="Dismiss banner">x</button>
      </div>
    </div>
  ` : ''
  const healthClass = botHealthClass(bot)
  const pingText = typeof bot.latencyMs === 'number' ? `${bot.latencyMs}ms` : 'n/a'
  const pauseStartedAt = getPauseStartedAt(bot)
  const pausedForText = pauseStartedAt ? formatPauseDurationFrom(pauseStartedAt) : 'n/a'
  const pauseReason = String(bot.pauseReason || '').trim()
  const canOperate = hasPermission('canOperate')
  const warningList = Array.isArray(bot.warnings) ? bot.warnings.slice(-3) : []
  const warningsHtml = warningList.length
    ? `<div class="bot-warnings">${warningList.map((warning) => `
        <div class="bot-warning">
          <strong>${escapeHtml(warning.category || 'warning')}</strong>
          <span>${escapeHtml(warning.message || '')}${Number(warning.count) > 1 ? ` (${escapeHtml(warning.count)}x)` : ''}</span>
        </div>`).join('')}</div>`
    : ''
  return `
    <article class="bot-card${showVerify ? ' bot-card-verify' : ''}">
      ${verifyBanner}
      <div class="bot-head">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="health-dot ${escapeHtml(healthClass)}" title="${escapeHtml(healthClass === 'health-green' ? 'Healthy' : healthClass === 'health-yellow' ? 'Warning' : 'Issue')}"></span>
          <div>
            <h3 class="bot-name">${escapeHtml(bot.botName)}</h3>
            <p class="bot-meta">${escapeHtml(bot.role || 'single')} | ${escapeHtml(locationText)}${bot.botIp && !showVerify ? ` | ${escapeHtml(bot.botIp)}` : ''}</p>
          </div>
        </div>
        <div class="status-inline">
          <span class="status-pill ${bot.online ? 'status-online' : 'status-offline'}">${bot.online ? 'Online' : 'Offline'}</span>
          <span class="phase-pill ${phaseClass(statusDetail)}">${escapeHtml(statusDetail)}</span>
        </div>
      </div>
      <div class="bot-metrics">
        <div class="metric">Status<strong>${escapeHtml(statusDetail)}</strong></div>
        <div class="metric">Health<strong>${escapeHtml(bot.health ?? 'n/a')}</strong></div>
        <div class="metric">Hunger<strong>${escapeHtml(bot.hunger ?? 'n/a')}</strong></div>
        <div class="metric">Activity<strong>${escapeHtml(bot.activeState || 'n/a')}</strong></div>
        <div class="metric">Progress<strong>${escapeHtml(progress)}</strong></div>
        <div class="metric">MC Ping<strong>${escapeHtml(pingText)}</strong></div>
        ${isBotPaused(bot) ? `<div class="metric">Paused For<strong data-paused-started-at="${escapeHtml(pauseStartedAt)}">${escapeHtml(pausedForText)}</strong></div>` : ''}
      </div>
      <div class="bot-metrics">
        <div class="metric">NBT<strong>${escapeHtml(bot.currentNbt || 'none')}</strong></div>
        <div class="metric">Current Run<strong>${escapeHtml(currentRunElapsed)}</strong></div>
        <div class="metric">Recovery<strong>${escapeHtml(bot.recoveryState || 'none')}</strong></div>
        <div class="metric">Reconnect<strong>${escapeHtml(bot.reconnectCount ? `${bot.reconnectState || 'idle'} (${bot.reconnectCount})` : (bot.reconnectState || 'idle'))}</strong></div>
      </div>
      ${bot.lastError ? `<p class="hint">Last error: ${escapeHtml(bot.lastError)}</p>` : ''}
      ${isBotPaused(bot) && pauseReason ? `<p class="hint">Pause reason: ${escapeHtml(pauseReason)}</p>` : ''}
      ${warningsHtml}
      <div class="bot-actions">
        <button class="accent-button" type="button" data-action="start" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}">Start Print</button>
        <button class="danger-button" type="button" data-action="stop" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}">Pause Print</button>
        <button class="ghost-button small-button" type="button" data-action="home-platform-bot" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}" title="Send /home platform">Home Platform</button>
        ${resettableCurrentNbt ? `<button class="danger-button small-button" type="button" data-action="reset-current-nbt" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}" data-current-nbt="${escapeHtml(bot.currentNbt || '')}" title="Reset platform and restart this NBT from target 0">Reset NBT</button>` : ''}
        <button class="ghost-button small-button" type="button" data-action="disconnect-bot" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}" title="Disconnect from server (no auto-reconnect)">Disconnect</button>
        <button class="ghost-button small-button" type="button" data-action="reconnect-bot" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}" title="Reconnect to server">Reconnect</button>
      </div>
      <div class="chat-panel">
        <div class="chat-messages" id="chat-${escapeHtml(bot.botName)}">
          ${(Array.isArray(bot.recentChat) && bot.recentChat.length)
            ? bot.recentChat.slice(-12).map((entry) => `
              <div class="chat-line">
                <span class="chat-ts">${escapeHtml(formatTime(entry.ts).split(', ')[1] || formatTime(entry.ts))}</span>
                <span class="chat-text">${escapeHtml(entry.text)}</span>
              </div>`).join('')
            : '<p class="chat-empty">No recent chat</p>'}
        </div>
        <div class="chat-input-row">
          <input class="chat-input" type="text" placeholder="Send chat message..." maxlength="256"
            data-chat-bot="${escapeHtml(bot.botName)}"
            data-permission-needed="canOperate" />
          <button class="accent-button small-button" type="button"
            data-action="chat-send"
            data-permission-needed="canOperate"
            data-bot-name="${escapeHtml(bot.botName)}">Send</button>
        </div>
      </div>
    </article>
  `
}

function renderBots() {
  const botsSignature = JSON.stringify({ bots: state.bots, nodes: state.nodes, dismissed: [...state.dismissedVerify] })
  if (state.renderCache.bots === botsSignature) return
  state.renderCache.bots = botsSignature

  if (!state.nodes.length && !state.bots.length) {
    elements.botsGrid.innerHTML = `
      <article class="empty-card">
        <h3>No bot data yet</h3>
        <p>Start at least one bot with dashboard integration enabled, then refresh this page.</p>
      </article>
    `
    return
  }

  const botsByNode = new Map()
  for (const bot of state.bots) {
    const hostLabel = String(bot.hostLabel || 'unknown-host')
    const group = botsByNode.get(hostLabel) || []
    group.push(bot)
    botsByNode.set(hostLabel, group)
  }

  const sortedNodes = state.nodes.slice().sort(compareNodeLabels)
  const renderedNodes = sortedNodes.map((node, index) => {
    const nodeBots = (botsByNode.get(node.hostLabel) || []).sort((left, right) => String(left.botName).localeCompare(String(right.botName)))
    const nodeHasActiveNbt = nodeBots.some((bot) => hasResettableCurrentNbt(bot))
    const configFiles = Array.isArray(node.configFiles) ? node.configFiles : []
    const configText = configFiles.length ? ` | Config ${configFiles.join(', ')}` : ''
    const editConfigName = configFiles.length === 1 ? configFiles[0] : ''
    return `
      <article id="${escapeHtml(nodeAnchorId(node.hostLabel, index))}" class="fleet-node-group">
        <div class="fleet-node-head">
          <div>
            <h3 class="bot-name">${escapeHtml(node.hostLabel)}</h3>
            <p class="bot-meta">${escapeHtml((node.botNames || []).join(', ') || 'no bots')} | Online ${escapeHtml(node.onlineCount)}/${escapeHtml(node.botCount)} | Last update ${escapeHtml(formatTime(node.lastStatusAt))}${escapeHtml(configText)}</p>
          </div>
          <div class="fleet-node-controls">
            <span class="tag ${node.onlineCount > 0 ? 'status-online' : 'status-offline'}">${node.onlineCount > 0 ? 'reachable' : 'offline'}</span>
            <button class="ghost-button small-button" type="button" data-action="edit-node-config" data-permission-needed="canManageOperators" data-host-label="${escapeHtml(node.hostLabel)}" data-config-name="${escapeHtml(editConfigName)}" title="${escapeHtml(editConfigName ? `Edit ${editConfigName}` : 'View config files')}">Edit Config</button>
            <button class="accent-button small-button" type="button" data-action="start-node" data-permission-needed="canOperate" data-host-label="${escapeHtml(node.hostLabel)}">Start Node</button>
            <button class="danger-button small-button" type="button" data-action="stop-node" data-permission-needed="canOperate" data-host-label="${escapeHtml(node.hostLabel)}">Pause Node</button>
            <button class="ghost-button small-button" type="button" data-action="home-platform-node" data-permission-needed="canOperate" data-host-label="${escapeHtml(node.hostLabel)}" title="Send /home platform to every bot on this node">Home Platform</button>
            ${nodeHasActiveNbt ? `<button class="danger-button small-button" type="button" data-action="reset-node-current-nbt" data-permission-needed="canOperate" data-host-label="${escapeHtml(node.hostLabel)}">Reset Node NBT</button>` : ''}
          </div>
        </div>
        ${renderNodeTimingMetrics(node)}
        ${renderNodeOperationalTags(node)}
        <div class="fleet-node-bots">
          ${nodeBots.length ? nodeBots.map(renderBotCard).join('') : `
            <article class="empty-card">
              <h3>No bot cards for this node</h3>
              <p>The node is known, but no bot status is currently available.</p>
            </article>
          `}
        </div>
      </article>
    `
  })

  const orphanBots = state.bots.filter((bot) => !sortedNodes.some((node) => node.hostLabel === bot.hostLabel))
  if (orphanBots.length) {
    renderedNodes.push(`
      <article class="fleet-node-group">
        <div class="fleet-node-head">
          <div>
            <h3 class="bot-name">Unmapped Nodes</h3>
            <p class="bot-meta">Bots without a matching node summary are shown here.</p>
          </div>
          <span class="tag status-neutral">mixed</span>
        </div>
        <div class="fleet-node-bots">
          ${orphanBots.sort((left, right) => String(left.botName).localeCompare(String(right.botName))).map(renderBotCard).join('')}
        </div>
      </article>
    `)
  }

  elements.botsGrid.innerHTML = renderedNodes.join('')
}

function renderFiles() {
  const sig = JSON.stringify({
    targetType: elements.uploadTargetType?.value || 'node',
    bots: state.bots.map((b) => `${b.botName}:${b.hostLabel}:${b.online}`)
  })
  if (state.renderCache.files === sig) return
  state.renderCache.files = sig

  const snapshot = captureFormState()
  const targetType = elements.uploadTargetType?.value === 'bot' ? 'bot' : 'node'
  const targetLabel = targetType === 'bot' ? 'bot' : 'node'
  const nodeOptions = [`<option value="">Select ${targetLabel}</option>`]

  if (elements.uploadTargetSelectText) {
    elements.uploadTargetSelectText.textContent = targetType === 'bot' ? 'Target bot' : 'Target node'
  }
  if (elements.distributeLabel) {
    elements.distributeLabel.textContent = 'Use central queue: any eligible bot can poll later'
  }

  // Group bots by hostLabel so related bots appear together
  const byNode = new Map()
  for (const bot of state.bots) {
    const label = String(bot.hostLabel || 'unknown').trim() || 'unknown'
    if (!byNode.has(label)) byNode.set(label, [])
    byNode.get(label).push(bot)
  }

  if (targetType === 'bot') {
    for (const [nodeLabel, bots] of byNode.entries()) {
      nodeOptions.push(`<optgroup label="${escapeHtml(nodeLabel)}">`)
      for (const bot of bots.sort((left, right) => String(left.botName).localeCompare(String(right.botName)))) {
        nodeOptions.push(`<option value="${escapeHtml(bot.botName)}">${escapeHtml(bot.botName)} (${bot.online ? 'online' : 'offline'})</option>`)
      }
      nodeOptions.push('</optgroup>')
    }
  } else if (byNode.size > 1) {
    // Multiple nodes - use <optgroup> to separate them
    for (const [nodeLabel, bots] of byNode.entries()) {
      nodeOptions.push(`<optgroup label="${escapeHtml(nodeLabel)}">`)
      const onlineCount = bots.filter((bot) => bot.online).length
      nodeOptions.push(`<option value="${escapeHtml(nodeLabel)}">${escapeHtml(nodeLabel)} (${onlineCount}/${bots.length} online)</option>`)
      nodeOptions.push('</optgroup>')
    }
  } else {
    // Single node - flat list, no group header needed
    const nodeLabel = byNode.keys().next().value || 'unknown'
    const bots = byNode.get(nodeLabel) || []
    const onlineCount = bots.filter((bot) => bot.online).length
    nodeOptions.push(`<option value="${escapeHtml(nodeLabel)}">${escapeHtml(nodeLabel)} (${onlineCount}/${bots.length} online)</option>`)
  }

  elements.uploadNodeSelect.innerHTML = nodeOptions.join('')
  restoreFormState(snapshot)
}

function renderUploadAssignments() {
  if (!elements.uploadAssignmentsList) return
  const sig = JSON.stringify({
    canOperate: hasPermission('canOperate'),
    assignments: state.uploadAssignments
  })
  if (state.renderCache.uploadAssignments === sig) return
  state.renderCache.uploadAssignments = sig

  if (!hasPermission('canOperate')) {
    elements.uploadAssignmentsList.innerHTML = `
      <article class="empty-card">
        <h3>Assignments hidden</h3>
        <p>Login as an operator to view NBT upload assignments.</p>
      </article>`
    return
  }

  if (!state.uploadAssignments.length) {
    elements.uploadAssignmentsList.innerHTML = `
      <article class="empty-card">
        <h3>No upload assignments</h3>
        <p>Uploaded NBT targets and claim status will appear here.</p>
      </article>`
    return
  }

  elements.uploadAssignmentsList.innerHTML = state.uploadAssignments.slice(0, 30).map((item) => {
    const target = item.targetBotName
      ? `Bot: ${item.targetBotName}`
      : (item.targetHostLabel ? `Node: ${item.targetHostLabel}` : 'Unassigned')
    const status = String(item.queueStatus || item.status || 'unknown')
    const statusClass = ['succeeded', 'placed', 'completed'].includes(status) ? 'status-online'
      : (['failed', 'failed-final'].includes(status) ? 'status-offline' : 'status-neutral')
    const claimed = item.claimedByBotName ? ` | claimed by ${item.claimedByBotName}${item.claimedByHostLabel ? `/${item.claimedByHostLabel}` : ''}` : ''
    const local = item.localFileName ? ` | local ${item.localFileName}` : ''
    const result = item.resultMessage ? ` | ${item.resultMessage}` : ''
    const attempts = Number(item.maxAttempts || 0) > 0 ? ` | attempts ${Number(item.attemptCount || 0)}/${Number(item.maxAttempts || 0)}` : ''
    const canRetry = ['failed-final', 'failed'].includes(status) || item.status === 'failed'
    return `
      <article class="file-item compact-file-item">
        <div class="file-row">
          <div>
            <strong>${escapeHtml(item.fileName || 'unknown.nbt')}</strong>
            <p class="file-meta">${escapeHtml(target)}${escapeHtml(claimed)}${escapeHtml(local)} | ${escapeHtml(formatTime(item.createdAt))}${escapeHtml(attempts)}${escapeHtml(result)}</p>
          </div>
          <div class="file-actions">
            <span class="tag ${statusClass}">${escapeHtml(status)}</span>
            ${canRetry ? `<button class="accent-button small-button" type="button" data-action="queue-retry" data-permission-needed="canOperate" data-file-id="${escapeHtml(item.id)}">Retry</button>` : ''}
          </div>
        </div>
      </article>`
  }).join('')
}

function isFailedQueueAssignment(item) {
  const status = String(item?.queueStatus || item?.status || '').trim().toLowerCase()
  return status === 'failed' || status === 'failed-final' || item?.status === 'failed'
}

function renderFailedQueueRetries() {
  if (!elements.failedQueueList) return
  const failedItems = state.uploadAssignments.filter(isFailedQueueAssignment)
  const sig = JSON.stringify({
    canOperate: hasPermission('canOperate'),
    failedItems
  })
  if (state.renderCache.failedQueue === sig) return
  state.renderCache.failedQueue = sig

  if (elements.retryAllFailedButton) {
    elements.retryAllFailedButton.textContent = `Retry All Failed (${failedItems.length})`
    elements.retryAllFailedButton.disabled = !hasPermission('canOperate') || failedItems.length === 0
  }

  if (!hasPermission('canOperate')) {
    elements.failedQueueList.innerHTML = `
      <article class="empty-card">
        <h3>Retries hidden</h3>
        <p>Login as an operator to view failed queue files.</p>
      </article>`
    return
  }

  if (!failedItems.length) {
    elements.failedQueueList.innerHTML = `
      <article class="empty-card">
        <h3>No failed queue files</h3>
        <p>Failed and failed-final NBTs will appear here.</p>
      </article>`
    return
  }

  elements.failedQueueList.innerHTML = failedItems.map((item) => {
    const status = String(item.queueStatus || item.status || 'failed')
    const owner = item.claimedByBotName
      ? `${item.claimedByBotName}${item.claimedByHostLabel ? ` / ${item.claimedByHostLabel}` : ''}`
      : (item.claimedByHostLabel || 'unclaimed')
    const failure = Array.isArray(item.failureHistory) && item.failureHistory.length
      ? item.failureHistory[item.failureHistory.length - 1]
      : null
    const reason = item.resultMessage || failure?.reason || 'no reason recorded'
    const failedAt = item.failedAt || failure?.failedAt || item.lastAttemptAt || item.createdAt
    return `
      <article class="file-item compact-file-item failed-queue-item">
        <div class="file-row">
          <div>
            <strong>${escapeHtml(item.fileName || 'unknown.nbt')}</strong>
            <p class="file-meta">Status ${escapeHtml(status)} | attempts ${escapeHtml(Number(item.attemptCount || 0))}/${escapeHtml(Number(item.maxAttempts || 0) || 3)} | last claimed ${escapeHtml(owner)} | failed ${escapeHtml(formatTime(failedAt))}</p>
            <p class="file-meta">${escapeHtml(reason)}</p>
          </div>
          <div class="file-actions">
            <span class="tag status-offline">${escapeHtml(status)}</span>
            <button class="accent-button small-button" type="button" data-action="queue-retry" data-permission-needed="canOperate" data-file-id="${escapeHtml(item.id)}">Retry</button>
          </div>
        </div>
      </article>`
  }).join('')
}

function renderQueueSummary() {
  if (!elements.queueRemainingValue || !elements.queueCompletedValue || !elements.queueTotalValue || !elements.queueEtaValue || !elements.queueOnlineEtaValue || !elements.queueRemainingMeta) return
  const summary = state.queueSummary || {}
  const sig = JSON.stringify(summary)
  if (state.renderCache.queueSummary === sig) return
  state.renderCache.queueSummary = sig

  const centralRemaining = Math.max(0, Number(summary.remaining || 0))
  const centralCompleted = Math.max(0, Number(summary.completed || 0))
  const pending = Math.max(0, Number(summary.pending || 0))
  const active = Math.max(0, Number(summary.active || 0))
  const retrying = Math.max(0, Number(summary.retrying || 0))
  const requeued = Math.max(0, Number(summary.requeued || 0))
  const attention = Math.max(0, Number(summary.attention || 0))
  const localNodeFiles = Math.max(0, Number(summary.localNodeFiles || 0))
  const managedLocalNodeFiles = Math.max(0, Number(summary.managedLocalNodeFiles || 0))
  const nodeFinishedMapCount = Math.max(0, Number(summary.nodeFinishedMapCount || 0))
  const remaining = Math.max(0, Number(summary.combinedRemaining ?? (centralRemaining + localNodeFiles)))
  const completed = Math.max(0, Number(summary.combinedCompleted ?? Math.max(centralCompleted, nodeFinishedMapCount)))
  const total = Math.max(0, Number(summary.combinedTotal ?? (remaining + completed)))
  const eta = summary.eta || null
  const parts = [`Queue ${centralRemaining} left/${centralCompleted} done`, `downloaded ${managedLocalNodeFiles}`, `manual local ${localNodeFiles}`, `finished ${nodeFinishedMapCount}`]
  if (pending || active || retrying || requeued) parts.push(`${pending} pending/${active} active/${requeued} requeued/${retrying} retry-needed`)
  if (attention) parts.push(`${attention} attention`)
  parts.push(describeQueueEta(eta))

  elements.queueRemainingValue.textContent = String(remaining)
  elements.queueCompletedValue.textContent = String(completed)
  elements.queueTotalValue.textContent = String(total)
  elements.queueEtaValue.textContent = formatQueueEta(eta)
  elements.queueOnlineEtaValue.textContent = `Online ${formatQueueEta(eta, 'online')}`
  elements.queueRemainingMeta.textContent = parts.join(' · ')
  if (elements.queueTracker) {
    elements.queueTracker.classList.toggle('queue-tracker-warn', attention > 0 || retrying > 0)
    elements.queueTracker.classList.toggle('queue-tracker-active', remaining > 0 && active > 0)
  }
}

function renderNodes() {
  const nodesSignature = JSON.stringify({ nodes: state.nodes, nbtSearch: state.nbtSearch, role: state.auth.role, isAdmin: isAdmin() })
  if (state.renderCache.nodes === nodesSignature) return
  state.renderCache.nodes = nodesSignature

  const totalFinishedMaps = state.nodes.reduce((total, node) => {
    return total + (Array.isArray(node.finishedMapFiles) ? node.finishedMapFiles.length : 0)
  }, 0)
  const bulkFinishedMapActions = isAdmin()
    ? `
      <article class="node-card">
        <div class="file-row">
          <div>
            <strong>Fresh-start maintenance</strong>
            <p class="file-meta">${escapeHtml(totalFinishedMaps)} finished .nbt file(s) reported across all nodes</p>
          </div>
          <div class="bot-actions">
            <button class="danger-button small-button" type="button" data-action="delete-all-finished-maps" data-permission-needed="admin">CLEANFINISHEDNBT</button>
            <button class="danger-button small-button" type="button" data-action="reset-everything" data-permission-needed="admin">RESETEVERYTHING</button>
          </div>
        </div>
      </article>
    `
    : ''

  if (!state.nodes.length) {
    elements.nodesGrid.innerHTML = `${bulkFinishedMapActions}
      <article class="empty-card">
        <h3>No node inventory yet</h3>
        <p>Once a node reports its shared NBT folder, the files will appear here.</p>
      </article>
    `
    return
  }

  elements.nodesGrid.innerHTML = bulkFinishedMapActions + state.nodes.map((node) => {
    const query = String(state.nbtSearch || '').trim().toLowerCase()
    const matchesQuery = (file) => {
      if (!query) return true
      return String(file?.fileName || '').toLowerCase().includes(query)
    }
    const files = (Array.isArray(node.nodeFiles) ? node.nodeFiles : []).filter(matchesQuery)
    const finishedFiles = (Array.isArray(node.finishedMapFiles) ? node.finishedMapFiles : []).filter(matchesQuery)
    const serverReprints = Array.isArray(node.reprintCommands) ? node.reprintCommands : []
    const localReprints = state.localReprintCommands
      .filter((command) => String(command.hostLabel || '') === String(node.hostLabel || ''))
      .filter((command) => !serverReprints.some((serverCommand) => serverCommand.commandId && serverCommand.commandId === command.commandId))
    const reprintCommands = [...localReprints, ...serverReprints].filter(matchesQuery)
    const configFiles = Array.isArray(node.configFiles) ? node.configFiles : []
    const totalNodeFiles = Array.isArray(node.nodeFiles) ? node.nodeFiles.length : 0
    const totalFinishedFiles = Array.isArray(node.finishedMapFiles) ? node.finishedMapFiles.length : 0
    const noActiveText = query && totalNodeFiles ? 'No active .nbt files match this search.' : 'No .nbt files reported on this node.'
    const noFinishedText = query && totalFinishedFiles ? 'No finished .nbt files match this search.' : 'No finished .nbt files reported on this node.'
    return `
      <article class="node-card">
        <div class="file-row">
          <div>
            <strong>${escapeHtml(node.hostLabel)}</strong>
            <p class="file-meta">Bots: ${escapeHtml((node.botNames || []).join(', ') || 'none')} | Online ${escapeHtml(node.onlineCount)}/${escapeHtml(node.botCount)}${configFiles.length ? ` | Config ${escapeHtml(configFiles.join(', '))}` : ''}</p>
          </div>
          <span class="tag ${node.onlineCount > 0 ? 'status-online' : 'status-offline'}">${node.onlineCount > 0 ? 'reachable' : 'offline'}</span>
        </div>
        ${renderNodeTimingMetrics(node)}
        ${renderNodeOperationalTags(node)}
        ${reprintCommands.length ? `
          <div class="reprint-queue">
            <strong>Reprint queue</strong>
            ${reprintCommands.map((command) => {
              const status = String(command.status || 'unknown')
              const statusClass = status === 'succeeded' ? 'status-online'
                : (status === 'failed' ? 'status-offline' : 'status-neutral')
              const claimed = command.claimedByBotName ? ` | claimed by ${command.claimedByBotName}` : ''
              const result = command.resultMessage ? ` | ${command.resultMessage}` : ''
              const queuedAt = command.createdAt ? formatTime(command.createdAt) : 'just now'
              return `
                <article class="file-item compact-file-item">
                  <div class="file-row">
                    <div>
                      <strong>${escapeHtml(command.fileName)}</strong>
                      <p class="file-meta">${escapeHtml(status)}${escapeHtml(claimed)} | queued ${escapeHtml(queuedAt)}${escapeHtml(result)}</p>
                    </div>
                    <span class="tag ${statusClass}">${escapeHtml(status)}</span>
                  </div>
                </article>`
            }).join('')}
          </div>
        ` : ''}
        ${files.length ? files.map((file) => `
          <article class="file-item compact-file-item">
            <div class="file-row">
              <div>
                <strong>${escapeHtml(file.fileName)}</strong>
                <p class="file-meta">${escapeHtml(file.sizeBytes)} bytes | ${escapeHtml(formatTime(file.modifiedAt))}</p>
              </div>
              <div class="file-actions">
                <button class="danger-button small-button" type="button" data-action="delete-node-file" data-permission-needed="canDeleteNodeFiles" data-host-label="${escapeHtml(node.hostLabel)}" data-file-name="${escapeHtml(file.fileName)}">Delete</button>
              </div>
            </div>
          </article>
        `).join('') : `<p class="hint">${escapeHtml(noActiveText)}</p>`}
        <details class="finished-map-details" open>
          <summary>Finished maps (${escapeHtml(finishedFiles.length)}${query ? `/${escapeHtml(node.finishedMapCount || totalFinishedFiles || 0)}` : ''})</summary>
          <div class="finished-map-list">
            ${finishedFiles.length ? finishedFiles.map((file) => `
              <article class="file-item compact-file-item">
                <div class="file-row">
                  <div>
                    <strong>${escapeHtml(file.fileName)}</strong>
                    <p class="file-meta">${escapeHtml(file.sizeBytes)} bytes | ${escapeHtml(formatTime(file.modifiedAt))}</p>
                  </div>
                  <div class="file-actions">
                    <button class="accent-button small-button" type="button" data-action="reprint-finished-map" data-permission-needed="canOperate" data-host-label="${escapeHtml(node.hostLabel)}" data-file-name="${escapeHtml(file.fileName)}">Reprint</button>
                    <button class="danger-button small-button" type="button" data-action="delete-finished-map" data-permission-needed="canManageOperators" data-host-label="${escapeHtml(node.hostLabel)}" data-file-name="${escapeHtml(file.fileName)}">Delete</button>
                  </div>
                </div>
              </article>
            `).join('') : `<p class="hint">${escapeHtml(noFinishedText)}</p>`}
          </div>
        </details>
      </article>
    `
  }).join('')
}

function renderLogs() {
  const nodeLogGroups = state.nodes
    .map((node) => ({
      hostLabel: node.hostLabel,
      botNames: Array.isArray(node.botNames) ? node.botNames : [],
      items: Array.isArray(node.nodeLogs) ? node.nodeLogs : []
    }))
  const groupedBotCount = nodeLogGroups.reduce((sum, group) => sum + group.botNames.length, 0)
  const sharedHostLabelNotice = nodeLogGroups.length === 1 && groupedBotCount > 1
    ? `
      <article class="file-item">
        <div>
          <strong>One node label detected</strong>
          <p class="file-meta">All ${escapeHtml(groupedBotCount)} reporting bot(s) use hostLabel "${escapeHtml(nodeLogGroups[0].hostLabel)}", so logs are grouped under one node. Set a unique dashboard.hostLabel per machine/process if these should appear as separate nodes.</p>
        </div>
      </article>
    `
    : ''

  const logsSignature = JSON.stringify({
    verified: state.auth.verified,
    canViewLogs: hasPermission('canViewLogs'),
    logs: state.logs,
    nodeLogGroups
  })
  if (state.renderCache.logs === logsSignature) return
  state.renderCache.logs = logsSignature

  if (!state.auth.verified || !hasPermission('canViewLogs')) {
    elements.logsList.innerHTML = `
      <article class="empty-card">
        <h3>Login required</h3>
        <p>Authenticate as a viewer, operator, or admin to list and download log files.</p>
      </article>
    `

    return
  }

  if (!state.logs.length && !nodeLogGroups.length) {
    elements.logsList.innerHTML = `
      <article class="empty-card">
        <h3>No logs found</h3>
        <p>No downloadable .log files are currently available on the dashboard host or any reporting node.</p>
      </article>
    `

    return
  }

  const hostLogsMarkup = state.logs.length
    ? `
      <section>
        <div class="file-row" style="margin-bottom:10px;">
          <div>
            <strong>Dashboard host</strong>
            <p class="file-meta">${escapeHtml(state.logs.length)} log file(s)</p>
          </div>
        </div>
        ${state.logs.map((item) => `
          <article class="file-item">
            <div class="file-row">
              <div>
                <strong>${escapeHtml(item.fileName)}</strong>
                <p class="file-meta">Node: Dashboard host | ${escapeHtml(formatFileSize(item.sizeBytes))} | ${escapeHtml(formatTime(item.modifiedAt))}</p>
              </div>
              <div style="display:flex;gap:8px;flex-shrink:0;">
                <button class="ghost-button small-button" type="button" data-action="download-log" data-permission-needed="canViewLogs" data-file-name="${escapeHtml(item.fileName)}">Download</button>
                <button class="danger-button small-button" type="button" data-action="delete-log" data-permission-needed="canManageOperators" data-file-name="${escapeHtml(item.fileName)}">Delete</button>
              </div>
            </div>
          </article>
        `).join('')}
      </section>
    `
    : `
      <article class="file-item">
        <div>
          <strong>Dashboard host</strong>
          <p class="file-meta">No local .log files found on the dashboard machine.</p>
        </div>
      </article>
    `

  const nodeLogsMarkup = nodeLogGroups.map((group) => `
    <section style="margin-top:14px;">
      <div class="file-row" style="margin-bottom:10px;">
        <div>
          <strong>Node: ${escapeHtml(group.hostLabel)}</strong>
          <p class="file-meta">${escapeHtml(group.items.length)} log file(s)${group.botNames.length ? ` | Bots: ${escapeHtml(group.botNames.join(', '))}` : ''}</p>
        </div>
      </div>
      ${group.items.length ? group.items.map((item) => {
        const reporters = Array.isArray(item.reportedByBotNames) && item.reportedByBotNames.length
          ? ` | Reported by: ${item.reportedByBotNames.join(', ')}`
          : ''
        return `
          <article class="file-item">
            <div class="file-row">
              <div>
                <strong>${escapeHtml(item.fileName)}</strong>
                <p class="file-meta">Node: ${escapeHtml(group.hostLabel)} | ${escapeHtml(formatFileSize(item.sizeBytes))} | ${escapeHtml(formatTime(item.modifiedAt))}${escapeHtml(reporters)}</p>
              </div>
              <div style="display:flex;gap:8px;flex-shrink:0;">
                <button class="ghost-button small-button" type="button" data-action="download-node-log" data-permission-needed="canViewLogs" data-host-label="${escapeHtml(group.hostLabel)}" data-file-name="${escapeHtml(item.fileName)}">Download</button>
              </div>
            </div>
          </article>`
      }).join('') : `
        <article class="file-item">
          <div>
            <strong>No node logs reported</strong>
            <p class="file-meta">Node: ${escapeHtml(group.hostLabel)} | Wait for a bot heartbeat from this node.</p>
          </div>
        </article>
      `}
    </section>
  `).join('')

  elements.logsList.innerHTML = `${hostLogsMarkup}${sharedHostLabelNotice}${nodeLogsMarkup}`
}

function renderOperators() {
  const operatorsSignature = JSON.stringify({
    canManageOperators: hasPermission('canManageOperators'),
    operators: state.operators
  })
  if (state.renderCache.operators === operatorsSignature) return
  state.renderCache.operators = operatorsSignature

  if (!hasPermission('canManageOperators')) {
    elements.operatorsList.innerHTML = `
      <article class="empty-card">
        <h3>Admin only</h3>
        <p>Log in with an operator that can manage operators to view and edit accounts.</p>
      </article>
    `
    return
  }

  if (!state.operators.length) {
    elements.operatorsList.innerHTML = `
      <article class="empty-card">
        <h3>No operators configured</h3>
        <p>Create an operator above. Changes are written directly to the operators JSON file.</p>
      </article>
    `
    return
  }

  elements.operatorsList.innerHTML = state.operators.map((item) => {
    const permissions = item.permissions || {}
    return `
      <article class="file-item">
        <div class="file-row">
          <div>
            <strong>${escapeHtml(item.username)}</strong>
            <p class="file-meta">role=${escapeHtml(item.role)} | created ${escapeHtml(formatTime(item.createdAt))} | updated ${escapeHtml(formatTime(item.updatedAt))}</p>
          </div>
          <button class="danger-button small-button" type="button" data-action="delete-operator" data-permission-needed="canManageOperators" data-username="${escapeHtml(item.username)}">Delete</button>
        </div>
        <p class="hint">Logs: ${permissions.canViewLogs ? 'yes' : 'no'} | Operate: ${permissions.canOperate ? 'yes' : 'no'} | Delete node files: ${permissions.canDeleteNodeFiles ? 'yes' : 'no'} | Manage operators: ${permissions.canManageOperators ? 'yes' : 'no'}</p>
      </article>
    `
  }).join('')
}

function renderConfigs() {
  const configNodes = buildConfigNodeMap()
  const configRows = buildConfigRows(configNodes)
  const sig = JSON.stringify({ canAdmin: hasPermission('canManageOperators'), configRows })
  if (state.renderCache.configs === sig) return
  state.renderCache.configs = sig

  if (!hasPermission('canManageOperators')) {
    elements.configFilesList.innerHTML = `
      <article class="empty-card">
        <h3>Admin only</h3>
        <p>Log in as admin to view and edit config files.</p>
      </article>`
    return
  }

  if (!configRows.length) {
    elements.configFilesList.innerHTML = `
      <article class="empty-card">
        <h3>No config files found</h3>
        <p>Make sure DASHBOARD_CONFIG_DIR points to the _configs directory or wait for nodes to report their config.</p>
      </article>`
    return
  }

  elements.configFilesList.innerHTML = configRows.map((configFile) => {
    const nodes = configNodes[configFile.name] || []
    const nodeText = nodes.length ? ` | Nodes: ${nodes.join(', ')}` : ' | Nodes: not currently reported'
    const localActions = configFile.local ? `
      <button class="ghost-button small-button" type="button"
        data-action="download-config" data-permission-needed="canManageOperators"
        data-config-name="${escapeHtml(configFile.name)}">Download Local</button>
      <button class="ghost-button small-button" type="button"
        data-action="edit-config" data-permission-needed="canManageOperators"
        data-config-name="${escapeHtml(configFile.name)}">Edit</button>
    ` : '<span class="tag status-neutral">Node only</span>'
    const nodeActions = nodes.map((hostLabel) => `
      <button class="ghost-button small-button" type="button"
        data-action="download-node-config" data-permission-needed="canManageOperators"
        data-host-label="${escapeHtml(hostLabel)}"
        data-config-name="${escapeHtml(configFile.name)}"
        title="Download ${escapeHtml(configFile.name)} from ${escapeHtml(hostLabel)}">Download ${escapeHtml(hostLabel)}</button>
    `).join('')
    const modifiedText = configFile.local
      ? `${formatFileSize(configFile.sizeBytes)} | modified ${formatTime(configFile.modifiedAt)}`
      : 'reported by node heartbeat'
    return `
      <article class="file-item">
        <div class="file-row">
          <div>
            <strong>${escapeHtml(configFile.name)}</strong>
            <p class="file-meta">${escapeHtml(modifiedText)}${escapeHtml(nodeText)}</p>
          </div>
          <div class="file-actions">
            ${localActions}
            ${nodeActions}
          </div>
        </div>
      </article>`
  }).join('')
}

function buildConfigRows(configNodes) {
  const byName = new Map()
  for (const configFile of state.configs) {
    byName.set(configFile.name, { ...configFile, local: true })
  }
  for (const fileName of Object.keys(configNodes)) {
    if (!byName.has(fileName)) {
      byName.set(fileName, {
        name: fileName,
        sizeBytes: null,
        modifiedAt: null,
        local: false
      })
    }
  }
  return Array.from(byName.values())
    .sort((left, right) => String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base' }))
}

function buildConfigNodeMap() {
  const configNodes = {}
  for (const node of state.nodes) {
    const hostLabel = String(node.hostLabel || '').trim()
    if (!hostLabel) continue
    for (const fileName of Array.isArray(node.configFiles) ? node.configFiles : []) {
      const safeName = String(fileName || '').trim()
      if (!safeName) continue
      if (!configNodes[safeName]) configNodes[safeName] = []
      if (!configNodes[safeName].includes(hostLabel)) configNodes[safeName].push(hostLabel)
    }
  }
  for (const nodes of Object.values(configNodes)) {
    nodes.sort((left, right) => String(left).localeCompare(String(right), undefined, { sensitivity: 'base' }))
  }
  return configNodes
}

function renderDataFiles() {
  if (!elements.dataFilesList) return
  const sig = JSON.stringify({ canAdmin: hasPermission('canManageOperators'), dataFiles: state.dataFiles })
  if (state.renderCache.dataFiles === sig) return
  state.renderCache.dataFiles = sig

  if (!hasPermission('canManageOperators')) {
    elements.dataFilesList.innerHTML = `
      <article class="empty-card">
        <h3>Admin only</h3>
        <p>Log in as admin to view and delete dashboard data files.</p>
      </article>`
    return
  }

  if (!state.dataFiles.length) {
    elements.dataFilesList.innerHTML = `
      <article class="empty-card">
        <h3>No data files found</h3>
        <p>The dashboard data folder does not currently contain JSON files.</p>
      </article>`
    return
  }

  elements.dataFilesList.innerHTML = state.dataFiles.map((file) => {
    const protectedText = file.protected ? 'protected' : 'deletable'
    const action = file.deletable
      ? `<button class="danger-button small-button" type="button" data-action="delete-data-file" data-permission-needed="canManageOperators" data-file-name="${escapeHtml(file.name)}">Delete</button>`
      : '<span class="status-pill status-neutral">Protected</span>'
    return `
      <article class="file-item">
        <div class="file-row">
          <div>
            <strong>${escapeHtml(file.name)}</strong>
            <p class="file-meta">${escapeHtml(formatFileSize(file.sizeBytes))} | modified ${escapeHtml(formatTime(file.modifiedAt))} | ${escapeHtml(protectedText)}</p>
          </div>
          ${action}
        </div>
      </article>`
  }).join('')
}

function renderConfigEditor() {
  const { name, content } = state.configEditor
  if (!name) {
    elements.configEditorSection.classList.add('hidden')
    return
  }
  elements.configEditorSection.classList.remove('hidden')
  elements.configEditorTitle.textContent = `Editing: ${name}`
  if (elements.configEditorTextarea.value !== content) {
    elements.configEditorTextarea.value = content
  }
  if (elements.configEditorStatus) elements.configEditorStatus.textContent = ''
}

async function onEditConfig(name) {
  if (!hasPermission('canManageOperators')) return
  try {
    const result = await requestJson(`/api/dashboard/config/${encodeURIComponent(name)}`, { requireAuth: true })
    state.configEditor.name = result.name
    state.configEditor.content = result.content || ''
    state.configEditor.dirty = false
    renderConfigEditor()
    elements.configEditorTextarea?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  } catch (err) {
    pushEvent('error', `Failed to load ${name}: ${err.message}`)
  }
}

async function onSaveConfig() {
  if (!hasPermission('canManageOperators')) return
  const { name } = state.configEditor
  if (!name) return
  const content = elements.configEditorTextarea?.value || ''
  try {
    JSON.parse(content)
  } catch {
    if (elements.configEditorStatus) elements.configEditorStatus.textContent = 'Invalid JSON - not saved.'
    return
  }
  try {
    if (elements.configEditorSave) elements.configEditorSave.disabled = true
    await requestJson(`/api/dashboard/config/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
      requireAuth: true
    })
    state.configEditor.content = content
    if (elements.configEditorStatus) elements.configEditorStatus.textContent = `Saved. Restart bot to apply.`
    pushEvent('info', `Config ${name} saved.`)
  } catch (err) {
    if (elements.configEditorStatus) elements.configEditorStatus.textContent = `Save failed: ${err.message}`
    pushEvent('error', `Save config failed: ${err.message}`)
  } finally {
    if (elements.configEditorSave) elements.configEditorSave.disabled = false
  }
}

async function onClearData() {
  if (!hasPermission('canManageOperators')) {
    pushEvent('warn', 'Admin permission required.')
    return
  }
  const confirmed = confirm('Delete all JSON data files on the server? (operators.json is preserved, configs are NOT affected)')
  if (!confirmed) return
  try {
    const result = await submitJson('/api/dashboard/data/clear', {})
    pushEvent('warn', `Cleared data folder: deleted ${(result.deleted || []).length} file(s)`)
    await refreshData()
  } catch (err) {
    pushEvent('error', `Clear data failed: ${err.message}`)
  }
}

async function onResetEverything() {
  if (!isAdmin()) {
    pushEvent('warn', 'Admin role required.')
    return
  }
  const first = confirm('RESETEVERYTHING will clear dashboard queue/upload state, delete local and finished .nbt files on all reporting nodes, clear bot progress/queue state, and run platform cleanup on all known bots. Continue?')
  if (!first) return
  const typed = prompt('Type RESETEVERYTHING to confirm this fresh-start reset.')
  if (String(typed || '').trim().toUpperCase() !== 'RESETEVERYTHING') {
    pushEvent('info', 'Reset everything cancelled.')
    return
  }
  try {
    const result = await submitJson('/api/dashboard/reset-everything', { confirm: 'RESETEVERYTHING' })
    pushEvent('warn', `Reset everything queued: ${result.nodeCommandCount || 0} node cleanup command(s), ${result.botCommandCount || 0} bot platform cleanup command(s).`)
    await refreshData()
  } catch (err) {
    pushEvent('error', `Reset everything failed: ${err.message}`)
  }
}

async function onDeleteDataFile(fileName) {
  if (!hasPermission('canManageOperators')) {
    pushEvent('warn', 'Admin permission required.')
    return
  }
  const safeName = String(fileName || '').trim()
  if (!safeName) return
  const confirmed = confirm(`Delete data file ${safeName}? (operators.json is protected)`)
  if (!confirmed) return
  try {
    const result = await submitJson(`/api/dashboard/data/${encodeURIComponent(safeName)}/delete`, {})
    pushEvent('warn', `Deleted data file ${(result.deleted || [safeName])[0] || safeName}`)
    await refreshData()
  } catch (err) {
    pushEvent('error', `Delete data file failed: ${err.message}`)
  }
}

function renderEvents() {
  const eventsSignature = JSON.stringify({
    localEvents: state.localEvents,
    events: state.events
  })
  if (state.renderCache.events === eventsSignature) return
  state.renderCache.events = eventsSignature

  const items = [...state.localEvents, ...state.events]
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    .slice(0, 24)

  if (!items.length) {
    elements.eventLog.innerHTML = `
      <article class="empty-card">
        <h3>No activity yet</h3>
        <p>Operator actions and dashboard errors will appear here.</p>
      </article>
    `
    return
  }

  elements.eventLog.innerHTML = items.map((entry) => `
    <article class="log-row ${escapeHtml(entry.level)}">
      <div>
        <strong>${escapeHtml(entry.operator || 'unknown')} | ${escapeHtml(entry.message)}</strong>
        <div class="hint">${escapeHtml(entry.action || 'activity')}</div>
      </div>
      <span class="timestamp">${escapeHtml(formatTime(entry.createdAt))}</span>
    </article>
  `).join('')
}

async function onVerifyBot(botName, action) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before sending verification commands.')
    return
  }
  await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/verify`, { action })
  pushEvent('info', `Sent verification ${action} for ${botName}`)
  await refreshData()
}

async function refreshData(options = {}) {
  if (state.busy) return
  if (options.background === true && (state.uploadBusy || activeElementInsideForm() || hasRecentUserInteraction())) return
  if (options.background === true && state.bots.some((bot) => bot.tokenWaiting)) return

  state.busy = true
  try {
    const snapshot = await requestJson('/api/dashboard/snapshot', { requireAuth: state.auth.verified })
    const logs = state.auth.verified && hasPermission('canViewLogs')
      ? await requestJson('/api/dashboard/logs', { requireAuth: true })
      : { items: [] }
    const operators = state.auth.verified && hasPermission('canManageOperators')
      ? await requestJson('/api/dashboard/operators', { requireAuth: true })
      : { items: [] }
    const configs = state.auth.verified && hasPermission('canManageOperators')
      ? await requestJson('/api/dashboard/config', { requireAuth: true })
      : { files: [] }
    const dataFiles = state.auth.verified && hasPermission('canManageOperators')
      ? await requestJson('/api/dashboard/data', { requireAuth: true })
      : { files: [] }
    state.bots = Array.isArray(snapshot.bots) ? snapshot.bots : []
    state.nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
    state.logs = Array.isArray(logs.items) ? logs.items : []
    state.operators = Array.isArray(operators.items) ? operators.items : []
    state.configs = Array.isArray(configs.files) ? configs.files : []
    state.dataFiles = Array.isArray(dataFiles.files) ? dataFiles.files : []
    state.uploadAssignments = Array.isArray(snapshot.uploadAssignments) ? snapshot.uploadAssignments : []
    state.queueSummary = snapshot.queueSummary && typeof snapshot.queueSummary === 'object' ? snapshot.queueSummary : state.queueSummary
    state.events = Array.isArray(snapshot.events) ? snapshot.events : []
    state.alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts : []
    // Clear dismissed banners for bots that are no longer verifying
    for (const botName of [...state.dismissedVerify]) {
      if (!state.bots.some((b) => b.botName === botName && b.tokenWaiting)) {
        state.dismissedVerify.delete(botName)
      }
    }
    elements.serviceStatus.textContent = snapshot.ok ? 'Service online' : 'Service unknown'
    elements.serviceStatus.className = `status-pill ${snapshot.ok ? 'status-online' : 'status-neutral'}`
    elements.lastRefresh.textContent = formatTime(new Date().toISOString())
    renderAlerts()
    renderSummary()
    renderFleetJump()
    renderBots()
    renderFiles()
    renderFailedQueueRetries()
    renderUploadAssignments()
    renderQueueSummary()
    renderNodes()
    renderLogs()
    renderOperators()
    renderConfigs()
    renderDataFiles()
    renderAuthState()
  } catch (error) {
    elements.serviceStatus.textContent = 'Service offline'
    elements.serviceStatus.className = 'status-pill status-offline'
    if (elements.queueRemainingValue) elements.queueRemainingValue.textContent = '--'
    if (elements.queueCompletedValue) elements.queueCompletedValue.textContent = '--'
    if (elements.queueTotalValue) elements.queueTotalValue.textContent = '--'
    if (elements.queueRemainingMeta) elements.queueRemainingMeta.textContent = 'Service offline'
    pushEvent('error', error.message)
  } finally {
    state.busy = false
  }
}

async function submitJson(url, body) {
  return requestJson(url, {
    method: 'POST',
    body: JSON.stringify(body || {}),
    requireAuth: true
  })
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result || '')
      const parts = value.split(',')
      resolve(parts[1] || '')
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function setUploadProgress(percent, text = '') {
  const safePercent = Number.isFinite(Number(percent))
    ? Math.max(0, Math.min(100, Math.round(Number(percent))))
    : null
  if (elements.uploadProgress) {
    elements.uploadProgress.classList.remove('hidden')
    if (safePercent != null) {
      elements.uploadProgress.setAttribute('aria-valuenow', String(safePercent))
    }
  }
  if (elements.uploadProgressFill && safePercent != null) {
    elements.uploadProgressFill.style.width = `${safePercent}%`
  }
  if (elements.uploadProgressText) {
    elements.uploadProgressText.textContent = text || (safePercent == null ? 'Uploading...' : `${safePercent}% uploaded`)
  }
}

function resetUploadProgress() {
  if (elements.uploadProgress) {
    elements.uploadProgress.classList.add('hidden')
    elements.uploadProgress.setAttribute('aria-valuenow', '0')
  }
  if (elements.uploadProgressFill) {
    elements.uploadProgressFill.style.width = '0%'
  }
  if (elements.uploadProgressText) {
    elements.uploadProgressText.textContent = '0% uploaded'
  }
}

function uploadFormDataWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.withCredentials = true
    const authValue = authHeaderValue()
    if (authValue) xhr.setRequestHeader('authorization', authValue)

    xhr.upload.onprogress = (event) => {
      if (typeof onProgress !== 'function') return
      if (event.lengthComputable && event.total > 0) {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          percent: (event.loaded / event.total) * 100
        })
      } else {
        onProgress({
          loaded: event.loaded,
          total: 0,
          percent: null
        })
      }
    }

    xhr.onload = () => {
      let body = null
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body)
      } else {
        reject(new Error(body?.error || `Upload failed: ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed: network error'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    xhr.send(formData)
  })
}

async function onUpload(event) {
  event.preventDefault()
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before uploading files.')
    return
  }
  const files = Array.from(elements.fileInput.files || [])
  if (!files.length) return

  const distribute = elements.distributeCheckbox.checked
  const targetType = elements.uploadTargetType?.value === 'bot' ? 'bot' : 'node'

  state.uploadBusy = true

  try {
    resetUploadProgress()
    const form = new FormData()
    for (const file of files) form.append('files', file, file.name)
    form.append('maxAttempts', '3')

    let targetText = 'central queue'
    if (!distribute) {
      const selectedTarget = elements.uploadNodeSelect.value
      if (!selectedTarget) {
        pushEvent('warn', `Select a target ${targetType} before uploading, or enable the central queue option.`)
        return
      }
      if (targetType === 'bot') {
        form.append('targetBotName', selectedTarget)
        targetText = `bot ${selectedTarget}`
      } else {
        form.append('targetHostLabel', selectedTarget)
        targetText = `node ${selectedTarget}`
      }
    }

    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0)
    elements.uploadStatus.textContent = `Uploading ${files.length} file(s) to ${targetText}...`
    setUploadProgress(0, totalBytes > 0 ? `0% uploaded of ${formatFileSize(totalBytes)}` : 'Starting upload...')
    const result = await uploadFormDataWithProgress('/api/dashboard/uploads', form, ({ loaded, total, percent }) => {
      if (percent == null) {
        elements.uploadStatus.textContent = `Uploading ${formatFileSize(loaded)} to ${targetText}...`
        setUploadProgress(null, `Uploaded ${formatFileSize(loaded)}`)
        return
      }
      const rounded = Math.max(0, Math.min(100, Math.round(percent)))
      const sizeText = total > 0 ? ` of ${formatFileSize(total)}` : ''
      elements.uploadStatus.textContent = rounded >= 100
        ? 'Upload sent. Dashboard is importing and queueing files...'
        : `Uploading ${rounded}% to ${targetText}...`
      setUploadProgress(rounded, rounded >= 100
        ? '100% uploaded; processing on dashboard...'
        : `${rounded}% uploaded (${formatFileSize(loaded)}${sizeText})`)
    })

    const queued = Array.isArray(result.items) ? result.items.length : 0
    const errors = Array.isArray(result.errors) ? result.errors : []
    setUploadProgress(100, errors.length ? 'Upload completed with import warnings' : '100% uploaded and queued')
    elements.uploadStatus.textContent = errors.length
      ? `Queued ${queued} NBT file(s); ${errors.length} import error(s).`
      : `Queued ${queued} NBT file(s) for polling.`
    pushEvent(errors.length ? 'warn' : 'info', `Queued ${queued} NBT file(s)${errors.length ? ` with ${errors.length} import error(s)` : ''}.`)
    elements.uploadForm.reset()
    if (elements.uploadTargetType) elements.uploadTargetType.value = targetType
    elements.distributeCheckbox.checked = true
    elements.uploadTargetSelectLabel.style.display = 'none'
    elements.uploadNodeSelect.required = false
    state.renderCache.files = ''
    renderFiles()
    await refreshData()
  } catch (error) {
    setUploadProgress(null, 'Upload failed')
    elements.uploadStatus.textContent = `Upload failed: ${error.message}`
    throw error
  } finally {
    state.uploadBusy = false
  }
}


async function onSendChat(botName, message) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before sending chat.')
    return
  }
  const msg = String(message || '').trim()
  if (!msg) return
  await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/chat`, { message: msg })
  pushEvent('info', `[${botName}] chat sent: ${msg}`)
}

async function onDeleteNodeFile(hostLabel, fileName) {
  if (!hasPermission('canDeleteNodeFiles')) {
    pushEvent('warn', 'Login as an admin before deleting node files.')
    return
  }
  await submitJson(`/api/dashboard/nodes/${encodeURIComponent(hostLabel)}/files/${encodeURIComponent(fileName)}/delete`, {})
  pushEvent('warn', `Queued delete for ${fileName} on ${hostLabel}`)
  await refreshData()
}

async function onDeleteFinishedMap(hostLabel, fileName) {
  if (!hasPermission('canManageOperators')) {
    pushEvent('warn', 'Admin permission required before deleting finished maps.')
    return
  }
  await submitJson(`/api/dashboard/nodes/${encodeURIComponent(hostLabel)}/finished-maps/${encodeURIComponent(fileName)}/delete`, {})
  pushEvent('warn', `Queued finished map delete for ${fileName} on ${hostLabel}`)
  await refreshData()
}

async function onDeleteAllFinishedMaps() {
  if (!isAdmin()) {
    pushEvent('warn', 'Admin role required before deleting finished maps across all nodes.')
    return
  }
  const totalFinishedMaps = state.nodes.reduce((total, node) => {
    return total + (Array.isArray(node.finishedMapFiles) ? node.finishedMapFiles.length : 0)
  }, 0)
  if (!totalFinishedMaps) {
    pushEvent('info', 'No finished NBT files are currently reported by nodes.')
    return
  }
  const confirmed = confirm(`CLEANFINISHEDNBT: queue deletion for ${totalFinishedMaps} finished .nbt file(s) across all nodes?`)
  if (!confirmed) return
  const typed = prompt('Type CLEANFINISHEDNBT to confirm finished NBT cleanup.')
  if (String(typed || '').trim().toUpperCase() !== 'CLEANFINISHEDNBT') {
    pushEvent('info', 'CLEANFINISHEDNBT cancelled.')
    return
  }
  const result = await submitJson('/api/dashboard/nodes/finished-maps/delete-all', {})
  pushEvent('warn', `CLEANFINISHEDNBT queued ${result.count || 0} finished NBT delete command(s) across all nodes.`)
  await refreshData()
}

async function onReprintFinishedMap(hostLabel, fileName) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before reprinting finished maps.')
    return
  }
  const localId = `local-reprint-${Date.now()}-${Math.random().toString(16).slice(2)}`
  state.localReprintCommands.unshift({
    commandId: localId,
    hostLabel,
    fileName,
    status: 'sending',
    claimedByBotName: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    resultMessage: 'sending request to dashboard'
  })
  state.localReprintCommands = state.localReprintCommands.slice(0, 20)
  state.renderCache.nodes = ''
  renderNodes()
  try {
    const result = await submitJson(`/api/dashboard/nodes/${encodeURIComponent(hostLabel)}/finished-maps/${encodeURIComponent(fileName)}/reprint`, {})
    state.localReprintCommands = state.localReprintCommands.map((command) => command.commandId === localId
      ? {
          ...command,
          commandId: result.command?.commandId || localId,
          status: result.command?.status || 'pending',
          resultMessage: 'waiting for node bot to claim it'
        }
      : command)
    pushEvent('info', `Queued reprint for ${fileName} on ${hostLabel}`)
    state.renderCache.nodes = ''
    renderNodes()
    await refreshData()
  } catch (error) {
    state.localReprintCommands = state.localReprintCommands.map((command) => command.commandId === localId
      ? { ...command, status: 'failed', completedAt: new Date().toISOString(), resultMessage: error.message }
      : command)
    state.renderCache.nodes = ''
    renderNodes()
    throw error
  }
}

async function onQueueRelease(fileId) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before releasing queue files.')
    return
  }
  await submitJson(`/api/dashboard/queue/${encodeURIComponent(fileId)}/release`, { reason: 'dashboard-ui release' })
  pushEvent('warn', 'Released queue file back to pending')
  await refreshData()
}

async function onQueueRetry(fileId) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before retrying queue files.')
    return
  }
  await submitJson(`/api/dashboard/queue/${encodeURIComponent(fileId)}/retry`, { reason: 'dashboard-ui retry' })
  pushEvent('info', 'Queued file for retry')
  await refreshData()
}

async function onQueueRetryAll() {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before retrying queue files.')
    return
  }
  const result = await submitJson('/api/dashboard/queue/retry-failed-all', { reason: 'dashboard-ui retry all failed' })
  pushEvent('info', `Queued ${Number(result.count || 0)} failed file(s) for retry`)
  await refreshData()
}

async function onDeleteLog(fileName) {
  if (!hasPermission('canManageOperators')) {
    pushEvent('warn', 'Admin permission required before deleting log files.')
    return
  }
  await submitJson(`/api/dashboard/logs/${encodeURIComponent(fileName)}/delete`, {})
  pushEvent('warn', `Deleted log file ${fileName}`)
  await refreshData()
}

async function onDisconnectBot(botName) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before disconnecting bots.')
    return
  }
  await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/disconnect`, {})
  pushEvent('warn', `Queued disconnect for ${botName} (auto-reconnect suppressed)`)
  await refreshData()
}

async function onReconnectBot(botName) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before reconnecting bots.')
    return
  }
  await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/reconnect`, {})
  pushEvent('info', `Queued force-reconnect for ${botName}`)
  await refreshData()
}

async function onResetCurrentNbt(botName, currentNbt = '') {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before resetting current NBT.')
    return
  }
  const label = currentNbt ? `${botName} (${currentNbt})` : botName
  const confirmed = confirm(`Reset current NBT for ${label}? This will reset saved progress to target 0, reconnect the bot, reset the platform, then restart the same NBT.`)
  if (!confirmed) return
  await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/reset-current-nbt`, { reason: 'dashboard-ui reset current NBT' })
  pushEvent('warn', `Queued current NBT reset for ${botName}`)
  await refreshData()
}

async function onTpaBot(botName, tpaTarget) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before sending TPA commands.')
    return
  }
  const msg = `/tpa ${tpaTarget}`
  await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/chat`, { message: msg })
  pushEvent('info', `[${botName}] sent: ${msg}`)
}

async function onHomePlatformBot(botName) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before sending home commands.')
    return
  }
  const msg = '/home platform'
  await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/chat`, { message: msg })
  pushEvent('info', `[${botName}] sent: ${msg}`)
  await refreshData()
}

async function onHomePlatformNode(hostLabel) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before sending home commands.')
    return
  }
  const msg = '/home platform'
  await submitJson(`/api/dashboard/nodes/${encodeURIComponent(hostLabel)}/commands/chat`, { message: msg })
  pushEvent('info', `[${hostLabel}] sent ${msg} to node bots`)
  await refreshData()
}

async function onFleetAction(action, botName = null) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before running fleet actions.')
    return
  }
  if (action === 'start-all') {
    await submitJson('/api/dashboard/commands/start-all', {})
    pushEvent('info', 'Queued print start for all known bots')
  } else if (action === 'stop-all') {
    await submitJson('/api/dashboard/commands/stop-all', { reason: 'dashboard-ui pause all' })
    pushEvent('warn', 'Queued print pause for all known bots')
  } else if (action === 'start' && botName) {
    await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/start`, {})
    pushEvent('info', `Queued print start for ${botName}`)
  } else if (action === 'stop' && botName) {
    await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/stop`, { reason: 'dashboard-ui pause' })
    pushEvent('warn', `Queued print pause for ${botName}`)
  } else if (action === 'start-node' && botName) {
    await submitJson(`/api/dashboard/nodes/${encodeURIComponent(botName)}/commands/start`, {})
    pushEvent('info', `Queued print start for node ${botName}`)
  } else if (action === 'stop-node' && botName) {
    await submitJson(`/api/dashboard/nodes/${encodeURIComponent(botName)}/commands/stop`, { reason: 'dashboard-ui node pause' })
    pushEvent('warn', `Queued print pause for node ${botName}`)
  } else if (action === 'reset-node-current-nbt' && botName) {
    const confirmed = confirm(`Reset current NBT for all active bots on node ${botName}? This resets saved progress to target 0, reconnects each bot, resets the platform, then restarts the same NBT.`)
    if (!confirmed) return
    await submitJson(`/api/dashboard/nodes/${encodeURIComponent(botName)}/commands/reset-current-nbt`, { reason: 'dashboard-ui node reset current NBT' })
    pushEvent('warn', `Queued current NBT reset for node ${botName}`)
  }
  await refreshData()
}

async function onSaveOperator(event) {
  event.preventDefault()
  if (!hasPermission('canManageOperators')) {
    pushEvent('warn', 'Login as an admin before managing operators.')
    return
  }

  const username = elements.managedUsername.value.trim()
  const password = elements.managedPassword.value
  const role = elements.managedRole.value
  if (!username) {
    pushEvent('warn', 'Operator username is required')
    return
  }

  const permissions = {
    canViewLogs: elements.permViewLogs.checked,
    canOperate: elements.permOperate.checked,
    canDeleteNodeFiles: elements.permDeleteNodeFiles.checked,
    canManageOperators: elements.permManageOperators.checked
  }

  const payload = { username, role, permissions }
  if (password) payload.password = password

  const result = await submitJson('/api/dashboard/operators', payload)
  elements.operatorStatus.textContent = `Saved operator ${result.item?.username || username}`
  if (String(username).toLowerCase() === String(state.auth.operator || '').toLowerCase()) {
    if (password) state.auth.password = password
    await verifyOperatorAuth()
  }
  elements.operatorForm.reset()
  elements.managedRole.value = 'viewer'
  setManagedOperatorDefaults('viewer')
  pushEvent('info', `Saved operator ${result.item?.username || username}`)
  await refreshData()
}

async function onDeleteOperator(username) {
  if (!hasPermission('canManageOperators')) {
    pushEvent('warn', 'Login as an admin before managing operators.')
    return
  }
  await submitJson(`/api/dashboard/operators/${encodeURIComponent(username)}/delete`, {})
  pushEvent('warn', `Deleted operator ${username}`)
  await refreshData()
}

document.addEventListener('click', async (event) => {
  markUserInteraction()
  const button = event.target.closest('button[data-action]')
  if (!button) return
  const requiredPermission = button.dataset.permissionNeeded || ''
  if (requiredPermission && !hasPermission(requiredPermission)) {
    pushEvent('warn', 'Login with approved access before using this dashboard action.')
    return
  }
  if (button.dataset.action === 'jump-node') {
    const target = document.getElementById(button.dataset.nodeTarget || '')
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  try {
    button.disabled = true
    if (button.dataset.action === 'delete-node-file') {
      await onDeleteNodeFile(button.dataset.hostLabel || '', button.dataset.fileName || '')
    } else if (button.dataset.action === 'delete-finished-map') {
      await onDeleteFinishedMap(button.dataset.hostLabel || '', button.dataset.fileName || '')
    } else if (button.dataset.action === 'delete-all-finished-maps') {
      await onDeleteAllFinishedMaps()
    } else if (button.dataset.action === 'reset-everything') {
      await onResetEverything()
    } else if (button.dataset.action === 'reprint-finished-map') {
      await onReprintFinishedMap(button.dataset.hostLabel || '', button.dataset.fileName || '')
    } else if (button.dataset.action === 'queue-release') {
      await onQueueRelease(button.dataset.fileId || '')
    } else if (button.dataset.action === 'queue-retry') {
      await onQueueRetry(button.dataset.fileId || '')
    } else if (button.dataset.action === 'queue-retry-all') {
      await onQueueRetryAll()
    } else if (button.dataset.action === 'download-node-log') {
      await downloadNodeLogFile(button.dataset.hostLabel || '', button.dataset.fileName || '')
      pushEvent('info', `Downloaded ${button.dataset.fileName || ''} from ${button.dataset.hostLabel || 'node'}`)
    } else if (button.dataset.action === 'delete-operator') {
      await onDeleteOperator(button.dataset.username || '')
    } else if (button.dataset.action === 'delete-data-file') {
      await onDeleteDataFile(button.dataset.fileName || '')
    } else if (button.dataset.action === 'download-log') {
      await downloadLogFile(button.dataset.fileName || '')
      pushEvent('info', `Downloaded log ${button.dataset.fileName || ''}`)
    } else if (button.dataset.action === 'delete-log') {
      await onDeleteLog(button.dataset.fileName || '')
    } else if (button.dataset.action === 'download-config') {
      await downloadConfigFile(button.dataset.configName || '')
      pushEvent('info', `Downloaded config ${button.dataset.configName || ''}`)
    } else if (button.dataset.action === 'download-node-config') {
      await downloadNodeConfigFile(button.dataset.hostLabel || '', button.dataset.configName || '')
      pushEvent('info', `Downloaded config ${button.dataset.configName || ''} from ${button.dataset.hostLabel || 'node'}`)
    } else if (button.dataset.action === 'reset-node-current-nbt') {
      await onFleetAction('reset-node-current-nbt', button.dataset.hostLabel || '')
    } else if (button.dataset.action === 'verify-done') {
      await onVerifyBot(button.dataset.botName || '', 'verified')
    } else if (button.dataset.action === 'verify-refresh') {
      await onVerifyBot(button.dataset.botName || '', 'refresh')
    } else if (button.dataset.action === 'verify-close') {
      state.dismissedVerify.add(button.dataset.botName || '')
      state.renderCache.bots = ''
      renderBots()
    } else if (button.dataset.action === 'disconnect-bot') {
      await onDisconnectBot(button.dataset.botName || '')
    } else if (button.dataset.action === 'reconnect-bot') {
      await onReconnectBot(button.dataset.botName || '')
    } else if (button.dataset.action === 'home-platform-bot') {
      await onHomePlatformBot(button.dataset.botName || '')
    } else if (button.dataset.action === 'home-platform-node') {
      await onHomePlatformNode(button.dataset.hostLabel || '')
    } else if (button.dataset.action === 'reset-current-nbt') {
      await onResetCurrentNbt(button.dataset.botName || '', button.dataset.currentNbt || '')
    } else if (button.dataset.action === 'edit-config') {
      await onEditConfig(button.dataset.configName || '')
    } else if (button.dataset.action === 'edit-node-config') {
      if (button.dataset.configName) {
        await onEditConfig(button.dataset.configName)
      } else {
        elements.configFilesList?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    } else if (button.dataset.action === 'chat-send') {
      const botName = button.dataset.botName || ''
      const input = document.querySelector(`.chat-input[data-chat-bot="${CSS.escape(botName)}"]`)
      const msg = input ? input.value.trim() : ''
      if (msg) {
        await onSendChat(botName, msg)
        if (input) input.value = ''
      }
    } else {
      await onFleetAction(button.dataset.action, button.dataset.botName || button.dataset.hostLabel || null)
    }
  } catch (error) {
    pushEvent('error', error.message)
  } finally {
    button.disabled = false
  }
})

document.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return
  const input = event.target.closest('.chat-input')
  if (!input) return
  const botName = input.dataset.chatBot || ''
  const msg = input.value.trim()
  if (!msg) return
  try {
    input.disabled = true
    await onSendChat(botName, msg)
    input.value = ''
  } catch (error) {
    pushEvent('error', error.message)
  } finally {
    input.disabled = false
    input.focus()
  }
})

for (const eventName of ['focusin', 'input', 'keydown', 'pointerdown']) {
  document.addEventListener(eventName, () => {
    markUserInteraction()
  }, { passive: true })
}

elements.refreshButton.addEventListener('click', () => {
  void refreshData()
})

if (elements.backToTopButton) {
  elements.backToTopButton.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })
  window.addEventListener('scroll', updateBackToTopVisibility, { passive: true })
  updateBackToTopVisibility()
}

elements.loginButton.addEventListener('click', async () => {
  state.auth.operator = elements.operatorUsername.value.trim()
  state.auth.password = elements.operatorPassword.value
  try {
    const result = await requestJson('/api/dashboard/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: state.auth.operator,
        password: state.auth.password
      })
    })
    applyAuthResult(result)
    pushEvent('info', `Operator authenticated as ${state.auth.operator}`)
    await refreshData()
  } catch (error) {
    pushEvent('error', error.message || 'Operator authentication failed')
  }
})

elements.logoutButton.addEventListener('click', async () => {
  const previous = state.auth.operator || 'operator'
  try {
    await requestJson('/api/dashboard/auth/logout', { method: 'POST', body: JSON.stringify({}) })
  } catch {
    // Local logout still clears browser state if the service is not reachable.
  }
  clearAuth()
  pushEvent('info', `Logged out ${previous}`)
  await refreshData()
})

elements.startAllButton.addEventListener('click', async () => {
  try {
    elements.startAllButton.disabled = true
    await onFleetAction('start-all')
  } catch (error) {
    pushEvent('error', error.message)
  } finally {
    elements.startAllButton.disabled = false
  }
})

elements.stopAllButton.addEventListener('click', async () => {
  try {
    elements.stopAllButton.disabled = true
    await onFleetAction('stop-all')
  } catch (error) {
    pushEvent('error', error.message)
  } finally {
    elements.stopAllButton.disabled = false
  }
})

elements.uploadForm.addEventListener('submit', (event) => {
  void onUpload(event).catch((error) => pushEvent('error', error.message))
})

elements.distributeCheckbox.addEventListener('change', () => {
  const distribute = elements.distributeCheckbox.checked
  elements.uploadTargetSelectLabel.style.display = distribute ? 'none' : ''
  elements.uploadNodeSelect.required = !distribute
})

if (elements.uploadTargetType) {
  elements.uploadTargetType.addEventListener('change', () => {
    state.renderCache.files = ''
    renderFiles()
  })
}

if (elements.nbtSearchInput) {
  elements.nbtSearchInput.addEventListener('input', () => {
    state.nbtSearch = elements.nbtSearchInput.value
    state.renderCache.nodes = ''
    renderNodes()
  })
}

elements.operatorForm.addEventListener('submit', (event) => {
  void onSaveOperator(event).catch((error) => pushEvent('error', error.message))
})

elements.managedRole.addEventListener('change', () => {
  setManagedOperatorDefaults(elements.managedRole.value)
})

if (elements.clearDataButton) {
  elements.clearDataButton.addEventListener('click', async () => {
    try {
      elements.clearDataButton.disabled = true
      await onClearData()
    } catch (error) {
      pushEvent('error', error.message)
    } finally {
      elements.clearDataButton.disabled = false
    }
  })
}

if (elements.configEditorClose) {
  elements.configEditorClose.addEventListener('click', () => {
    state.configEditor.name = null
    state.configEditor.content = ''
    renderConfigEditor()
  })
}

if (elements.configEditorSave) {
  elements.configEditorSave.addEventListener('click', async () => {
    try {
      await onSaveConfig()
    } catch (error) {
      pushEvent('error', error.message)
      if (elements.configEditorStatus) elements.configEditorStatus.textContent = `Error: ${error.message}`
    }
  })
}

renderEvents()
loadStoredAuth()
loadStoredRefreshInterval()
setManagedOperatorDefaults(elements.managedRole.value)
renderAuthState()
applyRefreshInterval()
state.pauseDurationTimer = window.setInterval(() => updatePauseDurationText(), 1000)
void verifyOperatorAuth()
void refreshData()

elements.refreshInterval.addEventListener('change', () => {
  state.refreshIntervalMs = normalizeRefreshInterval(elements.refreshInterval.value)
  persistRefreshInterval()
  applyRefreshInterval()
  pushEvent('info', `Auto refresh set to ${formatRefreshInterval(state.refreshIntervalMs)}`)
})
