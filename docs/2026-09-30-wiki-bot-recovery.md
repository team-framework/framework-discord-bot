# Discord 위키 갱신 복구와 모델 설정

2026-09-30 운영 서버에서 확인한 결과다. Discord로 실제 공지하거나 위키 변경 PR을 시험 목적으로 만들지는 않았다.

## 사용 흐름

- 위키 대상 채널에서 `@Framework Bot 이 내용으로 위키 갱신해`라고 요청한다.
- Bot이 요청 메시지를 근거로 변경안을 만들고 같은 채널에 확인 요청을 보낸다.
- 범위에 포함된 대화 참여자가 내용을 확인하고 승인하면 Draft PR을 만든다.
- 여러 메시지의 논의는 `/위키-제안`으로 시작·끝 또는 개수를 지정한다.
- PR을 병합해야 위키에 반영된다. 변경안 생성과 위키 반영은 별도 단계다.

직접 멘션 갱신 요청은 해당 메시지 한 개만 포함한다. 이전 대화 전체가 필요한 경우 범위를 지정해야 한다. 일반 멘션·Bot 답글 회신은 Hermes가 계속 응답한다.

## 장애 원인과 수정

1. Hermes의 Wiki MCP OAuth 갱신 요청이 400으로 실패했다. 백그라운드 서비스가 브라우저 재인증을 수행하지 못해 위키 도구가 등록되지 않았다.
2. Node Gateway는 슬래시 명령만 받아 자연어 갱신 요청을 변경안 생성으로 연결하지 못했다.
3. 실제 max 모델 검증에서 `old_text`가 문단 일부만 선택되어 원문 블록 검증에 걸렸다. 생성 지시와 제한된 재생성 처리를 보완했다. 원문·해시·문단 경계 검증은 유지한다.

MCP 서버에 읽기 전용 서비스 인증을 추가하고, 기존 서버 키를 Hermes 환경 파일에서 참조하도록 변경했다. 허용된 도구는 검색·문서·문단·위키 상태 조회 7개다. 이 연결은 위키 쓰기 권한을 제공하지 않는다.

Node Gateway가 명시적 갱신 멘션을 받아 기존 승인 절차를 실행한다. Hermes는 같은 요청을 중복 처리하지 않으며, 허용된 서버와 채널 범위를 양쪽에서 확인한다. 요청 중복·재시도 상태는 SQLite에 보관한다.

## 모델과 Fast 확인

| 경로 | 모델 | 추론 | Fast 요청 | 실제 응답 확인 |
| --- | --- | --- | --- | --- |
| Hermes 일반 Discord 대화 | GPT-6 Luna | 기본 max | priority | 운영 설정과 Gateway 재시작 확인 |
| Discord 스레드 요약 | GPT-6 Luna | max | priority | 성공, 반환 등급 default |
| Discord 위키 변경안 | GPT-6 Luna | max | priority | 운영 모델 호출과 문서 검증 실행 |
| 웹 Wiki Agent | GPT-6 Luna | 기본 max, 선택 가능 | priority | 성공, 반환 등급 default |

웹의 `/chat` 화면에서 추론 수준 `최대`가 기본으로 선택된 것을 확인했다. 기존 `none/low/medium/high/xhigh/max` 선택 기능은 유지한다.

OAuth 모델 응답의 `reasoning.effort=max`를 직접 확인했다. `priority`를 보내도 실제 응답은 `default`였다. 공식 API의 별칭인 `fast`를 직접 보내는 검증은 400으로 거절됐다. 따라서 Fast 요청 설정은 적용했지만 실제 Fast 처리로 확인했다고 기록하지 않는다. API 키로 인증을 바꾸지 않았다.

- [GPT-6 Luna 추론 수준](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Fast 요청과 반환 처리 등급](https://developers.openai.com/api/docs/guides/fast-mode)

## 공동 작성자

원본 메시지에서 bot·webhook을 제외한 작성자를 다시 추출해 저장된 참여자 목록과 대조한다. 게시 전에 GitHub API로 실제 사용자 login과 숫자 ID를 확인한다.

커밋에는 `Co-authored-by: login <id+login@users.noreply.github.com>`을 추가한다. 개인 이메일은 수집하지 않는다.

- 운영 연결: Discord 계정 7개 → GitHub 팀원 6명.
- 대형님의 Discord 두 계정은 `daehyeong2` 한 명으로 합친다.
- 태진 멘토님은 사용자의 지시에 따라 공동 작성자에서 제외한다.
- 기존 `itjzb` 오타를 확인하고 `itzjb`로 수정했다.
- 매핑이 없는 참여자나 검증되지 않은 계정이 있으면 게시를 멈추고 관리자에게 설정 확인 항목을 알린다.
- 공동 작성자 제외는 기존 참여자 승인 권한을 바꾸지 않는다.

운영 컨테이너에서 실제 GitHub 인증으로 8개 Discord 계정(멘토 포함)을 검증해 공동 작성자 6명, 멘토 제외, 대형님 중복 제거를 확인했다. 검증 호출은 Git 커밋이나 PR을 생성하지 않았다.

## 검증 근거

- MCP 인증 수정: [MCP PR #27](https://github.com/team-framework/framework-llm-wiki-mcp/pull/27), 배포 성공.
- 웹·API 기본 max: [MCP PR #29](https://github.com/team-framework/framework-llm-wiki-mcp/pull/29), [배포 #36660513543 성공](https://github.com/team-framework/framework-llm-wiki-mcp/actions/runs/36660513543).
- Bot 라우팅·공동 작성자: [Bot PR #8](https://github.com/team-framework/framework-discord-bot/pull/8), 운영 컨테이너 빌드·재시작·Gateway READY 확인.
- Hermes의 실제 MCP 도구 7개 등록 및 `get_context` 호출 성공. 2,500자 예산으로 근거 1개와 후속 조회 커서를 받았다.
- Node Bot 테스트 47개, Python 런타임·라우팅·요약 테스트 11개 통과(문단 재생성 보완 전).
- MCP/웹 Node 테스트 67개, 타입 검사·웹 빌드, Python 추론 요청 테스트 통과.

실제 승인 버튼을 누르고 위키 PR을 생성하는 최종 흐름은 이번 운영 검증에서 실행하지 않았다. 게시 없이 모델 요청과 원문 검증을 수행한 결과는 아래에 추가한다.

## 운영 호출 측정값

| 검증 | 입력 토큰 | 출력 토큰 | 결과 |
| --- | ---: | ---: | --- |
| 스레드 요약 bridge | 119 | 372 | max 요청, 정상 요약 JSON |
| 웹 위키 bridge 기본값 | 33 | 30 | max, 정상 답변, 2.55초 |
| OAuth 모델 설정 직접 검증 | 16 | 35 | 응답 모델 Luna, 반환 추론 max |
| One Store 입력 재현, 보완 전 | 6,293 | 1,548 | 문단 일부 선택으로 원문 경계 검증에서 중단 |

모든 성공 응답의 실제 처리 등급은 default다. 출력 토큰에는 추론 토큰이 포함돼 있으므로 별도로 더하지 않는다. 이 표는 서버 Bot 검증 호출의 사용량이며, 개발에 사용한 ChatGPT 작업 세션 토큰과는 별도다.

## 문단 경계 보완 후 재현 결과

제공된 One Store 요청 문구로 검증용 snapshot을 구성하고 운영 OAuth 모델·위키 검색·GitHub 원문 조회를 실행했다. 실제 Discord 메시지에서 추출한 snapshot은 아니다.

- 결과: 기존 `클라이언트.md`의 수정안 생성, 상태 pending. One Store 앱 링크를 포함했다.
- 모델 호출: 1회. 첫 응답이 검증을 통과해 자동 재생성은 사용하지 않았다.
- 입력 6,336, 출력 3,334, 합계 9,670토큰. 출력 중 추론은 2,792토큰이다.
- Bot 최종 테스트 50개 통과. 모의 테스트로 잘못된 첫 응답 → 유효한 두 번째 응답, 두 번 실패 시 중단, 인증·요청 제한·원문 변경 시 재생성하지 않음, 사용량 합산을 확인했다.
- 검증용 프로세스는 Discord 전송·승인·Git 커밋·PR 생성·proposal DB 저장을 호출하지 않았다. 따라서 실제 위키가 갱신됐다고 판단하지 않는다.

보완 코드와 이 기록은 [Bot 이슈 #9](https://github.com/team-framework/framework-discord-bot/issues/9)에서 관리한다.
