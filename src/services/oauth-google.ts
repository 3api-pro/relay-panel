/**
 * Google OAuth 2.0 helper — used by /admin/auth/google flow.
 *
 * Config source: app_config table (DB), NOT env. Keys:
 *   - google_oauth_client_id
 *   - google_oauth_client_secret
 *   - outbound_https_proxy  (optional, e.g. http://172.31.240.1:7897)
 *
 * Scopes: openid email profile.
 * No third-party SDK; raw fetch + URL encoding via undici ProxyAgent.
 */
import { ProxyAgent } from 'undici';
import { getConfig } from './app-config';

let _dispatcher: ProxyAgent | undefined;
let _dispatcherProxy: string | undefined;
function dispatcher(): any {
  const proxy = getConfig('outbound_https_proxy', '');
  // Rebuild if proxy URL changed (admin updated app_config).
  if (proxy && proxy !== _dispatcherProxy) {
    _dispatcher = new ProxyAgent(proxy);
    _dispatcherProxy = proxy;
  } else if (!proxy) {
    _dispatcher = undefined;
    _dispatcherProxy = undefined;
  }
  return _dispatcher;
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

const GOOGLE_AUTHZ = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(getConfig('google_oauth_client_id') && getConfig('google_oauth_client_secret'));
}

export function getAuthorizeUrl(state: string, redirectUri: string): string {
  const clientId = getConfig('google_oauth_client_id', '');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTHZ}?${params.toString()}`;
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<{
  access_token: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
}> {
  const clientId = getConfig('google_oauth_client_id', '');
  const clientSecret = getConfig('google_oauth_client_secret', '');
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    dispatcher: dispatcher(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`google_token_exchange_failed: ${r.status} ${text.slice(0, 200)}`);
  }
  return r.json() as any;
}

export async function getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const r = await fetch(GOOGLE_USERINFO, {
    headers: { Authorization: `Bearer ${accessToken}` },
    dispatcher: dispatcher(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`google_userinfo_failed: ${r.status} ${text.slice(0, 200)}`);
  }
  return r.json() as any;
}
