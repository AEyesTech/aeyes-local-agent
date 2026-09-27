/**
 * 비밀 값(DB 연결 문자열) 한 줄 입력. 터미널이면 raw 모드로 받아 화면에 보이지 않게 하고,
 * 파이프(스크립트·테스트)면 첫 줄을 읽는다. 명령 인자로 받지 않는 이유: 셸 기록·프로세스 목록에 남는다.
 */
import { createInterface } from 'node:readline';

interface RawCapable {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export async function readSecretLine(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  prompt: string
): Promise<string> {
  output.write(prompt);
  const tty = input as NodeJS.ReadableStream & RawCapable;
  if (tty.isTTY === true && typeof tty.setRawMode === 'function') {
    const setRaw = tty.setRawMode.bind(tty);
    return new Promise<string>((resolve, reject) => {
      let value = '';
      const cleanup = () => {
        input.off('data', onData);
        setRaw(false);
        input.pause();
      };
      const onData = (chunk: Buffer | string) => {
        for (const ch of String(chunk)) {
          if (ch === '\r' || ch === '\n') {
            cleanup();
            output.write('\n');
            resolve(value.trim());
            return;
          }
          if (ch === '\u0003' || ch === '\u0004') {
            cleanup();
            output.write('\n');
            reject(new Error('입력을 취소했습니다'));
            return;
          }
          if (ch === '\u007f' || ch === '\b') {
            value = Array.from(value).slice(0, -1).join('');
            continue;
          }
          if (ch >= ' ') value += ch;
        }
      };
      setRaw(true);
      input.setEncoding('utf8');
      input.on('data', onData);
      input.resume();
    });
  }
  const rl = createInterface({ input, terminal: false });
  try {
    for await (const line of rl) return line.trim();
    return '';
  } finally {
    rl.close();
  }
}
