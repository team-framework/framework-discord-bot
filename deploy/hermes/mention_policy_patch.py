"""Apply Framework's explicit mention/reply policy to the pinned Hermes adapter.

Fail if upstream changes the expected gate. Keep the upstream checkout backup.
"""
from pathlib import Path
import sys

MARKER = "    async def _framework_is_reply_to_self(self, message):"
HELPER = '''    async def _framework_is_reply_to_self(self, message):
        """Accept replies to this bot, including Discord replies with ping disabled."""
        reference = getattr(message, "reference", None)
        own_user = getattr(self._client, "user", None)
        if not reference or not own_user:
            return False
        channel_id = getattr(message.channel, "id", None)
        if getattr(reference, "channel_id", channel_id) not in (None, channel_id):
            return False
        resolved = getattr(reference, "resolved", None)
        if getattr(resolved, "author", None) is None:
            message_id = getattr(reference, "message_id", None)
            if not message_id:
                return False
            try:
                resolved = await message.channel.fetch_message(message_id)
            except Exception:
                return False
        return getattr(getattr(resolved, "author", None), "id", None) == own_user.id

'''
OLD = "                    and not self._is_bot_tag_debounce_continuation(message)\n"
NEW = "                    and not await self._framework_is_reply_to_self(message)\n"


def patched(source):
    if MARKER in source and NEW in source and OLD not in source:
        return source
    if MARKER in source or source.count(OLD) != 1 or source.count("    async def _handle_message(\n") != 1:
        raise ValueError("Hermes adapter changed; review the mention gate before applying")
    result = source.replace("    async def _handle_message(\n", HELPER + "    async def _handle_message(\n").replace(OLD, NEW)
    compile(result, "adapter.py", "exec")
    return result


def main():
    target = Path(sys.argv[1]).resolve()
    source = target.read_text()
    result = patched(source)
    if source != result:
        backup = target.with_suffix(".py.framework-before-mention-policy")
        if not backup.exists():
            backup.write_text(source)
        temporary = target.with_suffix(".py.framework-tmp")
        temporary.write_text(result)
        temporary.chmod(target.stat().st_mode)
        temporary.replace(target)
    print("Framework mention/reply policy installed")


if __name__ == "__main__":
    main()
