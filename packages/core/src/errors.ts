export type ToolErrorCode =
  | 'path_not_allowed'
  | 'not_found'
  | 'invalid_argument'
  | 'denied_locally'
  | 'too_large'
  | 'timeout'
  | 'failed';

/** 도구가 모델에 돌려줄 수 있는 예상된 실패. 코드와 짧은 메시지만 담는다. */
export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
