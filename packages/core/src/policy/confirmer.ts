/**
 * 로컬 확인 UI 추상화. CLI(터미널), desktop(네이티브 창), 테스트(가짜)가 각자 구현한다.
 * signal 이 abort 되면(타임아웃) 구현은 표시 중인 확인을 닫아야 한다.
 */
export type ConfirmDecision = 'allow' | 'always' | 'session' | 'deny';

export interface ConfirmRequest {
  tool: string;
  /** 사람이 읽을 요약(예: 셸 명령, 삭제할 경로). */
  summary: string;
  origin: string;
  accountLabel: string;
  /** "항상 허용"을 제안·수락해도 되는지. true 가 아니면 확인기는 [a] 를 보이지 않고 'always' 대신 'allow' 로 답한다. */
  alwaysAllowed?: boolean;
  /** "항상 허용"을 고르면 기록될 범위 키(예: shell_exec:git). alwaysAllowed 일 때만 있다. */
  grantKey?: string;
  /** "이 세션 동안 허용"(마우스·키보드)을 제안해도 되는지. true 가 아니면 확인기는 [s] 를 보이지 않고 'session' 대신 'allow' 로 답한다. */
  sessionAllowed?: boolean;
}

export interface Confirmer {
  confirm(req: ConfirmRequest, signal: AbortSignal): Promise<ConfirmDecision>;
}

export const autoAllowConfirmer: Confirmer = { confirm: async () => 'allow' };
export const denyAllConfirmer: Confirmer = { confirm: async () => 'deny' };
