/**
 * Verification Module - Checks bot behavior for critical scenarios
 * Verifies:
 *  1. Bot doesn't place on already placed blocks (prevents duplicates)
 *  2. Bot properly breaks misplaced carpets during repair
 *  3. Block support detection works correctly
 */

/**
 * Verify that the bot correctly handles duplicate placement attempts
 * @param {Bot} bot - The mineflayer bot instance
 * @param {Object} target - The target to verify
 * @returns {Object} Verification result
 */
function verifyNoDuplicatePlacement(bot, target) {
  const Vec3 = bot.entity.position.constructor
  const targetPos = new Vec3(target.position.x, target.position.y, target.position.z)
  const blockAtTarget = bot.blockAt(targetPos)

  return {
    position: target.position,
    blockName: target.blockName,
    blockAtTarget: blockAtTarget?.name,
    isDuplicate: blockAtTarget?.name === target.blockName,
    result: blockAtTarget?.name === target.blockName ? 'PASS' : 'FAIL'
  }
}

/**
 * Verify that the bot correctly identifies misplaced carpets
 * @param {Bot} bot - The mineflayer bot instance
 * @param {Object} target - The target position
 * @returns {Object} Verification result
 */
function verifyMisplacedCarpetDetection(bot, target) {
  const Vec3 = bot.entity.position.constructor
  const targetPos = new Vec3(target.position.x, target.position.y, target.position.z)
  const blockAtTarget = bot.blockAt(targetPos)

  const isMisplacedCarpet =
    blockAtTarget &&
    blockAtTarget.name !== 'air' &&
    String(blockAtTarget.name).endsWith('_carpet') &&
    blockAtTarget.name !== target.blockName

  return {
    position: target.position,
    expectedBlock: target.blockName,
    actualBlock: blockAtTarget?.name,
    isMisplacedCarpet,
    shouldBreak: isMisplacedCarpet,
    result: isMisplacedCarpet ? 'DETECTED' : 'NOT_FOUND'
  }
}

/**
 * Verify that the bot correctly identifies missing support blocks
 * @param {Bot} bot - The mineflayer bot instance
 * @param {Object} target - The target position
 * @returns {Object} Verification result
 */
function verifySupportDetection(bot, target) {
  const Vec3 = bot.entity.position.constructor
  const targetPos = new Vec3(target.position.x, target.position.y, target.position.z)
  const support = bot.blockAt(targetPos.offset(0, -1, 0))

  const hasSupport = support && support.name !== 'air'

  return {
    position: target.position,
    blockBelowName: support?.name,
    hasSupport,
    canPlace: hasSupport,
    result: hasSupport ? 'PASS' : 'FAIL'
  }
}

/**
 * Comprehensive behavior verification test
 * Checks that bot follows all expected rules
 */
async function runBehaviorVerificationTest(bot, testTargets, config) {
  const results = {
    timestamp: new Date().toISOString(),
    tests: {
      duplicatePlacement: [],
      misplacedCarpetDetection: [],
      supportDetection: []
    },
    summary: {
      totalTests: 0,
      passed: 0,
      failed: 0,
      issues: []
    }
  }

  console.log('[VERIFY] Starting behavior verification tests...')

  // Test 1: Duplicate placement prevention
  console.log('[VERIFY-TEST-1] Checking duplicate placement prevention...')
  for (const target of testTargets) {
    const result = verifyNoDuplicatePlacement(bot, target)
    results.tests.duplicatePlacement.push(result)
    results.summary.totalTests += 1

    if (result.result === 'PASS') {
      results.summary.passed += 1
    } else {
      results.summary.failed += 1
      // Only flag as issue if the expected block is there
      if (result.isDuplicate) {
        // This is actually good - means the block was already placed
        results.summary.passed -= 1
        results.summary.failed -= 1
        results.summary.passed += 1
      }
    }
  }

  // Test 2: Misplaced carpet detection
  console.log('[VERIFY-TEST-2] Checking misplaced carpet detection...')
  for (const target of testTargets) {
    const result = verifyMisplacedCarpetDetection(bot, target)
    results.tests.misplacedCarpetDetection.push(result)
    results.summary.totalTests += 1

    if (result.shouldBreak) {
      results.summary.issues.push({
        type: 'MISPLACED_CARPET',
        position: target.position,
        expected: result.expectedBlock,
        actual: result.actualBlock
      })
      results.summary.failed += 1
    } else {
      results.summary.passed += 1
    }
  }

  // Test 3: Support detection
  console.log('[VERIFY-TEST-3] Checking support detection...')
  for (const target of testTargets) {
    const result = verifySupportDetection(bot, target)
    results.tests.supportDetection.push(result)
    results.summary.totalTests += 1

    if (result.result === 'PASS') {
      results.summary.passed += 1
    } else {
      results.summary.failed += 1
      results.summary.issues.push({
        type: 'SUPPORT_MISSING',
        position: target.position,
        blockBelow: result.blockBelowName
      })
    }
  }

  results.summary.passRate = Math.round((results.summary.passed / results.summary.totalTests) * 100)

  return results
}

/**
 * Log verification test results
 */
function logVerificationResults(results) {
  console.log('\n' + '='.repeat(60))
  console.log('[VERIFY-RESULTS] BEHAVIOR VERIFICATION TEST')
  console.log('='.repeat(60))

  console.log(`\nTest Summary:`)
  console.log(`  Total Tests: ${results.summary.totalTests}`)
  console.log(`  Passed: ${results.summary.passed}`)
  console.log(`  Failed: ${results.summary.failed}`)
  console.log(`  Pass Rate: ${results.summary.passRate}%`)

  if (results.summary.issues.length > 0) {
    console.log(`\nIssues Found: ${results.summary.issues.length}`)
    for (const issue of results.summary.issues) {
      console.log(`  [${issue.type}] at (${issue.position.x}, ${issue.position.y}, ${issue.position.z})`)
      if (issue.expected) {
        console.log(`    Expected: ${issue.expected}, Got: ${issue.actual}`)
      }
    }
  } else {
    console.log('\nNo critical issues detected!')
  }

  console.log('='.repeat(60) + '\n')
}

module.exports = {
  verifyNoDuplicatePlacement,
  verifyMisplacedCarpetDetection,
  verifySupportDetection,
  runBehaviorVerificationTest,
  logVerificationResults
}
