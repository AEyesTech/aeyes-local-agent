/**
 * 로컬 확인 UI 추상화. CLI(터미널), desktop(네이티브 창), 테스트(가짜)가 각자 구현한다.
 * signal 이 abort 되면(타임아웃) 구현은 표시 중인 확인을 닫아야 한다.
 */
export type ConfirmDecision = 'allow' | 'always' | 'deny';

export interface ConfirmRequest {
  tool: string;
  /** 사람이 읽을 요약(예: 셸 명령, 삭제할 경로). */
  summary: string;
  origin: string;
  accountLabel: string;
}

export interface Confirmer {
  confirm(req: ConfirmRequest, signal: AbortSignal): Promise<ConfirmDecision>;
}

export const autoAllowConfirmer: Confirmer = { confirm: async () => 'allow' };
export const denyAllConfirmer: Confirmer = { confirm: async () => 'deny' };
