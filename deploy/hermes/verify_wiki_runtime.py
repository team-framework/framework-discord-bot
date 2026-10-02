"""Read-only Wiki checks in an isolated Hermes process; never sends Discord messages."""
import argparse
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace


REQUIRED = {'search_notion', 'read_notion_page', 'get_sources_context', 'search_wiki',
            'read_note', 'get_context', 'get_note_outline', 'read_sections',
            'get_current_metrics', 'get_wiki_status'}
PREFIX = 'mcp__framework_wiki__'


def read_result(raw):
    result = json.loads(raw) if isinstance(raw, str) else raw
    if 'error' in result:
        raise RuntimeError('Wiki read failed; inspect service status without printing credentials')
    value = result.get('result', result)
    return json.loads(value) if isinstance(value, str) else value


def verify(home, runtime, query, exercise_refresh=False):
    sys.path.insert(0, str(runtime))
    os.environ['HERMES_HOME'] = str(home)
    import hermes_bootstrap  # Gateway's managed dependencies and import paths.
    from dotenv import load_dotenv
    load_dotenv(home / '.env')
    from tools.mcp_tool_discovery import discover_mcp_tools
    from tools.registry import registry
    print('Wiki check: discovering tools', file=sys.stderr, flush=True)
    discover_mcp_tools()
    def names():
        return set(registry.get_tool_names_for_toolset('mcp-framework_wiki'))
    expected = {PREFIX + name for name in REQUIRED}
    missing = expected - names()
    if missing:
        raise RuntimeError('Missing Wiki tools: ' + ', '.join(sorted(missing)))
    report = {'registered_tools': sorted(names()), 'tool_count': len(names())}
    if exercise_refresh:
        print('Wiki check: restoring retained connection and agent', file=sys.stderr, flush=True)
        # These changes affect only this diagnostic process's private registry.
        from tools import mcp_tool as core
        from tools.mcp_tool_agent import refresh_agent_mcp_tools
        from tools.mcp_tool_loop import _run_on_mcp_loop
        from tools.mcp_tool_registration import _deregister_mcp_tool_all_scopes
        from model_tools import _dispatch_bridge_tool, get_tool_definitions
        server = next(s for s in core._servers.values() if s.name == 'framework_wiki')
        removed = {PREFIX + name for name in ['search_notion', 'read_notion_page', 'get_sources_context']}
        old = names() - removed
        for name in removed:
            _deregister_mcp_tool_all_scopes(server, name)
        server._registered_tool_names = sorted(old)
        old_defs = get_tool_definitions(enabled_toolsets=['framework_wiki'], quiet_mode=True)
        agent = SimpleNamespace(tools=old_defs,
                                valid_tool_names={x['function']['name'] for x in old_defs},
                                enabled_toolsets=['framework_wiki'], disabled_toolsets=None)
        report['before_refresh'] = len(names())
        _run_on_mcp_loop(server._discover_tools, timeout=40)
        if expected - names():
            raise RuntimeError('Reconnect did not restore Notion tools')
        refresh_agent_mcp_tools(agent, quiet_mode=True, preserve_prefix=True)
        catalog, _ = _dispatch_bridge_tool('tool_search', {'queries': sorted(removed), 'limit': 1},
                                           agent.enabled_toolsets, agent.disabled_toolsets)
        catalog = json.loads(catalog) if isinstance(catalog, str) else catalog
        visible = set(catalog.get('tools', {}))
        if removed - visible:
            raise RuntimeError('Existing agent did not receive the restored tools')
        _run_on_mcp_loop(server._keepalive_probe, timeout=40)
        report.update(after_refresh=len(names()), existing_agent_catalog_tools=catalog.get('total_available'),
                      notion_tools_visible=sorted(visible))
    print('Wiki check: reading current Wiki and Notion evidence', file=sys.stderr, flush=True)
    status = read_result(registry.dispatch(PREFIX + 'get_wiki_status', {}))
    result = read_result(registry.dispatch(PREFIX + 'get_sources_context',
                        {'query': query, 'sources': 'all', 'limit': 8, 'max_chars': 12000}))
    if 'error' in status or 'error' in result:
        raise RuntimeError('Wiki read failed; inspect service status without printing credentials')
    evidence = result.get('evidence', [])
    if not any(item.get('source_type') == 'notion' for item in evidence):
        raise RuntimeError('The probe query returned no Notion evidence')
    report.update(wiki_commit=status.get('wiki_commit'), note_count=status.get('note_count'),
                  source_status=result.get('source_status'), notices=result.get('notices'),
                  truncated=result.get('truncated'),
                  evidence=[{'path': x.get('path'), 'title': x.get('title'),
                             'source_type': x.get('source_type', 'wiki')} for x in evidence])
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--hermes-home', type=Path, default=Path('/home/chaeyn/.hermes'))
    parser.add_argument('--runtime', type=Path, default=Path('/home/chaeyn/.hermes/hermes-agent'))
    parser.add_argument('--query', default='AI 실험 보고서')
    parser.add_argument('--exercise-refresh', action='store_true')
    args = parser.parse_args()
    print(json.dumps(verify(args.hermes_home, args.runtime, args.query, args.exercise_refresh),
                     ensure_ascii=False))
