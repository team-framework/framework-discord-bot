# Hermes 운영

## 2026-09-30 Discord 위키 요청 복구

Hermes의 Wiki MCP OAuth 갱신이 400으로 실패해 검색 도구를 등록하지 못했다. 자연어 멘션에는 위키 변경안을 만드는 경로도 없었다.

- MCP 서버의 읽기 전용 서비스 인증을 먼저 배포한다.
- Node Gateway의 위키 멘션 처리 버전을 배포한다. 기존 `/위키-제안`과 참여자 승인 절차를 재사용한다.
- `configure_wiki_runtime.py --enable-mention-routing`으로 기존 서비스 키를 Hermes 환경 파일에 연결한다. 키를 로그나 저장소에 넣지 않는다. 모델은 기존 ChatGPT OAuth의 `gpt-6-luna`, 기본 추론은 `max`, 처리 요청은 `priority`다.
- `wiki_routing_patch.py ~/.hermes/hermes-agent/plugins/platforms/discord/adapter.py`를 적용하고 Hermes Gateway를 재시작한다. 허용 채널의 직접 멘션 갱신 요청은 Node가 처리한다. 일반 대화와 봇 답글 회신은 Hermes가 처리한다.
- `framework-thread-summary`와 `framework-wiki-inference`도 갱신한다. 요약과 위키 변경안은 max로 요청한다. 웹은 max를 기본으로 시작하며 사용자가 강도를 선택할 수 있다.

설정 도구는 수정 전 파일을 `~/.hermes/backups/framework-wiki-<timestamp>`에 권한 600으로 보관한다. 라우팅 패치는 원본 옆 `.framework-before-wiki-routing`에 백업하며, 예상한 코드가 없으면 중단한다. 되돌릴 때는 백업을 복원하고 서비스를 재시작한다.

Fast 요청과 실제 처리는 구분한다. `requested_tier=priority`를 보내도 응답이 `default`이면 Fast로 확인했다고 기록하지 않는다. Bridge 로그에는 모델·추론 강도·실제 처리 등급·토큰 사용량만 남긴다.

검증: Python 런타임·권한·백업·라우팅 경계 테스트, Node와 공유한 자연어 12개 사례, Gateway 단위 테스트를 실행한다. 운영 검증은 실제 MCP 도구 조회/호출 및 OAuth 모델 응답으로 확인한다. Discord 공지나 PR을 만드는 실전 시험은 별도 요청 없이 실행하지 않는다.
