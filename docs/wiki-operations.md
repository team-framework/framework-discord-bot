# 위키 제안 운영 설정

Node 24의 내장 SQLite를 사용한다. `runtime` 디렉터리는 gateway 컨테이너에 영구 마운트한다. DB에 원본 snapshot, 참여자, 정확한 변경안, 승인 hash, outbox, 수집 cursor를 저장한다. 디렉터리·DB 권한은 각각 700·600으로 생성한다. `.env`·키·DB는 저장소에 올리지 않는다.

## 인증 연결

- `WIKI_SERVICE_URL`·`WIKI_SERVICE_KEY`: 위키 서버의 읽기 전용 `/api/context`, `/api/note` API. `Authorization: Bearer` 헤더를 사용한다.
- `HERMES_WIKI_URL`·`HERMES_WIKI_KEY`: 사설 요약/제안 API. 서버의 `openai-codex` OAuth와 `gpt-6-luna`, `low`를 사용한다. 봇에 OAuth 토큰을 복사하지 않는다.
- `WIKI_GITHUB_APP_CLIENT_ID`·`WIKI_GITHUB_APP_PRIVATE_KEY_PATH`: wiki 저장소에 설치된 App. Contents write와 Pull requests write만 요청한다. PEM은 읽기 전용으로 마운트한다.
- `WIKI_TRACKING_ISSUE`: 미리 만든 지속 추적 이슈. 현재 wiki#73이다. 생성 브랜치는 `feat/discord-wiki-<proposal-id>/#73`, PR은 Draft다. PR 본문은 `Refs #73`을 쓰므로 지속 이슈를 닫지 않는다.

`WIKI_GITHUB_TOKEN`은 명시적으로 구성한 서버 자동화의 대체 인증이다. 기본 구성은 App을 사용한다.

## 대상과 제한

`WIKI_DISCORD_GUILD_ID`를 대상 Framework 서버로 지정한다. 카테고리·일반 채널·포럼 ID는 `.env.example`에 기록한 범위를 사용한다. Discord bot에 View channel, Read message history, Send messages, Attach files와 Message Content Intent가 필요하다. 현재 서버 멤버 조회 권한도 실제 API로 확인한다.

`WIKI_PROPOSALS_ENABLED=true`로 `/위키-제안`을 등록한다. `WIKI_SCHEDULE_ENABLED=true`로 한국 시간 자정 수집을 켠다. 시작 시 지나간 최신 자정의 작업이 완료되지 않았으면 해당 일자의 범위를 처리한다. 배포 전 설정과 대상 권한을 확인한 뒤 켠다.

기본 제한은 snapshot당 300개·직렬화된 출처 24,000자, 하루 3,000개다. 최신 메시지부터 거꾸로 읽는 동안 고정 상한과 페이지 원문을 SQLite buffer에 저장한다. 원래 하한에 도달한 뒤 오래된 메시지부터 snapshot을 생성한다. 캡에 도달하면 `backlog:<channel>` 상태를 남긴다. 읽지 않은 범위를 수집 cursor로 처리하지 않는다.

단일 메시지가 출처 제한보다 크면 `oversized:<channel>:<message>`를 남기고 그 채널의 다음 범위를 보류한다. 운영자는 `WIKI_SNAPSHOT_CHARS`를 최대 100,000자 이내에서 높여 원문을 재처리한다. 사람이 별도로 검토한 결정은 새 메시지 범위로 `/위키-제안`을 실행할 수 있다. 새 범위의 제안은 원본 메시지의 예약 backlog를 해소하지 않는다.

scan cursor는 snapshot을 영구 저장한 범위를 의미한다. finalized cursor는 Draft PR을 만든 범위의 마지막 메시지다. 둘 다 wiki main merge나 재색인을 의미하지 않는다. 개별 제안 기록에서 승인·거절·stale·PR 상태를 확인한다.

## 재시도와 승인

사람이 승인하기 전에 Discord 원본의 작성자·본문·수정 시각·reply·첨부 metadata와 실제 GitHub blob을 다시 읽는다. CDN URL의 갱신용 query signature는 source hash에서 제외한다. 승인자는 snapshot에 있는 사람 작성자이며 현재 guild member여야 한다. guild·channel·원래 안내 메시지·현재 제안 버전을 확인한다.

승인 상태와 PR outbox를 하나의 transaction에 저장한다. 승인 뒤에는 LLM을 호출해 변경 내용을 새로 만들지 않는다. GitHub PR marker와 제안별 고정 브랜치로 결과가 불확실한 요청을 복구한다. 같은 버튼을 다시 누르면 새 PR을 생성하지 않는다. PR 실패는 1분 뒤 재시도하고, 작업 lease는 최대 10분이다. 결론 수정 중 중단된 작업은 10분이 지나고 활성 생성 lease가 없을 때 이전 미승인 변경안으로 복구한다.

## 배포 전 확인

```sh
npm run typecheck
npm test
npm run build
npm run wiki:preview -- --channel 대상-ID --count 20 --output /tmp/wiki-review.md
```

preview는 실제 대화를 읽고 제안을 생성하지만 Discord에 게시하지 않는다. 원문·diff는 지정한 private 파일에 저장하고 터미널에는 개수·hash·파일 수만 출력한다. 검토를 마친 뒤 `--post`를 붙이면 승인 버튼이 있는 변경안을 올린다. 사람이 승인하면 gateway의 outbox worker가 Draft PR을 만든다. 테스트용 승인자를 사칭하지 않는다.

기존 `/스레드-정리`와 Hermes 대화 gateway를 함께 유지한다. 자연어 응답은 기존 Hermes만 담당하고, 이 gateway는 slash command·제안·승인만 처리한다.

제안 생성은 source hash별 10분 SQLite lease로 중복 실행을 막는다. 안내 메시지를 보내는 동안 승인이나 수정판이 생기면 안내 ID와 상태만 조건부 갱신한다. 이전 네트워크 응답으로 승인 내용이나 새판을 덮어쓰지 않는다. 일일 한도에 도달하기 전에 발견한 채널의 최초 하한을 저장하고, archive 페이지 위치도 다음 실행에 이어 읽는다. 접근할 수 없는 채널은 `blocked:<channel>`에 남기며 cursor를 전진시키지 않는다.

읽기 전용 preview의 JSON 출력에는 모델, 추론 강도, 입력 문자 수, 검색 근거 문자 수와 공급자가 반환한 토큰 사용량이 포함된다. 사용량이 없으면 추정한 값을 채우지 않는다. 제안·승인·거절·stale·published 건수는 SQLite의 proposals 상태로 집계할 수 있다. Discord 원문과 변경안 파일은 공개 분석 자료에 넣지 않는다.

서버의 `deploy/prepare-wiki-preview.py`는 기존 봇과 위키의 인증 설정을 별도 preview 폴더에 복사한다. secret 값은 출력하지 않는다. 이 스크립트는 서비스를 시작하거나 Discord 메시지를 보내지 않는다. preview는 Node24 컨테이너에서 실행하고 App private key를 read-only로 mount한다.

Hermes 배포 overlay는 `WIKI_GITHUB_APP_PRIVATE_KEY_HOST_PATH`의 파일을 `/run/secrets/wiki-app.pem`에 read-only로 mount한다. 컨테이너의 `WIKI_GITHUB_APP_PRIVATE_KEY_PATH`를 그 경로로 설정한다. Compose의 host path 치환에는 `docker compose --env-file ../.env -f compose.yaml -f compose.hermes.yaml`을 사용한다. 기존 `.env`, `.env.hermes`, runtime을 소스 동기화 대상에서 제외하고 서버 안에서 백업한 뒤 필요한 위키 설정만 병합한다.

### 2026-09-29 초기 배포 검증

기존 소스·runtime·환경과 Docker 이미지를 서버 안에 백업한 뒤 기존 봇에 위키 기능을 배포했다. 위키 설정과 팀 채널 ID를 병합했고, 기존 알림 환경은 보존했다. Node24 Gateway는 Discord에 연결됐으며 guild 명령 조회에서 `/스레드-정리`, `/위키-제안`을 확인했다. 기존 webhook 서비스는 HTTP 200, Docker health `healthy`로 확인했다.

Gateway를 재시작한 뒤 SQLite의 배포 확인 기록이 유지됐다. 확인 당시 제안·승인 건수는 0건이었고, Discord 메시지 게시나 시험 승인은 실행하지 않았다. 이 단계의 `WIKI_SERVICE_URL`은 내부 preview의 3110 포트, `WIKI_SCHEDULE_ENABLED`는 `false`다. 웹 전환과 정기 수집 활성화는 이후 운영 단계에서 별도로 확인한다.

무게시 preview는 branding·global 채널에서 각각 실제 메시지 20건을 읽고 Hermes와 위키 검색을 호출했다. 두 범위 모두 `no_update`로 끝났다. 실제 Discord 대화 응답, 변경안 게시, 참여자 승인, Draft PR 생성까지 이어지는 E2E는 수행하지 않았다. 변경안 생성·승인·PR 복구는 합성 입력과 mocked API 테스트로 검증했다.
