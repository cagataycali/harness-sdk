"""Trim-totality tests for SlidingWindowConversationManager (shapes S1-S7).

Mirrors strands-ts/src/conversation-manager/__tests__/sliding-window-trim-totality.test.ts.
Tool-heavy histories must ALWAYS be reducible, the post-trim history must be
provider-valid (user-first, no orphaned toolUse/toolResult), and repeated management
must reach a fixed point at or below the window size instead of treadmilling.
"""

import pytest

from strands.agent.agent import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.agent.conversation_manager.compression.pin_message import pin_message
from strands.types.exceptions import ContextWindowOverflowException

WINDOW = 120

# ---------- history builders (mirror sliding-window-dive/repro.py) ----------

_tool_seq = 0


def _user_text(text):
    return {"role": "user", "content": [{"text": text}]}


def _assistant_text(text):
    return {"role": "assistant", "content": [{"text": text}]}


def _tool_use(with_text=False):
    global _tool_seq
    _tool_seq += 1
    content = []
    if with_text:
        content.append({"text": f"Let me check that (step {_tool_seq})."})
    content.append({"toolUse": {"toolUseId": f"tool_{_tool_seq}", "name": "get_status", "input": {"step": _tool_seq}}})
    return {"role": "assistant", "content": content}


def _tool_result(tool_id=None):
    return {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": tool_id or f"tool_{_tool_seq}",
                    "status": "success",
                    "content": [{"text": f"ok step={_tool_seq}"}],
                }
            }
        ],
    }


def build_s1(length=174):
    """The real crash shape: non-adjacent pairs (assistant text between use and result)."""
    messages = [_user_text("Build a cabin near me."), _assistant_text("On it.")]
    while len(messages) + 3 <= length:
        messages.append(_tool_use())
        messages.append(_assistant_text(f"Narrating step {_tool_seq} before the result arrives."))
        messages.append(_tool_result())
    while len(messages) < length:
        messages.append(_assistant_text("filler"))
    return messages


def build_s2(length=174):
    """Adjacent pairs, but zero plain user messages anywhere."""
    messages = []
    while len(messages) + 2 <= length:
        messages.append(_tool_use(with_text=True))
        messages.append(_tool_result())
    while len(messages) < length:
        messages.append(_assistant_text("filler"))
    return messages


def build_s3(length=174):
    """S1 plus a trailing orphaned toolUse (result not yet arrived)."""
    messages = build_s1(length - 1)
    messages.append(_tool_use())
    return messages


def build_s7(length=174):
    """Plain agentic shape: adjacent pairs with a plain user opener (anchor exists)."""
    messages = [_user_text("Go mine some iron."), _assistant_text("Heading out.")]
    while len(messages) + 2 <= length:
        messages.append(_tool_use())
        messages.append(_tool_result())
    while len(messages) < length:
        messages.append(_assistant_text("filler"))
    return messages


# ---------- invariant helpers ----------


def _agent(messages):
    return Agent(messages=messages)


def assert_user_first(messages):
    first = messages[0]
    assert first["role"] == "user"
    assert not any("toolResult" in content for content in first["content"])


def assert_no_orphaned_results(messages):
    """Every toolResult must have its toolUse in the history."""
    use_ids = {
        content["toolUse"]["toolUseId"] for message in messages for content in message["content"] if "toolUse" in content
    }
    for message in messages:
        for content in message["content"]:
            if "toolResult" in content:
                assert content["toolResult"]["toolUseId"] in use_ids


def count_orphaned_uses(messages):
    """toolUse orphans introduced by trimming are forbidden; a pre-existing trailing orphan may remain."""
    result_ids = {
        content["toolResult"]["toolUseId"]
        for message in messages
        for content in message["content"]
        if "toolResult" in content
    }
    return sum(
        1
        for message in messages
        for content in message["content"]
        if "toolUse" in content and content["toolUse"]["toolUseId"] not in result_ids
    )


def reduce_to_fixed_point(manager, messages, window_size):
    """Emulate apply_management's loop: reduce while over the window, asserting termination."""
    for _ in range(10):
        if len(messages) <= window_size:
            break
        manager.reduce_context(_agent(messages))
    assert len(messages) <= window_size


# ---------- tests ----------


def test_s1_non_adjacent_pairs_no_plain_user_tail_still_reduces():
    """The real crash shape reduces instead of warn-stalling."""
    manager = SlidingWindowConversationManager(window_size=WINDOW)
    messages = build_s1()
    assert len(messages) == 174

    manager.reduce_context(_agent(messages))

    assert len(messages) <= WINDOW
    assert_user_first(messages)
    assert_no_orphaned_results(messages)
    assert count_orphaned_uses(messages) == 0


def test_s1_reactive_overflow_recovery_does_not_raise():
    """With e set (reactive path) the same shape recovers instead of re-raising."""
    manager = SlidingWindowConversationManager(window_size=WINDOW, should_truncate_results=False)
    messages = build_s1()

    manager.reduce_context(_agent(messages), e=ContextWindowOverflowException("Context overflow"))

    assert len(messages) <= WINDOW
    assert_user_first(messages)
    assert_no_orphaned_results(messages)


def test_s1_repeated_management_reaches_fixed_point():
    manager = SlidingWindowConversationManager(window_size=WINDOW)
    messages = build_s1()

    reduce_to_fixed_point(manager, messages, WINDOW)

    # Simulate the conversation continuing: growth past the window must stay reducible.
    while len(messages) <= WINDOW + 2:
        messages.append(_tool_use())
        messages.append(_assistant_text("narration"))
        messages.append(_tool_result())
    reduce_to_fixed_point(manager, messages, WINDOW)
    assert_user_first(messages)
    assert_no_orphaned_results(messages)


def test_s2_no_plain_user_anywhere_synthesizes_anchor():
    manager = SlidingWindowConversationManager(window_size=WINDOW)
    messages = build_s2()

    manager.reduce_context(_agent(messages))

    assert len(messages) <= WINDOW
    assert_user_first(messages)
    assert any(content.get("text") == "[earlier conversation trimmed]" for content in messages[0]["content"])
    assert_no_orphaned_results(messages)
    assert count_orphaned_uses(messages) == 0


def test_s3_trailing_orphaned_tool_use_survives():
    manager = SlidingWindowConversationManager(window_size=WINDOW)
    messages = build_s3()
    last_id = next(content["toolUse"]["toolUseId"] for content in messages[-1]["content"] if "toolUse" in content)

    manager.reduce_context(_agent(messages))

    assert len(messages) <= WINDOW
    assert_user_first(messages)
    assert_no_orphaned_results(messages)
    # The pre-existing trailing orphan is the only permitted one, and it must still be last.
    assert count_orphaned_uses(messages) == 1
    assert any(content.get("toolUse", {}).get("toolUseId") == last_id for content in messages[-1]["content"])


def test_s4_pinned_non_user_first_prefix_reduces_with_synthesized_anchor():
    manager = SlidingWindowConversationManager(window_size=WINDOW, pin_first=2)
    messages = [
        _assistant_text("system-ish assistant note"),
        _assistant_text("another note"),
        *build_s1(172),
    ]

    manager.reduce_context(_agent(messages))

    texts = [message["content"][0].get("text") for message in messages]
    assert "system-ish assistant note" in texts
    assert "another note" in texts
    assert_user_first(messages)
    assert_no_orphaned_results(messages)
    reduce_to_fixed_point(manager, messages, WINDOW)


def test_s5_all_pinned_trim_range_still_refuses():
    """Legitimate un-trimmability is preserved for an all-pinned trim range.

    The proactive/routine path (e=None) declines quietly; the reactive path (e set)
    re-raises the overflow because nothing can be removed.
    """
    messages = [
        _user_text("u1"),
        _assistant_text("a1"),
        _user_text("u2"),
        _assistant_text("a2"),
        _user_text("u3"),
        _assistant_text("a3"),
    ]

    manager = SlidingWindowConversationManager(window_size=2, pin_first=6)
    manager.reduce_context(_agent(messages))
    assert len(messages) == 6

    reactive = SlidingWindowConversationManager(window_size=2, pin_first=6, should_truncate_results=False)
    with pytest.raises(ContextWindowOverflowException):
        reactive.reduce_context(_agent(messages), e=ContextWindowOverflowException("Context overflow"))
    assert len(messages) == 6


def test_s7_plain_user_anchor_kept_no_off_by_one():
    manager = SlidingWindowConversationManager(window_size=WINDOW)
    messages = build_s7()
    anchor_text = messages[0]["content"][0]["text"]

    manager.reduce_context(_agent(messages))

    # The historical off-by-one left window_size+1 messages and re-triggered management forever.
    assert len(messages) <= WINDOW
    assert_user_first(messages)
    assert messages[0]["content"][0]["text"] == anchor_text
    assert_no_orphaned_results(messages)


def test_window_size_zero_keeps_pinned_only():
    manager = SlidingWindowConversationManager(window_size=0)
    messages = build_s7(20)
    pin_message(messages, 0)

    manager.reduce_context(_agent(messages))

    assert len(messages) == 1
    assert messages[0]["content"][0]["text"] == "Go mine some iron."
