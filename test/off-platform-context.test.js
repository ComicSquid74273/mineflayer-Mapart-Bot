'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  runWithOffPlatformNavigation,
  taskAllowsOffPlatformNavigation
} = require('../src/nerv-printer/navigation/off-platform-context')

test('off-platform permission is isolated to the portal task and its bot', async () => {
  const portalBot = { name: 'portal' }
  const printerBot = { name: 'printer' }
  let releasePortal
  const portalWaiting = new Promise((resolve) => { releasePortal = resolve })

  const portalTask = runWithOffPlatformNavigation(portalBot, async () => {
    assert.equal(taskAllowsOffPlatformNavigation(portalBot), true)
    assert.equal(taskAllowsOffPlatformNavigation(printerBot), false)
    await portalWaiting
    assert.equal(taskAllowsOffPlatformNavigation(portalBot), true)
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(taskAllowsOffPlatformNavigation(portalBot), false)
  assert.equal(taskAllowsOffPlatformNavigation(printerBot), false)

  releasePortal()
  await portalTask
  assert.equal(taskAllowsOffPlatformNavigation(portalBot), false)
})

test('nested async portal operations keep permission without leaking after completion', async () => {
  const bot = { name: 'portal' }

  await runWithOffPlatformNavigation(bot, async () => {
    await Promise.resolve()
    assert.equal(taskAllowsOffPlatformNavigation(bot), true)
    await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(taskAllowsOffPlatformNavigation(bot), true)
  })

  assert.equal(taskAllowsOffPlatformNavigation(bot), false)
})
