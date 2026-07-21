import { Sub2apiAdapter } from '@relay-panel/adapter-sub2api';
import { NewapiAdapter } from '@relay-panel/adapter-newapi';
import type { EngineAdapter, EngineKind, EngineLifecycle } from '@relay-panel/adapter-core';
import { loadConfig } from './config.js';
import { makeDb, runMigrations } from './db/client.js';
import { operators } from './db/schema.js';
import { hashPassword } from './auth/passwords.js';
import { makeLifecycles } from './provision/index.js';
import { JobEngine } from './jobs/engine.js';
import { lifecycleStepSink, makeStoreCredential } from './sites/service.js';
import { startMonitor } from './alerts/engine.js';
import { EmailNotifier, FanoutNotifier, WebhookNotifier } from './alerts/notify.js';
import { startBillingSweep } from './billing/sweep.js';
import { startFinanceReports } from './finance/scheduler.js';
import { startRiskScan } from './risk/service.js';
import { startCustomerSnapshot } from './customers/snapshot.js';
import { HttpMeteringGateway } from './marketplace/gateway.js';
import { startPullLoop } from './marketplace/ledger.js';
import { buildServer, type Notifier } from './server.js';
import { makeDemoAdapters, makeDemoLifecycles, demoNotifier, seedDemo } from './demo/index.js';

/**
 * 服务入口（规格 §1）：loadConfig → makeDb+migrate → bootstrap root → 装配依赖
 * → buildServer → job worker → listen。
 * 旧 Basic Auth 与 registry.json 路径已移除（session 认证 + DB sites 取代；
 * dashboard.ts 已并入 sites/service.ts 删除，registry.ts 仅供 registryImport 使用）。
 */

const config = loadConfig();
const db = await makeDb(config.dbUrl);
const migrated = await runMigrations(db);

// bootstrap root：仅 operators 空表且设置了 RP_ADMIN_EMAIL/RP_ADMIN_PASSWORD 时生效
const anyOperator = await db.orm.select({ id: operators.id }).from(operators).limit(1);
if (anyOperator.length === 0 && config.adminEmail !== undefined && config.adminPassword !== undefined) {
  await db.orm.insert(operators).values({
    email: config.adminEmail,
    passwordHash: await hashPassword(config.adminPassword),
    role: 'root',
    status: 'active',
  });
  // 只记邮箱，绝不打印密码
  console.log(`[bootstrap] 已创建初始 root 账号: ${config.adminEmail}`);
}

const jobs = new JobEngine(db);

// ---- 演示模式装配（RP_DEMO=1）：纯罐装数据、不连生产、不起容器 ----
// 两引擎都用 DemoAdapter + NoopLifecycle，gateway=null、notifier=noop；boot 时富种子。
// 非 demo 模式（默认）走下方真实 adapter/lifecycle/网关/通知器，行为完全不变。
let adapters: Record<EngineKind, EngineAdapter>;
let lifecycles: Record<EngineKind, EngineLifecycle>;
let gateway: HttpMeteringGateway | null;
let notifier: Notifier;

if (config.demo) {
  adapters = makeDemoAdapters();
  lifecycles = makeDemoLifecycles(lifecycleStepSink);
  gateway = null;
  notifier = demoNotifier;
  await seedDemo(db);
  console.log('[DEMO MODE] 演示模式已启用：纯罐装数据、不连生产、不起容器；一键账号见 GET /api/demo');
} else {
  adapters = {
    sub2api: new Sub2apiAdapter(),
    newapi: new NewapiAdapter(),
  };

  // G1：凭据字段名原样 JSON 加密入库（credentials 表，ref='enc:<slug>'，upsert）；
  // lifecycle 步骤经 lifecycleStepSink 汇入当前 job 的 steps。
  // 生命周期 job handler 在 buildServer → registerSitesRoutes → new SitesService 时注册进 jobs，boot 即生效。
  const storeCredential = makeStoreCredential(db, config);

  lifecycles = makeLifecycles({
    sub2api: { sitesRoot: config.sitesRoot, storeCredential, onStep: lifecycleStepSink },
    newapi: { sitesRoot: config.sitesRoot, storeCredential, onStep: lifecycleStepSink },
  });

  // G3: 组合通知器 = webhook + email 扇出，两者各自现读设置、各自失败互不影响。
  //   webhook 地址存 app_settings['alert_webhook_url']；
  //   email 收件人存 app_settings['alert_email_to']，SMTP 出信凭据来自 RP_SMTP_*（config.smtp，仅内存）；
  //   任一未配置即静默跳过。
  notifier = new FanoutNotifier([
    new WebhookNotifier(db),
    new EmailNotifier(db, config.smtp ?? null),
  ]);

  // G2: 计量网关装配——RP_METERING_GATEWAY_URL 未配置时保持 null（managed 模板不可启用）
  gateway =
    config.meteringGatewayUrl !== undefined
      ? new HttpMeteringGateway(config.meteringGatewayUrl, config.meteringGatewayToken)
      : null;
}

const app = await buildServer(
  { config, db, adapters, lifecycles, gateway, jobs, notifier },
  { logger: true },
);

if (migrated.length > 0) app.log.info(`migrations applied: ${migrated.join(', ')}`);

// 崩溃恢复：起 worker 前先回收上次重启遗留的 running 僵尸任务，否则其占据 enqueue
// 去重（queued/running）导致对应 slug 一律 409、站点无法升级/启停/销毁而彻底卡死。
// 显式 await 保证在 app.listen 开始接请求前完成（start() 内部亦有兜底回收，幂等无害）。
const recovered = await jobs.reconcileOrphans();
if (recovered > 0) app.log.warn(`reconciled ${recovered} orphaned running job(s) on boot`);

jobs.start();

// G3: 告警监控。monitorIntervalMs=0 时不起轮询定时器；startMonitor 内部把 jobs.onFinish
// 挂上 job_failed 告警，故即便巡检关闭，任务失败告警仍生效
const monitor = startMonitor({ config, db, adapters, notifier, jobs }, config.monitorIntervalMs);

// G2: 账本网关拉取循环（网关已配置且周期 > 0 时启动；启动即先拉一轮）
const stopLedgerPull =
  gateway !== null && config.ledgerPullIntervalMs > 0
    ? startPullLoop(db, gateway, config.ledgerPullIntervalMs)
    : null;

// 订阅生命周期：计费扫描循环（收敛过期状态 + 到期提醒邮件）。
// billingSweepIntervalMs=0 时不起；demo 模式不起（罐装数据不发信、不收敛）。
// SMTP 未配（config.smtp 缺省）时提醒静默跳过，状态收敛仍照常执行。
const billingSweep =
  !config.demo && config.billingSweepIntervalMs > 0
    ? startBillingSweep({ config, db, smtp: config.smtp ?? null }, config.billingSweepIntervalMs)
    : null;

// F2: 经营日报/周报扫描循环（阈值预警邮件 + margin_low/cost_spike 告警扇出）。
// reportSweepIntervalMs=0 时不起（master kill switch）；demo 模式不起（罐装数据不发信）。
// SMTP 未配或无收件人时报告发信静默跳过，阈值 openAlert 仍走已配 webhook/email 扇出。
const financeReports =
  !config.demo && config.reportSweepIntervalMs > 0
    ? startFinanceReports(
        { config, db, adapters, lifecycles, jobs, notifier, smtp: config.smtp ?? null },
        config.reportSweepIntervalMs,
      )
    : null;

// F3: 风控骤增扫描。riskScanIntervalMs=0 时不起自动循环（默认，避免线上骤增告警噪音）；
// 仅 root 可 POST /api/risk/scan 按需触发或显式设正值开启。demo 模式不启用。
// 🔴 限额写回受 config.riskEnforce（RP_RISK_ENFORCE，默认 off）门控，扫描本身绝不写回引擎。
const riskScan = !config.demo ? startRiskScan({ config, db, adapters, notifier }, config.riskScanIntervalMs) : null;

// F4: 客户 CRM 每日快照循环（逐日为每站每客户落 customer_snapshots，供消费骤降/流失侦测）。
// crmSnapshotIntervalMs=0 时不起（可关闭）；demo 模式不起（罐装数据不采集）。
// 🔴 只做只读 GET /admin/users(翻页)+写我方新表，绝不触碰引擎/客户额度/余额；churn 告警默认关闭。
const customerSnapshot =
  !config.demo && config.crmSnapshotIntervalMs > 0
    ? startCustomerSnapshot({ config, db, adapters, notifier }, config.crmSnapshotIntervalMs)
    : null;

async function shutdown(): Promise<void> {
  stopLedgerPull?.();
  customerSnapshot?.stop();
  riskScan?.stop();
  financeReports?.stop();
  billingSweep?.stop();
  monitor.stop();
  jobs.stop();
  await app.close().catch(() => undefined);
  await db.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

app.listen({ port: config.port, host: config.host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
