import { describe, expect, it } from 'vitest';
import { findRenewTarget } from '../src/views/billing-renew';

/**
 * 回归：expired 阶段「立即续费」死按钮。
 * 后端在 expired 把 plan 回落为 free（priceMonthly=0），旧逻辑定位不到付费套餐 → 静默 no-op。
 * findRenewTarget 现明确对该情形返回 null，调用方据此回退到「滚动至套餐区」（不再无反应）。
 */

const PLANS = [
  { key: 'free', priceMonthly: 0 },
  { key: 'pro', priceMonthly: 49 },
  { key: 'team', priceMonthly: 199 },
];

describe('findRenewTarget（立即续费目标选择）', () => {
  it('当前付费套餐 → 返回该套餐（打开购买弹窗直接续费）', () => {
    expect(findRenewTarget('pro', PLANS)).toEqual({ key: 'pro', priceMonthly: 49 });
  });

  it('expired 回落 free（priceMonthly=0）→ 返回 null（回退滚动至套餐区，非 no-op）', () => {
    expect(findRenewTarget('free', PLANS)).toBeNull();
  });

  it('无当前套餐 key（null/undefined）→ 返回 null', () => {
    expect(findRenewTarget(null, PLANS)).toBeNull();
    expect(findRenewTarget(undefined, PLANS)).toBeNull();
  });

  it('当前 key 不在套餐列表 → 返回 null', () => {
    expect(findRenewTarget('legacy-plan', PLANS)).toBeNull();
  });
});
