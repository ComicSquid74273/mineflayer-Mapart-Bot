function toNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function isSocksProxy(proxy = {}) {
  const type = String(proxy.type || proxy.proxyType || 'socks5').toLowerCase()
  if (type === 'minecraft-proxy' || type === 'direct') return false
  return type === 'socks5' || type === 'socks' || type === 'socks4'
}

function socksVersion(proxy = {}) {
  return String(proxy.type || proxy.proxyType || 'socks5').toLowerCase() === 'socks4' ? 4 : 5
}

function hasAccountStyleProxyEndpoint(source = {}) {
  return source.proxyHost !== undefined || source.proxyPort !== undefined
}

function pickProxySource(source = {}) {
  if (source.proxy === false || source.proxyEnabled === false) return null
  if (hasAccountStyleProxyEndpoint(source)) {
    return {
      id: source.proxyId,
      type: source.proxyType,
      host: source.proxyHost,
      port: source.proxyPort,
      username: source.proxyUsername,
      password: source.proxyPassword,
      timeoutMs: source.proxyConnectTimeoutMs
    }
  }
  if (source.proxy && typeof source.proxy === 'object') return { ...source.proxy }
  return null
}

function normalizeProxyConfig(source = {}) {
  const proxy = pickProxySource(source)
  if (!proxy) return null

  const host = String(proxy.host || proxy.proxyHost || '').trim()
  const port = toNumber(proxy.port ?? proxy.proxyPort, null)
  if (!host || !Number.isFinite(port) || port <= 0) return null

  return {
    id: String(proxy.id || proxy.proxyId || `${host}:${port}`).trim(),
    type: proxy.type || proxy.proxyType || 'socks5',
    host,
    port,
    username: proxy.username || proxy.user || proxy.proxyUsername || '',
    password: proxy.password || proxy.pass || proxy.proxyPassword || '',
    timeoutMs: toNumber(proxy.timeoutMs ?? proxy.proxyConnectTimeoutMs, null)
  }
}

function createSocksConnect({ proxy, destination, timeoutMs = 30000, logger = null }) {
  return (client) => {
    let SocksClient
    try {
      SocksClient = require('socks').SocksClient
    } catch (err) {
      client.emit('error', new Error('Missing dependency "socks". Run npm install before using SOCKS proxies.'))
      return
    }

    SocksClient.createConnection({
      command: 'connect',
      timeout: timeoutMs,
      proxy: {
        host: proxy.host,
        port: Number(proxy.port),
        type: socksVersion(proxy),
        userId: proxy.username || proxy.user || undefined,
        password: proxy.password || proxy.pass || undefined
      },
      destination: {
        host: destination.host,
        port: Number(destination.port)
      }
    }).then((info) => {
      logger?.info?.(`SOCKS${socksVersion(proxy)} proxy connected ${proxy.host}:${proxy.port} -> ${destination.host}:${destination.port}`)
      client.setSocket(info.socket)
      client.emit('connect')
    }).catch((err) => {
      client.emit('error', err)
    })
  }
}

function applyProxyToOptions(options, source = {}, settings = {}) {
  const proxy = normalizeProxyConfig(source)
  if (!proxy || !isSocksProxy(proxy)) return null

  options.connect = createSocksConnect({
    proxy,
    destination: {
      host: options.host,
      port: options.port
    },
    timeoutMs: toNumber(settings.timeoutMs ?? proxy.timeoutMs ?? source.proxyConnectTimeoutMs, 30000),
    logger: settings.logger || null
  })
  return proxy
}

function formatProxyForLog(proxy) {
  const normalized = normalizeProxyConfig(proxy) || proxy
  if (!normalized) return 'direct'
  const user = normalized.username ? ` user=${normalized.username}` : ''
  return `${normalized.id || 'proxy'} ${String(normalized.type || 'socks5').toUpperCase()} ${normalized.host}:${normalized.port}${user}`
}

module.exports = {
  applyProxyToOptions,
  createSocksConnect,
  formatProxyForLog,
  isSocksProxy,
  normalizeProxyConfig,
  socksVersion
}
