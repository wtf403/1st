import * as tls from 'tls'
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { getSystemProxy } from '../proxy/systemProxy'

function getRegistrationProxyUrl(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || getSystemProxy() || undefined
}

async function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  const proxyUrl = getRegistrationProxyUrl()
  if (proxyUrl) {
    const agent = new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } })
    return await undiciFetch(url, { ...options, dispatcher: agent } as UndiciRequestInit) as unknown as Response
  }
  return await fetch(url, options)
}

// ============ 验证码提取 ============

const OTP_PATTERN = /\b(\d{6})\b/g

export function extractCode(body: string): string {
  const matches = body.match(OTP_PATTERN)
  if (!matches || matches.length === 0) return ''
  return matches[matches.length - 1]
}

// ============ TempEmailService 接口 ============

export interface TempEmailService {
  create(): Promise<string>
  waitForCode(timeoutSec: number, intervalSec: number): Promise<string>
  getAddress(): string
}

// ============ MoEmail 临时邮箱 ============

export class MoEmailService implements TempEmailService {
  private baseURL: string
  private apiKey: string
  private address = ''

  constructor(baseURL: string, apiKey: string) {
    this.baseURL = baseURL
    this.apiKey = apiKey
  }

  async create(): Promise<string> {
    const url = `${this.baseURL}/api/mail/create`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const resp = await proxyFetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(30000) })
    const data = (await resp.json()) as Record<string, unknown>

    const addr =
      (data.address as string) ||
      (data.email as string) ||
      ((data.data as Record<string, unknown>)?.address as string) ||
      ((data.data as Record<string, unknown>)?.email as string) ||
      ''

    if (!addr) {
      console.log('[MoEmail] 创建邮箱失败:', JSON.stringify(data))
      return ''
    }
    this.address = addr
    return addr
  }

  async waitForCode(timeoutSec: number, intervalSec: number): Promise<string> {
    if (!this.address) throw new Error('邮箱地址为空')

    const maxRetries = Math.floor(timeoutSec / intervalSec)
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await sleep(intervalSec * 1000)
      try {
        const code = await this.fetchCode()
        if (code) return code
      } catch (err) {
        if (attempt % 5 === 0) console.log(`[MoEmail] [${attempt}/${maxRetries}] 查询失败:`, err)
      }
      if (attempt % 5 === 0) console.log(`[MoEmail] [${attempt}/${maxRetries}] 暂无验证码...`)
    }
    throw new Error(`等待验证码超时 (${timeoutSec}s)`)
  }

  getAddress(): string {
    return this.address
  }

  private async fetchCode(): Promise<string> {
    const url = `${this.baseURL}/api/mail/messages?address=${this.address}`
    const headers: Record<string, string> = {}
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const resp = await proxyFetch(url, { headers, signal: AbortSignal.timeout(15000) })
    const raw = await resp.json()

    let messages: Array<Record<string, unknown>> = []
    if (Array.isArray(raw)) {
      messages = raw as Array<Record<string, unknown>>
    } else if (typeof raw === 'object' && raw !== null) {
      const wrapper = raw as Record<string, unknown>
      if (Array.isArray(wrapper.data)) {
        messages = wrapper.data as Array<Record<string, unknown>>
      }
    }

    for (const msg of messages) {
      const text = (msg.text as string) || (msg.body as string) || (msg.html as string) || ''
      if (text) {
        const code = extractCode(text)
        if (code) return code
      }
    }
    return ''
  }
}

// ============ TempMail.Plus + 自建域名 ============

const FIRST_NAMES = [
  'james', 'john', 'robert', 'michael', 'david', 'william', 'richard', 'joseph', 'thomas', 'charles',
  'mary', 'patricia', 'jennifer', 'linda', 'elizabeth', 'barbara', 'susan', 'jessica', 'sarah', 'karen',
  'daniel', 'matthew', 'anthony', 'mark', 'steven', 'paul', 'andrew', 'joshua', 'kenneth', 'christopher',
  'nancy', 'betty', 'margaret', 'sandra', 'ashley', 'dorothy', 'kimberly', 'emily', 'donna', 'michelle',
  'ryan', 'kevin', 'brian', 'jason', 'timothy', 'sean', 'nathan', 'brandon', 'adam', 'tyler',
  'rachel', 'samantha', 'katherine', 'christine', 'stephanie', 'heather', 'lauren', 'rebecca', 'victoria', 'megan'
]

const LAST_NAMES = [
  'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'rodriguez', 'martinez',
  'hernandez', 'lopez', 'gonzalez', 'wilson', 'anderson', 'thomas', 'taylor', 'moore', 'jackson', 'martin',
  'lee', 'perez', 'thompson', 'white', 'harris', 'sanchez', 'clark', 'ramirez', 'lewis', 'robinson',
  'walker', 'young', 'allen', 'king', 'wright', 'scott', 'torres', 'nguyen', 'hill', 'flores',
  'green', 'adams', 'nelson', 'baker', 'hall', 'rivera', 'campbell', 'mitchell', 'carter', 'roberts'
]

function randomEmailPrefix(): string {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]
  const r = Math.random()
  if (r < 0.5) return `${first}.${last}`
  if (r < 0.75) return `${first}${last}`
  const digits = String(Math.floor(Math.random() * 100)).padStart(2, '0')
  return `${first}.${last}${digits}`
}

export class TempMailPlusService implements TempEmailService {
  private static readonly BASE_URL = 'https://tempmail.plus/api'

  private readonly tmEmail: string   // tempmail.plus 用户名（不含 @mailto.plus）
  private readonly epin: string
  private readonly domain: string
  private address = ''

  constructor(tmEmail: string, epin: string, domain: string) {
    this.tmEmail = tmEmail
    this.epin = epin
    this.domain = domain.replace(/^@/, '')
  }

  private get headers(): Record<string, string> {
    return {
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'x-requested-with': 'XMLHttpRequest',
      'Referer': 'https://tempmail.plus/zh/',
      'cookie': `email=${encodeURIComponent(this.fullEmail)}`
    }
  }

  async create(): Promise<string> {
    const prefix = randomEmailPrefix()
    this.address = `${prefix}@${this.domain}`
    console.log(`[TempMailPlus] 生成邮箱: ${this.address}`)
    return this.address
  }

  getAddress(): string {
    return this.address
  }

  async waitForCode(timeoutSec: number, intervalSec: number): Promise<string> {
    if (!this.address) throw new Error('邮箱地址为空')
    const maxRetries = Math.floor(timeoutSec / intervalSec)
    const checkedIds = new Set<number>()

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await sleep(intervalSec * 1000)
      try {
        const mails = await this.fetchMailList()
        if (attempt === 1 || attempt % 5 === 0) {
          console.log(`[TempMailPlus] [${attempt}/${maxRetries}] 邮件数: ${mails.length}`)
        }
        for (const mail of mails) {
          const mailId = mail.mail_id as number
          if (checkedIds.has(mailId)) continue
          checkedIds.add(mailId)

          const detail = await this.fetchMailDetail(mailId)
          if (!detail) continue

          // 验证收件人匹配
          const toField = String(detail.to || '').toLowerCase()
          if (!toField.includes(this.address.toLowerCase())) {
            console.log(`[TempMailPlus] 收件人不匹配: ${toField} (期望包含: ${this.address})`)
            continue
          }

          // 提取验证码
          const code = this.extractOTP(detail)
          if (code) {
            console.log(`[TempMailPlus] 验证码: ${code}`)
            await this.deleteMail(mailId)
            return code
          } else {
            console.log(`[TempMailPlus] 邮件 ${mailId} 未提取到验证码`)
          }
        }
      } catch (err) {
        console.log(`[TempMailPlus] [${attempt}/${maxRetries}] 查询失败:`, err)
      }
      if (attempt % 5 === 0) console.log(`[TempMailPlus] [${attempt}/${maxRetries}] 暂无验证码...`)
    }
    throw new Error(`等待验证码超时 (${timeoutSec}s)`)
  }

  private get fullEmail(): string {
    return `${this.tmEmail}@mailto.plus`
  }

  private async fetchMailList(): Promise<Array<Record<string, unknown>>> {
    const url = `${TempMailPlusService.BASE_URL}/mails?email=${encodeURIComponent(this.fullEmail)}&first_id=0&epin=${encodeURIComponent(this.epin)}`
    const resp = await proxyFetch(url, { headers: this.headers, signal: AbortSignal.timeout(15000) })
    const data = (await resp.json()) as Record<string, unknown>
    if (!data.result) return []
    return (data.mail_list as Array<Record<string, unknown>>) || []
  }

  private async fetchMailDetail(mailId: number): Promise<Record<string, unknown> | null> {
    const url = `${TempMailPlusService.BASE_URL}/mails/${mailId}?email=${encodeURIComponent(this.fullEmail)}&epin=${encodeURIComponent(this.epin)}`
    const resp = await proxyFetch(url, { headers: this.headers, signal: AbortSignal.timeout(15000) })
    const data = (await resp.json()) as Record<string, unknown>
    return data.result ? data : null
  }

  private async deleteMail(mailId: number): Promise<void> {
    const url = `${TempMailPlusService.BASE_URL}/mails/${mailId}`
    const headers = { ...this.headers, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }
    const body = `email=${encodeURIComponent(this.fullEmail)}&epin=${encodeURIComponent(this.epin)}`
    try {
      await proxyFetch(url, { method: 'DELETE', headers, body, signal: AbortSignal.timeout(10000) })
      console.log(`[TempMailPlus] 已删除邮件: ${mailId}`)
    } catch (err) {
      console.log(`[TempMailPlus] 删除邮件失败:`, err)
    }
  }

  private extractOTP(detail: Record<string, unknown>): string {
    // 从主题提取
    const subject = String(detail.subject || '')
    const subjectMatch = subject.match(/(\d{6})/)
    if (subjectMatch) return subjectMatch[1]
    // 从正文提取
    const text = String(detail.text || '')
    const code = extractCode(text)
    if (code) return code
    // 从 HTML 提取
    const html = String(detail.html || '')
    return extractCode(html)
  }
}

// ============ Outlook IMAP ============

export interface OutlookAccount {
  email: string
  password: string
  clientId: string
  refreshToken: string
}

export function parseOutlookLines(data: string): OutlookAccount[] {
  const accounts: OutlookAccount[] = []
  data = data.trim()
  if (!data) return accounts

  const lines = data.split('\n')
  const parseEntry = (entry: string): void => {
    entry = entry.trim()
    if (!entry) return
    const parts = entry.split('----')
    if (parts.length === 4) {
      accounts.push({
        email: parts[0].trim(),
        password: parts[1].trim(),
        clientId: parts[2].trim(),
        refreshToken: parts[3].trim()
      })
    }
  }

  if (lines.length === 1) {
    for (const part of data.split(/\s+/)) parseEntry(part)
  } else {
    for (const line of lines) parseEntry(line)
  }
  return accounts
}

export async function refreshOutlookToken(acc: OutlookAccount): Promise<string> {
  const form = new URLSearchParams({
    client_id: acc.clientId,
    refresh_token: acc.refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'
  })

  const resp = await proxyFetch(
    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }
  )
  const data = (await resp.json()) as Record<string, unknown>
  if (resp.status !== 200) throw new Error(`刷新失败 ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`)
  const token = data.access_token as string
  if (!token) throw new Error('响应中无 access_token')
  return token
}

function buildXOAuth2(email: string, accessToken: string): string {
  const auth = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
  return Buffer.from(auth).toString('base64')
}

class IMAPClient {
  private socket: tls.TLSSocket | null = null
  private buffer = ''
  private tag = 0

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(993, 'outlook.office365.com', { servername: 'outlook.office365.com' })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('连接超时'))
      }, 15000)

      socket.once('error', (err) => { clearTimeout(timer); reject(err) })
      socket.once('secureConnect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.readLine().then(() => resolve()).catch(reject)
      })
    })
  }

  private readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('未连接'))

      const check = (): void => {
        const idx = this.buffer.indexOf('\r\n')
        if (idx >= 0) {
          const line = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 2)
          resolve(line)
          return
        }
      }
      check()

      const onData = (chunk: Buffer): void => {
        this.buffer += chunk.toString()
        const idx = this.buffer.indexOf('\r\n')
        if (idx >= 0) {
          this.socket!.removeListener('data', onData)
          const line = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 2)
          resolve(line)
        }
      }
      this.socket.on('data', onData)
      this.socket.once('error', reject)
    })
  }

  private async sendCommand(cmd: string): Promise<string> {
    if (!this.socket) throw new Error('未连接')
    this.tag++
    const tagStr = `A${String(this.tag).padStart(3, '0')}`
    this.socket.write(`${tagStr} ${cmd}\r\n`)
    return tagStr
  }

  private async readUntilTag(tag: string): Promise<{ lines: string[]; result: string }> {
    const lines: string[] = []
    while (true) {
      const line = await this.readLine()
      if (line.startsWith(`${tag} `)) return { lines, result: line }
      lines.push(line)
    }
  }

  async authenticate(email: string, accessToken: string): Promise<void> {
    const xoauth2 = buildXOAuth2(email, accessToken)
    const tag = await this.sendCommand(`AUTHENTICATE XOAUTH2 ${xoauth2}`)
    const { result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) throw new Error(`认证失败: ${result}`)
    console.log('[IMAP] 认证成功')
    await sleep(800)
  }

  async selectInbox(): Promise<number> {
    for (let retry = 0; retry < 3; retry++) {
      const tag = await this.sendCommand('SELECT INBOX')
      const { lines, result } = await this.readUntilTag(tag)
      if (result.includes('OK')) {
        for (const line of lines) {
          const m = line.match(/\*\s+(\d+)\s+EXISTS/)
          if (m) return parseInt(m[1], 10)
        }
        return 0
      }
      if (retry < 2) {
        console.log(`[IMAP] SELECT INBOX 失败 (${result}), 重试 ${retry + 1}/3...`)
        await sleep((1 + retry) * 1000)
      }
    }
    throw new Error('SELECT INBOX 重试耗尽')
  }

  async fetchLatestBody(seq: number): Promise<string> {
    if (seq <= 0) throw new Error('无效的邮件序号')
    const tag = await this.sendCommand(`FETCH ${seq} (BODY.PEEK[TEXT])`)
    const { lines, result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) throw new Error(`FETCH TEXT 失败: ${result}`)

    const rawLines: string[] = []
    let inBody = false
    for (const line of lines) {
      if (line.includes('FETCH')) { inBody = true; continue }
      if (line === ')') continue
      if (inBody) rawLines.push(line)
    }
    const raw = rawLines.join('\n')

    // 尝试解码 MIME base64
    const parts = raw.split('------=_Part_')
    let decoded = ''
    for (const part of parts) {
      if (part.includes('base64')) {
        const idx = part.indexOf('base64')
        const content = part.slice(idx + 6)
        const b64 = content.replace(/[\s]/g, '')
        try {
          decoded += Buffer.from(b64, 'base64').toString() + ' '
        } catch { /* ignore */ }
      }
    }
    if (decoded) return decoded

    // 整体 base64 解码
    const cleaned = raw.replace(/[\s]/g, '')
    try {
      return Buffer.from(cleaned, 'base64').toString()
    } catch {
      return raw
    }
  }

  close(): void {
    if (this.socket) {
      try { this.socket.write('A999 LOGOUT\r\n') } catch { /* ignore */ }
      this.socket.destroy()
      this.socket = null
    }
  }
}

export async function getInboxCount(acc: OutlookAccount): Promise<number> {
  const accessToken = await refreshOutlookToken(acc)
  const client = new IMAPClient()
  try {
    await client.connect()
    await client.authenticate(acc.email, accessToken)
    return await client.selectInbox()
  } finally {
    client.close()
  }
}

export async function waitForOTP(
  acc: OutlookAccount,
  beforeCount: number,
  timeout: number,
  interval: number
): Promise<string> {
  console.log(`[Outlook IMAP] 等待验证码, 邮箱=${acc.email}, 发送前邮件数=${beforeCount}`)
  let accessToken = await refreshOutlookToken(acc)
  const maxRetries = Math.floor(timeout / interval)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let client: IMAPClient | null = null
    try {
      client = new IMAPClient()
      await client.connect()
      await client.authenticate(acc.email, accessToken)
      const total = await client.selectInbox()

      if (total <= beforeCount) {
        if (attempt % 5 === 0) console.log(`[Outlook IMAP] [${attempt}/${maxRetries}] 暂无新邮件 (当前${total}封)...`)
        await sleep(interval * 1000)
        continue
      }

      for (let i = total; i > beforeCount; i--) {
        try {
          const body = await client.fetchLatestBody(i)
          const code = extractCode(body)
          if (code) {
            console.log(`[Outlook IMAP] 获取到验证码: ${code}`)
            return code
          }
        } catch { /* continue */ }
      }

      if (attempt % 5 === 0) console.log(`[Outlook IMAP] [${attempt}/${maxRetries}] 新邮件中未找到验证码...`)
    } catch (err) {
      if (attempt % 5 === 0) console.log(`[Outlook IMAP] 连接失败:`, err)
      try { accessToken = await refreshOutlookToken(acc) } catch { /* ignore */ }
    } finally {
      client?.close()
    }
    await sleep(interval * 1000)
  }
  throw new Error(`等待验证码超时 (${timeout}s)`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ============ DDG Email Protection ============

export interface GmailIMAPAccount {
  email: string
  accessToken: string  // OAuth2 access token with IMAP scope
  appPassword?: string // alternative: Gmail app password
}

export class DuckDuckGoEmailService implements TempEmailService {
  private static readonly QUACK_URL = 'https://quack.duckduckgo.com/api'
  private readonly authToken: string  // Bearer token from DDG account
  private readonly gmailAccount: GmailIMAPAccount
  private address = ''
  //private generatedUsername = ''

  constructor(authToken: string, gmailAccount: GmailIMAPAccount) {
    this.authToken = authToken
    this.gmailAccount = gmailAccount
  }

  async create(): Promise<string> {
    const resp = await proxyFetch(`${DuckDuckGoEmailService.QUACK_URL}/email/addresses`, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'authorization': `Bearer ${this.authToken}`,
        'sec-ch-ua': '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
        'referrer': 'https://duckduckgo.com/'
      }
    })
    if (!resp.ok) {
      throw new Error(`DDG address creation failed: ${resp.status}`)
    }
    const data = (await resp.json()) as Record<string, unknown>
    const username = data.address as string
    if (!username) throw new Error('No address returned from DDG API')
    //this.generatedUsername = username
    this.address = `${username}@duck.com`
    console.log(`[DDG] Generated address: ${this.address}`)
    return this.address
  }

  getAddress(): string {
    return this.address
  }

  async waitForCode(timeoutSec: number, intervalSec: number): Promise<string> {
    if (!this.address) throw new Error('Address not created yet')
    // DDG forwards to Gmail — poll Gmail IMAP for the forwarded mail
    const service = new GmailIMAPService(this.gmailAccount, this.address)
    return service.waitForCode(timeoutSec, intervalSec)
  }
}

// ============ Gmail IMAP (reads DDG-forwarded mail) ============

class GmailIMAPService {
  private readonly account: GmailIMAPAccount
  private readonly filterForAddress: string  // the duck.com address to match

  constructor(account: GmailIMAPAccount, filterForAddress: string) {
    this.account = account
    this.filterForAddress = filterForAddress
  }

  async waitForCode(timeoutSec: number, intervalSec: number): Promise<string> {
    const maxRetries = Math.floor(timeoutSec / intervalSec)
    const checkedUids = new Set<string>()

    let beforeCount = 0
    try {
      beforeCount = await this.getMessageCount()
      console.log(`[Gmail IMAP] Messages before: ${beforeCount}`)
    } catch (err) {
      console.log(`[Gmail IMAP] getMessageCount failed (will use 0): ${err instanceof Error ? err.message : String(err)}`)
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await sleep(intervalSec * 1000)
      let client: GmailIMAPClient | null = null
      try {
        client = new GmailIMAPClient()
        await client.connect()
        if (this.account.appPassword) {
          await client.authenticatePlain(this.account.email, this.account.appPassword)
        } else {
          await client.authenticateXOAuth2(this.account.email, this.account.accessToken)
        }
        await client.selectInbox()

        // Search for emails from AWS signin sender received after we started
        const uids = await client.searchFrom('no-reply@signin.aws', beforeCount)
        console.log(`[Gmail IMAP] [${attempt}/${maxRetries}] AWS sender UIDs: [${uids.join(',')}]`)

        // Only check the NEWEST email (highest UID) — skip stale ones from previous runs
        if (uids.length === 0) continue
        const newestUid = uids[uids.length - 1]
        if (checkedUids.has(newestUid)) continue
        checkedUids.add(newestUid)

        const body = await client.fetchBodyByUID(newestUid)
        if (!body) continue

        const code = extractCode(body)
        if (code) {
          console.log(`[Gmail IMAP] Got OTP: ${code} from UID ${newestUid}`)
          await client.markSeen(newestUid)
          return code
        } else {
          console.log(`[Gmail IMAP] UID ${newestUid} from AWS but no 6-digit code found, body length: ${body.length}`)
        }
      } catch (err) {
        console.log(`[Gmail IMAP] [${attempt}/${maxRetries}] Error: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        client?.close()
      }
    }
    throw new Error(`OTP wait timed out (${timeoutSec}s)`)
  }

  private async getMessageCount(): Promise<number> {
    const client = new GmailIMAPClient()
    try {
      await client.connect()
      if (this.account.appPassword) {
        await client.authenticatePlain(this.account.email, this.account.appPassword)
      } else {
        await client.authenticateXOAuth2(this.account.email, this.account.accessToken)
      }
      return await client.selectInbox()
    } finally {
      client.close()
    }
  }
}

// ============ MIME body decoder ============

function decodeMimeBody(raw: string): string {
  const result: string[] = []

  // Split into MIME parts by boundary
  // Find all Content-Transfer-Encoding headers and decode their content
  const lines = raw.split(/\r?\n/)
  let encoding = ''
  let collectingContent = false
  const contentLines: string[] = []

  const flushContent = (): void => {
    if (contentLines.length === 0) return
    const content = contentLines.join('\n')
    const enc = encoding.toLowerCase().trim()
    if (enc === 'base64') {
      try {
        const decoded = Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf-8')
        result.push(decoded)
      } catch { /* ignore bad base64 */ }
    } else if (enc === 'quoted-printable') {
      result.push(decodeQuotedPrintable(content))
    } else {
      result.push(content)
    }
    contentLines.length = 0
    encoding = ''
  }

  for (const line of lines) {
    const lower = line.toLowerCase()

    // Detect MIME boundary (starts with --)
    if (line.startsWith('--')) {
      flushContent()
      collectingContent = false
      continue
    }

    // Detect Content-Transfer-Encoding header
    if (lower.startsWith('content-transfer-encoding:')) {
      flushContent()
      encoding = line.slice('content-transfer-encoding:'.length).trim()
      collectingContent = false
      continue
    }

    // Blank line after headers = start of content
    if (!collectingContent && line.trim() === '') {
      collectingContent = true
      continue
    }

    if (collectingContent) {
      contentLines.push(line)
    }
  }

  flushContent()

  // Join all decoded parts; if nothing decoded, return raw
  const joined = result.join('\n')
  return joined.length > 0 ? joined : raw
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '')  // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

// ============ Gmail IMAP client ============

class GmailIMAPClient {
  private socket: tls.TLSSocket | null = null
  private buffer = ''
  private tagCounter = 0

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(993, 'imap.gmail.com', { servername: 'imap.gmail.com' })
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Connect timeout')) }, 15000)
      socket.once('error', (err) => { clearTimeout(timer); reject(err) })
      socket.once('secureConnect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.readLine().then(() => resolve()).catch(reject)
      })
    })
  }

  async authenticatePlain(email: string, appPassword: string): Promise<void> {
    // Gmail app passwords are formatted as "xxxx xxxx xxxx xxxx" — strip spaces
    const password = appPassword.replace(/\s/g, '')
    const escaped = password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const tag = await this.sendCommand(`LOGIN "${email}" "${escaped}"`)
    const { result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) throw new Error(`Gmail LOGIN failed: ${result}`)
    console.log('[Gmail IMAP] Authenticated (plain)')
  }

  async authenticateXOAuth2(email: string, accessToken: string): Promise<void> {
    const auth = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
    const b64 = Buffer.from(auth).toString('base64')
    const tag = await this.sendCommand(`AUTHENTICATE XOAUTH2 ${b64}`)
    const { result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) throw new Error(`Gmail XOAUTH2 failed: ${result}`)
    console.log('[Gmail IMAP] Authenticated (OAuth2)')
  }

  async selectInbox(): Promise<number> {
    const tag = await this.sendCommand('SELECT INBOX')
    const { lines, result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) throw new Error(`SELECT INBOX failed: ${result}`)
    for (const line of lines) {
      const m = line.match(/\*\s+(\d+)\s+EXISTS/)
      if (m) return parseInt(m[1], 10)
    }
    return 0
  }

  // Search by sender, optionally restricted to messages after a sequence number floor
  async searchFrom(sender: string, afterSeq: number): Promise<string[]> {
    // UID SEARCH FROM "sender" <seq>:* — finds messages from sender with seq >= afterSeq+1
    const seqFloor = afterSeq + 1
    const tag = await this.sendCommand(`UID SEARCH ${seqFloor}:* FROM "${sender}"`)
    const { lines, result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) return []
    for (const line of lines) {
      if (line.startsWith('* SEARCH')) {
        return line.split(' ').slice(2).filter(Boolean)
      }
    }
    return []
  }

  // Get UIDs of messages by sequence number range
  async fetchUidsBySeqRange(from: number, to: number): Promise<string[]> {
    // FETCH by sequence range to get UIDs
    const tag = await this.sendCommand(`FETCH ${from}:${to} (UID)`)
    const { lines, result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) return []
    const uids: string[] = []
    for (const line of lines) {
      // e.g. "* 4756 FETCH (UID 98765432)"
      const m = line.match(/\*\s+\d+\s+FETCH\s+\(UID\s+(\d+)\)/i)
      if (m) uids.push(m[1])
    }
    return uids
  }

  async fetchBodyByUID(uid: string): Promise<string> {
    // Fetch full RFC822 message to get all MIME parts
    const tag = await this.sendCommand(`UID FETCH ${uid} (BODY.PEEK[])`)
    const { lines, result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) return ''

    // Collect raw lines between the FETCH response line and closing ')'
    let inBody = false
    const bodyLines: string[] = []
    for (const line of lines) {
      if (!inBody) {
        if (line.includes('FETCH') && line.includes('BODY')) {
          inBody = true
        }
        continue
      }
      if (line === ')') break
      bodyLines.push(line)
    }

    const raw = bodyLines.join('\r\n')
    return decodeMimeBody(raw)
  }

  async markSeen(uid: string): Promise<void> {
    const tag = await this.sendCommand(`UID STORE ${uid} +FLAGS (\\Seen)`)
    await this.readUntilTag(tag)
  }

  close(): void {
    if (this.socket) {
      try { this.socket.write('A999 LOGOUT\r\n') } catch { /* ignore */ }
      this.socket.destroy()
      this.socket = null
    }
  }

  private nextTag(): string {
    return `T${String(++this.tagCounter).padStart(3, '0')}`
  }

  private async sendCommand(cmd: string): Promise<string> {
    if (!this.socket) throw new Error('Not connected')
    const tag = this.nextTag()
    this.socket.write(`${tag} ${cmd}\r\n`)
    return tag
  }

  private readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Not connected'))

      // Check buffer first before attaching listeners
      const idx = this.buffer.indexOf('\r\n')
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 2)
        return resolve(line)
      }

      const onData = (chunk: Buffer): void => {
        this.buffer += chunk.toString()
        const i = this.buffer.indexOf('\r\n')
        if (i >= 0) {
          this.socket!.removeListener('data', onData)
          this.socket!.removeListener('error', onError)
          const line = this.buffer.slice(0, i)
          this.buffer = this.buffer.slice(i + 2)
          resolve(line)
        }
      }

      const onError = (err: Error): void => {
        this.socket!.removeListener('data', onData)
        this.socket!.removeListener('error', onError)
        reject(err)
      }

      this.socket.on('data', onData)
      this.socket.once('error', onError)
    })
  }

  private async readUntilTag(tag: string): Promise<{ lines: string[]; result: string }> {
    const lines: string[] = []
    while (true) {
      const line = await this.readLine()
      if (line.startsWith(`${tag} `)) return { lines, result: line }
      lines.push(line)
    }
  }
}
