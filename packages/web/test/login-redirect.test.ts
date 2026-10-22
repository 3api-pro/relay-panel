import { describe, expect, it } from 'vitest';
import { loginRedirect } from '../src/api/login-redirect';

describe('invitation return path after password and MFA login', () => {
  it('preserves the collaboration destination', () => {
    expect(loginRedirect('/collaboration')).toBe('/collaboration');
    expect(loginRedirect('/services?site=1')).toBe('/services?site=1');
  });
  it('rejects external and malformed destinations', () => {
    for (const value of [undefined, ['x'], 'https://example.com', '//example.com', '/\\example.com', '/\nexample.com']) expect(loginRedirect(value)).toBe('/');
  });
});
