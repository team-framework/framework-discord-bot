# Framework Discord Bot

GitHub PR 활동만 Discord로 보내는 TypeScript 봇이에요. 기존 `framework-collaboration-harness`의 지연 알림·스레드 요약·동기화 기능과 분리합니다.

## 전달 이벤트

- PR 열림: 선택한 팀 역할을 멘션할 수 있어요.
- 리뷰 요청: 요청받은 리뷰어를 멘션해요.
- PR 일반 댓글·코드 리뷰 댓글: PR 작성자를 멘션해요. 작성자가 자신의 PR에 댓글을 남기면 멘션하지 않아요.
- PR 병합: PR 작성자를 멘션해요.

Issue, 브랜치 생성, push, 라벨, workflow, 배포 등은 구독·전송하지 않아요. Discord 메시지는 `allowed_mentions`로 매핑된 사용자와 명시한 역할만 허용해 `@everyone`/`@here`를 절대 호출하지 않아요.

## GitHub App 설정

별도 read-only GitHub App을 만들거나 기존 activity App의 webhook을 이 봇으로 옮긴 뒤, 다음만 구독하세요.

- Pull request
- Pull request review
- Pull request review comment
- Issue comment

권한은 Pull requests와 Issues의 Read-only면 충분합니다. webhook URL은 `https://<host>/github/webhooks`이며, `.env`의 `GITHUB_WEBHOOK_SECRET`과 동일한 secret을 사용해야 해요.

## 실행

```bash
cp .env.example .env
npm install
npm test
npm run typecheck
npm run build
npm start
```

`.env`와 runtime 상태 파일은 절대 커밋하지 마세요.

## 서버 배포

`deploy/compose.yaml`은 localhost `3008`만 열어 둡니다. reverse proxy에서 HTTPS webhook 경로만 `127.0.0.1:3008`로 연결하세요. 기존 `framework-collaboration-harness`의 `activity` 서비스와는 별도 포트·별도 runtime 볼륨을 사용하므로, 새 GitHub App webhook 전환 전까지 기존 알림에 영향을 주지 않습니다.
