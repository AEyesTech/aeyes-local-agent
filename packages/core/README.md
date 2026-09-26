# @aeyes/local-agent

AeyeStudio AI 채팅이 **내 PC**의 파일·엑셀·클립보드·앱·셸을 쓸 수 있게 하는 로컬 MCP 에이전트입니다.
AeyeStudio 서버가 PC에 접속하지 않습니다 — 크롬의 AeyeStudio 탭이 `127.0.0.1`의 에이전트에 붙어 요청을 중계합니다.

## 실행

```bash
npx @aeyes/local-agent
```

터미널에 표시되는 6자리 코드를 AeyeStudio **설정 > 내 PC 연결**에 입력하면 연결됩니다.
실행 중 명령: `p` 새 코드, `u` 모든 연결 해제, `q` 종료.

옵션: `--allow-dir <경로>`(허용 폴더 추가), `--port <47821-47830>`, `--config-dir <경로>`.

### 동작 주의사항

- `aeyes-local-agent unpair --all` 명령은 에이전트 실행 중에는 거부됩니다(종료 코드 1). 터미널에서 `u`를 눌러 모든 연결을 해제하거나, 에이전트를 먼저 중지한 후 사용하세요.
- 터미널 입력이 없는 환경(터미널 없이 시작되었거나 stdin이 파이프로 연결된 경우)에서는 확인이 필요한 모든 도구 호출이 즉시 거부됩니다. 읽기 전용 도구(파일 검색·읽기, 클립보드 읽기 등)만 정상 작동합니다.

## 도구

| 도구 | 설명 | PC 확인 |
|---|---|---|
| fs_list / fs_stat / fs_read / fs_search | 허용 폴더 읽기 | 없음 |
| fs_write / excel_write | 파일·엑셀 쓰기 | 덮어쓸 때 |
| fs_mkdir / clipboard_write | 폴더 생성, 클립보드 쓰기 | 없음 |
| fs_move / fs_delete(휴지통) | 이동·삭제 | 항상 |
| excel_read | xlsx/csv 읽기 | 없음 |
| clipboard_read | 클립보드 읽기 | 항상 |
| open_path / open_app | URL·파일·앱 열기 | 항상 |
| shell_exec | 셸 명령(60초, 출력 64KB) | 항상 |

확인 프롬프트에서 `a`(항상 허용)를 고르면 같은 종류는 다시 묻지 않습니다(셸은 명령 첫 단어 단위).

## 보안

- `127.0.0.1`에만 열리고, `Host`가 `127.0.0.1`/`localhost`가 아니면 거부합니다(DNS 리바인딩 방어).
- `https://studio.aeyes.dev`, `https://seller-ai-studio.vercel.app`에서 온 요청만 받습니다.
- 페어링 토큰은 해시로만 저장합니다. 코드는 5분·1회용, 5회 실패 시 10분 잠금.
- 파일 도구는 허용 폴더(기본 `~/Documents/AeyeStudio`) 밖을 거부합니다.
- 모든 도구 호출은 `~/.aeyes-agent/audit.log`에 남습니다(파일 내용·클립보드 제외).
