#!/usr/bin/env python3
"""Prepare a separate preview environment on chaeyn; never start services or send messages."""
import json
import os
from pathlib import Path
import shutil
import subprocess

base = Path('/home/chaeyn/apps')
source = base / 'framework-discord-bot'
target = base / 'framework-discord-bot-wiki-preview'
wiki = base / 'framework-wiki-preview'

def read_env(path):
    result = {}
    for line in path.read_text().splitlines():
        text = line.strip()
        if not text or text.startswith('#') or '=' not in text:
            continue
        key, value = text.split('=', 1)
        if value[:1] in ('"', "'") and value[-1:] == value[:1]:
            value = value[1:-1]
        result[key] = value
    return result

old = read_env(source / '.env')
wiki_env = read_env(wiki / '.env')
container = json.loads(subprocess.check_output(['docker', 'inspect', 'framework-agent-harness-sync-webhook-1']))[0]
app = dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
for name, value in [('DISCORD_BOT_TOKEN', old.get('DISCORD_BOT_TOKEN')), ('WIKI_SERVICE_KEY', wiki_env.get('WIKI_SERVICE_KEY')), ('HERMES_WIKI_KEY', wiki_env.get('HERMES_WIKI_KEY')), ('HARNESS_SYNC_APP_CLIENT_ID', app.get('HARNESS_SYNC_APP_CLIENT_ID'))]:
    if not value:
        raise SystemExit(f'Required server setting is absent: {name}')
key_path = base / 'framework-agent-harness-sync/private-key.pem'
if not key_path.is_file():
    raise SystemExit('GitHub App private key is absent.')
target.mkdir(mode=0o700, parents=True, exist_ok=True)
(target / 'runtime').mkdir(mode=0o700, exist_ok=True)
values = {**old, 'WIKI_PROPOSALS_ENABLED': 'true', 'WIKI_SCHEDULE_ENABLED': 'false',
          'WIKI_DISCORD_GUILD_ID': '1472113453660377224', 'WIKI_DISCORD_CATEGORY_IDS': '1472113454914470045',
          'WIKI_DISCORD_CHANNEL_IDS': '1472113454482591922,1553638464988385431', 'WIKI_DISCORD_FORUM_IDS': '1553645670844334152',
          'WIKI_SERVICE_URL': 'http://127.0.0.1:3110', 'WIKI_SERVICE_KEY': wiki_env['WIKI_SERVICE_KEY'],
          'HERMES_WIKI_URL': 'http://127.0.0.1:8647/v1/wiki/answer', 'HERMES_WIKI_KEY': wiki_env['HERMES_WIKI_KEY'],
          'WIKI_GITHUB_APP_CLIENT_ID': app['HARNESS_SYNC_APP_CLIENT_ID'], 'WIKI_GITHUB_APP_PRIVATE_KEY_PATH': '/run/secrets/wiki-app.pem',
          'WIKI_GITHUB_REPOSITORY': 'team-framework/framework-llm-wiki', 'WIKI_TRACKING_ISSUE': '73',
          'WIKI_STATE_PATH': '/app/runtime/wiki-proposals.sqlite', 'WIKI_SNAPSHOT_MESSAGES': '300', 'WIKI_SNAPSHOT_CHARS': '24000', 'WIKI_DAILY_MESSAGES': '3000'}
if any('\n' in str(value) or '\r' in str(value) for value in values.values()):
    raise SystemExit('Multiline environment value requires manual review.')
temp = target / '.env.preparing'
with temp.open('w') as handle:
    os.chmod(temp, 0o600)
    handle.write('\n'.join(f'{key}={value}' for key, value in values.items()) + '\n')
temp.replace(target / '.env')
if (source / '.env.hermes').is_file():
    shutil.copyfile(source / '.env.hermes', target / '.env.hermes')
    os.chmod(target / '.env.hermes', 0o600)
print(json.dumps({'preview_directory': str(target), 'schedule_enabled': False, 'services_started': False, 'secrets_copied_on_server': True}))
