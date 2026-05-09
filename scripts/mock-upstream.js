#!/usr/bin/env node
/**
 * Mock Anthropic-compatible /v1/messages upstream for BYOK smoke testing.
 * Responds to POST /v1/messages with a canned reply, including usage tokens
 * so the panel's billing path runs end-to-end.
 */
const http = require('http');

const PORT = parseInt(process.env.MOCK_PORT || '19999', 10);
const EXPECTED_KEY = process.env.MOCK_API_KEY || 'test-byok-key-1234';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${EXPECTED_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'mock: bad key' } }));
      return;
    }
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'mock: only POST /messages supported' } }));
      return;
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = {}; }
    const wantsStream = parsed.stream === true;
    const reply = {
      id: 'msg_mock_' + Date.now().toString(36),
      type: 'message',
      role: 'assistant',
      model: parsed.model || 'claude-mock',
      content: [{ type: 'text', text: 'pong from mock upstream' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 4 },
    };
    if (wantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: reply })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock upstream on http://127.0.0.1:${PORT}/v1/messages (key=${EXPECTED_KEY})`);
});
