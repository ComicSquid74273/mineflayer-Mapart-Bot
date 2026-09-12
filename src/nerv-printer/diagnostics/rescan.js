/**
 * Rescan Module - Comprehensive post-printing verification
 * Scans the entire map before post-print workflow to identify and fix issues
 */

/**
 * Perform a comprehensive rescan of all targets
 * @param {Bot} bot - The mineflayer bot instance
 * @param {Array} allTargets - All targets to verify
 * @param {Object} config - The bot config
 * @returns {Object} Rescan results with missing/wrong/correct counts
 */
async function performFullRescan(bot, allTargets, config) {
  const Vec3 = bot.entity.position.constructor
  const results = {
    totalScanned: allTargets.length,
    correctBlocks: 0,
    missingBlocks: [],
    wrongBlocks: [],
    supportErrors: [],
    summary: {}
  }

  if (config.advanced?.debugPrints) {
    console.log(`[RESCAN] Starting full map rescan of ${allTargets.length} targets...`)
  }

  const startTime = Date.now()
  let checkedCount = 0

  for (let i = 0; i < allTargets.length; i++) {
    const target = allTargets[i]
    const targetPos = new Vec3(target.position.x, target.position.y, target.position.z)
    const blockAtTarget = bot.blockAt(targetPos)

    // Check actual block state
    if (!blockAtTarget || blockAtTarget.name === 'air') {
      results.missingBlocks.push({
        target,
        blockAtTarget: blockAtTarget?.name || 'air',
        support: bot.blockAt(targetPos.offset(0, -1, 0))?.name || 'air'
      })
    } else if (blockAtTarget.name !== target.blockName) {
      results.wrongBlocks.push({
        target,
        expected: target.blockName,
        actual: blockAtTarget.name
      })
    } else {
      results.correctBlocks += 1
    }

    checkedCount += 1

    // Progress logging every 256 blocks
    if (checkedCount % 256 === 0 && config.errorHandling?.logErrors !== false) {
      console.log(`[RESCAN-PROGRESS] ${checkedCount}/${allTargets.length} blocks checked (${results.correctBlocks} correct, ${results.missingBlocks.length} missing, ${results.wrongBlocks.length} wrong)`)
    }
  }

  results.summary = {
    accuracyPercent: Math.round((results.correctBlocks / results.totalScanned) * 100),
    issueCount: results.missingBlocks.length + results.wrongBlocks.length,
    scanTimeMs: Date.now() - startTime
  }

  if (config.errorHandling?.logErrors !== false) {
    console.log(`[RESCAN-COMPLETE] Scanned ${results.totalScanned} blocks in ${results.summary.scanTimeMs}ms`)
    console.log(`[RESCAN-RESULTS] Correct=${results.correctBlocks} (${results.summary.accuracyPercent}%) Missing=${results.missingBlocks.length} Wrong=${results.wrongBlocks.length}`)
  }

  return results
}

/**
 * Analyze rescan results and provide detailed breakdown
 */
function analyzeRescanResults(results, config) {
  const analysis = {
    accuracy: results.summary.accuracyPercent || 0,
    totalIssues: results.missingBlocks.length + results.wrongBlocks.length,
    missingByBlock: {},
    wrongByBlock: {},
    recommendations: []
  }

  // Group missing blocks by type
  for (const missing of results.missingBlocks) {
    const blockName = missing.target.blockName
    if (!analysis.missingByBlock[blockName]) {
      analysis.missingByBlock[blockName] = []
    }
    analysis.missingByBlock[blockName].push(missing.target)
  }

  // Group wrong blocks by type
  for (const wrong of results.wrongBlocks) {
    const key = `${wrong.expected}->${wrong.actual}`
    if (!analysis.wrongByBlock[key]) {
      analysis.wrongByBlock[key] = []
    }
    analysis.wrongByBlock[key].push(wrong.target)
  }

  // Generate recommendations
  if (results.missingBlocks.length > 0) {
    analysis.recommendations.push(`MISSING: ${results.missingBlocks.length} blocks need to be placed`)
  }

  if (results.wrongBlocks.length > 0) {
    analysis.recommendations.push(`WRONG: ${results.wrongBlocks.length} incorrect blocks need to be replaced`)
  }

  if (results.summary.accuracyPercent === 100) {
    analysis.recommendations.push('MAP PERFECT: All blocks are correctly placed!')
  } else if (results.summary.accuracyPercent >= 95) {
    analysis.recommendations.push('MAP GOOD: Minor issues remain, running final repair')
  }

  return analysis
}

/**
 * Log detailed rescan analysis to console and optionally to file
 */
function logRescanAnalysis(results, analysis, config) {
  console.log('\n' + '='.repeat(60))
  console.log('[RESCAN-ANALYSIS] DETAILED RESULTS')
  console.log('='.repeat(60))

  console.log(`\nAccuracy: ${analysis.accuracy}% (${results.correctBlocks}/${results.totalScanned})`)
  console.log(`Issues: ${analysis.totalIssues} total`)
  console.log(`  - Missing: ${results.missingBlocks.length}`)
  console.log(`  - Wrong: ${results.wrongBlocks.length}`)
  console.log(`Scan Time: ${results.summary.scanTimeMs}ms`)

  if (Object.keys(analysis.missingByBlock).length > 0) {
    console.log('\n[MISSING-BY-BLOCK]')
    for (const [blockName, blocks] of Object.entries(analysis.missingByBlock)) {
      console.log(`  ${blockName}: ${blocks.length} missing`)
      if (config.advanced?.debugPrints && blocks.length <= 5) {
        for (const block of blocks) {
          console.log(`    - (${block.position.x}, ${block.position.y}, ${block.position.z})`)
        }
      }
    }
  }

  if (Object.keys(analysis.wrongByBlock).length > 0) {
    console.log('\n[WRONG-BY-BLOCK]')
    for (const [key, blocks] of Object.entries(analysis.wrongByBlock)) {
      console.log(`  ${key}: ${blocks.length} misplaced`)
      if (config.advanced?.debugPrints && blocks.length <= 5) {
        for (const block of blocks) {
          console.log(`    - (${block.position.x}, ${block.position.y}, ${block.position.z})`)
        }
      }
    }
  }

  console.log('\n[RECOMMENDATIONS]')
  for (const rec of analysis.recommendations) {
    console.log(`  • ${rec}`)
  }

  console.log('='.repeat(60) + '\n')
}

module.exports = {
  performFullRescan,
  analyzeRescanResults,
  logRescanAnalysis
}
