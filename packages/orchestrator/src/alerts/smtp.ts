import net from 'node:net';
import tls from 'node:tls';
import { hostname } from 'node:os';

/**
 * 零依赖 SMTP 客户端（node:net + node:tls 手写，仓库先例=支付三网关手写加密无 SDK）。
 * 只负责发一封纯文本邮件（UTF-8 正文，Subject 走 RFC2047 base64 防中文乱码）。
 *  - 465 隐式 TLS：直接 tls.connect；
 *  - 587/25 STARTTLS：明文连上、EHLO，若上游通告 STARTTLS 则升级到 TLS 后再 EHLO；
 *    未通告则明文继续（best-effort，测试假服务器即走此路径）。
 *  - AUTH LOGIN（仅当传入 user+pass）；连接与命令各自独立超时；通告 8BITMIME 时 MAIL FROM 带 BODY=8BITMIME。
 * 🔴 凭据只在内存并直发 socket，绝不写入日志/错误消息：AUTH 阶段的报错只带响应码，绝不回显账号口令。
 */

export interface SmtpTransport {
  host: string;
  port: number;
  /** 传入 user+pass 才做 AUTH LOGIN；只在内存，绝不落日志 */
  user?: string;
  pass?: string;
  /** 465 隐式 TLS；缺省按 port===465 推断 */
  secure?: boolean;
  /** TCP/ TLS 建连超时（含隐式 TLS 与 STARTTLS 握手），默认 10s */
  connectTimeoutMs?: number;
  /** 单条命令等待响应超时，默认 10s */
  commandTimeoutMs?: number;
  /** 默认校验上游证书；仅测试可关（生产绝不关） */
  tlsRejectUnauthorized?: boolean;
  /**
   * 🔴 默认 false：连接未加密（非隐式 TLS 且 STARTTLS 未完成，含被中间人剥掉通告的场景）时拒绝 AUTH，
   * 防 STARTTLS-stripping 导致凭据明文上线。仅本机/内网调试可显式放行（RP_SMTP_ALLOW_INSECURE=1）。
   */
  allowInsecureAuth?: boolean;
}

export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** EmailNotifier 注入用的发信函数签名（默认 sendMail，测试可替身） */
export type SmtpSend = (transport: SmtpTransport, message: SmtpMessage) => Promise<void>;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

interface SmtpResponse {
  code: number;
  /** 完整响应文本行（多行响应保留全部行） */
  lines: string[];
}

type SockErr = Error & { code?: string };

/**
 * 单条 SMTP 连接的行协议读写器：把 socket 的字节流切成一条条完整响应
 * （末行形如 `250 xxx`，中间行形如 `250-xxx`），并提供带超时的 readResponse。
 * detach() 摘掉全部监听，供 STARTTLS 升级前把明文 socket 交给 tls 层。
 */
class SmtpChannel {
  private buffer = '';
  private curLines: string[] = [];
  private readonly queue: SmtpResponse[] = [];
  private waiter: ((r: SmtpResponse) => void) | null = null;
  private failWaiter: ((e: Error) => void) | null = null;
  private failed: Error | null = null;

  private readonly onData = (chunk: string): void => this.ingest(chunk);
  private readonly onError = (err: SockErr): void => this.fail(new Error(`SMTP 连接错误: ${err.message}`));
  private readonly onClose = (): void => this.fail(new Error('SMTP 连接被对端关闭'));

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.curLines.push(line);
      // 末行：三位数字 + 空格；中间行为三位数字 + '-'
      if (/^\d{3} /.test(line)) {
        const resp: SmtpResponse = { code: Number(line.slice(0, 3)), lines: this.curLines };
        this.curLines = [];
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          this.failWaiter = null;
          w(resp);
        } else {
          this.queue.push(resp);
        }
      }
    }
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    if (this.failWaiter) {
      const w = this.failWaiter;
      this.failWaiter = null;
      this.waiter = null;
      w(err);
    }
  }

  /** 读下一条完整响应；超时或连接错误则 reject */
  readResponse(timeoutMs: number): Promise<SmtpResponse> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise<SmtpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.failWaiter = null;
        reject(new Error(`SMTP 命令响应超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.waiter = (r): void => {
        clearTimeout(timer);
        resolve(r);
      };
      this.failWaiter = (e): void => {
        clearTimeout(timer);
        reject(e);
      };
    });
  }

  writeLine(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  writeRaw(text: string): void {
    this.socket.write(text);
  }

  /** STARTTLS 升级前把 socket 从本读写器解绑，交给 tls.connect 接管 */
  detach(): void {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
  }
}

/** RFC2047 编码 Subject：按完整字符切块（不切断多字节），每个 encoded-word 控制在安全长度内 */
function encodeSubject(subject: string): string {
  // 每块最多 45 字节 UTF-8（base64 后 ~60 字符，含包裹仍 < 75），且不跨字符切断
  const MAX_BYTES = 45;
  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const ch of subject) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (chunkBytes + b > MAX_BYTES && chunk !== '') {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += ch;
    chunkBytes += b;
  }
  if (chunk !== '') words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  // 多个 encoded-word 之间用 折叠空白（CRLF + SP）分隔
  return words.length > 0 ? words.join('\r\n ') : '=?UTF-8?B??=';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** RFC5322 日期头（统一 +0000 UTC） */
function rfc5322Date(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return (
    `${DAYS[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`
  );
}

/** DATA 正文：CRLF 规范化 + 行首点转义（dot-stuffing），保证以 CRLF 收尾 */
function dotStuffBody(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map((l) => (l.startsWith('.') ? `.${l}` : l));
  return `${lines.join('\r\n')}\r\n`;
}

/** IP 字面量不设 SNI（RFC6066：servername 不得为 IP，否则被忽略并告警） */
function isIpHost(host: string): boolean {
  return net.isIP(host) !== 0;
}

/** EHLO 名：取本机名，过滤成合法 domain-literal 字符，兜底 localhost */
function ehloName(): string {
  const raw = hostname() || 'localhost';
  const cleaned = raw.replace(/[^A-Za-z0-9.\-]/g, '');
  return cleaned !== '' ? cleaned : 'localhost';
}

/** Message-ID 域名取发件地址 @ 后缀，兜底 localhost；缺 Message-ID 是常见反垃圾减分项 */
function makeMessageId(from: string): string {
  const domain = from.split('@')[1] ?? 'localhost';
  const rand = Math.random().toString(36).slice(2, 10);
  return `<${Date.now()}.${rand}@${domain}>`;
}

function buildDataPayload(message: SmtpMessage, use8bit: boolean): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeSubject(message.subject)}`,
    `Date: ${rfc5322Date(new Date())}`,
    `Message-ID: ${makeMessageId(message.from)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${use8bit ? '8bit' : 'quoted-printable'}`,
  ];
  const body = use8bit ? dotStuffBody(message.text) : dotStuffBody(toQuotedPrintable(message.text));
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/** 无 8BITMIME 时用 quoted-printable 编码非 ASCII，避免裸 8bit 被上游截断/乱码 */
function toQuotedPrintable(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  let lineLen = 0;
  const push = (s: string): void => {
    if (lineLen + s.length > 75) {
      out += '=\r\n';
      lineLen = 0;
    }
    out += s;
    lineLen += s.length;
  };
  for (const byte of bytes) {
    if (byte === 0x0a) {
      out += '\r\n';
      lineLen = 0;
    } else if (byte === 0x0d) {
      // 交给 \n 处理，跳过裸 CR
    } else if ((byte >= 0x20 && byte <= 0x7e && byte !== 0x3d) || byte === 0x09) {
      push(String.fromCharCode(byte));
    } else {
      push(`=${byte.toString(16).toUpperCase().padStart(2, '0')}`);
    }
  }
  return out;
}

/** 建立 TCP / 隐式 TLS 连接，带建连超时 */
function connectSocket(
  transport: SmtpTransport,
  secure: boolean,
  connectTimeoutMs: number,
  rejectUnauthorized: boolean,
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket: net.Socket = secure
      ? tls.connect({
          host: transport.host,
          port: transport.port,
          rejectUnauthorized,
          ...(isIpHost(transport.host) ? {} : { servername: transport.host }),
        })
      : net.connect({ host: transport.host, port: transport.port });
    const readyEvent = secure ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SMTP 建连超时（${connectTimeoutMs}ms）`));
    }, connectTimeoutMs);
    const onErr = (err: SockErr): void => {
      clearTimeout(timer);
      reject(new Error(`SMTP 建连失败: ${err.message}`));
    };
    socket.once('error', onErr);
    socket.once(readyEvent, () => {
      clearTimeout(timer);
      socket.removeListener('error', onErr);
      resolve(socket);
    });
  });
}

/** STARTTLS：在既有明文 socket 上升级到 TLS */
function upgradeToTls(
  socket: net.Socket,
  host: string,
  rejectUnauthorized: boolean,
  timeoutMs: number,
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const secured = tls.connect({
      socket,
      rejectUnauthorized,
      ...(isIpHost(host) ? {} : { servername: host }),
    });
    const timer = setTimeout(() => {
      secured.destroy();
      reject(new Error(`STARTTLS 握手超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const onErr = (err: SockErr): void => {
      clearTimeout(timer);
      reject(new Error(`STARTTLS 握手失败: ${err.message}`));
    };
    secured.once('error', onErr);
    secured.once('secureConnect', () => {
      clearTimeout(timer);
      secured.removeListener('error', onErr);
      resolve(secured);
    });
  });
}

/** 解析 EHLO 250 多行响应为能力集（每行首个 token 大写，如 STARTTLS / 8BITMIME / AUTH） */
function parseCapabilities(resp: SmtpResponse): Set<string> {
  const caps = new Set<string>();
  // 首行是问候（250-host Hello），能力从第二行起；宽松起见逐行取首 token
  for (const line of resp.lines) {
    const rest = line.slice(4).trim(); // 去掉 "250-" / "250 "
    const token = rest.split(/\s+/)[0];
    if (token) caps.add(token.toUpperCase());
  }
  return caps;
}

async function ehlo(channel: SmtpChannel, timeoutMs: number): Promise<Set<string>> {
  channel.writeLine(`EHLO ${ehloName()}`);
  const resp = await channel.readResponse(timeoutMs);
  if (resp.code !== 250) {
    throw new Error(`SMTP EHLO 失败: ${resp.code} ${resp.lines.join(' ')}`);
  }
  return parseCapabilities(resp);
}

async function authLogin(channel: SmtpChannel, user: string, pass: string, timeoutMs: number): Promise<void> {
  channel.writeLine('AUTH LOGIN');
  const s1 = await channel.readResponse(timeoutMs);
  if (s1.code !== 334) throw new Error(`SMTP 认证失败（AUTH LOGIN 未受理, ${s1.code}）`);
  // 🔴 账号/口令 base64 只发 socket，绝不进日志；报错只带响应码
  channel.writeRaw(`${Buffer.from(user, 'utf8').toString('base64')}\r\n`);
  const s2 = await channel.readResponse(timeoutMs);
  if (s2.code !== 334) throw new Error(`SMTP 认证失败（用户名阶段, ${s2.code}）`);
  channel.writeRaw(`${Buffer.from(pass, 'utf8').toString('base64')}\r\n`);
  const s3 = await channel.readResponse(timeoutMs);
  if (s3.code !== 235) throw new Error(`SMTP 认证失败（凭据被拒, ${s3.code}）`);
}

/** 发一条命令并断言响应码；不匹配则抛（含服务端文本，供排障；EmailNotifier 侧再过 redactText） */
async function command(channel: SmtpChannel, line: string, expect: number, timeoutMs: number, stage: string): Promise<void> {
  channel.writeLine(line);
  const resp = await channel.readResponse(timeoutMs);
  if (resp.code !== expect) {
    throw new Error(`SMTP ${stage} 返回意外响应: ${resp.code} ${resp.lines.join(' ')}`);
  }
}

/**
 * 发送一封纯文本邮件。失败一律 throw（由上层 EmailNotifier 兜底成 warn，不反噬监控循环）。
 */
export async function sendMail(transport: SmtpTransport, message: SmtpMessage): Promise<void> {
  const secure = transport.secure ?? transport.port === 465;
  const connectTimeoutMs = transport.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const commandTimeoutMs = transport.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const rejectUnauthorized = transport.tlsRejectUnauthorized ?? true;

  let socket = await connectSocket(transport, secure, connectTimeoutMs, rejectUnauthorized);
  let channel = new SmtpChannel(socket);
  try {
    // 服务问候
    const greet = await channel.readResponse(commandTimeoutMs);
    if (greet.code !== 220) throw new Error(`SMTP 服务问候异常: ${greet.code} ${greet.lines.join(' ')}`);

    let caps = await ehlo(channel, commandTimeoutMs);

    // 587/25：通告 STARTTLS 则升级；未通告则明文继续（是否允许明文 AUTH 由下方门禁把关）
    let secured = secure;
    if (!secure && caps.has('STARTTLS')) {
      await command(channel, 'STARTTLS', 220, commandTimeoutMs, 'STARTTLS');
      channel.detach();
      socket = await upgradeToTls(socket, transport.host, rejectUnauthorized, connectTimeoutMs);
      channel = new SmtpChannel(socket);
      caps = await ehlo(channel, commandTimeoutMs); // TLS 后重新 EHLO 取能力
      secured = true;
    }

    if (transport.user !== undefined && transport.pass !== undefined) {
      // 🔴 未加密信道默认拒发凭据：上游未通告 STARTTLS 可能是服务器本身明文，
      // 也可能是中间人剥掉了通告（STARTTLS-stripping）——两种情况都不能把口令写上明文线路
      if (!secured && transport.allowInsecureAuth !== true) {
        throw new Error('连接未加密（无 TLS 且未完成 STARTTLS），拒绝发送 SMTP 凭据；确需明文认证请设 RP_SMTP_ALLOW_INSECURE=1');
      }
      await authLogin(channel, transport.user, transport.pass, commandTimeoutMs);
    }

    const use8bit = caps.has('8BITMIME');
    const mailFrom = `MAIL FROM:<${message.from}>${use8bit ? ' BODY=8BITMIME' : ''}`;
    await command(channel, mailFrom, 250, commandTimeoutMs, 'MAIL FROM');
    await command(channel, `RCPT TO:<${message.to}>`, 250, commandTimeoutMs, 'RCPT TO');
    await command(channel, 'DATA', 354, commandTimeoutMs, 'DATA');

    channel.writeRaw(buildDataPayload(message, use8bit));
    channel.writeRaw('.\r\n');
    const done = await channel.readResponse(commandTimeoutMs);
    if (done.code !== 250) throw new Error(`SMTP 投递失败: ${done.code} ${done.lines.join(' ')}`);

    // QUIT 尽力而为，失败不影响已投递结果
    try {
      await command(channel, 'QUIT', 221, commandTimeoutMs, 'QUIT');
    } catch {
      /* ignore */
    }
  } finally {
    socket.destroy();
  }
}
