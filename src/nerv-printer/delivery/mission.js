// GetAllMaps mission runtime for the delivery bot.
//
// The mission is a persisted state machine so the bot can resume mid-mission
// after disconnects, restarts and /tpa cooldown waits:
//
//   idle -> preparing -> selecting -> traveling -> collecting -> returning
//        -> depositing -> restocking -> selecting ... -> completed -> idle
//
// Error states: waiting-home (home unavailable), halted-mismatch (map ledger
// violation), halted-error (repeated stage failures), halted-death (the bot
// died — on 6b6t this drops the inventory, so carried maps may be on the
// ground). All of them surface a dashboard alert and never drop items silently.
//
// Zero-loss ledger invariant, checked at every checkpoint:
//   ledger.collected === ledger.deposited + maps currently carried

const fs = require('fs')
const path = require('path')

const stationLib = require('./station')
const bundlesLib = require('./bundles')
const cooldownsLib = require('./cooldowns')

const MISSION_STATE_VERSION = 1

function isTargetStatusFresh(value, maxAgeMs, now = Date.now()) {
  const timestamp = new Date(value || 0).getTime()
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false
  const age = now - timestamp
  return age >= -5000 && age <= Math.max(5000, Number(maxAgeMs) || 20000)
}

function shouldEatAtStation({ position, station, health, hunger, healthThreshold = 12, hungerThreshold = 12 } = {}) {
  if (!stationLib.isAtStation(position, station)) return false
  const currentHunger = Number(hunger)
  if (!Number.isFinite(currentHunger) || currentHunger >= 20) return false
  const currentHealth = Number(health)
  const lowHealth = Number.isFinite(currentHealth) && currentHealth <= Number(healthThreshold)
  const lowHunger = currentHunger <= Number(hungerThreshold)
  return lowHealth || lowHunger
}

// Pure decision for what to do when the delivery bot dies. On 6b6t death drops
// the whole inventory, so a death mid-mission means carried maps may be on the
// ground: alert (error level) and halt the active mission for operator recovery.
function buildDeathOutcome({ settings = {}, position = null, mapsAtRisk = 0, missionActive = false } = {}) {
  const atRisk = Math.max(0, Number(mapsAtRisk) || 0)
  const where = position && Number.isFinite(position.x)
    ? `(${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)})`
    : 'an unknown location'
  const message = atRisk > 0
    ? `Delivery bot DIED at ${where} while carrying ${atRisk} map(s) — inventory likely dropped. Recover the dropped items, then start a new GetAllMaps.`
    : `Delivery bot DIED at ${where}.`
  return {
    alert: settings.alertOnDeath !== false
      ? { category: 'delivery-bot-died', level: 'error', message, detail: { position: position || null, mapsAtRisk: atRisk } }
      : null,
    halt: missionActive === true && settings.haltMissionOnDeath !== false
  }
}

function createDeliveryRuntime(deps) {
  const {
    toNumber,
    delay,
    log = console.log,
    isBotSessionLive,
    isOperatorPaused,
    ensureFoodBeforeTraversal,
    setDashboardAlert,
    clearDashboardAlert,
    classifyRuntimePosition,
    GoalNear
  } = deps

  const bundleOps = bundlesLib.createBundleOps(deps)

  function deliverySettings(config) {
    const delivery = config?.delivery || {}
    const advanced = config?.advanced || {}
    const food = delivery.food || {}
    const cooldowns = delivery.cooldowns || {}
    const teleport = delivery.teleport || {}
    return {
      missionStateFile: path.resolve(process.cwd(), String(delivery.missionStateFile || './logs/delivery-mission-state.json')),
      homeCommand: String(delivery.homeCommand || '/home').trim() || '/home',
      homeName: String(delivery.homeName || 'platform').trim() || 'platform',
      tpaCommand: String(delivery.tpaCommand || '/tpa').trim() || '/tpa',
      fallbackTpaMs: Math.max(0, toNumber(cooldowns.fallbackTpaMs, 600000)),
      fallbackHomeMs: Math.max(0, toNumber(cooldowns.fallbackHomeMs, 600000)),
      extraDelayMs: Math.max(0, toNumber(cooldowns.extraDelayMs, 1500)),
      maxChatWaitMs: Math.max(1000, toNumber(cooldowns.maxChatWaitMs, 8000)),
      silentCommandRetryMs: Math.max(15000, toNumber(cooldowns.silentRetryMs, 20000)),
      arrivalTimeoutMs: Math.max(5000, toNumber(teleport.arrivalTimeoutMs, 20000)),
      arrivalPollMs: Math.max(100, toNumber(teleport.arrivalPollMs, 500)),
      postArrivalSettleMs: Math.max(0, toNumber(teleport.postArrivalSettleMs, 2500)),
      maxTravelRetries: Math.max(1, toNumber(teleport.maxRetries, 3)),
      homeRetryMs: Math.max(5000, toNumber(delivery.homeRetryMs, 60000)),
      dashboardPlanRefreshMs: Math.max(5000, toNumber(delivery.dashboardPlanRefreshMs, 30000)),
      targetReadyRetryMs: Math.max(5000, toNumber(delivery.targetReadyRetryMs, 5000)),
      targetStatusFreshMs: Math.max(15000, toNumber(delivery.targetStatusFreshMs, 20000)),
      maxStageErrors: Math.max(1, toNumber(delivery.maxStageErrors, 5)),
      walkGoalRange: Math.max(1, toNumber(delivery.walkGoalRange, 2)),
      idlePollMs: Math.max(250, toNumber(delivery.idlePollMs, 1000)),
      foodEnabled: food.enabled !== false && advanced.autoEatEnabled !== false,
      foodItem: String(food.itemName || advanced.autoEatFoodItem || 'cooked_beef').replace(/^minecraft:/, ''),
      foodHealthThreshold: Math.max(0, Math.min(20, toNumber(food.healthThreshold, toNumber(advanced.autoEatMinHealth, 12)))),
      foodHungerThreshold: Math.max(0, Math.min(20, toNumber(food.hungerThreshold, toNumber(advanced.autoEatMinHunger, 12)))),
      foodTargetHunger: Math.max(0, Math.min(20, toNumber(food.targetHunger, toNumber(advanced.autoEatTargetHunger, 20)))),
      foodCheckIntervalMs: Math.max(1000, toNumber(food.checkIntervalMs, 5000)),
      returnUnusedFood: food.returnUnusedFood !== false && advanced.autoEatReturnUnusedFood !== false,
      alertOnDeath: (delivery.death?.alertEnabled ?? delivery.alertOnDeath) !== false,
      haltMissionOnDeath: (delivery.death?.haltMissionOnDeath ?? delivery.haltMissionOnDeath) !== false
    }
  }

  // ---------- persistence ----------

  function readMissionState(settings) {
    try {
      const raw = fs.readFileSync(settings.missionStateFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.version === MISSION_STATE_VERSION) return parsed
    } catch { }
    return null
  }

  function writeMissionState(settings, state) {
    try {
      state.updatedAt = new Date().toISOString()
      fs.mkdirSync(path.dirname(settings.missionStateFile), { recursive: true })
      fs.writeFileSync(settings.missionStateFile, JSON.stringify(state, null, 2))
    } catch (err) {
      log(`[DELIVERY-WARN] failed to persist mission state: ${err?.message || err}`)
    }
  }

  function targetReady(target) {
    const retryAfterAt = Math.max(0, Number(target?.retryAfterAt || 0))
    return target?.online === true
      && target?.platformReady === true
      && (!retryAfterAt || Date.now() >= retryAfterAt)
  }

  function targetWaitState(target) {
    return target?.online === false ? 'offline' : 'notready'
  }

  function targetIsCollectablePending(target) {
    return ['pending', 'active', 'offline', 'notready'].includes(String(target?.state || ''))
  }

  function newMissionState(targets) {
    return {
      version: MISSION_STATE_VERSION,
      missionId: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'active', // active | completed | aborted | halted-mismatch | halted-error | halted-death
      stage: 'preparing',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      abortRequested: false,
      currentTargetIndex: -1,
      targets: targets.map((target) => ({
        botName: target.botName,
        anchor: target.anchor,
        hostLabel: target.hostLabel || null,
        source: target.source || 'dashboard',
        state: target.platformReady === true ? 'pending' : targetWaitState(target), // pending | active | offline | notready | done | unreachable
        online: target.online ?? null,
        platformReady: target.platformReady === true,
        readiness: target.readiness || (target.platformReady === true ? 'ready' : 'unknown'),
        readinessDetail: target.readinessDetail || null,
        location: target.location || null,
        locationDetail: target.locationDetail || null,
        lastStatusAt: target.lastStatusAt || null,
        retryAfterAt: 0,
        chests: {},
        mapsCollected: 0,
        travelRetries: 0
      })),
      ledger: { collected: 0, deposited: 0 },
      cooldowns: {},
      counters: { trips: 0, bundleRestocks: 0, stageErrors: 0 }
    }
  }

  // ---------- helpers ----------

  function botPosition(bot) {
    const pos = bot?.entity?.position
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null
    return { x: pos.x, y: pos.y, z: pos.z }
  }

  function currentTarget(state) {
    if (!state || state.currentTargetIndex < 0) return null
    return state.targets[state.currentTargetIndex] || null
  }

  function carriedMaps(bot, config) {
    return bundleOps.carriedState(bot, config).maps
  }

  function checkLedger(bot, config, state) {
    const carried = carriedMaps(bot, config)
    const expectedCarried = state.ledger.collected - state.ledger.deposited
    return {
      ok: carried.total === expectedCarried,
      carried: carried.total,
      expectedCarried,
      collected: state.ledger.collected,
      deposited: state.ledger.deposited
    }
  }

  function describeLocation(bot, config) {
    try {
      const runtime = classifyRuntimePosition(bot, config, 'delivery-status')
      return runtime?.classification?.state || 'unknown'
    } catch {
      return 'unknown'
    }
  }

  // ---------- the runtime ----------

  return function createMissionLoop(bot, config, runtimeControl, dashboardRuntime) {
    const settings = deliverySettings(config)
    const station = () => stationLib.resolveStation(config.delivery, mission.plan?.station || null)

    const mission = {
      state: null,
      plan: null,
      planFetchedAt: 0,
      cooldowns: null,
      died: false,
      lastFoodCheckAt: 0
    }

    function restockTargetCount(state = mission.state) {
      const targets = Array.isArray(state?.targets) ? state.targets : []
      const pending = targets.filter((entry) => targetIsCollectablePending(entry)).length
      // One platform is visited per trip, followed by a station deposit.
      // Carry only the bundle budget needed for that current platform.
      return pending > 0 || targets.length > 0 || planTargets().length > 0 ? 1 : 0
    }

    function persist() {
      if (!mission.state) return
      if (mission.cooldowns) mission.state.cooldowns = mission.cooldowns.toJSON()
      writeMissionState(settings, mission.state)
    }

    function buildCooldowns(saved = {}) {
      return new cooldownsLib.CooldownManager(
        { tpa: settings.fallbackTpaMs, home: settings.fallbackHomeMs, accept: settings.fallbackTpaMs },
        saved || {}
      )
    }

    function shouldAbortWaits() {
      return !isBotSessionLive(bot) ||
        bot.__nervSessionActive === false ||
        mission.died === true ||
        runtimeControl?.isStopRequested() === true ||
        dashboardRuntime?.isStopRequested?.() === true ||
        dashboardRuntime?.hasStopMissionRequest?.() === true
    }

    async function maybeEatAtStation(reason = 'delivery-station') {
      if (!settings.foodEnabled || typeof ensureFoodBeforeTraversal !== 'function') return false
      const home = station()
      if (!shouldEatAtStation({
        position: botPosition(bot),
        station: home,
        health: bot?.health,
        hunger: bot?.food,
        healthThreshold: settings.foodHealthThreshold,
        hungerThreshold: settings.foodHungerThreshold
      })) return false

      const now = Date.now()
      if (now - mission.lastFoodCheckAt < settings.foodCheckIntervalMs) return false
      mission.lastFoodCheckAt = now

      reportStatus('delivery:eating')
      try {
        const foodReady = await ensureFoodBeforeTraversal(bot, config, reason, {
          enabled: true,
          force: true,
          inclusiveTrigger: true,
          foodItem: settings.foodItem,
          hungerThreshold: settings.foodHungerThreshold,
          healthThreshold: settings.foodHealthThreshold,
          targetHunger: Math.max(settings.foodHungerThreshold + 1, settings.foodTargetHunger),
          foodChest: {
            enabled: true,
            position: home.foodChest,
            accessPosition: home.openPosition
          },
          returnUnusedFood: settings.returnUnusedFood,
          returnUnusedFoodAlways: true,
          allowDumpForSpace: false
        })
        if (foodReady) clearDashboardAlert(config, 'food-supply')
      } catch (err) {
        log(`[DELIVERY-FOOD-WARN] ${reason}: ${err?.message || err}; continuing mission`)
        setDashboardAlert(config, 'food-supply', `Delivery food check failed: ${err?.message || err}`, {
          reason,
          chest: home.foodChest,
          item: settings.foodItem
        }, 'warn')
      } finally {
        reportStatus()
      }
      return true
    }

    function knownTargetsForPlace(state) {
      const byName = new Map()
      for (const target of Array.isArray(state?.targets) ? state.targets : []) {
        if (target?.botName && target?.anchor) byName.set(target.botName, target)
      }
      for (const target of planTargets()) {
        if (target?.botName && target?.anchor) byName.set(target.botName, { ...(byName.get(target.botName) || {}), ...target })
      }
      return Array.from(byName.values())
    }

    function describeDeliveryPlace(state) {
      const pos = botPosition(bot)
      const runtimeLocation = describeLocation(bot, config)
      const home = station()
      if (stationLib.isAtStation(pos, home)) {
        return {
          kind: 'delivery-station',
          label: 'Delivery Station',
          detail: 'at delivery station'
        }
      }

      for (const target of knownTargetsForPlace(state)) {
        const geometry = stationLib.getTargetGeometry(target.anchor, config?.delivery?.chests || {})
        if (!geometry?.platformBounds || !stationLib.isInsideBounds(pos, geometry.platformBounds)) continue
        const label = target.hostLabel || target.botName
        return {
          kind: 'printer-platform',
          label: `${label} Platform`,
          botName: target.botName,
          hostLabel: target.hostLabel || null,
          detail: `at ${label} platform`
        }
      }

      const normalizedLocation = String(runtimeLocation || '').toLowerCase()
      if (normalizedLocation.includes('lobby')) {
        return { kind: 'lobby', label: runtimeLocation, detail: runtimeLocation }
      }
      if (normalizedLocation.includes('spawn')) {
        return { kind: 'spawn', label: runtimeLocation, detail: runtimeLocation }
      }
      if (normalizedLocation === 'missing-position' || normalizedLocation === 'unknown') {
        return { kind: 'unknown', label: 'Unknown', detail: runtimeLocation || 'unknown' }
      }
      return {
        kind: 'away',
        label: runtimeLocation || 'Away',
        detail: runtimeLocation || 'away from delivery station'
      }
    }

    function reportStatus(stageDetail = null) {
      const state = mission.state
      const carried = bundleOps.carriedState(bot, config)
      const target = currentTarget(state)
      const doneCount = state ? state.targets.filter((entry) => entry.state === 'done').length : 0
      const waitingTargets = state
        ? state.targets.filter((entry) => targetIsCollectablePending(entry) && !targetReady(entry))
        : []
      const currentPlace = describeDeliveryPlace(state)
      const payload = {
        missionId: state?.missionId || null,
        missionStatus: state?.status || 'idle',
        stage: state?.stage || 'idle',
        currentPlace,
        targetBot: target?.botName || null,
        targetReadiness: target
          ? {
              online: target.online ?? null,
              platformReady: target.platformReady === true,
              readiness: target.readiness || (targetReady(target) ? 'ready' : targetWaitState(target)),
              detail: target.readinessDetail || null,
              location: target.locationDetail || target.location || null,
              lastStatusAt: target.lastStatusAt || null
            }
          : null,
        targetIndex: state ? state.currentTargetIndex : -1,
        targetCount: state?.targets?.length || 0,
        targetsDone: doneCount,
        targetsWaiting: waitingTargets.length,
        waitingTargets: waitingTargets.map((entry) => ({
          botName: entry.botName,
          state: entry.state,
          online: entry.online ?? null,
          platformReady: entry.platformReady === true,
          readiness: entry.readiness || targetWaitState(entry),
          detail: entry.readinessDetail || null,
          location: entry.locationDetail || entry.location || null,
          lastStatusAt: entry.lastStatusAt || null
        })),
        mapsCollected: state?.ledger?.collected || 0,
        mapsDeposited: state?.ledger?.deposited || 0,
        mapsCarried: carried.maps.total,
        bundlesCarried: carried.bundles.total,
        emptyBundles: carried.bundles.empty,
        ledgerOk: state ? checkLedger(bot, config, state).ok : true,
        stationLocation: currentPlace.kind === 'delivery-station' ? 'at-station' : 'away',
        location: describeLocation(bot, config),
        cooldowns: mission.cooldowns
          ? {
              tpaReadyAt: mission.cooldowns.readyAt('delivery', 'tpa') || 0,
              homeReadyAt: mission.cooldowns.readyAt('delivery', 'home') || 0
            }
          : null
      }
      dashboardRuntime?.setDeliveryStatus?.(payload)
      if (state && ['active'].includes(state.status)) {
        dashboardRuntime?.setPhase?.('printing', stageDetail || `delivery:${state.stage}`)
        dashboardRuntime?.setCurrentNbt?.(target ? `target:${target.botName}` : null)
      }
    }

    function requestInventoryResync(reason) {
      const text = reason || 'delivery inventory resync'
      log(`[DELIVERY-WARN] ${text}; reconnecting to refresh server-authoritative bundle contents`)
      setDashboardAlert(config, 'delivery-inventory-resync', text, {}, 'warn')
      try {
        bot.quit(text)
      } catch {
        try { bot._client?.end?.(text) } catch { }
      }
    }

    async function refreshPlan(force = false) {
      const now = Date.now()
      if (!force && mission.plan && now - mission.planFetchedAt < settings.dashboardPlanRefreshMs) return mission.plan
      try {
        const plan = await dashboardRuntime?.fetchDeliveryPlan?.()
        mission.planFetchedAt = now
        if (plan && typeof plan === 'object') {
          mission.plan = plan
        }
      } catch (err) {
        mission.planFetchedAt = now
        log(`[DELIVERY-WARN] delivery plan fetch failed: ${err?.message || err}`)
      }
      return mission.plan
    }

    function normalizePlanTarget(entry) {
      if (!entry || entry.enabled === false || !entry.botName) return null
      const anchor = stationLib.toPoint(entry.anchor)
      if (!anchor) return null
      const statusFresh = isTargetStatusFresh(entry.lastStatusAt, settings.targetStatusFreshMs)
      const online = statusFresh && entry.online === true ? true : false
      const platformReady = statusFresh && online && entry.platformReady === true
      return {
        botName: String(entry.botName),
        anchor,
        hostLabel: entry.hostLabel || null,
        source: entry.source || 'dashboard',
        online,
        platformReady,
        readiness: platformReady ? 'ready' : (online ? 'notready' : 'offline'),
        readinessDetail: statusFresh ? (entry.readinessDetail || null) : 'offline or stale delivery-target heartbeat',
        location: entry.location || null,
        locationDetail: entry.locationDetail || null,
        lastStatusAt: entry.lastStatusAt || null,
        phase: entry.phase || null,
        statusDetail: entry.statusDetail || null
      }
    }

    function planTargets() {
      const targets = Array.isArray(mission.plan?.targets) ? mission.plan.targets : []
      return targets
        .map(normalizePlanTarget)
        .filter(Boolean)
    }

    function copyTargetReadiness(target, latest) {
      if (!target || !latest) return
      const previousState = String(target.state || '')
      target.anchor = latest.anchor
      target.hostLabel = latest.hostLabel || null
      target.source = latest.source
      target.online = latest.online
      target.platformReady = latest.platformReady
      target.readiness = latest.readiness
      target.readinessDetail = latest.readinessDetail
      target.location = latest.location
      target.locationDetail = latest.locationDetail
      target.lastStatusAt = latest.lastStatusAt
      target.phase = latest.phase
      target.statusDetail = latest.statusDetail
      if (targetReady(target) && ['offline', 'notready'].includes(target.state)) {
        target.state = 'pending'
        target.travelRetries = 0
        target.retryAfterAt = 0
        log(`[DELIVERY] target ${target.botName} is back online on platform; retry queued`)
      } else if (!targetReady(target) && previousState === 'active') {
        target.state = targetWaitState(target)
      }
    }

    // Merge newly-appeared dashboard targets into a running mission and refresh
    // online/platform readiness for existing targets.
    function syncTargetsFromPlan() {
      if (!mission.state) return
      const latestByName = new Map(planTargets().map((target) => [target.botName, target]))
      for (const target of planTargets()) {
        const existing = mission.state.targets.find((entry) => entry.botName === target.botName)
        if (existing) {
          copyTargetReadiness(existing, target)
          continue
        }
        mission.state.targets.push({
          botName: target.botName,
          anchor: target.anchor,
          hostLabel: target.hostLabel || null,
          source: target.source,
          state: target.platformReady === true ? 'pending' : targetWaitState(target),
          online: target.online,
          platformReady: target.platformReady,
          readiness: target.readiness,
          readinessDetail: target.readinessDetail,
          location: target.location || null,
          locationDetail: target.locationDetail || null,
          lastStatusAt: target.lastStatusAt || null,
          retryAfterAt: 0,
          phase: target.phase || null,
          statusDetail: target.statusDetail || null,
          chests: {},
          mapsCollected: 0,
          travelRetries: 0
        })
        log(`[DELIVERY] new target appeared on dashboard: ${target.botName}`)
      }
      // Targets removed/disabled from the dashboard no longer become eligible
      // for /tpa; a completed target remains completed for the current mission.
      for (const target of mission.state.targets) {
        if (target.state === 'done') continue
        const latest = latestByName.get(target.botName)
        if (latest) continue
        if (['pending', 'active', 'offline', 'notready'].includes(target.state)) {
          target.online = false
          target.platformReady = false
          target.readiness = 'offline'
          target.readinessDetail = 'target disabled or no longer reporting in dashboard plan'
          target.state = 'offline'
        }
      }
    }

    async function sendWithCooldown(command, message) {
      return await cooldownsLib.sendCommandWithCooldown({
        bot,
        cooldowns: mission.cooldowns,
        command,
        message,
        actor: 'delivery',
        maxChatWaitMs: settings.maxChatWaitMs,
        extraDelayMs: settings.extraDelayMs,
        silentRetryMs: settings.silentCommandRetryMs,
        assumeFallbackCooldown: false,
        log,
        shouldAbort: shouldAbortWaits,
        onWait: ({ waitMs }) => {
          reportStatus(`delivery:waiting-cooldown:${Math.ceil(waitMs / 1000)}s`)
          persist()
        }
      })
    }

    async function waitForArrival(checkFn, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (shouldAbortWaits()) return false
        if (checkFn(botPosition(bot))) return true
        await delay(settings.arrivalPollMs)
      }
      return checkFn(botPosition(bot))
    }

    async function walkTo(point, range = settings.walkGoalRange) {
      if (!point) return
      const pos = botPosition(bot)
      if (pos && stationLib.horizontalDistance(pos, point) <= range && Math.abs(pos.y - point.y) <= 3) return
      const goal = new GoalNear(point.x, point.y, point.z, range)
      const promise = bot.pathfinder.goto(goal)
      promise.catch(() => { })
      await promise
    }

    // ---------- stages ----------

    async function stagePreparing() {
      const state = mission.state
      const home = station()
      if (!stationLib.isAtStation(botPosition(bot), home)) {
        // Not at the station: go home first (also covers resume-from-lobby).
        state.stage = 'returning'
        persist()
        return
      }
      // Safety: deposit anything carried from a previous run before (re)stocking.
      const carried = carriedMaps(bot, config)
      if (carried.total > 0) {
        log(`[DELIVERY] depositing ${carried.total} carried map(s) before starting`)
        const result = await bundleOps.depositAtStation(bot, config, home)
        // Maps deposited during preparation belong to the resumed ledger when present.
        if (state.ledger.collected > state.ledger.deposited) {
          state.ledger.deposited += result.depositedMaps
        }
        if (result.chestFull) {
          setDashboardAlert(config, 'delivery-drop-chest-full', 'Drop chest is full; cannot deposit maps', {}, 'error')
          state.status = 'halted-error'
          persist()
          return
        }
      }
      const restock = await bundleOps.restockEmptyBundles(bot, config, home, { targetCount: restockTargetCount(state) })
      state.counters.bundleRestocks += 1
      log(`[DELIVERY] bundle restock: +${restock.withdrawn}, returned ${restock.returned || 0}, split ${restock.split || 0}, target ${restock.desired || '?'} (carrying ${restock.carried.total}, empty ${restock.carried.empty})`)
      if (!bundleOps.hasCollectCapacity(bot, config)) {
        setDashboardAlert(config, 'delivery-no-bundles', 'No empty bundles available in the bundles chest', {}, 'error')
        state.status = 'halted-error'
        persist()
        return
      }
      clearDashboardAlert(config, 'delivery-no-bundles')
      state.stage = 'selecting'
      persist()
    }

    function stageSelecting() {
      const state = mission.state
      syncTargetsFromPlan()
      if (state.abortRequested) {
        state.status = 'aborted'
        state.stage = 'idle'
        persist()
        log('[DELIVERY] mission aborted by operator request')
        return
      }
      const activeIndex = state.targets.findIndex((entry) => entry.state === 'active')
      if (activeIndex >= 0) {
        const active = state.targets[activeIndex]
        state.currentTargetIndex = activeIndex
        if (!targetReady(active)) {
          active.state = targetWaitState(active)
          state.stage = 'waiting-targets'
          setDashboardAlert(config, 'delivery-target-not-ready', `${active.botName} is ${active.state}; waiting before sending /tpa`, {
            botName: active.botName,
            readiness: active.readiness,
            detail: active.readinessDetail || null
          }, 'warn')
          persist()
          return
        }
        state.stage = 'traveling'
        persist()
        return
      }

      const nextIndex = state.targets.findIndex((entry) => targetIsCollectablePending(entry) && targetReady(entry))
      if (nextIndex < 0) {
        const waitingIndex = state.targets.findIndex((entry) => targetIsCollectablePending(entry))
        if (waitingIndex >= 0) {
          for (const target of state.targets) {
            if (!targetIsCollectablePending(target) || targetReady(target)) continue
            target.state = targetWaitState(target)
          }
          state.currentTargetIndex = waitingIndex
          state.stage = 'waiting-targets'
          setDashboardAlert(config, 'delivery-target-not-ready', 'Waiting for delivery targets to come online and report platform-ready', {
            waitingTargets: state.targets
              .filter((entry) => targetIsCollectablePending(entry) && !targetReady(entry))
              .map((entry) => ({ botName: entry.botName, state: entry.state, readiness: entry.readiness, detail: entry.readinessDetail || null }))
          }, 'warn')
          persist()
          return
        }
        state.stage = 'completing'
        persist()
        return
      }
      state.currentTargetIndex = nextIndex
      state.targets[nextIndex].state = 'active'
      clearDashboardAlert(config, 'delivery-target-not-ready')
      state.stage = 'traveling'
      persist()
    }

    async function stageTraveling() {
      const state = mission.state
      if (state.abortRequested) {
        state.stage = 'returning'
        persist()
        return
      }
      const target = currentTarget(state)
      if (!target) {
        state.stage = 'selecting'
        persist()
        return
      }
      await refreshPlan(true)
      syncTargetsFromPlan()
      if (!targetReady(target)) {
        target.state = targetWaitState(target)
        state.stage = 'waiting-targets'
        setDashboardAlert(config, 'delivery-target-not-ready', `${target.botName} is ${target.state}; waiting before sending /tpa`, {
          botName: target.botName,
          readiness: target.readiness,
          detail: target.readinessDetail || null,
          location: target.locationDetail || target.location || null
        }, 'warn')
        persist()
        return
      }
      const geometry = stationLib.getTargetGeometry(target.anchor, config?.delivery?.chests || {})
      const insideTarget = (pos) => stationLib.isInsideBounds(pos, geometry.platformBounds)

      if (insideTarget(botPosition(bot))) {
        state.stage = 'collecting'
        persist()
        return
      }

      bot.__nervAllowOffPlatformNavigation = true
      reportStatus(`delivery:tpa:${target.botName}`)
      const sendResult = await sendWithCooldown('tpa', `${settings.tpaCommand} ${target.botName}`)
      persist()
      if (sendResult.status === 'aborted') return
      if (sendResult.status === 'cooldown-blocked') {
        reportStatus(`delivery:waiting-cooldown:${target.botName}`)
        return // loop comes back to traveling once the cooldown clears
      }
      if (sendResult.status === 'target-unavailable') {
        target.online = false
        target.platformReady = false
        target.readiness = 'offline'
        target.readinessDetail = sendResult.message || 'server reported player unavailable'
        target.retryAfterAt = Date.now() + settings.silentCommandRetryMs
        target.state = 'offline'
        state.stage = 'waiting-targets'
        setDashboardAlert(config, 'delivery-target-not-ready', `${target.botName} is unavailable; waiting for a fresh platform-ready heartbeat`, {
          botName: target.botName,
          retryAfterAt: new Date(target.retryAfterAt).toISOString(),
          detail: target.readinessDetail
        }, 'warn')
        persist()
        return
      }

      reportStatus(`delivery:awaiting-arrival:${target.botName}`)
      const arrived = await waitForArrival(insideTarget, settings.arrivalTimeoutMs)
      if (shouldAbortWaits()) return
      if (arrived) {
        await delay(settings.postArrivalSettleMs)
        target.travelRetries = 0
        state.stage = 'collecting'
        persist()
        return
      }

      target.travelRetries += 1
      log(`[DELIVERY-WARN] no arrival at ${target.botName} platform (attempt ${target.travelRetries}/${settings.maxTravelRetries})`)
      if (target.travelRetries >= settings.maxTravelRetries) {
        target.state = 'unreachable'
        setDashboardAlert(config, 'delivery-target-unreachable', `Could not reach ${target.botName} after ${target.travelRetries} tpa attempts`, { botName: target.botName }, 'warn')
        state.currentTargetIndex = -1
        state.stage = 'selecting'
      }
      persist()
    }

    async function stageCollecting() {
      const state = mission.state
      if (state.abortRequested) {
        state.stage = 'returning'
        persist()
        return
      }
      const target = currentTarget(state)
      if (!target) {
        state.stage = 'selecting'
        persist()
        return
      }
      const geometry = stationLib.getTargetGeometry(target.anchor, config?.delivery?.chests || {})
      if (!stationLib.isInsideBounds(botPosition(bot), geometry.platformBounds)) {
        // Knocked off the platform (or resumed elsewhere): travel again.
        state.stage = 'traveling'
        persist()
        return
      }

      bot.__nervAllowOffPlatformNavigation = true
      await walkTo(geometry.openPosition, settings.walkGoalRange)

      for (const chest of geometry.chests) {
        if (shouldAbortWaits()) return
        if (state.abortRequested) break
        if (target.chests[chest.key] === 'done') continue
        if (!bundleOps.hasCollectCapacity(bot, config)) {
          log('[DELIVERY] bundle capacity exhausted; returning home to deposit before continuing')
          state.stage = 'returning'
          persist()
          return
        }

        target.chests[chest.key] = 'active'
        reportStatus(`delivery:collecting:${target.botName}:${chest.key}`)
        persist()

        const result = await bundleOps.collectMapsFromChest(bot, config, chest)
        state.ledger.collected += result.moved
        target.mapsCollected += result.moved
        log(`[DELIVERY] ${target.botName}/${chest.key}: moved ${result.moved} map(s), chestEmpty=${result.chestEmpty} capacityFull=${result.capacityFull}`)

        if (result.chestEmpty) {
          target.chests[chest.key] = 'done'
          persist()
        }

        const ledger = checkLedger(bot, config, state)
        if (!ledger.ok) {
          if (result.moved > 0 && ledger.carried < ledger.expectedCarried) {
            setDashboardAlert(config, 'delivery-inventory-resync', `Inventory needs resync after bundling: carried=${ledger.carried} expected=${ledger.expectedCarried}`, ledger, 'warn')
            persist()
            requestInventoryResync(`Inventory needs resync after bundling ${result.moved} map(s) from ${target.botName}/${chest.key}`)
            return
          }
          state.status = 'halted-mismatch'
          setDashboardAlert(config, 'delivery-ledger-mismatch', `Map ledger mismatch: carried=${ledger.carried} expected=${ledger.expectedCarried} (collected=${ledger.collected} deposited=${ledger.deposited})`, ledger, 'error')
          persist()
          return
        }
        clearDashboardAlert(config, 'delivery-inventory-resync')

        if (result.capacityFull) {
          state.stage = 'returning'
          persist()
          return
        }
      }

      const allDone = geometry.chests.every((chest) => target.chests[chest.key] === 'done')
      if (allDone) {
        target.state = 'done'
        state.currentTargetIndex = -1
        log(`[DELIVERY] target ${target.botName} complete: ${target.mapsCollected} map(s) collected`)
      }
      state.stage = 'returning'
      persist()
    }

    async function stageReturning() {
      const state = mission.state
      const home = station()
      if (carriedMaps(bot, config).total <= 0 && state.targets.some((entry) => targetIsCollectablePending(entry))) {
        state.stage = 'selecting'
        persist()
        return
      }
      if (stationLib.isAtStation(botPosition(bot), home)) {
        state.stage = 'depositing'
        persist()
        return
      }

      bot.__nervAllowOffPlatformNavigation = true
      reportStatus('delivery:returning-home')
      const sendResult = await sendWithCooldown('home', `${settings.homeCommand} ${settings.homeName}`)
      persist()
      if (sendResult.status === 'aborted') return
      if (sendResult.status === 'home-missing') {
        state.stage = 'waiting-home'
        setDashboardAlert(config, 'delivery-home-not-set', `Home "${settings.homeName}" is not set or unavailable: ${sendResult.message}`, {}, 'error')
        persist()
        return
      }
      if (sendResult.status === 'cooldown-blocked') {
        reportStatus('delivery:waiting-cooldown:home')
        return
      }

      const arrived = await waitForArrival((pos) => stationLib.isAtStation(pos, home), settings.arrivalTimeoutMs)
      if (shouldAbortWaits()) return
      if (arrived) {
        clearDashboardAlert(config, 'delivery-home-not-set')
        state.counters.trips += 1
        state.stage = 'depositing'
        persist()
        return
      }
      // /home went out but we did not arrive: warn and retry on the next pass.
      log('[DELIVERY-WARN] /home sent but the bot did not arrive at the station; retrying')
      persist()
    }

    async function stageWaitingHome() {
      const state = mission.state
      reportStatus('delivery:waiting-home')
      const finished = await cooldownsLib.waitWithAbort(settings.homeRetryMs, { shouldAbort: shouldAbortWaits })
      if (!finished) return
      state.stage = 'returning'
      persist()
    }

    async function stageWaitingTargets() {
      const state = mission.state
      if (state.abortRequested) {
        state.stage = 'returning'
        persist()
        return
      }

      await refreshPlan(true)
      syncTargetsFromPlan()

      const readyIndex = state.targets.findIndex((entry) => targetIsCollectablePending(entry) && targetReady(entry))
      if (readyIndex >= 0) {
        clearDashboardAlert(config, 'delivery-target-not-ready')
        state.currentTargetIndex = readyIndex
        state.stage = 'selecting'
        persist()
        return
      }

      const waiting = state.targets.filter((entry) => targetIsCollectablePending(entry))
      if (!waiting.length) {
        clearDashboardAlert(config, 'delivery-target-not-ready')
        state.stage = 'completing'
        persist()
        return
      }

      for (const target of waiting) {
        if (!targetReady(target)) target.state = targetWaitState(target)
      }
      setDashboardAlert(config, 'delivery-target-not-ready', 'Waiting for printer bots to be online and on-platform before sending /tpa', {
        waitingTargets: waiting.map((entry) => ({
          botName: entry.botName,
          state: entry.state,
          readiness: entry.readiness,
          detail: entry.readinessDetail || null,
          location: entry.locationDetail || entry.location || null,
          lastStatusAt: entry.lastStatusAt || null
        }))
      }, 'warn')
      reportStatus('delivery:waiting-targets')
      persist()

      await cooldownsLib.waitWithAbort(settings.targetReadyRetryMs, { shouldAbort: shouldAbortWaits })
    }

    async function stageDepositing() {
      const state = mission.state
      const home = station()
      bot.__nervAllowOffPlatformNavigation = true
      reportStatus('delivery:depositing')
      const result = await bundleOps.depositAtStation(bot, config, home)
      const expectedDeposit = Math.max(0, state.ledger.collected - state.ledger.deposited)
      if (result.depositedMaps > expectedDeposit) {
        const recovered = result.depositedMaps - expectedDeposit
        state.ledger.collected += recovered
        log(`[DELIVERY] ledger recovered ${recovered} extra carried map(s) during deposit`)
      }
      state.ledger.deposited += result.depositedMaps
      log(`[DELIVERY] deposited ${result.depositedMaps} map(s) in ${result.depositedBundles} bundle(s)`)

      const ledger = checkLedger(bot, config, state)
      if (!ledger.ok) {
        state.status = 'halted-mismatch'
        setDashboardAlert(config, 'delivery-ledger-mismatch', `Map ledger mismatch after deposit: carried=${ledger.carried} expected=${ledger.expectedCarried} (collected=${ledger.collected} deposited=${ledger.deposited})`, ledger, 'error')
        persist()
        return
      }

      if (result.chestFull && carriedMaps(bot, config).total > 0) {
        state.status = 'halted-error'
        setDashboardAlert(config, 'delivery-drop-chest-full', 'Drop chest is full and the bot is still carrying maps', {}, 'error')
        persist()
        return
      }
      clearDashboardAlert(config, 'delivery-drop-chest-full')

      if (state.abortRequested) {
        state.status = 'aborted'
        state.stage = 'idle'
        persist()
        log('[DELIVERY] mission aborted; carried maps were deposited safely')
        return
      }

      state.stage = 'restocking'
      persist()
    }

    async function stageRestocking() {
      const state = mission.state
      const home = station()
      const pendingTargets = state.targets.some((entry) => targetIsCollectablePending(entry))
      if (!pendingTargets) {
        state.stage = 'completing'
        persist()
        return
      }
      const restock = await bundleOps.restockEmptyBundles(bot, config, home, { targetCount: restockTargetCount(state) })
      state.counters.bundleRestocks += 1
      log(`[DELIVERY] bundle restock: +${restock.withdrawn}, returned ${restock.returned || 0}, split ${restock.split || 0}, target ${restock.desired || '?'} (carrying ${restock.carried.total}, empty ${restock.carried.empty})`)
      if (!bundleOps.hasCollectCapacity(bot, config)) {
        state.status = 'halted-error'
        setDashboardAlert(config, 'delivery-no-bundles', 'Out of empty bundles; refill the bundles chest and press Start', {}, 'error')
        persist()
        return
      }
      await refreshPlan(true)
      state.stage = 'selecting'
      persist()
    }

    function stageCompleting() {
      const state = mission.state
      const unreachable = state.targets.filter((entry) => entry.state === 'unreachable')
      state.status = 'completed'
      state.stage = 'idle'
      persist()
      const summary = `GetAllMaps complete: ${state.ledger.deposited} map(s) delivered from ${state.targets.filter((t) => t.state === 'done').length}/${state.targets.length} platform(s)` +
        (unreachable.length ? `; unreachable: ${unreachable.map((t) => t.botName).join(', ')}` : '')
      log(`[DELIVERY] ${summary}`)
      if (unreachable.length) {
        setDashboardAlert(config, 'delivery-summary', summary, {}, 'warn')
      } else {
        clearDashboardAlert(config, 'delivery-target-unreachable')
        clearDashboardAlert(config, 'delivery-summary')
      }
      bot.__nervAllowOffPlatformNavigation = false
    }

    async function stepMission() {
      const state = mission.state
      switch (state.stage) {
        case 'preparing': return await stagePreparing()
        case 'selecting': return stageSelecting()
        case 'traveling': return await stageTraveling()
        case 'collecting': return await stageCollecting()
        case 'returning': return await stageReturning()
        case 'waiting-home': return await stageWaitingHome()
        case 'waiting-targets': return await stageWaitingTargets()
        case 'depositing': return await stageDepositing()
        case 'restocking': return await stageRestocking()
        case 'completing': return stageCompleting()
        default:
          log(`[DELIVERY-WARN] unknown mission stage "${state.stage}"; resetting to selecting`)
          state.stage = 'selecting'
          persist()
      }
    }

    async function startNewMission() {
      await refreshPlan(true)
      const targets = planTargets()
      if (!targets.length) {
        setDashboardAlert(config, 'delivery-no-targets', 'GetAllMaps requested but no enabled delivery targets are configured on the dashboard', {}, 'warn')
        return false
      }
      clearDashboardAlert(config, 'delivery-no-targets')
      clearDashboardAlert(config, 'delivery-inventory-resync')
      clearDashboardAlert(config, 'delivery-bot-died')
      mission.died = false
      mission.state = newMissionState(targets)
      const carriedAtStart = carriedMaps(bot, config).total
      if (carriedAtStart > 0) {
        mission.state.ledger.collected = carriedAtStart
        log(`[DELIVERY] fresh mission includes ${carriedAtStart} map(s) already carried; will deposit before collecting`)
      }
      mission.cooldowns = buildCooldowns({})
      mission.stopMission = false
      clearDashboardAlert(config, 'delivery-ledger-mismatch')
      clearDashboardAlert(config, 'delivery-safety-halt')
      persist()
      log(`[DELIVERY] GetAllMaps mission started with ${targets.length} target(s): ${targets.map((t) => t.botName).join(', ')}`)
      return true
    }

    // 'active' missions resume automatically; 'halted-error' missions resume when
    // the operator presses Start after fixing the cause (e.g. refilled bundles).
    // 'halted-mismatch' is never silently resumed - it needs a fresh GetAllMaps.
    function resumeMissionIfAny(allowHaltedError = false) {
      const saved = readMissionState(settings)
      if (!saved) return false
      const resumable = saved.status === 'active' || (allowHaltedError && saved.status === 'halted-error')
      if (!resumable) return false
      if (saved.status === 'halted-error') {
        saved.status = 'active'
        saved.counters.stageErrors = 0
        clearDashboardAlert(config, 'delivery-stage-error')
        clearDashboardAlert(config, 'delivery-no-bundles')
        clearDashboardAlert(config, 'delivery-drop-chest-full')
        clearDashboardAlert(config, 'delivery-safety-halt')
        clearDashboardAlert(config, 'delivery-inventory-resync')
      }
      mission.state = saved
      mission.cooldowns = buildCooldowns(saved.cooldowns || {})
      log(`[DELIVERY] resuming mission ${saved.missionId} at stage=${saved.stage} target=${currentTarget(saved)?.botName || 'none'}`)
      persist()
      return true
    }

    // Raised on any in-game death. On 6b6t death drops the whole inventory, so a
    // delivery bot dying mid-mission means carried maps are now on the ground:
    // alert loudly and halt so the operator recovers them before a fresh run.
    function onDeath() {
      const pos = botPosition(bot)
      const missionActive = mission.state?.status === 'active'
      const mapsAtRisk = mission.state
        ? Math.max(0, toNumber(mission.state.ledger?.collected, 0) - toNumber(mission.state.ledger?.deposited, 0))
        : carriedMaps(bot, config).total
      mission.died = true
      const outcome = buildDeathOutcome({ settings, position: pos, mapsAtRisk, missionActive })
      log(`[DELIVERY-DEATH] ${outcome.alert?.message || `Delivery bot died (alerts disabled); mapsAtRisk=${mapsAtRisk}`}`)
      if (outcome.alert) {
        setDashboardAlert(config, outcome.alert.category, outcome.alert.message, {
          ...outcome.alert.detail,
          missionId: mission.state?.missionId || null,
          stage: mission.state?.stage || null,
          diedAt: new Date().toISOString()
        }, outcome.alert.level)
      }
      if (outcome.halt) {
        mission.state.status = 'halted-death'
        mission.state.stage = 'halted-death'
        mission.state.diedAt = new Date().toISOString()
        persist()
      }
      reportStatus('delivery:halted-death')
    }

    async function runManagedLoop() {
      log('[DELIVERY] managed delivery loop started')
      dashboardRuntime?.setPhase?.('idle', 'delivery-idle')
      bot.on('death', onDeath)

      // A reconnect builds a fresh dashboard runtime (empty alerts). If the last
      // session ended in a death-halt, re-surface the alert so it is not lost.
      const savedAtStart = readMissionState(settings)
      if (savedAtStart?.status === 'halted-death' && settings.alertOnDeath) {
        const atRisk = Math.max(0, toNumber(savedAtStart.ledger?.collected, 0) - toNumber(savedAtStart.ledger?.deposited, 0))
        setDashboardAlert(
          config,
          'delivery-bot-died',
          `Delivery bot previously died${atRisk > 0 ? ` carrying ${atRisk} map(s)` : ''}; recover any dropped items, then start a new GetAllMaps.`,
          { mapsAtRisk: atRisk, missionId: savedAtStart.missionId || null, diedAt: savedAtStart.diedAt || null },
          'error'
        )
      }

      const resumed = resumeMissionIfAny()
      if (resumed && !isOperatorPaused(config)) {
        log('[DELIVERY] active mission found; resuming automatically')
      }

      while (isBotSessionLive(bot) && bot.__nervSessionActive !== false) {
        try {
          // stop-mission request: route the machine to a safe abort.
          if (dashboardRuntime?.consumeStopMissionRequest?.() === true) {
            if (mission.state && mission.state.status === 'active') {
              mission.state.abortRequested = true
              mission.stopMission = false
              log('[DELIVERY] stop-mission requested; will deposit carried maps and stop')
              persist()
            }
          }

          const missionActive = mission.state?.status === 'active'
          await refreshPlan(false)

          await maybeEatAtStation(missionActive ? `delivery:${mission.state?.stage || 'active'}` : 'delivery:idle')

          if (runtimeControl?.isStopRequested() || isOperatorPaused(config)) {
            dashboardRuntime?.markRunStopped?.('paused')
            reportStatus('delivery:paused')
            await delay(settings.idlePollMs)
            continue
          }

          const startRequested = runtimeControl?.consumeStartRequest() === true || dashboardRuntime?.consumeStartRequest?.() === true
          const missionRequested = dashboardRuntime?.consumeDeliveryMissionRequest?.() === true

          if (!missionActive) {
            if (missionRequested) {
              const started = await startNewMission()
              if (!started) {
                reportStatus('delivery:no-targets')
                await delay(settings.idlePollMs)
                continue
              }
            } else if (startRequested && resumeMissionIfAny(true)) {
              // resumed below
            } else {
              dashboardRuntime?.setPhase?.('idle', `delivery-idle:${describeLocation(bot, config)}`)
              reportStatus('delivery:idle')
              await delay(settings.idlePollMs)
              continue
            }
          } else if (missionRequested) {
            log('[DELIVERY] GetAllMaps already running; request ignored')
          }

          if (!mission.state || mission.state.status !== 'active') {
            await delay(settings.idlePollMs)
            continue
          }

          reportStatus()
          await stepMission()
          reportStatus()

          const status = mission.state?.status
          if (status && status !== 'active') {
            if (status === 'completed' || status === 'aborted') {
              dashboardRuntime?.setCurrentNbt?.(null)
              dashboardRuntime?.setPhase?.('idle', `delivery:${status}`)
              mission.state = null
              mission.cooldowns = null
            } else {
              // halted-* : keep state so the operator can inspect/resume after fixing.
              dashboardRuntime?.setPhase?.('idle', `delivery:${status}`)
              reportStatus(`delivery:${status}`)
              await delay(settings.idlePollMs * 5)
            }
          }

          await delay(250)
        } catch (err) {
          const text = String(err?.message || err)
          log(`[DELIVERY-ERROR] ${text}`)
          dashboardRuntime?.setLastError?.(text)
          if (mission.state && mission.state.status === 'halted-death') {
            // A death already halted the mission; a follow-on stage error from the
            // interrupted action must not mask the death alert.
            persist()
            await delay(2000)
            continue
          }
          if (mission.state) {
            mission.state.counters.stageErrors += 1
            if (text.includes('delivery-ledger')) {
              mission.state.status = 'halted-mismatch'
              setDashboardAlert(config, 'delivery-ledger-mismatch', text, {}, 'error')
            } else if (text.includes('delivery-safety')) {
              mission.state.status = 'halted-error'
              setDashboardAlert(config, 'delivery-safety-halt', text, {}, 'error')
            } else if (mission.state.counters.stageErrors >= settings.maxStageErrors) {
              mission.state.status = 'halted-error'
              setDashboardAlert(config, 'delivery-stage-error', `Mission halted after ${mission.state.counters.stageErrors} stage errors: ${text}`, {}, 'error')
            }
            persist()
          }
          await delay(2000)
        }
      }

      // Session ending: persist and release the navigation override.
      try { bot.removeListener('death', onDeath) } catch { }
      persist()
      bot.__nervAllowOffPlatformNavigation = false
      log('[DELIVERY] managed delivery loop ended (session closed)')
    }

    return { runManagedLoop }
  }
}

module.exports = { createDeliveryRuntime, isTargetStatusFresh, shouldEatAtStation, buildDeathOutcome }
