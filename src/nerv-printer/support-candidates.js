'use strict'

function toPoint(value) {
  if (!value) return null
  const x = Number(value.x)
  const y = Number(value.y)
  const z = Number(value.z)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { x, y, z }
}

function normalizeSupportCandidates(...sources) {
  const result = []
  const seen = new Set()

  for (const source of sources) {
    const entries = Array.isArray(source) ? source : [source]
    for (const entry of entries) {
      if (!entry || entry.enabled === false) continue
      const position = toPoint(entry.position || entry.blockPos || entry)
      if (!position) continue
      const accessPosition = toPoint(
        entry.accessPosition ||
        entry.openPos ||
        entry.position?.accessPosition ||
        entry.position?.openPos
      )
      const key = `${position.x}:${position.y}:${position.z}:${accessPosition?.x ?? ''}:${accessPosition?.y ?? ''}:${accessPosition?.z ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ enabled: true, position, accessPosition })
    }
  }

  return result
}

function prioritizeSupportCandidates(candidates, preferred) {
  const normalized = normalizeSupportCandidates(candidates)
  const preferredList = normalizeSupportCandidates(preferred)
  if (!preferredList.length) return normalized
  return normalizeSupportCandidates(preferredList, normalized)
}

async function trySupportCandidates(candidates, attempt, options = {}) {
  const normalized = normalizeSupportCandidates(candidates)
  const attempts = []

  for (let index = 0; index < normalized.length; index += 1) {
    const candidate = normalized[index]
    let result
    try {
      result = await attempt(candidate, index)
    } catch (error) {
      if (typeof options.rethrow === 'function' && options.rethrow(error)) throw error
      result = {
        ready: false,
        verified: false,
        shortage: false,
        error: error?.message || String(error)
      }
    }
    const normalizedResult = {
      ...(result && typeof result === 'object' ? result : {}),
      ready: result?.ready === true,
      verified: result?.verified === true,
      shortage: result?.shortage === true,
      candidate,
      candidateIndex: index,
      fallback: index > 0
    }
    attempts.push(normalizedResult)
    if (normalizedResult.ready) return { ...normalizedResult, attempts }
  }

  return { ready: false, attempts }
}

function summarizeRequiredStockAttempts(attempts, resourceLabel) {
  const results = Array.isArray(attempts) ? attempts : []
  const verifiedEmpty = results.filter((entry) => entry.verified === true && entry.shortage === true)
  if (verifiedEmpty.length > 0) {
    const errors = results.map((entry) => entry.error).filter(Boolean)
    return {
      ready: false,
      verified: true,
      shortage: true,
      degraded: verifiedEmpty.length !== results.length,
      error: errors.join(' | ') || undefined,
      attempts: results
    }
  }

  const errors = results.map((entry) => entry.error).filter(Boolean)
  return {
    ready: false,
    verified: false,
    shortage: false,
    error: errors.join(' | ') || `${resourceLabel || 'support resource'} candidates could not be verified`,
    attempts: results
  }
}

module.exports = {
  normalizeSupportCandidates,
  prioritizeSupportCandidates,
  summarizeRequiredStockAttempts,
  trySupportCandidates
}
