"""Milestone F — Python end-to-end harness.

Drives a REAL Agent event loop (tool execution included) with a scripted model far past
the sliding window, reproducing the original incident shape (window_size=120, history
growing past 174 messages, tool-heavy tail with no plain user messages).

Asserts, while the loop runs:
  1. no 'no valid trim point' warning is ever logged
  2. the history stays bounded (never grows without bound past the window)
  3. the history stays provider-valid (user-first, no orphaned toolResult)
  4. every agent turn completes with a final text answer
"""

import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "strands-py" / "src"))

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "mocked_model_provider", ROOT / "strands-py" / "tests" / "fixtures" / "mocked_model_provider.py"
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
MockedModelProvider = _mod.MockedModelProvider

from strands import tool  # noqa: E402
from strands.agent import Agent  # noqa: E402
from strands.agent.conversation_manager import SlidingWindowConversationManager  # noqa: E402

WINDOW = 120
TOOL_CYCLES_PER_TURN = 40
TURNS = 3


@tool
def get_status(step: int) -> str:
    """Report status for a step."""
    return f"ok step={step}"


class WarnCatcher(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.records = []

    def emit(self, record):
        self.records.append(record.getMessage())


def build_responses():
    responses = []
    step = 0
    for _ in range(TURNS):
        for _ in range(TOOL_CYCLES_PER_TURN):
            step += 1
            responses.append(
                {
                    "role": "assistant",
                    "content": [
                        {"text": f"Narrating step {step} before acting."},
                        {"toolUse": {"toolUseId": f"tool_{step}", "name": "get_status", "input": {"step": step}}},
                    ],
                }
            )
        responses.append({"role": "assistant", "content": [{"text": f"Turn complete after step {step}."}]})
    return responses


def assert_provider_valid(messages, context):
    first = messages[0]
    assert first["role"] == "user", f"{context}: history must start with user, got {first['role']}"
    assert not any("toolResult" in c for c in first["content"]), f"{context}: history starts with a toolResult"
    use_ids = {c["toolUse"]["toolUseId"] for m in messages for c in m["content"] if "toolUse" in c}
    for m in messages:
        for c in m["content"]:
            if "toolResult" in c:
                assert c["toolResult"]["toolUseId"] in use_ids, (
                    f"{context}: orphaned toolResult {c['toolResult']['toolUseId']}"
                )


class InstrumentedManager(SlidingWindowConversationManager):
    """Records the raw history length seen by every management call (pre-trim)."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.pre_lengths = []
        self.reductions = 0

    def apply_management(self, agent, **kwargs):
        self.pre_lengths.append(len(agent.messages))
        before = len(agent.messages)
        super().apply_management(agent, **kwargs)
        if len(agent.messages) < before:
            self.reductions += 1


def main():
    catcher = WarnCatcher()
    logging.getLogger("strands").addHandler(catcher)

    manager = InstrumentedManager(window_size=WINDOW)
    agent = Agent(
        model=MockedModelProvider(build_responses()),
        tools=[get_status],
        conversation_manager=manager,
        callback_handler=None,
    )

    peak = 0
    for turn in range(1, TURNS + 1):
        result = agent(f"Do the next batch of work (turn {turn}).")
        peak = max(peak, len(agent.messages))
        text = str(result)
        assert "Turn complete" in text, f"turn {turn}: unexpected final answer {text!r}"
        assert len(agent.messages) <= WINDOW, (
            f"turn {turn}: history not bounded — {len(agent.messages)} > {WINDOW}"
        )
        assert_provider_valid(agent.messages, f"turn {turn}")
        print(f"turn {turn}: final len={len(agent.messages)} (peak seen {peak}) — OK", flush=True)

    stall_warns = [m for m in catcher.records if "no valid trim point" in m]
    assert not stall_warns, f"stall warnings logged: {stall_warns}"
    raw_peak = max(manager.pre_lengths)
    assert raw_peak > WINDOW, f"window never crossed (raw peak {raw_peak}) — harness too small to prove anything"
    assert manager.reductions > 0, "no reduction ever happened"
    print(f"\nE2E PASS: {TURNS} turns x {TOOL_CYCLES_PER_TURN} tool cycles, window={WINDOW}, "
          f"raw peak {raw_peak} (> window), {manager.reductions} reductions, "
          f"0 stall warnings, history provider-valid throughout.", flush=True)


if __name__ == "__main__":
    main()
