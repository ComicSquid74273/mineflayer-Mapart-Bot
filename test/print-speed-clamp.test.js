'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

test('sprint boost is not gated on allowJump — flat sprint reaches 7.192 bps', () => {
  const start = source.indexOf('function installVanillaSpeed')
  const end = source.indexOf('\nfunction readOptionalJson', start)
  assert.ok(start >= 0 && end > start, 'installVanillaSpeed found')
  const fn = source.slice(start, end)

  assert.doesNotMatch(fn, /maxSafeBps\s*=\s*allowJump\s*\?/)
  assert.match(fn, /const maxSafeBps = 7\.192/)
  // The 5.612 walk-speed clamp must not appear as the no-jump ceiling anymore.
  assert.doesNotMatch(fn, /5\.612/)
})

test('TPS throttle uses 19/17 hysteresis and retains the previous mode in between', () => {
  const start = source.indexOf('function installVanillaSpeed')
  const end = source.indexOf('\nfunction readOptionalJson', start)
  const fn = source.slice(start, end)

  assert.match(fn, /serverTps >= 19\.0 \? 'boost'|serverTps >= 19\.0\) throttleState = 'boost'|serverTps >= 19\.0 \? throttleState = 'boost'/)
  assert.match(fn, /throttleState = 'fallback'/)
  assert.match(fn, /__nervSpeedThrottleState/)
  // Fallback speed is 5.6 bps normal sprint, never the old <14 walk tier.
  assert.doesNotMatch(fn, /4\.317/)
})

test('speed boost still respects setback cooldown and platform-only gating', () => {
  const start = source.indexOf('function installVanillaSpeed')
  const end = source.indexOf('\nfunction readOptionalJson', start)
  const fn = source.slice(start, end)

  assert.match(fn, /lastSetbackAt < setbackCooldownMs/)
  assert.match(fn, /vanillaSpeedPlatformOnly !== false/)
})
