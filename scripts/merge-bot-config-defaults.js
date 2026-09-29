'use strict'

const fs = require('fs')
const path = require('path')

function mergeBotConfigDefaults(configPath) {
  const resolvedPath = path.resolve(configPath)
  const config = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
  const adv = config.advanced || (config.advanced = {})
  const printer = config.printer || (config.printer = {})

  printer.allowJump = false
  printer.sprintMode = 'always'
  if (printer.placeRange === undefined || printer.placeRange < 5) printer.placeRange = 5
  if (printer.minPlaceDistance === undefined || printer.minPlaceDistance > 0.35) printer.minPlaceDistance = 0.35
  if (adv.vanillaSpeedEnabled === undefined) adv.vanillaSpeedEnabled = true
  if (adv.vanillaSpeedBps === undefined) adv.vanillaSpeedBps = 7.192
  if (adv.vanillaStepHeight === undefined || adv.vanillaStepHeight < 1.25) adv.vanillaStepHeight = 1.25
  if (adv.vanillaSpeedInLiquids === undefined) adv.vanillaSpeedInLiquids = false
  if (adv.vanillaSpeedOnlyOnGround === undefined) adv.vanillaSpeedOnlyOnGround = true
  if (adv.vanillaSpeedPlatformOnly === undefined) adv.vanillaSpeedPlatformOnly = true
  if (adv.vanillaSpeedSetbackFallbackMs === undefined) adv.vanillaSpeedSetbackFallbackMs = 3000
  if (adv.latencySafeModeEnterMs === undefined || adv.latencySafeModeEnterMs === 90) adv.latencySafeModeEnterMs = 300
  if (adv.latencySafeModeResumeMs === undefined || adv.latencySafeModeResumeMs === 85) adv.latencySafeModeResumeMs = 280
  if (adv.dumpInventoryStableMs === undefined || adv.dumpInventoryStableMs === 400 || adv.dumpInventoryStableMs === 2500) adv.dumpInventoryStableMs = 1200
  if (adv.machineAccessSprintMode === undefined || adv.machineAccessSprintMode === 'disabled') adv.machineAccessSprintMode = 'enabled'
  if (adv.machineAccessPreciseVerticalTolerance === undefined || adv.machineAccessPreciseVerticalTolerance < 1.25) adv.machineAccessPreciseVerticalTolerance = 1.25
  if (adv.inventoryRefillRows === undefined || adv.inventoryRefillRows < 4) adv.inventoryRefillRows = 4
  if (adv.autoEatTargetHunger === undefined || adv.autoEatTargetHunger < 18) adv.autoEatTargetHunger = 20
  if (adv.autoEatMinHunger === undefined || adv.autoEatMinHunger < 16) adv.autoEatMinHunger = 16
  if (adv.scannerLineEndSettleMs === undefined || adv.scannerLineEndSettleMs < 250) adv.scannerLineEndSettleMs = 250

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
