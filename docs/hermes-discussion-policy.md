# Discord Agent 참여 조건

기존 Hermes Discord gateway가 일반 논의에 답한다. Node gateway는 명시적인 위키 갱신 요청과 `/위키-제안`을 처리한다.

허용된 공개 위키 논의 채널에서 `@Bot`을 직접 멘션하며 “위키 갱신해”, “위키에 반영해 줘”처럼 명시적으로 요청하면 Node gateway가 그 요청 메시지 한 건으로 변경안을 만든다. 제안과 변경안은 같은 채널에서 검토한다. 참여자가 승인해야 Draft PR을 만들며, 멘션만으로 위키 원문을 바꾸지 않는다. 질문, 부정 요청, 일반 대화와 허용되지 않은 채널의 멘션은 기존 Hermes가 처리한다. 답글만 단 요청은 이 경로에 포함하지 않는다.

- `@Agent` 멘션 또는 Agent가 쓴 메시지에 회신하면 답한다. 회신 알림을 꺼도 대상 메시지의 작성자로 확인한다.
- 일반 채널과 스레드 모두 명시적으로 요청할 때 답한다. 자동 스레드 생성은 끈다.
- 삭제된 회신 대상, 다른 채널의 회신 참조, 다른 사람에게 보낸 회신에는 참여하지 않는다.
- 기존 허용 사용자·채널 설정은 유지한다. 변경하려면 팀 운영자가 별도로 설정한다.

Hermes `config.yaml`의 `discord`에는 `require_mention: true`, `thread_require_mention: true`, `free_response_channels: []`, `auto_thread: false`를 적용한다. `deploy/hermes/mention_policy_patch.py`에 adapter 경로를 전달해 ping 없는 회신을 지원한다. patch는 기존 gate가 예상과 다르면 중단하며 최초 원문 backup을 남긴다. Hermes 업데이트 후 이 검증과 참여 조건 테스트를 다시 수행한다.

검증: `python -m unittest discover -s deploy/hermes -p 'test_mention_policy.py'`. 실제 서버에서는 Python 문법 검사 후 gateway를 재시작하고 연결 상태를 확인한다. 합성 테스트 성공과 실제 Discord 회신 성공을 구분해 기록한다.
