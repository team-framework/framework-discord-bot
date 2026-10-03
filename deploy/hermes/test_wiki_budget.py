import importlib.util
import sys
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('wiki_budget', Path(__file__).with_name('framework-wiki-budget')/'__init__.py')
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)

class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.b = m.Budget(clock=lambda: self.now)
        self.ids = {'session_id':'s', 'turn_id':'t', 'task_id':'task'}
        self.b.begin(user_message='innolive AI 모델의 변천사를 알려줘',platform='discord',**self.ids)

    def test_intent_preserves_actions_and_deep_research(self):
        for q in ['innolive AI 모델의 변천사를 알려줘','Framework 노션 보고서 목록 찾아줘','위키 서버 구조 설명해줘']:
            self.assertTrue(m.ordinary_question(q))
        for q in ['innolive 코드를 수정해줘','Framework 모든 문서를 조사하고 정리해줘','위키에 이 결과 보내줘','innolive 코드 분석해줘','Notion 상세히 알려줘','날씨 알려줘']:
            self.assertFalse(m.ordinary_question(q),q)
        history=[{'role':'user','content':'innolive AI 모델 알려줘'}]
        self.assertTrue(m.ordinary_question('그 모델의 실험 보고서를 찾아줘',history))
        history += [{'role':'tool','content':'evidence'} for _ in range(12)]
        self.assertTrue(m.ordinary_question('그 모델의 실험 보고서를 찾아줘',history))

    def test_current_tool_pairs_and_saved_history_preserved(self):
        history=[{'role':'system','content':'keep'}, {'role':'user','content':'old'}, {'role':'assistant','tool_calls':[{'id':'oldcall'}]}, {'role':'tool','tool_call_id':'oldcall','content':'x'*200000}, {'role':'assistant','content':'old answer'}, {'role':'user','content':'current'}, {'type':'function_call','call_id':'new','name':'read'}, {'type':'function_call_output','call_id':'new','output':'new evidence'}]
        before=repr(history)
        selected=m.select_messages(history)
        self.assertEqual(repr(history),before)
        self.assertEqual(selected[-3:],history[-3:])
        self.assertEqual(selected[0],history[0])
        self.assertNotIn('x'*100,repr(selected))
        self.assertNotIn('oldcall',repr(selected))

    def test_recent_plain_history_budget_and_codex_input(self):
        old=[{'role':'user','content':'u'*5000},{'role':'assistant','content':'a'*20000},{'role':'user','content':'current'}]
        out=self.b.request({'input':old,'instructions':'unchanged','tools':[{'name':'tool_call'}]},api_call_count=1,**self.ids)['request']
        self.assertLess(len(str(out['input'])),8200)
        self.assertEqual(out['instructions'],'unchanged')
        self.assertEqual(len(old[1]['content']),20000)
        linked=[{'role':'user','content':'Framework AI 문서 알려줘'},{'role':'assistant','content':'a'*20000+'https://app.notion.com/p/123'},{'role':'user','content':'이 문서를 요약해줘'}]
        chosen=m.select_messages(linked)
        self.assertIn('https://app.notion.com/p/123',repr(chosen))
        self.assertIn('Framework AI 문서 알려줘',repr(chosen))

    def test_parallel_bridge_budget_and_duplicate_hooks(self):
        for i in range(3):
            name=m.SOURCE+'get_sources_context'
            self.assertIsNone(self.b.tool('tool_call',{'calls':[{'name':name,'arguments':{}}]},tool_call_id=str(i),**self.ids))
            self.assertIsNone(self.b.tool(name,{},tool_call_id=str(i),**self.ids))
        self.assertEqual(self.b.tool(name,{},tool_call_id='4',**self.ids)['action'],'block')
        out=self.b.request({'messages':[],'tools':[1],'tool_choice':'auto','parallel_tool_calls':True},**self.ids)['request']
        self.assertEqual(out['tools'],[]);self.assertNotIn('tool_choice',out)

    def test_deadline_forces_answer_and_blocks_more_tools(self):
        self.now=91
        self.assertEqual(self.b.request({'input':[],'tools':[1]},**self.ids)['request']['tools'],[])
        self.assertEqual(self.b.tool(m.SOURCE+'search_notion',{},**self.ids)['action'],'block')

    def test_three_tool_rounds_then_final_and_nonmatching_turn_unchanged(self):
        self.assertEqual(self.b.request({'input':[],'tools':[1]},api_call_count=4,**self.ids)['request']['tools'],[])
        self.assertIsNone(self.b.request({'input':[]},session_id='other',turn_id='t'))
        self.assertIsNone(self.b.begin(user_message='Framework 위키 업데이트해',platform='discord',session_id='other',turn_id='t'))
        self.assertIsNone(self.b.begin(user_message='innolive 알려줘',platform='cli',session_id='other',turn_id='t'))

    def test_mutation_blocked_and_new_turn_resets_budget(self):
        self.assertEqual(self.b.tool('terminal',{},**self.ids)['action'],'block')
        self.b.tool(m.SOURCE+'search_notion',{},**self.ids)
        self.b.begin(user_message='위키 구조 알려줘',platform='discord',**self.ids)
        self.assertEqual(self.b.turns[self.b.key(**self.ids)].reads,0)


class InstallTests(unittest.TestCase):
    def test_preserves_config_and_backups_and_repeat_is_idempotent(self):
        from tempfile import TemporaryDirectory
        import yaml
        from configure_wiki_budget import configure
        with TemporaryDirectory() as d:
            home=Path(d);path=home/'config.yaml'
            config={'model':{'default':'gpt-6-luna'},'agent':{'reasoning_effort':'max','max_turns':150},'plugins':{'enabled':['existing'],'entries':{'existing':{'settings':{'keep':True}}}},'mcp_servers':{'other':{'headers':{'Authorization':'private'}}}}
            path.write_text(yaml.safe_dump(config));before=path.read_text()
            backup=configure(home);configure(home)
            result=yaml.safe_load(path.read_text())
            self.assertEqual(result['agent'],config['agent']);self.assertEqual(result['mcp_servers'],config['mcp_servers'])
            self.assertEqual(result['plugins']['enabled'],['existing','framework-wiki-budget'])
            self.assertEqual(result['plugins']['entries'],config['plugins']['entries'])
            self.assertEqual((backup/'config.yaml').read_text(),before)
            self.assertEqual((backup/'config.yaml').stat().st_mode & 0o777,0o600)
            self.assertTrue((home/'plugins/framework-wiki-budget/plugin.yaml').exists())

if __name__=='__main__':unittest.main()
