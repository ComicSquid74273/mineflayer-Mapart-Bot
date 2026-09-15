'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { formatLogArg, redactLogText } = require('../src/shared/log-redaction')

test('redacts credentials from structured SOCKS errors', () => {
  const value = formatLogArg({
    options: {
      proxy: {
        userId: 'example-user',
        password: 'example-secret'
      }
    }
  })

  assert.doesNotMatch(value, /example-secret/)
  assert.match(value, /"password":"<redacted>"/)
})

test('redacts common text and proxy URL credential formats', () => {
  const value = redactLogText("proxyPassword='example-secret' socks5://user:example-secret@localhost:1080")

  assert.doesNotMatch(value, /example-secret/)
  assert.match(value, /proxyPassword=<redacted>/)
  assert.match(value, /socks5:\/\/user:<redacted>@localhost:1080/)
})
