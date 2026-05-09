/**
 * /v1/messages relay — supports both JSON and SSE streaming.
 *
 * Protocol detection:
 *   - body.stream === true       → SSE
 *   - Accept: text/event-stream  → SSE
 *   - else                       → JSON
 */
import { Router, Request, Response } from 'express';
import {
  callUpstream,
  callUpstreamStream,
  extractUsageFromSse,
} from '../services/upstream';
import { recordUsageAndBill } from '../services/billing';
import { logger } from '../services/logger';

export const relayRouter = Router();

relayRouter.post('/messages', async (req: Request, res: Response) => {
  const start = Date.now();
  const tok = req.endToken!;
  const usr = req.endUser!;
  const requestedModel = String(req.body?.model || 'claude-sonnet-4-7');

  if (tok.allowedModels && !tok.allowedModels.includes(requestedModel)) {
    res.status(403).json({
      error: { type: 'permission_error', message: `Model not allowed: ${requestedModel}` },
    });
    return;
  }

  const wantsStream =
    req.body?.stream === true ||
    String(req.headers['accept'] ?? '').includes('text/event-stream');

  if (wantsStream) {
    return handleStream(req, res, requestedModel, start);
  }
  return handleJson(req, res, requestedModel, start);
});

async function handleJson(
  req: Request,
  res: Response,
  model: string,
  start: number,
): Promise<void> {
  const tok = req.endToken!;
  const usr = req.endUser!;

  let upstreamRes;
  try {
    upstreamRes = await callUpstream({ path: '/messages', body: req.body });
  } catch (err: any) {
    logger.error({ err: err.message }, 'relay:upstream_error');
    await recordUsageAndBill({
      tenantId: tok.tenantId, endUserId: usr.id, endTokenId: tok.id,
      modelName: model, promptTokens: 0, completionTokens: 0,
      requestId: null, elapsedMs: Date.now() - start, isStream: false, status: 'failure',
    }).catch(() => {});
    res.status(502).json({ error: { type: 'upstream_error', message: 'Upstream unavailable' } });
    return;
  }

  const promptTokens =
    upstreamRes.body?.usage?.input_tokens ??
    upstreamRes.body?.usage?.prompt_tokens ?? 0;
  const completionTokens =
    upstreamRes.body?.usage?.output_tokens ??
    upstreamRes.body?.usage?.completion_tokens ?? 0;

  const billOut = await recordUsageAndBill({
    tenantId: tok.tenantId, endUserId: usr.id, endTokenId: tok.id,
    modelName: model, promptTokens, completionTokens,
    requestId: upstreamRes.body?.id ?? null, elapsedMs: Date.now() - start,
    isStream: false,
    status: upstreamRes.status >= 200 && upstreamRes.status < 300 ? 'success' : 'failure',
  }).catch(() => null);

  if (billOut && upstreamRes.body && typeof upstreamRes.body === 'object') {
    upstreamRes.body._3api = {
      charged_cents: billOut.chargedCents,
      remain_quota_cents: billOut.remainCents,
    };
  }
  res.status(upstreamRes.status).json(upstreamRes.body);
}

async function handleStream(
  req: Request,
  res: Response,
  model: string,
  start: number,
): Promise<void> {
  const tok = req.endToken!;
  const usr = req.endUser!;

  let upstreamRes: Response;
  try {
    upstreamRes = await callUpstreamStream({ path: '/messages', body: req.body });
  } catch (err: any) {
    logger.error({ err: err.message }, 'relay:upstream_stream_error');
    res.status(502).json({ error: { type: 'upstream_error', message: 'Upstream unavailable' } });
    return;
  }

  if (upstreamRes.status !== 200) {
    const errText = await upstreamRes.text();
    res.status(upstreamRes.status).type('application/json').send(errText);
    await recordUsageAndBill({
      tenantId: tok.tenantId, endUserId: usr.id, endTokenId: tok.id,
      modelName: model, promptTokens: 0, completionTokens: 0,
      requestId: null, elapsedMs: Date.now() - start, isStream: true, status: 'failure',
    }).catch(() => {});
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (!upstreamRes.body) {
    res.end();
    return;
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let aborted = false;

  req.on('close', () => {
    aborted = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      accumulated += chunk;
      if (!aborted) res.write(value);
    }
    if (!aborted) res.end();
  } catch (err: any) {
    logger.error({ err: err.message }, 'relay:stream_error');
    if (!aborted) res.end();
  }

  // Bill after stream completes
  const usage = extractUsageFromSse(accumulated);
  await recordUsageAndBill({
    tenantId: tok.tenantId, endUserId: usr.id, endTokenId: tok.id,
    modelName: model,
    promptTokens: usage.input,
    completionTokens: usage.output,
    requestId: null,
    elapsedMs: Date.now() - start,
    isStream: true,
    status: aborted ? 'failure' : 'success',
  }).catch(() => null);
}

relayRouter.get('/models', (_req: Request, res: Response) => {
  res.json({
    data: [
      { id: 'claude-sonnet-4-7', object: 'model' },
      { id: 'claude-opus-4-7',   object: 'model' },
    ],
  });
});
