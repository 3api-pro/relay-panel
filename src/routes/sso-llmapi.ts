/**
 * GET /sso/llmapi — receive a one-time SSO handoff from llmapi.pro.
 *
 * Flow:
 *   1. Pull ?token=... (mandatory)
 *   2. Verify HMAC + TTL + aud/iss + nonce
 *   3. Atomically: consume nonce, find/create reseller_admin + tenant,
 *      seed plans at 2x markup, upsert llmapi-wholesale upstream channel
 *   4. signSession (admin) + set cookie + render SSO bridge HTML (writes
 *      JWT to localStorage and location.replace('/admin'))
 *
 * Public, no auth required (token IS the auth). Hardened against replay
 * (one-time nonce) and tampering (HMAC).
 */
import { Router, Request, Response } from 'express';
import { signSession } from '../services/jwt';
import { setAdminCookie, ADMIN_COOKIE_NAME, ADMIN_TTL_SECONDS } from './auth-admin';
import { verifySsoToken, consumeLlmapiSsoToken, SsoTokenError } from '../services/sso-llmapi';
import { logger } from '../services/logger';

export const ssoLlmapiRouter = Router();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

function ssoBridgeHtml(token: string, returnTo = '/admin', notice = ''): string {
  const safeToken = token.replace(/[^A-Za-z0-9._-]/g, '');
  const safeReturn = returnTo.replace(/[^A-Za-z0-9/_?=&.-]/g, '');
  const safeNotice = escapeHtml(notice);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>登录中…</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,sans-serif;background:#fafbfc;color:#0b1220;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.b{text-align:center;padding:32px;max-width:420px}.t{font-size:32px;font-weight:600;color:#0d9488;margin:0 0 8px}p{color:#475569;margin:6px 0}.spinner{display:inline-block;width:18px;height:18px;border:2px solid #d1d5db;border-top-color:#0d9488;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px}@keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body><div class="b">
<div class="t">3API Panel</div>
<p><span class="spinner"></span>正在配置你的分销站…</p>
${safeNotice ? `<p style="color:#0d9488;font-size:14px">${safeNotice}</p>` : ''}
<script>
(function(){
  try { localStorage.setItem('token', '${safeToken}'); } catch(e){}
  setTimeout(function(){ location.replace('${safeReturn}'); }, 250);
})();
</script>
<noscript><p style="margin-top:16px"><a href="${safeReturn}" style="color:#0d9488">点这里继续</a></p></noscript>
</div></body></html>`;
}

function errorHtml(title: string, msg: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,sans-serif;background:#fafbfc;color:#0b1220;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.b{text-align:center;padding:32px;max-width:480px}.t{font-size:24px;font-weight:600;color:#dc2626;margin:0 0 12px}p{color:#475569;margin:6px 0;line-height:1.55}a{color:#0d9488}</style>
</head><body><div class="b">
<div class="t">${escapeHtml(title)}</div>
<p>${escapeHtml(msg)}</p>
<p style="margin-top:20px"><a href="https://llmapi.pro/dashboard">回到 llmapi 控制台</a> · <a href="/admin/login">手动登录 3api</a></p>
</div></body></html>`;
}

ssoLlmapiRouter.get('/llmapi', async (req: Request, res: Response) => {
  const token = String(req.query.token || '');
  if (!token) {
    res.status(400).type('html').send(errorHtml('无效请求', '缺少 token 参数。请从 llmapi 控制台进入。'));
    return;
  }

  try {
    const claims = verifySsoToken(token);
    const result = await consumeLlmapiSsoToken(claims);

    const sessionToken = signSession({
      type: 'admin',
      adminId: result.adminId,
      tenantId: result.tenantId,
      email: claims.email,
    });

    setAdminCookie(res, sessionToken);
    logger.info(
      {
        adminId: result.adminId,
        tenantId: result.tenantId,
        slug: result.tenantSlug,
        llmapi_user_id: claims.user_id,
        fresh: result.fresh,
      },
      'sso:llmapi:login',
    );

    const notice = result.fresh
      ? `已为你创建分销站：${result.tenantSlug}.3api.pro · 上游已配置为你的 llmapi 订阅`
      : `欢迎回来 · 站点：${result.tenantSlug}.3api.pro`;
    res.status(200).type('html').send(ssoBridgeHtml(sessionToken, '/admin', notice));
  } catch (err: any) {
    if (err instanceof SsoTokenError) {
      const userMsg: Record<string, string> = {
        not_configured: 'SSO 未配置，请联系管理员。',
        malformed: 'Token 格式错误。',
        bad_signature: 'Token 签名不匹配，可能已被篡改。',
        bad_alg: 'Token 算法不支持。',
        bad_iss: 'Token 来源不可信。',
        bad_aud: 'Token 目标不是 3API。',
        expired: '登录链接已过期（5 分钟有效期），请回到 llmapi 控制台重新点击。',
        bad_iat: 'Token 时间戳异常。',
        bad_nonce: 'Token 防重放编号格式错误。',
        bad_payload: 'Token 缺少必要字段。',
        bad_sk: 'Token 中未携带 API 凭据。',
        replay: '此登录链接已被使用过，请回到 llmapi 控制台重新点击。',
      };
      logger.warn({ code: err.code, err: err.message }, 'sso:llmapi:reject');
      res.status(400).type('html').send(errorHtml('登录失败', userMsg[err.code] || err.message));
      return;
    }
    logger.error({ err: err.message, stack: err.stack }, 'sso:llmapi:error');
    res.status(500).type('html').send(errorHtml('内部错误', '抱歉，跳转过程出现异常，请稍后重试。'));
  }
});
