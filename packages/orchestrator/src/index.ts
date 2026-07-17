import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/healthz', async () => ({ ok: true, service: 'relay-panel-orchestrator' }));

const port = Number(process.env.PORT ?? 7100);
app.listen({ port, host: '127.0.0.1' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
