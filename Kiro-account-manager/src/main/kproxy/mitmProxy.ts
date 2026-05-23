// K-Proxy MITM 代理核心
import * as http from 'http'
import * as net from 'net'
import * as tls from 'tls'
import * as url from 'url'
import type { KProxyConfig, KProxyStats, KProxyEvents, KProxyRequestInfo } from './types'
import { CertManager } from './certManager'

// Machine ID 正则匹配模式（64位十六进制）
const MACHINE_ID_REGEX = /[a-f0-9]{64}/gi
// 支持两种格式：KiroIDE-0.6.18-{machineId} 或 KiroIDE 0.6.18 {machineId}
const KIRO_UA_REGEX = /KiroIDE[-\s][\d.]+[-\s]([a-f0-9]{64})/i

/**
 * K-Proxy MITM 代理服务器
 */
export class MitmProxy {
  private server: http.Server | null = null
  private certManager: CertManager
  private config: KProxyConfig
  private stats: KProxyStats
  private events: KProxyEvents
  private tlsServers: Map<string, tls.Server> = new Map()

  constructor(certManager: CertManager, config: KProxyConfig, events: KProxyEvents = {}) {
    this.certManager = certManager
    this.config = config
    this.events = events
    this.stats = {
      totalRequests: 0,
      mitmRequests: 0,
      bypassRequests: 0,
      modifiedRequests: 0,
      startTime: 0,
      lastRequestTime: 0
    }
  }

  /**
   * 启动代理服务器
   */
  async start(): Promise<void> {
    if (this.server) {
      console.log('[MitmProxy] Server already running')
      return
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res)
      })

      // 处理 CONNECT 请求（HTTPS 隧道）
      this.server.on('connect', (req, clientSocket: net.Socket, head) => {
        this.handleConnect(req, clientSocket, head)
      })

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`[MitmProxy] Port ${this.config.port} is already in use`)
          reject(new Error(`Port ${this.config.port} is already in use`))
        } else {
          console.error('[MitmProxy] Server error:', error)
          this.events.onError?.(error)
          reject(error)
        }
      })

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[MitmProxy] Started on ${this.config.host}:${this.config.port}`)
        this.stats.startTime = Date.now()
        this.events.onStatusChange?.(true, this.config.port)
        resolve()
      })
    })
  }

  /**
   * 停止代理服务器
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    // 关闭所有 TLS 服务器
    for (const tlsServer of this.tlsServers.values()) {
      tlsServer.close()
    }
    this.tlsServers.clear()

    return new Promise((resolve) => {
      this.server!.close(() => {
        console.log('[MitmProxy] Stopped')
        this.server = null
        this.events.onStatusChange?.(false, this.config.port)
        resolve()
      })
    })
  }

  /**
   * 处理 HTTP 请求
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.stats.totalRequests++
    this.stats.lastRequestTime = Date.now()

    const targetUrl = url.parse(req.url || '')
    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: targetUrl.path,
      method: req.method,
      headers: req.headers
    }

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (error) => {
      console.error('[MitmProxy] HTTP proxy error:', error)
      res.writeHead(502)
      res.end('Bad Gateway')
    })

    req.pipe(proxyReq)
  }

  /**
   * 处理 CONNECT 请求（HTTPS 隧道）
   */
  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    this.stats.totalRequests++
    this.stats.lastRequestTime = Date.now()

    const [hostname, portStr] = (req.url || '').split(':')
    const port = parseInt(portStr, 10) || 443

    // 检查是否需要 MITM
    const shouldMitm = this.shouldMitm(hostname)

    if (shouldMitm) {
      this.stats.mitmRequests++
      this.handleMitmConnect(hostname, port, clientSocket, head)
    } else {
      this.stats.bypassRequests++
      this.handleDirectConnect(hostname, port, clientSocket, head)
    }
  }

  /**
   * 检查域名是否需要 MITM
   */
  private shouldMitm(hostname: string): boolean {
    for (const domain of this.config.mitmDomains) {
      if (hostname.includes(domain)) {
        if (this.config.logRequests) {
          console.log(`[MitmProxy] MITM: ${hostname} matches ${domain}`)
        }
        return true
      }
    }
    if (this.config.logRequests) {
      console.log(`[MitmProxy] Bypass: ${hostname}`)
    }
    return false
  }

  /**
   * 直接转发连接（不解密）
   */
  private handleDirectConnect(
    hostname: string,
    port: number,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      serverSocket.write(head)
      serverSocket.pipe(clientSocket)
      clientSocket.pipe(serverSocket)
    })

    serverSocket.on('error', (error) => {
      console.error(`[MitmProxy] Direct connect error to ${hostname}:${port}:`, error.message)
      clientSocket.end()
    })

    clientSocket.on('error', (error) => {
      console.error(`[MitmProxy] Client socket error:`, error.message)
      serverSocket.end()
    })
  }

  /**
   * MITM 拦截连接
   */
  private handleMitmConnect(
    hostname: string,
    port: number,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    try {
      // 为目标域名生成证书
      const { cert, key } = this.certManager.generateCertForHost(hostname)

      // 创建 TLS 连接选项
      const tlsOptions = {
        key,
        cert
      }

      // 通知客户端连接已建立
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

      // 创建 TLS 连接
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        ...tlsOptions,
        isServer: true,
        ALPNProtocols: ['http/1.1']
      })

      // 处理 TLS 错误
      tlsSocket.on('error', (error) => {
        console.error(`[MitmProxy] TLS error for ${hostname}:`, error.message)
        clientSocket.end()
      })

      // If the client already sent TLS bytes with CONNECT, feed them into TLSSocket.
      if (head.length > 0) tlsSocket.unshift(head)

      // 处理解密后的请求
      this.handleDecryptedConnection(tlsSocket, hostname, port)
    } catch (error) {
      console.error(`[MitmProxy] MITM setup error for ${hostname}:`, error)
      clientSocket.end()
    }
  }

  /**
   * 处理解密后的 HTTPS 连接
   */
  private handleDecryptedConnection(
    clientSocket: tls.TLSSocket,
    hostname: string,
    port: number
  ): void {
    let requestBuffer = Buffer.alloc(0)
    let headersParsed = false
    let contentLength = 0
    let bodyReceived = 0
    let modifiedHeaders = ''
    let requestInfo: KProxyRequestInfo | null = null

    const onClientData = (chunk: Buffer): void => {
      if (!headersParsed) {
        requestBuffer = Buffer.concat([requestBuffer, chunk])
        const headerEnd = requestBuffer.indexOf('\r\n\r\n')

        if (headerEnd !== -1) {
          headersParsed = true
          const headers = requestBuffer.subarray(0, headerEnd).toString('latin1')
          const bodyBuffer = requestBuffer.subarray(headerEnd + 4)

          // 解析并修改请求头
          const { modified, newHeaders, info } = this.modifyHeaders(headers, hostname)
          modifiedHeaders = newHeaders
          requestInfo = info

          // 记录请求
          if (requestInfo) {
            this.events.onRequest?.(requestInfo)
            this.events.onMitmIntercept?.(hostname, modified)
          }

          // 获取 Content-Length
          const clMatch = headers.match(/content-length:\s*(\d+)/i)
          if (clMatch) {
            contentLength = parseInt(clMatch[1], 10)
          }

          const contentType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.toLowerCase() || ''
          let modifiedBody = bodyBuffer
          if (contentType.includes('json') || contentType.includes('text')) {
            const body = bodyBuffer.toString('utf8')
            const modifiedText = this.modifyBody(body)
            if (modifiedText !== body) {
              modifiedBody = Buffer.from(modifiedText, 'utf8')
              modifiedHeaders = modifiedHeaders.replace(
                /content-length:\s*\d+/i,
                `content-length: ${modifiedBody.length}`
              )
              contentLength = modifiedBody.length
            }
          }
          bodyReceived = modifiedBody.length

          // Stop the TLS socket while the upstream TLS connection is being established.
          // Large Kiro/Claude requests are commonly split across multiple TLS data chunks.
          // Previously those chunks could arrive before forwardRequest attached its own
          // listener, while this parser listener ignored them after headersParsed=true.
          // That dropped part of the request body, leaving upstream waiting for the
          // declared Content-Length until the app-side endpoint timeout fired.
          clientSocket.pause()
          clientSocket.removeListener('data', onClientData)

          // 转发请求到目标服务器
          this.forwardRequest(
            modifiedHeaders,
            modifiedBody,
            hostname,
            port,
            clientSocket,
            contentLength,
            bodyReceived
          )
        }
      }
    }

    clientSocket.on('data', onClientData)

    clientSocket.on('error', (error) => {
      console.error(`[MitmProxy] Decrypted connection error:`, error.message)
    })
  }

  /**
   * 替换请求体中的 Machine ID
   */
  private modifyBody(body: string): string {
    const targetDeviceId = this.config.deviceId
    if (!targetDeviceId || !body) return body
    // 只在 body 中包含 64 位十六进制时才替换（避免误伤无关内容）
    if (!MACHINE_ID_REGEX.test(body)) return body
    MACHINE_ID_REGEX.lastIndex = 0
    const result = body.replace(MACHINE_ID_REGEX, (match) => {
      // 不替换已经是目标 ID 的
      if (match.toLowerCase() === targetDeviceId.toLowerCase()) return match
      if (this.config.logRequests) {
        console.log(
          `[MitmProxy] Replaced Machine ID in body: ${match.substring(0, 16)}... -> ${targetDeviceId.substring(0, 16)}...`
        )
      }
      return targetDeviceId
    })
    MACHINE_ID_REGEX.lastIndex = 0
    return result
  }

  /**
   * 修改请求头（替换 Machine ID）
   */
  private modifyHeaders(
    headers: string,
    hostname: string
  ): { modified: boolean; newHeaders: string; info: KProxyRequestInfo } {
    const lines = headers.split('\r\n')
    const firstLine = lines[0]
    const [method, path] = firstLine.split(' ')

    let modified = false
    let originalDeviceId: string | undefined
    let newDeviceId: string | undefined
    const targetDeviceId = this.config.deviceId

    const info: KProxyRequestInfo = {
      timestamp: Date.now(),
      method: method || 'UNKNOWN',
      host: hostname,
      path: path || '/',
      isMitm: true,
      deviceIdReplaced: false
    }

    if (!targetDeviceId) {
      return { modified: false, newHeaders: headers, info }
    }

    const modifiedLines = lines.map((line) => {
      const lowerLine = line.toLowerCase()

      // 检查 user-agent 和 x-amz-user-agent
      if (lowerLine.startsWith('user-agent:') || lowerLine.startsWith('x-amz-user-agent:')) {
        const match = line.match(KIRO_UA_REGEX)
        if (match) {
          originalDeviceId = match[1]
          const newLine = line.replace(MACHINE_ID_REGEX, targetDeviceId)
          if (newLine !== line) {
            modified = true
            newDeviceId = targetDeviceId
            if (this.config.logRequests) {
              console.log(`[MitmProxy] Replaced Machine ID in ${line.split(':')[0]}`)
              console.log(`  Original: ${originalDeviceId?.substring(0, 16)}...`)
              console.log(`  New: ${targetDeviceId.substring(0, 16)}...`)
            }
            return newLine
          }
        }
      }
      return line
    })

    if (modified) {
      this.stats.modifiedRequests++
      info.deviceIdReplaced = true
      info.originalDeviceId = originalDeviceId
      info.newDeviceId = newDeviceId
    }

    return {
      modified,
      newHeaders: modifiedLines.join('\r\n'),
      info
    }
  }

  /**
   * 转发请求到目标服务器
   */
  private forwardRequest(
    headers: string,
    initialBody: Buffer,
    hostname: string,
    port: number,
    clientSocket: tls.TLSSocket,
    contentLength: number,
    bodyReceived: number
  ): void {
    const startTime = Date.now()

    // 连接到目标服务器
    const serverSocket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        rejectUnauthorized: true
      },
      () => {
        // 发送修改后的请求头
        serverSocket.write(headers + '\r\n\r\n')

        // 发送已接收的请求体
        if (initialBody.length > 0) {
          serverSocket.write(initialBody)
        }

        // 如果还有更多数据，继续转发
        if (bodyReceived < contentLength) {
          const onBodyData = (chunk: Buffer): void => {
            serverSocket.write(chunk)
            bodyReceived += chunk.length
            if (bodyReceived >= contentLength) {
              clientSocket.removeListener('data', onBodyData)
            }
          }
          clientSocket.on('data', onBodyData)
          clientSocket.resume()
        } else {
          clientSocket.resume()
        }
      }
    )

    // 将响应转发回客户端
    serverSocket.on('data', (chunk: Buffer) => {
      clientSocket.write(chunk)
    })

    serverSocket.on('end', () => {
      const duration = Date.now() - startTime
      this.events.onResponse?.({
        timestamp: Date.now(),
        host: hostname,
        statusCode: 200,
        duration
      })
      clientSocket.end()
    })

    serverSocket.on('error', (error) => {
      console.error(`[MitmProxy] Server connection error to ${hostname}:`, error.message)
      clientSocket.end()
    })

    clientSocket.on('end', () => {
      serverSocket.end()
    })

    clientSocket.on('error', () => {
      serverSocket.end()
    })
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<KProxyConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * 获取配置
   */
  getConfig(): KProxyConfig {
    return { ...this.config }
  }

  /**
   * 获取统计信息
   */
  getStats(): KProxyStats {
    return { ...this.stats }
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      mitmRequests: 0,
      bypassRequests: 0,
      modifiedRequests: 0,
      startTime: this.stats.startTime,
      lastRequestTime: 0
    }
  }

  /**
   * 检查是否运行中
   */
  isRunning(): boolean {
    return this.server !== null
  }
}
