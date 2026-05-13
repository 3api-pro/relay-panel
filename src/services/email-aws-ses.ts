/**
 * AWS SES v2 transport. Raw fetch + SigV4 (no @aws-sdk dep).
 *
 * Config (from app_config):
 *   aws_ses_region              (default us-east-1)
 *   aws_ses_access_key_id
 *   aws_ses_secret_access_key
 *   aws_ses_from_address        (e.g. noreply@3api.pro — must be verified in SES)
 *
 * Endpoint: https://email.{region}.amazonaws.com/v2/email/outbound-emails
 * Service:  ses
 *
 * Returns { ok, providerMessageId?, error? }. Never throws.
 */
import crypto from 'crypto';
import { ProxyAgent } from 'undici';
import { getConfig } from './app-config';
import { logger } from './logger';

let _dispatcher: ProxyAgent | undefined;
let _dispatcherProxy: string | undefined;
function dispatcher(): any {
  const proxy = getConfig('outbound_https_proxy', '');
  if (proxy && proxy !== _dispatcherProxy) {
    _dispatcher = new ProxyAgent(proxy);
    _dispatcherProxy = proxy;
  } else if (!proxy) {
    _dispatcher = undefined;
    _dispatcherProxy = undefined;
  }
  return _dispatcher;
}

export interface SesSendInput {
  to: string;
  fromOverride?: string;
  subject: string;
  html: string;
  text?: string;
}
export interface SesSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export function isSesConfigured(): boolean {
  return Boolean(
    getConfig('aws_ses_access_key_id') &&
    getConfig('aws_ses_secret_access_key') &&
    getConfig('aws_ses_from_address'),
  );
}

// ---- SigV4 (small, no SDK) ----
function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

interface SignedRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

function signSesRequest(opts: {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bodyJson: string;
}): SignedRequest {
  const { region, accessKeyId, secretAccessKey, bodyJson } = opts;
  const host = `email.${region}.amazonaws.com`;
  const path = '/v2/email/outbound-emails';
  const url = `https://${host}${path}`;
  const service = 'ses';
  const algorithm = 'AWS4-HMAC-SHA256';

  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, ''); // 20260513T201500Z
  const dateStamp = amzDate.slice(0, 8); // 20260513

  const payloadHash = sha256Hex(bodyJson);
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest =
    'POST\n' + path + '\n' + '' + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + payloadHash;

  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credScope}\n${sha256Hex(canonicalRequest)}`;
  const signature = crypto
    .createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');

  const authz = `${algorithm} Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Host': host,
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
      'Authorization': authz,
    },
    body: bodyJson,
  };
}

export async function sendViaSes(input: SesSendInput): Promise<SesSendResult> {
  const accessKeyId = getConfig('aws_ses_access_key_id', '');
  const secretAccessKey = getConfig('aws_ses_secret_access_key', '');
  const region = getConfig('aws_ses_region', 'us-east-1');
  const fromAddr = input.fromOverride || getConfig('aws_ses_from_address', '');

  if (!accessKeyId || !secretAccessKey || !fromAddr) {
    return { ok: false, error: 'ses_not_configured' };
  }

  const body = {
    FromEmailAddress: fromAddr,
    Destination: { ToAddresses: [input.to] },
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: input.html, Charset: 'UTF-8' },
          ...(input.text ? { Text: { Data: input.text, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  };
  const bodyJson = JSON.stringify(body);
  const signed = signSesRequest({ region, accessKeyId, secretAccessKey, bodyJson });

  try {
    const r = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: signed.body,
      dispatcher: dispatcher(),
    } as any);
    const text = await r.text();
    if (!r.ok) {
      logger.warn({ status: r.status, body: text.slice(0, 300) }, 'ses:send:failed');
      return {
        ok: false,
        error: `ses_${r.status}: ${text.slice(0, 200)}`,
      };
    }
    let parsed: any = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return { ok: true, providerMessageId: parsed?.MessageId };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
