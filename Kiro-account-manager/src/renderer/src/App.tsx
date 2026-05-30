import { useState, useEffect, useCallback, useRef } from 'react'
import { AccountManager } from './components/accounts'
import { Sidebar, type PageType } from './components/layout'
import {
  HomePage,
  AboutPage,
  SettingsPage,
  MachineIdPage,
  KiroSettingsPage,
  ProxyPage,
  KProxyPage,
  RegisterPage,
  SubscriptionPage,
  LogsPage,
  ProxyPoolPage,
  WebhooksPage,
  DiagnosePage,
  ConfigSyncPage
} from './components/pages'
import { UpdateDialog } from './components/UpdateDialog'
import { CloseConfirmDialog } from './components/CloseConfirmDialog'
import { useAccountsStore } from './store/accounts'
import { useWebhookStore } from './store/webhooks'

// 托盘信息防抖延迟：后台刷新风暴时合并多次跨进程 IPC 为单次
const TRAY_UPDATE_DEBOUNCE_MS = 400
// 后台刷新结果批量化间隔：N 条结果合并到一次 set，避免 N 次 Map 全量复制 + 渲染抖动
const BACKGROUND_RESULT_FLUSH_MS = 120

function App(): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState<PageType>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)

  const {
    loadFromStorage,
    startAutoTokenRefresh,
    stopAutoTokenRefresh,
    handleBackgroundRefreshResult,
    handleBackgroundCheckResult,
    flushSaveImmediately,
    accounts,
    activeAccountId,
    setActiveAccount,
    checkAndRefreshExpiringTokens,
    updateAccount
  } = useAccountsStore()

  // 切换到下一个可用账户
  const switchToNextAccount = useCallback(() => {
    const activeAccounts = Array.from(accounts.values()).filter((acc) => acc.status === 'active')
    if (activeAccounts.length <= 1) return

    const currentIndex = activeAccounts.findIndex((acc) => acc.id === activeAccountId)
    const nextIndex = (currentIndex + 1) % activeAccounts.length
    setActiveAccount(activeAccounts[nextIndex].id)
  }, [accounts, activeAccountId, setActiveAccount])

  // 托盘信息防抖：账号 Map 频繁变更（后台刷新风暴）时合并 N 次 IPC 为 1 次
  const trayDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateTrayInfo = useCallback(() => {
    // 更新账户列表
    const accountList = Array.from(accounts.values()).map((acc) => ({
      id: acc.id,
      email: acc.email || 'Unknown',
      idp: acc.idp || 'Unknown',
      status: acc.status
    }))
    window.api.updateTrayAccountList(accountList)

    // 更新当前账户
    if (activeAccountId) {
      const activeAccount = accounts.get(activeAccountId)
      if (activeAccount) {
        window.api.updateTrayAccount({
          id: activeAccount.id,
          email: activeAccount.email || 'Unknown',
          idp: activeAccount.idp || 'Unknown',
          status: activeAccount.status,
          subscription: activeAccount.subscription?.title || undefined,
          usage: activeAccount.usage
            ? {
                usedCredits: activeAccount.usage.current || 0,
                totalCredits: activeAccount.usage.limit || 0,
                totalRequests: 0,
                successRequests: 0,
                failedRequests: 0
              }
            : undefined
        })
      } else {
        window.api.updateTrayAccount(null)
      }
    } else {
      window.api.updateTrayAccount(null)
    }
  }, [accounts, activeAccountId])

  // 应用启动时加载数据并启动自动刷新
  useEffect(() => {
    loadFromStorage().then(() => {
      startAutoTokenRefresh()
    })

    return () => {
      stopAutoTokenRefresh()
    }
  }, [loadFromStorage, startAutoTokenRefresh, stopAutoTokenRefresh])

  // 反代关键事件 → 触发 webhook（v1.8 新增）
  // 由 main/proxyServer 内置的 webhookTrigger 通过 IPC 推送过来，统一在 renderer 调 useWebhookStore
  useEffect(() => {
    const unsubscribe = window.api.onProxyWebhookTrigger?.((event, payload) => {
      try {
        const store = useWebhookStore.getState()
        // 映射反代事件名 → Webhook 事件类型
        const webhookEventMap: Record<string, 'risk-warning' | 'account-banned'> = {
          'proxy-account-suspended': 'account-banned',
          'proxy-all-exhausted': 'risk-warning'
        }
        const targetEvent = webhookEventMap[event] || 'risk-warning'
        // 规范化 level（main 用 'error'/'info' 等字符串字面量，需要映射到 store 接受的类型）
        const rawLevel = (payload as { level?: string })?.level
        const level: 'info' | 'warn' | 'error' | 'success' =
          rawLevel === 'error'
            ? 'error'
            : rawLevel === 'info'
              ? 'info'
              : rawLevel === 'success'
                ? 'success'
                : 'warn'
        void store.triggerEvent(targetEvent, {
          title: String((payload as Record<string, unknown>).title ?? '反代告警'),
          message: String((payload as Record<string, unknown>).message ?? ''),
          level,
          fields: (payload as { fields?: Record<string, string | number> })?.fields
        })
      } catch (err) {
        console.error('[App] Proxy webhook trigger failed:', err)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [])

  // 关闭/刷新前强制 flush 防抖中的待保存数据，防止数据丢失
  useEffect(() => {
    const handleBeforeUnload = (): void => {
      void flushSaveImmediately()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      if (trayDebounceRef.current) clearTimeout(trayDebounceRef.current)
    }
  }, [flushSaveImmediately])

  // 账户/激活变化时触发托盘更新（内部防抖 + 直接从 store 读取最新数据，避免 stale closure）
  useEffect(() => {
    updateTrayInfo()
  }, [accounts, activeAccountId, updateTrayInfo])

  // 监听托盘刷新账户事件
  useEffect(() => {
    const unsubscribe = window.api.onTrayRefreshAccount(() => {
      checkAndRefreshExpiringTokens()
      updateTrayInfo()
    })
    return () => {
      unsubscribe()
    }
  }, [checkAndRefreshExpiringTokens, updateTrayInfo])

  // 监听托盘切换账户事件
  useEffect(() => {
    const unsubscribe = window.api.onTraySwitchAccount(() => {
      switchToNextAccount()
    })
    return () => {
      unsubscribe()
    }
  }, [switchToNextAccount])

  // 监听反代账号状态更新（例如请求流中发现 suspended）
  useEffect(() => {
    const unsubscribe = window.api.onProxyAccountUpdate?.((update) => {
      if (!update?.id) return
      const updates: Record<string, unknown> = {}
      if (update.accessToken || update.refreshToken || update.expiresAt) {
        const current = useAccountsStore.getState().accounts.get(update.id)
        updates.credentials = {
          ...(current?.credentials || {}),
          ...(update.accessToken ? { accessToken: update.accessToken } : {}),
          ...(update.refreshToken ? { refreshToken: update.refreshToken } : {}),
          ...(update.expiresAt ? { expiresAt: update.expiresAt } : {})
        }
      }
      if (update.suspended) {
        updates.status = 'error'
        updates.isActive = false
        updates.lastError =
          update.lastError || 'Account temporarily suspended or locked by AWS/Kiro'
        updates.lastCheckedAt = Date.now()
      }
      if (Object.keys(updates).length > 0) updateAccount(update.id, updates as any)
    })
    return () => {
      unsubscribe?.()
    }
  }, [updateAccount])

  // 监听后台刷新结果
  useEffect(() => {
    const refreshBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> =
      []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      flushTimer = null
      if (refreshBuffer.length === 0) return
      const batch = refreshBuffer.splice(0)
      batch.forEach(handleBackgroundRefreshResult)
    }

    const unsubscribe = window.api.onBackgroundRefreshResult((data) => {
      refreshBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        // 卸载前 flush 剩余结果，防止丢失
        flush()
      }
    }
  }, [handleBackgroundRefreshResult])

  // 监听后台检查结果：同样的批量化策略
  useEffect(() => {
    const checkBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      flushTimer = null
      if (checkBuffer.length === 0) return
      const batch = checkBuffer.splice(0)
      batch.forEach(handleBackgroundCheckResult)
    }

    const unsubscribe = window.api.onBackgroundCheckResult((data) => {
      checkBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flush()
      }
    }
  }, [handleBackgroundCheckResult])

  const renderPage = () => {
    switch (currentPage) {
      case 'home':
        return <HomePage />
      case 'accounts':
        return <AccountManager />
      case 'machineId':
        return <MachineIdPage />
      case 'kiroSettings':
        return <KiroSettingsPage />
      case 'proxy':
        return <ProxyPage />
      case 'kproxy':
        return <KProxyPage />
      case 'proxyPool':
        return <ProxyPoolPage />
      case 'register':
        return <RegisterPage />
      case 'subscription':
        return <SubscriptionPage />
      case 'webhooks':
        return <WebhooksPage />
      case 'diagnose':
        return <DiagnosePage />
      case 'configSync':
        return <ConfigSyncPage />
      case 'logs':
        return <LogsPage />
      case 'settings':
        return <SettingsPage />
      case 'about':
        return <AboutPage />
      default:
        return <HomePage />
    }
  }

  return (
    <div className="h-screen bg-background flex">
      <Sidebar
        currentPage={currentPage}
        onPageChange={setCurrentPage}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <main className="flex-1 overflow-auto">{renderPage()}</main>
      <UpdateDialog />
      <CloseConfirmDialog />
    </div>
  )
}

export default App
