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

단일 메시지가 출처 제한보다 크면 `oversized:<channel>:<message>`를 남기고 그 채널의 다음 범위를 보류한다. 사람이 원문을 검토해 짧은 결정 메시지를 남기거나, 출처 제한을 높여 재처리한다. 원문을 자동으로 잘라 사실을 누락시키지 않는다.

scan cursor는 snapshot을 영구 저장한 범위를 의미한다. finalized cursor는 Draft PR을 만든 범위의 마지막 메시지다. 둘 다 wiki main merge나 재색인을 의미하지 않는다. 개별 제안 기록에서 승인·거절·stale·PR 상태를 확인한다.

## 재시도와 승인

사람이 승인하기 전에 Discord 원본의 작성자·본문·수정 시각·reply·첨부 metadata와 실제 GitHub blob을 다시 읽는다. CDN URL의 갱신용 query signature는 source hash에서 제외한다. 승인자는 snapshot에 있는 사람 작성자이며 현재 guild member여야 한다. guild·channel·원래 안내 메시지·현재 제안 버전을 확인한다.

승인 상태와 PR outbox를 하나의 transaction에 저장한다. 승인 뒤에는 LLM을 호출해 변경 내용을 새로 만들지 않는다. GitHub PR marker와 제안별 고정 브랜치로 결과가 불확실한 요청을 복구한다. 같은 버튼을 다시 누르면 새 PR을 생성하지 않는다. PR 실패는 1분 뒤 재시도하고, 작업 lease는 최대 10분이다. 결론 수정 중 중단된 작업은 5분 뒤 이전 미승인 변경안으로 복구한다.

## 배포 전 확인

```sh
npm run typecheck
npm test
npm run build
npm run wiki:preview -- --channel 대상-ID --count 20 --output /tmp/wiki-review.md
```

preview는 실제 대화를 읽고 제안을 생성하지만 Discord에 게시하지 않는다. 원문·diff는 지정한 private 파일에 저장하고 터미널에는 개수·hash·파일 수만 출력한다. 검토를 마친 뒤 `--post`를 붙이면 승인 버튼이 있는 변경안을 올린다. 사람이 승인하면 gateway의 outbox worker가 Draft PR을 만든다. 테스트용 승인자를 사칭하지 않는다.

기존 `/스레드-정리`와 Hermes 대화 gateway를 함께 유지한다. 자연어 응답은 기존 Hermes만 담당하고, 이 gateway는 slash command·제안·승인만 처리한다.
