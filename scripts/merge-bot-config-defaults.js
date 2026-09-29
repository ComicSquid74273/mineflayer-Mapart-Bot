'use strict'

const fs = require('fs')
const path = require('path')

function mergeBotConfigDefaults(configPath) {
  const resolvedPath = path.resolve(configPath)
  const config = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
  const adv = config.advanced || (config.advanced = {})
  const printer = config.printer || (config.printer = {})

  printer.allowJump = false
  if (adv.vanillaSpeedEnabled === undefined) adv.vanillaSpeedEnabled = true
  if (adv.vanillaSpeedBps === undefined) adv.vanillaSpeedBps = 7.192
  if (adv.vanillaStepHeight === undefined || adv.vanillaStepHeight < 1.25) adv.vanillaStepHeight = 1.25
  if (adv.vanillaSpeedInLiquids === undefined) adv.vanillaSpeedInLiquids = false
  if (adv.vanillaSpeedOnlyOnGround === undefined) adv.vanillaSpeedOnlyOnGround = true
  if (adv.vanillaSpeedPlatformOnly === undefined) adv.vanillaSpeedPlatformOnly = true
  if (adv.vanillaSpeedSetbackFallbackMs === undefined) adv.vanillaSpeedSetbackFallbackMs = 3000
  if (adv.latencySafeModeEnterMs === undefined || adv.latencySafeModeEnterMs === 90) adv.latencySafeModeEnterMs = 300
  if (adv.latencySafeModeResumeMs === undefined || adv.latencySafeModeResumeMs === 85) adv.latencySafeModeResumeMs = 280
  if (adv.dumpInventoryStableMs === undefined || adv.dumpInventoryStableMs === 2500) adv.dumpInventoryStableMs = 400
  if (adv.machineAccessSprintMode === undefined || adv.machineAccessSprintMode === 'disabled') adv.machineAccessSprintMode = 'enabled'

  const tempPath = `${resolvedPath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tempPath, resolvedPath)
  return adv
}

if (require.main === module) {
  const configPath = process.argv[2]
  if (!configPath) throw new Error('Usage: node scripts/merge-bot-config-defaults.js <config-path>')
  mergeBotConfigDefaults(configPath)
  console.log(`Merged config defaults for ${configPath}`)
}

module.exports = { mergeBotConfigDefaults }
