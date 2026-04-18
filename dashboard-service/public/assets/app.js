const state = {
  bots: [],
  files: [],
  refreshTimer: null,
  busy: false,
  events: []
}

const elements = {
  assignForm: document.getElementById('assignForm'),
  botSelect: document.getElementById('botSelect'),
  botsGrid: document.getElementById('botsGrid'),
  botSummary: document.getElementById('botSummary'),
  eventLog: document.getElementById('eventLog'),
  fileInput: document.getElementById('fileInput'),
  fileSelect: document.getElementById('fileSelect'),
  filesList: document.getElementById('filesList'),
  lastRefresh: document.getElementById('lastRefresh'),
  notesInput: document.getElementById('notesInput'),
  refreshButton: document.getElementById('refreshButton'),
  serviceStatus: document.getElementById('serviceStatus'),
  startAllButton: document.getElementById('startAllButton'),
  stopAllButton: document.getElementById('stopAllButton'),
  uploadForm: document.getElementById('uploadForm'),
  uploadedByInput: document.getElementById('uploadedByInput')
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

function phaseClass(phase) {
  return `phase-${String(phase || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function pushEvent(level, message) {
  state.events.unshift({
    level,
    message,
    time: new Date().toISOString()
  })
  state.events = state.events.slice(0, 14)
  renderEvents()
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  })

  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(body?.error || `Request failed: ${response.status}`)
  }
  return body
}

function renderSummary() {
  const online = state.bots.filter((item) => item.online).length
  const printing = state.bots.filter((item) => item.phase === 'printing').length
  const stale = state.bots.filter((item) => item.activeState === 'stale').length
  const idle = state.bots.filter((item) => item.idle).length

  elements.botSummary.innerHTML = [
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

function renderBots() {
  if (!state.bots.length) {
    elements.botsGrid.innerHTML = `
      <article class="empty-card">
        <h3>No bot data yet</h3>
        <p>Start at least one bot with dashboard integration enabled, then refresh this page.</p>
      </article>
    `
    return
  }

  elements.botsGrid.innerHTML = state.bots.map((bot) => {
    const progress = bot.progress && Number.isFinite(Number(bot.progress.percent))
      ? `${bot.progress.percent}%`
      : 'n/a'
    return `
      <article class="bot-card">
        <div class="bot-head">
          <div>
            <h3 class="bot-name">${escapeHtml(bot.botName)}</h3>
            <p class="bot-meta">${escapeHtml(bot.hostLabel || 'unknown host')} · ${escapeHtml(bot.role || 'single')} · ${escapeHtml(bot.location || 'unknown')}</p>
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
        </div>
        <div class="bot-metrics">
          <div class="metric">NBT<strong>${escapeHtml(bot.currentNbt || 'none')}</strong></div>
          <div class="metric">Recovery<strong>${escapeHtml(bot.recoveryState || 'none')}</strong></div>
          <div class="metric">Reconnect<strong>${escapeHtml(bot.reconnectState || 'idle')}</strong></div>
          <div class="metric">Heartbeat<strong>${escapeHtml(formatTime(bot.heartbeatAt))}</strong></div>
        </div>
        ${bot.lastError ? `<p class="hint">Last error: ${escapeHtml(bot.lastError)}</p>` : ''}
        <div class="bot-actions">
          <button class="accent-button" type="button" data-action="start" data-bot-name="${escapeHtml(bot.botName)}">Start Print</button>
          <button class="danger-button" type="button" data-action="stop" data-bot-name="${escapeHtml(bot.botName)}">Stop Print</button>
        </div>
      </article>
    `
  }).join('')
}

function renderFiles() {
  const fileOptions = ['<option value="">Select uploaded file</option>']
  const botOptions = ['<option value="">Select bot</option>']

  state.files.forEach((item) => {
    fileOptions.push(`<option value="${escapeHtml(item.fileId)}">${escapeHtml(item.originalName)} · ${escapeHtml(item.deliveryStatus)}</option>`)
  })
  state.bots.forEach((item) => {
    botOptions.push(`<option value="${escapeHtml(item.botName)}">${escapeHtml(item.botName)}</option>`)
  })

  elements.fileSelect.innerHTML = fileOptions.join('')
  elements.botSelect.innerHTML = botOptions.join('')

  if (!state.files.length) {
    elements.filesList.innerHTML = `
      <article class="empty-card">
        <h3>No uploaded files</h3>
        <p>Upload an NBT file here, then assign it to a bot.</p>
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
      <p class="hint">Assigned: ${escapeHtml(item.assignedBotName || 'nobody')} · Uploaded: ${escapeHtml(formatTime(item.uploadedAt))}</p>
      ${item.failedReason ? `<p class="hint">Failure: ${escapeHtml(item.failedReason)}</p>` : ''}
    </article>
  `).join('')
}

function renderEvents() {
  if (!state.events.length) {
    elements.eventLog.innerHTML = `
      <article class="empty-card">
        <h3>No activity yet</h3>
        <p>Operator actions and dashboard errors will appear here.</p>
      </article>
    `
    return
  }

  elements.eventLog.innerHTML = state.events.map((entry) => `
    <article class="log-row ${escapeHtml(entry.level)}">
      <div>
        <strong>${escapeHtml(entry.message)}</strong>
      </div>
      <span class="timestamp">${escapeHtml(formatTime(entry.time))}</span>
    </article>
  `).join('')
}

async function refreshData() {
  if (state.busy) return
  state.busy = true
  try {
    const [health, bots, files] = await Promise.all([
      requestJson('/health'),
      requestJson('/api/dashboard/bots'),
      requestJson('/api/dashboard/files')
    ])
    state.bots = Array.isArray(bots.items) ? bots.items : []
    state.files = Array.isArray(files.items) ? files.items : []
    elements.serviceStatus.textContent = health.ok ? 'Service online' : 'Service unknown'
    elements.serviceStatus.className = `status-pill ${health.ok ? 'status-online' : 'status-neutral'}`
    elements.lastRefresh.textContent = formatTime(new Date().toISOString())
    renderSummary()
    renderBots()
    renderFiles()
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
    body: JSON.stringify(body || {})
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
  const file = elements.fileInput.files[0]
  if (!file) return
  const base64 = await fileToBase64(file)
  await submitJson('/api/dashboard/files', {
    originalName: file.name,
    contentBase64: base64,
    uploadedBy: elements.uploadedByInput.value.trim(),
    notes: elements.notesInput.value.trim()
  })
  pushEvent('info', `Uploaded ${file.name}`)
  elements.uploadForm.reset()
  await refreshData()
}

async function onAssign(event) {
  event.preventDefault()
  const fileId = elements.fileSelect.value
  const targetBotName = elements.botSelect.value
  if (!fileId || !targetBotName) return
  await submitJson(`/api/dashboard/files/${encodeURIComponent(fileId)}/assign`, { targetBotName })
  pushEvent('info', `Assigned file to ${targetBotName}`)
  await refreshData()
}

async function onFleetAction(action, botName = null) {
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
  }
  await refreshData()
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]')
  if (!button) return
  try {
    button.disabled = true
    await onFleetAction(button.dataset.action, button.dataset.botName || null)
  } catch (error) {
    pushEvent('error', error.message)
  } finally {
    button.disabled = false
  }
})

elements.refreshButton.addEventListener('click', () => {
  void refreshData()
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

renderEvents()
void refreshData()
state.refreshTimer = window.setInterval(() => {
  void refreshData()
}, 5000)