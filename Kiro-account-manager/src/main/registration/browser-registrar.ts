import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'
import { BrowserWindow, session } from 'electron'
import { is } from '@electron-toolkit/utils'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { getSystemProxy } from '../proxy/systemProxy'
import {
  DuckDuckGoEmailService,
  MoEmailService,
  TempMailPlusService,
  GmailIMAPAccount
} from './email-service'
import { randomFullName } from './browser-identity'
import { genPassword } from './config'
import type { RegistrationResult, LogFn } from './registrar'

export interface BrowserRegistrationConfig {
  useDDG?: boolean
  ddgAuthToken?: string
  ddgGmailEmail?: string
  ddgGmailAppPassword?: string
  ddgGmailAccessToken?: string
  useTempMailPlus?: boolean
  tempMailPlusEmail?: string
  tempMailPlusEpin?: string
  tempMailPlusDomain?: string
  moEmailBaseURL?: string
  moEmailAPIKey?: string
  fullName?: string
  password?: string
  proxyUrl?: string
  taskId?: string
}

const OIDC_BASE = 'https://oidc.us-east-1.amazonaws.com'
//const VIEW_BASE = 'https://view.awsapps.com'
//const START_URL = 'https://view.awsapps.com/start'

const KIRO_SCOPES =
  'codewhisperer:completions,codewhisperer:analysis,codewhisperer:conversations,codewhisperer:transformations,codewhisperer:taskassist'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function randomDelay(min: number, max: number): Promise<void> {
  return sleep(min + Math.random() * (max - min))
}

function isWindowUsable(win: BrowserWindow): boolean {
  try {
    return !win.isDestroyed() && !win.webContents.isDestroyed()
  } catch {
    return false
  }
}

function getProxyUrl(cfgProxy?: string): string | undefined {
  return (
    cfgProxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    getSystemProxy() ||
    undefined
  )
}

async function apiFetch(
  url: string,
  options: {
    method?: string
    body?: string
    headers?: Record<string, string>
    proxyUrl?: string
  } = {}
): Promise<{ status: number; body: string }> {
  const h: Record<string, string> = { 'User-Agent': BROWSER_UA, ...(options.headers || {}) }
  const fetchOpts: Record<string, unknown> = {
    method: options.method || 'GET',
    headers: h,
    body: options.body
  }
  const proxyUrl = getProxyUrl(options.proxyUrl)
  if (proxyUrl) {
    const agent = new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } })
    fetchOpts.dispatcher = agent as Dispatcher
  }
  const resp = await undiciFetch(url, fetchOpts as Parameters<typeof undiciFetch>[1])
  const body = await resp.text()
  return { status: resp.status, body }
}

/** Poll for a CSS selector to appear. Returns true if found, false if timed out. */
async function waitForSelector(
  win: BrowserWindow,
  selector: string,
  timeoutMs = 30000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isWindowUsable(win)) return false
    try {
      const found = await win.webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(selector)})`
      )
      if (found) return true
    } catch {
      /* navigating */
    }
    await sleep(500)
  }
  return false
}

/** Wait for page load + extra settle time. */
async function waitForPageLoad(win: BrowserWindow, extraMs = 1500): Promise<void> {
  if (!isWindowUsable(win)) return

  await new Promise<void>((resolve) => {
    if (!isWindowUsable(win)) return resolve()

    const done = (): void => {
      if (win.webContents.isDestroyed()) return resolve()
      win.webContents.removeListener('did-finish-load', done)
      win.webContents.removeListener('did-fail-load', done)
      resolve()
    }

    try {
      if (!win.webContents.isLoading()) {
        resolve()
      } else {
        win.webContents.once('did-finish-load', done)
        win.webContents.once('did-fail-load', done)
      }
    } catch {
      resolve()
    }
  })

  await randomDelay(extraMs, extraMs + 1000)
}

/** Dismiss cookie banner then click selector. Retries 3x. */
async function clickWithCookieDismiss(
  win: BrowserWindow,
  selector: string,
  timeoutMs = 10000
): Promise<boolean> {
  const dismissCookies = async (): Promise<void> => {
    if (!isWindowUsable(win)) return
    await win.webContents
      .executeJavaScript(
        `
      (function() {
        const btn = document.querySelector('button[data-id="awsccc-cb-btn-accept"]');
        if (btn) btn.click();
      })()
    `
      )
      .catch(() => {})
    await sleep(300)
  }

  await dismissCookies()
  if (!(await waitForSelector(win, selector, timeoutMs))) return false

  for (let i = 0; i < 3; i++) {
    if (!isWindowUsable(win)) return false
    await dismissCookies()
    await win.webContents
      .executeJavaScript(
        `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) el.click();
      })()
    `
      )
      .catch(() => {})
    await sleep(400)
    if (!isWindowUsable(win)) return true

    // If element disappeared, click worked
    const stillThere = await win.webContents
      .executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)
      .catch(() => false)
    if (!stillThere) return true
    if (i < 2) await sleep(600)
  }
  return true
}

/** Type text into a field character by character. */
async function typeInto(
  win: BrowserWindow,
  selector: string,
  text: string,
  timeoutMs = 15000
): Promise<boolean> {
  if (!(await waitForSelector(win, selector, timeoutMs)) || !isWindowUsable(win)) return false

  await win.webContents
    .executeJavaScript(
      `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `
    )
    .catch(() => {})

  for (const char of text) {
    if (!isWindowUsable(win)) return false
    await win.webContents
      .executeJavaScript(
        `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, el.value + ${JSON.stringify(char)});
        else el.value += ${JSON.stringify(char)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `
      )
      .catch(() => {})
    await sleep(60 + Math.random() * 80)
  }

  await win.webContents
    .executeJavaScript(
      `
    document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new Event('change', { bubbles: true }))
  `
    )
    .catch(() => {})
  return true
}

export class BrowserRegistrar {
  private cfg: BrowserRegistrationConfig
  private log: LogFn
  private win: BrowserWindow | null = null
  private sessionPartition: string
  private aborted = false
  private emailSvc: DuckDuckGoEmailService | TempMailPlusService | MoEmailService | null = null

  constructor(cfg: BrowserRegistrationConfig, log?: LogFn) {
    this.cfg = cfg
    this.log = log || ((msg) => console.log(msg))
    this.sessionPartition = `persist:reg-${cfg.taskId || Date.now()}`
  }

  abort(): void {
    this.aborted = true
    this.destroyWindow()
  }

  private checkAborted(): void {
    if (this.aborted) throw new Error('Registration cancelled')
  }

  private destroyWindow(): void {
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.close()
      } catch {
        /* ignore */
      }
    }
    this.win = null
  }

  async destroy(): Promise<void> {
    this.destroyWindow()
    try {
      const ses = session.fromPartition(this.sessionPartition)
      await ses.clearStorageData()
      await ses.clearCache()
    } catch {
      /* ignore */
    }
  }

  private async createWindow(): Promise<BrowserWindow> {
    const ses = session.fromPartition(this.sessionPartition)

    if (this.cfg.proxyUrl) {
      await ses.setProxy({ proxyRules: this.cfg.proxyUrl })
      this.log(`[Browser] Proxy: ${this.cfg.proxyUrl}`)
    }

    const cleanUA = ses
      .getUserAgent()
      .replace(/Electron\/[\d.]+\s*/g, '')
      .replace(/kiro-account-manager\/[\d.]+\s*/g, '')
      .trim()
    ses.setUserAgent(cleanUA)

    const win = new BrowserWindow({
      width: 1024,
      height: 768,
      show: is.dev,
      title: 'Kiro Registration',
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    win.on('closed', () => {
      this.log('[Browser] Registration window closed')
    })
    win.webContents.on('destroyed', () => {
      this.log('[Browser] Registration webContents destroyed')
    })
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      this.log(
        `[Browser] Load failed: ${errorCode} ${errorDescription} ${validatedURL.slice(0, 120)}`
      )
    })

    if (!is.dev) win.setSkipTaskbar(true)
    this.win = win
    return win
  }

  private async createEmailAddress(): Promise<string> {
    if (this.cfg.useDDG) {
      if (!this.cfg.ddgAuthToken || !this.cfg.ddgGmailEmail)
        throw new Error('DDG config incomplete')
      const gmailAccount: GmailIMAPAccount = {
        email: this.cfg.ddgGmailEmail,
        accessToken: this.cfg.ddgGmailAccessToken || '',
        appPassword: this.cfg.ddgGmailAppPassword || undefined
      }
      const svc = new DuckDuckGoEmailService(this.cfg.ddgAuthToken, gmailAccount)
      const addr = await svc.create()
      if (!addr) throw new Error('DDG address creation failed')
      this.emailSvc = svc
      return addr
    }

    if (this.cfg.useTempMailPlus) {
      if (
        !this.cfg.tempMailPlusEmail ||
        !this.cfg.tempMailPlusEpin ||
        !this.cfg.tempMailPlusDomain
      ) {
        throw new Error('TempMailPlus config incomplete')
      }
      const svc = new TempMailPlusService(
        this.cfg.tempMailPlusEmail,
        this.cfg.tempMailPlusEpin,
        this.cfg.tempMailPlusDomain
      )
      const addr = await svc.create()
      if (!addr) throw new Error('TempMailPlus address creation failed')
      this.emailSvc = svc
      return addr
    }

    if (this.cfg.moEmailBaseURL) {
      const svc = new MoEmailService(this.cfg.moEmailBaseURL, this.cfg.moEmailAPIKey || '')
      const addr = await svc.create()
      if (!addr) throw new Error('MoEmail address creation failed')
      this.emailSvc = svc
      return addr
    }

    throw new Error('No email provider configured')
  }

  // ============ Authorization Code + PKCE flow (same as Kiro IDE) ============

  /** Generate PKCE code_verifier and code_challenge */
  private generatePKCE(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
  }

  /**
   * Build the authorization URL that Kiro IDE uses.
   * The browser navigates here, user signs up/in, then redirects to callback.
   */
  private async registerOidcClient(
    redirectUri: string
  ): Promise<{ clientId: string; clientSecret: string }> {
    const resp = await apiFetch(`${OIDC_BASE}/client/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Kiro IDE',
        clientType: 'public',
        scopes: KIRO_SCOPES.split(','),
        grantTypes: ['authorization_code', 'refresh_token'],
        redirectUris: [redirectUri],
        issuerUrl: 'https://view.awsapps.com/start'
      })
    })
    if (resp.status !== 200) {
      throw new Error(
        `OIDC client registration failed (${resp.status}): ${resp.body.slice(0, 200)}`
      )
    }
    const data = JSON.parse(resp.body) as { clientId?: string; clientSecret?: string }
    if (!data.clientId || !data.clientSecret) {
      throw new Error(`OIDC client registration missing credentials: ${resp.body.slice(0, 200)}`)
    }
    return { clientId: data.clientId, clientSecret: data.clientSecret }
  }

  private buildAuthURL(
    clientId: string,
    codeChallenge: string,
    state: string,
    redirectUri: string
  ): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scopes: KIRO_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })
    return `${OIDC_BASE}/authorize?${params.toString()}`
  }

  /**
   * Exchange authorization code for tokens.
   */
  private async exchangeCodeForTokens(
    clientId: string,
    clientSecret: string,
    code: string,
    verifier: string,
    redirectUri: string
  ): Promise<Record<string, unknown>> {
    const resp = await apiFetch(`${OIDC_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        clientSecret,
        grantType: 'authorization_code',
        code,
        redirectUri,
        codeVerifier: verifier
      })
    })
    if (resp.status !== 200) {
      throw new Error(`Token exchange failed (${resp.status}): ${resp.body.slice(0, 200)}`)
    }
    const data = JSON.parse(resp.body) as Record<string, unknown>
    if (!data.access_token && !data.accessToken) {
      throw new Error(`No access token in response: ${resp.body.slice(0, 200)}`)
    }
    // Normalize field names (OIDC uses snake_case, AWS SDK uses camelCase)
    return {
      accessToken: (data.access_token || data.accessToken) as string,
      refreshToken: (data.refresh_token || data.refreshToken) as string,
      expiresIn: (data.expires_in || data.expiresIn) as number
    }
  }

  /**
   * Wait for the browser to navigate to the callback URL and extract the auth code.
   * Uses a local redirect URI that we intercept via webRequest.
   */
  private waitForAuthCode(
    win: BrowserWindow,
    redirectUri: string,
    state: string,
    timeoutMs = 300000
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Authorization code wait timed out'))
      }, timeoutMs)

      const cleanup = (): void => {
        clearTimeout(timer)
        try {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.removeListener('did-navigate', onNav)
            win.webContents.removeListener('did-navigate-in-page', onNav)
            win.webContents.removeListener('did-fail-load', onFail)
          }
        } catch {
          // Window/webContents may already be destroyed by user closing the registration window.
        }
      }

      const onNav = (_: unknown, url: string): void => {
        if (!url.startsWith(redirectUri)) return
        try {
          const parsed = new URL(url)
          const code = parsed.searchParams.get('code')
          const returnedState = parsed.searchParams.get('state')
          if (code && returnedState === state) {
            cleanup()
            resolve(code)
          } else if (parsed.searchParams.get('error')) {
            cleanup()
            reject(
              new Error(
                `Auth error: ${parsed.searchParams.get('error_description') || parsed.searchParams.get('error')}`
              )
            )
          }
        } catch {
          /* ignore parse errors */
        }
      }

      // Also handle ERR_ABORTED on the callback URL — the redirect to localhost will fail
      // to load (no server there) but we can still extract the code from the URL
      const onFail = (
        _: unknown,
        _errorCode: number,
        _errorDesc: string,
        validatedURL: string
      ): void => {
        if (!validatedURL.startsWith(redirectUri)) return
        try {
          const parsed = new URL(validatedURL)
          const code = parsed.searchParams.get('code')
          const returnedState = parsed.searchParams.get('state')
          if (code && returnedState === state) {
            cleanup()
            resolve(code)
          }
        } catch {
          /* ignore */
        }
      }

      win.webContents.on('did-navigate', onNav)
      win.webContents.on('did-navigate-in-page', onNav)
      win.webContents.on('did-fail-load', onFail)
    })
  }

  // ============ Browser automation steps ============

  /** Step 1: Accept cookie banner, then wait for email input. */
  private async stepAcceptCookiesAndWaitForEmail(win: BrowserWindow): Promise<void> {
    this.log('[Browser] Waiting for page to load...')
    await waitForPageLoad(win, 2000)
    if (!isWindowUsable(win)) throw new Error('Registration browser window closed during page load')
    this.log(`[Browser] Page: ${win.webContents.getURL()}`)

    // Accept cookie banner if present (wait up to 10s)
    const hasBanner = await waitForSelector(win, 'button[data-id="awsccc-cb-btn-accept"]', 10000)
    if (hasBanner) {
      await win.webContents
        .executeJavaScript(
          `
        const btn = document.querySelector('button[data-id="awsccc-cb-btn-accept"]');
        if (btn) btn.click();
      `
        )
        .catch(() => {})
      this.log('[Browser] Cookie banner accepted')
      await randomDelay(800, 1500)
    }

    // Wait for email input (React SPA may take time to hydrate)
    this.log('[Browser] Waiting for email input...')
    const emailAppeared = await waitForSelector(win, 'input[placeholder*="@"]', 30000)
    if (!emailAppeared) {
      const body = await win.webContents
        .executeJavaScript(`document.body.innerText.slice(0, 300)`)
        .catch(() => '')
      throw new Error(`Email input not found after 30s. Page: ${body}`)
    }
    this.log('[Browser] Email input found')
  }

  /** Step 2: Fill email and click Continue. */
  private async stepFillEmail(win: BrowserWindow, email: string): Promise<void> {
    this.log(`[Browser] Filling email: ${email}`)
    await typeInto(win, 'input[placeholder*="@"]', email)
    await randomDelay(500, 1000)

    // Email page Continue button: data-testid="test-primary-button"
    await clickWithCookieDismiss(win, 'button[data-testid="test-primary-button"]')
    this.log('[Browser] Clicked Continue after email')
    await waitForPageLoad(win, 2000)
    this.log(`[Browser] After email: ${win.webContents.getURL()}`)
  }

  /** Step 3: Handle signup — click "Create account" if present, fill name, click Continue. */
  private async stepSignup(win: BrowserWindow, fullName: string): Promise<void> {
    await randomDelay(1500, 3000)

    // Click "Create account" / "Sign up" if present
    const createClicked = await win.webContents
      .executeJavaScript(
        `
      (function() {
        const els = Array.from(document.querySelectorAll('a, button'));
        const btn = els.find(el => {
          const t = (el.textContent || '').trim();
          return /create.*(account|builder)/i.test(t) || /sign.?up/i.test(t);
        });
        if (btn) { btn.click(); return true; }
        return false;
      })()
    `
      )
      .catch(() => false)
    if (createClicked) {
      this.log('[Browser] Clicked create account')
      await waitForPageLoad(win, 1500)
    }

    // Wait for name input (placeholder is a person name: has space, no @, no digits)
    this.log('[Browser] Waiting for name input...')
    const nameAppeared = await waitForSelector(win, 'input[placeholder*=" "]', 15000)
    if (nameAppeared) {
      const isNameField = await win.webContents
        .executeJavaScript(
          `
        (function() {
          const el = document.querySelector('input[placeholder*=" "]');
          if (!el) return false;
          const ph = el.placeholder || '';
          return !ph.includes('@') && !/\\d/.test(ph);
        })()
      `
        )
        .catch(() => false)

      if (isNameField) {
        await typeInto(win, 'input[placeholder*=" "]', fullName)
        this.log(`[Browser] Name filled: ${fullName}`)
        await randomDelay(500, 1000)
      }
    }

    // Name page Continue: data-testid="signup-next-button"
    await clickWithCookieDismiss(win, 'button[data-testid="signup-next-button"]')
    this.log('[Browser] Clicked Continue to send OTP')
    await waitForPageLoad(win, 1500)
  }

  /** Step 4: Wait for OTP input, fill it, click Continue. */
  private async stepFillOTP(win: BrowserWindow, otp: string): Promise<void> {
    this.log('[Browser] Waiting for OTP input...')
    const otpAppeared = await waitForSelector(win, 'input[placeholder*="digit"]', 30000)
    if (!otpAppeared) throw new Error('OTP input not found after 30s')

    // Clear any existing value first, then fill
    await win.webContents
      .executeJavaScript(
        `
      (function() {
        const el = document.querySelector('input[placeholder*="digit"]');
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, '');
        else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `
      )
      .catch(() => {})

    this.log(`[Browser] Filling OTP: ${otp}`)
    await typeInto(win, 'input[placeholder*="digit"]', otp)
    await randomDelay(500, 1000)

    // OTP Continue: data-testid="email-verification-verify-button"
    await clickWithCookieDismiss(win, 'button[data-testid="email-verification-verify-button"]')
    this.log('[Browser] OTP submitted')
    // Short wait — don't do full page load wait since we need to check for error on same page
    await sleep(2000)
  }

  /** Step 5: Fill password if required. */
  private async stepFillPassword(win: BrowserWindow, password: string): Promise<void> {
    const hasPwd = await waitForSelector(win, 'input[type="password"]', 5000)
    if (!hasPwd) return

    this.log('[Browser] Filling password')
    await typeInto(win, 'input[type="password"]', password)

    // Fill confirm password if second field exists
    const hasConfirm = await win.webContents
      .executeJavaScript(`document.querySelectorAll('input[type="password"]').length > 1`)
      .catch(() => false)
    if (hasConfirm) {
      await win.webContents
        .executeJavaScript(
          `
        (function() {
          const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
          const el = inputs[1];
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, ${JSON.stringify(password)});
          else el.value = ${JSON.stringify(password)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `
        )
        .catch(() => {})
    }

    await randomDelay(500, 1000)
    // Password Continue: data-testid="test-primary-button"
    await clickWithCookieDismiss(win, 'button[data-testid="test-primary-button"]')
    this.log('[Browser] Password submitted')
    await waitForPageLoad(win, 2000)
  }

  /** Try multiple selectors to find and click the Allow access button */
  private async tryClickAllowAccess(win: BrowserWindow): Promise<boolean> {
    const SELECTORS = [
      'button[data-testid="allow-access-button"]',
      'button[data-testid="allow-access"]',
      'button[data-id="allow-access-button"]',
      'input[type="submit"][value*="Allow"]',
      'form button[type="submit"]',
      '[data-testid="submit-button"]'
    ]

    for (const selector of SELECTORS) {
      const found = await win.webContents
        .executeJavaScript(
          `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          return el ? true : false;
        })()
      `
        )
        .catch(() => false)
      if (!found) continue

      this.log(`[Browser] Found button with selector: ${selector}`)
      await win.webContents
        .executeJavaScript(
          `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) el.click();
          return true;
        })()
      `
        )
        .catch(() => {})
      this.log('[Browser] Clicked Allow access')
      return true
    }
    return false
  }

  /** Try to find any button with Allow-related text */
  private async tryClickAllowByText(win: BrowserWindow): Promise<boolean> {
    const found = await win.webContents
      .executeJavaScript(
        `
      (function() {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'));
        const allowBtn = buttons.find(el => {
          const t = (el.textContent || el.value || '').toLowerCase().trim();
          return t === 'allow access' || t === 'allow' || t.includes('allow access') || t === '同意' || t.includes('同意');
        });
        if (allowBtn) { allowBtn.click(); return true; }
        return false;
      })()
    `
      )
      .catch(() => false)
    if (found) {
      this.log('[Browser] Clicked Allow access button by text match')
      return true
    }
    return false
  }

  /** Step 6: Handle any remaining consent/allow-access pages before callback redirect. */
  private async stepConfirmDevice(win: BrowserWindow): Promise<void> {
    try {
      this.log('[Browser] [9] Confirm device and allow access')

      // After password submission, the page may redirect to OIDC authorize endpoint.
      // Wait for URL to stabilize on the consent page.
      const currentUrl = win.webContents.getURL()
      this.log(
        `[Browser] Current URL before waiting: ${currentUrl ? currentUrl.slice(0, 100) : 'unknown'}`
      )

      // Wait for the consent SPA to transition from workflowResultHandle to the real consent page.
      let clicked = false
      const deadline = Date.now() + 45000
      while (!clicked && Date.now() < deadline && isWindowUsable(win)) {
        clicked = await this.tryClickAllowAccess(win)
        if (!clicked) clicked = await this.tryClickAllowByText(win)
        if (!clicked) await sleep(1000)
      }

      if (!clicked) {
        // Dump page info for debugging
        this.log('[Browser] Allow access button not found, dumping page state')
        const pageInfo = await win.webContents
          .executeJavaScript(
            `
          (function() {
            const url = window.location.href;
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'))
              .map(el => ({
                tag: el.tagName,
                type: el.type || '',
                text: (el.textContent || el.value || '').trim().slice(0, 40),
                id: el.id,
                classes: el.className.slice(0, 60),
                'data-testid': el.getAttribute('data-testid') || '',
                visible: !!el.offsetParent
              }));
            return { url: url.slice(0, 150), buttons: buttons.slice(0, 15) };
          })()
        `
          )
          .catch(() => ({ url: 'unknown', buttons: [] }))
        this.log(`[Browser] Page state: ${JSON.stringify(pageInfo)}`)

        // Wait longer for possible auto-redirect
        this.log('[Browser] Waiting 15s for auto-redirect...')
        await sleep(15000)
      }
    } catch (err) {
      this.log(
        `[Browser] Error in stepConfirmDevice: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ============ Main flow ============

  async run(): Promise<RegistrationResult> {
    console.log('[BrowserRegistrar] run() started')

    let email: string
    try {
      email = await this.createEmailAddress()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`[Browser] Email creation failed: ${msg}`)
      return { status: 'failed', email: '', error: msg }
    }

    const fullName = this.cfg.fullName || randomFullName()
    const password = this.cfg.password || genPassword()

    console.log(`[BrowserRegistrar] Email: ${email}`)
    this.log(`[Browser] Email: ${email}`)

    // Generate PKCE — same as Kiro IDE does
    const { verifier, challenge } = this.generatePKCE()
    const state = randomBytes(16).toString('hex')
    // Start a local HTTP server to receive the OAuth callback
    // This matches how Kiro IDE handles the redirect
    let localPort = 59817

    // Create a promise that resolves when the callback is received
    let resolveCode: (code: string) => void
    let rejectCode: (err: Error) => void
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '', `http://127.0.0.1:${localPort}`)
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<html><body><h2>Authorization complete. This window will close automatically.</h2><script>window.close()</script></body></html>'
        )
        if (code && returnedState === state) {
          resolveCode(code)
        } else {
          rejectCode(new Error(`Auth callback missing code or state mismatch`))
        }
      } catch (e) {
        res.writeHead(500)
        res.end()
        rejectCode(e instanceof Error ? e : new Error(String(e)))
      }
    })

    // Try to bind to the port, fall back if busy
    await new Promise<void>((res, rej) => {
      server.listen(localPort, '127.0.0.1', () => res())
      server.on('error', () => {
        // Try a different port
        localPort = 59818 + Math.floor(Math.random() * 100)
        server.listen(localPort, '127.0.0.1', () => res())
        server.on('error', rej)
      })
    })

    // Now construct the redirectUri with the final port
    const redirectUri = `http://127.0.0.1:${localPort}/oauth/callback`
    this.log('[Browser] [1] Registering OIDC client')
    const oidcClient = await this.registerOidcClient(redirectUri)
    const authURL = this.buildAuthURL(oidcClient.clientId, challenge, state, redirectUri)
    this.log(
      `[Browser] [1] Auth URL built (PKCE, client_id: ${oidcClient.clientId.slice(0, 8)}...)`
    )

    // Create browser window
    let win: BrowserWindow
    try {
      win = await this.createWindow()
      console.log('[BrowserRegistrar] Window created')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'failed', email, error: `Window creation failed: ${msg}` }
    }

    try {
      // Start listening for the auth code BEFORE navigating
      let resolvedAuthCode: string | undefined
      const authCodePromise = Promise.race([
        codePromise,
        this.waitForAuthCode(win, redirectUri, state, 300000)
      ]).then((code) => {
        resolvedAuthCode = code
        return code
      })

      // Navigate to the OIDC authorize URL
      this.log(`[Browser] [2] Loading auth URL (redirect: ${redirectUri})`)
      await win.loadURL(authURL).catch(() => {
        /* ERR_ABORTED on redirects is normal */
      })
      this.checkAborted()

      await sleep(500)

      if (resolvedAuthCode) {
        this.log('[Browser] Authorization code received during initial navigation')
      } else {
        // Step 1: Accept cookies, wait for email input
        await this.stepAcceptCookiesAndWaitForEmail(win)
        this.checkAborted()

        // Step 2: Fill email + Continue
        await this.stepFillEmail(win, email)
        this.checkAborted()

        // Step 3: Signup flow (create account + name + Continue)
        await this.stepSignup(win, fullName)
        this.checkAborted()

        // Record inbox count AFTER OTP was sent (signup form submitted)
        // This ensures we only look at emails that arrived after this point
        this.log('[Browser] [6] Waiting for OTP email')
        if (!this.emailSvc) throw new Error('Email service not initialized')

        // Try OTP up to 3 times (resend if wrong)
        let otpSuccess = false
        for (let attempt = 1; attempt <= 3 && !otpSuccess; attempt++) {
          if (attempt > 1) {
            // Wait for resend button to become enabled (60s cooldown)
            this.log(`[Browser] Waiting for resend button...`)
            const resendEnabled = await waitForSelector(
              win,
              'button[data-testid="email-verification-resend-code-button"]:not([disabled])',
              90000
            )
            if (resendEnabled) {
              await clickWithCookieDismiss(
                win,
                'button[data-testid="email-verification-resend-code-button"]:not([disabled])'
              )
              this.log('[Browser] Clicked resend code')
              await sleep(2000)
            }
          }

          const otp = await this.emailSvc.waitForCode(120, 3)
          this.log(`[Browser] Got OTP (attempt ${attempt}): ${otp}`)
          this.checkAborted()

          await this.stepFillOTP(win, otp)
          this.checkAborted()

          // Check if OTP was rejected
          const hasError = await win.webContents
            .executeJavaScript(
              `
            !!document.querySelector('[data-testid="email-verification-invalid-code-error"]')
          `
            )
            .catch(() => false)

          if (hasError) {
            this.log(`[Browser] OTP rejected (attempt ${attempt}), will retry`)
          } else {
            otpSuccess = true
          }
        }

        if (!otpSuccess) throw new Error('OTP verification failed after 3 attempts')

        // Step 5: Password if required
        await this.stepFillPassword(win, password)
        this.checkAborted()

        // Step 6: Confirm device and allow access
        this.log('[Browser] [9] Confirm device and allow access')
        await this.stepConfirmDevice(win)
        this.checkAborted()
      }

      // Step 7: Wait for auth code from callback redirect
      this.log('[Browser] [10] Waiting for authorization code...')
      const authCode = resolvedAuthCode || (await authCodePromise)
      this.log(`[Browser] Got auth code: ${authCode.slice(0, 8)}...`)

      // Close browser window immediately after authorization complete
      this.destroyWindow()

      // Step 8: Exchange code for tokens
      this.log('[Browser] [11] Exchanging code for tokens')
      const tokenData = await this.exchangeCodeForTokens(
        oidcClient.clientId,
        oidcClient.clientSecret,
        authCode,
        verifier,
        redirectUri
      )
      this.log(`[Browser] Done! Email: ${email}`)

      return {
        status: 'success',
        email,
        password,
        clientId: oidcClient.clientId,
        clientSecret: oidcClient.clientSecret,
        refreshToken: (tokenData.refreshToken as string) || '',
        accessToken: (tokenData.accessToken as string) || '',
        region: 'us-east-1',
        provider: 'BuilderId'
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[BrowserRegistrar] Error: ${msg}`)
      this.log(`[Browser] Error: ${msg}`)
      if (is.dev && this.win && !this.win.isDestroyed()) {
        const url = this.win.webContents.getURL()
        console.log(`[BrowserRegistrar] Failed at: ${url}`)
        this.log(`[Browser] Failed at: ${url}`)
      }
      return { status: 'failed', email, error: msg }
    } finally {
      this.destroyWindow()
      try {
        server.close()
      } catch {
        /* ignore */
      }
    }
  }
}
