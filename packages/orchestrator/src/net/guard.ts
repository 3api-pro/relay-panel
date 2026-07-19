import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from '../auth/rbac.js';

/**
 * 出站地址守卫（开放注册前置闸 §2）：拦截 operator 可控 URL 指向内网/回环/元数据的 SSRF。
 *
 * 背景：面板从生产进程 fetch operator 填写的 baseUrl（adopt 健康探测 + admin 实连、
 * 渠道注入等）。本机同时跑 metering-gateway / sub2api / claude-max-proxy 等内部服务，
 * 未加过滤即内网端口扫描 oracle + 响应泄露。
 *
 * 策略（单一口径，全部应用点复用）：
 *  - 非 http/https 一律拒。
 *  - IP 字面量：直接按内网段判定，命中即拒（无需 DNS）。
 *  - 主机名：DNS 解析出的**全部**地址逐一判定，任一命中内网即拒
 *    （防 DNS rebinding / 主机名解析到内网）。
 *  - 解析失败/超时：failClosed=false 时放行（解析不了谈不上 SSRF，且不制造 NXDOMAIN oracle）；
 *    failClosed=true（adopt 等面板直连路径）时拒绝（合法公网站点必然快速可解析）。
 *  - skip=true（🔴 root 豁免：内网自有站 adopt / dogfood）直接放行。
 *
 * 拒绝一律抛统一模糊错误「不允许的目标地址」——对所有内网类别用同一句，
 * 攻击者无法区分 127.x / 10.x / 元数据，消除区分 oracle。
 */

/** IPv4 点分转 32 位无符号整数；非法返回 null */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n >>> 0;
}

function ipv4InCidr(ipInt: number, netStr: string, bits: number): boolean {
  const net = ipv4ToInt(netStr);
  if (net === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((net & mask) >>> 0);
}

/** 判定 IPv4 是否属于内网/保留/元数据段（宁可多杀，解析不了当作可疑一并拒绝） */
function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return (
    ipv4InCidr(n, '0.0.0.0', 8) || // 本网络（含 0.0.0.0）
    ipv4InCidr(n, '10.0.0.0', 8) || // 私网 A
    ipv4InCidr(n, '100.64.0.0', 10) || // 运营商级 NAT
    ipv4InCidr(n, '127.0.0.0', 8) || // 回环
    ipv4InCidr(n, '169.254.0.0', 16) || // link-local（含 169.254.169.254 云元数据）
    ipv4InCidr(n, '172.16.0.0', 12) || // 私网 B
    ipv4InCidr(n, '192.0.0.0', 24) || // IETF 协议分配
    ipv4InCidr(n, '192.168.0.0', 16) || // 私网 C
    ipv4InCidr(n, '198.18.0.0', 15) || // 基准测试
    ipv4InCidr(n, '224.0.0.0', 4) || // 多播
    ipv4InCidr(n, '240.0.0.0', 4) // 保留（含 255.255.255.255 广播）
  );
}

/** 判定 IPv6 是否属于回环/未指定/link-local/ULA/多播；IPv4-mapped 回落 IPv4 判定 */
function isBlockedIpv6(ip: string): boolean {
  // 去 zone id（fe80::1%eth0）并小写
  let addr = ip.toLowerCase();
  const pct = addr.indexOf('%');
  if (pct >= 0) addr = addr.slice(0, pct);

  // IPv4-mapped：::ffff:a.b.c.d
  const mappedDotted = addr.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return isBlockedIpv4(mappedDotted[1]!);
  // IPv4-mapped：::ffff:7f00:0001 十六进制形式 → 取末 32 位
  const mappedHex = addr.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(v4);
  }

  if (addr === '::1' || addr === '::') return true; // 回环 / 未指定
  if (/^fe[89ab]/.test(addr)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(addr)) return true; // ULA fc00::/7
  if (/^ff/.test(addr)) return true; // 多播 ff00::/8
  return false; // 其余（全局单播 2000::/3 等）视为公网
}

/** 单个 IP 串是否属于禁止段；非 IP 串保守拒绝 */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) return isBlockedIpv6(ip);
  return true;
}

export interface UrlGuardOptions {
  /** 🔴 root 豁免：内网自有站 adopt / dogfood 放行 */
  skip?: boolean;
  /** DNS 解析失败/超时时是否拒绝（adopt 等面板直连路径应 true；渠道注入等纵深防御 false） */
  failClosed?: boolean;
  /** DNS 解析超时毫秒（默认 2000） */
  timeoutMs?: number;
  /** 注入解析器，仅测试用；默认走 dns.promises.lookup 全部地址 */
  resolve?: (host: string) => Promise<string[]>;
}

const DEFAULT_LOOKUP_TIMEOUT_MS = 2000;

async function defaultResolve(host: string): Promise<string[]> {
  const res = await lookup(host, { all: true });
  return res.map((r) => r.address);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lookup timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 统一模糊错误：所有拒绝路径同一句，消除区分 oracle */
function blocked(): never {
  throw new ApiError(400, '不允许的目标地址');
}

/**
 * 校验出站 URL 必须指向公网；命中内网/非法一律抛 ApiError(400,'不允许的目标地址')。
 * skip=true 直接放行（root）。主机名走 DNS 解析全部地址逐一判定。
 */
export async function assertPublicUrl(rawUrl: string, opts: UrlGuardOptions = {}): Promise<void> {
  if (opts.skip) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    blocked();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') blocked();

  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // 去 IPv6 方括号
  host = host.toLowerCase();
  if (host === '') blocked();

  // IP 字面量：直接判定，不触网
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) blocked();
    return;
  }

  // 主机名：解析全部地址，任一内网即拒（防 rebinding / 解析到内网）
  let addresses: string[];
  try {
    addresses = await withTimeout(
      (opts.resolve ?? defaultResolve)(host),
      opts.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS,
    );
  } catch {
    if (opts.failClosed) blocked();
    return; // 解析不了 → 无法建立连接，放行且不制造 NXDOMAIN oracle
  }
  if (addresses.length === 0) {
    if (opts.failClosed) blocked();
    return;
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) blocked();
  }
}
