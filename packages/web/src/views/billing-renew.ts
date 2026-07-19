/**
 * BillingView「立即续费」目标选择（纯逻辑，便于回归测试）。
 * 从 BillingView.vue 抽出，避免过期态 CTA 静默 no-op 的回归再次发生。
 */

export interface RenewablePlan {
  key: string;
  priceMonthly: number;
}

/**
 * 定位「立即续费」应直接购买的当前付费套餐：
 *  - 当前套餐存在且为付费档（priceMonthly>0）→ 返回它（直接打开购买弹窗续费）；
 *  - 免费/无当前付费套餐（典型：expired 阶段后端把 plan 回落为 free，priceMonthly=0）→ 返回 null。
 * 返回 null 时调用方须回退到「滚动至套餐区选购」，绝不能静默无反应。
 */
export function findRenewTarget<T extends RenewablePlan>(
  currentPlanKey: string | null | undefined,
  plans: readonly T[],
): T | null {
  if (!currentPlanKey) return null;
  return plans.find((p) => p.key === currentPlanKey && p.priceMonthly > 0) ?? null;
}
