"""Verify the Claude OAuth request's model, reasoning and recorded usage offline."""
import importlib.util
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

class BridgeTests(unittest.TestCase):
    def test_max_reasoning_oauth_route_and_recorded_usage(self):
        calls = []
        text = '```json\n{"three_line_summary":{"problem":"","action":"","status":""},"timeline":[],"conclusion":[]}\n```'
        response = NS(stop_reason='end_turn', content=[NS(type='thinking'), NS(type='text', text=text)], model='claude-opus-5-5',
                      usage=NS(service_tier='standard', model_dump=lambda: {'input_tokens': 3, 'output_tokens': 2}))
        class Client:
            def close(self): pass
        def build_kwargs(model, messages, tools, max_tokens, reasoning, **kwargs):
            calls.append({'model': model, 'messages': messages, 'tools': tools, 'reasoning': reasoning, **kwargs})
            return {}
        bootstrap = ModuleType('hermes_bootstrap')
        env_loader = ModuleType('hermes_cli.env_loader'); env_loader.load_hermes_dotenv = lambda: None
        adapter = ModuleType('agent.anthropic_adapter')
        adapter.build_anthropic_client = lambda *_args, **_kwargs: Client()
        adapter.build_anthropic_kwargs = build_kwargs
        adapter.create_anthropic_message = lambda *_args: response
        credentials = ModuleType('agent.anthropic_credentials')
        credentials.resolve_anthropic_token = lambda **_: 'fake'
        credentials.anthropic_route_is_oauth = lambda *_args, **_kwargs: True
        modules = {'hermes_bootstrap': bootstrap, 'hermes_cli.env_loader': env_loader,
                   'agent.anthropic_adapter': adapter, 'agent.anthropic_credentials': credentials}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {'HERMES_SUMMARY_KEY': 'x' * 40}):
            spec = importlib.util.spec_from_file_location('tested_summary_bridge', Path(__file__).with_name('summary_bridge.py'))
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            with patch('builtins.print'):
                result = module.summarize({'instructions': 'test', 'input': 'test'})
        self.assertEqual(calls[0]['model'], 'claude-opus-5-5')
        self.assertIsNone(calls[0]['tools'])
        self.assertEqual(calls[0]['reasoning'], {'effort': 'max'})
        self.assertTrue(calls[0]['is_oauth'])
        self.assertEqual(result['model'], 'claude-opus-5-5')
        self.assertEqual(result['reasoning']['effort'], 'max')
        self.assertEqual(result['service_tier'], 'standard')
        self.assertEqual(result['usage']['input_tokens'], 3)
        self.assertTrue(result['output'][0]['content'][0]['text'].startswith('{'))

if __name__ == '__main__': unittest.main()
