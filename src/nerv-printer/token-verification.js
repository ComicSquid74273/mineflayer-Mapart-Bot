'use strict'

function isTokenVerificationText(value) {
  const text = String(value || '').toLowerCase()
  return (
    text.includes('verify.6b6t.org/') ||
    text.includes('https://6b6t.org/verify') ||
    text.includes('verification code') ||
    text.includes('vpn/proxy') ||
    (text.includes('verify') && (
      text.includes('token') ||
      text.includes('website') ||
      text.includes('browser') ||
      text.includes('captcha') ||
      text.includes('6b6t')
    ))
  )
}

function extractVerificationCode(value, selfName = '') {
  const text = String(value || '')
  const ignored = new Set(['COLOR', 'WHITE', 'YELLOW', 'GRAY', 'EXTRA', 'VALUE', 'STRING', 'TEXT'])
  const self = String(selfName || '').trim().toUpperCase()
  if (self) ignored.add(self)
  const accept = (candidate) => {
    const code = String(candidate || '').trim().toUpperCase()
    return /^[A-Z0-9]{4,12}$/.test(code) && !ignored.has(code) ? code : ''
  }

  const labeled = text.match(/verification code:\s*([A-Z0-9]{4,12})/i)
  if (labeled) {
    const code = accept(labeled[1])
    if (code) return code
  }

  try {
    const payload = JSON.parse(text)
    const parts = []
    const collectTextParts = (node) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.text === 'string') {
        parts.push({
          text: node.text,
          color: typeof node.color === 'string' ? node.color : ''
        })
      }
      if (Array.isArray(node.extra)) {
        for (const child of node.extra) collectTextParts(child)
      }
      if (node.value && typeof node.value === 'object') {
        collectTextParts(node.value)
      }
    }
    collectTextParts(payload)

    for (let i = 0; i < parts.length; i += 1) {
      if (!/verification code/i.test(parts[i].text || '')) continue
      for (let j = i + 1; j < parts.length; j += 1) {
        const code = accept(parts[j].text)
        if (code) return code
      }
    }

    const whiteCode = parts.find((part) => part.color.toLowerCase() === 'white' && accept(part.text))
    if (whiteCode) return accept(whiteCode.text)
  } catch { }

  const jsonWhiteText = [...text.matchAll(/"color"\s*:\s*"white"\s*,\s*"text"\s*:\s*"([A-Z0-9]{4,12})"/gi)]
    .map((match) => accept(match[1]))
    .filter(Boolean)
  if (jsonWhiteText.length) return jsonWhiteText[jsonWhiteText.length - 1]

  return ''
}

function extractVerificationUrl(value) {
  const text = String(value || '').replace(/\\\//g, '/')
  const matches = [...text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)]
    .map((match) => match[0]
      .replace(/(?:\u00a7[0-9A-FK-OR])+$/gi, '')
      .replace(/[)\]}.,;'"]+$/, ''))
    .filter(Boolean)

  if (!matches.length) return ''
  return matches.find((url) => /^https?:\/\/verify\.6b6t\.org\//i.test(url))
    || matches.find((url) => /^https?:\/\/6b6t\.org\/verify(?:\/|\?|$)/i.test(url))
    || matches[0]
}

module.exports = {
  isTokenVerificationText,
  extractVerificationCode,
  extractVerificationUrl
}
