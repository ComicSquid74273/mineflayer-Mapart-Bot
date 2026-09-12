// Cooldown parsing + tracking for the delivery bot.
// Ported from account-onboarding-bot (src/command-cooldown.js, src/cooldowns.js):
// cooldowns are LEARNED from server chat ("You have to wait 9m 55s to teleport again."),
// never hardcoded; configured fallbacks only apply when the server says nothing.

function parseDurationMs(text) {
  const source = String(text || '').toLowerCase()
  let totalMs = 0
  let matched = false

  const patterns = [
    { unit: 'h', ms: 60 * 60 * 1000, regex: /(\d+)\s*(?:h|hr|hrs|hour|hours)(?![a-z])/g },
    { unit: 'm', ms: 60 * 1000, regex: /(\d+)\s*(?:m|min|mins|minute|minutes)(?![a-z])/g },
    { unit: 's', ms: 1000, regex: /(\d+)\s*(?:s|sec|secs|second|seconds)(?![a-z])/g }
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.regex.exec(source)) !== null) {
      totalMs += Number(match[1]) * pattern.ms
      matched = true
    }
  }

  return matched ? totalMs : 0
}

function extractCommandCooldown(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim()
  const lower = text.toLowerCase()
  if (!lower.includes('wait')) return null

  const waitMs = parseDurationMs(text)
  if (waitMs <= 0) return null

  let type = 'command'
  if (/(teleport|tpa|tp|home)/i.test(text)) type = 'teleport'
  if (/(msg|message|whisper|chat)/i.test(text)) type = 'message'

  return {
    type,
    waitMs,
    message: text
  }
}

function extractTeleportWarmup(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim()
  if (!/^teleporting\s+to\s+/i.test(text)) return null
  const waitMs = parseDurationMs(text)
  if (waitMs <= 0) return null
  return {
    type: 'teleport-warmup',
    waitMs,
    message: text
  }
}

function commandKeysForCooldown(command, cooldownType) {
  const key = String(command || '').toLowerCase()
  if (cooldownType === 'message') return ['msg']
  if (cooldownType === 'teleport') {
    if (key === 'sethome') return ['sethome']
    if (['home', 'tpa', 'accept'].includes(key)) return ['home', 'tpa', 'accept']
    return ['home', 'tpa', 'accept']
  }
  return key ? [key] : []
}

// Messages that mean the command itself failed (not a cooldown), e.g. missing home.
function extractHomeFailure(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim()
  const lower = text.toLowerCase()
  if (!lower) return null
  const patterns = [
    /home .* (?:does ?n.?t|not) exist/i,
    /no home (?:named|called|set)/i,
    /you have no homes?/i,
    /invalid home/i,
    /home not found/i,
    /unknown home/i
  ]
  for (const pattern of patterns) {
    if (pattern.test(text)) return { type: 'home-missing', message: text }
  }
  return null
}

function extractTargetUnavailable(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const patterns = [
    /player not found/i,
    /no player (?:was )?found/i,
    /player .* is (?:currently )?offline/i,
    /player .* is not online/i,
    /cannot find (?:that )?player/i
  ]
  for (const pattern of patterns) {
    if (pattern.test(text)) return { type: 'target-unavailable', message: text }
  }
  return null
}

class CooldownManager {
  constructor(durations = {}, state = {}) {
    this.durations = { ...durations }
    this.state = state && typeof state === 'object' ? { ...state } : {}
  }

  key(actor, command) {
    return `${actor}:${command}`
  }

  duration(command) {
    return Math.max(0, Number(this.durations[command] || 0))
  }

  getEntry(actor, command) {
    const key = this.key(actor, command)
    if (!this.state[key]) {
      this.state[key] = {
        lastUsedAt: 0,
        readyAt: 0
      }
    }
    return this.state[key]
  }

  readyAt(actor, command) {
    return Number(this.getEntry(actor, command).readyAt || 0)
  }

  waitMs(actor, command, now = Date.now()) {
    return Math.max(0, this.readyAt(actor, command) - now)
  }

  canRun(actor, command, now = Date.now()) {
    return this.waitMs(actor, command, now) === 0
  }

  markUsed(actor, command, now = Date.now()) {
    const entry = this.getEntry(actor, command)
    entry.lastUsedAt = now
    entry.readyAt = now + this.duration(command)
    return { ...entry }
  }

  setReadyAt(actor, command, readyAt, now = Date.now()) {
    const entry = this.getEntry(actor, command)
    entry.readyAt = Math.max(Number(entry.readyAt || 0), Number(readyAt || 0))
    if (!entry.lastUsedAt) entry.lastUsedAt = now
    return { ...entry }
  }

  // Server-reported cooldowns are authoritative: overwrite (not max) so a shorter
  // real cooldown can replace a pessimistic fallback.
  overrideReadyAt(actor, command, readyAt, now = Date.now()) {
    const entry = this.getEntry(actor, command)
    entry.readyAt = Math.max(now, Number(readyAt || 0))
    if (!entry.lastUsedAt) entry.lastUsedAt = now
    return { ...entry }
  }

  delay(actor, command, waitMs, now = Date.now()) {
    return this.setReadyAt(actor, command, now + Math.max(0, Number(waitMs || 0)), now)
  }

  toJSON() {
    return { ...this.state }
  }
}

function waitForCommandResponse(bot, command, timeoutMs) {
  const waitMs = Math.max(0, Number(timeoutMs || 0))
  if (!bot || waitMs <= 0) return Promise.resolve(null)

  return new Promise((resolve) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      bot.removeListener('messagestr', onMessage)
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), waitMs)
    timer.unref?.()
    const onMessage = (message) => {
      const cooldown = extractCommandCooldown(message)
      if (cooldown) {
        const keys = commandKeysForCooldown(command, cooldown.type)
        if (keys.includes(command)) {
          finish({ type: 'cooldown', cooldown, waitMs: cooldown.waitMs, message })
        }
        return
      }

      const warmup = extractTeleportWarmup(message)
      if (warmup && command === 'home') {
        finish({ type: 'teleport-warmup', waitMs: warmup.waitMs, message })
        return
      }

      if (command === 'home') {
        const failure = extractHomeFailure(message)
        if (failure) finish({ type: 'home-missing', message })
      }

      if (command === 'tpa') {
        const unavailable = extractTargetUnavailable(message)
        if (unavailable) finish({ type: 'target-unavailable', message })
      }
    }

    bot.on('messagestr', onMessage)
  })
}

async function waitWithAbort(ms, { shouldAbort = null, onTick = null, tickMs = 1000 } = {}) {
  const deadline = Date.now() + Math.max(0, Number(ms || 0))
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function' && shouldAbort()) return false
    if (typeof onTick === 'function') await onTick(Math.max(0, deadline - Date.now()))
    if (typeof shouldAbort === 'function' && shouldAbort()) return false
    const step = Math.min(Math.max(50, Number(tickMs) || 1000), deadline - Date.now())
    await new Promise((resolve) => {
      const t = setTimeout(resolve, step)
      t.unref?.()
    })
  }
  return !(typeof shouldAbort === 'function' && shouldAbort())
}

// Sends a chat command respecting local + server-learned cooldowns.
// Resolves { status: 'sent', warmupMs } once the command went out (after any waits),
// { status: 'aborted' } if shouldAbort fired during a wait,
// { status: 'home-missing', message } when the server says the home doesn't exist.
async function sendCommandWithCooldown({
  bot,
  cooldowns,
  command,
  message,
  actor = 'delivery',
  maxChatWaitMs = 8000,
  extraDelayMs = 1500,
  silentRetryMs = 20000,
  assumeFallbackCooldown = true,
  maxRetries = 3,
  log = null,
  shouldAbort = null,
  onWait = null
}) {
  if (!bot) throw new Error('sendCommandWithCooldown: bot is required')
  if (!message) throw new Error(`sendCommandWithCooldown: missing chat message for ${actor}:${command}`)

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const localWaitMs = cooldowns.waitMs(actor, command)
    if (localWaitMs > 0) {
      log?.(`[DELIVERY-COOLDOWN] ${command} on local cooldown for ${Math.ceil(localWaitMs / 1000)}s before "${message}"`)
      onWait?.({ reason: 'local-cooldown', waitMs: localWaitMs, command })
      const finished = await waitWithAbort(localWaitMs, { shouldAbort })
      if (!finished) return { status: 'aborted' }
    }

    const responsePromise = waitForCommandResponse(bot, command, maxChatWaitMs)
    bot.chat(message)
    log?.(`[DELIVERY-COOLDOWN] sent ${actor}:${command}: ${message}`)
    // A silent server response does not prove that a long teleport cooldown was
    // consumed. Delivery mode uses a short anti-spam hold and learns the real
    // shared cooldown only when the server reports it.
    if (assumeFallbackCooldown) cooldowns.markUsed(actor, command)
    else cooldowns.delay(actor, command, Math.max(15000, Number(silentRetryMs) || 20000))

    const response = await responsePromise

    if (response?.type === 'cooldown') {
      const totalWaitMs = response.cooldown.waitMs + Math.max(0, extraDelayMs)
      const now = Date.now()
      for (const key of commandKeysForCooldown(command, response.cooldown.type)) {
        cooldowns.overrideReadyAt(actor, key, now + totalWaitMs, now)
      }
      log?.(`[DELIVERY-COOLDOWN] server cooldown for ${command}: "${response.cooldown.message}" -> waiting ${Math.ceil(totalWaitMs / 1000)}s`)
      if (attempt < maxRetries) continue
      return { status: 'cooldown-blocked', waitMs: totalWaitMs, message: response.cooldown.message }
    }

    if (response?.type === 'home-missing') {
      log?.(`[DELIVERY-COOLDOWN] home missing: "${response.message}"`)
      return { status: 'home-missing', message: response.message }
    }

    if (response?.type === 'target-unavailable') {
      log?.(`[DELIVERY-COOLDOWN] tpa target unavailable: "${response.message}"`)
      return { status: 'target-unavailable', message: response.message }
    }

    if (response?.type === 'teleport-warmup') {
      const warmupMs = response.waitMs + Math.max(0, extraDelayMs)
      log?.(`[DELIVERY-COOLDOWN] teleport warmup detected; waiting ${Math.ceil(warmupMs / 1000)}s`)
      const finished = await waitWithAbort(warmupMs, { shouldAbort })
      if (!finished) return { status: 'aborted' }
      return { status: 'sent', warmupMs }
    }

    return { status: 'sent', warmupMs: 0 }
  }

  return { status: 'cooldown-blocked', waitMs: cooldowns.waitMs(actor, command), message: 'retries exhausted' }
}

module.exports = {
  parseDurationMs,
  extractCommandCooldown,
  extractTeleportWarmup,
  extractHomeFailure,
  extractTargetUnavailable,
  commandKeysForCooldown,
  CooldownManager,
  waitForCommandResponse,
  waitWithAbort,
  sendCommandWithCooldown
}
