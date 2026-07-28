import { describe, expect, it } from 'vitest';
import {
  NEWAPI_PLACEHOLDER_LIMIT,
  parseNewApiBillingUsageResponse,
  parseNewApiBillingWalletResponses,
  parseSub2ApiUsageResponse,
  type RawWalletResponse,
} from '../src/upstream/wallet-response.js';

function json(body: unknown, contentType = 'application/json; charset=utf-8'): RawWalletResponse {
  return { contentType, body: JSON.stringify(body) };
}

function subscription(hardLimit = 100): RawWalletResponse {
  return json({
    object: 'billing_subscription',
    has_payment_method: true,
    soft_limit_usd: hardLimit,
    hard_limit_usd: hardLimit,
    system_hard_limit_usd: hardLimit,
    access_until: 0,
  });
}

function usage(totalUsage = 1_250): RawWalletResponse {
  return json({ object: 'list', total_usage: totalUsage });
}

describe('parseSub2ApiUsageResponse', () => {
  it('strictly parses a wallet response and sums explicit daily costs', () => {
    const result = parseSub2ApiUsageResponse(json({
      mode: 'unrestricted',
      isValid: true,
      balance: 42.5,
      unit: 'USD',
      daily_usage: [
        { date: '2026-07-27', requests: 2, input_tokens: 10, cost: 0.75, actual_cost: 0.5 },
        { date: '2026-07-28', requests: 1, cache_tokens: 3, cost: 1.25, actual_cost: 1 },
      ],
      model_stats: [],
    }));

    expect(result).toEqual({
      status: 'ok',
      protocol: 'sub2api',
      balance: 42.5,
      usage: 2,
      coverage: 'full',
    });
  });

  it('keeps missing usage as partial coverage instead of inventing zero', () => {
    expect(parseSub2ApiUsageResponse(json({
      mode: 'unrestricted',
      isValid: true,
      balance: -2.5,
    }))).toEqual({
      status: 'partial',
      protocol: 'sub2api',
      balance: -2.5,
      usage: null,
      coverage: 'balance_only',
    });
  });

  it('accepts an explicit empty daily array as exact zero usage', () => {
    expect(parseSub2ApiUsageResponse(json({
      mode: 'unrestricted',
      isValid: true,
      balance: 5,
      daily_usage: [],
    }))).toMatchObject({ status: 'ok', usage: 0, coverage: 'full' });
  });

  it('rejects HTML and JSON-looking bodies with a non-JSON content type', () => {
    expect(parseSub2ApiUsageResponse({ contentType: 'text/html', body: '<!doctype html>' }))
      .toEqual({
        status: 'invalid_content_type',
        protocol: null,
        balance: null,
        usage: null,
        coverage: 'none',
      });
    expect(parseSub2ApiUsageResponse({
      contentType: 'text/plain',
      body: '{"mode":"unrestricted","isValid":true,"balance":9}',
    }).status).toBe('invalid_content_type');
  });

  it('rejects malformed JSON, HTML mislabeled as JSON, and NaN syntax', () => {
    for (const body of ['{', '<html></html>', '{"balance":NaN}']) {
      expect(parseSub2ApiUsageResponse({ contentType: 'application/json', body }).status)
        .toBe('invalid_json');
    }
  });

  it('requires the Sub2API signature and strict daily usage item schema', () => {
    expect(parseSub2ApiUsageResponse(json({ balance: 9, daily_usage: [] })).status)
      .toBe('schema_mismatch');
    expect(parseSub2ApiUsageResponse(json({
      mode: 'unrestricted',
      isValid: true,
      balance: 9,
      daily_usage: [{ date: '2026-02-30', cost: 1 }],
    })).status).toBe('schema_mismatch');
    expect(parseSub2ApiUsageResponse(json({
      mode: 'unrestricted',
      isValid: true,
      balance: 9,
      daily_usage: [{ date: '2026-07-28', cost: '1' }],
    })).status).toBe('schema_mismatch');
  });

  it('rejects non-finite and negative usage numbers without returning partial values', () => {
    const infiniteBalance = {
      contentType: 'application/json',
      body: '{"mode":"unrestricted","isValid":true,"balance":1e309,"daily_usage":[]}',
    };
    expect(parseSub2ApiUsageResponse(infiniteBalance)).toMatchObject({
      status: 'invalid_number',
      protocol: 'sub2api',
      balance: null,
      usage: null,
      coverage: 'none',
    });
    expect(parseSub2ApiUsageResponse(json({
      mode: 'unrestricted',
      isValid: true,
      balance: 9,
      daily_usage: [{ date: '2026-07-28', cost: -1 }],
    }))).toMatchObject({ status: 'invalid_number', coverage: 'none' });
  });
});

describe('parseNewApiBillingUsageResponse', () => {
  it('requires the NewAPI object marker and converts hundredths to display units', () => {
    expect(parseNewApiBillingUsageResponse(usage())).toEqual({
      status: 'ok',
      protocol: 'newapi',
      balance: null,
      usage: 12.5,
      coverage: 'usage_only',
    });
    expect(parseNewApiBillingUsageResponse(json({ total_usage: 100 })).status)
      .toBe('schema_mismatch');
    expect(parseNewApiBillingUsageResponse(json({ object: 'error', total_usage: 100 })).status)
      .toBe('schema_mismatch');
  });

  it('rejects negative, string, and non-finite total_usage', () => {
    expect(parseNewApiBillingUsageResponse(json({ object: 'list', total_usage: -1 })).status)
      .toBe('invalid_number');
    expect(parseNewApiBillingUsageResponse(json({ object: 'list', total_usage: '100' })).status)
      .toBe('schema_mismatch');
    expect(parseNewApiBillingUsageResponse({
      contentType: 'application/json',
      body: '{"object":"list","total_usage":1e309}',
    }).status).toBe('invalid_number');
  });
});

describe('parseNewApiBillingWalletResponses', () => {
  it('strictly combines total limit and lifetime usage into wallet balance', () => {
    expect(parseNewApiBillingWalletResponses({
      subscription: subscription(100),
      lifetimeUsage: usage(1_250),
    })).toEqual({
      status: 'ok',
      protocol: 'newapi',
      balance: 87.5,
      usage: 12.5,
      coverage: 'full',
    });
  });

  it('preserves a legitimate negative computed balance', () => {
    expect(parseNewApiBillingWalletResponses({
      subscription: subscription(10),
      lifetimeUsage: usage(1_250),
    })).toMatchObject({ status: 'ok', balance: -2.5, coverage: 'full' });
  });

  it('rejects the 1e8 placeholder while retaining separately valid usage', () => {
    expect(parseNewApiBillingWalletResponses({
      subscription: subscription(NEWAPI_PLACEHOLDER_LIMIT),
      lifetimeUsage: usage(1_250),
    })).toEqual({
      status: 'placeholder_limit',
      protocol: 'newapi',
      balance: null,
      usage: 12.5,
      coverage: 'usage_only',
    });
  });

  it('accepts a finite limit below the placeholder threshold', () => {
    expect(parseNewApiBillingWalletResponses({
      subscription: subscription(NEWAPI_PLACEHOLDER_LIMIT - 1),
      lifetimeUsage: usage(100),
    })).toMatchObject({
      status: 'ok',
      balance: NEWAPI_PLACEHOLDER_LIMIT - 2,
      usage: 1,
      coverage: 'full',
    });
  });

  it('does not mistake a 200 HTML SPA fallback for NewAPI', () => {
    const html: RawWalletResponse = { contentType: 'text/html; charset=utf-8', body: '<!doctype html>' };
    expect(parseNewApiBillingWalletResponses({ subscription: html, lifetimeUsage: html })).toEqual({
      status: 'invalid_content_type',
      protocol: null,
      balance: null,
      usage: null,
      coverage: 'none',
    });
  });

  it('can report valid usage-only coverage when subscription schema is unavailable', () => {
    expect(parseNewApiBillingWalletResponses({
      subscription: { contentType: 'text/html', body: '<html></html>' },
      lifetimeUsage: usage(250),
    })).toEqual({
      status: 'invalid_content_type',
      protocol: 'newapi',
      balance: null,
      usage: 2.5,
      coverage: 'usage_only',
    });
  });

  it('requires the full subscription schema and rejects HTTP-200 error envelopes', () => {
    const missingFields = json({ object: 'billing_subscription', hard_limit_usd: 100 });
    const errorEnvelope = json({ error: { type: 'new_api_error' } });
    expect(parseNewApiBillingWalletResponses({
      subscription: missingFields,
      lifetimeUsage: usage(),
    }).status).toBe('schema_mismatch');
    expect(parseNewApiBillingWalletResponses({
      subscription: errorEnvelope,
      lifetimeUsage: errorEnvelope,
    })).toMatchObject({ status: 'schema_mismatch', protocol: null, coverage: 'none' });
  });

  it('rejects non-finite subscription numbers and never surfaces a partial limit', () => {
    const bad = {
      contentType: 'application/json',
      body: '{"object":"billing_subscription","has_payment_method":true,' +
        '"soft_limit_usd":1,"hard_limit_usd":1e309,"system_hard_limit_usd":1,"access_until":0}',
    };
    expect(parseNewApiBillingWalletResponses({ subscription: bad, lifetimeUsage: usage() }))
      .toEqual({
        status: 'invalid_number',
        protocol: 'newapi',
        balance: null,
        usage: 12.5,
        coverage: 'usage_only',
      });
  });

  it('accepts structured +json media types but rejects a missing Content-Type', () => {
    expect(parseNewApiBillingWalletResponses({
      subscription: { ...subscription(100), contentType: 'application/problem+json' },
      lifetimeUsage: { ...usage(100), contentType: 'APPLICATION/JSON' },
    }).status).toBe('ok');
    expect(parseNewApiBillingUsageResponse({ body: '{"object":"list","total_usage":100}' }).status)
      .toBe('invalid_content_type');
  });
});
