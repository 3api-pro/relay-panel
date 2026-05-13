export const config = {
  port: parseInt(process.env.PORT || "8080", 10),
  publicUrl: process.env.PUBLIC_URL || "http://localhost:8080",
  // Used in email links + payment redirects. Falls back to publicUrl.
  publicBaseUrl:
    process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || "http://localhost:8080",
  nodeEnv: process.env.NODE_ENV || "development",

  databaseType: (process.env.DATABASE_TYPE as "sqlite" | "postgres") || "sqlite",
  databaseUrl: process.env.DATABASE_URL || "./data/3api.db",

  tenantMode: (process.env.TENANT_MODE as "single" | "multi") || "single",
  saasDomain: process.env.SAAS_DOMAIN, // only when tenantMode=multi

  // Corrected default — llmapi.pro mounts wholesale under /v1/wholesale,
  // not /wholesale/v1. wholesale-sync.ts falls back to the legacy path if
  // the canonical one 404s, so existing operators don't break on upgrade.
  upstreamBaseUrl:
    process.env.UPSTREAM_BASE_URL || "https://api.llmapi.pro/v1/wholesale",
  upstreamKey: process.env.UPSTREAM_KEY || "",

  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  adminDefaultPassword: process.env.ADMIN_DEFAULT_PASSWORD || "admin",

  /**
   * Static secret guarding the platform tenant-provisioning routes
   * (POST /platform/tenants). When unset, those routes return 503 —
   * they are only reachable when explicitly enabled via PLATFORM_TOKEN env.
   */
  platformToken: process.env.PLATFORM_TOKEN || "",

  // ------- Payments -------
  alipayGateway:
    process.env.ALIPAY_GATEWAY ||
    "https://openapi.alipay.com/gateway.do", // sandbox: https://openapi.alipaydev.com/gateway.do
  // Per-tenant Alipay app credentials live in tenant.config.payment_config
  // (app_id, app_private_key, alipay_public_key). These env keys are only
  // fallbacks for single-tenant self-host.
  alipayAppIdFallback: process.env.ALIPAY_APP_ID || "",
  alipayPrivateKeyFallback: process.env.ALIPAY_PRIVATE_KEY || "",
  alipayPublicKeyFallback: process.env.ALIPAY_PUBLIC_KEY || "",

  // ------- USDT -------
  tronGridApi: process.env.TRONGRID_API || "https://api.trongrid.io",
  tronGridApiKey: process.env.TRONGRID_API_KEY || "",
  etherscanApi: process.env.ETHERSCAN_API || "https://api.etherscan.io/api",
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || "",
  usdtErc20Contract:
    process.env.USDT_ERC20_CONTRACT ||
    "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  usdtTrc20Contract:
    process.env.USDT_TRC20_CONTRACT ||
    "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  // Address + ttl per tenant in tenant.config.payment_config. Fallbacks below.
  usdtTrc20AddressFallback: process.env.USDT_TRC20_ADDRESS || "",
  usdtErc20AddressFallback: process.env.USDT_ERC20_ADDRESS || "",
  usdtCnyRate: parseFloat(process.env.USDT_CNY_RATE || "7.2"), // 1 USDT = ?¥
  usdtPaymentTtlMinutes: parseInt(
    process.env.USDT_PAYMENT_TTL_MINUTES || "30",
    10,
  ),

  // ------- Resend email -------
  resendApiKey: process.env.RESEND_API_KEY || "",
  emailDefaultFrom:
    process.env.EMAIL_DEFAULT_FROM || "noreply@3api.pro",

  // ------- Background jobs (per-process) -------
  // Disable via env in tests.
  usdtWatcherEnabled:
    (process.env.USDT_WATCHER_ENABLED || "on").toLowerCase() === "on",
  emailCronEnabled:
    (process.env.EMAIL_CRON_ENABLED || "on").toLowerCase() === "on",


  logLevel: process.env.LOG_LEVEL || "info",
  autoUpdate: process.env.AUTO_UPDATE !== "off",
} as const;
