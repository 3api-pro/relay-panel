export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:8080',
  nodeEnv: process.env.NODE_ENV || 'development',

  databaseType: (process.env.DATABASE_TYPE as 'sqlite' | 'postgres') || 'sqlite',
  databaseUrl: process.env.DATABASE_URL || './data/3api.db',

  tenantMode: (process.env.TENANT_MODE as 'single' | 'multi') || 'single',
  saasDomain: process.env.SAAS_DOMAIN, // only when tenantMode=multi

  upstreamBaseUrl:
    process.env.UPSTREAM_BASE_URL || 'https://api.llmapi.pro/wholesale/v1',
  upstreamKey: process.env.UPSTREAM_KEY || '',

  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  adminDefaultPassword: process.env.ADMIN_DEFAULT_PASSWORD || 'admin',

  logLevel: process.env.LOG_LEVEL || 'info',
  autoUpdate: process.env.AUTO_UPDATE !== 'off',
} as const;
