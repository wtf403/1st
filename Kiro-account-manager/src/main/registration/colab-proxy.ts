const DEFAULT_COLAB_URL = 'https://colab.research.google.com/drive/1KGMyn4gYBF1qvJj6vnNFFoDRWUJYJw5a'
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

export interface GenerateColabProxyConfig {
  cdpAddress: string
  formUrl?: string
  cellSelector?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeCdpAddress(address: string): string {
  const trimmed = address.trim()
  if (!trimmed) throw new Error('CDP address is required')
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed.replace(/\/$/, '')
  return `http://${trimmed.replace(/\/$/, '')}`
}

function clickScript(selector: string): string {
  return `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      return true;
    })()
  `
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`CDP HTTP ${res.status}: ${await res.text()}`)
  return await res.json() as T
}

class CdpSession {
  private ws: any
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  constructor(private readonly wsUrl: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const WebSocketCtor = (globalThis as any).WebSocket
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
    try { this.ws?.close() } catch { /* noop */ }
  }
}

async function findOrOpenColabTarget(cdpBase: string, notebookUrl: string): Promise<CdpTarget> {
  let targets = await fetchJson<CdpTarget[]>(`${cdpBase}/json/list`)
  let target = targets.find((item) => item.type === 'page' && item.url?.includes('colab.research.google.com'))
  if (target) return target

  const encodedUrl = encodeURIComponent(notebookUrl)
  try {
    target = await fetchJson<CdpTarget>(`${cdpBase}/json/new?${encodedUrl}`, { method: 'PUT' })
  } catch {
    target = await fetchJson<CdpTarget>(`${cdpBase}/json/new?${encodedUrl}`)
  }

  await sleep(5000)
  targets = await fetchJson<CdpTarget[]>(`${cdpBase}/json/list`)
  return targets.find((item) => item.id === target?.id) || target
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

async function resetRuntime(session: CdpSession): Promise<void> {
  const isRunning = await session.evaluate<boolean>(`
    (() => !!(document.querySelector('.cell-execution.running') || document.querySelector('#stop-symbol')))()
  `)
  if (isRunning) {
    await session.evaluate(clickScript('.cell-execution.running #run-button'))
    await sleep(2000)
  }

  const statusText = await session.evaluate<string>(`
    (() => (document.querySelector('#runtime-menu-button')?.textContent || '').toLowerCase())()
  `)
  if (statusText.includes('connect') && !statusText.includes('disconnect')) {
    await session.evaluate(clickScript('#runtime-menu-button'))
    await sleep(1000)
    await session.evaluate(clickScript('div[command="connect"]'))
    await sleep(15000)
  }

  await session.evaluate(clickScript('#runtime-menu-button'))
  await sleep(2500)
  await session.evaluate(clickScript('div[command="powerwash-current-vm"]'))
  await sleep(1500)
  await session.evaluate(clickScript('div[command="powerwash-current-vm"]'))
  await sleep(1500)
  await clickYesButton(session)
  await sleep(5000)
}

async function runCellAndExtractProxy(session: CdpSession, cellSelector: string): Promise<string> {
  await session.evaluate(`
    (() => {
      const runBtn = document.querySelector(${JSON.stringify(`${cellSelector} colab-run-button`)});
      if (runBtn) runBtn.click();
      return !!runBtn;
    })()
  `)

  for (let attempt = 1; attempt <= 90; attempt++) {
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
          /socks5:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d+/,
          /socks5:\d{1,3}(?:\.\d{1,3}){3}:\d+/,
          /\d{1,3}(?:\.\d{1,3}){3}:\d+/
        ];
        for (const pattern of patterns) {
          const match = allText.match(pattern);
          if (match) return { found: true, proxy: match[0] };
        }
        return { found: false, debug: allText.substring(0, 200) };
      })()
    `)
    if (result.found && result.proxy) return result.proxy.replace(/^socks5:\/\//, 'socks5://').replace(/^socks5:/, 'socks5://')
    if (attempt === 30 || attempt === 60) {
      await session.evaluate(`document.querySelector(${JSON.stringify(`${cellSelector} colab-run-button`)})?.click()`)
      await sleep(25000)
    }
  }
  throw new Error('Timeout extracting proxy from Colab output')
}

export async function generateColabProxy(config: GenerateColabProxyConfig): Promise<string> {
  const cdpBase = normalizeCdpAddress(config.cdpAddress)
  const target = await findOrOpenColabTarget(cdpBase, config.formUrl?.trim() || DEFAULT_COLAB_URL)
  if (!target?.webSocketDebuggerUrl) throw new Error('Colab CDP target has no WebSocket URL')

  const session = new CdpSession(target.webSocketDebuggerUrl)
  await session.connect()
  try {
    await session.send('Runtime.enable')
    await resetRuntime(session)
    return await runCellAndExtractProxy(session, config.cellSelector?.trim() || DEFAULT_CELL_SELECTOR)
  } finally {
    session.close()
  }
}
