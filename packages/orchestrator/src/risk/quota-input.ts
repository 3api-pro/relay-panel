import type { PlatformQuota, PlatformQuotaInput } from '@relay-panel/adapter-core';
export type QuotaWindow = 'daily' | 'weekly' | 'monthly';

export interface QuotaChange {
  platform: string;
  window: QuotaWindow;
  /** null=不限；0=完全禁用；>0=USD 上限 */
  limitUsd: number | null;
}

/**
 * GET-合并：把 change 叠加到 current 全量限额上，产出 PUT【全量替换】输入。
 * 🔴 必须保留：(a) 未涉及的其它 platform 行（否则被软删）(b) 同 platform 未涉及的其它两窗口 limit。
 * null≠0：各窗口按 current 的 limitUsd（null=不限）原样搬运，绝不把「清空/不限」落成 0=禁用。
 */
export function mergeQuotaInput(current: PlatformQuota[], change: QuotaChange): PlatformQuotaInput[] {
  const byPlatform = new Map<string, PlatformQuotaInput>();
  // 先把现有全部平台搬进来（保留每平台三窗口现值：null=不限 / 0=禁用 / >0=上限 原样）
  for (const p of current) {
    byPlatform.set(p.platform, {
      platform: p.platform,
      dailyLimitUsd: p.daily.limitUsd,
      weeklyLimitUsd: p.weekly.limitUsd,
      monthlyLimitUsd: p.monthly.limitUsd,
    });
  }
  // 目标平台不存在则新建（其余两窗口=不限 null）
  let target = byPlatform.get(change.platform);
  if (!target) {
    target = { platform: change.platform, dailyLimitUsd: null, weeklyLimitUsd: null, monthlyLimitUsd: null };
    byPlatform.set(change.platform, target);
  }
  // 覆盖目标窗口（null=不限/0=禁用/>0=上限）
  if (change.window === 'daily') target.dailyLimitUsd = change.limitUsd;
  else if (change.window === 'weekly') target.weeklyLimitUsd = change.limitUsd;
  else target.monthlyLimitUsd = change.limitUsd;
  return [...byPlatform.values()];
}
