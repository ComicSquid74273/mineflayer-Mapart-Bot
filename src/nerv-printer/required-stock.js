'use strict'

function normalizeRequiredStockKey(value) {
  return String(value || 'stock')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'stock'
}

function requiredStockAlertCategory(resource) {
  return `required-stock-${normalizeRequiredStockKey(resource)}`
}

function requiredStockStatusDetail(resource) {
  return `waiting-${normalizeRequiredStockKey(resource)}-stock`
}

function normalizeAttemptResult(result) {
  const value = result && typeof result === 'object' ? result : {}
  return {
    ...value,
    ready: value.ready === true,
    shortage: value.shortage === true,
    verified: value.verified === true
  }
}

async function waitForRequiredStock(options = {}) {
  if (typeof options.attempt !== 'function') {
    throw new TypeError('waitForRequiredStock requires an attempt function')
  }

  const retryMs = Math.max(250, Number(options.retryMs) || 5000)
  const waitSliceMs = Math.max(50, Math.min(retryMs, Number(options.waitSliceMs) || 1000))
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
  const now = typeof options.now === 'function' ? options.now : Date.now
  const assertContinue = typeof options.assertContinue === 'function' ? options.assertContinue : () => {}
  let holdStartedAt = 0
  let attempts = 0

  while (true) {
    assertContinue()
    attempts += 1
    const result = normalizeAttemptResult(await options.attempt({
      attempt: attempts,
      holdStartedAt
    }))
    assertContinue()

    if (result.ready) {
      const waitedMs = holdStartedAt > 0 ? Math.max(0, now() - holdStartedAt) : 0
      if (holdStartedAt > 0 && typeof options.onRecovered === 'function') {
        await options.onRecovered({ result, waitedMs, attempts, holdStartedAt })
      }
      return { ...result, waitedMs, attempts }
    }

    // Only a confirmed resource shortage is retryable. Navigation, protocol,
    // inventory, and unverified-window failures must remain visible defects.
    if (!result.shortage || !result.verified) {
      return {
        ...result,
        waitedMs: holdStartedAt > 0 ? Math.max(0, now() - holdStartedAt) : 0,
        attempts,
        operationalFailure: true
      }
    }

    const firstHoldObservation = holdStartedAt <= 0
    if (firstHoldObservation) holdStartedAt = now()
    const holdContext = {
      result,
      retryMs,
      attempts,
      holdStartedAt,
      firstHoldObservation,
      waitedMs: Math.max(0, now() - holdStartedAt)
    }
    if (typeof options.onShortage === 'function') {
      await options.onShortage(holdContext)
    }
    if (typeof options.onWait === 'function') {
      await options.onWait(holdContext)
    }

    let remainingMs = retryMs
    while (remainingMs > 0) {
      assertContinue()
      const sliceMs = Math.min(waitSliceMs, remainingMs)
      await sleep(sliceMs)
      remainingMs -= sliceMs
    }
  }
}

module.exports = {
  normalizeRequiredStockKey,
  requiredStockAlertCategory,
  requiredStockStatusDetail,
  waitForRequiredStock
}
