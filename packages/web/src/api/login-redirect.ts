/** Same-origin path only; shared by password and MFA completion. */
export function loginRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return '/';
  return value;
}
