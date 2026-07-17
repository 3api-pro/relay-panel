import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  alerts,
  appSettings,
  channelGrants,
  channelTemplates,
  invites,
  jobs,
  operators,
  sites,
  subscriptions,
  usageLedger,
} from '../db/schema.js';
import { hashPassword } from '../auth/passwords.js';
import { toPgTimestamp } from '../auth/sessions.js';

/**
 * 演示模式富种子（幂等）。全部中性演示名，绝无任何真实品牌/站名/上游供应商。
 * 时间戳以当前时间往前铺（普通 node 运行，Date 可用）。
 *
 * 安全：这里只写 demo DB（建议 pglite:memory，重启即净）。唯一“可回显”的凭据是
 * 演示 root 账号密码（沙箱罐装，见 DEMO_EMAIL/DEMO_PASSWORD），其余账号无口令。
 */

/** 演示一键登录账号（纯沙箱罐装，可对外回显） */
export const DEMO_EMAIL = 'demo@relay-panel.example';
export const DEMO_PASSWORD = 'demo-panel-2026';
export const DEMO_NOTE = '只读演示环境，数据随机生成、随时重置，请勿录入真实信息。';

const SEEDED_MARKER = 'demo_seeded';

const DAY_MS = 86_400_000;
function daysAgo(n: number): string {
  return toPgTimestamp(new Date(Date.now() - n * DAY_MS));
}
/** 第 n 个月的 1 号(UTC) */
function monthStart(offset: number): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}

/**
 * 幂等富种子：已种过（app_settings['demo_seeded']）则直接返回。
 */
export async function seedDemo(db: Db): Promise<void> {
  const existing = await db.orm
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, SEEDED_MARKER))
    .limit(1);
  if (existing.length > 0) return;

  // ---- operators：5 个（root + operator + viewer 混合） ----
  const demoHash = await hashPassword(DEMO_PASSWORD);
  const opRows = await db.orm
    .insert(operators)
    .values([
      { email: DEMO_EMAIL, displayName: '演示管理员', passwordHash: demoHash, role: 'root', status: 'active' },
      { email: 'olivia@demo-op.example', displayName: 'Olivia（站长）', role: 'operator', status: 'active' },
      { email: 'marcus@demo-op.example', displayName: 'Marcus（站长）', role: 'operator', status: 'active' },
      { email: 'nadia@demo-op.example', displayName: 'Nadia（站长）', role: 'operator', status: 'active' },
      { email: 'auditor@demo-op.example', displayName: '只读审计', role: 'viewer', status: 'active' },
    ])
    .returning({ id: operators.id, email: operators.email });
  const opId = (email: string): number => opRows.find((o) => o.email === email)!.id;
  const root = opId(DEMO_EMAIL);
  const olivia = opId('olivia@demo-op.example');
  const marcus = opId('marcus@demo-op.example');
  const nadia = opId('nadia@demo-op.example');

  // ---- sites：5 个 active（sub2api/newapi 混合，归属不同 operator） ----
  const siteDefs = [
    { slug: 'acme-relay', label: 'Acme 中转', engine: 'sub2api', version: '0.1.160', hostPort: 18101, operatorId: olivia },
    { slug: 'globex-api', label: 'Globex API', engine: 'newapi', version: 'v0.6.11', hostPort: 18102, operatorId: olivia },
    { slug: 'initech-gw', label: 'Initech 网关', engine: 'sub2api', version: '0.1.158', hostPort: 18103, operatorId: marcus },
    { slug: 'umbrella-hub', label: 'Umbrella Hub', engine: 'newapi', version: 'v0.6.10', hostPort: 18104, operatorId: nadia },
    { slug: 'wayne-relay', label: 'Wayne 中转', engine: 'sub2api', version: '0.1.160', hostPort: 18105, operatorId: nadia },
  ];
  const siteRows = await db.orm
    .insert(sites)
    .values(
      siteDefs.map((s, i) => ({
        operatorId: s.operatorId,
        slug: s.slug,
        label: s.label,
        engine: s.engine,
        version: s.version,
        domains: [`${s.slug}.demo.example`],
        hostPort: s.hostPort,
        baseUrl: `http://demo.invalid/${s.slug}`,
        status: 'active',
        managed: 'compose',
        credentialRef: `demo:${s.slug}`,
        createdAt: daysAgo(90 - i * 3),
        updatedAt: daysAgo(i),
      })),
    )
    .returning({ id: sites.id, slug: sites.slug });
  const siteId = (slug: string): number => siteRows.find((s) => s.slug === slug)!.id;

  // ---- channel_templates：6 个（byo + managed 混） ----
  const tplRows = await db.orm
    .insert(channelTemplates)
    .values([
      { key: 'claude-byo', title: 'Claude（自带 Key）', description: 'Anthropic 协议，自备上游密钥', protocol: 'anthropic', models: ['claude-sonnet', 'claude-opus'], suggestedRatio: 2.0, source: 'byo', enabled: true },
      { key: 'openai-byo', title: 'OpenAI（自带 Key）', description: 'OpenAI 协议，自备上游密钥', protocol: 'openai', models: ['gpt-omni', 'gpt-mini'], suggestedRatio: 1.5, source: 'byo', enabled: true },
      { key: 'gpt-managed', title: 'GPT 托管渠道', description: '平台托管计量，按量结算', protocol: 'openai-responses', models: ['gpt-omni'], suggestedRatio: 1.8, source: 'managed', enabled: true },
      { key: 'gemini-byo', title: 'Gemini（自带 Key）', description: 'Gemini 协议，自备上游密钥', protocol: 'gemini', models: ['gemini-pro', 'gemini-pro-vision'], suggestedRatio: 1.2, source: 'byo', enabled: true },
      { key: 'llama-managed', title: 'Llama 托管渠道', description: '开源大模型托管计量', protocol: 'openai', models: ['llama-70b'], suggestedRatio: 0.8, source: 'managed', enabled: true },
      { key: 'mistral-byo', title: 'Mistral（自带 Key）', description: 'Mistral 协议，自备上游密钥', protocol: 'openai', models: ['mistral-large'], suggestedRatio: 1.0, source: 'byo', enabled: true },
    ])
    .returning({ id: channelTemplates.id, key: channelTemplates.key });
  const tplId = (key: string): number => tplRows.find((t) => t.key === key)!.id;

  // ---- channel_grants：4 个（挂到站上，engineChannelId 假串） ----
  const grantRows = await db.orm
    .insert(channelGrants)
    .values([
      { siteId: siteId('acme-relay'), templateId: tplId('claude-byo'), engineChannelId: 'demo-ch-1001', channelName: 'Claude 主力', status: 'active', createdBy: DEMO_EMAIL, createdAt: daysAgo(80) },
      { siteId: siteId('acme-relay'), templateId: tplId('gpt-managed'), engineChannelId: 'demo-ch-1002', channelName: 'GPT 托管', meterKeyRef: 'demo-meter-1', status: 'active', createdBy: DEMO_EMAIL, createdAt: daysAgo(78) },
      { siteId: siteId('initech-gw'), templateId: tplId('gemini-byo'), engineChannelId: 'demo-ch-2001', channelName: 'Gemini 视觉', status: 'active', createdBy: DEMO_EMAIL, createdAt: daysAgo(60) },
      { siteId: siteId('wayne-relay'), templateId: tplId('llama-managed'), engineChannelId: 'demo-ch-3001', channelName: 'Llama 托管', meterKeyRef: 'demo-meter-2', status: 'active', createdBy: DEMO_EMAIL, createdAt: daysAgo(45) },
    ])
    .returning({ id: channelGrants.id, engineChannelId: channelGrants.engineChannelId });
  const grantId = (ch: string): number => grantRows.find((g) => g.engineChannelId === ch)!.id;

  // ---- usage_ledger：跨最近 3 个月，每 grant 每月一行，billed > upstream（正毛利） ----
  const ledgerValues: (typeof usageLedger.$inferInsert)[] = [];
  const grantScale: Record<string, number> = {
    'demo-ch-1001': 1.0,
    'demo-ch-1002': 0.7,
    'demo-ch-2001': 0.5,
    'demo-ch-3001': 0.9,
  };
  for (const [ch, scale] of Object.entries(grantScale)) {
    const gid = grantId(ch);
    for (let m = -2; m <= 0; m++) {
      const start = monthStart(m);
      const end = monthStart(m + 1);
      const monthIdx = 2 + m; // 0,1,2 越近越大
      const requests = Math.round((12000 + monthIdx * 4000) * scale);
      const promptTokens = requests * 1200;
      const completionTokens = requests * 600;
      const upstreamCost = Math.round(requests * 0.012 * 100) / 100;
      const billedCost = Math.round(upstreamCost * 1.6 * 100) / 100; // 60% 毛利
      ledgerValues.push({
        grantId: gid,
        periodStart: toPgTimestamp(start),
        periodEnd: toPgTimestamp(end),
        requests,
        promptTokens,
        completionTokens,
        upstreamCost,
        billedCost,
        source: 'gateway',
      });
    }
  }
  await db.orm.insert(usageLedger).values(ledgerValues);

  // ---- jobs：历史 6-8 条（succeeded 的 provision/upgrade/start + 1 条 running） ----
  const doneStep = (step: string, at: string) => [
    { step, status: 'start', at },
    { step, status: 'ok', at },
  ];
  await db.orm.insert(jobs).values([
    { kind: 'provision', siteId: siteId('acme-relay'), slug: 'acme-relay', status: 'succeeded', createdBy: DEMO_EMAIL, steps: doneStep('provision', daysAgo(90)), createdAt: daysAgo(90), startedAt: daysAgo(90), finishedAt: daysAgo(90) },
    { kind: 'provision', siteId: siteId('globex-api'), slug: 'globex-api', status: 'succeeded', createdBy: DEMO_EMAIL, steps: doneStep('provision', daysAgo(75)), createdAt: daysAgo(75), startedAt: daysAgo(75), finishedAt: daysAgo(75) },
    { kind: 'provision', siteId: siteId('initech-gw'), slug: 'initech-gw', status: 'succeeded', createdBy: DEMO_EMAIL, steps: doneStep('provision', daysAgo(60)), createdAt: daysAgo(60), startedAt: daysAgo(60), finishedAt: daysAgo(60) },
    { kind: 'upgrade', siteId: siteId('acme-relay'), slug: 'acme-relay', payload: { toVersion: '0.1.160' }, status: 'succeeded', createdBy: DEMO_EMAIL, steps: doneStep('upgrade', daysAgo(10)), createdAt: daysAgo(10), startedAt: daysAgo(10), finishedAt: daysAgo(10) },
    { kind: 'start', siteId: siteId('umbrella-hub'), slug: 'umbrella-hub', status: 'succeeded', createdBy: DEMO_EMAIL, steps: doneStep('start', daysAgo(5)), createdAt: daysAgo(5), startedAt: daysAgo(5), finishedAt: daysAgo(5) },
    { kind: 'upgrade', siteId: siteId('wayne-relay'), slug: 'wayne-relay', payload: { toVersion: '0.1.160' }, status: 'succeeded', createdBy: DEMO_EMAIL, steps: doneStep('upgrade', daysAgo(2)), createdAt: daysAgo(2), startedAt: daysAgo(2), finishedAt: daysAgo(2) },
    { kind: 'upgrade', siteId: siteId('globex-api'), slug: 'globex-api', payload: { toVersion: 'v0.6.11' }, status: 'running', createdBy: DEMO_EMAIL, steps: [{ step: '拉取镜像', status: 'start', at: daysAgo(0) }], createdAt: daysAgo(0), startedAt: daysAgo(0) },
  ]);

  // ---- alerts：2 open + 3 resolved（不同 severity/kind） ----
  await db.orm.insert(alerts).values([
    { kind: 'low_balance', siteId: siteId('initech-gw'), severity: 'warning', title: '余额偏低', detail: '演示：站点余额低于阈值', status: 'open', firstSeenAt: daysAgo(3), lastSeenAt: daysAgo(0) },
    { kind: 'channel_disabled', siteId: siteId('wayne-relay'), severity: 'info', title: '渠道被停用', detail: '演示：某备用渠道已停用', status: 'open', firstSeenAt: daysAgo(1), lastSeenAt: daysAgo(0) },
    { kind: 'site_down', siteId: siteId('acme-relay'), severity: 'critical', title: '站点曾不可达', detail: '演示：短暂不可达已恢复', status: 'resolved', firstSeenAt: daysAgo(20), lastSeenAt: daysAgo(20), resolvedAt: daysAgo(20) },
    { kind: 'job_failed', siteId: siteId('globex-api'), severity: 'warning', title: '任务曾失败', detail: '演示：一次升级重试后成功', status: 'resolved', firstSeenAt: daysAgo(15), lastSeenAt: daysAgo(15), resolvedAt: daysAgo(14) },
    { kind: 'low_balance', siteId: siteId('umbrella-hub'), severity: 'info', title: '余额提醒（已处理）', detail: '演示：已充值恢复', status: 'resolved', firstSeenAt: daysAgo(8), lastSeenAt: daysAgo(8), resolvedAt: daysAgo(7) },
  ]);

  // ---- subscriptions：给 2-3 个 operator 挂 pro/scale ----
  const periodEnd = (days: number): string => toPgTimestamp(new Date(Date.now() + days * DAY_MS));
  await db.orm.insert(subscriptions).values([
    { operatorId: olivia, planKey: 'scale', status: 'active', currentPeriodEnd: periodEnd(60), createdAt: daysAgo(30) },
    { operatorId: marcus, planKey: 'pro', status: 'active', currentPeriodEnd: periodEnd(20), createdAt: daysAgo(45) },
    { operatorId: nadia, planKey: 'pro', status: 'active', currentPeriodEnd: periodEnd(40), createdAt: daysAgo(15) },
  ]);

  // ---- invites：2 条 pending ----
  await db.orm.insert(invites).values([
    { token: 'demo000invite0001aaaa', role: 'operator', note: '演示邀请（站长）', createdBy: DEMO_EMAIL, expiresAt: periodEnd(7) },
    { token: 'demo000invite0002bbbb', role: 'viewer', note: '演示邀请（只读）', createdBy: DEMO_EMAIL, expiresAt: periodEnd(7) },
  ]);

  // ---- 标记已种（幂等） ----
  await db.orm
    .insert(appSettings)
    .values({ key: SEEDED_MARKER, value: { at: new Date().toISOString() } })
    .onConflictDoNothing();
}
