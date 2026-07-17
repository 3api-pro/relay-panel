import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { loadRegistry } from './registry.js';
import { allSnapshots, siteSnapshot } from './dashboard.js';

const app = Fastify({ logger: true });

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
