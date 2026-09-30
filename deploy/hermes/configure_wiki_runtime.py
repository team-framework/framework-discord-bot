"""Configure the existing Hermes Wiki reader without printing credentials."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import yaml


def read_env(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def env_text(source, updates):
    lines = source.splitlines()
    for key, value in updates.items():
        if '\n' in value or '\r' in value:
            raise ValueError('Multiline environment values are unsupported')
        prefix = key + '='
        lines = [line for line in lines if not line.startswith(prefix)]
        lines.append(prefix + value)
    return '\n'.join(lines) + '\n'


def configure(hermes_home, wiki_env, bot_envs, enable_mentions=False):
    source_env = read_env(wiki_env)
    key = source_env.get('WIKI_SERVICE_KEY', '')
    if len(key) < 32 or not re.fullmatch(r'[A-Za-z0-9_+/=.-]+', key):
        raise ValueError('A valid existing WIKI_SERVICE_KEY is required')
    config_path = hermes_home / 'config.yaml'
    config = yaml.safe_load(config_path.read_text())
    model = config.get('model', {})
    if model.get('provider') != 'openai-codex':
        raise ValueError('Existing Hermes ChatGPT OAuth provider is required')
    model['default'] = 'gpt-6-luna'
    config.setdefault('agent', {}).update(reasoning_effort='max', service_tier='priority')
    servers = config.get('mcp_servers', {})
    if not isinstance(servers.get('framework_wiki'), dict):
        raise ValueError('Existing framework_wiki MCP configuration is required')
    server = servers['framework_wiki']
    if server.get('url') != 'https://framework-wiki.chaeyn.com/mcp':
        raise ValueError('Review the existing Wiki MCP URL before changing authentication')
    server.pop('auth', None)
    server.pop('oauth', None)
    server['enabled'] = True
    server['strict_redirect_headers'] = True
    server['headers'] = {k: v for k, v in server.get('headers', {}).items() if k.lower() != 'authorization'}
    server['headers']['Authorization'] = 'Bearer ${FRAMEWORK_WIKI_SERVICE_KEY}'
    updates = {'FRAMEWORK_WIKI_SERVICE_KEY': key}
    if enable_mentions:
        bot = {}
        for path in bot_envs:
            bot.update(read_env(path))
        if bot.get('WIKI_PROPOSALS_ENABLED') != 'true':
            raise ValueError('Start the proposal Gateway before enabling mention routing')
        for name in ['WIKI_DISCORD_GUILD_ID', 'WIKI_DISCORD_CATEGORY_IDS', 'WIKI_DISCORD_CHANNEL_IDS', 'WIKI_DISCORD_FORUM_IDS']:
            value = bot.get(name, '')
            if any(not re.fullmatch(r'\d{17,20}', item.strip()) for item in value.split(',') if item.strip()):
                raise ValueError('Invalid Discord scope configuration')
            updates[name] = value
        if not updates['WIKI_DISCORD_GUILD_ID'] or not any(updates[k] for k in updates if k.endswith('_IDS')):
            raise ValueError('An explicit guild and channel scope is required')
        updates['FRAMEWORK_WIKI_MENTION_ROUTING'] = 'true'
    env_path = hermes_home / '.env'
    env_source = env_path.read_text() if env_path.exists() else ''
    skill_path = hermes_home / 'skills/framework-wiki-reader/SKILL.md'
    skill_source = Path(__file__).with_name('framework-wiki-reader').joinpath('SKILL.md').read_text()
    backup = hermes_home / 'backups' / ('framework-wiki-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(parents=True, mode=0o700)
    for source, name in [(config_path, 'config.yaml'), (env_path, 'hermes.env'), (skill_path, 'reader-SKILL.md')]:
        if source.exists():
            destination = backup / name
            shutil.copyfile(source, destination)
            destination.chmod(0o600)
    for path, content in [(config_path, yaml.safe_dump(config, allow_unicode=True, sort_keys=False)), (env_path, env_text(env_source, updates)), (skill_path, skill_source)]:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + '.framework-tmp')
        temporary.write_text(content)
        temporary.chmod(0o600)
        temporary.replace(path)
    return backup


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--hermes-home', type=Path, default=Path('/home/chaeyn/.hermes'))
    parser.add_argument('--wiki-env', type=Path, default=Path('/home/chaeyn/apps/framework-llm-wiki-mcp/.env'))
    parser.add_argument('--bot-env', type=Path, action='append')
    parser.add_argument('--enable-mention-routing', action='store_true')
    args = parser.parse_args()
    backups = configure(args.hermes_home, args.wiki_env, args.bot_env or [Path('/home/chaeyn/apps/framework-discord-bot/.env'), Path('/home/chaeyn/apps/framework-discord-bot/.env.hermes')], args.enable_mention_routing)
    print('Hermes Wiki runtime configured; private backup:', backups)
