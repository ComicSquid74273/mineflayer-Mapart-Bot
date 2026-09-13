const path = require('path')

const MAX_PLAYER_JOIN_MESSAGES = 5000
const MAX_PLAYER_JOIN_MESSAGE_LENGTH = 220

function parseQuotedRow(line) {
  let value = ''
  let index = 1
  while (index < line.length) {
    if (line[index] !== '"') {
      value += line[index]
      index += 1
      continue
    }
    if (line[index + 1] === '"') {
      value += '"'
      index += 2
      continue
    }
    const remainder = line.slice(index + 1).trim()
    if (remainder && remainder !== ',') throw new Error('CSV must contain exactly one message column')
    return value.trim()
  }
  throw new Error('CSV contains an unterminated quoted message')
}

function parsePlayerJoinMessagesCsv(fileName, content) {
  if (path.extname(String(fileName || '')).toLowerCase() !== '.csv') throw new Error('message list must be a .csv file')
  const text = String(content || '').replace(/^\uFEFF/, '')
  const messages = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const message = line.startsWith('"') ? parseQuotedRow(line) : line.replace(/,\s*$/, '').trim()
    if (!message) continue
    if (message.length > MAX_PLAYER_JOIN_MESSAGE_LENGTH) throw new Error(`message exceeds ${MAX_PLAYER_JOIN_MESSAGE_LENGTH} characters`)
    if (/[\u0000-\u001f\u007f]/.test(message)) throw new Error('message contains control characters')
    messages.push(message)
    if (messages.length > MAX_PLAYER_JOIN_MESSAGES) throw new Error(`CSV contains more than ${MAX_PLAYER_JOIN_MESSAGES} messages`)
  }
  if (!messages.length) throw new Error('CSV contains no messages')
  return messages
}

module.exports = {
  MAX_PLAYER_JOIN_MESSAGES,
  MAX_PLAYER_JOIN_MESSAGE_LENGTH,
  parsePlayerJoinMessagesCsv
}
