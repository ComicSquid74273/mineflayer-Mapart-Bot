'use strict'

function redactLogText(value) {
  return String(value)
    .replace(/("(?:proxyPassword|proxy_password|loginPassword|chatLoginPassword|password|passphrase|accessToken|refreshToken)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"<redacted>"')
    .replace(/(\b(?:proxyPassword|proxy_password|loginPassword|chatLoginPassword|password|passphrase|accessToken|refreshToken)\b\s*[:=]\s*)'(?:\\.|[^'\\])*'/gi, '$1\'<redacted>\'')
    .replace(/(\b(?:proxyPassword|proxy_password|loginPassword|chatLoginPassword|password|passphrase|accessToken|refreshToken)\b\s*[:=]\s*)([^\s,}\]]+)/gi, '$1<redacted>')
    .replace(/(socks(?:4|5|5h)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1<redacted>@')
}

function formatLogArg(value) {
  if (typeof value === 'string') return redactLogText(value)
  try {
    return redactLogText(JSON.stringify(value))
  } catch {
    return redactLogText(String(value))
  }
}

module.exports = {
  formatLogArg,
  redactLogText
}
