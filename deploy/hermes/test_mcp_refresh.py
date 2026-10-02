"""Regress changed tools on a retained connection and polling without notifications."""
import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock

from mcp_refresh_patch import (HEALTH_AFTER, HEALTH_BEFORE, TRANSPORT_AFTER,
                               TRANSPORT_BEFORE, LEGACY_HEALTH_AFTER, patch_runtime, replace_once)


TRANSPORT = '''class Server:
    def _register_discovered_tools_if_needed(self):
        if self._registered_tool_names:
            return
        with _core._lock:
            owned = [key for key, live in _core._servers.items() if live is self]
        if not owned and not self._ready.is_set():
            return
        self._registered_tool_names = _registration._register_server_tools(self.name, self, self._config)

    def _deregister_owned(self, names):
        for name in names:
            published.pop(name, None)
'''
HEALTH = '''class Server:
    async def _keepalive_probe(self):
        async def list_tools():
            await asyncio.wait_for(self.session.list_tools(), timeout=_KEEPALIVE_RPC_TIMEOUT)
        await list_tools()
'''


class ReconnectTests(unittest.TestCase):
    def server(self, source):
        published = {f'tool_{i}': {'version': 1} for i in range(7)}
        def register(_name, server, _config):
            published.update(server._tools)
            return list(server._tools)
        core = NS(_lock=Lock(), _servers={})
        scope = {'_core': core, 'published': published,
                 '_registration': NS(_register_server_tools=register)}
        exec(source, scope)
        server = scope['Server']()
        server.name = 'framework_wiki'; server._config = {}
        server._registered_tool_names = list(published)
        server._tools = dict(published)
        server._ready = NS(is_set=lambda: True)
        core._servers['framework_wiki'] = server
        return server, published

    def test_reproduces_seven_tools_and_restores_ten(self):
        for source, expected in [(TRANSPORT, 7),
                                 (replace_once(TRANSPORT, TRANSPORT_BEFORE, TRANSPORT_AFTER), 10)]:
            server, published = self.server(source)
            server._tools.update({f'tool_{i}': {'version': 1} for i in range(7, 10)})
            server._register_discovered_tools_if_needed()
            self.assertEqual(len(published), expected)
            self.assertEqual(len(server._registered_tool_names), expected)

    def test_same_count_replacement_and_changed_schema(self):
        server, published = self.server(replace_once(TRANSPORT, TRANSPORT_BEFORE, TRANSPORT_AFTER))
        server._tools.pop('tool_0'); server._tools['notion_read'] = {'version': 1}
        server._tools['tool_1'] = {'version': 2}
        server._register_discovered_tools_if_needed()
        self.assertNotIn('tool_0', published)
        self.assertIn('notion_read', published)
        self.assertEqual(published['tool_1']['version'], 2)
        self.assertEqual(set(published), set(server._registered_tool_names))

    def test_removed_tools_are_deregistered(self):
        server, published = self.server(replace_once(TRANSPORT, TRANSPORT_BEFORE, TRANSPORT_AFTER))
        server._tools = {'tool_1': {'version': 1}}
        server._register_discovered_tools_if_needed()
        self.assertEqual(set(published), {'tool_1'})

    def test_initial_discovery_still_registers(self):
        server, published = self.server(replace_once(TRANSPORT, TRANSPORT_BEFORE, TRANSPORT_AFTER))
        server._registered_tool_names = []; published.clear()
        server._register_discovered_tools_if_needed()
        self.assertEqual(len(published), 7)


class PollTests(unittest.TestCase):
    def test_opt_in_poll_refreshes_registry_without_notification(self):
        scope = {'asyncio': asyncio, '_KEEPALIVE_RPC_TIMEOUT': 2}
        exec(replace_once(HEALTH, HEALTH_BEFORE, HEALTH_AFTER), scope)
        for enabled in [True, False]:
            server = scope['Server'](); server._config = {'refresh_tools_on_keepalive': enabled}
            server._schedule_tools_refresh = unittest.mock.Mock(); server.session = NS(list_tools=AsyncMock())
            asyncio.run(server._keepalive_probe())
            self.assertEqual(server._schedule_tools_refresh.call_count, int(enabled))
            self.assertEqual(server.session.list_tools.await_count, 1)

    def test_failed_refresh_propagates_to_existing_reconnect_handler(self):
        scope = {'asyncio': asyncio, '_KEEPALIVE_RPC_TIMEOUT': 2}
        exec(replace_once(HEALTH, HEALTH_BEFORE, HEALTH_AFTER), scope)
        server = scope['Server'](); server._config = {'refresh_tools_on_keepalive': True}
        server.session = NS(list_tools=AsyncMock(side_effect=ConnectionError('disconnected')))
        with self.assertRaises(ConnectionError): asyncio.run(server._keepalive_probe())

    def test_keepalive_under_rpc_lock_refreshes_after_release(self):
        async def check():
            scope = {'asyncio': asyncio, '_KEEPALIVE_RPC_TIMEOUT': 0.2}
            exec(replace_once(HEALTH, HEALTH_BEFORE, HEALTH_AFTER), scope)
            server = scope['Server'](); server._config = {'refresh_tools_on_keepalive': True}
            server.session = NS(list_tools=AsyncMock()); lock = asyncio.Lock(); refreshed = asyncio.Event()
            async def refresh():
                async with lock:
                    await server.session.list_tools()
                    refreshed.set()
            tasks = []
            server._schedule_tools_refresh = lambda: tasks.append(asyncio.create_task(refresh()))
            async with lock:
                await asyncio.wait_for(server._keepalive_probe(), timeout=0.3)
                self.assertFalse(refreshed.is_set())
            await asyncio.wait_for(refreshed.wait(), timeout=0.3)
            await asyncio.gather(*tasks)
            self.assertEqual(server.session.list_tools.await_count, 2)
        asyncio.run(check())


class PatchTests(unittest.TestCase):
    def runtime(self, root):
        tools = root / 'tools'; tools.mkdir()
        (tools / 'mcp_tool_transport.py').write_text(TRANSPORT)
        (tools / 'mcp_tool_health.py').write_text(HEALTH)
        return tools

    def test_repeat_is_safe_and_backups_preserve_original(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp); tools = self.runtime(root)
            self.assertEqual(patch_runtime(root), 2)
            self.assertEqual(patch_runtime(root), 0)
            backup = tools / 'mcp_tool_transport.py.framework-before-mcp-refresh'
            self.assertEqual(backup.read_text(), TRANSPORT)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)

    def test_upstream_drift_changes_neither_file(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp); tools = self.runtime(root)
            (tools / 'mcp_tool_health.py').write_text('class Changed: pass\n')
            with self.assertRaises(ValueError): patch_runtime(root)
            self.assertEqual((tools / 'mcp_tool_transport.py').read_text(), TRANSPORT)
            self.assertFalse(list(tools.glob('*.framework-before-mcp-refresh')))

    def test_upgrades_lock_reentrant_patch(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp); tools = self.runtime(root)
            (tools / 'mcp_tool_health.py').write_text(replace_once(HEALTH, HEALTH_BEFORE, LEGACY_HEALTH_AFTER))
            self.assertEqual(patch_runtime(root), 2)
            self.assertIn(HEALTH_AFTER, (tools / 'mcp_tool_health.py').read_text())
            self.assertNotIn(LEGACY_HEALTH_AFTER, (tools / 'mcp_tool_health.py').read_text())


if __name__ == '__main__': unittest.main()
