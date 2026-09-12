const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const cliPath = path.resolve(__dirname, '..', 'src', 'nerv-printer', 'cli.js')
const source = fs.readFileSync(cliPath, 'utf8')

test('multi-user roster inherits matched account proxy and login overrides', () => {
  const helperStart = source.indexOf('function getEnabledMultiBots(config) {')
  const helperEnd = source.indexOf('\nfunction shouldRunMultiUser(', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)

  const helper = source.slice(helperStart, helperEnd)
  assert.match(helper, /const configuredAccounts = Array\.isArray\(config\.bot\?\.usernames\)/)
  assert.match(helper, /accountsByName\.get\(normalized\.name\.toLowerCase\(\)\)/)
  assert.match(helper, /mergeBotOverrides\(\s*getAccountBotOverrides\(account\),\s*normalized\.botOverrides/)
})

test('chat login password can come from a per-account environment variable', () => {
  const helperStart = source.indexOf('function getChatLoginPassword(config) {')
  const helperEnd = source.indexOf('\nfunction isOfflineAuthConfig(', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  const getChatLoginPassword = Function('process', `${helper}; return getChatLoginPassword`)({
    env: {
      NERV_LOGIN_PASSWORD_VULCANB001: 'local-only-secret'
    }
  })

  assert.equal(getChatLoginPassword({ bot: { username: 'VulcanB001' } }), 'local-only-secret')
})
