/** SiteDetailView 子组件共用的轻量格式化助手（本地）。 */

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 成本格式：大数取整、小数两位，带单位（如 USD/¥ 由 costUnit 提供）。 */
export function fmtCost(n: number, unit = ''): string {
  const v = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2);
  return unit ? `${v} ${unit}` : v;
}

function parseIso(iso: string): number {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
}

/** 绝对时间 YYYY-MM-DD HH:mm（本地时区）。 */
export function fmtDateTime(iso: string): string {
  const t = parseIso(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间；超过 30 天回落绝对时间。 */
export function relTime(iso: string): string {
  const t = parseIso(iso);
  if (Number.isNaN(t)) return iso;
  const min = Math.floor((Date.now() - t) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return fmtDateTime(iso);
}

/** 任务/生命周期动作类型中文名。 */
export function jobKindText(kind: string): string {
  const map: Record<string, string> = {
    provision: '开站',
    upgrade: '升级',
    start: '启动',
    stop: '停止',
    destroy: '销毁',
  };
  return map[kind] ?? kind;
}
