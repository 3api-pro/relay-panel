'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Alert } from '@/components/store/ui';
import dynamic from 'next/dynamic';
import 'swagger-ui-react/swagger-ui.css';

// Dynamic + ssr:false because swagger-ui-react touches window at import
// time and would crash the static-export build otherwise.
const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false, loading: () => <div className="text-muted-foreground text-sm">Loading interactive spec...</div> });
import { useTranslations } from '@/lib/i18n';

export default function DocsPage() {
  const t = useTranslations('storefront.docs');
  const [origin, setOrigin] = useState(t('default_origin'));

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 space-y-6">
      <h1 className="text-3xl font-bold tracking-tight text-foreground">{t('title')}</h1>
      <p className="text-muted-foreground">{t('intro')}</p>

      <Card title={t('card_endpoint')}>
        <div className="text-sm space-y-2">
          <div>
            <span className="text-muted-foreground">{t('label_base_url')}</span>{' '}
            <code className="bg-muted px-2 py-1 rounded text-xs">{origin}</code>
          </div>
          <div>
            <span className="text-muted-foreground">{t('label_messages')}</span>{' '}
            <code className="bg-muted px-2 py-1 rounded text-xs">POST {origin}/v1/messages</code>
          </div>
        </div>
      </Card>

      <Card title={t('card_auth')}>
        <p className="text-sm text-foreground mb-3">
          {t('auth_body_pre')}<Link href="/dashboard/keys" className="underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>{t('auth_body_link')}</Link>{t('auth_body_mid')}<code className="text-xs bg-muted px-1 rounded">sk-*</code>{t('auth_body_mid2')}<code className="text-xs bg-muted px-1 rounded">Authorization: Bearer</code>{t('auth_body_post')}
        </p>
        <Alert kind="info">
          {t('auth_alert_pre')}<code className="text-xs bg-card px-1 rounded">x-api-key</code>{t('auth_alert_post')}
        </Alert>
      </Card>

      <Card title={t('card_curl')}>
        <pre className="bg-foreground text-slate-100 text-xs p-4 rounded overflow-x-auto whitespace-pre-wrap break-all">{`curl -X POST ${origin}/v1/messages \\
  -H "Authorization: Bearer sk-xxxx" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "Hello" }
    ]
  }'`}</pre>
      </Card>

      <Card title={t('card_sdk')}>
        <div className="text-sm space-y-3">
          <div>
            <div className="text-muted-foreground mb-1">{t('sdk_python_label')}</div>
            <pre className="bg-foreground text-slate-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">{`from anthropic import Anthropic

client = Anthropic(
    api_key="sk-xxxx",
    base_url="${origin}",
)

msg = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(msg.content[0].text)`}</pre>
          </div>
          <div>
            <div className="text-muted-foreground mb-1">{t('sdk_ts_label')}</div>
            <pre className="bg-foreground text-slate-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">{`import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: 'sk-xxxx',
  baseURL: '${origin}',
});

const msg = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(msg.content[0].text);`}</pre>
          </div>
        </div>
      </Card>

      <Card title={t('card_client')}>
        <div className="text-sm text-foreground space-y-2">
          <p><strong>{t('client_cc_pre')}</strong>{t('client_cc_body', { origin })}</p>
          <p><strong>{t('client_continue_pre')}</strong>{t('client_continue_body')}</p>
          <p>{t('client_more_pre')}<a href="https://github.com/3api-pro/relay-panel" className="underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>{t('client_more_link')}</a>{t('client_more_post')}</p>
        </div>
      </Card>

      <Card title={t('card_errors')}>
        <p className="text-sm text-foreground">
          {t('errors_body')}
          <code className="text-xs bg-muted px-1 rounded mx-1">{`{"type":"error","error":{"type":"...","message":"..."}}`}</code>
        </p>
      </Card>

      <div id="openapi-explorer" className="space-y-3">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">OpenAPI</h2>
        <p className="text-sm text-muted-foreground">
          Raw spec: <a href="/openapi.yaml" className="underline">openapi.yaml</a>
          {" · "}<a href="/openapi.json" className="underline">openapi.json</a>.
        </p>
        <div className="swagger-wrap bg-card rounded-lg border border-border overflow-hidden">
          <SwaggerUI url="/openapi.json" docExpansion="list" defaultModelsExpandDepth={-1} />
        </div>
      </div>
    </div>
  );
}
