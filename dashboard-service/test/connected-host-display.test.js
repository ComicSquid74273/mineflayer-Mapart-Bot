const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const appPath = path.resolve(__dirname, '..', 'public', 'assets', 'app.js')
const source = fs.readFileSync(appPath, 'utf8')

test('automatic host selection displays the active hostname instead of auto', () => {
  const rendererStart = source.indexOf('function renderNodeHostSelect(node) {')
  const rendererEnd = source.indexOf('\nfunction renderBots()', rendererStart)
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart)

  const renderer = source.slice(rendererStart, rendererEnd)
  assert.match(renderer, /connectedHost \? `Connected: \$\{connectedHost\}` : 'Host: Automatic'/)
  assert.doesNotMatch(renderer, /\$\{connectedHost\} \(auto\)/)
})

test('bot cards display proxy ID with the same permission gate as proxy IP', () => {
  const rendererStart = source.indexOf('function renderBotCard(bot) {')
  const rendererEnd = source.indexOf('\nfunction renderBots()', rendererStart)
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart)

  const renderer = source.slice(rendererStart, rendererEnd)
  assert.match(renderer, /const proxyIdText = canViewBotIp && bot\.proxyId/)
  assert.match(renderer, /Proxy ID: \$\{proxyIdText\}/)
  assert.match(renderer, /\$\{verifyProxyIdField\}/)
})
