"""Offline checks for private runtime migration and cross-Gateway routing."""
import asyncio
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch
import yaml
from configure_wiki_runtime import configure
from wiki_routing_patch import HELPER, ANCHOR, GATE, patched


class RuntimeTests(unittest.TestCase):
    def setup_home(self, root):
        home = root / 'hermes'; home.mkdir()
        config = {'model': {'provider': 'openai-codex', 'default': 'gpt-6-luna'},
                  'agent': {'reasoning_effort': 'low', 'max_turns': 90},
                  'discord': {'require_mention': True},
                  'mcp_servers': {'framework_wiki': {'url': 'https://framework-wiki.chaeyn.com/mcp',
                  'auth': 'oauth', 'oauth': {'redirect_port': 123}, 'headers': {'X-Test': 'keep'}}}}
        (home / 'config.yaml').write_text(yaml.safe_dump(config))
        (home / '.env').write_text('EXISTING_VALUE=keep\n')
        wiki = root / 'wiki.env'; wiki.write_text('WIKI_SERVICE_KEY=' + 'k' * 40 + '\n')
        bot = root / 'bot.env'; bot.write_text('WIKI_PROPOSALS_ENABLED=true\nWIKI_DISCORD_GUILD_ID=123456789012345678\nWIKI_DISCORD_CATEGORY_IDS=223456789012345678\n')
        return home, wiki, bot

    def test_config_private_backup_and_preserved_settings(self):
        with TemporaryDirectory() as tmp:
            home, wiki, bot = self.setup_home(Path(tmp))
            backup = configure(home, wiki, [bot], True)
            cfg = yaml.safe_load((home / 'config.yaml').read_text())
            self.assertEqual(cfg['agent'], {'max_turns': 90, 'reasoning_effort': 'max', 'service_tier': 'priority'})
            self.assertTrue(cfg['discord']['require_mention'])
            mcp = cfg['mcp_servers']['framework_wiki']
            self.assertNotIn('auth', mcp); self.assertNotIn('oauth', mcp)
            self.assertEqual(mcp['headers']['Authorization'], 'Bearer ${FRAMEWORK_WIKI_SERVICE_KEY}')
            self.assertEqual(mcp['headers']['X-Test'], 'keep')
            self.assertNotIn('k' * 40, (home / 'config.yaml').read_text())
            self.assertIn('EXISTING_VALUE=keep', (home / '.env').read_text())
            self.assertEqual((backup / 'hermes.env').stat().st_mode & 0o777, 0o600)
            self.assertEqual((home / '.env').stat().st_mode & 0o777, 0o600)
            self.assertEqual(yaml.safe_load((backup / 'config.yaml').read_text())['agent']['reasoning_effort'], 'low')

    def test_invalid_scope_leaves_config_unchanged(self):
        with TemporaryDirectory() as tmp:
            home, wiki, bot = self.setup_home(Path(tmp)); before = (home / 'config.yaml').read_text()
            bot.write_text('WIKI_PROPOSALS_ENABLED=false\n')
            with self.assertRaises(ValueError): configure(home, wiki, [bot], True)
            self.assertEqual((home / 'config.yaml').read_text(), before)
            self.assertFalse((home / 'backups').exists())

    def test_invalid_credential_leaves_config_unchanged(self):
        with TemporaryDirectory() as tmp:
            home, wiki, bot = self.setup_home(Path(tmp)); before = (home / 'config.yaml').read_text()
            wiki.write_text('WIKI_SERVICE_KEY=short\n')
            with self.assertRaises(ValueError): configure(home, wiki, [bot])
            self.assertEqual((home / 'config.yaml').read_text(), before)


class RoutingTests(unittest.TestCase):
    def setUp(self):
        scope = {}; exec('class Adapter:\n' + HELPER, scope)
        self.adapter = scope['Adapter']()
        self.fixture = json.loads((Path(__file__).resolve().parents[2] / 'tests/fixtures/wiki-mention-intent.json').read_text())
        self.own = NS(id=int(self.fixture['bot_id']))
        self.adapter._client = NS(user=self.own)
        self.scope = {'FRAMEWORK_WIKI_MENTION_ROUTING': 'true', 'WIKI_DISCORD_GUILD_ID': '10', 'WIKI_DISCORD_CATEGORY_IDS': '20'}

    def check(self, message):
        return asyncio.run(self.adapter._framework_is_wiki_update(message))

    def message(self, content, mentioned=True):
        return NS(author=NS(bot=False), webhook_id=None, guild=NS(id=10), content=content,
                  mentions=[self.own] if mentioned else [], channel=NS(id=30, type=NS(value=0), category_id=20))

    def test_shared_node_classifier_cases(self):
        with patch.dict(os.environ, self.scope, clear=True):
            for case in self.fixture['cases']:
                with self.subTest(case=case['name']):
                    self.assertEqual(self.check(self.message(case['content'], case['mentioned'])), case['expected'])

    def test_scope_and_human_boundaries(self):
        content = '<@' + str(self.own.id) + '> 이거로 위키 갱신해.'
        with patch.dict(os.environ, self.scope, clear=True):
            for field, value in [('webhook_id', 1), ('author', NS(bot=True)), ('guild', NS(id=99)), ('channel', NS(id=30, type=NS(value=0), category_id=99)), ('channel', NS(id=30, type=NS(value=12), category_id=20))]:
                msg = self.message(content); setattr(msg, field, value)
                self.assertFalse(self.check(msg))
            msg = self.message(content); msg.channel = NS(id=40, type=NS(value=11), parent=msg.channel)
            self.assertTrue(self.check(msg))
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(self.check(self.message(content)))

    def test_uncached_thread_parent_uses_id_or_fetch(self):
        content = '<@' + str(self.own.id) + '> 위키 갱신해'
        msg = self.message(content)
        msg.channel = NS(id=40, type=NS(value=11), parent=None, parent_id=30)
        self.adapter._client.fetch_channel = AsyncMock(return_value=NS(id=30, category_id=20))
        with patch.dict(os.environ, self.scope, clear=True):
            self.assertTrue(self.check(msg))
        self.adapter._client.fetch_channel.assert_awaited_once_with(30)
        self.adapter._client.fetch_channel.reset_mock()
        with patch.dict(os.environ, {**self.scope, 'WIKI_DISCORD_FORUM_IDS': '30'}, clear=True):
            self.assertTrue(self.check(msg))
        self.adapter._client.fetch_channel.assert_not_awaited()

    def test_patch_idempotent_and_upstream_drift_rejected(self):
        original = 'class Adapter:\n    async def _handle_message(\n        self, message\n    ):\n' + ANCHOR + '        return True\n'
        result = patched(original)
        self.assertEqual(patched(result), result)
        self.assertIn(GATE + ANCHOR, result)
        with self.assertRaises(ValueError): patched('class Adapter: pass\n')


if __name__ == '__main__': unittest.main()
