/**
 * /v1/messages relay — supports both JSON and SSE streaming.
 */
import { Router, Request, Response } from 'express';
import {
  callUpstream,
  callUpstreamStream,
  extractUsageFromSse,
  UpstreamChannel,
} from '../services/upstream';
import { recordUsageAndBill } from '../services/billing';
import { recordUsage as recordSubscriptionUsage } from '../services/order-engine';
import { query } from '../services/database';
import { config } from '../config';
import { logger } from '../services/logger';


function modelMatchesAllowlist(model: string, allow: string[]): boolean {
  for (const pat of allow) {
    if (pat === model) return true;
    if (pat.endsWith("*")) {
      const prefix = pat.slice(0, -1);
      if (model.startsWith(prefix)) return true;
    }
  }
  return false;
}

export const relayRouter = Router();

// Subscription-aware usage recorder: subscription tokens decrement
// remaining_tokens via order-engine; legacy cents tokens go through billing.
async function recordUsageRouted(req: any, input: any): Promise<{ chargedCents?: number; remainCents?: number; remaining_tokens?: number | null }> {
  const tok = req.endToken;
  if (tok?.subscriptionId) {
    const r = await recordSubscriptionUsage({
      tenantId: input.tenantId,
      endUserId: input.endUserId,
      endTokenId: input.endTokenId,
      subscriptionId: tok.subscriptionId,
      channelId: input.channelId ?? null,
      modelName: input.modelName,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      costCents: 0,
      requestId: input.requestId ?? null,
      elapsedMs: input.elapsedMs,
      isStream: input.isStream,
      status: input.status,
    });
    return { remaining_tokens: r.remaining_tokens };
  }
  return recordUsageAndBill(input);
}


/**
 * Pick the active default channel for the tenant, falling back to env in
 * single-tenant deploys. Returns null + an error response if neither is
 * available.
 */
async function resolveChannel(
  tenantId: number,
): Promise<{ channel: UpstreamChannel | null; channelId: number | null; error?: string }> {
  const rows = await query<{ id: number; base_url: string; api_key: string }>(
    `SELECT id, base_url, api_key
       FROM upstream_channel
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY is_default DESC, weight DESC, priority ASC, id ASC
      LIMIT 1`,
    [tenantId],
  );
  if (rows.length > 0) {
    return {
      channel: { id: rows[0].id, base_url: rows[0].base_url, api_key: rows[0].api_key },
      channelId: rows[0].id,
    };
  }
  // Fallback: env (single-tenant or pre-channel deploy)
  if (config.upstreamKey && config.upstreamBaseUrl) {
    return { channel: null, channelId: null };
  }
  return {
    channel: null,
    channelId: null,
    error: 'no upstream channel configured for this tenant — admin must add one in /admin/channels',
  };
}

relayRouter.post('/messages', async (req: Request, res: Response) => {
  const start = Date.now();
  const tok = req.endToken!;
  const requestedModel = String(req.body?.model || 'claude-sonnet-4-7');

  // Allow exact match OR glob wildcard ("claude-*" / "claude-sonnet-*").
  // Plan-derived allow lists are typically wildcards; the legacy admin-issued
  // tokens use exact model names. Both flow through here.
  if (tok.allowedModels && !modelMatchesAllowlist(requestedModel, tok.allowedModels)) {
    res.status(403).json({
      error: { type: 'permission_error', message: `Model not allowed: ${requestedModel}` },
    });
    return;
  }

  const resolved = await resolveChannel(tok.tenantId);
  if (resolved.error) {
    res.status(503).json({
      error: { type: 'upstream_not_configured', message: resolved.error },
    });
    return;
  }

  const wantsStream =
    req.body?.stream === true ||
    String(req.headers['accept'] ?? '').includes('text/event-stream');

  if (wantsStream) {
    return handleStream(req, res, requestedModel, start, resolved.channel, resolved.channelId);
  }
  return handleJson(req, res, requestedModel, start, resolved.channel, resolved.channelId);
});

async function handleJson(
  req: Request,
  res: Response,
  model: string,
  start: number,
  channel: UpstreamChannel | null,
  channelId: number | null,
): Promise<void> {
  const tok = req.endToken!;
  const usr = req.endUser!;

  let upstreamJson;
  try {
    upstreamJson = await callUpstream({
      path: '/messages',
      body: req.body,
      ...(channel ? { channel } : {}),
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'relay:upstream_error');
    await recordUsageRouted(req, {
      tenantId: tok.tenantId, endUserId: usr.id, endTokenId: tok.id,
      modelName: model, promptTokens: 0, completionTokens: 0,
      requestId: null, elapsedMs: Date.now() - start, isStream: false, status: 'failure',
      channelId,
    }).catch(() => {});
    res.status(502).json({ error: { type: 'upstream_error', message: 'Upstream unavailable' } });
    return;
  }

  const promptTokens =
    upstreamJson.body?.usage?.input_tokens ??
    upstreamJson.body?.usage?.prompt_tokens ?? 0;
  const completionTokens =
    upstreamJson.body?.usage?.output_tokens ??
    upstreamJson.body?.usage?.completion_tokens ?? 0;

  const billOut = await recordUsageRouted(req, {
    tenantId: tok.tenantId, endUserId: usr.id, endTokenId: tok.id,
    modelName: model, promptTokens, completionTokens,
    requestId: upstreamJson.body?.id ?? null, elapsedMs: Date.now() - start,
    isStream: false,
    status: upstreamJson.status >= 200 && upstreamJson.status < 300 ? 'success' : 'failure',
    channelId,
  }).catch(() => null);

  if (billOut && upstreamJson.body && typeof upstreamJson.body === 'object') {
    upstreamJson.body._3api = {
      charged_cents: billOut.chargedCents,
      remain_quota_cents: billOut.remainCents,
    };
  }
  res.status(upstreamJson.status).json(upstreamJson.body);
}

async function handleStream(
  req: Request,
  res: Response,
  model: string,
  start: number,
  channel: UpstreamChannel | null,
  channelId: number | null,
): Promise<void> {
  const tok = req.endToken!;
  const usr = req.endUser!;

  let upstreamHttp: globalThis.Response;
  try {
    upstreamHttp = await callUpstreamStream({
      path: '/messages',
      body: req.body,
      ...(channel ? { channel } : {}),
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'relay:upstream_stream_error');
    res.status(502).json({ error: { type: 'upstream_error', message: 'Upstream unavailable' } });
    return;
  }

  if (upstreamHttp.status !== 200) {
    const errText = await upstreamHttp.text();
    res.status(upstreamHttp.status).type('application/json').send(errText);
    await recordUsageRouted(req, {
      tenantId: tok.tenantId, endUserId: usr.id, endTokenId: tok.id,
      modelName: model, promptTokens: 0, completionTokens: 0,
      requestId: null, elapsedMs: Date.now() - start, isStream: true, status: 'failure',
      channelId,
    }).catch(() => {});
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (!upstreamHttp.body) {
    res.end();
    return;
  }

  const reader = upstreamHttp.body.getReader();
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

  const usage = extractUsageFromSse(accumulated);
  await recordUsageRouted(req, {
    tenantId: tok.tenantId, endUserId: usr.id, endTokenId: tok.id,
    modelName: model,
    promptTokens: usage.input,
    completionTokens: usage.output,
    requestId: null,
    elapsedMs: Date.now() - start,
    isStream: true,
    status: aborted ? 'failure' : 'success',
    channelId,
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
