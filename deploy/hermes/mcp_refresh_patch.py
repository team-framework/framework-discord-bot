"""Publish changed MCP tools after reconnect and opt-in keepalive checks."""
import argparse
from pathlib import Path
import shutil
import tempfile


TRANSPORT_BEFORE = '''        if self._registered_tool_names:
            return
        with _core._lock:
'''
TRANSPORT_AFTER = '''        if self._registered_tool_names:
            # Framework: reconnect must publish additions, removals and schema changes.
            old_names = set(self._registered_tool_names)
            names = _registration._register_server_tools(self.name, self, self._config)
            self._deregister_owned(old_names - set(names))
            self._registered_tool_names = names
            return
        with _core._lock:
'''
HEALTH_BEFORE = '''        async def list_tools():
            await asyncio.wait_for(self.session.list_tools(), timeout=_KEEPALIVE_RPC_TIMEOUT)
'''
HEALTH_AFTER = '''        # Framework: opt-in polling also reconciles tools when no notification is sent.
        if self._config.get("refresh_tools_on_keepalive", False):
            await asyncio.wait_for(self._refresh_tools(), timeout=_KEEPALIVE_RPC_TIMEOUT)
            return
        async def list_tools():
            await asyncio.wait_for(self.session.list_tools(), timeout=_KEEPALIVE_RPC_TIMEOUT)
'''


def replace_once(source, before, after):
    if after in source:
        if source.count(after) != 1:
            raise ValueError("Duplicate MCP refresh patch; inspect the runtime source")
        return source
    if source.count(before) != 1:
        raise ValueError("Hermes MCP source changed; inspect the runtime before patching")
    return source.replace(before, after, 1)


def patch_runtime(runtime):
    patches = [(runtime / 'tools/mcp_tool_transport.py', TRANSPORT_BEFORE, TRANSPORT_AFTER),
               (runtime / 'tools/mcp_tool_health.py', HEALTH_BEFORE, HEALTH_AFTER)]
    pending = []
    # Validate both files before changing either file.
    for path, before, after in patches:
        source = path.read_text()
        result = replace_once(source, before, after)
        compile(result, str(path), 'exec')
        if result != source:
            pending.append((path, result))
    for path, result in pending:
        backup = path.with_name(path.name + '.framework-before-mcp-refresh')
        if not backup.exists():
            shutil.copyfile(path, backup)
            backup.chmod(0o600)
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
            stream.write(result)
            temporary = Path(stream.name)
        try:
            temporary.chmod(path.stat().st_mode & 0o777)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return len(pending)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('runtime', type=Path)
    args = parser.parse_args()
    print('Hermes MCP refresh files updated:', patch_runtime(args.runtime))
