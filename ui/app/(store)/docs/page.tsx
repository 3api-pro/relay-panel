'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Alert } from '@/components/store/ui';

export default function DocsPage() {
  const [origin, setOrigin] = useState('https://your-store.example.com');

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 space-y-6">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">API 文档</h1>
      <p className="text-slate-600">本站 API 与 Anthropic Messages API 完全兼容, 任何 Anthropic 兼容的客户端都可直接接入。</p>

      <Card title="Endpoint">
        <div className="text-sm space-y-2">
          <div>
            <span className="text-slate-500">Base URL:</span>{' '}
            <code className="bg-slate-100 px-2 py-1 rounded text-xs">{origin}</code>
          </div>
          <div>
            <span className="text-slate-500">Messages:</span>{' '}
            <code className="bg-slate-100 px-2 py-1 rounded text-xs">POST {origin}/v1/messages</code>
          </div>
        </div>
      </Card>

      <Card title="认证">
        <p className="text-sm text-slate-700 mb-3">
          请在 <Link href="/dashboard/keys" className="underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>API Keys</Link> 页生成 <code className="text-xs bg-slate-100 px-1 rounded">sk-*</code> 密钥, 然后通过 <code className="text-xs bg-slate-100 px-1 rounded">Authorization: Bearer</code> 头传入。
        </p>
        <Alert kind="info">
          也支持 <code className="text-xs bg-white px-1 rounded">x-api-key</code> 头, 与 Anthropic 官方完全兼容。
        </Alert>
      </Card>

      <Card title="cURL 示例">
        <pre className="bg-slate-900 text-slate-100 text-xs p-4 rounded overflow-x-auto whitespace-pre-wrap break-all">{`curl -X POST ${origin}/v1/messages \\
  -H "Authorization: Bearer sk-xxxx" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "你好" }
    ]
  }'`}</pre>
      </Card>

      <Card title="官方 SDK">
        <div className="text-sm space-y-3">
          <div>
            <div className="text-slate-500 mb-1">Python (anthropic):</div>
            <pre className="bg-slate-900 text-slate-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">{`from anthropic import Anthropic

client = Anthropic(
    api_key="sk-xxxx",
    base_url="${origin}",
)

msg = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
)
print(msg.content[0].text)`}</pre>
          </div>
          <div>
            <div className="text-slate-500 mb-1">TypeScript (@anthropic-ai/sdk):</div>
            <pre className="bg-slate-900 text-slate-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">{`import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: 'sk-xxxx',
  baseURL: '${origin}',
});

const msg = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '你好' }],
});
console.log(msg.content[0].text);`}</pre>
          </div>
        </div>
      </Card>

      <Card title="客户端配置">
        <div className="text-sm text-slate-700 space-y-2">
          <p><strong>Claude Code / Cursor / Cline:</strong> 把 <code className="text-xs bg-slate-100 px-1 rounded">ANTHROPIC_BASE_URL</code> 设为 <code className="text-xs bg-slate-100 px-1 rounded">{origin}</code>, <code className="text-xs bg-slate-100 px-1 rounded">ANTHROPIC_API_KEY</code> 设为你的 <code className="text-xs bg-slate-100 px-1 rounded">sk-*</code>。</p>
          <p><strong>Continue:</strong> Provider 选 anthropic, apiBase 填同上, apiKey 填同上。</p>
          <p>更多客户端示例见 <a href="https://github.com/3api-pro/relay-panel" className="underline" style={{ color: 'var(--brand-primary, #0e9486)' }}>GitHub</a>。</p>
        </div>
      </Card>

      <Card title="错误处理">
        <p className="text-sm text-slate-700">
          错误返回与 Anthropic 完全一致 — HTTP 4xx/5xx + JSON
          <code className="text-xs bg-slate-100 px-1 rounded mx-1">{`{"type":"error","error":{"type":"...","message":"..."}}`}</code>
          的结构。客户端 SDK 都能直接识别。
        </p>
      </Card>
    </div>
  );
}
