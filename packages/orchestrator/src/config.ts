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
  sitesRoot: string;
  /** 面板开站端口池 */
  portRange: PortRange;
  dockerViaWsl: boolean;
  /** 告警监控周期；0=关闭 */
  monitorIntervalMs: number;
  /** >0 时启用 low_balance 规则 */
  balanceThreshold: number;
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
  RP_SITES_ROOT: z.string().default('./data/sites'),
  RP_PORT_RANGE: z
    .string()
    .regex(/^\d{1,5}-\d{1,5}$/, '形如 18100-18999')
    .default('18100-18999'),
  RP_DOCKER_VIA_WSL: z.enum(['0', '1']).default('0'),
  RP_MONITOR_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  RP_BALANCE_THRESHOLD: z.coerce.number().min(0).default(0),
  RP_METERING_GATEWAY_URL: z.string().url().optional(),
  RP_METERING_GATEWAY_TOKEN: z.string().min(1).optional(),
  RP_LEDGER_PULL_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
  RP_CADDY_ADMIN_URL: z.string().url().optional(),
  RP_WEB_DIST: z.string().default('../web/dist'),
  RP_METRICS_TOKEN: z.string().min(1).optional(),
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

  return {
    port: e.PORT,
    host: e.RP_HOST,
    dbUrl: e.RP_DB,
    ...(e.RP_SECRET_KEY !== undefined ? { secretKey: e.RP_SECRET_KEY } : {}),
    ...(e.RP_ADMIN_EMAIL !== undefined ? { adminEmail: e.RP_ADMIN_EMAIL } : {}),
    ...(e.RP_ADMIN_PASSWORD !== undefined ? { adminPassword: e.RP_ADMIN_PASSWORD } : {}),
    signupMode: e.RP_SIGNUP_MODE,
    sessionTtlHours: e.RP_SESSION_TTL_HOURS,
    sitesRoot: e.RP_SITES_ROOT,
    portRange,
    dockerViaWsl: e.RP_DOCKER_VIA_WSL === '1',
    monitorIntervalMs: e.RP_MONITOR_INTERVAL_MS,
    balanceThreshold: e.RP_BALANCE_THRESHOLD,
    ...(e.RP_METERING_GATEWAY_URL !== undefined ? { meteringGatewayUrl: e.RP_METERING_GATEWAY_URL } : {}),
    ...(e.RP_METERING_GATEWAY_TOKEN !== undefined
      ? { meteringGatewayToken: e.RP_METERING_GATEWAY_TOKEN }
      : {}),
    ledgerPullIntervalMs: e.RP_LEDGER_PULL_INTERVAL_MS,
    ...(e.RP_CADDY_ADMIN_URL !== undefined ? { caddyAdminUrl: e.RP_CADDY_ADMIN_URL } : {}),
    webDist: e.RP_WEB_DIST,
    ...(e.RP_METRICS_TOKEN !== undefined ? { metricsToken: e.RP_METRICS_TOKEN } : {}),
    demo: e.RP_DEMO === '1',
  };
}
