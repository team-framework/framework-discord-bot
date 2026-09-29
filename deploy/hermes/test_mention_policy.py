import asyncio
from types import SimpleNamespace as NS
import unittest
from mention_policy_patch import HELPER, OLD, NEW, patched

namespace = {}
exec("class Policy:\n" + HELPER, namespace)
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
        fixture = "class Adapter:\n    async def _handle_message(\n        self, message\n    ):\n        if (True\n" + OLD + "        ):\n            return False\n"
        result = patched(fixture)
        self.assertIn(NEW, result)
        self.assertEqual(patched(result), result)
        with self.assertRaises(ValueError):
            patched("class Adapter: pass\n")


if __name__ == "__main__":
    unittest.main()
