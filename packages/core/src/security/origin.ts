/**
 * 127.0.0.1 포트는 셀러가 방문하는 모든 웹사이트가 두드릴 수 있다.
 * AeyeStudio origin 만 받고(크롬 확장 security.js 의 TRUSTED_CONTROLLER_ORIGINS 와 동일하게 유지),
 * Host 헤더로 DNS 리바인딩을 막는다.
 */
export const TRUSTED_ORIGINS: readonly string[] = Object.freeze([
  'https://studio.aeyes.dev',
  'https://seller-ai-studio.vercel.app',
]);

export function isAllowedOrigin(origin: string | undefined, dev: boolean): boolean {
  if (!origin) return false;
  if (TRUSTED_ORIGINS.includes(origin)) return true;
  if (!dev) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.origin === origin;
  } catch {
    return false;
  }
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
