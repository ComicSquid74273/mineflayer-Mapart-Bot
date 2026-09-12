'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  isTokenVerificationText,
  extractVerificationCode,
  extractVerificationUrl
} = require('../src/nerv-printer/token-verification')

test('detects and extracts the new per-account 6b6t verification link', () => {
  const message = [
    "1. Please prove you're a human",
    '2. Open https://verify.6b6t.org/h6RJn6 in a browser',
    '   on the same device as your Minecraft',
    '3. Complete the captcha',
    '4. Start playing 6b6t',
    'Username: VulcanB003'
  ].join('\n')

  assert.equal(isTokenVerificationText(message), true)
  assert.equal(extractVerificationUrl(message), 'https://verify.6b6t.org/h6RJn6')
  assert.equal(extractVerificationCode(message, 'VulcanB003'), '')
})

test('prefers the 6b6t verification link when a message contains another URL', () => {
  const message = 'Help: https://6b6t.org/help Open https://verify.6b6t.org/Ab12Cd in a browser'
  assert.equal(extractVerificationUrl(message), 'https://verify.6b6t.org/Ab12Cd')
})

test('retains support for the legacy verification URL and code', () => {
  const message = 'Open https://6b6t.org/verify and enter verification code: A1B2C3.'
  assert.equal(isTokenVerificationText(message), true)
  assert.equal(extractVerificationUrl(message), 'https://6b6t.org/verify')
  assert.equal(extractVerificationCode(message), 'A1B2C3')
})

test('does not treat an ordinary URL as a verification prompt', () => {
  assert.equal(isTokenVerificationText('Read the rules at https://6b6t.org/rules'), false)
})
