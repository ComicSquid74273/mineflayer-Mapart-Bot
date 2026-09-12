'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

  const forbiddenPaths = [
  /^\.local-tools\//,
  /^\.claude\//,
  /^auth-cache\//,
  /^dashboard-service\/data\//,
  /^dashboard-service\/smtp-config\.env$/,
  /^docs\/(?:6b6t|anchorinformation|EC2-DEPLOY)\./i,
  /^graphify-out\//,
  /^local-nixtri-nodes\//,
  /^logs\//,
  /^reference\//,
  /^spatial-awareness\//
]
const coordinatePrefix = '(?:min|max|center|origin|target|anchor|start|end|from|to|block|world|home|spawn|pos(?:ition)?|location|portal|chest|anvil|food|xp|station|platform|lobby|death|respawn|safe|access|entry|exit|corner|bound)'
const coordinateKey = `(?:x|z|${coordinatePrefix}[_-]?[xz])`
const numericLiteral = String.raw`[+-]?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|(?:(?:\d{1,3}(?:,\d{3})+)|(?:\d(?:_?\d)*))(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?n?)`
const exactNumericLiteral = new RegExp(`^${numericLiteral}$`)
const coordinateAssignment = new RegExp(`["']?${coordinateKey}["']?\\s*[:=]\\s*["']?(${numericLiteral})`, 'gi')
const coordinateTriple = new RegExp(`(?:^|[^\\w.])(${numericLiteral})\\s*(?:,\\s*|\\s+)(${numericLiteral})\\s*(?:,\\s*|\\s+)(${numericLiteral})(?=$|[^\\w.])`, 'gim')
const compactCoordinateTriple = /(?:^|[^\d])-?(\d{5,})[_/|;]+-?(\d{1,4})[_/|;]+-?(\d{5,})(?:[^\d]|$)/gm
const groupedCoordinateTriple = /(?:^|[^\d])(-?\d{1,3}(?:,\d{3})+?),\s*(-?\d{1,4}),\s*(-?\d{1,3}(?:,\d{3})+)(?:[^\d]|$)/gm
const email = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi
const localUserPath = /[A-Z]:\\Users\\[^\s"']+/gi
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const separatedSecretKey = /(?:^|[-_])(?:password|passwd|passphrase|token|secret|api[-_]?key)$/i

function isSecretKey(key) {
  return separatedSecretKey.test(key) || /(?:Password|Passphrase|Token|Secret|ApiKey)$/.test(key)
}

function printableText(buffer) {
  if (!buffer.includes(0)) return buffer.toString('utf8')
  return (buffer.toString('latin1').match(/[\x20-\x7e]{4,}/g) || []).join('\n')
}

function parseNumericLiteral(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !exactNumericLiteral.test(value.trim())) return null

  let normalized = value.trim().replaceAll('_', '').replaceAll(',', '').replace(/n$/i, '')
  let sign = 1
  if (normalized.startsWith('-')) {
    sign = -1
    normalized = normalized.slice(1)
  } else if (normalized.startsWith('+')) {
    normalized = normalized.slice(1)
  }

  const parsed = /^0x/i.test(normalized)
    ? Number.parseInt(normalized.slice(2), 16)
    : /^0b/i.test(normalized)
      ? Number.parseInt(normalized.slice(2), 2)
      : /^0o/i.test(normalized)
        ? Number.parseInt(normalized.slice(2), 8)
        : Number(normalized)
  return Number.isFinite(parsed) ? sign * parsed : null
}

function findCoordinateViolations(text, file) {
  const violations = []

  for (const match of text.matchAll(coordinateAssignment)) {
    const value = parseNumericLiteral(match[1])
    if (value !== null && Math.abs(value) > 10000) violations.push(`${file}: absolute coordinate assignment`)
  }
  coordinateAssignment.lastIndex = 0

  for (const match of text.matchAll(coordinateTriple)) {
    const x = parseNumericLiteral(match[1])
    const y = parseNumericLiteral(match[2])
    const z = parseNumericLiteral(match[3])
    if (y !== null && Math.abs(y) <= 10000 && ((x !== null && Math.abs(x) > 10000) || (z !== null && Math.abs(z) > 10000))) {
      violations.push(`${file}: absolute coordinate triple`)
    }
  }
  coordinateTriple.lastIndex = 0

  for (const match of text.matchAll(compactCoordinateTriple)) {
    if (Number(match[1]) > 10000 || Number(match[3]) > 10000) violations.push(`${file}: compact absolute coordinate triple`)
  }
  compactCoordinateTriple.lastIndex = 0

  for (const match of text.matchAll(groupedCoordinateTriple)) {
    const x = parseNumericLiteral(match[1])
    const y = parseNumericLiteral(match[2])
    const z = parseNumericLiteral(match[3])
    if (y !== null && Math.abs(y) <= 10000 && ((x !== null && Math.abs(x) > 10000) || (z !== null && Math.abs(z) > 10000))) {
      violations.push(`${file}: grouped absolute coordinate triple`)
    }
  }
  groupedCoordinateTriple.lastIndex = 0

  return violations
}

function inspectJson(value, file, violations, parts = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectJson(entry, file, violations, parts.concat(index)))
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, entry] of Object.entries(value)) {
    const location = parts.concat(key).join('.')
      const coordinateValue = parseNumericLiteral(entry)
      if (new RegExp(`^${coordinateKey}$`, 'i').test(key) && coordinateValue !== null && Math.abs(coordinateValue) > 10000) {
        violations.push(`${file}: absolute coordinate at ${location}`)
    }
    if (isSecretKey(key) && typeof entry === 'string' && entry.trim()) {
      violations.push(`${file}: tracked secret at ${location}`)
    }
    inspectJson(entry, file, violations, parts.concat(key))
  }
}

test('tracked repository excludes private coordinates, credentials, and deployment identity', () => {
  const violations = []

  for (const file of trackedFiles) {
    const normalized = file.replaceAll('\\', '/')
    if (forbiddenPaths.some((pattern) => pattern.test(normalized))) violations.push(`${normalized}: forbidden tracked path`)
    if (/\.env$/i.test(normalized)) violations.push(`${normalized}: tracked environment file`)

    const buffer = fs.readFileSync(path.join(root, file))
    const text = printableText(buffer)

    violations.push(...findCoordinateViolations(normalized, normalized))
    violations.push(...findCoordinateViolations(text, normalized))
    for (const match of text.matchAll(email)) {
      if (!/^example\.(?:com|net|org)$/i.test(match[1])) violations.push(`${normalized}: literal email address`)
    }
    email.lastIndex = 0
    if (localUserPath.test(text)) violations.push(`${normalized}: local user path`)
    localUserPath.lastIndex = 0
    if (/BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/.test(text)) violations.push(`${normalized}: private key`)

    for (const address of text.match(ipv4) || []) {
      const octets = address.split('.').map(Number)
      if (octets.some((value) => value > 255)) continue
      if (octets[0] !== 127 && address !== '0.0.0.0') violations.push(`${normalized}: non-local IPv4 address`)
    }

    if (/\.json$/i.test(normalized)) {
      try {
        inspectJson(JSON.parse(text), normalized, violations)
      } catch {
        violations.push(`${normalized}: invalid JSON`)
      }
    }
  }

  assert.deepEqual([...new Set(violations)], [])
})

test('coordinate detector covers alternate numeric formats', () => {
  const grouped = ['12', '345'].join(',')
  const separated = ['12', '345'].join('_')
  const scientific = ['1.2345', 'e4'].join('')
  const hexadecimal = `0x${(12345).toString(16)}`
  const compact = ['12345', '64', '-12345'].join('_')
  const groupedTriple = [grouped, '64', `-${grouped}`].join(',')
  const samples = [
    `x = ${grouped}`,
    `"anchorZ": "-${separated}"`,
    `targetX=${scientific}`,
    `worldZ=${hexadecimal}`,
    `${grouped} 64 -${grouped}`,
    `new Vec3(${separated}, 64, -${scientific})`,
    compact,
    groupedTriple
  ]

  for (const sample of samples) {
    assert.notDeepEqual(findCoordinateViolations(sample, 'fixture'), [], sample)
  }
  assert.deepEqual(findCoordinateViolations('timeoutMs = 60000; mapId = 12345', 'fixture'), [])
})
