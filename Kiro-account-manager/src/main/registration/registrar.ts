import { ModuleClient, SessionClient } from 'tlsclientwrapper'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { RegistrationConfig } from './config'
import { BrowserIdentity, randomIdentity } from './browser-identity'
import { FingerprintContext, newFPContext, resetPerfTiming, generateFingerprint } from './fingerprint'
import { encryptPassword } from './jwe'
import { refreshAppJSConfig } from './xxtea'
import {
  DEFAULT_UA, DEFAULT_SEC_UA,
  visitorId, awsccc, ubidGen, amznFbgId, newUUID, gmtDate,
  extractParam, splitAfter, saveCookies,
  getNestedMap, getNestedStringMap
} from './http-utils'
import {
  TempEmailService, MoEmailService, TempMailPlusService,
  DuckDuckGoEmailService, GmailIMAPAccount,
  parseOutlookLines, getInboxCount, waitForOTP
} from './email-service'
import { getSystemProxy, safeCreateProxyAgent } from '../proxy/systemProxy'

export type LogFn = (message: string) => void

export interface FingerprintSnapshot {
  chromeVer: string
  ua: string
  gpuVendor: string
  gpuModel: string
  canvasHash: number
  screen: { width: number; height: number }
  /** 注册时使用的出口代理 URL（脱敏前缀） */
  proxyUrl?: string
}

export interface RegistrationResult {
  status: 'success' | 'failed'
  email: string
  password?: string
  error?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  accessToken?: string
  region?: string
  provider?: string
  verify?: Record<string, unknown>
  /** 本次注册使用的指纹摘要（用于审计与后续复用） */
  fingerprint?: FingerprintSnapshot
}

type StepFn = () => Promise<void>

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class Registrar {
  private cfg: RegistrationConfig
  private session: SessionClient | null = null
  private moduleClient: ModuleClient | null = null
  private cookies = new Map<string, string>()
  private identity: BrowserIdentity
  private fpCtx: FingerprintContext
  private vid: string

  private email = ''
  private emailSvc: TempEmailService | null = null
  private clientId = ''
  private clientSecret = ''
  private deviceCode = ''
  private userCode = ''
  private workflowHandle = ''
  private workflowId = ''
  private workflowState = ''
  private ubid = ''
  private regCode = ''
  private signState = ''
  private authCode = ''
  private ssoState = ''
  private wdcCSRFToken = ''
  private ssoToken = ''
  private outlookMailCount = 0

  private log: LogFn
  private abortController = new AbortController()

  constructor(cfg: RegistrationConfig, log?: LogFn) {
    this.cfg = cfg
    this.identity = randomIdentity()
    this.fpCtx = newFPContext(this.identity)
    this.vid = visitorId()
    this.log = log || ((msg) => console.log(msg))
  }

  /** 中止当前注册流程 */
  abort(): void {
    this.abortController.abort()
  }

  private checkAborted(): void {
    if (this.abortController.signal.aborted) throw new Error('注册已取消')
  }

  /** TLS SessionClient 选项 */
  private get sessionOpts() {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || getSystemProxy() || undefined
    // Match TLS fingerprint to Chrome 148 UA — rotate between recent Chrome identifiers
    const tlsIds = ['chrome_120', 'chrome_124', 'chrome_131', 'chrome_133'] as const
    const tlsClientIdentifier = tlsIds[Math.floor(Math.random() * tlsIds.length)]
    return {
      tlsClientIdentifier,
      timeoutSeconds: 60,
      followRedirects: true,
      insecureSkipVerify: true,
      proxyUrl
    }
  }

  /**
   * 初始化 TLS 客户端
   *
   * DLL 存储策略（按优先级，从高到低）：
   *   1. userData/tls-client/ — 应用用户数据目录（系统不会清理，**永久复用**）
   *   2. resources/ — 应用安装目录（打包资源，开发版可能不存在）
   *   3. tmpdir → 自动迁移到 userData（老版本兼容）
   *   4. GitHub 下载到 userData（最后兜底，仅首次）
   */
  private async initTlsClient(): Promise<void> {
    const { existingPath, downloadDir } = this.ensureTlsLib()
    // 已有具体文件 → customLibraryPath；否则 → customLibraryDownloadPath，让 open() 自动下载
    const opts = existingPath
      ? { customLibraryPath: existingPath }
      : { customLibraryDownloadPath: downloadDir }
    this.moduleClient = new ModuleClient(opts)
    await this.moduleClient.open()  // open() 内部会按需 downloadLibrary
    this.log('[TLS] open() completed, pool stats: ' + JSON.stringify(this.moduleClient.getPoolStats()))
    this.session = new SessionClient(this.moduleClient, this.sessionOpts)
  }

  /**
   * 确保 tls-client 共享库可用
   * @returns existingPath 已经存在的完整 DLL 文件路径（如有，传 customLibraryPath）
   *          downloadDir  需要下载到的目录（如未找到，传 customLibraryDownloadPath 让 tlsclientwrapper 自动下载）
   *
   * 优先放到 userData，避免被系统临时目录清理工具误删（之前用 tmpdir 会被清理）
   */
  private ensureTlsLib(): { existingPath?: string; downloadDir: string } {
    const os = require('os')
    const path = require('path')
    const fs = require('fs')
    const { app } = require('electron')

    const platform = os.platform()
    const arch = os.arch()
    let filename = 'tls-client-xgo-1.14.0-'
    if (platform === 'win32') {
      filename += (arch.includes('64') ? 'windows-amd64' : 'windows-386') + '.dll'
    } else if (platform === 'darwin') {
      filename += (arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64') + '.dylib'
    } else {
      filename += (arch === 'arm64' ? 'linux-arm64' : 'linux-amd64') + '.so'
    }

    // 1. userData 永久目录（首选）
    const userDataDir = app.getPath('userData')
    const tlsClientDir = path.join(userDataDir, 'tls-client')
    const finalPath = path.join(tlsClientDir, filename)

    // 确保目录存在
    try { fs.mkdirSync(tlsClientDir, { recursive: true }) } catch { /* ignore */ }

    // 已存在 → 直接复用
    if (fs.existsSync(finalPath)) {
      this.log('[TLS] Library reused from userData (persistent): ' + finalPath)
      return { existingPath: finalPath, downloadDir: tlsClientDir }
    }

    // 2. 从打包资源复制（安装包自带）
    const resourcePath = path.join(process.resourcesPath || '', filename)
    if (fs.existsSync(resourcePath)) {
      this.log('[TLS] Copying library from resources to userData (one-time): ' + resourcePath + ' -> ' + finalPath)
      try {
        fs.copyFileSync(resourcePath, finalPath)
        return { existingPath: finalPath, downloadDir: tlsClientDir }
      } catch (err) {
        this.log('[TLS] Failed to copy from resources: ' + (err as Error).message)
      }
    }

    // 3. 兼容老版本：检测 tmpdir 副本并迁移到 userData
    const tmpPath = path.join(os.tmpdir(), filename)
    if (fs.existsSync(tmpPath)) {
      this.log('[TLS] Migrating library from tmpdir to userData: ' + tmpPath + ' -> ' + finalPath)
      try {
        fs.copyFileSync(tmpPath, finalPath)
        return { existingPath: finalPath, downloadDir: tlsClientDir }
      } catch (err) {
        this.log('[TLS] Migration failed, will use tmpdir as fallback: ' + (err as Error).message)
        return { existingPath: tmpPath, downloadDir: tlsClientDir }
      }
    }

    // 4. 都没有 → 返回 downloadDir，让 tlsclientwrapper open() 自动下载到此目录（永久保存）
    this.log('[TLS] Library not found, will download from GitHub to userData (one-time): ' + tlsClientDir)
    return { downloadDir: tlsClientDir }
  }

  private async rebuildTlsClient(): Promise<void> {
    try { await this.session?.destroySession() } catch { /* ignore */ }
    this.session = null
    if (this.moduleClient) {
      try { await this.moduleClient.terminate() } catch { /* ignore */ }
      this.moduleClient = null
    }
    await this.initTlsClient()
  }

  /**
   * 用 undici 直接 fetch 静态资源（如 AWS signin app.js），绕过 tls-client。
   * 原因：tls-client 的 dll 是进程级单例，失败请求会污染其全局状态，
   * 导致后续重建 SessionClient 后仍报 "no tls client for modification check"。
   * 静态资源不需要 TLS 指纹伪装，直接用 Node/undici fetch 即可。
   */
  private async fetchAppJS(url: string, init?: RequestInit): Promise<Response> {
    const proxyUrl = (this.cfg.proxy && this.cfg.proxy.trim())
      || process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || getSystemProxy() || undefined
    const agent = safeCreateProxyAgent(proxyUrl)
    if (agent) {
      const resp = await undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher: agent })
      return resp as unknown as Response
    }
    return await fetch(url, init)
  }

  private isRecoverableTlsClientError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    return err.message.includes('EOF')
      || err.message.includes('no tls client for modification check')
      || err.message.includes('failed to modify existing client')
  }

  /** 清理 TLS 客户端资源 */
  private async cleanup(): Promise<void> {
    if (this.session) {
      try { await this.session.destroySession() } catch { /* ignore */ }
      this.session = null
    }
    if (this.moduleClient) {
      try {
        await this.moduleClient.terminate()
      } catch (err: unknown) {
        // piscina 线程池终止时可能有排队任务被中止，属于预期行为
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('aborted') && !msg.includes('terminated')) {
          console.error('Error during ModuleClient termination:', err)
        }
      }
      this.moduleClient = null
    }
  }

  /** 公共销毁方法，供外部调用释放资源 */
  async destroy(): Promise<void> {
    await this.cleanup()
  }

  // ============ HTTP 工具方法 ============

  private cookieString(): string {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private buildHeaders(referer: string, origin: string): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Content-Type': 'application/json',
      'User-Agent': DEFAULT_UA,
      'sec-ch-ua': DEFAULT_SEC_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    }
    if (referer) h['Referer'] = referer
    if (origin) h['Origin'] = origin
    if (this.cookies.size > 0) h['Cookie'] = this.cookieString()
    return h
  }

  private buildProfileHeaders(referer: string): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': DEFAULT_UA,
      'Origin': this.cfg.profileBase,
      'Referer': referer,
      'sec-ch-ua': DEFAULT_SEC_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'priority': 'u=1, i'
    }
    const keys = ['awsccc', 'aws-user-profile-ubid', 'amznfbgid', 'i18next']
    if (this.cookies.has('awsd2c-token')) keys.push('awsd2c-token', 'awsd2c-token-c')
    const parts = keys.filter((k) => this.cookies.has(k)).map((k) => `${k}=${this.cookies.get(k)}`)
    if (parts.length) h['Cookie'] = parts.join('; ')
    return h
  }

  private async doGet(url: string, headers: Record<string, string>): Promise<{ body: string; status: number; headers: Record<string, string | string[]> }> {
    if (!this.session) throw new Error('TLS 客户端未初始化')
    try {
      const resp = await this.session.get(url, { headers })
      return { body: this.decodeBody(resp.body), status: resp.status, headers: (resp.headers || {}) as Record<string, string | string[]> }
    } catch (err: unknown) {
      if (this.isRecoverableTlsClientError(err)) {
        this.log('[TLS] Recoverable GET error, rebuilding TLS client: ' + (err instanceof Error ? err.message : String(err)))
        await this.rebuildTlsClient()
        const resp = await this.session!.get(url, { headers })
        return { body: this.decodeBody(resp.body), status: resp.status, headers: (resp.headers || {}) as Record<string, string | string[]> }
      }
      throw err
    }
  }

  private async doPost(url: string, payload: unknown, headers: Record<string, string>): Promise<{ body: string; status: number; headers: Record<string, string | string[]> }> {
    if (!this.session) throw new Error('TLS 客户端未初始化')
    const body = JSON.stringify(payload)
    try {
      const resp = await this.session.post(url, body, { headers })
      return { body: this.decodeBody(resp.body), status: resp.status, headers: (resp.headers || {}) as Record<string, string | string[]> }
    } catch (err: unknown) {
      if (this.isRecoverableTlsClientError(err)) {
        this.log('[TLS] Recoverable POST error, rebuilding TLS client: ' + (err instanceof Error ? err.message : String(err)))
        await this.rebuildTlsClient()
        const resp = await this.session!.post(url, body, { headers })
        return { body: this.decodeBody(resp.body), status: resp.status, headers: (resp.headers || {}) as Record<string, string | string[]> }
      }
      throw err
    }
  }

  /**
   * tls-client 返回的 body 是字节透传字符串（latin1）；
   * 如果响应实际是 UTF-8 编码（含中文等多字节），需要二次解码。
   * 实现：把 string 当作 latin1 字节读回，再用 UTF-8 解码；
   * 若解码后含 U+FFFD 替换字符比原文多很多，则回退原值（说明原本就是 latin1 / ASCII）。
   */
  private decodeBody(body: string | undefined | null): string {
    if (!body) return ''
    try {
      // 快速路径：纯 ASCII 直接返回
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7F]*$/.test(body)) return body
      const buf = Buffer.from(body, 'latin1')
      const utf8 = buf.toString('utf-8')
      // 检测 mojibake：原文如果在 latin1 解码 UTF-8 字节，会出现大量字符在 \u00a0-\u00ff 区间
      // 重解后如果替换字符数量明显多于原文，说明不是 UTF-8，回退原值
      const replaceInOriginal = (body.match(/\uFFFD/g) || []).length
      const replaceInUtf8 = (utf8.match(/\uFFFD/g) || []).length
      if (replaceInUtf8 > replaceInOriginal + 2) return body
      return utf8
    } catch {
      return body
    }
  }

  private parseBody(body: string): Record<string, unknown> {
    try { return JSON.parse(body) } catch { return {} }
  }

  /**
   * 识别 AWS 风控触发的错误响应，返回人类可读的标签
   * @returns 风控类型标签（如 'AWS-RISK-CONTROL'），不是风控返回 null
   */
  private detectRiskControl(body: string, status: number): string | null {
    if (status !== 400) return null
    const lower = body.toLowerCase()
    // 中文消息（已正确解码）
    if (body.includes('请稍后再试') && body.includes('管理员')) return 'AWS-RISK-CONTROL'
    if (body.includes('发生意外错误')) return 'AWS-RISK-CONTROL'
    // 英文消息
    if (lower.includes('try again later') && lower.includes('administrator')) return 'AWS-RISK-CONTROL'
    if (lower.includes('unexpected error') && lower.includes('contact')) return 'AWS-RISK-CONTROL'
    return null
  }

  /** 把响应错误格式化为更友好的消息（含风控识别） */
  private formatErrorBody(body: string, status: number): string {
    const risk = this.detectRiskControl(body, status)
    if (risk) {
      return `${risk}（AWS 风控，建议：1) 启用代理池 N:1 分桶；2) 启用限速 + 风控自动暂停；3) 避免同邮箱域名大量注册）`
    }
    return `status=${status} body=${body.substring(0, 200)}`
  }

  private async fetchD2CToken(origin: string, referer: string): Promise<void> {
    const headers: Record<string, string> = {
      'Accept': '*/*', 'Content-Type': 'application/json',
      'User-Agent': DEFAULT_UA, 'Origin': origin, 'Referer': referer,
      'sec-ch-ua': DEFAULT_SEC_UA, 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'priority': 'u=1, i'
    }
    const parts: string[] = []
    if (this.cookies.has('awsccc')) parts.push('awsccc=' + this.cookies.get('awsccc'))
    if (this.cookies.has('awsd2c-token')) {
      const old = this.cookies.get('awsd2c-token')!
      parts.push('awsd2c-token=' + old, 'awsd2c-token-c=' + old)
    }
    if (parts.length) headers['Cookie'] = parts.join('; ')

    const payload: Record<string, string> = {}
    if (this.cookies.has('awsd2c-token')) payload.token = this.cookies.get('awsd2c-token')!

    const resp = await this.doPost('https://vs.aws.amazon.com/token', payload, headers)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    const tok = data.token as string
    if (tok) {
      this.cookies.set('awsd2c-token', tok)
      this.cookies.set('awsd2c-token-c', tok)
      // 从 JWT 中提取 visitor ID
      const jwtParts = tok.split('.')
      if (jwtParts.length >= 2) {
        try {
          const decoded = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString())
          if (decoded.vid) this.vid = decoded.vid
        } catch { /* ignore */ }
      }
    }
  }

  // ============ 指纹生成 ============

  private genFP(pageType: string, eventType: string, emailLen: number, emailAddr: string): string {
    return this.genFPWithTime(pageType, eventType, 0, emailLen, emailAddr)
  }

  private genFPWithTime(pageType: string, eventType: string, timeOnPage: number, emailLen: number, emailAddr: string): string {
    const did = this.cfg.directoryId
    let loc = '', ref = ''

    switch (pageType) {
      case 'signin':
        loc = `${this.cfg.signinBase}/platform/${did}/login?workflowStateHandle=${this.workflowHandle}`
        break
      case 'signup':
        loc = `${this.cfg.signinBase}/platform/${did}/signup?workflowStateHandle=${this.workflowHandle}`
        break
      default: // profile
        if (eventType === 'PageSubmit') {
          loc = `${this.cfg.profileBase}/?workflowID=${this.workflowId}#/signup/enter-email`
        } else {
          loc = `${this.cfg.profileBase}/?workflowID=${this.workflowId}#/signup/start`
        }
        if (!this.workflowId) loc = this.cfg.profileBase + '/'
    }

    if (pageType === 'profile') {
      ref = `${this.cfg.signinBase}/platform/${did}/signup?workflowStateHandle=${this.workflowHandle}`
    } else {
      ref = this.cfg.viewBase + '/'
    }

    return generateFingerprint(this.identity, loc, ref, this.fpCtx, pageType, eventType, timeOnPage, emailLen, emailAddr)
  }

  // ============ 注册步骤 ============

  private async step1OIDC(): Promise<void> {
    this.log('[1] OIDC 注册')
    const payload = {
      clientName: 'Amazon Q Developer for command line',
      clientType: 'public',
      scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations', 'codewhisperer:transformations', 'codewhisperer:taskassist']
    }
    const headers = { 'Content-Type': 'application/json' }

    let resp: { body: string; status: number; headers: Record<string, string | string[]> } | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        resp = await this.doPost(this.cfg.oidcBase + '/client/register', payload, headers)
        if (resp.status === 200) break
      } catch (err: unknown) {
        if (attempt < 2) {
          this.log(`[1] OIDC 重试 (${attempt + 1}/3)...`)
          await sleep(2000 * (attempt + 1))
          await this.rebuildTlsClient()
          continue
        }
        throw err
      }
    }
    if (!resp) throw new Error('OIDC 注册失败: 所有重试均失败')
    const data = this.parseBody(resp.body)
    this.clientId = (data.clientId as string) || ''
    this.clientSecret = (data.clientSecret as string) || ''
    if (!this.clientId) throw new Error(`OIDC 注册失败: ${resp.body.slice(0, 200)}`)
  }

  private async step2Device(): Promise<void> {
    this.log('[2] 设备授权')
    const resp = await this.doPost(this.cfg.oidcBase + '/device_authorization', {
      clientId: this.clientId, clientSecret: this.clientSecret,
      startUrl: this.cfg.startURL
    }, { 'Content-Type': 'application/json' })
    const data = this.parseBody(resp.body)
    this.deviceCode = (data.deviceCode as string) || ''
    this.userCode = (data.userCode as string) || ''
    this.log(`user_code=${this.userCode}`)
  }

  private async step3Email(): Promise<void> {
    if (this.cfg.manualMode) return // 手动模式在外部设置

    if (this.cfg.useOutlook && this.cfg.outlookData) {
      this.log('[3] 使用 Outlook 邮箱')
      const accounts = parseOutlookLines(this.cfg.outlookData)
      if (accounts.length === 0) throw new Error('无可用的 Outlook 账号')
      // 单行 → 直接用（批量并发时前端已为每个 task 切一行，避免并发抢占）
      // 多行（单次注册）→ 随机挑一行
      const acc = accounts.length === 1
        ? accounts[0]
        : accounts[Math.floor(Math.random() * accounts.length)]
      this.email = acc.email
      this.log(`email=${this.email}`)
      return
    }

    if (this.cfg.useTempMailPlus) {
      this.log('[3] 使用自建域名邮箱 (TempMail.Plus)')
      if (!this.cfg.tempMailPlusEmail || !this.cfg.tempMailPlusEpin || !this.cfg.tempMailPlusDomain) {
        throw new Error('TempMail.Plus 配置不完整')
      }
      this.emailSvc = new TempMailPlusService(
        this.cfg.tempMailPlusEmail, this.cfg.tempMailPlusEpin, this.cfg.tempMailPlusDomain
      )
      this.email = await this.emailSvc.create()
      if (!this.email) throw new Error('生成邮箱地址失败')
      this.log(`email=${this.email}`)
      return
    }

    if (this.cfg.useDDG) {
      this.log('[3] 使用 DuckDuckGo Email Protection')
      if (!this.cfg.ddgAuthToken || !this.cfg.ddgGmailEmail) {
        throw new Error('DDG 配置不完整 (需要 authToken 和 Gmail 地址)')
      }
      const gmailAccount: GmailIMAPAccount = {
        email: this.cfg.ddgGmailEmail,
        accessToken: this.cfg.ddgGmailAccessToken,
        appPassword: this.cfg.ddgGmailAppPassword || undefined
      }
      this.emailSvc = new DuckDuckGoEmailService(this.cfg.ddgAuthToken, gmailAccount)
      this.email = await this.emailSvc.create()
      if (!this.email) throw new Error('DDG 地址生成失败')
      this.log(`email=${this.email}`)
      return
    }

    this.log('[3] 创建临时邮箱')
    if (!this.cfg.moEmailBaseURL) throw new Error('MoEmail 未配置')
    this.emailSvc = new MoEmailService(this.cfg.moEmailBaseURL, this.cfg.moEmailAPIKey)
    this.email = await this.emailSvc.create()
    if (!this.email) throw new Error('创建临时邮箱失败')
    this.log(`email=${this.email}`)
  }

  private async step4Portal(): Promise<void> {
    this.log('[4] Portal 初始化')
    this.cookies.set('awsccc', awsccc())
    this.cookies.set('amznfbgid', amznFbgId())
    const redirect = `${this.cfg.viewBase}/start/#/device?user_code=${this.userCode}`
    const url = `${this.cfg.portalBase}/login?directory_id=view&redirect_url=${redirect}`

    const h: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'Origin': this.cfg.viewBase,
      'Referer': this.cfg.viewBase + '/',
      'User-Agent': DEFAULT_UA,
      'sec-ch-ua': DEFAULT_SEC_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site'
    }
    const resp = await this.doGet(url, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)

    const rurl = (data.redirectUrl as string) || ''
    if (rurl.includes('workflowStateHandle=')) {
      this.workflowHandle = splitAfter(rurl, 'workflowStateHandle=')
    }
    if (data.csrfToken) this.cookies.set('loginCsrfToken', data.csrfToken as string)
    if (!this.workflowHandle) throw new Error('Portal 未返回 workflow handle')

    const loginURL = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`
    await this.fetchD2CToken(this.cfg.signinBase, loginURL)
  }

  private async step5WorkflowInit(): Promise<void> {
    this.log('[5] 工作流初始化')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`

    let fp = this.genFP('signin', 'first_load', 0, '')
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: this.workflowHandle,
      inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
      requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string

    if (data.stepId === 'start') {
      fp = this.genFP('signin', 'PageLoad', 0, '')
      rid = newUUID()
      h = this.buildHeaders(ref, this.cfg.signinBase)
      h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

      resp = await this.doPost(api, {
        stepId: 'start', workflowStateHandle: this.workflowHandle,
        inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
        requestId: rid
      }, h)
      saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
      data = this.parseBody(resp.body)
      if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string
    }
  }

  private async step6SubmitEmail(): Promise<'signup' | 'login'> {
    this.log(`[6] 提交邮箱 ${this.email}`)
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`
    const fp = this.genFP('signin', 'PageSubmit', this.email.length, this.email)
    const rid = newUUID()
    const h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    const resp = await this.doPost(api, {
      stepId: 'get-identity-user', workflowStateHandle: this.workflowHandle,
      actionId: 'SUBMIT',
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'ApplicationTypeRequestInput', applicationType: 'SSO_INDIVIDUAL_ID' },
        {
          input_type: 'UserEventRequestInput', directoryId: this.cfg.directoryId,
          userName: this.email,
          userEvents: [{ input_type: 'UserEvent', eventType: 'PAGE_SUBMIT', pageName: 'IDENTIFICATION', timeSpentOnPage: 5000 }]
        },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string

    if (resp.status === 400) return 'signup'
    if (resp.status === 200) return 'login'
    throw new Error(`提交邮箱失败: ${resp.status} - ${resp.body.slice(0, 200)}`)
  }

  private async step7Signup(): Promise<void> {
    this.log('[7] 注册 (SIGNUP)')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`
    const fp = this.genFP('signup', 'PageSubmit', 0, '')
    const rid = newUUID()
    const h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    const resp = await this.doPost(api, {
      stepId: 'get-identity-user', workflowStateHandle: this.workflowHandle,
      actionId: 'SIGNUP',
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (rurl?.includes('workflowStateHandle=')) {
      this.workflowHandle = splitAfter(rurl, 'workflowStateHandle=')
    }
  }

  private async step7_5SignupInit(): Promise<void> {
    this.log('[7.5] Signup API 初始化')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup?workflowStateHandle=${this.workflowHandle}`

    let fp = this.genFP('signup', 'first_load', 0, '')
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: this.workflowHandle,
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string
    if (data.stepId !== 'start') throw new Error(`Signup init 失败: ${this.formatErrorBody(resp.body, resp.status)}`)

    fp = this.genFP('signup', 'PageLoad', 0, '')
    rid = newUUID()
    h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    resp = await this.doPost(api, {
      stepId: 'start', workflowStateHandle: this.workflowHandle,
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string
    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (rurl?.includes('workflowID=')) {
      let wid = splitAfter(rurl, 'workflowID=')
      const hashIdx = wid.indexOf('#')
      if (hashIdx >= 0) wid = wid.slice(0, hashIdx)
      this.workflowId = wid
    }
    if (!this.workflowId) throw new Error('Signup init 未返回 workflowID')
  }

  private async step7_8ProfileInit(): Promise<void> {
    this.log('[7.8] Profile 页面初始化')
    this.ubid = ubidGen()
    this.cookies.set('aws-user-profile-ubid', this.ubid)
    // amznfbgid is Amazon's fraud detection localStorage ID — must be present
    if (!this.cookies.has('amznfbgid')) this.cookies.set('amznfbgid', amznFbgId())
    // Don't set i18next — let the server set it via Set-Cookie to avoid locale mismatch
    if (!this.cookies.has('awsccc')) this.cookies.set('awsccc', awsccc())

    const url = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const resp = await this.doGet(url, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': DEFAULT_UA,
      'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate'
    })
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    resetPerfTiming(this.fpCtx)
    await this.fetchD2CToken(this.cfg.profileBase, url)
  }

  private async step8ProfileStart(): Promise<void> {
    this.log('[8] Profile 启动')
    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const fp = this.genFP('profile', 'PageLoad', 0, '')

    const resp = await this.doPost(this.cfg.profileBase + '/api/start', {
      workflowID: this.workflowId,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          timeSpentOnPage: String(800 + Math.floor(Math.random() * 2200)),
          eventType: 'PageLoad',
          ubid: this.ubid, visitorId: this.vid
        },
        cookies: {}
      }
    }, this.buildProfileHeaders(ref))
    const data = this.parseBody(resp.body)
    this.workflowState = (data.workflowState as string) || ''
    if (!this.workflowState) throw new Error(`Profile start 未返回 workflowState: ${resp.body.slice(0, 200)}`)
  }

  private async step9SendOTP(): Promise<void> {
    this.log('[9] 发送验证码')

    if (this.cfg.useOutlook && this.cfg.outlookData) {
      const accounts = parseOutlookLines(this.cfg.outlookData)
      const acc = accounts.find((a) => a.email === this.email)
      if (acc) {
        try {
          this.outlookMailCount = await getInboxCount(acc)
          this.log(`发送前邮件数: ${this.outlookMailCount}`)
        } catch (err) {
          this.log(`获取邮件数量失败: ${err}, 默认为0`)
        }
      }
    }

    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const timeOnPage = 5000 + Math.floor(Math.random() * 3001)
    const fp = this.genFPWithTime('profile', 'PageSubmit', timeOnPage, this.email.length, this.email)
    const tsp = String(timeOnPage)

    const payload = {
      workflowState: this.workflowState,
      email: this.email,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          timeSpentOnPage: tsp, pageName: 'EMAIL_COLLECTION',
          eventType: 'PageSubmit', ubid: this.ubid, visitorId: this.vid
        },
        cookies: {}
      }
    }

    const resp = await this.doPost(this.cfg.profileBase + '/api/send-otp', payload, this.buildProfileHeaders(ref))
    if (resp.status !== 200) throw new Error(`send-otp 失败 (${resp.status}), body: ${resp.body.substring(0, 300)}`)
    this.log('验证码已发送')
  }

  private async step10GetOTP(): Promise<string> {
    if (this.cfg.manualMode) throw new Error('手动模式需外部提供验证码')

    this.log('[10] 等待验证码')
    if (this.cfg.useOutlook && this.cfg.outlookData) {
      const accounts = parseOutlookLines(this.cfg.outlookData)
      const acc = accounts.find((a) => a.email === this.email)
      if (!acc) throw new Error('未找到对应 Outlook 账号')
      return await waitForOTP(acc, this.outlookMailCount, 120, 5)
    }
    if (!this.emailSvc) throw new Error('邮箱服务未初始化')
    return await this.emailSvc.waitForCode(120, 3)
  }

  private async step11CreateIdentity(otp: string): Promise<void> {
    this.log('[11] 创建身份')
    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const fp = this.genFP('profile', 'EmailVerification', 0, '')

    const resp = await this.doPost(this.cfg.profileBase + '/api/create-identity', {
      workflowState: this.workflowState,
      userData: { email: this.email, fullName: this.cfg.fullName },
      otpCode: otp,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          timeSpentOnPage: String(30000 + Math.floor(Math.random() * 30000)),
          pageName: 'EMAIL_VERIFICATION',
          eventType: 'EmailVerification', ubid: this.ubid, visitorId: this.vid
        },
        cookies: {}
      }
    }, this.buildProfileHeaders(ref))
    const data = this.parseBody(resp.body)
    this.regCode = (data.registrationCode as string) || ''
    this.signState = (data.signInState as string) || ''
    if (!this.regCode) throw new Error(`create-identity 未返回 registrationCode: ${resp.body.slice(0, 200)}`)
  }

  private async step12SetPassword(): Promise<void> {
    this.log('[12] 设置密码')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup?registrationCode=${this.regCode}&state=${this.signState}`
    let fp = this.genFP('signup', 'PageSubmit', 0, '')

    // 12a: 获取加密公钥
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', state: this.signState,
      inputs: [
        { input_type: 'UserRegistrationRequestInput', registrationCode: this.regCode, state: this.signState },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    this.workflowHandle = (data.workflowStateHandle as string) || ''

    const encCtx = getNestedMap(data as Record<string, unknown>, 'workflowResponseData', 'encryptionContextResponse')
    const pubKeyMap = encCtx ? getNestedStringMap(encCtx, 'publicKey') : null
    if (!pubKeyMap?.n) throw new Error(`未获取到加密公钥: ${this.formatErrorBody(resp.body, resp.status)}`)

    const issuer = (encCtx?.issuer as string) || 'signin'
    const audience = (encCtx?.audience as string) || 'AWSPasswordService'
    const region = (encCtx?.region as string) || 'us-east-1'

    const encrypted = encryptPassword(this.cfg.password, pubKeyMap, issuer, audience, region)

    // 12b: 提交密码
    fp = this.genFP('signup', 'PageSubmit', 0, '')
    rid = newUUID()
    h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    resp = await this.doPost(api, {
      stepId: 'get-new-password-for-password-creation',
      workflowStateHandle: this.workflowHandle, actionId: 'SUBMIT',
      inputs: [
        { input_type: 'PasswordRequestInput', password: encrypted, successfullyEncrypted: 'SUCCESSFUL' },
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    data = this.parseBody(resp.body)

    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (!rurl) throw new Error(`密码设置未返回 redirect: ${resp.body.slice(0, 200)}`)

    const wh = extractParam(rurl, 'workflowStateHandle')
    const st = extractParam(rurl, 'state')
    const rh = extractParam(rurl, 'workflowResultHandle')
    await this.completeSignup(wh, st, rh)
  }

  private async completeSignup(wh: string, state: string, rh: string): Promise<void> {
    this.log('[12.5] 完成注册工作流')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${wh}&state=${state}&workflowResultHandle=${rh}`
    const fp = this.genFP('signin', 'PageLoad', 0, '')
    const rid = newUUID()
    const h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    const resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: wh,
      workflowResultHandle: rh, state,
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    if (data.stepId !== 'end-of-workflow-success') throw new Error(`完成工作流失败: ${data.stepId || 'undefined'} ${this.formatErrorBody(resp.body, resp.status)}`)

    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (rurl) {
      this.authCode = extractParam(rurl, 'workflowResultHandle')
      this.ssoState = extractParam(rurl, 'state')
      this.wdcCSRFToken = extractParam(rurl, 'wdc_csrf_token')
    }
  }

  // ============ SSO 授权 (Step12.8-13) ============

  private async step12_8SSOWorkflow(): Promise<void> {
    this.log('[12.8] SSO 工作流')
    const redirectURL = encodeURIComponent(this.cfg.viewBase + '/start/#/')
    const loginURL = `${this.cfg.portalBase}/login?directory_id=view&redirect_url=${redirectURL}`

    const h: Record<string, string> = {
      'Accept': '*/*', 'User-Agent': DEFAULT_UA,
      'Origin': this.cfg.viewBase, 'Referer': this.cfg.viewBase + '/',
      'sec-ch-ua': DEFAULT_SEC_UA, 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'priority': 'u=1, i'
    }
    if (this.cookies.has('awsccc')) h['Cookie'] = 'awsccc=' + this.cookies.get('awsccc')

    const resp = await this.doGet(loginURL, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    if (data.csrfToken) this.cookies.set('loginCsrfToken', data.csrfToken as string)

    const rurl = (data.redirectUrl as string) || ''
    let wh = ''
    if (rurl.includes('workflowStateHandle=')) {
      wh = splitAfter(rurl, 'workflowStateHandle=')
    }
    if (!wh) throw new Error('SSO 无法获取 workflowStateHandle')

    await this.completeSSOWorkflow(wh)
  }

  private async completeSSOWorkflow(wh: string): Promise<void> {
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${wh}`
    let fp = this.genFP('signin', 'PageLoad', 0, '')
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: wh,
      inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
      requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    let newWH = (data.workflowStateHandle as string) || wh

    if (data.stepId === 'start') {
      fp = this.genFP('signin', 'PageLoad', 0, '')
      rid = newUUID()
      h = this.buildHeaders(ref, this.cfg.signinBase)
      h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

      resp = await this.doPost(api, {
        stepId: 'start', workflowStateHandle: newWH,
        inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
        requestId: rid
      }, h)
      saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
      data = this.parseBody(resp.body)
    }

    if (data.stepId === 'end-of-workflow-success') {
      const redir = data.redirect as Record<string, unknown> | undefined
      const rurl = redir?.url as string
      if (rurl) {
        this.authCode = extractParam(rurl, 'workflowResultHandle')
        this.ssoState = extractParam(rurl, 'state')
        this.wdcCSRFToken = extractParam(rurl, 'wdc_csrf_token')
      }
    }

    // 访问 start 页面
    const params = new URLSearchParams()
    if (this.ssoState) params.set('state', this.ssoState)
    params.set('workflowResultHandle', this.authCode)
    if (this.wdcCSRFToken) params.set('wdc_csrf_token', this.wdcCSRFToken)
    const startURL = this.cfg.viewBase + '/start/?' + params.toString()

    const cookieParts: string[] = []
    if (this.cookies.has('loginCsrfToken')) cookieParts.push('loginCsrfToken=' + this.cookies.get('loginCsrfToken'))
    if (this.cookies.has('awsccc')) cookieParts.push('awsccc=' + this.cookies.get('awsccc'))

    await this.doGet(startURL, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': DEFAULT_UA,
      'Referer': this.cfg.signinBase + '/',
      'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
      ...(cookieParts.length ? { Cookie: cookieParts.join('; ') } : {})
    })
  }

  private async step13SSOToken(): Promise<Record<string, unknown>> {
    this.log('[13] 获取 SSO Token')
    const csrf = this.cookies.get('loginCsrfToken')
    if (!csrf) throw new Error('缺少 loginCsrfToken')

    const h: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DEFAULT_UA, 'Origin': this.cfg.viewBase,
      'Referer': this.cfg.viewBase + '/',
      'x-amz-sso-csrf-token': csrf,
      'sec-ch-ua': DEFAULT_SEC_UA, 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'priority': 'u=1, i'
    }
    const formData = `authCode=${encodeURIComponent(this.authCode)}&state=${encodeURIComponent(this.ssoState)}&orgId=view`

    // 使用新客户端轮询 SSO Token
    const ssoSession = new SessionClient(this.moduleClient!, this.sessionOpts)

    try {
      for (let retry = 0; retry < 5; retry++) {
        const resp = await ssoSession.post(this.cfg.portalBase + '/auth/sso-token', formData, { headers: h })
        const data = JSON.parse(resp.body || '{}')

        if (data.token) {
          this.ssoToken = data.token
          break
        }
        const errMsg = (data.errorMessage || '') as string
        if (errMsg.toLowerCase().includes('not authorized')) {
          await sleep(3000)
          continue
        }
        throw new Error(`SSO Token 失败: ${resp.body?.slice(0, 200)}`)
      }
    } finally {
      try { await ssoSession.destroySession() } catch { /* ignore */ }
    }

    if (!this.ssoToken) throw new Error('SSO Token 重试 5 次仍失败')

    // Accept device + Associate token
    let resp = await this.doPost(this.cfg.oidcBase + '/device_authorization/accept_user_code', {
      userCode: this.userCode, userSessionId: this.ssoToken
    }, { 'Content-Type': 'application/json' })
    const dcData = this.parseBody(resp.body)
    const dc = dcData.deviceContext

    await this.doPost(this.cfg.oidcBase + '/device_authorization/associate_token', {
      deviceContext: dc, userSessionId: this.ssoToken
    }, { 'Content-Type': 'application/json' })

    // 轮询 token
    for (let i = 0; i < 30; i++) {
      resp = await this.doPost(this.cfg.oidcBase + '/token', {
        clientId: this.clientId, clientSecret: this.clientSecret,
        deviceCode: this.deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code'
      }, { 'Content-Type': 'application/json' })

      if (resp.status === 200) return this.parseBody(resp.body)
      await sleep(2000)
    }
    throw new Error('Token 轮询超时')
  }

  // ============ 主流程 ============

  /** 执行完整注册流程（自动模式） */
  async run(): Promise<RegistrationResult> {
    try {
      await this.initTlsClient()
      await refreshAppJSConfig((url, init) => this.fetchAppJS(url, init))
      await this.rebuildTlsClient()

      const initSteps: Array<{ name: string; fn: StepFn }> = [
        { name: 'OIDC', fn: () => this.step1OIDC() },
        { name: 'Device', fn: () => this.step2Device() },
        { name: 'Email', fn: () => this.step3Email() },
        { name: 'Portal', fn: () => this.step4Portal() },
        { name: 'WorkflowInit', fn: () => this.step5WorkflowInit() }
      ]
      for (const s of initSteps) {
        this.checkAborted()
        try { await s.fn() } catch (err) {
          return { status: 'failed', email: this.email, error: `[${s.name}] ${(err as Error).message}` }
        }
      }

      this.checkAborted()
      const emailStatus = await this.step6SubmitEmail()

      if (emailStatus === 'signup') {
        const signupSteps: Array<{ name: string; fn: StepFn }> = [
          { name: 'Signup', fn: () => this.step7Signup() },
          { name: 'SignupInit', fn: () => this.step7_5SignupInit() },
          { name: 'ProfileInit', fn: () => this.step7_8ProfileInit() },
          { name: 'ProfileStart', fn: () => this.step8ProfileStart() },
          { name: 'SendOTP', fn: () => this.step9SendOTP() }
        ]
        for (const s of signupSteps) {
          this.checkAborted()
          try { await s.fn() } catch (err) {
            return { status: 'failed', email: this.email, error: `[${s.name}] ${(err as Error).message}` }
          }
        }

        this.checkAborted()
        let otp: string
        try { otp = await this.step10GetOTP() } catch (err) {
          return { status: 'failed', email: this.email, error: `[GetOTP] ${(err as Error).message}` }
        }

        for (const s of [
          { name: 'CreateIdentity', fn: () => this.step11CreateIdentity(otp) },
          { name: 'SetPassword', fn: () => this.step12SetPassword() }
        ] as Array<{ name: string; fn: StepFn }>) {
          this.checkAborted()
          try { await s.fn() } catch (err) {
            return { status: 'failed', email: this.email, error: `[${s.name}] ${(err as Error).message}` }
          }
        }
      } else {
        return { status: 'failed', email: this.email, error: '该邮箱已注册过' }
      }

      this.checkAborted()
      try { await this.step12_8SSOWorkflow() } catch (err) {
        return { status: 'failed', email: this.email, error: `[SSOWorkflow] ${(err as Error).message}` }
      }

      await sleep(2000)

      this.checkAborted()
      let awsToken: Record<string, unknown>
      try { awsToken = await this.step13SSOToken() } catch (err) {
        return { status: 'failed', email: this.email, error: `[SSOToken] ${(err as Error).message}` }
      }

      // Do NOT call verifyAlive here — hitting getUsageLimits immediately after account
      // creation without a real browser WAF token is the primary suspension trigger.
      // The account refresh cycle will verify the account naturally when first used.
      return {
        status: 'success',
        email: this.email,
        password: this.cfg.password,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: (awsToken.refreshToken as string) || '',
        accessToken: (awsToken.accessToken as string) || '',
        region: 'us-east-1',
        provider: 'BuilderId'
      }
    } finally {
      await this.cleanup()
    }
  }

  /**
   * 返回本次注册实际生效的代理 URL（按 sessionOpts 同样的优先级解析），
   * 用于在指纹摘要里准确显示是直连还是走代理。
   */
  private resolvedProxyUrl(): string | undefined {
    return (this.cfg.proxy && this.cfg.proxy.trim())
      || process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || getSystemProxy() || undefined
  }

  /** 输出本次注册使用的指纹摘要（用于审计与后续复用） */
  private fingerprintSnapshot(): FingerprintSnapshot {
    const resolved = this.resolvedProxyUrl()
    return {
      chromeVer: this.identity.chromeVer,
      ua: this.identity.ua,
      gpuVendor: this.identity.gpuVendor,
      gpuModel: this.identity.gpuModel,
      canvasHash: this.identity.canvasHash,
      screen: { width: this.identity.screen.width, height: this.identity.screen.height },
      // 脱敏后保存（隐藏密码部分），同时确保系统/环境变量代理也被捕获
      proxyUrl: resolved ? resolved.replace(/:([^:@/]+)@/, ':***@') : undefined
    }
  }

  /** 手动模式注册 - Step1-2 自动，Step3 等待外部设置邮箱，Step4-9 自动，Step10 等待外部 OTP */
  async runManualPhase1(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.initTlsClient()
      await refreshAppJSConfig((url, init) => this.fetchAppJS(url, init))
      await this.rebuildTlsClient()

      await this.step1OIDC()
      await this.step2Device()
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /** 手动模式 - 设置邮箱后继续注册流程到发送 OTP */
  async runManualPhase2(email: string, fullName?: string): Promise<{ success: boolean; error?: string }> {
    this.email = email
    if (fullName) this.cfg.fullName = fullName

    try {
      await this.step4Portal()
      await this.step5WorkflowInit()

      const status = await this.step6SubmitEmail()
      if (status !== 'signup') return { success: false, error: '该邮箱已注册过' }

      await this.step7Signup()
      await this.step7_5SignupInit()
      await this.step7_8ProfileInit()
      await this.step8ProfileStart()
      await this.step9SendOTP()
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /** 手动模式 - 输入 OTP 后完成注册 */
  async runManualPhase3(otp: string): Promise<RegistrationResult> {
    try {
      await this.step11CreateIdentity(otp)
      await this.step12SetPassword()
      await this.step12_8SSOWorkflow()
      await sleep(2000)

      const awsToken = await this.step13SSOToken()

      // Do NOT call verifyAlive — same reason as auto mode
      return {
        status: 'success',
        email: this.email,
        password: this.cfg.password,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: (awsToken.refreshToken as string) || '',
        accessToken: (awsToken.accessToken as string) || '',
        region: 'us-east-1',
        provider: 'BuilderId'
      }
    } catch (err) {
      return { status: 'failed', email: this.email, error: (err as Error).message }
    } finally {
      await this.cleanup()
    }
  }
}
