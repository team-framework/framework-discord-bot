# Hermes 운영

Discord의 문서 질문은 platform_hints.discord.append에서 Wiki·Notion 통합 조회를 먼저 지정한다. 스킬을 열지 않은 턴에도 같은 검색 경로와 근거 예산을 안내하며, 기존 Discord 문체와 다른 플랫폼의 지침을 보존한다. 설정을 다시 적용해도 이 지침을 중복 추가하지 않는다.

## 2026-09-30 Discord 위키 요청 복구

Hermes의 Wiki MCP OAuth 갱신이 400으로 실패해 검색 도구를 등록하지 못했다. 자연어 멘션에는 위키 변경안을 만드는 경로도 없었다.

- MCP 서버의 읽기 전용 서비스 인증을 먼저 배포한다.
- Node Gateway의 위키 멘션 처리 버전을 배포한다. 기존 `/위키-제안`과 참여자 승인 절차를 재사용한다.
- `configure_wiki_runtime.py --enable-mention-routing`으로 기존 서비스 키를 Hermes 환경 파일에 연결한다. 키를 로그나 저장소에 넣지 않는다. 모델은 기존 ChatGPT OAuth의 `gpt-6-luna`, 기본 추론은 `max`, 처리 요청은 `priority`다.
- `wiki_routing_patch.py ~/.hermes/hermes-agent/plugins/platforms/discord/adapter.py`를 적용하고 Hermes Gateway를 재시작한다. 허용 채널의 직접 멘션 갱신 요청은 Node가 처리한다. 일반 대화와 봇 답글 회신은 Hermes가 처리한다.

- 갱신된 `framework-wiki-reader`는 일반 문서 질문에도 `get_sources_context`로 위키와 노션을 함께 확인한다. Wiki 서버의 Notion 기능 배포 후 스킬을 설치하고 MCP 도구 목록을 다시 로드한다.
- `mention_policy_patch.py`는 진행 중인 요청과 같은 작성자·서버·채널의 후속 메시지도 받는다. 작업이 끝나면 일반 채널에서 다시 멘션이나 봇 답글 회신이 필요하다. 다른 작성자의 일반 채널 메시지는 새 요청으로 받지 않는다.
- `configure_wiki_runtime.py`는 `display.busy_input_mode=steer`를 설정한다. 진행 중에 들어온 범위 수정은 현재 에이전트에 전달하고, 최신 제외 지시를 최종 답변에 반영하도록 스킬에서 안내한다. 재시작 전에 진행 중인 요청을 확인한다.
- `framework-thread-summary`와 `framework-wiki-inference`도 갱신한다. 요약과 위키 변경안은 max로 요청한다. 웹은 max를 기본으로 시작하며 사용자가 강도를 선택할 수 있다.

설정 도구는 수정 전 파일을 `~/.hermes/backups/framework-wiki-<timestamp>`에 권한 600으로 보관한다. 라우팅 패치는 원본 옆 `.framework-before-wiki-routing`에 백업하며, 예상한 코드가 없으면 중단한다. 되돌릴 때는 백업을 복원하고 서비스를 재시작한다.

Fast 요청과 실제 처리는 구분한다. `requested_tier=priority`를 보내도 응답이 `default`이면 Fast로 확인했다고 기록하지 않는다. Bridge 로그에는 모델·추론 강도·실제 처리 등급·토큰 사용량만 남긴다.

검증: Python 런타임·권한·백업·라우팅 경계 테스트, Node와 공유한 자연어 12개 사례, Gateway 단위 테스트를 실행한다. 운영 검증은 실제 MCP 도구 조회/호출 및 OAuth 모델 응답으로 확인한다. Discord 공지나 PR을 만드는 실전 시험은 별도 요청 없이 실행하지 않는다.

## MCP 도구 갱신과 Notion 조회

Hermes의 재연결 경로는 새 도구 목록을 받아도 기존 등록이 있으면 게시를 생략했다. Wiki 서버에 Notion 도구를 추가한 후에도 Discord가 기존 7개만 검색하는 원인이다.

- `mcp_refresh_patch.py ~/.hermes/hermes-agent`로 재연결 시 추가·삭제·스키마 변경을 등록한다. 소스가 예상과 다르면 수정 전에 중단한다. 원본은 `.framework-before-mcp-refresh`에 보관하며 재적용은 안전하다.
- `configure_wiki_runtime.py`는 `framework_wiki.refresh_tools_on_keepalive=true`와 Wiki·Notion 통합 조회 스킬을 적용한다. 주기 확인에도 도구 등록을 갱신하여 변경 알림이 없는 서버 배포를 반영한다. 다른 MCP 서버의 확인 방식은 기존 설정을 따른다.
- 진행 중인 요청이 끝난 뒤 Gateway를 재시작한다. 시작 로그의 Wiki 도구 목록에 `search_notion`, `read_notion_page`, `get_sources_context`가 있는지 확인한다.
- Gateway가 사용하는 Python으로 `verify_wiki_runtime.py --exercise-refresh`를 실행한다. `systemctl --user show hermes-gateway --property=MainPID`와 `/proc/<MainPID>/exe`로 실제 Python 경로를 확인한다. 검증 도구도 `hermes_bootstrap`으로 Gateway의 관리 의존성을 불러온다. 별도 프로세스에서 실제 MCP 도구를 7개로 줄인 뒤 재조회하여 10개와 기존 agent 목록을 복구하고, 서비스 인증으로 Notion 원문 근거를 읽는다. 운영 대화 기록과 Discord 메시지는 변경하지 않는다.
- `python -m unittest discover -s deploy/hermes -p 'test_mcp_refresh.py'`로 추가·삭제·같은 개수의 교체·스키마 변경·주기 갱신·백업·상위 소스 변경을 검증한다.

Hermes 업데이트 후 패치를 다시 검증·적용한다. 시작 로그의 등록 개수, 실제 호출 성공, 색인 범위, 모델 답변은 각각 확인한다. Notion 부분 색인을 전체 문서 목록으로 표현하지 않는다.
