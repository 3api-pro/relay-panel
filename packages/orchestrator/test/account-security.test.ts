import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { authTokens, notifications, operators } from '../src/db/schema.js';
import { base32, totp } from '../src/auth/totp.js';
import { decryptSecret } from '../src/secrets.js';
import { deliverNotifications } from '../src/notifications/service.js';

let server: TestServer;
afterEach(async () => { await server?.close(); });
const mailConfig = { signupMode: 'open' as const, emailVerificationRequired: true, publicUrl: 'https://panel.example.test',
  smtp: { host: 'smtp.example.test', port: 465, secure: true, from: 'noreply@example.test' } };
async function tokenFromMail(): Promise<string> {
  const rows = await server.db.orm.select().from(notifications);
  const mail = decryptSecret(rows.at(-1)!.mailCiphertext!, server.config.secretKey!);
  return mail.match(/#(?:verify|reset)=([a-f0-9]{64})/)![1]!;
}
describe('account security', () => {
  it('matches RFC 6238 SHA1 vectors', () => {
    const secret = base32(Buffer.from('12345678901234567890'));
    for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']] as const) {
      expect(totp(secret, Math.floor(seconds / 30), 8)).toBe(expected);
    }
  });
  it('requires verification, stores only token hashes, consumes links once, and protects queued mail', async () => {
    server = await makeTestServer({ config: mailConfig });
    const identity = { email: 'new@example.test', password: 'correct-pass-123' };
    const signup = await server.app.inject({ method: 'POST', url: '/api/auth/signup', payload: identity });
    expect(signup.statusCode).toBe(200);
    expect(signup.json().verificationRequired).toBe(true);
    expect((await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: identity })).statusCode).toBe(403);
    const token = await tokenFromMail();
    expect(JSON.stringify(await server.db.orm.select().from(authTokens))).not.toContain(token);
    const complete = () => server.app.inject({ method: 'POST', url: '/api/auth/recovery/complete', payload: { token, purpose: 'verify' } });
    const responses = await Promise.all([complete(), complete()]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 400]);
    const cookie = await server.login(identity.email, identity.password);
    const inbox = await server.app.inject({ url: '/api/notifications', cookies: { rp_session: cookie } });
    expect(inbox.body).not.toContain(token);
    expect(inbox.body).not.toContain('mailCiphertext');
    const messages: string[] = [];
    await deliverNotifications(server.db, server.config, async (_transport, message) => { messages.push(message.text); });
    expect(messages[0]).toContain(token);
    expect((await server.db.orm.select().from(notifications))[0]!.mailCiphertext).toBeNull();
  });
  it('resets a password atomically and revokes old sessions, without logging in from the reset link', async () => {
    server = await makeTestServer({ config: mailConfig });
    const account = await server.seedLogin({ email: 'owner@example.test', password: 'old-pass-123' });
    const request = (email: string) => server.app.inject({ method: 'POST', url: '/api/auth/recovery/request', payload: { email, purpose: 'reset' } });
    const known = await request('owner@example.test'), unknown = await request('missing@example.test');
    expect(known.json()).toEqual(unknown.json());
    const token = await tokenFromMail();
    const reset = await server.app.inject({ method: 'POST', url: '/api/auth/recovery/complete', payload: { token, purpose: 'reset', password: 'new-pass-123' } });
    expect(reset.statusCode).toBe(200);
    expect(reset.cookies).toHaveLength(0);
    expect((await server.app.inject({ url: '/api/auth/me', cookies: { rp_session: account.cookie } })).statusCode).toBe(401);
    expect((await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: 'old-pass-123' } })).statusCode).toBe(401);
    expect(await server.login('owner@example.test', 'new-pass-123')).toBeTruthy();
  });
  it('enforces MFA login, one-use challenges, TOTP replay protection and one-use recovery codes', async () => {
    server = await makeTestServer();
    const identity = { email: 'admin@example.test', password: 'correct-pass-123' };
    const account = await server.seedLogin(identity);
    const cookies = { rp_session: account.cookie };
    const setup = await server.app.inject({ method: 'POST', url: '/api/auth/mfa/setup', cookies, payload: { password: identity.password } });
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().secret as string, step = Math.floor(Date.now() / 30_000);
    const enable = await server.app.inject({ method: 'POST', url: '/api/auth/mfa/enable', cookies, payload: { password: identity.password, code: totp(secret, step) } });
    expect(enable.statusCode).toBe(200);
    const recovery = enable.json().recoveryCodes as string[];
    const login = await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: identity });
    expect(login.json().mfaRequired).toBe(true); expect(login.cookies).toHaveLength(0);
    const verify = (challenge: string, code: string) => server.app.inject({ method: 'POST', url: '/api/auth/mfa/login', payload: { challenge, code } });
    expect((await verify(login.json().challenge, totp(secret, step))).statusCode).toBe(400);
    const passed = await verify(login.json().challenge, totp(secret, step + 1));
    expect(passed.statusCode).toBe(200);
    expect((await verify(login.json().challenge, recovery[0]!)).statusCode).toBe(400);
    const login2 = await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: identity });
    expect((await verify(login2.json().challenge, recovery[0]!)).statusCode).toBe(200);
    const login3 = await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: identity });
    expect((await verify(login3.json().challenge, recovery[0]!)).statusCode).toBe(400);
    const [op] = await server.db.orm.select().from(operators).where(eq(operators.id, account.operatorId));
    expect(op!.mfaSecret).not.toContain(secret); expect(op!.mfaRecoveryHashes).toHaveLength(9);
  });
  it('blocks a stale or expired link and does not let email reset bypass MFA', async () => {
    server = await makeTestServer({ config: mailConfig });
    const account = await server.seedLogin({ email: 'safe@example.test', password: 'correct-pass-123' });
    await server.db.orm.update(operators).set({ mfaSecret: 'v1:invalid' }).where(eq(operators.id, account.operatorId));
    await server.app.inject({ method: 'POST', url: '/api/auth/recovery/request', payload: { email: 'safe@example.test', purpose: 'reset' } });
    const token = await tokenFromMail();
    const reset = await server.app.inject({ method: 'POST', url: '/api/auth/recovery/complete', payload: { token, purpose: 'reset', password: 'new-pass-123' } });
    expect(reset.statusCode).not.toBe(200);
    expect(await server.db.orm.select().from(authTokens)).toHaveLength(1);
  });
});
