"""Verify the OAuth request's model, reasoning, tier and recorded usage offline."""
import importlib.util
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

class BridgeTests(unittest.TestCase):
    def test_max_priority_and_recorded_usage(self):
        calls = []
        response = NS(status='completed', output_text='{"three_line_summary":{"problem":"","action":"","status":""},"timeline":[],"conclusion":[]}', model='gpt-6-luna', service_tier='default', usage=NS(model_dump=lambda: {'input_tokens': 3, 'output_tokens': 2}))
        class Stream:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def __iter__(self): return iter([])
            def get_final_response(self): return response
        class Client:
            def __init__(self, **kwargs): self.responses = self
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def close(self): pass
            def stream(self, **kwargs): calls.append(kwargs); return Stream()
        auth = ModuleType('hermes_cli.auth'); auth.resolve_codex_runtime_credentials = lambda: {'api_key': 'fake', 'base_url': 'https://example.invalid'}
        auxiliary = ModuleType('agent.auxiliary_client'); auxiliary._codex_cloudflare_headers = lambda _: {}
        sdk = ModuleType('openai'); sdk.OpenAI = Client
        with patch.dict(sys.modules, {'hermes_cli.auth': auth, 'agent.auxiliary_client': auxiliary, 'openai': sdk}), patch.dict(os.environ, {'HERMES_SUMMARY_KEY': 'x' * 40}):
            spec = importlib.util.spec_from_file_location('tested_summary_bridge', Path(__file__).with_name('summary_bridge.py'))
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            with patch('builtins.print'):
                result = module.summarize({'instructions': 'test', 'input': 'test'})
        self.assertEqual(calls[0]['model'], 'gpt-6-luna')
        self.assertEqual(calls[0]['reasoning']['effort'], 'max')
        self.assertEqual(calls[0]['service_tier'], 'priority')
        self.assertFalse(calls[0]['store'])
        self.assertEqual(result['reasoning']['effort'], 'max')
        self.assertEqual(result['service_tier'], 'default')
        self.assertEqual(result['usage']['input_tokens'], 3)

if __name__ == '__main__': unittest.main()
