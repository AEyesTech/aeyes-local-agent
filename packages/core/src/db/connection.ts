import type { DatabaseKind } from '../config.js';

/** 연결 문자열 형식 검사. 오류 메시지에 값을 넣지 않는다(비밀번호가 들어 있다). */
export function connectionStringError(kind: DatabaseKind, value: string): string | null {
  if (!value) return '연결 문자열이 비어 있습니다';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '연결 문자열은 URL 형식이어야 합니다(예: postgres://사용자:비밀번호@호스트:5432/DB이름)';
  }
  const schemes = kind === 'postgres' ? ['postgres:', 'postgresql:'] : ['mysql:'];
  if (!schemes.includes(url.protocol)) {
    return kind === 'postgres' ? 'postgres:// 또는 postgresql:// 로 시작해야 합니다' : 'mysql:// 로 시작해야 합니다';
  }
  if (!url.hostname && !url.searchParams.get('host')) return '연결 문자열에 호스트가 없습니다';
  return null;
}
