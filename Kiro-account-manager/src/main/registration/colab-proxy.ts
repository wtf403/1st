import { spawn } from 'child_process'
import { existsSync, readdirSync } from 'fs'

const DEFAULT_COLAB_URL =
  'https://colab.research.google.com/drive/1KGMyn4gYBF1qvJj6vnNFFoDRWUJYJw5a'
const DEFAULT_CELL_SELECTOR = '#cell-SyjPT6ZFWD0D'

type CdpTarget = {
  id: string
  type: string
  title?: string
  url?: string
  webSocketDebuggerUrl?: string
}

type CdpResponse = {
  id?: number
  result?: unknown
  error?: { message?: string }
}

type WebSocketLike = {
  onopen: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: (() => void) | null
  send: (data: string) => void
  close: () => void
}

type WebSocketConstructor = new (url: string) => WebSocketLike

export interface GenerateColabProxyConfig {
  cdpAddress?: string
  formUrl?: string
  cellSelector?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeCdpAddress(address?: string): string {
  const trimmed = address?.trim() || '127.0.0.1:9229'
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://'))
    return trimmed.replace(/\/$/, '')
  return `http://${trimmed.replace(/\/$/, '')}`
}

function getCdpPort(cdpBase: string): number | undefined {
  try {
    return Number(new URL(cdpBase).port || 80)
  } catch {
    return undefined
  }
}

function getDefaultChromeUserDataDir(candidate: string): string | undefined {
  const home = process.env.USERPROFILE || process.env.HOME
  if (!home) return undefined
  const lower = candidate.toLowerCase()
  const isEdge = lower.includes('edge') || lower.includes('msedge')
  const isChromium = lower.includes('chromium')

  if (process.platform === 'win32') {
    if (isEdge) return `${home}\\AppData\\Local\\Microsoft\\Edge\\User Data`
    if (isChromium) return `${home}\\AppData\\Local\\Chromium\\User Data`
    return `${home}\\AppData\\Local\\Google\\Chrome\\User Data`
  }
  if (process.platform === 'darwin') {
    if (isEdge) return `${home}/Library/Application Support/Microsoft Edge`
    if (isChromium) return `${home}/Library/Application Support/Chromium`
    return `${home}/Library/Application Support/Google/Chrome`
  }

  // Do not override Chromium's profile path on Linux. The snap Chromium build exits with
  // code 21 when pointed at /root/.config/chromium from inside snap confinement. Omitting
  // --user-data-dir lets /snap/bin/chromium use its own default profile successfully.
  if (isChromium) return undefined
  if (isEdge) return `${home}/.config/microsoft-edge`
  return `${home}/.config/google-chrome`
}

function detectDisplay(): string {
  if (process.env.DISPLAY) return process.env.DISPLAY
  try {
    const sockets = readdirSync('/tmp/.X11-unix')
      .filter((name) => /^X\d+$/.test(name))
      .map((name) => Number(name.slice(1)))
      .filter((display) => Number.isFinite(display))
      .sort((a, b) => b - a)
    if (sockets.length > 0) return `:${sockets[0]}`
  } catch {
    /* ignore */
  }
  return ':0'
}

function detectXauthority(): string | undefined {
  if (process.env.XAUTHORITY) return process.env.XAUTHORITY
  const home = process.env.HOME || process.env.USERPROFILE
  const candidates = [home ? `${home}/.Xauthority` : '', '/root/.Xauthority'].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate))
}

function getChromeCandidates(): string[] {
  if (process.platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA
        ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
        : '',
      process.env.PROGRAMFILES
        ? `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`
        : '',
      process.env['PROGRAMFILES(X86)']
        ? `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`
        : '',
      'chrome.exe',
      'msedge.exe'
    ]
    return candidates.filter(Boolean)
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'google-chrome',
      'chromium'
    ]
  }
  return [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'microsoft-edge'
  ]
}

function spawnBrowser(candidate: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(candidate, args, { detached: true, stdio: 'ignore', env })

    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })

    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      reject(new Error(`exited immediately (code ${code ?? 'null'}, signal ${signal ?? 'null'})`))
    })

    child.once('spawn', () => {
      child.unref()
      setTimeout(() => {
        if (settled) return
        settled = true
        resolve()
      }, 4000)
    })
  })
}

async function launchDefaultChromeProfile(cdpBase: string, notebookUrl: string): Promise<void> {
  const port = getCdpPort(cdpBase) || 9229
  const candidates = getChromeCandidates()
  const errors: string[] = []
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const xauthority = detectXauthority()
  const env = {
    ...process.env,
    DISPLAY: detectDisplay(),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    ...(xauthority ? { XAUTHORITY: xauthority } : {})
  }

  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (!existsSync(candidate)) {
        errors.push(`${candidate}: not found`)
        continue
      }
    }

    const userDataDir = getDefaultChromeUserDataDir(candidate)
    const args = [
      `--remote-debugging-port=${port}`,
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      notebookUrl
    ]
    if (process.platform === 'linux') args.unshift('--no-sandbox')
    if (userDataDir && existsSync(userDataDir)) args.unshift(`--user-data-dir=${userDataDir}`)

    try {
      await spawnBrowser(candidate, args, env)
      await sleep(5500)
      return
    } catch (error) {
      errors.push(
        `${candidate} DISPLAY=${env.DISPLAY}${env.XAUTHORITY ? ` XAUTHORITY=${env.XAUTHORITY}` : ''}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  throw new Error(
    `Unable to start Chrome/Chromium with the default profile. Start it manually with --remote-debugging-port=${port}. Tried: ${errors.join('; ')}`
  )
}

async function waitForCdp(cdpBase: string): Promise<void> {
  let lastError = ''
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fetchJson<CdpTarget[]>(`${cdpBase}/json/list`)
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await sleep(1000)
    }
  }
  throw new Error(
    `Chrome/Chromium was launched but CDP did not become ready at ${cdpBase}. ${lastError}`
  )
}

function logColab(message: string): void {
  console.log(`[Collab] ${message}`)
}

function clickScript(selector: string): string {
  return `
    (() => {
      const findDeep = (root, selectors) => {
        for (const sel of selectors) {
          const direct = root.querySelector?.(sel);
          if (direct) return direct;
        }
        for (const el of Array.from(root.querySelectorAll?.('*') || [])) {
          if (el.shadowRoot) {
            const found = findDeep(el.shadowRoot, selectors);
            if (found) return found;
          }
        }
        return null;
      };
      const el = findDeep(document, [${JSON.stringify(selector)}]);
      if (!el) return false;
      el.scrollIntoView?.({ block: 'center', inline: 'center' });
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      el.click?.();
      return true;
    })()
  `
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (error) {
    throw new Error(
      `Cannot connect to Chrome CDP at ${url}. Start Chrome/Chromium with --remote-debugging-port=9229 and keep the default profile signed in to Colab. ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!res.ok) throw new Error(`CDP HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

class CdpSession {
  private ws?: WebSocketLike
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  constructor(private readonly wsUrl: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const WebSocketCtor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
      if (!WebSocketCtor) {
        reject(new Error('WebSocket is not available in this Node runtime'))
        return
      }

      this.ws = new WebSocketCtor(this.wsUrl)
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('Failed to connect to CDP WebSocket'))
      this.ws.onmessage = (event: { data: string }) => {
        const msg = JSON.parse(event.data) as CdpResponse
        if (!msg.id) return
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        if (msg.error) waiter.reject(new Error(msg.error.message || 'CDP command failed'))
        else waiter.resolve(msg.result)
      }
      this.ws.onclose = () => {
        for (const waiter of this.pending.values()) waiter.reject(new Error('CDP WebSocket closed'))
        this.pending.clear()
      }
    })
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws) return Promise.reject(new Error('CDP session is not connected'))
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    })
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{ result?: { value?: T } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    return result.result?.value as T
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}

async function findOrOpenColabTarget(cdpBase: string, notebookUrl: string): Promise<CdpTarget> {
  logColab(`Looking for Chrome CDP target at ${cdpBase}`)
  let targets: CdpTarget[]
  let initialError = ''
  try {
    targets = await fetchJson<CdpTarget[]>(`${cdpBase}/json/list`)
    logColab(`Connected to CDP; found ${targets.length} target(s)`)
  } catch (error) {
    initialError = error instanceof Error ? error.message : String(error)
    logColab(`CDP is not ready, launching Chrome/Chromium: ${initialError}`)
    try {
      await launchDefaultChromeProfile(cdpBase, notebookUrl)
      await waitForCdp(cdpBase)
      targets = await fetchJson<CdpTarget[]>(`${cdpBase}/json/list`)
      logColab(`Chrome launched; found ${targets.length} target(s)`)
    } catch (launchError) {
      const launchMessage = launchError instanceof Error ? launchError.message : String(launchError)
      throw new Error(`${launchMessage}. Initial CDP error: ${initialError}`)
    }
  }
  let target = targets.find(
    (item) => item.type === 'page' && item.url?.includes('colab.research.google.com')
  )
  if (target) {
    logColab(`Reusing Colab tab: ${target.title || target.url || target.id}`)
    return target
  }

  logColab(`Opening Colab notebook: ${notebookUrl}`)
  const encodedUrl = encodeURIComponent(notebookUrl)
  try {
    target = await fetchJson<CdpTarget>(`${cdpBase}/json/new?${encodedUrl}`, { method: 'PUT' })
  } catch {
    target = await fetchJson<CdpTarget>(`${cdpBase}/json/new?${encodedUrl}`)
  }

  await sleep(5000)
  targets = await fetchJson<CdpTarget[]>(`${cdpBase}/json/list`)
  const openedTarget = targets.find((item) => item.id === target?.id) || target
  logColab(`Opened Colab target: ${openedTarget.title || openedTarget.url || openedTarget.id}`)
  return openedTarget
}

async function clickYesButton(session: CdpSession): Promise<boolean> {
  return await session.evaluate<boolean>(`
    (() => {
      const findYesButton = (root) => {
        const textButtons = root.querySelectorAll('md-text-button');
        for (const btn of textButtons) {
          if ((btn.textContent || '').trim() === 'Yes') {
            return btn.shadowRoot?.querySelector('button') || btn;
          }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const found = findYesButton(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      };
      const yesButton = findYesButton(document);
      if (!yesButton) return false;
      yesButton.click();
      return true;
    })()
  `)
}

async function clickRunButton(session: CdpSession): Promise<void> {
  logColab('Waiting for Colab run button')
  const result = await session.evaluate<{ clicked: boolean; debug: string }>(
    `
    new Promise((resolve) => {
      let done = false;
      const selectors = [
        '#run-button',
        'colab-run-button',
        '[aria-label*="Run"]',
        '[title*="Run"]',
        'paper-icon-button.command-run-focused',
        'paper-icon-button[command="run"]'
      ];
      const findDeep = (root) => {
        for (const selector of selectors) {
          const el = root.querySelector?.(selector);
          if (el) return el;
        }
        for (const el of Array.from(root.querySelectorAll?.('*') || [])) {
          if (el.shadowRoot) {
            const found = findDeep(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      };
      const clickElement = (el) => {
        const rect = el.getBoundingClientRect?.();
        el.scrollIntoView?.({ block: 'center', inline: 'center' });
        el.focus?.();
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
          el.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect ? rect.left + rect.width / 2 : 0,
            clientY: rect ? rect.top + rect.height / 2 : 0
          }));
        });
        el.click?.();
      };
      const click = () => {
        if (done) return true;
        const runBtn = findDeep(document);
        if (!runBtn) return false;
        done = true;
        clickElement(runBtn);
        resolve({ clicked: true, debug: runBtn.outerHTML?.slice(0, 300) || runBtn.tagName || 'unknown' });
        return true;
      };
      if (click()) return;
      const observer = new MutationObserver(() => click());
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        if (done) return;
        observer.disconnect();
        const buttons = Array.from(document.querySelectorAll('button, paper-icon-button, colab-run-button, [role="button"]'))
          .map((el) => ({
            tag: el.tagName,
            id: el.id,
            aria: el.getAttribute('aria-label') || '',
            title: el.getAttribute('title') || '',
            text: (el.textContent || '').trim().slice(0, 80)
          }))
          .slice(0, 30);
        resolve({ clicked: false, debug: JSON.stringify(buttons) });
      }, 30000);
    })
  `
  )

  if (!result.clicked) {
    logColab(`Run button not found. Page buttons: ${result.debug}`)
    throw new Error('Timed out waiting for Colab run button')
  }
  logColab(`Clicked Colab run button: ${result.debug}`)
}

async function disconnectRuntime(session: CdpSession): Promise<void> {
  logColab('Opening runtime menu')
  const menuClicked = await session.evaluate<boolean>(clickScript('#runtime-menu-button'))
  logColab(`Runtime menu click result: ${menuClicked}`)
  await sleep(1500)
  const clicked = await session.evaluate<boolean>(
    `
    (() => {
      const commands = [
        'disconnect',
        'disconnect-and-delete-runtime',
        'manage-sessions'
      ];
      for (const command of commands) {
        const el = document.querySelector(` +
      '`div[command="${command}"]`' +
      `);
        if (el) {
          el.click();
          return true;
        }
      }
      const items = Array.from(document.querySelectorAll('[role="menuitem"], paper-item, mwc-list-item'));
      const item = items.find((el) => /disconnect|delete runtime|terminate/i.test(el.textContent || ''));
      if (item) {
        item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      }
      return false;
    })()
  `
  )
  logColab(`Disconnect runtime menu item click result: ${clicked}`)
  if (clicked) {
    await sleep(1500)
    const yesClicked = await clickYesButton(session)
    logColab(`Disconnect confirmation click result: ${yesClicked}`)
  }
  await sleep(10000)
}

async function runFreshCell(session: CdpSession, cellSelector: string): Promise<void> {
  logColab(`Running fresh cell: ${cellSelector}`)
  const clicked = await session.evaluate<boolean>(`
    (() => {
      const cell = document.querySelector(${JSON.stringify(cellSelector)});
      cell?.scrollIntoView({ block: 'center' });
      const runBtn = document.querySelector(${JSON.stringify(`${cellSelector} colab-run-button`)}) ||
        cell?.querySelector('colab-run-button, #run-button, [aria-label*="Run"], [title*="Run"]');
      if (!runBtn) return false;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
        runBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      runBtn.click?.();
      return true;
    })()
  `)
  logColab(`Fresh cell run click result: ${clicked}`)
}

async function resetRuntime(session: CdpSession): Promise<void> {
  logColab('Reset runtime sequence started')
  await clickRunButton(session)
  logColab('Run button clicked, immediately disconnecting runtime')
  await disconnectRuntime(session)
  logColab('Waiting 20s after runtime disconnect')
  await sleep(20000)
}

async function runCellAndExtractProxy(session: CdpSession, cellSelector: string): Promise<string> {
  logColab(`Waiting for proxy output in cell: ${cellSelector}`)
  for (let attempt = 1; attempt <= 120; attempt++) {
    await sleep(1000)
    const result = await session.evaluate<{ found: boolean; proxy?: string; debug?: string }>(`
      (() => {
        const cell = document.querySelector(${JSON.stringify(cellSelector)});
        if (!cell) return { found: false, debug: 'Cell not found' };
        const selectors = ['.output-area', '.output_subarea', '.output_text', 'colab-output-area', '[data-mime-type]', 'pre'];
        let allText = '';
        for (const selector of selectors) {
          for (const el of cell.querySelectorAll(selector)) allText += el.textContent || '';
        }
        if (!allText) allText = cell.textContent || '';
        const patterns = [
          new RegExp('socks5://\\\\d{1,3}(?:\\\\.\\\\d{1,3}){3}:\\\\d+'),
          new RegExp('socks5:\\\\d{1,3}(?:\\\\.\\\\d{1,3}){3}:\\\\d+'),
          new RegExp('\\\\d{1,3}(?:\\\\.\\\\d{1,3}){3}:\\\\d+')
        ];
        for (const pattern of patterns) {
          const match = allText.match(pattern);
          if (match) return { found: true, proxy: match[0] };
        }
        return { found: false, debug: allText.substring(0, 200) };
      })()
    `)
    if (result.found && result.proxy) {
      const proxy = result.proxy
        .replace(/^socks5:\/\//, 'socks5://')
        .replace(/^socks5:/, 'socks5://')
      logColab(`Proxy extracted on attempt ${attempt}: ${proxy}`)
      return proxy
    }
    if (attempt === 1 || attempt % 15 === 0) {
      logColab(`Proxy not found yet (attempt ${attempt}/120): ${result.debug || 'no output'}`)
    }
    if (attempt === 45 || attempt === 90) {
      logColab(`Retrying cell run at attempt ${attempt}`)
      await runFreshCell(session, cellSelector)
      await sleep(15000)
    }
  }
  throw new Error('Timeout extracting proxy from Colab output')
}

export async function generateColabProxy(config: GenerateColabProxyConfig): Promise<string> {
  logColab('Generate Colab proxy requested')
  const cdpBase = normalizeCdpAddress(config.cdpAddress)
  const notebookUrl = config.formUrl?.trim() || DEFAULT_COLAB_URL
  const target = await findOrOpenColabTarget(cdpBase, notebookUrl)
  if (!target?.webSocketDebuggerUrl) throw new Error('Colab CDP target has no WebSocket URL')

  const session = new CdpSession(target.webSocketDebuggerUrl)
  logColab('Connecting to Colab CDP WebSocket')
  await session.connect()
  try {
    await session.send('Runtime.enable')
    const cellSelector = config.cellSelector?.trim() || DEFAULT_CELL_SELECTOR
    logColab(`Using cell selector: ${cellSelector}`)
    await resetRuntime(session)
    return await runCellAndExtractProxy(session, cellSelector)
  } finally {
    logColab('Closing Colab CDP session')
    session.close()
  }
}
