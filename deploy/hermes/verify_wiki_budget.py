"""Exercise the real Hermes plugin loader and middleware across isolated homes."""
import argparse
import os
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory


def verify(runtime):
    sys.path.insert(0,str(runtime))
    import hermes_bootstrap  # noqa: F401
    from hermes_cli.plugins import get_plugin_manager, invoke_hook
    from hermes_cli.middleware import apply_llm_request_middleware
    original=os.environ.get('HERMES_HOME')
    try:
        with TemporaryDirectory(prefix='wiki-budget-contract-') as directory:
            root=Path(directory);a=root/'a';b=root/'b';a.mkdir();b.mkdir()
            shutil.copytree(Path(__file__).with_name('framework-wiki-budget'),a/'plugins/framework-wiki-budget')
            (a/'config.yaml').write_text('plugins:\n  enabled: [framework-wiki-budget]\n')
            (b/'config.yaml').write_text('plugins:\n  enabled: []\n')
            ids={'session_id':'contract','turn_id':'turn','task_id':'task'}
            payload={'input':[{'role':'user','content':'old'},{'role':'assistant','content':'x'*20000},{'role':'user','content':'innolive AI 모델의 변천사를 알려줘'}],'tools':[{'name':'tool_call'}]}
            for home,enabled in [(a,True),(b,False),(a,True)]:
                os.environ['HERMES_HOME']=str(home)
                manager=get_plugin_manager();manager.discover_and_load()
                invoke_hook('pre_llm_call',user_message='innolive AI 모델의 변천사를 알려줘',platform='discord',conversation_history=[],**ids)
                actual=apply_llm_request_middleware(payload,api_call_count=4,**ids).payload
                if enabled:
                    assert len(str(actual['input']))<5000 and actual['tools']==[]
                    blocked=invoke_hook('pre_tool_call',tool_name='terminal',args={},tool_call_id='blocked',**ids)
                    assert any(row and row.get('action')=='block' for row in blocked)
                else: assert actual==payload
                assert len(payload['input'][1]['content'])==20000
            print('Hermes plugin discovery, middleware, tool policy and A -> B -> A home isolation passed')
    finally:
        if original is None:os.environ.pop('HERMES_HOME',None)
        else:os.environ['HERMES_HOME']=original

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--runtime',type=Path,default=Path('/home/chaeyn/.hermes/hermes-agent'))
    verify(parser.parse_args().runtime)
