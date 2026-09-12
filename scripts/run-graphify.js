const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function candidateExecutables() {
  const candidates = []

  if (process.env.LOCALAPPDATA) {
    const pythonRoot = path.join(process.env.LOCALAPPDATA, 'Programs', 'Python')
    if (fs.existsSync(pythonRoot)) {
      for (const entry of fs.readdirSync(pythonRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        candidates.push(path.join(pythonRoot, entry.name, 'Scripts', 'graphify.exe'))
      }
    }
  }

  candidates.push('graphify')
  return candidates
}

function resolveGraphify() {
  for (const candidate of candidateExecutables()) {
    if (candidate === 'graphify') return candidate
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const graphify = resolveGraphify()
if (!graphify) {
  console.error('Unable to find graphify. Expected it on PATH or under %LOCALAPPDATA%\\Programs\\Python\\*\\Scripts\\graphify.exe.')
  process.exit(1)
}

const args = process.argv.slice(2)
const result = spawnSync(graphify, args, {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: false
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 0)
