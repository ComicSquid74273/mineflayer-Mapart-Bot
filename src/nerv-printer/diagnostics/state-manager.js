/**
 * State Management System for Mapart Bot
 * Tracks bot state, crash recovery, and detailed progress
 */

const fs = require('fs')
const path = require('path')

/**
 * Possible bot states throughout the print lifecycle
 */
const BOT_STATES = {
  // Printing phase
  PRINTING_START: 'printing_start',
  PRINTING_BATCH: 'printing_batch',
  PRINTING_LINEEND_CHECK: 'printing_lineend_check',
  
  // Repair phase
  REPAIR_START: 'repair_start',
  REPAIR_PASS: 'repair_pass',
  
  // Rescan phase
  RESCAN_START: 'rescan_start',
  RESCAN_FULL: 'rescan_full',
  RESCAN_ANALYSIS: 'rescan_analysis',
  
  // Post-print phase
  POST_PRINT_START: 'post_print_start',
  POST_PRINT_WORKFLOW: 'post_print_workflow',
  POST_PRINT_DONE: 'post_print_done',
  
  // Cleanup
  CLEANUP: 'cleanup',
  FINISHED: 'finished'
}

/**
 * Error classification types
 */
const ERROR_TYPES = {
  MISSING: 'missing',           // Block should be there but is air
  WRONG_BLOCK: 'wrong_block',   // Different block is there
  MISPLACED_CARPET: 'misplaced_carpet',
  SUPPORT_MISSING: 'support_missing',
  INVENTORY_FULL: 'inventory_full',
  MATERIAL_UNAVAILABLE: 'material_unavailable',
  PLACEMENT_FAILED: 'placement_failed',
  PATHFINDING_FAILED: 'pathfinding_failed',
  UNKNOWN: 'unknown'
}

class StateManager {
  constructor(stateFilePath, enableLogging = true) {
    this.stateFilePath = stateFilePath
    this.enableLogging = enableLogging
    this.stateHistoryFile = stateFilePath.replace('.json', '-history.json')
    
    this.state = {
      currentPhase: null,
      currentState: null,
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
      processedTargets: 0,
      totalTargets: 0,
      
      // Progress counters
      stats: {
        placed: 0,
        already: 0,
        skipped: 0,
        errors: 0
      },
      
      // Error tracking
      errors: [],
      errorsByType: {},
      
      // Input info for resume
      sourceType: null,
      sourceName: null,
      sourcePath: null,
      
      // Recovery info
      lastSuccessfulTarget: null,
      crashCount: 0,
      
      // Rescan results
      rescanResults: null
    }
    
    this.load()
  }

  load() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const saved = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'))
        this.state = { ...this.state, ...saved }
        this.state.crashCount = (this.state.crashCount || 0) + 1
        if (this.enableLogging) {
          console.log(`[STATE-MGR] Loaded state: phase=${this.state.currentPhase} processed=${this.state.processedTargets}/${this.state.totalTargets} crashes=${this.state.crashCount}`)
        }
      }
    } catch (err) {
      console.error(`[STATE-MGR-ERR] Failed to load state: ${err.message}`)
    }
  }

  save() {
    try {
      const dir = path.dirname(this.stateFilePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      this.state.lastUpdateTime = Date.now()
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf8')
    } catch (err) {
      console.error(`[STATE-MGR-ERR] Failed to save state: ${err.message}`)
    }
  }

  /**
   * Record a state transition
   */
  transitionTo(newPhase, newState, details = {}) {
    this.state.currentPhase = newPhase
    this.state.currentState = newState
    
    const timestamp = new Date().toISOString()
    const logEntry = {
      timestamp,
      phase: newPhase,
      state: newState,
      processed: this.state.processedTargets,
      stats: { ...this.state.stats },
      details
    }
    
    if (this.enableLogging) {
      console.log(`[STATE] ${newPhase}/${newState} - processed=${this.state.processedTargets}/${this.state.totalTargets} placed=${this.state.stats.placed} skipped=${this.state.stats.skipped}`)
    }
    
    this.addHistory(logEntry)
    this.save()
  }

  /**
   * Record progress update
   */
  updateProgress(placed = 0, skipped = 0, already = 0, processedCount = null) {
    this.state.stats.placed += placed
    this.state.stats.skipped += skipped
    this.state.stats.already += already
    
    if (processedCount !== null) {
      this.state.processedTargets = processedCount
    }
    
    this.save()
  }

  /**
   * Record an error
   */
  recordError(target, errorType = ERROR_TYPES.UNKNOWN, details = null) {
    const errorEntry = {
      timestamp: new Date().toISOString(),
      position: target.position || {},
      blockName: target.blockName || 'unknown',
      errorType,
      details
    }
    
    this.state.errors.push(errorEntry)
    this.state.stats.errors += 1
    
    // Count by type
    if (!this.state.errorsByType[errorType]) {
      this.state.errorsByType[errorType] = 0
    }
    this.state.errorsByType[errorType] += 1
    
    if (this.enableLogging) {
      console.log(`[ERROR-RECORD] ${errorType} at (${target.position.x}, ${target.position.y}, ${target.position.z}) - ${target.blockName}`)
    }
  }

  /**
   * Set input information for resume tracking
   */
  setInputInfo(sourceType, sourceName, sourcePath, totalTargets) {
    this.state.sourceType = sourceType
    this.state.sourceName = sourceName
    this.state.sourcePath = sourcePath
    this.state.totalTargets = totalTargets
    this.save()
  }

  /**
   * Update last successful target (for resume tracking)
   */
  markTargetSuccess(target) {
    this.state.lastSuccessfulTarget = {
      position: target.position,
      blockName: target.blockName,
      col: target.col,
      row: target.row
    }
    this.save()
  }

  /**
   * Record rescan results
   */
  recordRescanResults(results) {
    this.state.rescanResults = {
      timestamp: new Date().toISOString(),
      totalScanned: results.totalScanned,
      missingBlocks: results.missingBlocks || [],
      wrongBlocks: results.wrongBlocks || [],
      correctBlocks: results.correctBlocks || 0,
      summary: results.summary || {}
    }
    
    if (this.enableLogging) {
      console.log(`[RESCAN-RESULTS] Scanned=${results.totalScanned} Missing=${(results.missingBlocks || []).length} Wrong=${(results.wrongBlocks || []).length} Correct=${results.correctBlocks || 0}`)
    }
    
    this.save()
  }

  /**
   * Add entry to state history
   */
  addHistory(entry) {
    try {
      let history = []
      if (fs.existsSync(this.stateHistoryFile)) {
        history = JSON.parse(fs.readFileSync(this.stateHistoryFile, 'utf8'))
      }
      
      history.push(entry)
      
      // Keep last 1000 entries
      if (history.length > 1000) {
        history = history.slice(-1000)
      }
      
      fs.writeFileSync(this.stateHistoryFile, JSON.stringify(history, null, 2), 'utf8')
    } catch (err) {
      console.error(`[STATE-MGR-ERR] Failed to write history: ${err.message}`)
    }
  }

  /**
   * Check if should resume and from where
   */
  shouldResume() {
    return this.state.processedTargets > 0 && 
           this.state.sourceType && 
           this.state.sourceName &&
           this.state.currentPhase !== BOT_STATES.FINISHED
  }

  /**
   * Clear state (on successful completion)
   */
  clear() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        fs.unlinkSync(this.stateFilePath)
      }
      if (this.enableLogging) {
        console.log('[STATE-MGR] State cleared on successful completion')
      }
    } catch (err) {
      console.error(`[STATE-MGR-ERR] Failed to clear state: ${err.message}`)
    }
  }

  /**
   * Get state summary
   */
  getSummary() {
    const uptime = Date.now() - this.state.startTime
    return {
      phase: this.state.currentPhase,
      state: this.state.currentState,
      progress: `${this.state.processedTargets}/${this.state.totalTargets}`,
      stats: this.state.stats,
      errorsByType: this.state.errorsByType,
      crashes: this.state.crashCount,
      uptime: `${Math.round(uptime / 1000)}s`,
      lastUpdate: new Date(this.state.lastUpdateTime).toISOString()
    }
  }
}

module.exports = {
  StateManager,
  BOT_STATES,
  ERROR_TYPES
}
