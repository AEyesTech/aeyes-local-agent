# aeyes-local-agent

AeyeStudio AI 채팅이 **내 PC**의 파일·엑셀·클립보드·앱·셸을 쓸 수 있게 하는 로컬 MCP 에이전트입니다.
AeyeStudio 서버가 PC에 접속하지 않습니다 — 크롬의 AeyeStudio 탭이 `127.0.0.1`의 에이전트에 붙어 요청을 중계합니다.

## 실행

```bash
npx aeyes-local-agent
```

터미널에 표시되는 6자리 코드를 AeyeStudio **설정 > 내 PC 연결**에 입력하면 연결됩니다.
실행 중 명령: `p` 새 코드, `u` 모든 연결 해제, `g` 항상 허용 목록 보기, `r` 항상 허용 모두 지우기, `q` 종료.

옵션: `--allow-dir <경로>`(허용 폴더 추가), `--port <47821-47830>`, `--config-dir <경로>`.
파일시스템 루트, 홈 폴더 자체나 그 상위, 설정 폴더를 포함하는 폴더는 `--allow-dir`로 줄 수 없습니다(종료 코드 1).

### 동작 주의사항

- `aeyes-local-agent unpair --all` 명령은 에이전트 실행 중에는 거부됩니다(종료 코드 1). 터미널에서 `u`를 눌러 모든 연결을 해제하거나, 에이전트를 먼저 중지한 후 사용하세요.
- 같은 설정 폴더로 에이전트를 두 번 띄울 수 없습니다("이미 에이전트가 실행 중입니다(pid N)").
- 터미널 입력이 없는 환경(터미널 없이 시작되었거나 stdin이 닫힌 경우)에서는 PC 확인이 필요한 호출이 모두 즉시 거부됩니다 — `clipboard_read`, `fs_move`, `fs_delete`, `open_path`, `open_app`, `shell_exec`, 기존 파일 덮어쓰기. 확인이 필요 없는 도구(파일 목록·읽기·검색, `excel_read`, 새 파일 쓰기, `fs_mkdir`, `clipboard_write`)는 계속 작동합니다.
- 확인이 10개 넘게 밀려 있으면 새 확인은 즉시 거부됩니다.

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

확인 프롬프트에서 `a`(항상 허용)를 고르면 프롬프트에 표시된 범위는 다시 묻지 않습니다. 범위는 좁게 잡습니다.

- `shell_exec`: 명령 첫 단어 단위(예: `shell_exec:git`). 단 `` ; & | $ ` ( ) { } < > `` 문자나 줄바꿈이 들어간 명령, `=` 대입이 있는 명령,
  경로로 시작하는 명령, `sudo`·`env`·`xargs`·`bash`·`powershell`·`node`·`python`·`open` 같은 래퍼·인터프리터 명령은 항상 허용할 수 없고 매번 묻습니다.
- `open_path`: 웹 주소(http/https)만 `open_path:url` 로 항상 허용할 수 있습니다. 파일·폴더 열기는 매번 묻고, 실행 파일·실행기 형식(`.app`, `.exe`, `.bat`, `.sh`, `.command`, `.lnk` 등)은 열지 않습니다.
- `open_app`: 인자 없이 실행할 때만 앱 이름 단위로 항상 허용할 수 있습니다.
- 항상 허용 목록은 실행 중 터미널에서 `g` 로 보고 `r` 로 모두 지울 수 있습니다.

## 보안

- `127.0.0.1`에만 열리고, `Host`가 `127.0.0.1`/`localhost`가 아니면 거부합니다(DNS 리바인딩 방어).
- `https://studio.aeyes.dev`, `https://seller-ai-studio.vercel.app`에서 온 요청만 받습니다.
- 페어링 토큰은 해시로만 저장합니다. 코드는 5분·1회용, 5회 실패 시 10분 잠금.
- 파일 도구는 허용 폴더(기본 `~/Documents/AeyeStudio`, Windows 는 OneDrive 문서 폴더가 있으면 그 아래) 밖을 거부합니다. 심볼릭 링크는 실제 경로 기준으로 검사하고, 끊어진 링크는 거부합니다. 설정 폴더는 허용 폴더 안에 있어도 접근할 수 없습니다.
- 확인 프롬프트는 원격에서 온 글의 제어 문자를 보이는 형태로 바꿔 표시합니다(요약 500자까지).
- 설정·감사 로그 위치: macOS/Linux `~/.aeyes-agent/`, Windows `%APPDATA%\aeyes-agent\`.
- 모든 도구 호출은 설정 폴더의 `audit.log`에 남습니다(파일 내용·클립보드 제외).

## 저장소 구조

```
aeyes-local-agent/
├── .github/workflows/ci.yml     # GitHub Actions CI
├── packages/core/               # aeyes-local-agent (npm 패키지)
│   ├── src/
│   │   ├── cli.ts               # 진입점(인자 처리, 터미널 명령)
│   │   ├── server.ts            # 127.0.0.1 HTTP 서버(Host·Origin·CORS·/pair·/mcp)
│   │   ├── mcp.ts               # 요청별 MCP 서버, 확인·감사 로그 연결
│   │   ├── terminal.ts          # 터미널 로컬 확인 프롬프트
│   │   ├── config.ts            # 설정 파일(config.json)
│   │   ├── paths.ts             # 허용 폴더 경로 검사
│   │   ├── audit.ts             # 감사 로그
│   │   ├── errors.ts, version.ts, index.ts
│   │   ├── policy/              # 확인 게이트·항상 허용 범위(gate.ts, confirmer.ts)
│   │   ├── security/            # 페어링·Origin·속도 제한
│   │   └── tools/               # 15개 도구(fs, excel, clipboard, open, shell)
│   ├── test/                    # 단위·통합 테스트(vitest)
│   ├── package.json
│   └── README.md                # npm 패키지 문서
├── package.json
├── pnpm-workspace.yaml
└── README.md                    # 이 파일
```
