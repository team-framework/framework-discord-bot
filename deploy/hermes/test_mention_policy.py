import asyncio
from types import SimpleNamespace as NS
import unittest
from mention_policy_patch import HELPER, FOLLOWUP, OLD, NEW, AUTO_THREAD, EVENT, patched

namespace = {}
exec("class Policy:\n" + HELPER + FOLLOWUP, namespace)
Policy = namespace["Policy"]


class MentionPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_reply_without_ping_and_other_author(self):
        policy = Policy()
        policy._client = NS(user=NS(id=42))
        message = NS(channel=NS(id=7), reference=NS(channel_id=7, resolved=NS(author=NS(id=42))))
        self.assertTrue(await policy._framework_is_reply_to_self(message))
        message.reference.resolved.author.id = 99
        self.assertFalse(await policy._framework_is_reply_to_self(message))

    async def test_uncached_reply_fetches_same_channel_and_denies_missing(self):
        calls = []
        async def fetch(message_id):
            calls.append(message_id)
            return NS(author=NS(id=42))
        policy = Policy()
        policy._client = NS(user=NS(id=42))
        message = NS(channel=NS(id=7, fetch_message=fetch), reference=NS(channel_id=7, message_id=123))
        self.assertTrue(await policy._framework_is_reply_to_self(message))
        self.assertEqual(calls, [123])
        message.reference.channel_id = 8
        self.assertFalse(await policy._framework_is_reply_to_self(message))
        self.assertEqual(calls, [123])
        message.reference.channel_id = 7
        async def deleted(_):
            raise RuntimeError("deleted")
        message.channel.fetch_message = deleted
        self.assertFalse(await policy._framework_is_reply_to_self(message))
        message.reference = None
        self.assertFalse(await policy._framework_is_reply_to_self(message))

    def test_patch_is_idempotent_and_rejects_changed_upstream(self):
        fixture = "class Adapter:\n    async def _handle_message(\n        self, message\n    ):\n        if (True\n" + OLD + "        ):\n            return False\n" + AUTO_THREAD + EVENT + "        )\n        # Track participation so follow-ups in this thread don't need @mention.\n"
        result = patched(fixture)
        self.assertIn(NEW, result)
        self.assertEqual(patched(result), result)
        with self.assertRaises(ValueError):
            patched("class Adapter: pass\n")

    def test_parent_channel_followup_keeps_original_thread_and_current_message_identity(self):
        policy = Policy()
        policy._source_session_key = lambda source: source.key
        message = NS(guild=NS(id=1), channel=NS(id=7), author=NS(id=10, bot=False), webhook_id=None)
        original = NS(key="thread-session", chat_id="99", chat_type="thread", chat_name="실험", thread_id="99", parent_chat_id="7", message_id="first")
        policy._framework_record_requester(message, original)
        policy._active_sessions = {"thread-session": object()}
        current = NS(chat_id="7", chat_type="group", message_id="correction")
        routed = policy._framework_followup_source(message, current)
        self.assertEqual(routed.chat_id, "99")
        self.assertEqual(routed.chat_type, "thread")
        self.assertEqual(routed.message_id, "correction")
        self.assertEqual(current.chat_id, "7")
        policy._self_is_explicitly_mentioned = lambda message: True
        self.assertFalse(policy._framework_is_active_request_followup(message))
        self.assertIs(policy._framework_followup_source(message, current), current)

    def test_reused_session_does_not_authorize_the_previous_requester(self):
        policy = Policy()
        policy._source_session_key = lambda source: source.key
        first = NS(guild=NS(id=1), channel=NS(id=7), author=NS(id=10, bot=False), webhook_id=None)
        second = NS(guild=NS(id=1), channel=NS(id=7), author=NS(id=11, bot=False), webhook_id=None)
        policy._framework_record_requester(first, NS(key="session"))
        policy._framework_record_requester(second, NS(key="session"))
        policy._active_sessions = {"session": object()}
        self.assertFalse(policy._framework_is_active_request_followup(first))
        self.assertTrue(policy._framework_is_active_request_followup(second))

    def test_only_active_same_requester_in_same_channel_can_correct_without_ping(self):
        policy = Policy()
        policy._source_session_key = lambda source: source.key
        original = NS(guild=NS(id=1), channel=NS(id=7), author=NS(id=10, bot=False), webhook_id=None)
        policy._framework_record_requester(original, NS(key="session"))
        policy._active_sessions = {"session": object()}
        correction = NS(guild=NS(id=1), channel=NS(id=7), author=NS(id=10, bot=False), webhook_id=None,
                        content="아, 자체 모델에 한정해야 해. InSwapper / GHOST 제외")
        self.assertTrue(policy._framework_is_active_request_followup(correction))
        for field, value in [("author", NS(id=11, bot=False)), ("channel", NS(id=8)), ("guild", NS(id=2))]:
            previous = getattr(correction, field)
            setattr(correction, field, value)
            self.assertFalse(policy._framework_is_active_request_followup(correction))
            setattr(correction, field, previous)
        correction.author.bot = True
        self.assertFalse(policy._framework_is_active_request_followup(correction))
        correction.author.bot = False
        policy._active_sessions = {}
        self.assertFalse(policy._framework_is_active_request_followup(correction))


if __name__ == "__main__":
    unittest.main()
