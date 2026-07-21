import { z } from 'zod';

/**
 * 全部 RP_* 环境变量的单一解析来源（规格 §2）。
 * index.ts 与测试都从 loadConfig() 走，任何模块不得自行读 process.env。
 * 旧 RP_AUTH_USER/RP_AUTH_PASS Basic Auth 已移除（被 session 认证取代）。
 */

export interface PortRange {
  min: number;
  max: number;
}

/**
 * 告警邮件通知的 SMTP 出信设置（全部来自 RP_SMTP_* 环境变量）。
 * 🔴 user/pass 只在内存，绝不入 DB/日志/错误。host+port+from 齐备才算"已配置"。
 */
export interface SmtpSettings {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  /** 465 隐式 TLS；587/25 走 STARTTLS/明文（按 port===465 推断） */
  secure: boolean;
  /** 🔴 默认 false：未加密信道拒发 AUTH 凭据（防 STARTTLS-stripping）；仅内网调试可放行 */
  allowInsecureAuth?: boolean;
}

export interface Config {
  /** 监听端口 */
  port: number;
  /** 监听地址；容器部署设 0.0.0.0 */
  host: string;
  /** postgres://… | pglite:<dir> | pglite:memory */
  dbUrl: string;
  /** 主密钥：64hex 直接作 key，否则 sha256(utf8) 派生。缺失时 enc: 凭据/面板开站报错但服务可起 */
  secretKey?: string;
  /** 首启 operators 空表时自动建 root */
  adminEmail?: string;
  adminPassword?: string;
  signupMode: 'closed' | 'invite' | 'open';
  sessionTtlHours: number;
  /** 注册限速：单 IP 每小时最多注册尝试数（开放注册防羊毛党批量刷号） */
  signupMaxPerIp: number;
  /** 注册限速：单邮箱每小时最多注册尝试数 */
  signupMaxPerEmail: number;
  /** 登录限速：单 (IP,账号) 每 10 分钟最多失败次数，超限退避 429 */
  loginMaxFails: number;
  /** operator 触发的 adopt 探测统一超时（毫秒）防 slowloris 挂起；root 走引擎原超时 */
  adoptProbeTimeoutMs: number;
  sitesRoot: string;
  /** 面板开站端口池 */
  portRange: PortRange;
  dockerViaWsl: boolean;
  /** 告警监控周期；0=关闭 */
  monitorIntervalMs: number;
  /** >0 时启用 low_balance 规则 */
  balanceThreshold: number;
  /**
   * 🔴 上游渠道额度不足告警阈值（F5，USD）：>0 才启用 channel_low_balance 告警（仅对 quota 型 apikey/bedrock，
   * remaining=quotaLimit-quotaUsed < 此值即告警；window/none 零覆盖永不误报）。默认 0=告警关闭。
   */
  channelBalanceThreshold: number;
  /** 订阅宽限期天数（到期后配额仍按原计划生效的窗口）；0=关闭宽限 */
  billingGraceDays: number;
  /** 计费扫描循环周期（收敛过期状态 + 到期提醒邮件）；0=关闭该后台循环 */
  billingSweepIntervalMs: number;
  /** 经营日报开关（master default，与 app_settings['finance_report'].daily 逻辑与） */
  reportDaily: boolean;
  /** 经营周报开关（master default，与 app_settings['finance_report'].weekly 逻辑与） */
  reportWeekly: boolean;
  /**
   * 经营报告扫描循环周期；0=关闭整个报告循环（master kill switch，默认关）。
   * 🔴 默认 0：首次受控重启不自动评估阈值/发送日周报，避免对薄利站误发 margin_low/cost_spike 噪音；
   * 由 root 显式设 >0（配合 app_settings['finance_report'].daily/weekly）才启用，与 F3 风控扫描默认关对齐。
   */
  reportSweepIntervalMs: number;
  /**
   * 🔴 风控限额写回开关（F3）：默认 false（仅告警模式）。false 时只侦测+告警+出「将限额」预览，
   * 绝不调用 platform-quotas 写回；true 才允许写回（UI 动作亦受此门控）。改需受控重启生效。
   */
  riskEnforce: boolean;
  /**
   * 🔴 上游渠道快捷充值/额度重置写开关（F5）：默认 false（禁写）。false 时 reset-quota 端点直接 403，
   * 只读余额呈现不受影响；true 才允许对 kind='quota'(apikey/bedrock) 渠道调 reset-quota 清零已用计数
   * （不可逆，另受 root-only + 站点 readonly + 确认令牌=渠道名 + 仅 quota 型 多重守卫）。改需受控重启生效。
   */
  upstreamResetEnabled: boolean;
  /** 风控骤增后台扫描周期（毫秒）；0=不起自动扫描循环（默认，避免线上突现骤增告警噪音，仅按需 POST 触发）。 */
  riskScanIntervalMs: number;
  /**
   * 客户 CRM 每日快照循环周期（毫秒，F4）；0=关闭快照循环（默认关）。
   * 只做只读 GET /admin/users(翻页)+写我方 customer_snapshots，绝不触碰引擎/客户额度/余额；demo 模式不起。
   * 🔴 默认 0：首次受控重启不自动翻页拉生产 admin API/不写库，由 root 观察后显式设 >0（建议 21_600_000=6h）再开。
   */
  crmSnapshotIntervalMs: number;
  /** managed 渠道市场网关；未配置=managed 模板不可启用 */
  meteringGatewayUrl?: string;
  meteringGatewayToken?: string;
  /** 账本网关拉取周期；0=关闭 */
  ledgerPullIntervalMs: number;
  /** 未配置=域名只记 DB 不下发 */
  caddyAdminUrl?: string;
  /** SPA 构建产物目录（相对 orchestrator 包根） */
  webDist: string;
  /** 设置后 /metrics 可用 Bearer token 免 session 访问 */
  metricsToken?: string;
  /** 告警邮件出信设置；未配齐（host/port/from）时为 undefined，EmailNotifier 静默跳过 */
  smtp?: SmtpSettings;
  /** RP_DEMO==='1' 时进入演示模式：纯罐装数据、不连生产、不起容器、公开一键登录（见 src/demo/*） */
  demo: boolean;
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(7100),
  RP_HOST: z.string().default('127.0.0.1'),
  RP_DB: z.string().default('pglite:./data/orchestrator-db'),
  RP_SECRET_KEY: z.string().min(1).optional(),
  RP_ADMIN_EMAIL: z.string().email().optional(),
  RP_ADMIN_PASSWORD: z.string().min(1).optional(),
  RP_SIGNUP_MODE: z.enum(['closed', 'invite', 'open']).default('closed'),
  RP_SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
  RP_SIGNUP_MAX_PER_IP: z.coerce.number().int().min(1).default(20),
  RP_SIGNUP_MAX_PER_EMAIL: z.coerce.number().int().min(1).default(5),
  RP_LOGIN_MAX_FAILS: z.coerce.number().int().min(1).default(10),
  RP_ADOPT_PROBE_TIMEOUT_MS: z.coerce.number().int().min(500).default(6000),
  RP_SITES_ROOT: z.string().default('./data/sites'),
  RP_PORT_RANGE: z
    .string()
    .regex(/^\d{1,5}-\d{1,5}$/, '形如 18100-18999')
    .default('18100-18999'),
  RP_DOCKER_VIA_WSL: z.enum(['0', '1']).default('0'),
  RP_MONITOR_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  RP_BALANCE_THRESHOLD: z.coerce.number().min(0).default(0),
  RP_CHANNEL_BALANCE_THRESHOLD: z.coerce.number().min(0).default(0),
  RP_BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(365).default(3),
  RP_BILLING_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
  RP_REPORT_DAILY: z.enum(['0', '1']).default('1'),
  RP_REPORT_WEEKLY: z.enum(['0', '1']).default('1'),
  RP_REPORT_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  RP_RISK_ENFORCE: z.enum(['0', '1']).default('0'),
  RP_UPSTREAM_RESET_ENABLED: z.enum(['0', '1']).default('0'),
  RP_RISK_SCAN_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  RP_CRM_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  RP_METERING_GATEWAY_URL: z.string().url().optional(),
  RP_METERING_GATEWAY_TOKEN: z.string().min(1).optional(),
  RP_LEDGER_PULL_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
  RP_CADDY_ADMIN_URL: z.string().url().optional(),
  RP_WEB_DIST: z.string().default('../web/dist'),
  RP_METRICS_TOKEN: z.string().min(1).optional(),
  RP_SMTP_HOST: z.string().min(1).optional(),
  RP_SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RP_SMTP_USER: z.string().min(1).optional(),
  RP_SMTP_PASS: z.string().min(1).optional(),
  RP_SMTP_FROM: z.string().email('RP_SMTP_FROM 须为合法邮箱地址').optional(),
  RP_SMTP_ALLOW_INSECURE: z.string().optional(),
  RP_DEMO: z.enum(['0', '1']).default('0'),
});

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // 空串视为未设置（docker compose 里 `VAR=` 的常见形态）
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== '') cleaned[k] = v;
  }

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`环境变量配置无效: ${issues}`);
  }
  const e = parsed.data;

  const [minStr, maxStr] = e.RP_PORT_RANGE.split('-');
  const portRange: PortRange = { min: Number(minStr), max: Number(maxStr) };
  if (portRange.min < 1 || portRange.max > 65535 || portRange.min > portRange.max) {
    throw new Error(`RP_PORT_RANGE 无效: ${e.RP_PORT_RANGE}`);
  }

  // SMTP：host/port/from 三者齐备才算已配置；user/pass 可选（有则 AUTH LOGIN）
  const smtp: SmtpSettings | undefined =
    e.RP_SMTP_HOST !== undefined && e.RP_SMTP_PORT !== undefined && e.RP_SMTP_FROM !== undefined
      ? {
          host: e.RP_SMTP_HOST,
          port: e.RP_SMTP_PORT,
          from: e.RP_SMTP_FROM,
          secure: e.RP_SMTP_PORT === 465,
          ...(e.RP_SMTP_USER !== undefined ? { user: e.RP_SMTP_USER } : {}),
          ...(e.RP_SMTP_PASS !== undefined ? { pass: e.RP_SMTP_PASS } : {}),
          ...(e.RP_SMTP_ALLOW_INSECURE === '1' || e.RP_SMTP_ALLOW_INSECURE === 'true'
            ? { allowInsecureAuth: true }
            : {}),
        }
      : undefined;

  return {
    port: e.PORT,
    host: e.RP_HOST,
    dbUrl: e.RP_DB,
    ...(e.RP_SECRET_KEY !== undefined ? { secretKey: e.RP_SECRET_KEY } : {}),
    ...(e.RP_ADMIN_EMAIL !== undefined ? { adminEmail: e.RP_ADMIN_EMAIL } : {}),
    ...(e.RP_ADMIN_PASSWORD !== undefined ? { adminPassword: e.RP_ADMIN_PASSWORD } : {}),
    signupMode: e.RP_SIGNUP_MODE,
    sessionTtlHours: e.RP_SESSION_TTL_HOURS,
    signupMaxPerIp: e.RP_SIGNUP_MAX_PER_IP,
    signupMaxPerEmail: e.RP_SIGNUP_MAX_PER_EMAIL,
    loginMaxFails: e.RP_LOGIN_MAX_FAILS,
    adoptProbeTimeoutMs: e.RP_ADOPT_PROBE_TIMEOUT_MS,
    sitesRoot: e.RP_SITES_ROOT,
    portRange,
    dockerViaWsl: e.RP_DOCKER_VIA_WSL === '1',
    monitorIntervalMs: e.RP_MONITOR_INTERVAL_MS,
    balanceThreshold: e.RP_BALANCE_THRESHOLD,
    channelBalanceThreshold: e.RP_CHANNEL_BALANCE_THRESHOLD,
    billingGraceDays: e.RP_BILLING_GRACE_DAYS,
    billingSweepIntervalMs: e.RP_BILLING_SWEEP_INTERVAL_MS,
    reportDaily: e.RP_REPORT_DAILY === '1',
    reportWeekly: e.RP_REPORT_WEEKLY === '1',
    reportSweepIntervalMs: e.RP_REPORT_SWEEP_INTERVAL_MS,
    riskEnforce: e.RP_RISK_ENFORCE === '1',
    upstreamResetEnabled: e.RP_UPSTREAM_RESET_ENABLED === '1',
    riskScanIntervalMs: e.RP_RISK_SCAN_INTERVAL_MS,
    crmSnapshotIntervalMs: e.RP_CRM_SNAPSHOT_INTERVAL_MS,
    ...(e.RP_METERING_GATEWAY_URL !== undefined ? { meteringGatewayUrl: e.RP_METERING_GATEWAY_URL } : {}),
    ...(e.RP_METERING_GATEWAY_TOKEN !== undefined
      ? { meteringGatewayToken: e.RP_METERING_GATEWAY_TOKEN }
      : {}),
    ledgerPullIntervalMs: e.RP_LEDGER_PULL_INTERVAL_MS,
    ...(e.RP_CADDY_ADMIN_URL !== undefined ? { caddyAdminUrl: e.RP_CADDY_ADMIN_URL } : {}),
    webDist: e.RP_WEB_DIST,
    ...(e.RP_METRICS_TOKEN !== undefined ? { metricsToken: e.RP_METRICS_TOKEN } : {}),
    ...(smtp !== undefined ? { smtp } : {}),
    demo: e.RP_DEMO === '1',
  };
}
