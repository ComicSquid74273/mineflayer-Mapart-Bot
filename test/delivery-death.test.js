const test = require('node:test')
const assert = require('node:assert/strict')
const { buildDeathOutcome } = require('../src/nerv-printer/delivery/mission')

const onSettings = { alertOnDeath: true, haltMissionOnDeath: true }

test('death while carrying maps mid-mission alerts (error) and halts', () => {
  const outcome = buildDeathOutcome({
    settings: onSettings,
    position: { x: 21.4, y: 86, z: -854.2 },
    mapsAtRisk: 37,
    missionActive: true
  })
  assert.equal(outcome.halt, true)
  assert.ok(outcome.alert)
  assert.equal(outcome.alert.category, 'delivery-bot-died')
  assert.equal(outcome.alert.level, 'error')
  assert.match(outcome.alert.message, /DIED at \(21, 86, -854\)/)
  assert.match(outcome.alert.message, /carrying 37 map\(s\)/)
  assert.equal(outcome.alert.detail.mapsAtRisk, 37)
})

test('death with no maps and no active mission still alerts but does not halt', () => {
  const outcome = buildDeathOutcome({
    settings: onSettings,
    position: { x: 0, y: 64, z: 0 },
    mapsAtRisk: 0,
    missionActive: false
  })
  assert.equal(outcome.halt, false)
  assert.ok(outcome.alert)
  assert.doesNotMatch(outcome.alert.message, /carrying/)
})

test('unknown position renders gracefully', () => {
  const outcome = buildDeathOutcome({ settings: onSettings, position: null, mapsAtRisk: 5, missionActive: true })
  assert.match(outcome.alert.message, /an unknown location/)
})

test('alertOnDeath=false suppresses the alert but halt still protects maps', () => {
  const outcome = buildDeathOutcome({
    settings: { alertOnDeath: false, haltMissionOnDeath: true },
    position: { x: 1, y: 2, z: 3 },
    mapsAtRisk: 10,
    missionActive: true
  })
  assert.equal(outcome.alert, null)
  assert.equal(outcome.halt, true)
})

test('haltMissionOnDeath=false keeps the mission active (alert only)', () => {
  const outcome = buildDeathOutcome({
    settings: { alertOnDeath: true, haltMissionOnDeath: false },
    position: { x: 1, y: 2, z: 3 },
    mapsAtRisk: 10,
    missionActive: true
  })
  assert.ok(outcome.alert)
  assert.equal(outcome.halt, false)
})

test('defaults (empty settings) alert and halt when mission active', () => {
  const outcome = buildDeathOutcome({ settings: {}, position: { x: 1, y: 2, z: 3 }, mapsAtRisk: 2, missionActive: true })
  assert.ok(outcome.alert)
  assert.equal(outcome.halt, true)
})
