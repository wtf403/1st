import { useState, useEffect, useRef, useCallback } from 'react'
import {
  UserPlus,
  Mail,
  Key,
  Loader2,
  CheckCircle2,
  XCircle,
  Trash2,
  Play,
  Square,
  Clock,
  RotateCcw,
  RefreshCw,
  Download,
  Settings2,
  Link2
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useAccountsStore } from '@/store/accounts'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
  Progress,
  Badge,
  Switch
} from '../ui'
import { cn } from '@/lib/utils'
import { appendSubscriptionLink, updateSubscriptionLink } from './SubscriptionPage'

type RegMode =
  | 'manual'
  | 'moemail'
  | 'outlook'
  | 'tempmail'
  | 'ddg'
  | 'browser-ddg'
  | 'browser-tempmail'
  | 'browser-provided-email'
type Phase = 'idle' | 'initializing' | 'email' | 'otp' | 'running' | 'done'

interface RegResult {
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
  consumedProvidedEmailLine?: string
}

type BatchItemStatus =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'success'
  | 'failed'
  | 'imported'
  | 'import_failed'

interface HistoryItem {
  id: string
  time: number
  email: string
  status: 'success' | 'failed'
  error?: string
  password?: string
  result?: RegResult
  imported: boolean
  subscriptionUrl?: string
}

interface BatchItem {
  id: string
  index: number
  status: BatchItemStatus
  email: string
  error?: string
  retryCount: number
}

const MANUAL_STEPS = ['OIDC', 'Email', 'OTP', 'Done'] as const

function phaseToStep(phase: Phase): number {
  switch (phase) {
    case 'idle':
      return -1
    case 'initializing':
      return 0
    case 'email':
      return 1
    case 'otp':
      return 2
    case 'running':
      return 1
    case 'done':
      return 3
  }
}

const STORAGE_KEY = 'kiro-register-config'
const HISTORY_KEY = 'kiro-register-history'

// 模块级状态：组件卸载后仍保留（同一会话内）
let _logs: string[] = []
let _phase: Phase = 'idle'
let _result: RegResult | null = null
let _batchRunning = false
let _batchDone = 0
let _batchSuccess = 0
let _batchFail = 0
let _batchItems: BatchItem[] = []

// 模块级 React setter refs：异步代码跨组件生命周期调用最新 setter
let _refSetPhase: ((v: Phase) => void) | null = null
let _refSetResult: ((v: RegResult | null) => void) | null = null
let _refSetLogs: ((v: string[]) => void) | null = null
let _refSetBatchRunning: ((v: boolean) => void) | null = null
let _refSetBatchDone: ((v: number) => void) | null = null
let _refSetBatchSuccess: ((v: number) => void) | null = null
let _refSetBatchFail: ((v: number) => void) | null = null
let _refSetBatchItems: ((v: BatchItem[]) => void) | null = null
let _refSetHistory: ((v: HistoryItem[] | ((prev: HistoryItem[]) => HistoryItem[])) => void) | null =
  null

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveHistory(items: HistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 100)))
  } catch {
    /* ignore */
  }
}

interface RegisterConfig {
  mode: RegMode
  moBaseURL: string
  moAPIKey: string
  outlookData: string
  fullName: string
  batchCount: number
  batchInterval: number
  batchAutoImport: boolean
  batchRetries: number
  batchConcurrency: number
  autoFetchProLink: boolean
  tempMailEmail: string
  tempMailEpin: string
  tempMailDomain: string
  ddgAuthToken: string
  ddgGmailEmail: string
  ddgGmailAppPassword: string
  proxyUrl: string
  providedEmailData: string
  providedEmailApiKey: string
  providedEmailApiBaseURL: string
  generateProxyEachTime: boolean
  proxyCdpAddress: string
  proxyFormUrl: string
}

function loadConfig(): Partial<RegisterConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveConfig(cfg: RegisterConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    /* ignore */
  }
}

function takeFirstProvidedEmailLine(data: string): { line: string; remaining: string } | null {
  const lines = data.split(/\r?\n/)
  const idx = lines.findIndex((line) => {
    const trimmed = line.trim()
    const sep = trimmed.indexOf(':')
    return sep > 0 && trimmed.slice(0, sep).includes('@') && trimmed.slice(sep + 1).length > 0
  })
  if (idx < 0) return null
  return {
    line: lines[idx].trim(),
    remaining: [...lines.slice(0, idx), ...lines.slice(idx + 1)].join('\n')
  }
}

export function RegisterPage(): React.JSX.Element {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const saved = useRef(loadConfig()).current

  const [mode, setMode] = useState<RegMode>(saved.mode || 'manual')
  const [phase, _setPhase] = useState<Phase>(_phase)
  const [logs, setLogs] = useState<string[]>(_logs)
  const [result, _setResult] = useState<RegResult | null>(_result)
  const [imported, setImported] = useState(false)

  const setPhase = useCallback((p: Phase) => {
    _phase = p
    _refSetPhase?.(p)
  }, [])
  const setResult = useCallback((r: RegResult | null) => {
    _result = r
    _refSetResult?.(r)
  }, [])

  // 手动模式
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState(saved.fullName || '')
  const [otp, setOtp] = useState('')

  // MoEmail 配置
  const [moBaseURL, setMoBaseURL] = useState(saved.moBaseURL || '')
  const [moAPIKey, setMoAPIKey] = useState(saved.moAPIKey || '')

  // Outlook 配置
  const [outlookData, setOutlookData] = useState(saved.outlookData || '')

  // TempMail.Plus 配置
  const [tempMailEmail, setTempMailEmail] = useState(saved.tempMailEmail || '')
  const [tempMailEpin, setTempMailEpin] = useState(saved.tempMailEpin || '')
  const [tempMailDomain, setTempMailDomain] = useState(saved.tempMailDomain || '')

  // DDG 配置
  const [ddgAuthToken, setDdgAuthToken] = useState(saved.ddgAuthToken || '')
  const [ddgGmailEmail, setDdgGmailEmail] = useState(saved.ddgGmailEmail || '')
  const [ddgGmailAppPassword, setDdgGmailAppPassword] = useState(saved.ddgGmailAppPassword || '')
  const [proxyUrl, setProxyUrl] = useState(saved.proxyUrl || '')
  const [providedEmailData, setProvidedEmailData] = useState(saved.providedEmailData || '')
  const [providedEmailApiKey, setProvidedEmailApiKey] = useState(saved.providedEmailApiKey || '')
  const [providedEmailApiBaseURL, setProvidedEmailApiBaseURL] = useState(
    saved.providedEmailApiBaseURL || 'https://firstmail.ltd/api/v1'
  )
  const [generateProxyEachTime, setGenerateProxyEachTime] = useState(
    saved.generateProxyEachTime ?? false
  )
  const [proxyCdpAddress, setProxyCdpAddress] = useState(saved.proxyCdpAddress || '127.0.0.1:9229')
  const [proxyFormUrl, setProxyFormUrl] = useState(
    saved.proxyFormUrl ||
      'https://colab.research.google.com/drive/1KGMyn4gYBF1qvJj6vnNFFoDRWUJYJw5a'
  )

  const logContainerRef = useRef<HTMLDivElement>(null)
  const { addAccount } = useAccountsStore()

  const addLog = useCallback((msg: string) => {
    const next = [..._logs, `[${new Date().toLocaleTimeString()}] ${msg}`]
    _logs = next
    _refSetLogs?.(next)
  }, [])

  useEffect(() => {
    const el = logContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  // 监听注册日志
  useEffect(() => {
    const unsub = window.api.onRegistrationLog((msg) => {
      addLog(msg)
    })
    return () => unsub()
  }, [addLog])

  // 页面挂载时检测注册流程状态
  useEffect(() => {
    window.api.registrationStatus().then((res) => {
      if (res.inProgress && _phase === 'idle') {
        // 后端有流程但前端无状态（应用重启场景），取消残留
        window.api.registrationCancel()
      }
    })
  }, [])

  const reset = (): void => {
    _phase = 'idle'
    _logs = []
    _result = null
    setPhase('idle')
    setLogs([])
    setResult(null)
    setImported(false)
    setOtp('')
  }

  // ============ 手动模式 ============

  const startManual = async (): Promise<void> => {
    setPhase('initializing')
    _logs = []
    setLogs([])
    setResult(null)
    setImported(false)
    addLog(t('register.logManualInit'))

    const config: Record<string, string> = {}
    if (fullName.trim()) config.fullName = fullName.trim()
    const res = await window.api.registrationManualPhase1(config)
    if (res.success) {
      addLog(t('register.logInitDone'))
      setPhase('email')
    } else {
      addLog(`${t('register.logInitFailed')} ${res.error}`)
      setPhase('idle')
    }
  }

  const submitEmail = async (): Promise<void> => {
    if (!email.trim()) return
    setPhase('running')
    addLog(`${t('register.logSubmitEmail')} ${email}`)

    const res = await window.api.registrationManualPhase2(
      email.trim(),
      fullName.trim() || undefined
    )
    if (res.success) {
      addLog(t('register.logOtpSent'))
      setPhase('otp')
    } else {
      addLog(`${t('register.logFailed')} ${res.error}`)
      setPhase('idle')
    }
  }

  const submitOTP = async (): Promise<void> => {
    if (!otp.trim()) return
    setPhase('running')
    addLog(`${t('register.logSubmitOtp')} ${otp}`)

    const res = await window.api.registrationManualPhase3(otp.trim())
    if (res.success) {
      const regResult = res.result as RegResult
      setResult(regResult)
      setPhase('done')
      addHistory({
        email: regResult.email,
        status: regResult.status,
        password: regResult.password,
        result: regResult
      })
      if (batchAutoImport && regResult.status === 'success') {
        const ok = await autoImportResult(regResult)
        if (ok) {
          setImported(true)
          addLog(t('register.logImported'))
          setHistory((prev) => {
            const idx = prev.findIndex((h) => h.email === regResult.email && !h.imported)
            if (idx >= 0) {
              const u = [...prev]
              u[idx] = { ...u[idx], imported: true }
              return u
            }
            return prev
          })
        }
      }
      if (autoFetchProLink && regResult.status === 'success') {
        await fetchProSubscriptionUrl(regResult, regResult.email)
      }
    } else {
      addLog(`${t('register.logFailed')} ${res.error}`)
      setPhase('idle')
    }
  }

  // ============ 自动模式 (MoEmail / Outlook / Browser) ============

  const startAuto = async (): Promise<void> => {
    setPhase('running')
    _logs = []
    setLogs([])
    setResult(null)
    setImported(false)
    const modeLabel =
      mode === 'moemail'
        ? 'MoEmail'
        : mode === 'tempmail'
          ? 'TempMail.Plus'
          : mode === 'ddg'
            ? 'DDG + Gmail'
            : mode === 'browser-ddg'
              ? 'Browser (DDG)'
              : mode === 'browser-tempmail'
                ? 'Browser (TempMail)'
                : mode === 'browser-provided-email'
                  ? 'Browser (Email Provider)'
                  : 'Outlook'
    addLog(t('register.logAutoStart').replace('{mode}', modeLabel))

    if (isBrowserMode) {
      let config: Parameters<typeof window.api.registrationStartBrowser>[0]
      try {
        config = await prepareBrowserConfig()
        if (mode === 'browser-provided-email') {
          const picked = takeFirstProvidedEmailLine(providedEmailData)
          if (!picked)
            throw new Error(
              isEn ? 'No valid email:password line available' : '没有可用的 email:password 行'
            )
          setProvidedEmailData(picked.remaining)
          config.providedEmailData = picked.line
          addLog(`${isEn ? 'Reserved email' : '已预留邮箱'}: ${picked.line.split(':')[0]}`)
        }
      } catch (error) {
        addLog(
          `${t('register.logStartFailed')} ${error instanceof Error ? error.message : String(error)}`
        )
        setPhase('idle')
        return
      }
      const res = await window.api.registrationStartBrowser(config)
      if (!res.success) {
        addLog(`${t('register.logStartFailed')} ${res.error}`)
        setPhase('idle')
      } else if (res.result) {
        await onRegComplete(res.result as RegResult)
      }
      return
    }

    const config: Record<string, unknown> = {}
    if (mode === 'moemail') {
      config.moEmailBaseURL = moBaseURL
      config.moEmailAPIKey = moAPIKey
    } else if (mode === 'outlook') {
      config.useOutlook = true
      config.outlookData = outlookData
    } else if (mode === 'tempmail') {
      config.useTempMailPlus = true
      config.tempMailPlusEmail = tempMailEmail
      config.tempMailPlusEpin = tempMailEpin
      config.tempMailPlusDomain = tempMailDomain
    } else if (mode === 'ddg') {
      config.useDDG = true
      config.ddgAuthToken = ddgAuthToken
      config.ddgGmailEmail = ddgGmailEmail
      config.ddgGmailAppPassword = ddgGmailAppPassword
    }

    const res = await window.api.registrationStartAuto(
      config as Parameters<typeof window.api.registrationStartAuto>[0]
    )
    if (!res.success) {
      addLog(`${t('register.logStartFailed')} ${res.error}`)
      setPhase('idle')
    }
  }

  // ============ 取消 ============

  const cancel = async (): Promise<void> => {
    if (isBrowserMode) {
      await window.api.registrationCancelBrowser()
    } else {
      await window.api.registrationCancel()
    }
    addLog(t('register.logCancelled'))
    setPhase('idle')
  }

  // ============ 导入账号 ============

  const importAccount = async (): Promise<void> => {
    if (!result || result.status !== 'success' || !result.refreshToken) return

    try {
      const verifyResult = await window.api.verifyAccountCredentials({
        refreshToken: result.refreshToken,
        clientId: result.clientId!,
        clientSecret: result.clientSecret!,
        region: result.region || 'us-east-1',
        authMethod: 'IdC',
        provider: 'BuilderId'
      })

      const now = Date.now()
      const defaultUsage = { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }

      if (verifyResult.success && verifyResult.data) {
        const expiresAt = verifyResult.data.expiresIn
          ? now + verifyResult.data.expiresIn * 1000
          : now + 3600000
        const usage = verifyResult.data.usage
          ? {
              ...verifyResult.data.usage,
              percentUsed:
                verifyResult.data.usage.limit > 0
                  ? Math.round(
                      (verifyResult.data.usage.current / verifyResult.data.usage.limit) * 100
                    )
                  : 0,
              lastUpdated: now
            }
          : defaultUsage

        addAccount({
          email: verifyResult.data.email || result.email,
          idp: 'BuilderId',
          status: 'active',
          credentials: {
            refreshToken: result.refreshToken,
            clientId: result.clientId!,
            clientSecret: result.clientSecret!,
            accessToken: verifyResult.data.accessToken || result.accessToken || '',
            csrfToken: '',
            region: result.region || 'us-east-1',
            authMethod: 'IdC' as const,
            provider: 'BuilderId' as const,
            expiresAt
          },
          subscription: {
            type:
              (verifyResult.data.subscriptionType as
                | 'Free'
                | 'Pro'
                | 'Pro_Plus'
                | 'Enterprise'
                | 'Teams') || 'Free',
            title: verifyResult.data.subscriptionTitle || 'Free Tier'
          },
          usage,
          tags: [],
          lastUsedAt: now
        })
        setImported(true)
        addLog(t('register.logImported'))
      } else {
        addLog(`${t('register.logVerifyFailed')} ${verifyResult.error}`)
        addAccount({
          email: result.email,
          idp: 'BuilderId',
          status: 'active',
          credentials: {
            refreshToken: result.refreshToken,
            clientId: result.clientId!,
            clientSecret: result.clientSecret!,
            accessToken: result.accessToken || '',
            csrfToken: '',
            region: result.region || 'us-east-1',
            authMethod: 'IdC' as const,
            provider: 'BuilderId' as const,
            expiresAt: now + 3600000
          },
          subscription: { type: 'Free', title: 'Free Tier' },
          usage: defaultUsage,
          tags: [],
          lastUsedAt: now
        })
        setImported(true)
        addLog(t('register.logDirectImport'))
      }
    } catch (err) {
      addLog(`${t('register.logImportFailed')} ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const isRunning = phase === 'initializing' || phase === 'running'
  const currentStep = phaseToStep(phase)

  // ============ 批量注册 ============

  const [batchCount, setBatchCount] = useState(saved.batchCount ?? 1)
  const [batchInterval, setBatchInterval] = useState(saved.batchInterval ?? 5)
  const [batchRunning, _setBatchRunning] = useState(_batchRunning)
  const [batchDone, _setBatchDone] = useState(_batchDone)
  const [batchSuccess, _setBatchSuccess] = useState(_batchSuccess)
  const [batchFail, _setBatchFail] = useState(_batchFail)
  const [batchAutoImport, setBatchAutoImport] = useState(saved.batchAutoImport ?? true)
  const [batchRetries, setBatchRetries] = useState(saved.batchRetries ?? 1)
  const [batchConcurrency, setBatchConcurrency] = useState(saved.batchConcurrency ?? 1)
  const [autoFetchProLink, setAutoFetchProLink] = useState(saved.autoFetchProLink ?? false)
  const [batchItems, _setBatchItems] = useState<BatchItem[]>(_batchItems)

  const setBatchRunning = (v: boolean) => {
    _batchRunning = v
    _refSetBatchRunning?.(v)
  }
  const setBatchDone = (v: number | ((p: number) => number)) => {
    const next = typeof v === 'function' ? v(_batchDone) : v
    _batchDone = next
    _refSetBatchDone?.(next)
  }
  const setBatchSuccess = (v: number | ((p: number) => number)) => {
    const next = typeof v === 'function' ? v(_batchSuccess) : v
    _batchSuccess = next
    _refSetBatchSuccess?.(next)
  }
  const setBatchFail = (v: number | ((p: number) => number)) => {
    const next = typeof v === 'function' ? v(_batchFail) : v
    _batchFail = next
    _refSetBatchFail?.(next)
  }
  const setBatchItems = (v: BatchItem[] | ((p: BatchItem[]) => BatchItem[])) => {
    const next = typeof v === 'function' ? v(_batchItems) : v
    _batchItems = next
    _refSetBatchItems?.(next)
  }
  const batchAbort = useRef(false)

  // 自动保存配置到 localStorage
  useEffect(() => {
    saveConfig({
      mode,
      moBaseURL,
      moAPIKey,
      outlookData,
      fullName,
      batchCount,
      batchInterval,
      batchAutoImport,
      batchRetries,
      batchConcurrency,
      autoFetchProLink,
      tempMailEmail,
      tempMailEpin,
      tempMailDomain,
      ddgAuthToken,
      ddgGmailEmail,
      ddgGmailAppPassword,
      proxyUrl,
      providedEmailData,
      providedEmailApiKey,
      providedEmailApiBaseURL,
      generateProxyEachTime,
      proxyCdpAddress,
      proxyFormUrl
    })
    if (
      mode === 'browser-ddg' ||
      mode === 'browser-tempmail' ||
      mode === 'browser-provided-email'
    ) {
      window.api
        .registrationSaveAutoReplacementConfig({
          enabled: true,
          useDDG: mode === 'browser-ddg',
          ddgAuthToken,
          ddgGmailEmail,
          ddgGmailAppPassword,
          useTempMailPlus: mode === 'browser-tempmail',
          tempMailPlusEmail: tempMailEmail,
          tempMailPlusEpin: tempMailEpin,
          tempMailPlusDomain: tempMailDomain,
          providedEmailData: mode === 'browser-provided-email' ? providedEmailData : undefined,
          providedEmailApiKey:
            mode === 'browser-provided-email' ? providedEmailApiKey.trim() || undefined : undefined,
          providedEmailApiBaseURL:
            mode === 'browser-provided-email'
              ? providedEmailApiBaseURL.trim() || undefined
              : undefined,
          proxyUrl: generateProxyEachTime ? undefined : proxyUrl.trim() || undefined,
          generateProxyEachTime,
          proxyCdpAddress,
          proxyFormUrl
        })
        .catch(() => undefined)
    } else {
      window.api.registrationSaveAutoReplacementConfig({ enabled: false }).catch(() => undefined)
    }
  }, [
    mode,
    moBaseURL,
    moAPIKey,
    outlookData,
    fullName,
    batchCount,
    batchInterval,
    batchAutoImport,
    batchRetries,
    batchConcurrency,
    autoFetchProLink,
    tempMailEmail,
    tempMailEpin,
    tempMailDomain,
    ddgAuthToken,
    ddgGmailEmail,
    ddgGmailAppPassword,
    proxyUrl,
    providedEmailData,
    providedEmailApiKey,
    providedEmailApiBaseURL,
    generateProxyEachTime,
    proxyCdpAddress,
    proxyFormUrl
  ])

  // ============ 注册历史 ============

  const [history, _setHistory] = useState<HistoryItem[]>(loadHistory)

  const setHistory = useCallback(
    (updater: HistoryItem[] | ((prev: HistoryItem[]) => HistoryItem[])) => {
      _refSetHistory?.((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        saveHistory(next)
        return next
      })
    },
    []
  )

  const addHistory = useCallback(
    (item: Omit<HistoryItem, 'id' | 'time' | 'imported'>) => {
      setHistory((prev) => [
        {
          ...item,
          id: crypto.randomUUID(),
          time: Date.now(),
          imported: false
        },
        ...prev
      ])
    },
    [setHistory]
  )

  // 注册模块级 setter refs，确保异步代码跨组件生命周期调用最新 setter
  useEffect(() => {
    _refSetPhase = _setPhase
    _refSetResult = _setResult
    _refSetLogs = setLogs
    _refSetBatchRunning = _setBatchRunning
    _refSetBatchDone = _setBatchDone
    _refSetBatchSuccess = _setBatchSuccess
    _refSetBatchFail = _setBatchFail
    _refSetBatchItems = _setBatchItems
    _refSetHistory = _setHistory
    // 组件重新挂载时同步模块级状态到 React state
    _setPhase(_phase)
    _setResult(_result)
    setLogs([..._logs])
    _setBatchRunning(_batchRunning)
    _setBatchDone(_batchDone)
    _setBatchSuccess(_batchSuccess)
    _setBatchFail(_batchFail)
    _setBatchItems([..._batchItems])
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 自动导入单个成功结果
  const autoImportResult = useCallback(
    async (regResult: RegResult): Promise<boolean> => {
      if (!regResult.refreshToken || !regResult.clientId || !regResult.clientSecret) return false
      try {
        const now = Date.now()
        const defaultUsage = { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }
        // Do NOT call verifyAccountCredentials here — hitting GetUsageLimits immediately
        // after registration (without a real browser WAF token) triggers account suspension.
        // Import directly with the tokens we already have from registration.
        addAccount({
          email: regResult.email,
          password: regResult.password,
          idp: 'BuilderId',
          status: 'active',
          credentials: {
            refreshToken: regResult.refreshToken,
            clientId: regResult.clientId,
            clientSecret: regResult.clientSecret,
            accessToken: regResult.accessToken || '',
            csrfToken: '',
            region: regResult.region || 'us-east-1',
            authMethod: 'IdC' as const,
            provider: 'BuilderId' as const,
            expiresAt: now + 3600000
          },
          subscription: { type: 'Free', title: 'Free Tier' },
          usage: defaultUsage,
          tags: [],
          lastUsedAt: now
        })
        return true
      } catch {
        return false
      }
    },
    [addAccount]
  )

  // 获取 Pro 订阅链接并写入订阅页面链接列表
  const fetchProSubscriptionUrl = useCallback(
    async (regResult: RegResult, email: string): Promise<string | undefined> => {
      const accessToken = regResult.accessToken
      if (!accessToken) return undefined
      const linkId = crypto.randomUUID()
      appendSubscriptionLink({ accountId: linkId, email, status: 'loading' })
      try {
        addLog(`[Pro Link] ${email}: ${t('register.fetchingProLink')}...`)
        const result = await window.api.accountGetSubscriptionUrl(
          accessToken,
          'Q_DEVELOPER_STANDALONE_PRO',
          regResult.region || 'us-east-1',
          undefined,
          undefined,
          'BuilderId',
          'IdC',
          undefined
        )
        if (result.success && result.url) {
          addLog(`[Pro Link] ${email}: ${result.url}`)
          updateSubscriptionLink(linkId, { status: 'success', url: result.url })
          return result.url
        }
        const errMsg = result.error || 'Failed to get link'
        addLog(`[Pro Link] ${email}: ${errMsg}`)
        updateSubscriptionLink(linkId, { status: 'error', error: errMsg })
        return undefined
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        addLog(`[Pro Link] ${email}: ${errMsg}`)
        updateSubscriptionLink(linkId, { status: 'error', error: errMsg })
        return undefined
      }
    },
    [addLog, t]
  )

  // 监听注册完成 - 同时记录到历史 + 自动导入
  const onRegComplete = useCallback(
    async (res: RegResult) => {
      setResult(res)
      setPhase('done')
      if (res.status === 'success') {
        addLog(`${t('register.logRegSuccess')} ${res.email}`)
        addHistory({ email: res.email, status: 'success', password: res.password, result: res })
        if (batchAutoImport) {
          const ok = await autoImportResult(res)
          if (ok) {
            setImported(true)
            addLog(t('register.logImported'))
            setHistory((prev) => {
              const idx = prev.findIndex((h) => h.email === res.email && !h.imported)
              if (idx >= 0) {
                const u = [...prev]
                u[idx] = { ...u[idx], imported: true }
                return u
              }
              return prev
            })
          }
        }
        if (autoFetchProLink) {
          await fetchProSubscriptionUrl(res, res.email)
        }
      } else {
        addLog(`${t('register.logRegFailed')} ${res.error}`)
        addHistory({
          email: res.email,
          status: res.status,
          error: res.error,
          password: res.password,
          result: res
        })
      }
    },
    [
      addLog,
      addHistory,
      t,
      batchAutoImport,
      autoImportResult,
      autoFetchProLink,
      fetchProSubscriptionUrl
    ]
  )

  // 覆盖原有的 onRegistrationComplete 监听
  useEffect(() => {
    const unsub = window.api.onRegistrationComplete(onRegComplete)
    return () => unsub()
  }, [onRegComplete])

  // 构建自动模式配置
  const buildAutoConfig = useCallback((): Parameters<
    typeof window.api.registrationStartAuto
  >[0] => {
    const config: Record<string, unknown> = {}
    if (mode === 'moemail') {
      config.moEmailBaseURL = moBaseURL
      config.moEmailAPIKey = moAPIKey
    } else if (mode === 'tempmail') {
      config.useTempMailPlus = true
      config.tempMailPlusEmail = tempMailEmail
      config.tempMailPlusEpin = tempMailEpin
      config.tempMailPlusDomain = tempMailDomain
    } else if (mode === 'ddg') {
      config.useDDG = true
      config.ddgAuthToken = ddgAuthToken
      config.ddgGmailEmail = ddgGmailEmail
      config.ddgGmailAppPassword = ddgGmailAppPassword
    } else {
      config.useOutlook = true
      config.outlookData = outlookData
    }
    return config as Parameters<typeof window.api.registrationStartAuto>[0]
  }, [
    mode,
    moBaseURL,
    moAPIKey,
    outlookData,
    tempMailEmail,
    tempMailEpin,
    tempMailDomain,
    ddgAuthToken,
    ddgGmailEmail,
    ddgGmailAppPassword
  ])

  // 构建浏览器模式配置
  const buildBrowserConfig = useCallback((): Parameters<
    typeof window.api.registrationStartBrowser
  >[0] => {
    const config: Parameters<typeof window.api.registrationStartBrowser>[0] = {}
    if (mode === 'browser-ddg') {
      config.useDDG = true
      config.ddgAuthToken = ddgAuthToken
      config.ddgGmailEmail = ddgGmailEmail
      config.ddgGmailAppPassword = ddgGmailAppPassword
    } else if (mode === 'browser-tempmail') {
      config.useTempMailPlus = true
      config.tempMailPlusEmail = tempMailEmail
      config.tempMailPlusEpin = tempMailEpin
      config.tempMailPlusDomain = tempMailDomain
    } else if (mode === 'browser-provided-email') {
      config.providedEmailData = providedEmailData
      config.providedEmailApiKey = providedEmailApiKey.trim() || undefined
      config.providedEmailApiBaseURL = providedEmailApiBaseURL.trim() || undefined
    }
    if (!generateProxyEachTime && proxyUrl.trim()) config.proxyUrl = proxyUrl.trim()
    return config
  }, [
    mode,
    ddgAuthToken,
    ddgGmailEmail,
    ddgGmailAppPassword,
    tempMailEmail,
    tempMailEpin,
    tempMailDomain,
    providedEmailData,
    providedEmailApiKey,
    providedEmailApiBaseURL,
    proxyUrl,
    generateProxyEachTime
  ])

  const generateSharedColabProxy = useCallback(
    async (scope: 'single' | 'batch'): Promise<string | undefined> => {
      addLog(
        scope === 'batch'
          ? isEn
            ? 'Generating one shared proxy before launching concurrent browser registrations...'
            : '正在启动并发浏览器注册前生成一个共享代理...'
          : isEn
            ? 'Generating new proxy from Colab...'
            : '正在从 Colab 生成新代理...'
      )
      const proxyRes = await window.api.registrationGenerateColabProxy({
        cdpAddress: proxyCdpAddress.trim() || undefined,
        formUrl: proxyFormUrl.trim() || undefined
      })
      if (!proxyRes.success || !proxyRes.proxyUrl) {
        addLog(
          scope === 'batch'
            ? `${isEn ? 'Shared proxy generation failed; batch will continue without proxy' : '共享代理生成失败，批量将不使用代理继续'}: ${proxyRes.error || 'Proxy generation failed'}`
            : `${isEn ? 'Proxy generation failed, continuing without proxy' : '代理生成失败，将不使用代理继续'}: ${proxyRes.error || 'Proxy generation failed'}`
        )
        return undefined
      }
      setProxyUrl(proxyRes.proxyUrl)
      addLog(
        `${scope === 'batch' ? (isEn ? 'Shared proxy generated' : '已生成共享代理') : isEn ? 'Generated proxy' : '已生成代理'}: ${proxyRes.proxyUrl}`
      )
      return proxyRes.proxyUrl
    },
    [addLog, isEn, proxyCdpAddress, proxyFormUrl]
  )

  const prepareBrowserConfig = useCallback(
    async (
      baseConfig?: Parameters<typeof window.api.registrationStartBrowser>[0]
    ): Promise<Parameters<typeof window.api.registrationStartBrowser>[0]> => {
      const config = { ...(baseConfig || buildBrowserConfig()) }
      // Batch registration may pre-generate one shared proxy and pass it in baseConfig.
      // Do not generate again when a proxyUrl already exists, otherwise concurrent
      // browser tasks race the same Colab/CDP session and each task gets a different proxy.
      if (generateProxyEachTime && !config.proxyUrl) {
        config.proxyUrl = await generateSharedColabProxy('single')
      }
      return config
    },
    [buildBrowserConfig, generateProxyEachTime, generateSharedColabProxy]
  )

  const isBrowserMode =
    mode === 'browser-ddg' || mode === 'browser-tempmail' || mode === 'browser-provided-email'

  // 执行单次注册（含重试）
  const runSingleWithRetry = useCallback(
    async (
      itemId: string,
      taskId: string,
      maxRetries: number,
      config: Parameters<typeof window.api.registrationStartAuto>[0]
    ): Promise<{ success: boolean; result?: RegResult }> => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (batchAbort.current) return { success: false }

        if (attempt > 0) {
          setBatchItems((prev) =>
            prev.map((it) =>
              it.id === itemId
                ? { ...it, status: 'retrying' as BatchItemStatus, retryCount: attempt }
                : it
            )
          )
          addLog(
            t('register.batchRetrying')
              .replace('{current}', String(attempt))
              .replace('{max}', String(maxRetries))
          )
          await new Promise((r) => setTimeout(r, 3000))
        } else {
          setBatchItems((prev) =>
            prev.map((it) =>
              it.id === itemId ? { ...it, status: 'running' as BatchItemStatus } : it
            )
          )
        }

        const isBrowser = isBrowserMode
        const res = isBrowser
          ? await window.api.registrationStartBrowser({
              ...(await prepareBrowserConfig(
                config as Parameters<typeof window.api.registrationStartBrowser>[0]
              )),
              taskId
            })
          : await window.api.registrationStartAuto({ ...config, taskId } as typeof config)

        if (res.success && res.result) {
          const regResult = res.result as RegResult
          if (regResult.status === 'success') {
            return { success: true, result: regResult }
          }
          if (attempt === maxRetries) {
            return { success: false, result: regResult }
          }
        } else if (!res.success) {
          if (attempt === maxRetries) return { success: false }
        }
      }
      return { success: false }
    },
    [addLog, t, isBrowserMode, prepareBrowserConfig]
  )

  // 处理单个批量注册任务完成
  const handleBatchOutcome = async (
    itemId: string,
    outcome: { success: boolean; result?: RegResult }
  ): Promise<void> => {
    if (outcome.success && outcome.result) {
      setBatchSuccess((p) => p + 1)
      setBatchItems((prev) =>
        prev.map((it) =>
          it.id === itemId ? { ...it, status: 'success', email: outcome.result!.email } : it
        )
      )
      addHistory({
        email: outcome.result.email,
        status: 'success',
        password: outcome.result.password,
        result: outcome.result
      })

      if (batchAutoImport) {
        const imported = await autoImportResult(outcome.result)
        setBatchItems((prev) =>
          prev.map((it) =>
            it.id === itemId ? { ...it, status: imported ? 'imported' : 'import_failed' } : it
          )
        )
        if (imported) {
          addLog(t('register.logImported'))
          setHistory((prev) => {
            const idx = prev.findIndex((h) => h.email === outcome.result!.email && !h.imported)
            if (idx >= 0) {
              const updated = [...prev]
              updated[idx] = { ...updated[idx], imported: true }
              return updated
            }
            return prev
          })
        }
      }
      if (autoFetchProLink) {
        await fetchProSubscriptionUrl(outcome.result, outcome.result.email)
      }
    } else {
      setBatchFail((p) => p + 1)
      const errEmail = outcome.result?.email || ''
      const errMsg = outcome.result?.error || 'unknown'
      setBatchItems((prev) =>
        prev.map((it) =>
          it.id === itemId ? { ...it, status: 'failed', email: errEmail, error: errMsg } : it
        )
      )
      if (outcome.result) {
        addHistory({ email: errEmail, status: 'failed', error: errMsg })
      }
    }
    setBatchDone((p) => p + 1)
  }

  // 批量注册主逻辑（支持并发）
  const startBatch = async (): Promise<void> => {
    if (mode === 'manual') return
    setBatchRunning(true)
    setBatchDone(0)
    setBatchSuccess(0)
    setBatchFail(0)
    batchAbort.current = false

    const items: BatchItem[] = Array.from({ length: batchCount }, (_, i) => ({
      id: crypto.randomUUID(),
      index: i + 1,
      status: 'pending' as BatchItemStatus,
      email: '',
      retryCount: 0
    }))
    setBatchItems(items)

    const config = isBrowserMode ? buildBrowserConfig() : buildAutoConfig()
    const concurrency = Math.max(1, batchConcurrency)

    if (isBrowserMode && generateProxyEachTime) {
      ;(config as Parameters<typeof window.api.registrationStartBrowser>[0]).proxyUrl =
        await generateSharedColabProxy('batch')
    }

    let reservedProvidedLines: string[] = []
    if (mode === 'browser-provided-email') {
      let remaining = providedEmailData
      for (let i = 0; i < batchCount; i++) {
        const picked = takeFirstProvidedEmailLine(remaining)
        if (!picked) break
        reservedProvidedLines.push(picked.line)
        remaining = picked.remaining
      }
      if (reservedProvidedLines.length === 0) {
        addLog(isEn ? 'No valid email:password lines available' : '没有可用的 email:password 行')
        setBatchRunning(false)
        return
      }
      if (reservedProvidedLines.length < batchCount) {
        addLog(
          `${isEn ? 'Only reserved' : '只预留了'} ${reservedProvidedLines.length}/${batchCount} ${isEn ? 'email accounts' : '个邮箱账号'}`
        )
      }
      setProvidedEmailData(remaining)
    }

    setPhase('running')

    // 并发池执行
    const executing = new Set<Promise<void>>()
    let launched = 0
    const launchCount =
      mode === 'browser-provided-email' ? reservedProvidedLines.length : batchCount

    for (let i = 0; i < launchCount; i++) {
      if (batchAbort.current) {
        addLog(
          t('register.batchStopped')
            .replace('{done}', String(launched))
            .replace('{total}', String(batchCount))
        )
        break
      }

      const itemId = items[i].id
      const taskId = `batch-${itemId.slice(0, 8)}`
      const taskConfig =
        mode === 'browser-provided-email'
          ? ({ ...config, providedEmailData: reservedProvidedLines[i] } as typeof config)
          : config
      addLog(`--- Batch ${i + 1}/${launchCount} ---`)
      if (mode === 'browser-provided-email') {
        addLog(
          `${isEn ? 'Reserved email' : '已预留邮箱'}: ${reservedProvidedLines[i].split(':')[0]}`
        )
      }
      launched++

      const task = (async () => {
        const outcome = await runSingleWithRetry(itemId, taskId, batchRetries, taskConfig)
        await handleBatchOutcome(itemId, outcome)
      })()

      const tracked = task.finally(() => executing.delete(tracked))
      executing.add(tracked)

      // 控制并发数：池满时等待空位
      if (executing.size >= concurrency) {
        await Promise.race(executing)
      }

      // 每次启动任务后等待间隔（0 则不等待）
      if (i < launchCount - 1 && !batchAbort.current && batchInterval > 0) {
        await new Promise((r) => setTimeout(r, batchInterval * 1000))
      }
    }

    // 等待所有正在执行的任务完成
    await Promise.all(executing)

    setBatchRunning(false)
    setPhase('idle')
    addLog(t('register.batchCompleted'))
  }

  const stopBatch = (): void => {
    batchAbort.current = true
    if (isBrowserMode) {
      window.api.registrationCancelBrowser()
    } else {
      window.api.registrationCancel()
    }
  }

  // 导入历史中的账号
  const importHistoryItem = async (item: HistoryItem): Promise<void> => {
    if (!item.result || item.result.status !== 'success' || !item.result.refreshToken) return
    const r = item.result

    try {
      const verifyResult = await window.api.verifyAccountCredentials({
        refreshToken: r.refreshToken!,
        clientId: r.clientId!,
        clientSecret: r.clientSecret!,
        region: r.region || 'us-east-1',
        authMethod: 'IdC',
        provider: 'BuilderId'
      })

      const now = Date.now()
      const defaultUsage = { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }

      if (verifyResult.success && verifyResult.data) {
        const expiresAt = verifyResult.data.expiresIn
          ? now + verifyResult.data.expiresIn * 1000
          : now + 3600000
        const usage = verifyResult.data.usage
          ? {
              ...verifyResult.data.usage,
              percentUsed:
                verifyResult.data.usage.limit > 0
                  ? Math.round(
                      (verifyResult.data.usage.current / verifyResult.data.usage.limit) * 100
                    )
                  : 0,
              lastUpdated: now
            }
          : defaultUsage

        addAccount({
          email: verifyResult.data.email || r.email,
          idp: 'BuilderId',
          status: 'active',
          credentials: {
            refreshToken: r.refreshToken!,
            clientId: r.clientId!,
            clientSecret: r.clientSecret!,
            accessToken: verifyResult.data.accessToken || r.accessToken || '',
            csrfToken: '',
            region: r.region || 'us-east-1',
            authMethod: 'IdC' as const,
            provider: 'BuilderId' as const,
            expiresAt
          },
          subscription: {
            type:
              (verifyResult.data.subscriptionType as
                | 'Free'
                | 'Pro'
                | 'Pro_Plus'
                | 'Enterprise'
                | 'Teams') || 'Free',
            title: verifyResult.data.subscriptionTitle || 'Free Tier'
          },
          usage,
          tags: [],
          lastUsedAt: now
        })
      } else {
        addAccount({
          email: r.email,
          idp: 'BuilderId',
          status: 'active',
          credentials: {
            refreshToken: r.refreshToken!,
            clientId: r.clientId!,
            clientSecret: r.clientSecret!,
            accessToken: r.accessToken || '',
            csrfToken: '',
            region: r.region || 'us-east-1',
            authMethod: 'IdC' as const,
            provider: 'BuilderId' as const,
            expiresAt: now + 3600000
          },
          subscription: { type: 'Free', title: 'Free Tier' },
          usage: defaultUsage,
          tags: [],
          lastUsedAt: now
        })
      }

      setHistory((prev) => prev.map((h) => (h.id === item.id ? { ...h, imported: true } : h)))
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto max-w-5xl mx-auto">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-primary/10 p-6 border border-primary/20">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-primary/10">
            <UserPlus className="h-7 w-7 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-primary">{t('register.title')}</h1>
            <p className="text-sm text-muted-foreground">
              {isEn
                ? 'Register new Kiro accounts automatically or manually'
                : '自动或手动注册新的 Kiro 账号'}
            </p>
          </div>
        </div>
      </div>

      {/* 模式选择 + 配置 */}
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" />
            {t('register.mode')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
            {(
              [
                ['manual', t('register.manual')],
                ['moemail', 'MoEmail'],
                ['outlook', 'Outlook'],
                ['tempmail', t('register.tempmail')],
                ['ddg', 'DDG + Gmail'],
                ['browser-ddg', isEn ? 'Browser (DDG)' : '浏览器 (DDG)'],
                ['browser-tempmail', isEn ? 'Browser (TempMail)' : '浏览器 (TempMail)'],
                [
                  'browser-provided-email',
                  isEn ? 'Browser (Email Provider)' : '浏览器 (邮箱提供商)'
                ]
              ] as [RegMode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={isRunning || batchRunning}
                className={cn(
                  'px-4 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50',
                  mode === m
                    ? 'bg-background shadow text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 自动导入开关 */}
          <div className="flex items-center gap-3">
            <Switch
              checked={batchAutoImport}
              onCheckedChange={setBatchAutoImport}
              disabled={isRunning || batchRunning}
            />
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">{t('register.batchAutoImport')}</span>
              <span className="text-xs text-muted-foreground">
                — {t('register.batchAutoImportDesc')}
              </span>
            </div>
          </div>

          {/* 自动获取 Pro 订阅链接开关 */}
          <div className="flex items-center gap-3">
            <Switch
              checked={autoFetchProLink}
              onCheckedChange={setAutoFetchProLink}
              disabled={isRunning || batchRunning}
            />
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">{t('register.autoFetchProLink')}</span>
              <span className="text-xs text-muted-foreground">
                — {t('register.autoFetchProLinkDesc')}
              </span>
            </div>
          </div>

          {/* MoEmail 配置 */}
          {mode === 'moemail' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-muted/30 rounded-lg border border-dashed">
              <div className="space-y-1.5">
                <Label>{t('register.moApiUrl')}</Label>
                <Input
                  value={moBaseURL}
                  onChange={(e) => setMoBaseURL(e.target.value)}
                  placeholder="https://mo.xxx.com"
                  disabled={isRunning || batchRunning}
                />
              </div>
              <div className="space-y-1.5">
                <Label>
                  {t('register.moApiKey')} ({t('register.optional')})
                </Label>
                <Input
                  type="password"
                  value={moAPIKey}
                  onChange={(e) => setMoAPIKey(e.target.value)}
                  disabled={isRunning || batchRunning}
                />
              </div>
            </div>
          )}

          {/* Outlook 配置 */}
          {mode === 'outlook' && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-1.5">
              <Label>
                {t('register.outlookAccounts')} ({t('register.outlookFormat')})
              </Label>
              <textarea
                value={outlookData}
                onChange={(e) => setOutlookData(e.target.value)}
                placeholder={t('register.outlookPlaceholder')}
                rows={3}
                disabled={isRunning || batchRunning}
                className="w-full px-3 py-2 bg-background border rounded-lg text-sm font-mono disabled:opacity-50 resize-none"
              />
            </div>
          )}

          {/* TempMail.Plus 自建域名配置 */}
          {(mode === 'tempmail' || mode === 'browser-tempmail') && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>{t('register.tempMailDomain')}</Label>
                  <Input
                    value={tempMailDomain}
                    onChange={(e) => setTempMailDomain(e.target.value)}
                    placeholder="example.com"
                    disabled={isRunning || batchRunning}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('register.tempMailEmail')}</Label>
                  <Input
                    value={tempMailEmail}
                    onChange={(e) => setTempMailEmail(e.target.value)}
                    placeholder={t('register.tempMailEmailPlaceholder')}
                    disabled={isRunning || batchRunning}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('register.tempMailEpin')}</Label>
                  <Input
                    type="password"
                    value={tempMailEpin}
                    onChange={(e) => setTempMailEpin(e.target.value)}
                    disabled={isRunning || batchRunning}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('register.tempMailDesc')}</p>
            </div>
          )}

          {/* DuckDuckGo Email Protection + Gmail IMAP 配置 */}
          {(mode === 'ddg' || mode === 'browser-ddg') && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>{isEn ? 'DDG Auth Token' : 'DDG 授权 Token'}</Label>
                  <Input
                    type="password"
                    value={ddgAuthToken}
                    onChange={(e) => setDdgAuthToken(e.target.value)}
                    placeholder={isEn ? 'Bearer token from DDG account' : 'DDG 账号 Bearer token'}
                    disabled={isRunning || batchRunning}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{isEn ? 'Gmail Address' : 'Gmail 地址'}</Label>
                  <Input
                    value={ddgGmailEmail}
                    onChange={(e) => setDdgGmailEmail(e.target.value)}
                    placeholder="you@gmail.com"
                    disabled={isRunning || batchRunning}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>{isEn ? 'Gmail App Password' : 'Gmail 应用专用密码'}</Label>
                <Input
                  type="password"
                  value={ddgGmailAppPassword}
                  onChange={(e) => setDdgGmailAppPassword(e.target.value)}
                  placeholder={
                    isEn
                      ? '16-char app password (Settings → Security → App passwords)'
                      : '16位应用专用密码（设置 → 安全 → 应用专用密码）'
                  }
                  disabled={isRunning || batchRunning}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {isEn
                  ? 'DDG generates a @duck.com alias and forwards mail to your Gmail. Gmail IMAP polls for the OTP.'
                  : 'DDG 生成 @duck.com 别名并转发邮件到 Gmail，通过 Gmail IMAP 轮询获取验证码。'}
              </p>
            </div>
          )}

          {/* Provided Email Provider config */}
          {mode === 'browser-provided-email' && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>{isEn ? 'FirstMail API Key' : 'FirstMail API 密钥'}</Label>
                  <Input
                    type="password"
                    value={providedEmailApiKey}
                    onChange={(e) => setProvidedEmailApiKey(e.target.value)}
                    placeholder="X-API-KEY"
                    disabled={isRunning || batchRunning}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{isEn ? 'FirstMail API Base URL' : 'FirstMail API 地址'}</Label>
                  <Input
                    value={providedEmailApiBaseURL}
                    onChange={(e) => setProvidedEmailApiBaseURL(e.target.value)}
                    placeholder="https://firstmail.ltd/api/v1"
                    disabled={isRunning || batchRunning}
                  />
                </div>
              </div>
              <Label>{isEn ? 'Email Provider Accounts' : '邮箱提供商账号'}</Label>
              <textarea
                value={providedEmailData}
                onChange={(e) => setProvidedEmailData(e.target.value)}
                placeholder={`kimnickles1931@alchiod.com:tmaxqeoxY!9528\njanniecavender1943@amaruanele.com:nrghrmzxY!3696`}
                rows={8}
                disabled={isRunning || batchRunning}
                className="w-full px-3 py-2 bg-background border rounded-lg text-sm font-mono disabled:opacity-50 resize-y"
              />
              <p className="text-xs text-muted-foreground">
                {isEn
                  ? 'Format: email:password, one account per line. OTP is read through FirstMail /email/messages using X-API-KEY. Each successful run consumes the top line and removes it from this list.'
                  : '格式：email:password，每行一个账号。验证码通过 FirstMail /email/messages 和 X-API-KEY 读取。每次成功注册会使用并从列表顶部移除一行。'}
              </p>
            </div>
          )}

          {/* Browser Mode Proxy Config */}
          {isBrowserMode && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-4">
              <div className="space-y-1.5">
                <Label>{isEn ? 'Proxy URL (Optional)' : '代理 URL（可选）'}</Label>
                <Input
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder={
                    isEn
                      ? 'http://user:pass@host:port or socks5://host:port'
                      : 'http://user:pass@host:port 或 socks5://host:port'
                  }
                  disabled={isRunning || batchRunning || generateProxyEachTime}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label>{isEn ? 'Generate new proxy each time' : '每次生成新代理'}</Label>
                  <p className="text-xs text-muted-foreground">
                    {isEn
                      ? 'Uses an existing Chrome CDP session with the Colab notebook.'
                      : '使用已有 Chrome CDP 会话和 Colab 笔记本。'}
                  </p>
                </div>
                <Switch
                  checked={generateProxyEachTime}
                  onCheckedChange={setGenerateProxyEachTime}
                  disabled={isRunning || batchRunning}
                />
              </div>
              {generateProxyEachTime && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>{isEn ? 'CDP address' : 'CDP 地址'}</Label>
                    <Input
                      value={proxyCdpAddress}
                      onChange={(e) => setProxyCdpAddress(e.target.value)}
                      placeholder="127.0.0.1:9229"
                      disabled={isRunning || batchRunning}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{isEn ? 'Colab notebook URL' : 'Colab 笔记本 URL'}</Label>
                    <Input
                      value={proxyFormUrl}
                      onChange={(e) => setProxyFormUrl(e.target.value)}
                      placeholder="https://colab.research.google.com/drive/..."
                      disabled={isRunning || batchRunning}
                    />
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {isEn
                  ? 'Start Chrome with --remote-debugging-port=9229 and keep the Colab notebook signed in.'
                  : '用 --remote-debugging-port=9229 启动 Chrome，并保持 Colab 笔记本已登录。'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 手动模式进度步骤条 */}
      {mode === 'manual' && phase !== 'idle' && (
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center justify-between">
            {MANUAL_STEPS.map((step, i) => (
              <div key={step} className="flex items-center flex-1">
                <div
                  className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-colors ${
                    i < currentStep
                      ? 'bg-green-500 text-white'
                      : i === currentStep
                        ? 'bg-primary text-primary-foreground animate-pulse'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {i < currentStep ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                </div>
                <span
                  className={`ml-2 text-xs font-medium ${i <= currentStep ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  {step}
                </span>
                {i < MANUAL_STEPS.length - 1 && (
                  <div
                    className={`flex-1 h-0.5 mx-3 ${i < currentStep ? 'bg-green-500' : 'bg-muted'}`}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 操作区 */}
      <Card className="border-0 shadow-sm">
        <CardContent className="pt-5 space-y-4">
          {/* 手动模式 email/otp 输入 */}
          {mode === 'manual' && phase === 'email' && (
            <div className="space-y-4 p-4 bg-muted/30 rounded-lg border border-dashed">
              <div className="space-y-1.5">
                <Label>{t('register.emailLabel')}</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('register.emailPlaceholder')}
                  onKeyDown={(e) => e.key === 'Enter' && submitEmail()}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('register.fullNameRandom')}</Label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('register.fullNamePlaceholder')}
                />
              </div>
              <Button onClick={submitEmail} size="sm">
                <Mail className="h-4 w-4 mr-2" />
                {t('register.submitEmail')}
              </Button>
            </div>
          )}

          {mode === 'manual' && phase === 'otp' && (
            <div className="space-y-4 p-4 bg-muted/30 rounded-lg border border-dashed">
              <div className="space-y-1.5">
                <Label>{t('register.otpLabel')}</Label>
                <Input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="123456"
                  maxLength={6}
                  className="font-mono text-lg tracking-widest"
                  onKeyDown={(e) => e.key === 'Enter' && submitOTP()}
                />
                <p className="text-xs text-muted-foreground">
                  {t('register.otpSentTo')} {email}
                </p>
              </div>
              <Button onClick={submitOTP} size="sm">
                <Key className="h-4 w-4 mr-2" />
                {t('register.submitOtp')}
              </Button>
            </div>
          )}

          {/* 按钮 */}
          <div className="flex gap-3">
            {phase === 'idle' && !batchRunning && (
              <Button
                onClick={mode === 'manual' ? startManual : startAuto}
                disabled={
                  (mode === 'moemail' && !moBaseURL) ||
                  (mode === 'outlook' && !outlookData.trim()) ||
                  (mode === 'tempmail' &&
                    (!tempMailDomain.trim() || !tempMailEmail.trim() || !tempMailEpin.trim())) ||
                  (mode === 'ddg' &&
                    (!ddgAuthToken.trim() ||
                      !ddgGmailEmail.trim() ||
                      !ddgGmailAppPassword.trim())) ||
                  (mode === 'browser-ddg' &&
                    (!ddgAuthToken.trim() ||
                      !ddgGmailEmail.trim() ||
                      !ddgGmailAppPassword.trim())) ||
                  (mode === 'browser-tempmail' &&
                    (!tempMailDomain.trim() || !tempMailEmail.trim() || !tempMailEpin.trim())) ||
                  (mode === 'browser-provided-email' &&
                    (!providedEmailData.trim() || !providedEmailApiKey.trim()))
                }
              >
                <Play className="h-4 w-4 mr-2" />
                {t('register.startRegistration')}
              </Button>
            )}

            {(isRunning || batchRunning || phase === 'email' || phase === 'otp') && (
              <Button variant="destructive" onClick={batchRunning ? stopBatch : cancel}>
                <Square className="h-4 w-4 mr-2" />
                {t('register.cancel')}
              </Button>
            )}

            {phase === 'done' && !batchRunning && (
              <Button variant="outline" onClick={reset}>
                <RotateCcw className="h-4 w-4 mr-2" />
                {t('register.newRegistration')}
              </Button>
            )}
          </div>

          {isRunning && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              {t('register.processing')}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 批量注册 (非手动模式) */}
      {mode !== 'manual' && (
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Play className="h-4 w-4 text-primary" />
              {t('register.batchTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* 配置行 */}
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchCount')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={batchCount}
                  onChange={(e) => {
                    const v = parseInt(e.target.value)
                    if (!isNaN(v) && v >= 1) setBatchCount(v)
                  }}
                  onBlur={() => {
                    if (batchCount < 1) setBatchCount(1)
                  }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchInterval')}</Label>
                <Input
                  type="number"
                  min={0}
                  max={300}
                  value={batchInterval}
                  onChange={(e) => {
                    const v = parseInt(e.target.value)
                    if (!isNaN(v) && v >= 0) setBatchInterval(v)
                  }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchRetries')}</Label>
                <Input
                  type="number"
                  min={0}
                  max={10}
                  value={batchRetries}
                  onChange={(e) => {
                    const v = parseInt(e.target.value)
                    if (!isNaN(v) && v >= 0) setBatchRetries(v)
                  }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchConcurrency')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={batchConcurrency}
                  onChange={(e) => {
                    const v = parseInt(e.target.value)
                    if (!isNaN(v) && v >= 1) setBatchConcurrency(v)
                  }}
                  onBlur={() => {
                    if (batchConcurrency < 1) setBatchConcurrency(1)
                  }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <Button
                variant={batchRunning ? 'destructive' : 'default'}
                onClick={batchRunning ? stopBatch : startBatch}
                disabled={
                  (!batchRunning && isRunning) ||
                  (mode === 'moemail' && !moBaseURL) ||
                  (mode === 'outlook' && !outlookData.trim()) ||
                  (mode === 'tempmail' &&
                    (!tempMailDomain.trim() || !tempMailEmail.trim() || !tempMailEpin.trim())) ||
                  (mode === 'ddg' &&
                    (!ddgAuthToken.trim() ||
                      !ddgGmailEmail.trim() ||
                      !ddgGmailAppPassword.trim())) ||
                  (mode === 'browser-ddg' &&
                    (!ddgAuthToken.trim() ||
                      !ddgGmailEmail.trim() ||
                      !ddgGmailAppPassword.trim())) ||
                  (mode === 'browser-tempmail' &&
                    (!tempMailDomain.trim() || !tempMailEmail.trim() || !tempMailEpin.trim())) ||
                  (mode === 'browser-provided-email' &&
                    (!providedEmailData.trim() || !providedEmailApiKey.trim()))
                }
              >
                {batchRunning ? (
                  <>
                    <Square className="h-4 w-4 mr-2" />
                    {t('register.batchStop')}
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    {t('register.batchStart')}
                  </>
                )}
              </Button>
            </div>

            {/* 进度 + 每项状态 */}
            {(batchRunning || batchDone > 0) && (
              <div className="space-y-3">
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium">
                    {t('register.batchProgress')}: {batchDone}/{batchCount}
                  </span>
                  <Badge
                    variant="outline"
                    className="text-green-600 border-green-200 bg-green-50 dark:bg-green-950/30"
                  >
                    {t('register.batchSuccess')}: {batchSuccess}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="text-red-600 border-red-200 bg-red-50 dark:bg-red-950/30"
                  >
                    {t('register.batchFail')}: {batchFail}
                  </Badge>
                </div>
                <Progress
                  value={batchCount > 0 ? (batchDone / batchCount) * 100 : 0}
                  className="h-2"
                />

                {/* 每项状态列表 */}
                {batchItems.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border rounded-lg bg-muted/20">
                    {batchItems.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between px-3 py-1.5 border-b last:border-b-0 text-xs hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground w-6 text-right">
                            #{item.index}
                          </span>
                          {item.status === 'pending' && (
                            <span className="text-muted-foreground">—</span>
                          )}
                          {item.status === 'running' && (
                            <Loader2 className="h-3 w-3 animate-spin text-primary" />
                          )}
                          {item.status === 'retrying' && (
                            <RefreshCw className="h-3 w-3 animate-spin text-yellow-500" />
                          )}
                          {item.status === 'success' && (
                            <CheckCircle2 className="h-3 w-3 text-green-500" />
                          )}
                          {item.status === 'imported' && (
                            <Download className="h-3 w-3 text-green-600" />
                          )}
                          {item.status === 'failed' && <XCircle className="h-3 w-3 text-red-500" />}
                          {item.status === 'import_failed' && (
                            <XCircle className="h-3 w-3 text-orange-500" />
                          )}
                          {item.email && <span className="font-mono">{item.email}</span>}
                        </div>
                        <span
                          className={cn(
                            'text-xs',
                            (item.status === 'success' || item.status === 'imported') &&
                              'text-green-600',
                            (item.status === 'failed' || item.status === 'import_failed') &&
                              'text-red-500',
                            item.status === 'retrying' && 'text-yellow-600',
                            (item.status === 'pending' || item.status === 'running') &&
                              'text-muted-foreground'
                          )}
                        >
                          {item.status === 'pending'
                            ? ''
                            : item.status === 'running'
                              ? t('register.processing')
                              : item.status === 'retrying'
                                ? `${t('register.batchItemRetrying')} (${item.retryCount})`
                                : item.status === 'success'
                                  ? t('register.batchItemSuccess')
                                  : item.status === 'imported'
                                    ? t('register.batchItemImported')
                                    : item.status === 'import_failed'
                                      ? t('register.batchItemImportFailed')
                                      : item.error || t('register.batchItemFailed')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 结果 */}
      {result && (
        <Card
          className={cn(
            'border shadow-sm',
            result.status === 'success'
              ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
          )}
        >
          <CardContent className="pt-5 space-y-3">
            <div className="flex items-center gap-2">
              {result.status === 'success' ? (
                <div className="p-1.5 rounded-full bg-green-100 dark:bg-green-900/50">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                </div>
              ) : (
                <div className="p-1.5 rounded-full bg-red-100 dark:bg-red-900/50">
                  <XCircle className="h-5 w-5 text-red-600" />
                </div>
              )}
              <h3 className="text-lg font-semibold">
                {result.status === 'success' ? t('register.success') : t('register.failed')}
              </h3>
            </div>

            {result.status === 'success' && (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm p-3 bg-background/50 rounded-lg">
                  <div>
                    <span className="text-muted-foreground">{t('register.emailField')}</span>{' '}
                    <span className="font-mono font-medium">{result.email}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('register.passwordField')}</span>{' '}
                    <span className="font-mono font-medium">{result.password}</span>
                  </div>
                </div>
                <Button
                  onClick={importAccount}
                  disabled={imported}
                  variant={imported ? 'outline' : 'default'}
                  className={imported ? 'text-green-600 border-green-300' : ''}
                  size="sm"
                >
                  {imported ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      {t('register.imported')}
                    </>
                  ) : (
                    <>
                      <UserPlus className="h-4 w-4 mr-2" />
                      {t('register.importToManager')}
                    </>
                  )}
                </Button>
              </>
            )}

            {result.status === 'failed' && (
              <p className="text-sm text-red-600 dark:text-red-400">{result.error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* 注册历史 */}
      {history.length > 0 && (
        <Card className="border-0 shadow-sm overflow-hidden">
          <CardHeader className="py-3 border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" />
                {t('register.historyTitle')} ({history.length})
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setHistory([])}>
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {t('register.historyClear')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-48 overflow-y-auto">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between px-4 py-2.5 border-b last:border-b-0 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {item.status === 'success' ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-500" />
                    )}
                    <span className="font-mono text-xs">{item.email}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(item.time).toLocaleTimeString()}
                    </span>
                  </div>
                  {item.status === 'success' && item.result?.refreshToken && (
                    <Badge
                      variant="outline"
                      className={cn(
                        'cursor-pointer text-xs',
                        item.imported
                          ? 'text-green-600 border-green-200'
                          : 'text-primary border-primary/30 hover:bg-primary/10'
                      )}
                      onClick={() => !item.imported && importHistoryItem(item)}
                    >
                      {item.imported ? t('register.imported') : t('register.historyImport')}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 日志 */}
      {logs.length > 0 && (
        <Card className="border-0 shadow-sm overflow-hidden">
          <CardHeader className="py-3 border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">{t('register.log')}</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  _logs = []
                  setLogs([])
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div
              ref={logContainerRef}
              className="h-48 overflow-y-auto p-3 font-mono text-xs space-y-0.5 bg-muted/20"
            >
              {logs.map((line, i) => (
                <div key={i} className="text-muted-foreground leading-relaxed">
                  {line}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
