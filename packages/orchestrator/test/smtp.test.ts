import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import type { SmtpSettings } from '../src/config.js';
import { appSettings } from '../src/db/schema.js';
import { sendMail, type SmtpMessage, type SmtpTransport } from '../src/alerts/smtp.js';
import {
  ALERT_EMAIL_SETTINGS_KEY,
  EmailNotifier,
  FanoutNotifier,
  renderAlertEmail,
  type Notifier,
  type NotifyEvent,
} from '../src/alerts/notify.js';
import { makeTestDb } from './helpers.js';

// pglite WASM 冷启动约 4s；SMTP 用例本身很快，整文件放宽超时
vi.setConfig({ testTimeout: 30_000 });

/**
 * 脚本化假 SMTP 服务器（node:net，全内存零依赖）：记录收到的控制命令与 DATA 载荷，
 * 按可配置能力集回 EHLO，覆盖 问候/EHLO/AUTH/MAIL/RCPT/DATA/QUIT 全流程。
 * STARTTLS 分支：通告 STARTTLS 并对 STARTTLS 命令回 220，随后对端升级 TLS 时本机为明文
 * → 主动断开使握手快速失败（真 TLS 握手困难，改测 587 前半段命令序列）。
 */
interface FakeSmtpOptions {
  advertiseStarttls?: boolean;
  advertise8bitmime?: boolean;
  advertiseAuth?: boolean;
  /** 从不发送问候（测命令响应超时） */
  silentGreeting?: boolean;
  /** 在收到 pass 的 base64 后拒绝认证（测 AUTH 失败不泄露凭据） */
  rejectAuth?: boolean;
}

class FakeSmtpServer {
  readonly commands: string[] = [];
  readonly rcpts: string[] = [];
  dataPayload = '';
  mailFrom = '';
  private readonly server: net.Server;
  private readonly opts: FakeSmtpOptions;

  constructor(opts: FakeSmtpOptions = {}) {
    this.opts = { advertise8bitmime: true, advertiseAuth: true, ...opts };
    this.server = net.createServer((sock) => this.handle(sock));
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private ehloReply(): string {
    const caps = ['250-fake.local greets you', '250-PIPELINING'];
    if (this.opts.advertiseAuth) caps.push('250-AUTH LOGIN PLAIN');
    if (this.opts.advertise8bitmime) caps.push('250-8BITMIME');
    if (this.opts.advertiseStarttls) caps.push('250-STARTTLS');
    caps.push('250 SIZE 10485760'); // 末行用空格
    return caps.map((l) => `${l}\r\n`).join('');
  }

  private handle(sock: net.Socket): void {
    sock.setEncoding('utf8');
    let buffer = '';
    let mode: 'command' | 'data' = 'command';
    let authStage: 0 | 1 | 2 = 0;
    let starttlsArmed = false;

    if (!this.opts.silentGreeting) sock.write('220 fake ESMTP ready\r\n');

    sock.on('data', (chunk: string) => {
      // STARTTLS 握手：220 之后对端发来的都是 TLS 明文握手字节，直接断开让其握手失败
      if (starttlsArmed) {
        sock.destroy();
        return;
      }
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (mode === 'data') {
          if (line === '.') {
            mode = 'command';
            sock.write('250 2.0.0 Ok: queued\r\n');
          } else {
            this.dataPayload += `${line}\n`;
          }
          continue;
        }

        // AUTH LOGIN 交互阶段优先（base64 内容不应被当作命令解析）
        if (authStage === 1) {
          this.commands.push(line);
          authStage = 2;
          sock.write('334 UGFzc3dvcmQ6\r\n'); // "Password:"
          continue;
        }
        if (authStage === 2) {
          this.commands.push(line);
          authStage = 0;
          sock.write(this.opts.rejectAuth ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 Authentication successful\r\n');
          continue;
        }

        this.commands.push(line);
        if (line.startsWith('EHLO') || line.startsWith('HELO')) {
          sock.write(this.ehloReply());
        } else if (line === 'STARTTLS') {
          sock.write('220 2.0.0 Ready to start TLS\r\n');
          starttlsArmed = true;
        } else if (line === 'AUTH LOGIN') {
          authStage = 1;
          sock.write('334 VXNlcm5hbWU6\r\n'); // "Username:"
        } else if (line.startsWith('MAIL FROM')) {
          this.mailFrom = line;
          sock.write('250 2.1.0 Ok\r\n');
        } else if (line.startsWith('RCPT TO')) {
          this.rcpts.push(line);
          sock.write('250 2.1.5 Ok\r\n');
        } else if (line === 'DATA') {
          mode = 'data';
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line === 'QUIT') {
          sock.write('221 2.0.0 Bye\r\n');
          sock.end();
        } else {
          sock.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    sock.on('error', () => undefined); // 断开引发的 ECONNRESET 忽略
  }
}

/**
 * 从 DATA 载荷解出 RFC2047 base64 编码的 Subject 明文。
 * Subject 可能折叠成多行（续行以空白开头）、含多个 encoded-word——先收齐 Subject 头
 * 字段全部续行，再把所有 encoded-word 依次解码拼接（word 之间的折叠空白按 RFC2047 忽略）。
 */
function decodeSubject(data: string): string {
  const lines = data.split('\n');
  const start = lines.findIndex((l) => l.startsWith('Subject: '));
  if (start < 0) return '';
  let field = lines[start]!.slice('Subject: '.length);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[ \t]/.test(lines[i]!)) field += lines[i]!; // 折叠续行
    else break;
  }
  const re = /=\?UTF-8\?B\?([^?]*)\?=/gi;
  let out = '';
  let g: RegExpExecArray | null;
  while ((g = re.exec(field)) !== null) out += Buffer.from(g[1]!, 'base64').toString('utf8');
  return out;
}

const CHINESE_SUBJECT = '[relay-panel 告警] 站点甲 站点不可达';
const BASE_MSG: SmtpMessage = {
  from: 'monitor@relay.example.com',
  to: 'ops@example.com',
  subject: CHINESE_SUBJECT,
  text: '第一行\n.以点开头的行\n最后一行',
};

describe('SMTP 客户端: 全流程命令序列', () => {
  it('问候/EHLO/AUTH/MAIL/RCPT/DATA/QUIT 全通，8BITMIME 生效，Subject 中文不乱码，行首点转义', async () => {
    const server = new FakeSmtpServer({ advertise8bitmime: true, advertiseAuth: true });
    const port = await server.listen();
    try {
      const transport: SmtpTransport = {
        host: '127.0.0.1',
        port,
        user: 'smtp-user',
        pass: 'smtp-secret-pass',
        secure: false,
        commandTimeoutMs: 5_000,
        connectTimeoutMs: 5_000,
      };
      await expect(sendMail(transport, BASE_MSG)).resolves.toBeUndefined();

      // 命令序列
      expect(server.commands.some((c) => c.startsWith('EHLO'))).toBe(true);
      expect(server.commands).toContain('AUTH LOGIN');
      // AUTH base64（不含明文口令）
      expect(server.commands).toContain(Buffer.from('smtp-user', 'utf8').toString('base64'));
      expect(server.commands).toContain(Buffer.from('smtp-secret-pass', 'utf8').toString('base64'));
      // 明文口令绝不出现在线路命令里
      expect(server.commands.join('\n')).not.toContain('smtp-secret-pass');
      // 8BITMIME → MAIL FROM 带 BODY=8BITMIME
      expect(server.mailFrom).toBe('MAIL FROM:<monitor@relay.example.com> BODY=8BITMIME');
      expect(server.rcpts).toContain('RCPT TO:<ops@example.com>');
      expect(server.commands).toContain('DATA');
      expect(server.commands).toContain('QUIT');

      // Subject RFC2047 解码回中文原文
      expect(decodeSubject(server.dataPayload)).toBe(CHINESE_SUBJECT);
      // 8bit 编码头 + 行首点转义（'.以点开头' → '..以点开头'）
      expect(server.dataPayload).toContain('Content-Transfer-Encoding: 8bit');
      expect(server.dataPayload).toContain('..以点开头的行');
      expect(server.dataPayload).toContain('最后一行');
    } finally {
      await server.close();
    }
  });

  it('无 AUTH 凭据时跳过 AUTH，直接 MAIL/RCPT/DATA', async () => {
    const server = new FakeSmtpServer({ advertiseAuth: false });
    const port = await server.listen();
    try {
      await expect(
        sendMail({ host: '127.0.0.1', port, secure: false, commandTimeoutMs: 5_000 }, BASE_MSG),
      ).resolves.toBeUndefined();
      expect(server.commands).not.toContain('AUTH LOGIN');
      expect(server.rcpts).toContain('RCPT TO:<ops@example.com>');
    } finally {
      await server.close();
    }
  });

  it('无 8BITMIME 通告时 MAIL FROM 不带 BODY=8BITMIME，正文走 quoted-printable', async () => {
    const server = new FakeSmtpServer({ advertise8bitmime: false, advertiseAuth: false });
    const port = await server.listen();
    try {
      await expect(
        sendMail({ host: '127.0.0.1', port, secure: false, commandTimeoutMs: 5_000 }, BASE_MSG),
      ).resolves.toBeUndefined();
      expect(server.mailFrom).toBe('MAIL FROM:<monitor@relay.example.com>');
      expect(server.dataPayload).toContain('Content-Transfer-Encoding: quoted-printable');
    } finally {
      await server.close();
    }
  });
});

describe('SMTP 客户端: STARTTLS / 认证失败 / 超时', () => {
  it('通告 STARTTLS 时发出 EHLO→STARTTLS 前半段序列（握手在明文服务器上快速失败）', async () => {
    const server = new FakeSmtpServer({ advertiseStarttls: true });
    const port = await server.listen();
    try {
      await expect(
        sendMail(
          { host: '127.0.0.1', port, secure: false, commandTimeoutMs: 3_000, connectTimeoutMs: 3_000 },
          BASE_MSG,
        ),
      ).rejects.toThrow();
      // 前半段命令序列已覆盖：EHLO 后紧跟 STARTTLS
      const ehloIdx = server.commands.findIndex((c) => c.startsWith('EHLO'));
      expect(ehloIdx).toBeGreaterThanOrEqual(0);
      expect(server.commands).toContain('STARTTLS');
      expect(server.commands.indexOf('STARTTLS')).toBeGreaterThan(ehloIdx);
    } finally {
      await server.close();
    }
  });

  it('AUTH 被拒时抛错但绝不回显账号/口令', async () => {
    const server = new FakeSmtpServer({ rejectAuth: true });
    const port = await server.listen();
    try {
      const p = sendMail(
        { host: '127.0.0.1', port, user: 'u', pass: 'top-secret-pw', secure: false, commandTimeoutMs: 5_000 },
        BASE_MSG,
      );
      await expect(p).rejects.toThrow(/认证失败/);
      await p.catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain('top-secret-pw');
      });
    } finally {
      await server.close();
    }
  });

  it('服务器不发问候时命令响应超时（不无限挂起）', async () => {
    const server = new FakeSmtpServer({ silentGreeting: true });
    const port = await server.listen();
    try {
      const started = Date.now();
      await expect(
        sendMail({ host: '127.0.0.1', port, secure: false, commandTimeoutMs: 250, connectTimeoutMs: 3_000 }, BASE_MSG),
      ).rejects.toThrow(/超时/);
      expect(Date.now() - started).toBeLessThan(2_500);
    } finally {
      await server.close();
    }
  });
});

describe('FanoutNotifier', () => {
  it('并发扇出到多个通知器，单个失败不影响其他，且不 throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seenA: NotifyEvent[] = [];
    const seenC: NotifyEvent[] = [];
    const a: Notifier = { fire: async (e) => void seenA.push(e) };
    const b: Notifier = {
      fire: async () => {
        throw new Error('boom');
      },
    };
    const c: Notifier = { fire: async (e) => void seenC.push(e) };
    const fan = new FanoutNotifier([a, b, c]);
    const ev: NotifyEvent = { type: 'open', alert: { id: 1 } };
    await expect(fan.fire(ev)).resolves.toBeUndefined();
    expect(seenA).toHaveLength(1);
    expect(seenC).toHaveLength(1); // b 抛错不影响 a/c
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('EmailNotifier', () => {
  let db: Db;

  beforeAll(async () => {
    db = await makeTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.close().catch(() => undefined);
  });

  afterEach(async () => {
    await db.orm.delete(appSettings).where(eq(appSettings.key, ALERT_EMAIL_SETTINGS_KEY));
    vi.restoreAllMocks();
  });

  const smtp: SmtpSettings = {
    host: '127.0.0.1',
    port: 2525,
    from: 'monitor@relay.example.com',
    secure: false,
    user: 'u',
    pass: 'p',
  };

  const openEvent: NotifyEvent = {
    type: 'open',
    alert: {
      kind: 'site_down',
      severity: 'critical',
      title: '站点不可达',
      detail: '连续 3 次健康检查失败: connection refused',
      firstSeenAt: '2026-07-19 08:00:00',
      lastSeenAt: '2026-07-19 08:05:00',
    },
    site: { slug: 'site-a', label: '站点甲' },
  };

  async function setRecipient(email: string): Promise<void> {
    await db.orm
      .insert(appSettings)
      .values({ key: ALERT_EMAIL_SETTINGS_KEY, value: { email } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { email } } });
  }

  it('env 未配 SMTP（smtp=null）→ 静默跳过，不 throw、不发信', async () => {
    const send = vi.fn(async () => undefined);
    const notifier = new EmailNotifier(db, null, send);
    await setRecipient('ops@example.com');
    await expect(notifier.fire(openEvent)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('收件人未配置 → 静默跳过，不 throw、不发信', async () => {
    const send = vi.fn(async () => undefined);
    const notifier = new EmailNotifier(db, smtp, send);
    await expect(notifier.fire(openEvent)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('SMTP 失败 → 只 warn 不 throw（不反噬监控循环）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:2525');
    });
    const notifier = new EmailNotifier(db, smtp, send);
    await setRecipient('ops@example.com');
    await expect(notifier.fire(openEvent)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.join(' '))).toContain('邮件通知失败');
  });

  it('每次触发现读收件人设置（root 改完即时生效）', async () => {
    const send = vi.fn(async () => undefined);
    const notifier = new EmailNotifier(db, smtp, send);

    // 未配置 → 跳过
    await notifier.fire(openEvent);
    expect(send).not.toHaveBeenCalled();

    // 配置 A → 发到 A
    await setRecipient('a@example.com');
    await notifier.fire(openEvent);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ to: 'a@example.com', from: 'monitor@relay.example.com' });

    // 改成 B → 下次即发到 B（现读生效）
    await setRecipient('b@example.com');
    await notifier.fire(openEvent);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toMatchObject({ to: 'b@example.com' });
  });

  it('邮件内容：中文主题/正文含站点 slug/label/类型/UTC 时间；resolve 用恢复主题', async () => {
    const openMail = renderAlertEmail(openEvent);
    expect(openMail.subject).toBe('[relay-panel 告警] 站点甲 站点不可达');
    expect(openMail.text).toContain('site-a');
    expect(openMail.text).toContain('站点甲');
    expect(openMail.text).toContain('站点不可达');
    expect(openMail.text).toContain('2026-07-19T08:00:00.000Z'); // firstSeenAt → UTC

    const resolveMail = renderAlertEmail({
      ...openEvent,
      type: 'resolve',
      alert: { ...(openEvent.alert as object), resolvedAt: '2026-07-19 09:00:00' },
    });
    expect(resolveMail.subject).toBe('[relay-panel 恢复] 站点甲 站点不可达');
    expect(resolveMail.text).toContain('2026-07-19T09:00:00.000Z');
  });

  it('端到端：真 sendMail 投递到假 SMTP 服务器，收件人现读、RCPT/Subject 正确', async () => {
    const server = new FakeSmtpServer({ advertiseAuth: false });
    const port = await server.listen();
    try {
      const liveSmtp: SmtpSettings = {
        host: '127.0.0.1',
        port,
        from: 'monitor@relay.example.com',
        secure: false,
      };
      const notifier = new EmailNotifier(db, liveSmtp); // 默认真 sendMail
      await setRecipient('oncall@example.com');
      await expect(notifier.fire(openEvent)).resolves.toBeUndefined();

      expect(server.rcpts).toContain('RCPT TO:<oncall@example.com>');
      expect(server.mailFrom).toBe('MAIL FROM:<monitor@relay.example.com> BODY=8BITMIME');
      expect(decodeSubject(server.dataPayload)).toBe('[relay-panel 告警] 站点甲 站点不可达');
    } finally {
      await server.close();
    }
  });
});
