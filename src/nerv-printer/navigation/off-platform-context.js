'use strict'

const { AsyncLocalStorage } = require('async_hooks')

const offPlatformNavigationContext = new AsyncLocalStorage()

function runWithOffPlatformNavigation(bot, task) {
  if (typeof task !== 'function') throw new TypeError('off-platform navigation task must be a function')
  return offPlatformNavigationContext.run({ bot }, task)
}

function taskAllowsOffPlatformNavigation(bot) {
  return offPlatformNavigationContext.getStore()?.bot === bot
}

module.exports = {
  runWithOffPlatformNavigation,
  taskAllowsOffPlatformNavigation
}
