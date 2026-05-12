/**
 * OpenAPI metadata catalogue.
 *
 * Single source of truth that scripts/generate-openapi.ts consumes to
 * emit docs/openapi.yaml. Hand-maintained because Express has no runtime
 * schema reflection; adding a new endpoint = appending one entry here.
 *
 * Sections:
 *   - storefront   /api/storefront/* and /storefront/* (end-user facing)
 *   - admin        /api/admin/* and /admin/* (reseller admin)
 *   - relay        /v1/messages, /v1/messages/count_tokens, /v1/models
 *                  (Anthropic-compatible, public via API key auth)
 *   - platform     /api/platform/* (root domain only)
 */

export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: 'none' | 'api_key' | 'bearer_admin' | 'bearer_customer' | 'platform_token';
  requestBody?: { example?: any; required?: boolean };
  responses: Record<string, { description: string; example?: any }>;
}

export const OPENAPI_INFO = {
  title: '3API Relay Panel',
  version: '0.8.0',
  description:
    'Anthropic-compatible LLM relay with multi-tenant storefront, ' +
    'reseller admin, plans / orders / subscriptions, webhook delivery, ' +
    'and per-tenant BYOK upstream channels.',
};

export const SERVERS = [
  { url: 'https://3api.pro', description: 'SaaS root (multi-tenant)' },
  { url: 'https://{store}.3api.pro', description: 'Tenant storefront (replace {store})' },
  { url: 'http://localhost:8080', description: 'Local dev' },
];

export const ENDPOINTS: ApiEndpoint[] = [
  // -------------------------------------------------------------------
  // Relay — Anthropic-compatible LLM API
  // -------------------------------------------------------------------
  {
    method: 'POST',
    path: '/v1/messages',
    summary: 'Create a message (Anthropic-compatible)',
    description: 'Drop-in for `POST https://api.anthropic.com/v1/messages`. Supports streaming (SSE) when `stream:true`.',
    tags: ['relay'],
    auth: 'api_key',
    requestBody: {
      required: true,
      example: {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      },
    },
    responses: {
      '200': {
        description: 'Message response (JSON or text/event-stream)',
        example: {
          id: 'msg_01...',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi!' }],
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      },
      '401': { description: 'Missing / invalid API key' },
      '429': { description: 'Rate limited or quota exhausted' },
    },
  },
  {
    method: 'POST',
    path: '/v1/messages/count_tokens',
    summary: 'Count tokens for a prospective message',
    tags: ['relay'],
    auth: 'api_key',
    requestBody: { example: { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'Hello' }] } },
    responses: { '200': { description: 'Token count', example: { input_tokens: 10 } } },
  },
  {
    method: 'GET',
    path: '/v1/models',
    summary: 'List available models',
    tags: ['relay'],
    auth: 'api_key',
    responses: {
      '200': {
        description: 'Models array',
        example: { data: [{ id: 'claude-sonnet-4-7', object: 'model' }] },
      },
    },
  },

  // -------------------------------------------------------------------
  // Storefront — end-user facing
  // -------------------------------------------------------------------
  {
    method: 'POST', path: '/storefront/signup',
    summary: 'End-user signup', tags: ['storefront'], auth: 'none',
    requestBody: { example: { email: 'alice@example.com', password: 'secret123' } },
    responses: { '200': { description: 'JWT token', example: { token: 'eyJ...' } }, '409': { description: 'email already exists' } },
  },
  {
    method: 'POST', path: '/storefront/login',
    summary: 'End-user login', tags: ['storefront'], auth: 'none',
    requestBody: { example: { email: 'alice@example.com', password: 'secret123' } },
    responses: { '200': { description: 'JWT token' }, '401': { description: 'bad credentials' } },
  },
  {
    method: 'POST', path: '/storefront/forgot-password',
    summary: 'Request a password-reset email', tags: ['storefront'], auth: 'none',
    requestBody: { example: { email: 'alice@example.com' } },
    responses: { '200': { description: 'always 200 to avoid enumeration' } },
  },
  {
    method: 'POST', path: '/storefront/reset-password',
    summary: 'Consume reset token + set new password', tags: ['storefront'], auth: 'none',
    requestBody: { example: { token: '…', password: 'new-secret-123' } },
    responses: { '200': { description: 'reset OK' }, '400': { description: 'expired or invalid token' } },
  },
  {
    method: 'GET', path: '/storefront/plans', summary: 'List enabled plans for this storefront',
    tags: ['storefront'], auth: 'none',
    responses: { '200': { description: 'Plan list', example: { data: [{ id: 1, slug: 'pro', name: 'Pro', price_cents: 9900 }] } } },
  },
  {
    method: 'GET', path: '/storefront/brand', summary: 'Get tenant branding (logo, colors)',
    tags: ['storefront'], auth: 'none',
    responses: { '200': { description: 'Brand config' } },
  },
  {
    method: 'GET', path: '/storefront/balance', summary: 'Current user quota + subscription status',
    tags: ['storefront'], auth: 'bearer_customer',
    responses: { '200': { description: 'Balance', example: { quota_cents: 10000, used_quota_cents: 1200 } } },
  },
  {
    method: 'POST', path: '/storefront/orders', summary: 'Create order for a plan',
    tags: ['storefront'], auth: 'bearer_customer',
    requestBody: { example: { plan_id: 1, idempotency_key: 'cli-2025-01-01-001' } },
    responses: { '201': { description: 'Order with payment URL' }, '402': { description: 'payment required' } },
  },
  {
    method: 'GET', path: '/storefront/orders', summary: 'List user orders',
    tags: ['storefront'], auth: 'bearer_customer',
    responses: { '200': { description: 'Orders array' } },
  },
  {
    method: 'GET', path: '/storefront/subscriptions', summary: 'List user subscriptions',
    tags: ['storefront'], auth: 'bearer_customer',
    responses: { '200': { description: 'Subscriptions array' } },
  },
  {
    method: 'GET', path: '/storefront/checkin/status', summary: 'Daily check-in availability',
    tags: ['storefront'], auth: 'bearer_customer',
    responses: { '200': { description: 'Status + streak' } },
  },
  {
    method: 'POST', path: '/storefront/checkin', summary: 'Claim daily check-in reward',
    tags: ['storefront'], auth: 'bearer_customer',
    responses: { '200': { description: 'Reward applied' }, '409': { description: 'already claimed today' } },
  },

  // -------------------------------------------------------------------
  // Admin — reseller-facing
  // -------------------------------------------------------------------
  {
    method: 'POST', path: '/admin/login', summary: 'Admin login',
    tags: ['admin'], auth: 'none',
    requestBody: { example: { email: 'admin@example.com', password: 'secret' } },
    responses: { '200': { description: 'JWT cookie set' }, '401': { description: 'bad credentials' } },
  },
  {
    method: 'GET', path: '/admin/me', summary: 'Admin + tenant + brand bundle',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Bundle' } },
  },
  {
    method: 'GET', path: '/admin/brand', summary: 'Read brand config', tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Brand config' } },
  },
  {
    method: 'PATCH', path: '/admin/brand', summary: 'Update brand config', tags: ['admin'], auth: 'bearer_admin',
    requestBody: { example: { store_name: 'My Relay', primary_color: '#0e9486' } },
    responses: { '200': { description: 'Updated brand config' } },
  },
  {
    method: 'GET', path: '/admin/stats', summary: 'Revenue / subs / tokens aggregates',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Stats' } },
  },
  {
    method: 'GET', path: '/admin/orders', summary: 'List orders (paginated)',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Orders' } },
  },
  {
    method: 'GET', path: '/admin/orders/export', summary: 'Bulk CSV export (streamed)',
    tags: ['admin'], auth: 'bearer_admin',
    responses: {
      '200': { description: 'text/csv; charset=utf-8 — UTF-8 BOM + header row + rows' },
    },
  },
  {
    method: 'POST', path: '/admin/orders/{id}/refund', summary: 'Issue full or partial refund',
    tags: ['admin'], auth: 'bearer_admin',
    requestBody: { example: { amount_cents: 9900, reason: 'customer cancelled' } },
    responses: { '200': { description: 'Refund issued + email sent' }, '409': { description: 'order not refundable' } },
  },
  {
    method: 'GET', path: '/admin/end-users', summary: 'List end users (paginated)',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'End users' } },
  },
  {
    method: 'POST', path: '/admin/end-users', summary: 'Create an end user',
    tags: ['admin'], auth: 'bearer_admin',
    requestBody: { example: { email: 'bob@example.com', password: 'secret', initial_quota_cents: 10000 } },
    responses: { '201': { description: 'Created' }, '409': { description: 'email already exists' } },
  },
  {
    method: 'GET', path: '/admin/plans', summary: 'List plans', tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Plans' } },
  },
  {
    method: 'POST', path: '/admin/plans', summary: 'Create a plan', tags: ['admin'], auth: 'bearer_admin',
    requestBody: { example: { name: 'Pro', slug: 'pro', period_days: 30, quota_tokens: 10000000, price_cents: 9900 } },
    responses: { '201': { description: 'Plan created' } },
  },
  {
    method: 'PATCH', path: '/admin/plans/{id}', summary: 'Update plan',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Updated' } },
  },
  {
    method: 'DELETE', path: '/admin/plans/{id}', summary: 'Disable plan (soft delete)',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Disabled' } },
  },
  {
    method: 'GET', path: '/admin/channels', summary: 'List upstream channels',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Channels' } },
  },
  {
    method: 'POST', path: '/admin/channels', summary: 'Create upstream channel',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '201': { description: 'Created' } },
  },
  {
    method: 'GET', path: '/admin/wholesale', summary: 'Wholesale balance',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Balance' } },
  },
  {
    method: 'GET', path: '/admin/affiliate', summary: 'Affiliate stats',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Stats + invite link' } },
  },
  {
    method: 'GET', path: '/admin/affiliate/referrals', summary: 'List referred tenants',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Referrals' } },
  },
  {
    method: 'POST', path: '/admin/affiliate/withdraw', summary: 'File payout request',
    tags: ['admin'], auth: 'bearer_admin',
    requestBody: { example: { amount_cents: 10000, method: 'alipay', account_info: 'user@example.com' } },
    responses: { '200': { description: 'Recorded' }, '400': { description: 'amount > available' } },
  },
  {
    method: 'GET', path: '/admin/system-setting', summary: 'Read tenant runtime switches',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Settings' } },
  },
  {
    method: 'PATCH', path: '/admin/system-setting', summary: 'Update tenant runtime switches',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Updated' } },
  },
  {
    method: 'GET', path: '/admin/payment-config', summary: 'Read payment provider config (masked)',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Config' } },
  },
  {
    method: 'PATCH', path: '/admin/payment-config', summary: 'Update payment provider config',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Updated' } },
  },
  {
    method: 'POST', path: '/admin/change-password', summary: 'Change admin password',
    tags: ['admin'], auth: 'bearer_admin',
    requestBody: { example: { old_password: 'old', new_password: 'new-secret-123' } },
    responses: { '200': { description: 'Changed' }, '401': { description: 'old password wrong' } },
  },

  // -------------------------------------------------------------------
  // Logs + Redemption (v0.7)
  // -------------------------------------------------------------------
  {
    method: 'GET', path: '/admin/logs', summary: 'Paginated per-request usage logs',
    description:
      'Returns usage_log rows scoped to the admin tenant. Filters: status (success | failure | all), ' +
      'model (ILIKE substring), end_user_id, from / to (ISO-8601), limit (default 50, max 200), offset.',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Rows + total for the chosen filter' } },
  },
  {
    method: 'GET', path: '/admin/redemption', summary: 'List redemption codes',
    description:
      'Lists codes scoped to the admin tenant. Filter status=unused | redeemed | revoked | all (default all). ' +
      'Response includes `counts` keyed by status for filter chips.',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Rows + counts tally' } },
  },
  {
    method: 'POST', path: '/admin/redemption', summary: 'Batch-generate redemption codes',
    description:
      'Creates `count` random codes (1-1000) of the given face value. Returns codes in plaintext exactly once. ' +
      'Optional prefix (≤16 chars) is concatenated in front and helps organize batches.',
    tags: ['admin'], auth: 'bearer_admin',
    requestBody: { example: { count: 100, quota_cents: 1000, prefix: '2026Q2-', expires_at: '2026-12-31T23:59:59Z' } },
    responses: { '201': { description: '{ count, codes[], quota_cents_each }' }, '400': { description: 'invalid quota_cents' } },
  },
  {
    method: 'POST', path: '/admin/redemption/{id}/revoke', summary: 'Revoke an unused redemption code',
    description: 'Marks `status = revoked` on an unused code. Returns 409 if already redeemed or already revoked.',
    tags: ['admin'], auth: 'bearer_admin',
    responses: { '200': { description: 'Revoked' }, '409': { description: 'code not in unused state' } },
  },

  // -------------------------------------------------------------------
  // Webhooks (v0.5)
  // -------------------------------------------------------------------
  {
    method: 'GET', path: '/admin/webhooks', summary: 'List webhook subscriptions',
    tags: ['admin', 'webhooks'], auth: 'bearer_admin',
    responses: { '200': { description: 'Webhook list incl. last_triggered_at, fail_count_total' } },
  },
  {
    method: 'POST', path: '/admin/webhooks', summary: 'Create webhook subscription',
    description:
      'Returns the HMAC secret in the response **once** — record it for ' +
      'signature verification. Subsequent reads will not include the secret. ' +
      'Allowed event types: order.paid, subscription.expired, refund.processed, wholesale.low.',
    tags: ['admin', 'webhooks'], auth: 'bearer_admin',
    requestBody: {
      example: {
        url: 'https://example.com/3api-webhook',
        events: ['order.paid', 'subscription.expired'],
      },
    },
    responses: { '201': { description: 'Created (secret returned once)' } },
  },
  {
    method: 'PATCH', path: '/admin/webhooks/{id}', summary: 'Update webhook url / events / enabled',
    tags: ['admin', 'webhooks'], auth: 'bearer_admin',
    responses: { '200': { description: 'Updated' } },
  },
  {
    method: 'DELETE', path: '/admin/webhooks/{id}', summary: 'Delete webhook (cascades deliveries)',
    tags: ['admin', 'webhooks'], auth: 'bearer_admin',
    responses: { '200': { description: 'Deleted' } },
  },
  {
    method: 'POST', path: '/admin/webhooks/{id}/test', summary: 'Send a synthetic test event',
    tags: ['admin', 'webhooks'], auth: 'bearer_admin',
    responses: { '200': { description: 'Delivery row with status' } },
  },
  {
    method: 'GET', path: '/admin/webhooks/{id}/deliveries', summary: 'Delivery history',
    tags: ['admin', 'webhooks'], auth: 'bearer_admin',
    responses: { '200': { description: 'Recent deliveries (most recent first)' } },
  },

  // -------------------------------------------------------------------
  // Platform — root-domain operator API (X-Platform-Token guarded)
  // -------------------------------------------------------------------
  {
    method: 'GET', path: '/platform/tenants', summary: 'List all tenants',
    tags: ['platform'], auth: 'platform_token',
    responses: { '200': { description: 'Tenant list with id, slug, status, created_at' } },
  },
  {
    method: 'POST', path: '/platform/tenants', summary: 'Create tenant + initial admin (atomic)',
    description:
      'Atomically creates a `tenant` row and its first `reseller_admin`. ' +
      'Slug must be 1-32 chars `[a-z0-9-]` and not a reserved name (admin, api, www, ...).',
    tags: ['platform'], auth: 'platform_token',
    requestBody: {
      example: {
        slug: 'acme',
        admin_email: 'owner@acme.com',
        admin_password: 'min8chars',
      },
    },
    responses: {
      '201': { description: 'Created (returns tenant + admin)' },
      '409': { description: 'Slug already taken' },
    },
  },
  {
    method: 'POST', path: '/platform/tenants/{id}/suspend', summary: 'Suspend a tenant',
    description: 'Sets `status = suspended`. Cannot suspend tenant 1.',
    tags: ['platform'], auth: 'platform_token',
    responses: { '200': { description: 'Updated tenant row' } },
  },
  {
    method: 'POST', path: '/platform/tenants/{id}/activate', summary: 'Activate a tenant',
    description: 'Sets `status = active`. Cannot deactivate tenant 1.',
    tags: ['platform'], auth: 'platform_token',
    responses: { '200': { description: 'Updated tenant row' } },
  },
  {
    method: 'POST', path: '/platform/tenants/{id}/upgrade-shadow',
    summary: 'Mint a per-tenant shadow sk- against wholesale (phase 2)',
    description:
      'Phase-2 manual upgrade: spends platform `wholesale_balance` to mint a ' +
      'per-tenant `sk-relay-*` via llmapi.pro `/v1/wholesale/purchase`, then ' +
      'replaces the tenant recommended upstream channel api_key with it. ' +
      'Use this for paying tenants who justify the spend (~¥29 for pro/monthly); ' +
      'cheap / spam signups stay on the shared phase-1 key. Each call mints a ' +
      'new purchase — callers are responsible for not double-spending.',
    tags: ['platform'], auth: 'platform_token',
    requestBody: {
      required: false,
      example: { plan: 'pro', cycle: 'monthly' },
    },
    responses: {
      '200': { description: 'Channel api_key swapped; purchase summary returned' },
      '404': { description: 'Tenant not found' },
      '502': {
        description:
          'Upstream / balance failure (insufficient_balance, network, HTTP 402, etc.). ' +
          'Structured `error.message` + `purchase` returned for the operator UI.',
      },
    },
  },
];

export const TAG_DESCRIPTIONS: Record<string, string> = {
  relay: 'Anthropic-compatible LLM relay (drop-in)',
  storefront: 'End-user signup / login / orders / subscriptions',
  admin: 'Reseller admin (per-tenant CRUD)',
  webhooks: 'Outbound webhook subscriptions + delivery',
  platform: 'Platform operator (root-domain only, X-Platform-Token guarded)',
};
