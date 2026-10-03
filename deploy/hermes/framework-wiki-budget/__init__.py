"""Request-only context selection and read budgets using Hermes plugin contracts."""
from copy import deepcopy
from dataclasses import dataclass, field
import logging
import re
import threading
import time

log = logging.getLogger(__name__)
TOPIC = re.compile(r'framework|innolive|inno live|이노라이브|위키|노션|notion', re.I)
LOOKUP = re.compile(r'알려|설명|요약|정리|찾아|변천|변화|현황|목록|링크|무엇|뭐|어떻|읽|볼 수|show|explain|summari|history|list|find', re.I)
DEEP_OR_WRITE = re.compile(r'심층|자세히|상세히|꼼꼼|전부|모든 문서|끝까지|deep research|exhaustive|코드|로그|실서버|운영 서버|GPU 서버|실제 실행|고쳐|수정해|수정해줘|작성해|구현해|코드.*(?:분석|확인|검토)|배포|커밋|실행해|갱신|업데이트해|삭제|등록해|보내|전송', re.I)
FOLLOWUP = re.compile(r'이 문서|그 문서|이 모델|그 모델|방금|앞서|이 중|그중|그러면|그럼|후속')
SOURCE = 'mcp__framework_wiki__'
READS = {'get_sources_context', 'search_notion', 'read_notion_page', 'search', 'get_context', 'get_note_outline', 'read_sections', 'get_wiki_status', 'list_notes'}
INSTRUCTION = '일반 문서 질문: get_sources_context(sources="all", limit=8, max_chars=12000)를 한 번 조회하고, 필요하면 원문을 최대 2회 보충한다. 제목 검색을 반복하지 않는다. 근거가 확보되면 원문 링크와 함께 답한다. 3회의 문서 조회 또는 3회의 도구 단계 뒤에는 조회를 끝내고 확인 범위와 남은 불확실성을 밝힌다. 요청하지 않은 심층 조사와 skill 수정을 시작하지 않는다.'


def text_of(message):
    content = message.get('content', '')
    if isinstance(content, str): return content
    if isinstance(content, list):
        return '\n'.join(x.get('text', '') for x in content if isinstance(x, dict) and isinstance(x.get('text'), str))
    return ''


def ordinary_question(text, history=()):
    if DEEP_OR_WRITE.search(text) or not LOOKUP.search(text): return False
    if TOPIC.search(text): return True
    return bool(FOLLOWUP.search(text) and any(TOPIC.search(text_of(m)) for m in [row for row in history if row.get('role') == 'user'][-3:]))


def select_messages(messages, old_chars=8000):
    """Keep the current user and all current tool pairs; select plain previous context."""
    start = next((i for i in range(len(messages)-1, -1, -1) if messages[i].get('role') == 'user'), None)
    if start is None: return deepcopy(messages)
    prefix = [deepcopy(m) for m in messages[:start] if m.get('role') in ('system', 'developer')]
    previous = []
    for m in reversed(messages[:start]):
        if m.get('role') not in ('user', 'assistant') or m.get('tool_calls') or m.get('type') == 'function_call': continue
        content = text_of(m)
        if not content: continue
        budget = max(0, old_chars - sum(len(x['content']) for x in previous))
        if not budget: break
        cap = min(budget, 4000)
        clipped = content if len(content) <= cap else content[:max(0, cap-1000)] + content[-min(1000, cap):]
        previous.append({'role': m['role'], 'content': clipped})
        if len(previous) >= 4: break
    # Retain alternating plain conversation, without dangling old tool calls.
    previous.reverse()
    while previous and previous[-1]['role'] != 'assistant': previous.pop()
    return prefix + previous + deepcopy(messages[start:])


@dataclass
class Turn:
    started: float
    reads: int = 0
    catalog: int = 0
    seen: set = field(default_factory=set)


class Budget:
    def __init__(self, clock=time.monotonic):
        self.clock = clock; self.turns = {}; self.lock = threading.RLock()

    def key(self, session_id='', turn_id='', task_id='', **kwargs):
        return (session_id, turn_id or task_id)

    def begin(self, user_message='', conversation_history=(), platform='', **ids):
        if platform != 'discord' or not ordinary_question(str(user_message), conversation_history): return None
        with self.lock:
            now = self.clock()
            self.turns = {k: v for k, v in self.turns.items() if now-v.started < 600}
            self.turns[self.key(**ids)] = Turn(now)
        return {'context': INSTRUCTION}

    def request(self, request, api_call_count=0, **ids):
        with self.lock:
            turn = self.turns.get(self.key(**ids))
            if turn is None: return None
            payload = deepcopy(request)
            key = 'messages' if isinstance(payload.get('messages'), list) else 'input'
            if isinstance(payload.get(key), list):
                before = len(str(payload[key]))
                payload[key] = select_messages(payload[key])
                log.info('Wiki request context selected: chars=%s->%s reads=%s', before, len(str(payload[key])), turn.reads)
            if turn.reads >= 3 or turn.catalog >= 8 or api_call_count >= 4 or self.clock()-turn.started >= 90:
                payload['tools'] = []
                payload.pop('tool_choice', None)
                payload.pop('parallel_tool_calls', None)
        return {'request': payload, 'source': 'framework-wiki-budget', 'reason': 'ordinary document question'}

    def tool(self, tool_name, args, tool_call_id='', **ids):
        with self.lock:
            turn = self.turns.get(self.key(**ids))
            if turn is None: return None
            name = tool_name
            if name == 'tool_call':
                calls = args.get('calls', [])
                if len(calls) != 1 or not isinstance(calls[0], dict): return self.block()
                name = calls[0].get('name', '')
            # The bridge may fire the hook again for the unwrapped name with the same id.
            dedup = (tool_call_id, name)
            if tool_call_id and dedup in turn.seen: return None
            if self.clock()-turn.started >= 90: return self.block()
            if name.startswith(SOURCE) and name[len(SOURCE):] in READS:
                if turn.reads >= 3: return self.block()
                turn.reads += 1
            elif name in {'tool_search', 'tool_describe', 'skill_view', 'skills_list'}:
                if turn.catalog >= 8: return self.block()
                turn.catalog += 1
            else: return self.block()
            turn.seen.add(dedup)
        return None

    @staticmethod
    def block():
        return {'action': 'block', 'message': '일반 문서 질문의 조회 범위를 마쳤습니다. 확보한 근거로 답하고 확인하지 못한 부분을 밝혀 주세요.'}


def register(ctx):
    budget = Budget()
    ctx.register_hook('pre_llm_call', budget.begin)
    ctx.register_hook('pre_tool_call', budget.tool)
    ctx.register_middleware('llm_request', budget.request)
