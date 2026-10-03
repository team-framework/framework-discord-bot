# Framework Discord Bot

위키 논의와 승인 절차는 [봇 사용법](docs/bot-usage.md), 서버 설정은 [위키 제안 운영](docs/wiki-operations.md)을 참고하세요.

GitHub PR 알림, 스레드 요약, 참여자 승인을 거친 위키 변경 제안을 처리하는 TypeScript 봇이에요.

## 전달 이벤트

- PR 열림: 선택한 팀 역할을 멘션할 수 있어요.
- 리뷰 요청: 요청받은 리뷰어를 멘션해요.
- PR 일반 댓글·코드 리뷰 댓글: PR 작성자를 멘션해요. 작성자가 자신의 PR에 댓글을 남기면 멘션하지 않아요.
- PR 병합: PR 작성자를 멘션해요.

Issue, 브랜치 생성, push, 라벨, workflow, 배포 등은 구독·전송하지 않아요. Discord 메시지는 `allowed_mentions`로 매핑된 사용자와 명시한 역할만 허용해 `@everyone`/`@here`를 절대 호출하지 않아요.

## `/스레드-정리`

Gateway가 `/스레드-정리` 명령을 등록하고, 일반 답글 스레드와 독립 생성 스레드의 최근 500개 메시지를 익명화해 정리합니다. 결과는 `3줄 요약 → 시간순 타임라인 → 다음 작업` 형식으로 원본 채널에 남깁니다. 기본 OpenAI API 구성의 `gpt-5-nano`는 `reasoning.effort: minimal`, `store: false`를 사용합니다. Hermes 구성은 아래 절차에 따라 `gpt-6-luna`를 사용합니다.

## PR 알림용 GitHub App 설정

별도 read-only GitHub App을 만들거나 기존 activity App의 webhook을 이 봇으로 옮긴 뒤, 다음만 구독하세요.

- Pull request
- Pull request review
- Pull request review comment
- Issue comment

PR 알림용 권한은 Pull requests와 Issues의 Read-only면 충분합니다. webhook URL은 `https://<host>/github/webhooks`이며, `.env`의 `GITHUB_WEBHOOK_SECRET`과 동일한 secret을 사용해야 해요. 위키 Draft PR을 만드는 App은 별도로 [위키 제안 운영](docs/wiki-operations.md)의 제한된 쓰기 권한을 사용합니다.

## 실행

```bash
cp .env.example .env
npm install
npm test
npm run typecheck
npm run build
npm start
npm run start:gateway
```

`.env`와 runtime 상태 파일은 절대 커밋하지 마세요.

## 서버 배포

`deploy/compose.yaml`은 localhost `3008`만 열어 둡니다. reverse proxy에서 HTTPS webhook 경로만 `127.0.0.1:3008`로 연결하세요. 기존 `framework-collaboration-harness`의 `activity` 서비스와는 별도 포트·별도 runtime 볼륨을 사용하므로, 새 GitHub App webhook 전환 전까지 기존 알림에 영향을 주지 않습니다.

## Hermes ChatGPT로 스레드 요약하기

`THREAD_SUMMARY_PROVIDER=hermes`를 사용하면 OpenAI API 키 대신 서버 Hermes의 `openai-codex` 인증으로 요약합니다. 모델은 `gpt-6-luna`, 추론은 `low`(Light), Fast 요청은 `service_tier: priority`로 고정합니다. 응답의 실제 처리 등급은 서비스 로그의 `returned_tier`로 확인합니다. 서버가 `default`를 반환하면 우선 처리 적용을 보장할 수 없습니다.

요약 브리지는 도구 실행과 대화 기억 없이 요약만 수행합니다. Hermes 인증 갱신 코드를 사용하며 OAuth 토큰을 Docker 컨테이너에 복사하지 않습니다. Linux 호스트의 `127.0.0.1:8646`에서만 수신하고 별도의 내부 인증 키를 요구합니다.

1. `deploy/hermes/summary_bridge.py`를 서버에 배치합니다. 기본 Hermes 경로는 `/home/chaeyn/.hermes/hermes-agent`입니다.
2. 서버 프로젝트의 `.env.hermes`에 무작위 `HERMES_SUMMARY_KEY`를 생성하고 파일 권한을 `600`으로 설정합니다. 이 파일은 커밋하지 않습니다.
3. `deploy/hermes/framework-thread-summary.service`를 `~/.config/systemd/user/`에 복사하고 `systemctl --user daemon-reload`, `systemctl --user enable --now framework-thread-summary`를 실행합니다.
4. 아래 명령으로 Gateway를 빌드하고 실행합니다. Hermes 구성에서는 이후 재배포에도 두 Compose 파일을 함께 사용합니다.

```bash
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.hermes.yaml up -d --build --no-deps gateway
```

`/healthz`는 브리지 프로세스 상태만 검사합니다. 인증과 모델 사용 가능 여부는 실제 요약 요청으로 검증해야 합니다. 요청이 실패해도 유료 OpenAI API로 자동 전환하지 않습니다.

## 일반 문서 질문의 조회 제한

`deploy/hermes/configure_wiki_budget.py`는 사용자 Hermes 홈에 `framework-wiki-budget` 플러그인을 설치하고 기존 설정을 비공개 백업합니다. 배치 후 Gateway를 재시작합니다. 플러그인은 Discord의 일반 Framework·InnoLive 문서 질문에만 적용됩니다. 심층 조사와 수정·배포 요청은 기존 경로를 사용합니다.

일반 질문은 문서 조회를 3회로 제한하고, 네 번째 모델 요청부터 도구 없이 답변합니다. 90초가 지나면 추가 조회를 중단합니다. 이미 진행 중인 모델·문서 요청은 이 제한으로 취소하지 않으므로 전체 응답 시간의 상한은 아닙니다. 과거 도구 출력은 요청에서 제외하고 최근 일반 대화는 8,000자 이내로 선택합니다. 이번 질문의 도구 호출과 결과 쌍, 시스템 지침, 저장된 대화 기록은 보존합니다. 기존 `gpt-6-luna`·`max` 추론 설정을 유지합니다.

```bash
python deploy/hermes/configure_wiki_budget.py --hermes-home /home/chaeyn/.hermes
python -m unittest discover -s deploy/hermes -p 'test_*.py'
```
