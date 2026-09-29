# Discord Agent 참여 조건

기존 Hermes Discord gateway가 논의에 답한다. 위키 제안 Bot은 별도 메시지 응답기를 실행하지 않는다.

- `@Agent` 멘션 또는 Agent가 쓴 메시지에 회신하면 답한다. 회신 알림을 꺼도 대상 메시지의 작성자로 확인한다.
- 일반 채널과 스레드 모두 명시적으로 요청할 때 답한다. 자동 스레드 생성은 끈다.
- 삭제된 회신 대상, 다른 채널의 회신 참조, 다른 사람에게 보낸 회신에는 참여하지 않는다.
- 기존 허용 사용자·채널 설정은 유지한다. 변경하려면 팀 운영자가 별도로 설정한다.

Hermes `config.yaml`의 `discord`에는 `require_mention: true`, `thread_require_mention: true`, `free_response_channels: []`, `auto_thread: false`를 적용한다. `deploy/hermes/mention_policy_patch.py`에 adapter 경로를 전달해 ping 없는 회신을 지원한다. patch는 기존 gate가 예상과 다르면 중단하며 최초 원문 backup을 남긴다. Hermes 업데이트 후 이 검증과 참여 조건 테스트를 다시 수행한다.

검증: `python -m unittest discover -s deploy/hermes -p 'test_mention_policy.py'`. 실제 서버에서는 Python 문법 검사 후 gateway를 재시작하고 연결 상태를 확인한다. 합성 테스트 성공과 실제 Discord 회신 성공을 구분해 기록한다.
