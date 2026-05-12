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
  auth: 'none' | 'api_key' | 'bearer_admin' | 'bearer_customer';
  requestBody?: { example?: any; required?: boolean };
  responses: Record<string, { description: string; example?: any }>;
}

export const OPENAPI_INFO = {
  title: '3API Relay Panel',
  version: '0.5.0',
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
];

export const TAG_DESCRIPTIONS: Record<string, string> = {
  relay: 'Anthropic-compatible LLM relay (drop-in)',
  storefront: 'End-user signup / login / orders / subscriptions',
  admin: 'Reseller admin (per-tenant CRUD)',
  webhooks: 'Outbound webhook subscriptions + delivery',
};
