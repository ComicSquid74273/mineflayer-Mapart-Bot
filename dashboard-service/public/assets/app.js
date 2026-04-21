const state = {
  bots: [],
  nodes: [],
  files: [],
  logs: [],
  operators: [],
  configs: [],
  configEditor: { name: null, content: '', dirty: false },
  refreshTimer: null,
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
    events: '',
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
const ALLOWED_REFRESH_INTERVALS = [60000, 300000, 600000]
const UI_ACTIVITY_HOLD_MS = 15000

const elements = {
  assignForm: document.getElementById('assignForm'),
  authStatus: document.getElementById('authStatus'),
  nodeSelect: document.getElementById('nodeSelect'),
  botsGrid: document.getElementById('botsGrid'),
  botSummary: document.getElementById('botSummary'),
  eventLog: document.getElementById('eventLog'),
  fileInput: document.getElementById('fileInput'),
  fileSelect: document.getElementById('fileSelect'),
  filesList: document.getElementById('filesList'),
  lastRefresh: document.getElementById('lastRefresh'),
  logsList: document.getElementById('logsList'),
  nodesGrid: document.getElementById('nodesGrid'),
  notesInput: document.getElementById('notesInput'),
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
  serviceStatus: document.getElementById('serviceStatus'),
  startAllButton: document.getElementById('startAllButton'),
  stopAllButton: document.getElementById('stopAllButton'),
  uploadNodeSelect: document.getElementById('uploadNodeSelect'),
  uploadForm: document.getElementById('uploadForm'),
  uploadedByInput: document.getElementById('uploadedByInput'),
  uploadStatus: document.getElementById('uploadStatus'),
  clearDataButton: document.getElementById('clearDataButton'),
  configFilesList: document.getElementById('configFilesList'),
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

function hasPermission(permissionName) {
  return Boolean(state.auth.permissions?.[permissionName])
}

function escapeHtml(value) {
  return String(value || '')
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

function phaseClass(phase) {
  return `phase-${String(phase || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function botHealthClass(bot) {
  if (!bot.online || bot.phase === 'crashed' || bot.phase === 'stopped') return 'health-red'
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
    operator: state.auth.operator,
    password: state.auth.password
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
  if (elements.assignForm) {
    const submit = elements.assignForm.querySelector('button[type="submit"]')
    if (submit) submit.disabled = !canOperate
  }
  if (elements.uploadForm) {
    const submit = elements.uploadForm.querySelector('button[type="submit"]')
    if (submit) submit.disabled = !canOperate
  }
  for (const element of [elements.fileInput, elements.uploadedByInput, elements.notesInput, elements.fileSelect, elements.nodeSelect]) {
    if (element) element.disabled = !canOperate
  }
  if (elements.uploadNodeSelect) elements.uploadNodeSelect.disabled = !canOperate
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

async function verifyOperatorAuth() {
  if (!state.auth.operator || !state.auth.password) {
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
  try {
    const result = await requestJson('/api/dashboard/auth/me', { requireAuth: true })
    state.auth.verified = result.ok === true
    state.auth.role = String(result.role || 'viewer')
    state.auth.permissions = result.permissions || {
      canViewLogs: false,
      canOperate: false,
      canDeleteNodeFiles: false,
      canManageOperators: false,
      canAdmin: false
    }
    persistAuth()
    renderAuthState()
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

function activeElementInsideForm() {
  const active = document.activeElement
  return Boolean(active && (
    elements.assignForm.contains(active)
    || elements.uploadForm.contains(active)
    || elements.operatorForm.contains(active)
  ))
}

function captureFormState() {
  return {
    fileId: elements.fileSelect.value,
    node: elements.nodeSelect.value,
    uploadNode: elements.uploadNodeSelect.value,
    uploadedBy: elements.uploadedByInput.value,
    notes: elements.notesInput.value
  }
}

function restoreFormState(snapshot) {
  if (!snapshot) return
  elements.uploadedByInput.value = snapshot.uploadedBy || elements.uploadedByInput.value
  elements.notesInput.value = snapshot.notes || elements.notesInput.value

  if (snapshot.fileId && Array.from(elements.fileSelect.options).some((option) => option.value === snapshot.fileId)) {
    elements.fileSelect.value = snapshot.fileId
  }
  if (snapshot.node && Array.from(elements.nodeSelect.options).some((option) => option.value === snapshot.node)) {
    elements.nodeSelect.value = snapshot.node
  }
  if (snapshot.uploadNode && Array.from(elements.uploadNodeSelect.options).some((option) => option.value === snapshot.uploadNode)) {
    elements.uploadNodeSelect.value = snapshot.uploadNode
  }
}

function renderSummary() {
  const summarySignature = JSON.stringify({
    botCount: state.bots.length,
    nodeCount: state.nodes.length,
    online: state.bots.filter((item) => item.online).length,
    printing: state.bots.filter((item) => item.phase === 'printing').length,
    stale: state.bots.filter((item) => item.activeState === 'stale').length,
    idle: state.bots.filter((item) => item.idle).length
  })
  if (state.renderCache.summary === summarySignature) return
  state.renderCache.summary = summarySignature

  const online = state.bots.filter((item) => item.online).length
  const printing = state.bots.filter((item) => item.phase === 'printing').length
  const stale = state.bots.filter((item) => item.activeState === 'stale').length
  const idle = state.bots.filter((item) => item.idle).length
  const nodeCount = state.nodes.length

  elements.botSummary.innerHTML = [
    ['Known Nodes', nodeCount],
    ['Known Bots', state.bots.length],
    ['Online', online],
    ['Printing', printing],
    ['Idle', idle],
    ['Stale', stale]
  ].map(([label, value]) => `
    <article class="summary-card">
      <span class="hint">${escapeHtml(label)}</span>
      <span class="summary-value">${escapeHtml(value)}</span>
    </article>
  `).join('')
}

function renderNodeTimingMetrics(node) {
  const timing = node.timing || {}
  const activeRun = timing.activeRun || null
  return `
    <div class="node-timing-strip">
      <div class="metric metric-compact">
        Avg Map Time<strong>${escapeHtml(formatDuration(timing.averageDurationMs))}</strong>
      </div>
      <div class="metric metric-compact">
        Completed<strong>${escapeHtml(timing.totalCompletedMaps ?? 0)}</strong>
      </div>
      <div class="metric metric-compact">
        Current Run<strong>${escapeHtml(activeRun ? formatDuration(activeRun.elapsedMs) : 'idle')}</strong>
      </div>
      <div class="metric metric-compact">
        Active Map<strong>${escapeHtml(activeRun?.fileName || timing.lastCompletedFileName || 'none')}</strong>
      </div>
    </div>
  `
}

function renderBotCard(bot) {
  const progress = bot.progress && Number.isFinite(Number(bot.progress.percent))
    ? `${bot.progress.percent}%`
    : 'n/a'
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
          <span class="verify-field">Code: <strong class="verify-code">${escapeHtml(bot.verificationCode || 'loading…')}</strong></span>
          <span class="verify-field">IP: <strong>${escapeHtml(bot.botIp || 'unknown')}</strong></span>
        </div>
      </div>
      <div class="verify-actions">
        <button class="accent-button small-button" type="button" data-action="verify-done" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}">✓ Verified</button>
        <button class="ghost-button small-button" type="button" data-action="verify-refresh" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}">↺ Resend</button>
        <button class="ghost-button small-button" type="button" data-action="verify-close" data-bot-name="${escapeHtml(bot.botName)}" title="Dismiss banner">✕</button>
      </div>
    </div>
  ` : ''
  const healthClass = botHealthClass(bot)
  const pingText = typeof bot.latencyMs === 'number' ? `${bot.latencyMs}ms` : 'n/a'
  const canOperate = hasPermission('canOperate')
  return `
    <article class="bot-card${showVerify ? ' bot-card-verify' : ''}">
      ${verifyBanner}
      <div class="bot-head">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="health-dot ${escapeHtml(healthClass)}" title="${escapeHtml(healthClass === 'health-green' ? 'Healthy' : healthClass === 'health-yellow' ? 'Warning' : 'Issue')}"></span>
          <div>
            <h3 class="bot-name">${escapeHtml(bot.botName)}</h3>
            <p class="bot-meta">${escapeHtml(bot.role || 'single')} · ${escapeHtml(bot.location || 'unknown')}${bot.botIp && !showVerify ? ` · ${escapeHtml(bot.botIp)}` : ''}</p>
          </div>
        </div>
        <div class="status-inline">
          <span class="status-pill ${bot.online ? 'status-online' : 'status-offline'}">${bot.online ? 'Online' : 'Offline'}</span>
          <span class="phase-pill ${phaseClass(bot.phase)}">${escapeHtml(bot.phase || 'unknown')}</span>
        </div>
      </div>
      <div class="bot-metrics">
        <div class="metric">Health<strong>${escapeHtml(bot.health ?? 'n/a')}</strong></div>
        <div class="metric">Hunger<strong>${escapeHtml(bot.hunger ?? 'n/a')}</strong></div>
        <div class="metric">Activity<strong>${escapeHtml(bot.activeState || 'n/a')}</strong></div>
        <div class="metric">Progress<strong>${escapeHtml(progress)}</strong></div>
        <div class="metric">Ping<strong>${escapeHtml(pingText)}</strong></div>
      </div>
      <div class="bot-metrics">
        <div class="metric">NBT<strong>${escapeHtml(bot.currentNbt || 'none')}</strong></div>
        <div class="metric">Current Run<strong>${escapeHtml(currentRunElapsed)}</strong></div>
        <div class="metric">Recovery<strong>${escapeHtml(bot.recoveryState || 'none')}</strong></div>
        <div class="metric">Reconnect<strong>${escapeHtml(bot.reconnectState || 'idle')}</strong></div>
      </div>
      ${bot.lastError ? `<p class="hint">Last error: ${escapeHtml(bot.lastError)}</p>` : ''}
      <div class="bot-actions">
        <button class="accent-button" type="button" data-action="start" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}">Start Print</button>
        <button class="danger-button" type="button" data-action="stop" data-permission-needed="canOperate" data-bot-name="${escapeHtml(bot.botName)}">Stop Print</button>
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
          <input class="chat-input" type="text" placeholder="Send chat message…" maxlength="256"
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

  const renderedNodes = state.nodes.map((node) => {
    const nodeBots = (botsByNode.get(node.hostLabel) || []).sort((left, right) => String(left.botName).localeCompare(String(right.botName)))
    return `
      <article class="fleet-node-group">
        <div class="fleet-node-head">
          <div>
            <h3 class="bot-name">${escapeHtml(node.hostLabel)}</h3>
            <p class="bot-meta">${escapeHtml((node.botNames || []).join(', ') || 'no bots')} · Online ${escapeHtml(node.onlineCount)}/${escapeHtml(node.botCount)} · Last update ${escapeHtml(formatTime(node.lastStatusAt))}</p>
          </div>
          <div class="fleet-node-controls">
            <span class="tag ${node.onlineCount > 0 ? 'status-online' : 'status-offline'}">${node.onlineCount > 0 ? 'reachable' : 'offline'}</span>
            <button class="accent-button small-button" type="button" data-action="start-node" data-permission-needed="canOperate" data-host-label="${escapeHtml(node.hostLabel)}">Start Node</button>
            <button class="danger-button small-button" type="button" data-action="stop-node" data-permission-needed="canOperate" data-host-label="${escapeHtml(node.hostLabel)}">Stop Node</button>
          </div>
        </div>
        ${renderNodeTimingMetrics(node)}
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

  const orphanBots = state.bots.filter((bot) => !state.nodes.some((node) => node.hostLabel === bot.hostLabel))
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
  const filesSignature = JSON.stringify({ files: state.files, nodes: state.nodes })
  if (state.renderCache.files === filesSignature) return
  state.renderCache.files = filesSignature

  const snapshot = captureFormState()
  const fileOptions = ['<option value="">Select uploaded file</option>']
  const nodeOptions = ['<option value="">Select node</option>']

  state.files.forEach((item) => {
    const duplicateLabel = Number(item.nameConflictCount || 0) > 0 ? ` · dup ${Number(item.nameConflictCount) + 1}` : ''
    fileOptions.push(`<option value="${escapeHtml(item.fileId)}">${escapeHtml(item.originalName)} · ${escapeHtml(item.deliveryStatus)}${escapeHtml(duplicateLabel)}</option>`)
  })
  state.nodes.forEach((item) => {
    nodeOptions.push(`<option value="${escapeHtml(item.hostLabel)}">${escapeHtml(item.hostLabel)} (${escapeHtml(item.onlineCount)}/${escapeHtml(item.botCount)} online)</option>`)
  })

  elements.fileSelect.innerHTML = fileOptions.join('')
  elements.nodeSelect.innerHTML = nodeOptions.join('')
  elements.uploadNodeSelect.innerHTML = nodeOptions.join('')
  restoreFormState(snapshot)

  if (!state.files.length) {
    elements.filesList.innerHTML = `
      <article class="empty-card">
        <h3>No uploaded files</h3>
        <p>Upload one or more NBT files directly to a node. Existing uploads can still be reassigned here.</p>
      </article>
    `
    return
  }

  elements.filesList.innerHTML = state.files.map((item) => `
    <article class="file-item">
      <div class="file-row">
        <div>
          <strong>${escapeHtml(item.originalName)}</strong>
          <p class="file-meta">${escapeHtml(item.sizeBytes)} bytes · ${escapeHtml(item.sha256.slice(0, 12))}...</p>
        </div>
        <span class="tag ${item.deliveryStatus === 'failed' ? 'status-offline' : 'status-neutral'}">${escapeHtml(item.deliveryStatus)}</span>
      </div>
      <p class="hint">Assigned node: ${escapeHtml(item.assignedHostLabel || 'nobody')} · Uploaded: ${escapeHtml(formatTime(item.uploadedAt))}</p>
      ${Number(item.nameConflictCount || 0) > 0 ? `<p class="hint">Duplicate upload name detected. Existing copies: ${escapeHtml(item.nameConflictCount)}</p>` : ''}
      ${item.failedReason ? `<p class="hint">Failure: ${escapeHtml(item.failedReason)}</p>` : ''}
    </article>
  `).join('')
}

function renderNodes() {
  const nodesSignature = JSON.stringify(state.nodes)
  if (state.renderCache.nodes === nodesSignature) return
  state.renderCache.nodes = nodesSignature

  if (!state.nodes.length) {
    elements.nodesGrid.innerHTML = `
      <article class="empty-card">
        <h3>No node inventory yet</h3>
        <p>Once a node reports its shared NBT folder, the files will appear here.</p>
      </article>
    `
    return
  }

  elements.nodesGrid.innerHTML = state.nodes.map((node) => {
    const files = Array.isArray(node.nodeFiles) ? node.nodeFiles : []
    return `
      <article class="node-card">
        <div class="file-row">
          <div>
            <strong>${escapeHtml(node.hostLabel)}</strong>
            <p class="file-meta">Bots: ${escapeHtml((node.botNames || []).join(', ') || 'none')} · Online ${escapeHtml(node.onlineCount)}/${escapeHtml(node.botCount)}</p>
          </div>
          <span class="tag ${node.onlineCount > 0 ? 'status-online' : 'status-offline'}">${node.onlineCount > 0 ? 'reachable' : 'offline'}</span>
        </div>
        ${renderNodeTimingMetrics(node)}
        ${files.length ? files.map((file) => `
          <article class="file-item compact-file-item">
            <div class="file-row">
              <div>
                <strong>${escapeHtml(file.fileName)}</strong>
                <p class="file-meta">${escapeHtml(file.sizeBytes)} bytes · ${escapeHtml(formatTime(file.modifiedAt))}</p>
              </div>
              <button class="danger-button small-button" type="button" data-action="delete-node-file" data-permission-needed="canDeleteNodeFiles" data-host-label="${escapeHtml(node.hostLabel)}" data-file-name="${escapeHtml(file.fileName)}">Delete</button>
            </div>
          </article>
        `).join('') : '<p class="hint">No .nbt files reported on this node.</p>'}
      </article>
    `
  }).join('')
}

function renderLogs() {
  const logsSignature = JSON.stringify({
    verified: state.auth.verified,
    canViewLogs: hasPermission('canViewLogs'),
    logs: state.logs
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

  if (!state.logs.length) {
    elements.logsList.innerHTML = `
      <article class="empty-card">
        <h3>No logs found</h3>
        <p>No downloadable .log files are currently available on the dashboard host.</p>
      </article>
    `
    return
  }

  elements.logsList.innerHTML = state.logs.map((item) => `
    <article class="file-item">
      <div class="file-row">
        <div>
          <strong>${escapeHtml(item.fileName)}</strong>
          <p class="file-meta">${escapeHtml(formatFileSize(item.sizeBytes))} · ${escapeHtml(formatTime(item.modifiedAt))}</p>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <button class="ghost-button small-button" type="button" data-action="download-log" data-permission-needed="canViewLogs" data-file-name="${escapeHtml(item.fileName)}">Download</button>
          <button class="danger-button small-button" type="button" data-action="delete-log" data-permission-needed="canOperate" data-file-name="${escapeHtml(item.fileName)}">Delete</button>
        </div>
      </div>
    </article>
  `).join('')
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
            <p class="file-meta">role=${escapeHtml(item.role)} · created ${escapeHtml(formatTime(item.createdAt))} · updated ${escapeHtml(formatTime(item.updatedAt))}</p>
          </div>
          <button class="danger-button small-button" type="button" data-action="delete-operator" data-permission-needed="canManageOperators" data-username="${escapeHtml(item.username)}">Delete</button>
        </div>
        <p class="hint">Logs: ${permissions.canViewLogs ? 'yes' : 'no'} · Operate: ${permissions.canOperate ? 'yes' : 'no'} · Delete node files: ${permissions.canDeleteNodeFiles ? 'yes' : 'no'} · Manage operators: ${permissions.canManageOperators ? 'yes' : 'no'}</p>
      </article>
    `
  }).join('')
}

function renderConfigs() {
  const sig = JSON.stringify({ canAdmin: hasPermission('canManageOperators'), configs: state.configs })
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

  if (!state.configs.length) {
    elements.configFilesList.innerHTML = `
      <article class="empty-card">
        <h3>No config files found</h3>
        <p>Set DASHBOARD_CONFIG_DIR on the server to point to your config directory.</p>
      </article>`
    return
  }

  elements.configFilesList.innerHTML = state.configs.map((f) => `
    <article class="file-item">
      <div class="file-row">
        <div>
          <strong>${escapeHtml(f.name)}</strong>
          <p class="file-meta">${formatFileSize(f.sizeBytes)} · modified ${escapeHtml(formatTime(f.modifiedAt))}</p>
        </div>
        <button class="ghost-button small-button" type="button"
          data-action="edit-config" data-permission-needed="canManageOperators"
          data-config-name="${escapeHtml(f.name)}">Edit</button>
      </div>
    </article>`).join('')
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
    if (elements.configEditorStatus) elements.configEditorStatus.textContent = 'Invalid JSON — not saved.'
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
        <strong>${escapeHtml(entry.operator || 'unknown')} · ${escapeHtml(entry.message)}</strong>
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
    const [health, bots, nodes, files, events] = await Promise.all([
      requestJson('/health'),
      requestJson('/api/dashboard/bots'),
      requestJson('/api/dashboard/nodes'),
      requestJson('/api/dashboard/files'),
      requestJson('/api/dashboard/events')
    ])
    const logs = state.auth.verified && hasPermission('canViewLogs')
      ? await requestJson('/api/dashboard/logs', { requireAuth: true })
      : { items: [] }
    const operators = state.auth.verified && hasPermission('canManageOperators')
      ? await requestJson('/api/dashboard/operators', { requireAuth: true })
      : { items: [] }
    const configs = state.auth.verified && hasPermission('canManageOperators')
      ? await requestJson('/api/dashboard/config', { requireAuth: true })
      : { files: [] }
    state.bots = Array.isArray(bots.items) ? bots.items : []
    state.nodes = Array.isArray(nodes.items) ? nodes.items : []
    state.files = Array.isArray(files.items) ? files.items : []
    state.logs = Array.isArray(logs.items) ? logs.items : []
    state.operators = Array.isArray(operators.items) ? operators.items : []
    state.configs = Array.isArray(configs.files) ? configs.files : []
    state.events = Array.isArray(events.items) ? events.items : []
    // Clear dismissed banners for bots that are no longer verifying
    for (const botName of [...state.dismissedVerify]) {
      if (!state.bots.some((b) => b.botName === botName && b.tokenWaiting)) {
        state.dismissedVerify.delete(botName)
      }
    }
    elements.serviceStatus.textContent = health.ok ? 'Service online' : 'Service unknown'
    elements.serviceStatus.className = `status-pill ${health.ok ? 'status-online' : 'status-neutral'}`
    elements.lastRefresh.textContent = formatTime(new Date().toISOString())
    renderSummary()
    renderBots()
    renderFiles()
    renderNodes()
    renderLogs()
    renderOperators()
    renderConfigs()
    renderAuthState()
  } catch (error) {
    elements.serviceStatus.textContent = 'Service offline'
    elements.serviceStatus.className = 'status-pill status-offline'
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

async function onUpload(event) {
  event.preventDefault()
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before uploading files.')
    return
  }
  const files = Array.from(elements.fileInput.files || [])
  const targetHostLabel = elements.uploadNodeSelect.value
  if (!files.length) return
  if (!targetHostLabel) {
    pushEvent('warn', 'Select a target node before uploading files.')
    return
  }

  state.uploadBusy = true
  const uploadedBy = elements.uploadedByInput.value.trim()
  const notes = elements.notesInput.value.trim()
  let completed = 0
  let failed = 0

  try {
    for (const file of files) {
      elements.uploadStatus.textContent = `Uploading ${completed + failed + 1}/${files.length}: ${file.name}`
      try {
        const base64 = await fileToBase64(file)
        await submitJson('/api/dashboard/files', {
          originalName: file.name,
          contentBase64: base64,
          targetHostLabel,
          uploadedBy,
          notes
        })
        completed += 1
      } catch (error) {
        failed += 1
        pushEvent('error', `Upload failed for ${file.name}: ${error.message}`)
      }
    }

    elements.uploadStatus.textContent = failed > 0
      ? `Upload finished: ${completed} succeeded, ${failed} failed.`
      : `Upload finished: ${completed} file(s) queued for ${targetHostLabel}.`
    pushEvent('info', `Upload batch complete for ${targetHostLabel}: ${completed}/${files.length} succeeded${failed ? `, ${failed} failed` : ''}`)
    elements.uploadForm.reset()
    elements.uploadNodeSelect.value = ''
    await refreshData()
  } finally {
    state.uploadBusy = false
  }
}

async function onAssign(event) {
  event.preventDefault()
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before assigning files.')
    return
  }
  const fileId = elements.fileSelect.value
  const targetHostLabel = elements.nodeSelect.value
  if (!fileId || !targetHostLabel) return
  await submitJson(`/api/dashboard/files/${encodeURIComponent(fileId)}/assign`, { targetHostLabel })
  pushEvent('info', `Assigned file to node ${targetHostLabel}`)
  await refreshData()
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

async function onDeleteLog(fileName) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before deleting log files.')
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

async function onTpaBot(botName, tpaTarget) {
  if (!hasPermission('canOperate')) {
    pushEvent('warn', 'Login as an operator before sending TPA commands.')
    return
  }
  const msg = `/tpa ${tpaTarget}`
  await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/chat`, { message: msg })
  pushEvent('info', `[${botName}] sent: ${msg}`)
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
    await submitJson('/api/dashboard/commands/stop-all', { reason: 'dashboard-ui stop all' })
    pushEvent('warn', 'Queued print stop for all known bots')
  } else if (action === 'start' && botName) {
    await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/start`, {})
    pushEvent('info', `Queued print start for ${botName}`)
  } else if (action === 'stop' && botName) {
    await submitJson(`/api/dashboard/bots/${encodeURIComponent(botName)}/commands/stop`, { reason: 'dashboard-ui stop' })
    pushEvent('warn', `Queued print stop for ${botName}`)
  } else if (action === 'start-node' && botName) {
    await submitJson(`/api/dashboard/nodes/${encodeURIComponent(botName)}/commands/start`, {})
    pushEvent('info', `Queued print start for node ${botName}`)
  } else if (action === 'stop-node' && botName) {
    await submitJson(`/api/dashboard/nodes/${encodeURIComponent(botName)}/commands/stop`, { reason: 'dashboard-ui node stop' })
    pushEvent('warn', `Queued print stop for node ${botName}`)
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
  try {
    button.disabled = true
    if (button.dataset.action === 'delete-node-file') {
      await onDeleteNodeFile(button.dataset.hostLabel || '', button.dataset.fileName || '')
    } else if (button.dataset.action === 'delete-operator') {
      await onDeleteOperator(button.dataset.username || '')
    } else if (button.dataset.action === 'download-log') {
      await downloadLogFile(button.dataset.fileName || '')
      pushEvent('info', `Downloaded log ${button.dataset.fileName || ''}`)
    } else if (button.dataset.action === 'delete-log') {
      await onDeleteLog(button.dataset.fileName || '')
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
    } else if (button.dataset.action === 'edit-config') {
      await onEditConfig(button.dataset.configName || '')
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

elements.loginButton.addEventListener('click', async () => {
  state.auth.operator = elements.operatorUsername.value.trim()
  state.auth.password = elements.operatorPassword.value
  const ok = await verifyOperatorAuth()
  if (ok) {
    pushEvent('info', `Operator authenticated as ${state.auth.operator}`)
  } else {
    pushEvent('error', 'Operator authentication failed')
  }
})

elements.logoutButton.addEventListener('click', () => {
  const previous = state.auth.operator || 'operator'
  clearAuth()
  pushEvent('info', `Logged out ${previous}`)
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

elements.assignForm.addEventListener('submit', (event) => {
  void onAssign(event).catch((error) => pushEvent('error', error.message))
})

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
void verifyOperatorAuth()
void refreshData()

elements.refreshInterval.addEventListener('change', () => {
  state.refreshIntervalMs = normalizeRefreshInterval(elements.refreshInterval.value)
  persistRefreshInterval()
  applyRefreshInterval()
  pushEvent('info', `Auto refresh set to ${Math.round(state.refreshIntervalMs / 60000)} minute(s)`)
})