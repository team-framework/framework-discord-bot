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


FOLLOWUP_MARKER = "    def _framework_is_active_request_followup(self, message):"
FOLLOWUP = '''    def _framework_requester_key(self, message):
        return (str(getattr(getattr(message, "guild", None), "id", "")),
                str(getattr(getattr(message, "channel", None), "id", "")),
                str(getattr(getattr(message, "author", None), "id", "")))

    def _framework_record_requester(self, message, source):
        author = getattr(message, "author", None)
        if not author or getattr(author, "bot", False) or getattr(message, "webhook_id", None):
            return
        requesters = getattr(self, "_framework_requesters", None)
        if requesters is None:
            self._framework_requesters = requesters = {}
        key = self._framework_requester_key(message)
        session_key = self._source_session_key(source)
        for requester, previous in list(requesters.items()):
            if previous["session_key"] == session_key and requester != key:
                requesters.pop(requester)
        if len(requesters) >= 200 and key not in requesters:
            requesters.pop(next(iter(requesters)))
        requesters[key] = {"session_key": session_key, "source": source}

    def _framework_is_active_request_followup(self, message):
        author = getattr(message, "author", None)
        if not author or getattr(author, "bot", False) or getattr(message, "webhook_id", None):
            return False
        explicit = getattr(self, "_self_is_explicitly_mentioned", None)
        if explicit and explicit(message):
            return False
        key = self._framework_requester_key(message)
        requesters = getattr(self, "_framework_requesters", {})
        previous = requesters.get(key)
        if not previous:
            return False
        session_key = previous["session_key"]
        active = session_key in getattr(self, "_active_sessions", {}) or session_key in getattr(self, "_pending_text_batches", {})
        if not active:
            requesters.pop(key, None)
        return active

    def _framework_followup_source(self, message, source):
        if not self._framework_is_active_request_followup(message):
            return source
        import copy
        previous = self._framework_requesters[self._framework_requester_key(message)]["source"]
        result = copy.copy(source)
        for field in ("chat_id", "chat_name", "chat_type", "thread_id", "parent_chat_id"):
            if hasattr(previous, field):
                setattr(result, field, getattr(previous, field))
        return result

'''
FOLLOWUP_GATE = "                    and not self._framework_is_active_request_followup(message)\n"
RECORD_ANCHOR = "        # Track participation so follow-ups in this thread don't need @mention.\n"
RECORD = "        self._framework_record_requester(message, event.source)\n"
AUTO_THREAD = '            auto_thread = self._extra_or_env_flag("auto_thread", "DISCORD_AUTO_THREAD", "true", truthy=True)\n'
AUTO_THREAD_GUARD = '            auto_thread = auto_thread and not self._framework_is_active_request_followup(message)\n'
EVENT = "        event = MessageEvent(\n            text=event_text, message_type=msg_type, source=source, raw_message=message,\n"
ROUTE = "        source = self._framework_followup_source(message, source)\n"


def patched(source):
    if FOLLOWUP_MARKER in source and NEW + FOLLOWUP_GATE in source and RECORD + RECORD_ANCHOR in source and AUTO_THREAD_GUARD in source and ROUTE + EVENT in source:
        return source
    if FOLLOWUP_MARKER in source or source.count(RECORD_ANCHOR) != 1 or source.count(AUTO_THREAD) != 1 or source.count(EVENT) != 1:
        raise ValueError("Hermes adapter changed; review active-request follow-ups before applying")
    if MARKER in source:
        if source.count(HELPER) != 1 or source.count(NEW) != 1 or OLD in source:
            raise ValueError("Hermes adapter changed; review the existing mention policy before applying")
        result = source.replace(HELPER, HELPER + FOLLOWUP).replace(NEW, NEW + FOLLOWUP_GATE)
    else:
        if source.count(OLD) != 1 or source.count("    async def _handle_message(\n") != 1:
            raise ValueError("Hermes adapter changed; review the mention gate before applying")
        result = source.replace("    async def _handle_message(\n", HELPER + FOLLOWUP + "    async def _handle_message(\n").replace(OLD, NEW + FOLLOWUP_GATE)
    result = result.replace(RECORD_ANCHOR, RECORD + RECORD_ANCHOR)
    result = result.replace(AUTO_THREAD, AUTO_THREAD + AUTO_THREAD_GUARD).replace(EVENT, ROUTE + EVENT)
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
