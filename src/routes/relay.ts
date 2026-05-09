/**
 * /v1/messages relay — accepts customer requests, proxies to upstream,
 * meters usage, deducts quota.
 *
 * MVP scope (v0.1.0-alpha):
 *  - Non-streaming JSON only (SSE/streaming TODO in v0.2)
 *  - Single default channel (UPSTREAM_BASE_URL/KEY from env)
 *  - Anthropic-compatible /v1/messages format
 */
import { Router, Request, Response } from 'express';
import { callUpstream } from '../services/upstream';
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

  let upstreamRes;
  try {
    upstreamRes = await callUpstream({
      path: '/messages',
      body: req.body,
    });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId: tok.tenantId }, 'relay:upstream_error');

    await recordUsageAndBill({
      tenantId: tok.tenantId,
      endUserId: usr.id,
      endTokenId: tok.id,
      modelName: requestedModel,
      promptTokens: 0,
      completionTokens: 0,
      requestId: null,
      elapsedMs: Date.now() - start,
      isStream: false,
      status: 'failure',
    }).catch(() => {});

    res
      .status(502)
      .json({ error: { type: 'upstream_error', message: 'Upstream unavailable' } });
    return;
  }

  const promptTokens =
    upstreamRes.body?.usage?.input_tokens ??
    upstreamRes.body?.usage?.prompt_tokens ??
    0;
  const completionTokens =
    upstreamRes.body?.usage?.output_tokens ??
    upstreamRes.body?.usage?.completion_tokens ??
    0;

  const billOut = await recordUsageAndBill({
    tenantId: tok.tenantId,
    endUserId: usr.id,
    endTokenId: tok.id,
    modelName: requestedModel,
    promptTokens,
    completionTokens,
    requestId: upstreamRes.body?.id ?? null,
    elapsedMs: Date.now() - start,
    isStream: false,
    status: upstreamRes.status >= 200 && upstreamRes.status < 300 ? 'success' : 'failure',
  }).catch((err: any) => {
    logger.error({ err: err.message }, 'relay:billing_failed');
    return null;
  });

  // Pass-through response, but enrich usage block
  if (billOut && upstreamRes.body && typeof upstreamRes.body === 'object') {
    upstreamRes.body._3api = {
      charged_cents: billOut.chargedCents,
      remain_quota_cents: billOut.remainCents,
    };
  }

  res.status(upstreamRes.status).json(upstreamRes.body);
});

relayRouter.get('/models', (_req: Request, res: Response) => {
  res.json({
    data: [
      { id: 'claude-sonnet-4-7', object: 'model' },
      { id: 'claude-opus-4-7', object: 'model' },
    ],
  });
});
