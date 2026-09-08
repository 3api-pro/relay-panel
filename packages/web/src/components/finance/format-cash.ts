/** 按支付币种展示现金；USDT 等非 ISO 4217 代码保留原币种，不做汇率换算。 */
export function fmtCash(amounts: Record<string, number> | null | undefined): string {
  if (amounts == null) return '—';
  const entries = Object.entries(amounts)
    .filter(([, amount]) => Number.isFinite(amount))
    .sort(([a], [b]) => (a === 'CNY' ? -1 : b === 'CNY' ? 1 : a.localeCompare(b)));
  if (entries.length === 0) return '¥0';
  return entries.map(([currency, amount]) => {
    if (/^[A-Za-z]{3}$/.test(currency)) {
      return new Intl.NumberFormat(currency === 'CNY' ? 'zh-CN' : 'en-US', {
        style: 'currency', currency, maximumFractionDigits: 2,
      }).format(amount);
    }
    return `${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(amount)} ${currency}`;
  }).join(' · ');
}
