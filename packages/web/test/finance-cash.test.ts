import { describe, expect, it } from 'vitest';
import { fmtCash } from '../src/components/finance/format-cash';

describe('finance recharge formatting', () => {
  it('renders the live mixed CNY/USDT recharge without throwing or merging currencies', () => {
    expect(fmtCash({ CNY: 903, USDT: 21.46 })).toBe('¥903.00 · 21.46 USDT');
  });
  it('renders USDT-only daily rows and chart tooltips', () => {
    expect(fmtCash({ USDT: 15.33 })).toBe('15.33 USDT');
  });
  it('keeps fiat currency formatting', () => {
    expect(fmtCash({ USD: 12.5, CNY: 10 })).toBe('¥10.00 · $12.50');
  });
  it('distinguishes unavailable and zero recharge', () => {
    expect(fmtCash(null)).toBe('—');
    expect(fmtCash(undefined)).toBe('—');
    expect(fmtCash({})).toBe('¥0');
    expect(fmtCash({ USDT: NaN })).toBe('¥0');
  });
});
