import { randomFullName } from './browser-identity'

export interface RegistrationConfig {
  // AWS
  oidcBase: string
  signinBase: string
  profileBase: string
  viewBase: string
  portalBase: string
  directoryId: string
  startURL: string

  // 默认值
  password: string
  fullName: string

  // 运行时
  proxy: string

  // MoEmail 配置
  moEmailBaseURL: string
  moEmailAPIKey: string

  // Outlook 模式
  useOutlook: boolean
  outlookData: string

  // TempMail.Plus + 自建域名
  useTempMailPlus: boolean
  tempMailPlusEmail: string  // tempmail.plus 用户名（不含 @mailto.plus）
  tempMailPlusEpin: string
  tempMailPlusDomain: string // 自建域名

  // DuckDuckGo Email Protection + Gmail IMAP
  useDDG: boolean
  ddgAuthToken: string       // DDG account Bearer token
  ddgGmailEmail: string      // Gmail address that receives DDG-forwarded mail
  ddgGmailAppPassword: string // Gmail app password (preferred over OAuth2)
  ddgGmailAccessToken: string // Gmail OAuth2 access token (alternative)

  // 手动模式
  manualMode: boolean
}

export function genPassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const digits = '0123456789'
  const special = '!@#$%^&*'

  let pw = ''
  for (let i = 0; i < 3; i++) pw += upper[Math.floor(Math.random() * upper.length)]
  for (let i = 0; i < 6; i++) pw += lower[Math.floor(Math.random() * lower.length)]
  for (let i = 0; i < 3; i++) pw += digits[Math.floor(Math.random() * digits.length)]
  for (let i = 0; i < 2; i++) pw += special[Math.floor(Math.random() * special.length)]

  const arr = pw.split('')
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.join('')
}

export function newConfig(overrides?: Partial<RegistrationConfig>): RegistrationConfig {
  return {
    oidcBase: 'https://oidc.us-east-1.amazonaws.com',
    signinBase: 'https://us-east-1.signin.aws',
    profileBase: 'https://profile.aws.amazon.com',
    viewBase: 'https://view.awsapps.com',
    portalBase: 'https://portal.sso.us-east-1.amazonaws.com',
    directoryId: 'd-9067642ac7',
    startURL: 'https://view.awsapps.com/start',
    password: genPassword(),
    fullName: randomFullName(),
    proxy: '',
    moEmailBaseURL: '',
    moEmailAPIKey: '',
    useOutlook: false,
    outlookData: '',
    useTempMailPlus: false,
    tempMailPlusEmail: '',
    tempMailPlusEpin: '',
    tempMailPlusDomain: '',
    useDDG: false,
    ddgAuthToken: '',
    ddgGmailEmail: '',
    ddgGmailAppPassword: '',
    ddgGmailAccessToken: '',
    manualMode: false,
    ...overrides
  }
}
