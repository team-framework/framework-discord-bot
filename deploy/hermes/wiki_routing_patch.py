"""Hand explicit wiki update mentions to Framework's proposal Gateway."""
from pathlib import Path
import sys

MARKER = '    async def _framework_is_wiki_update(self, message):'
ANCHOR = '        # Save stripped text now: create_thread() can clobber message.content (breaks /command detection).\n'
GATE = '        if await self._framework_is_wiki_update(message):\n            return False\n'
HELPER = '''    async def _framework_is_wiki_update(self, message):
        import os
        import re
        if os.getenv("FRAMEWORK_WIKI_MENTION_ROUTING") != "true":
            return False
        own = getattr(getattr(self, "_client", None), "user", None)
        author = getattr(message, "author", None)
        guild = getattr(message, "guild", None)
        if not own or not author or getattr(author, "bot", False) or getattr(message, "webhook_id", None):
            return False
        if not guild or str(guild.id) != os.getenv("WIKI_DISCORD_GUILD_ID"):
            return False
        content = getattr(message, "content", "")
        if not any(getattr(user, "id", None) == own.id for user in getattr(message, "mentions", [])):
            return False
        if not re.search(r"<@!?" + re.escape(str(own.id)) + r">", content):
            return False
        text = re.sub(r"https?://\\S+|<@!?\\d+>", " ", content, flags=re.I)
        if not re.search(r"(?:위키|wiki)", text, re.I):
            return False
        if re.search(r"[?？]|어떻게|방법|할\\s*수|가능|하지\\s*마|하지\\s*말", text):
            return False
        if not re.search(r"(?:갱신|업데이트|반영)\\s*(?:해(?:\\s*줘|주세요|줄래|주실래)?|하자|해라|부탁)(?=$|[\\s.!])", text):
            return False
        channel = getattr(message, "channel", None)
        kind = getattr(getattr(channel, "type", None), "value", None)
        if kind not in (0, 5, 10, 11):
            return False
        ids = lambda key: set(filter(None, (part.strip() for part in os.getenv(key, "").split(","))))
        parent = getattr(channel, "parent", None) if kind in (10, 11) else channel
        parent_id = getattr(channel, "parent_id", None) if kind in (10, 11) else channel.id
        if str(parent_id) in ids("WIKI_DISCORD_CHANNEL_IDS") or str(parent_id) in ids("WIKI_DISCORD_FORUM_IDS"):
            return True
        if not parent and parent_id:
            try:
                parent = await self._client.fetch_channel(parent_id)
            except Exception:
                return False
        return bool(parent and str(getattr(parent, "category_id", None)) in ids("WIKI_DISCORD_CATEGORY_IDS"))

'''

def patched(source):
    if MARKER in source and GATE + ANCHOR in source:
        return source
    if MARKER in source or source.count(ANCHOR) != 1 or source.count('    async def _handle_message(\n') != 1:
        raise ValueError('Hermes adapter changed; review wiki routing before applying')
    result = source.replace('    async def _handle_message(\n', HELPER + '    async def _handle_message(\n').replace(ANCHOR, GATE + ANCHOR)
    compile(result, 'adapter.py', 'exec')
    return result

def main():
    target = Path(sys.argv[1]).resolve()
    source = target.read_text()
    result = patched(source)
    if result != source:
        backup = target.with_suffix('.py.framework-before-wiki-routing')
        if not backup.exists():
            backup.write_text(source)
            backup.chmod(0o600)
        temporary = target.with_suffix('.py.framework-wiki-tmp')
        temporary.write_text(result)
        temporary.chmod(target.stat().st_mode)
        temporary.replace(target)
    print('Framework wiki mention routing installed')

if __name__ == '__main__':
    main()
