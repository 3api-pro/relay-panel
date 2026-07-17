import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { loadRegistry } from './registry.js';
import { allSnapshots, siteSnapshot } from './dashboard.js';

const app = Fastify({ logger: true });

// 登录闸：设了 RP_AUTH_USER/RP_AUTH_PASS 则全站要求 HTTP Basic Auth。
// 看板聚合全站营收/成本，绝不可无认证暴露公网 —— 对外部署必须设置这两个变量。
const AUTH_USER = process.env.RP_AUTH_USER ?? '';
const AUTH_PASS = process.env.RP_AUTH_PASS ?? '';
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
if (AUTH_USER && AUTH_PASS) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const hdr = req.headers.authorization ?? '';
    if (hdr.startsWith('Basic ')) {
      const [u, p] = Buffer.from(hdr.slice(6), 'base64').toString('utf8').split(':');
      if (safeEq(u ?? '', AUTH_USER) && safeEq(p ?? '', AUTH_PASS)) return;
    }
    reply.header('WWW-Authenticate', 'Basic realm="relay-panel"').code(401).send('auth required');
  });
} else {
  app.log.warn('RP_AUTH_USER/RP_AUTH_PASS unset — dashboard is UNAUTHENTICATED (bind loopback only!)');
}

const registryPath = process.env.RP_REGISTRY ?? join(process.cwd(), 'registry.json');
// UI 是静态资源，从源码树读取（tsc 不搬运非 TS 文件）
const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui');

// 简单内存缓存：快照 15s TTL，避免面板刷新连打生产站
let cache: { at: number; data: unknown } | null = null;
const TTL_MS = 15_000;

app.get('/healthz', async () => ({ ok: true, service: 'relay-panel-orchestrator' }));

app.get('/api/sites', async () => {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  const reg = await loadRegistry(registryPath);
  const data = { sites: await allSnapshots(reg), generatedAt: new Date(now).toISOString() };
  cache = { at: now, data };
  return data;
});

app.get<{ Params: { slug: string } }>('/api/sites/:slug', async (req) => {
  const reg = await loadRegistry(registryPath);
  return siteSnapshot(reg, req.params.slug);
});

app.get('/', async (_req, reply) => {
  const html = await readFile(join(uiDir, 'dashboard.html'), 'utf8');
  reply.type('text/html').send(html);
});

const port = Number(process.env.PORT ?? 7100);
app.listen({ port, host: '127.0.0.1' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
