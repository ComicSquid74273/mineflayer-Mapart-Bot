function createPlacementWorkload(deps) {
  const {
    toNumber,
    delay,
    GoalNear,
    estimateNeededFromLookahead,
    restockMaterial,
    countInventoryItems,
    findNervScannerCandidate,
    placeNervScannerTarget
  } = deps

  function buildNervUCheckpoints(batchTargets, startOnNorthSide) {
    const minX = Math.min(...batchTargets.map((target) => target.position.x))
    const minY = Math.min(...batchTargets.map((target) => target.position.y))
    const minZ = Math.min(...batchTargets.map((target) => target.position.z))
    const maxZ = Math.max(...batchTargets.map((target) => target.position.z))
    const activeCols = new Set(batchTargets.map((target) => target.col))
    const cp1 = { x: minX + 0.5, y: minY, z: minZ + 0.5 }
    const cp2 = { x: minX + 0.5, y: minY, z: maxZ + 0.5 }

    return startOnNorthSide
      ? [{ position: cp1, action: '', activeCols }, { position: cp2, action: 'lineEnd', activeCols }]
      : [{ position: cp2, action: '', activeCols }, { position: cp1, action: 'lineEnd', activeCols }]
  }

  function getMissingTargets(bot, batchTargets) {
    const Vec3 = bot.entity.position.constructor
    return batchTargets.filter((target) => {
      const actual = bot.blockAt(new Vec3(target.position.x, target.position.y, target.position.z))
      return actual?.name !== target.blockName
    })
  }

  function getTargetKey(target) {
    return `${target.position.x}:${target.position.y}:${target.position.z}`
  }

  function confirmTargetPlaced(bot, target) {
    const Vec3 = bot.entity.position.constructor
    const actual = bot.blockAt(new Vec3(target.position.x, target.position.y, target.position.z))
    return actual?.name === target.blockName
  }

  function applyAdaptiveSlowdown(config, missingCount, batchSize, label) {
    const advanced = config.advanced || {}
    if (advanced.scannerAdaptiveSlowdown === false || batchSize <= 0) return false

    const threshold = Math.max(1, toNumber(advanced.scannerAdaptiveMissingThreshold, 32))
    const recoverThreshold = Math.max(0, toNumber(advanced.scannerAdaptiveRecoverThreshold, 6))
    const isBad = missingCount > threshold
    const isGood = missingCount <= recoverThreshold

    if (!isBad && !isGood) return false

    const oldSettle = Math.max(0, toNumber(advanced.scannerLineEndSettleMs, 0))
    const oldDelay = Math.max(1, toNumber(advanced.scannerPlaceDelayMs, 8))
    const settleStep = Math.max(0, toNumber(advanced.scannerAdaptiveSettleStepMs, 1000))
    const delayStep = Math.max(0, toNumber(advanced.scannerAdaptivePlaceDelayStepMs, 2))
    const maxSettle = Math.max(oldSettle, toNumber(advanced.scannerAdaptiveMaxSettleMs, 7000))
    const maxDelay = Math.max(oldDelay, toNumber(advanced.scannerAdaptiveMaxPlaceDelayMs, 16))
    const minSettle = Math.max(0, toNumber(advanced.scannerAdaptiveMinSettleMs, 1500))
    const minDelay = Math.max(1, toNumber(advanced.scannerAdaptiveMinPlaceDelayMs, 6))

    if (isBad) {
      const nextSettle = Math.min(maxSettle, oldSettle + settleStep)
      const nextDelay = Math.min(maxDelay, oldDelay + delayStep)
      advanced.scannerLineEndSettleMs = nextSettle
      advanced.scannerPlaceDelayMs = nextDelay
      console.log(`[${label}-ADAPT-SLOW] missing=${missingCount}/${batchSize} placeDelayMs=${oldDelay}->${nextDelay} lineEndSettleMs=${oldSettle}->${nextSettle}`)
      return true
    }

    const nextSettle = Math.max(minSettle, oldSettle - settleStep)
    const nextDelay = Math.max(minDelay, oldDelay - delayStep)
    if (nextSettle !== oldSettle || nextDelay !== oldDelay) {
      advanced.scannerLineEndSettleMs = nextSettle
      advanced.scannerPlaceDelayMs = nextDelay
      console.log(`[${label}-ADAPT-RECOVER] missing=${missingCount}/${batchSize} placeDelayMs=${oldDelay}->${nextDelay} lineEndSettleMs=${oldSettle}->${nextSettle}`)
      return true
    }

    return false
  }

  async function runNervScannerPlacementBatch(bot, config, batchTargets, startOnNorthSide, allowEmergencyRestock = true) {
    if (!batchTargets.length) return { placed: 0, already: 0, skipped: 0, seen: 0, missing: 0 }

    const printer = config.printer || {}
    const advanced = config.advanced || {}
    const tickMs = Math.max(10, toNumber(printer.fastTraversalTickMs, 40))
    const maxPerTick = Math.max(1, toNumber(printer.maxPlacementsPerTick, 1))
    const lineEndSettleMs = Math.max(0, toNumber(config.advanced?.scannerLineEndSettleMs, toNumber(printer.fastTraversalCatchupStallMs, 0)))
    const checkpointBuffer = Math.max(0.5, toNumber(config.advanced?.checkpointBuffer, 0.8))
    const retryCooldownMs = Math.max(0, toNumber(advanced.scannerRetryCooldownMs, 30))
    const checkpoints = buildNervUCheckpoints(batchTargets, startOnNorthSide)
    const targetByXZ = new Map(batchTargets.map((target) => [`${target.position.x}:${target.position.z}`, target]))
    const neededByBlock = estimateNeededFromLookahead(batchTargets)

    let active = true
    let currentGoal = checkpoints[0].position
    let currentAction = checkpoints[0].action
    let currentActiveCols = checkpoints[0].activeCols
    let placed = 0
    let already = 0
    let skipped = 0
    let emergencyRestockBlock = null
    const seen = new Set()
    const pendingUntil = new Map()

    const placementLoop = (async () => {
      while (active) {
        const allowPlacement = currentAction === '' || currentAction === 'lineEnd' || currentAction === 'sprint'
        if (allowPlacement) {
          const now = Date.now()
          const burstExcluded = new Set(seen)
          for (const [key, until] of pendingUntil.entries()) {
            if (until > now) burstExcluded.add(key)
            else pendingUntil.delete(key)
          }

          for (let i = 0; i < maxPerTick; i += 1) {
            const target = findNervScannerCandidate(bot, config, targetByXZ, currentGoal, burstExcluded, currentActiveCols)
            if (!target) break

            const key = getTargetKey(target)
            burstExcluded.add(key)

            try {
              const result = await placeNervScannerTarget(bot, config, target)
              const confirmed = confirmTargetPlaced(bot, target)

              if (confirmed) {
                seen.add(key)
                pendingUntil.delete(key)
              } else if (result.state === 'placed') {
                pendingUntil.set(key, Date.now() + retryCooldownMs)
              }

              if (result.state === 'placed') {
                placed += 1
              } else if (result.state === 'already') {
                already += 1
                seen.add(key)
                pendingUntil.delete(key)
              } else {
                skipped += 1
                if (!String(result.reason || '').startsWith('missing-item-')) {
                  pendingUntil.set(key, Date.now() + retryCooldownMs)
                }
                if (config.errorHandling?.logErrors !== false) {
                  console.log(`[NERV-SCANNER-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
                }
                if (allowEmergencyRestock && String(result.reason || '').startsWith('missing-item-')) {
                  emergencyRestockBlock = target.blockName
                  active = false
                  break
                }
              }
            } catch (err) {
              skipped += 1
              pendingUntil.set(key, Date.now() + retryCooldownMs)
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[NERV-SCANNER-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
              }
            }
          }
        }

        await delay(tickMs)
      }
    })()

    try {
      for (const checkpoint of checkpoints) {
        if (emergencyRestockBlock) break
        currentGoal = checkpoint.position
        currentAction = checkpoint.action
        currentActiveCols = checkpoint.activeCols
        const sprintMode = String(printer.sprintMode || 'notPlacing').toLowerCase()
        const shouldSprint = sprintMode === 'always' || (sprintMode !== 'off' && currentAction === 'sprint')
        bot.setControlState('sprint', shouldSprint)
        await bot.pathfinder.goto(new GoalNear(checkpoint.position.x, checkpoint.position.y, checkpoint.position.z, checkpointBuffer))
        if (checkpoint.action === 'lineEnd' && lineEndSettleMs > 0 && !emergencyRestockBlock) {
          await delay(lineEndSettleMs)
        }
      }
    } finally {
      active = false
      await placementLoop
    }

    if (allowEmergencyRestock && emergencyRestockBlock) {
      console.log(`[NERV-SCANNER-EMERGENCY-RESTOCK] ${emergencyRestockBlock} unavailable during placement; stopping movement, refilling, and retrying remaining targets once.`)
      const restocked = await restockMaterial(bot, config, emergencyRestockBlock, 1, neededByBlock)
      if (restocked || countInventoryItems(bot, emergencyRestockBlock) > 0) {
        const Vec3Retry = bot.entity.position.constructor
        const remainingTargets = batchTargets.filter((target) => {
          const actual = bot.blockAt(new Vec3Retry(target.position.x, target.position.y, target.position.z))
          return actual?.name !== target.blockName
        })
        if (remainingTargets.length) {
          const retry = await runNervScannerPlacementBatch(bot, config, remainingTargets, startOnNorthSide, false)
          placed += retry.placed
          already += retry.already
          skipped += retry.skipped
        }
      }
    }

    const missing = getMissingTargets(bot, batchTargets).length

    return { placed, already, skipped, seen: batchTargets.length - missing, missing }
  }

  async function runNervTimeWorkloadPlacementBatch(bot, config, batchTargets, startOnNorthSide, allowEmergencyRestock = true) {
    if (!batchTargets.length) {
      return { placed: 0, already: 0, skipped: 0, seen: 0, missing: 0, hardStops: 0, rawAllowed: 0, capped: 0, maxAllowed: 0 }
    }

    const printer = config.printer || {}
    const advanced = config.advanced || {}
    const placeDelayMs = Math.max(1, toNumber(advanced.scannerPlaceDelayMs, toNumber(printer.placeDelayMs, 10)))
    const maxCatchup = Math.max(1, toNumber(advanced.scannerMaxCatchupPlacements, 12))
    const pollMs = Math.max(1, toNumber(advanced.scannerWorkloadPollMs, Math.min(10, placeDelayMs)))
    const retryCooldownMs = Math.max(0, toNumber(advanced.scannerRetryCooldownMs, 30))
    const lineEndSettleMs = Math.max(0, toNumber(advanced.scannerLineEndSettleMs, toNumber(printer.fastTraversalCatchupStallMs, 0)))
    const checkpointBuffer = Math.max(0.5, toNumber(advanced.checkpointBuffer, 0.8))
    const checkpoints = buildNervUCheckpoints(batchTargets, startOnNorthSide)
    const targetByXZ = new Map(batchTargets.map((target) => [`${target.position.x}:${target.position.z}`, target]))
    const neededByBlock = estimateNeededFromLookahead(batchTargets)

    let active = true
    let currentGoal = checkpoints[0].position
    let currentAction = checkpoints[0].action
    let currentActiveCols = checkpoints[0].activeCols
    let lastTickTime = Date.now()
    let placed = 0
    let already = 0
    let skipped = 0
    let hardStops = 0
    let rawAllowedTotal = 0
    let cappedTotal = 0
    let maxAllowedSeen = 0
    let emergencyRestockBlock = null
    const seen = new Set()
    const pendingUntil = new Map()

    const placementLoop = (async () => {
      while (active) {
        const now = Date.now()
        const rawAllowed = Math.floor((now - lastTickTime) / placeDelayMs)

        if (rawAllowed <= 0) {
          await delay(pollMs)
          continue
        }

        lastTickTime += rawAllowed * placeDelayMs
        rawAllowedTotal += rawAllowed
        const allowed = Math.min(rawAllowed, maxCatchup)
        cappedTotal += Math.max(0, rawAllowed - allowed)
        maxAllowedSeen = Math.max(maxAllowedSeen, rawAllowed)

        const allowPlacement = currentAction === '' || currentAction === 'lineEnd' || currentAction === 'sprint'
        if (allowPlacement) {
          const burstExcluded = new Set(seen)
          for (const [key, until] of pendingUntil.entries()) {
            if (until > now) burstExcluded.add(key)
            else pendingUntil.delete(key)
          }

          for (let i = 0; i < allowed; i += 1) {
            const target = findNervScannerCandidate(bot, config, targetByXZ, currentGoal, burstExcluded, currentActiveCols)
            if (!target) break

            const key = getTargetKey(target)
            const neededSwap = String(bot.heldItem?.name || '') !== target.blockName
            burstExcluded.add(key)

            try {
              const result = await placeNervScannerTarget(bot, config, target)
              const confirmed = confirmTargetPlaced(bot, target)

              if (confirmed) {
                seen.add(key)
                pendingUntil.delete(key)
              } else if (result.state === 'placed') {
                pendingUntil.set(key, Date.now() + retryCooldownMs)
              }

              if (result.state === 'placed') {
                placed += 1
              } else if (result.state === 'already') {
                already += 1
                seen.add(key)
                pendingUntil.delete(key)
              } else {
                skipped += 1
                if (!String(result.reason || '').startsWith('missing-item-')) {
                  pendingUntil.set(key, Date.now() + retryCooldownMs)
                }
                if (config.errorHandling?.logErrors !== false) {
                  console.log(`[NERV-WORKLOAD-SKIP] ${target.position.x} ${target.position.y} ${target.position.z} (${result.reason})`)
                }

                if (String(result.reason || '').startsWith('missing-item-')) {
                  hardStops += 1
                  if (allowEmergencyRestock) {
                    emergencyRestockBlock = target.blockName
                    active = false
                  }
                  lastTickTime = Date.now()
                  break
                }
              }
            } catch (err) {
              skipped += 1
              hardStops += 1
              if (config.errorHandling?.logErrors !== false) {
                console.log(`[NERV-WORKLOAD-ERR] ${target.position.x} ${target.position.y} ${target.position.z} -> ${err?.message || err}`)
              }
              lastTickTime = Date.now()
              break
            }

            if (neededSwap) {
              hardStops += 1
              lastTickTime = Date.now()
              break
            }
          }
        }

        await delay(pollMs)
      }
    })()

    try {
      for (const checkpoint of checkpoints) {
        if (emergencyRestockBlock) break
        currentGoal = checkpoint.position
        currentAction = checkpoint.action
        currentActiveCols = checkpoint.activeCols
        const sprintMode = String(printer.sprintMode || 'notPlacing').toLowerCase()
        const shouldSprint = sprintMode === 'always' || (sprintMode !== 'off' && currentAction === 'sprint')
        bot.setControlState('sprint', shouldSprint)
        await bot.pathfinder.goto(new GoalNear(checkpoint.position.x, checkpoint.position.y, checkpoint.position.z, checkpointBuffer))
        if (checkpoint.action === 'lineEnd' && lineEndSettleMs > 0 && !emergencyRestockBlock) {
          await delay(lineEndSettleMs)
        }
      }
    } finally {
      active = false
      await placementLoop
    }

    if (allowEmergencyRestock && emergencyRestockBlock) {
      console.log(`[NERV-WORKLOAD-EMERGENCY-RESTOCK] ${emergencyRestockBlock} unavailable during placement; stopping movement, refilling, and retrying remaining targets once.`)
      const restocked = await restockMaterial(bot, config, emergencyRestockBlock, 1, neededByBlock)
      if (restocked || countInventoryItems(bot, emergencyRestockBlock) > 0) {
        const Vec3Retry = bot.entity.position.constructor
        const remainingTargets = batchTargets.filter((target) => {
          const actual = bot.blockAt(new Vec3Retry(target.position.x, target.position.y, target.position.z))
          return actual?.name !== target.blockName
        })
        if (remainingTargets.length) {
          const retry = await runNervTimeWorkloadPlacementBatch(bot, config, remainingTargets, startOnNorthSide, false)
          placed += retry.placed
          already += retry.already
          skipped += retry.skipped
          hardStops += retry.hardStops
          rawAllowedTotal += retry.rawAllowed
          cappedTotal += retry.capped
          maxAllowedSeen = Math.max(maxAllowedSeen, retry.maxAllowed)
        }
      }
    }

    const missingTargets = getMissingTargets(bot, batchTargets)
    const missing = missingTargets.length
    applyAdaptiveSlowdown(config, missing, batchTargets.length, 'NERV-WORKLOAD')

    return {
      placed,
      already,
      skipped,
      seen: batchTargets.length - missing,
      missing,
      hardStops,
      rawAllowed: rawAllowedTotal,
      capped: cappedTotal,
      maxAllowed: maxAllowedSeen
    }
  }

  return {
    buildNervUCheckpoints,
    runNervScannerPlacementBatch,
    runNervTimeWorkloadPlacementBatch
  }
}

module.exports = { createPlacementWorkload }
