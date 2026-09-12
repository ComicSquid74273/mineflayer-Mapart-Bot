'use strict'

function timestampMs(value) {
  const parsed = new Date(value || 0).getTime()
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function isExplicitlyBlocked(bot) {
  const blockedPattern = /\b(blocked|awaiting-operator|failed|failure|timed-out|timeout|fatal|error)\b/
  const liveStatus = `${bot?.phase || ''} ${bot?.statusDetail || ''}`.toLowerCase()
  if (blockedPattern.test(liveStatus)) return true

  const lastError = String(bot?.lastError || '').toLowerCase()
  if (!blockedPattern.test(lastError)) return false

  // A recovered placement can keep its diagnostic lastError until the run
  // returns from runPrint. Do not let that historical error override newer,
  // authoritative progress and falsely label an active print as stalled.
  const lastErrorAtMs = timestampMs(bot?.lastErrorAt)
  const progressAtMs = timestampMs(bot?.progress?.updatedAt)
  return !lastErrorAtMs || !progressAtMs || lastErrorAtMs >= progressAtMs
}

function getProgressAgeMs(bot, now = Date.now()) {
  const updatedAtMs = timestampMs(bot?.progress?.updatedAt)
  return updatedAtMs > 0 ? Math.max(0, now - updatedAtMs) : Number.POSITIVE_INFINITY
}

function hasActiveRequiredStockAlert(bot) {
  return Array.isArray(bot?.alerts) && bot.alerts.some((alert) =>
    alert?.active === true && String(alert.category || '').startsWith('required-stock-')
  )
}

function isLongRuntimeStalled(bot, options = {}) {
  const now = Number(options.now) || Date.now()
  const runtimeDurationMs = Math.max(60 * 1000, Number(options.runtimeDurationMs) || 30 * 60 * 1000)
  const progressStaleMs = Math.max(60 * 1000, Number(options.progressStaleMs) || 5 * 60 * 1000)
  if (bot?.online !== true) return false
  if (!['printing', 'repair', 'rescan', 'post-print', 'cleanup'].includes(String(bot?.phase || '').trim().toLowerCase())) return false
  if (!String(bot?.currentNbt || '').trim()) return false
  // A confirmed empty stock chest is an intentional, operator-visible hold.
  // The dedicated critical stock alert remains active until refill; do not also
  // mislabel the same bot as an unexplained NBT stall after 30 minutes.
  if (hasActiveRequiredStockAlert(bot)) return false
  const startedAtMs = timestampMs(bot?.currentNbtStartedAt)
  if (!startedAtMs || now - startedAtMs < runtimeDurationMs) return false
  if (isExplicitlyBlocked(bot)) return true
  return getProgressAgeMs(bot, now) >= progressStaleMs
}

module.exports = {
  getProgressAgeMs,
  hasActiveRequiredStockAlert,
  isExplicitlyBlocked,
  isLongRuntimeStalled,
  timestampMs
}
