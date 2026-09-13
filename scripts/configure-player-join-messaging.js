const fs = require('fs')
const path = require('path')
const { DEFAULT_PLAYER_JOIN_MESSAGES } = require('../src/nerv-printer/player-join-messaging')

function configurePlayerJoinMessaging(configPath, enabled) {
  const resolvedPath = path.resolve(configPath)
  const config = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
  const current = config.playerJoinMessaging && typeof config.playerJoinMessaging === 'object'
    ? config.playerJoinMessaging
    : {}
  config.playerJoinMessaging = {
    enabled: enabled === true,
    masterOnly: current.masterOnly !== false,
    joinDelayMs: Number(current.joinDelayMs || 1000),
    intervalMs: Number(current.intervalMs || 10000),
    messageListPollMs: Number(current.messageListPollMs || 30000),
    defaultMessages: Array.isArray(current.defaultMessages) && current.defaultMessages.length
      ? current.defaultMessages
      : DEFAULT_PLAYER_JOIN_MESSAGES
  }
  const tempPath = `${resolvedPath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tempPath, resolvedPath)
  return config.playerJoinMessaging
}

if (require.main === module) {
  const configPath = process.argv[2]
  if (!configPath) throw new Error('Usage: node scripts/configure-player-join-messaging.js <config-path> <true|false>')
  const enabled = String(process.argv[3] || '').trim().toLowerCase() === 'true'
  const result = configurePlayerJoinMessaging(configPath, enabled)
  console.log(`playerJoinMessaging.enabled=${result.enabled}`)
}

module.exports = { configurePlayerJoinMessaging }
