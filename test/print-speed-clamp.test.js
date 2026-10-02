'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const cliPath = path.join(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

test('sprint boost is physics-integrated, never a post-physics position teleport', () => {
  const start = source.indexOf('function installVanillaSpeed')
  const end = source.indexOf('\nfunction readOptionalJson', start)
  assert.ok(start >= 0 && end > start, 'installVanillaSpeed found')
  const fn = source.slice(start, end)

  // THM/Meteor Vanilla-mode semantics: the movement-speed attribute constant is
  // scaled so the full vanilla pipeline (inertia, acceleration, collisions)
  // produces the target speed. The old teleport (pos.x = nextPos.x AFTER
  // physics) produced unexplainable positions and the rubberband storm.
  assert.match(fn, /bot\.physics\.playerSpeed = scaled/)
  assert.match(fn, /defaultPlayerSpeed \* \(bps \/ vanillaSprintBps\)/)
  assert.match(fn, /vanillaSprintBps = 5\.612/)
  assert.doesNotMatch(fn, /pos\.x = nextPos\.x/)
  assert.doesNotMatch(fn, /pos\.z = nextPos\.z/)
  assert.match(fn, /restorePlayerSpeed/)
})

test('TPS throttle uses 19/17 hysteresis and retains the previous mode in between', () => {
  const start = source.indexOf('function installVanillaSpeed')
  const end = source.indexOf('\nfunction readOptionalJson', start)
  const fn = source.slice(start, end)

  assert.match(fn, /serverTps >= 19\.0\) throttleState = 'boost'/)
  assert.match(fn, /serverTps < 17\.0\) throttleState = 'fallback'/)
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

test('event-loop lag meter exists to correlate code saturation with ping', () => {
  const start = source.indexOf('function installVanillaSpeed')
  const end = source.indexOf('\nfunction readOptionalJson', start)
  const fn = source.slice(start, end)

  assert.match(fn, /LOOP-LAG/)
  assert.match(fn, /clearInterval\(lagSampler\)/)
})
