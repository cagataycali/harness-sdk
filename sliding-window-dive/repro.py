"""Reproduction harness for the sliding-window "no valid trim point found" bug (Python).

Runs SlidingWindowConversationManager.reduce_context / apply_management against the SAME
174-message fixture the TypeScript repro serialized (fixtures/messages-174.json), plus the
other trigger shapes. No network, no model: only ``agent.messages`` is touched.

Run:  sliding-window-dive/.venv/bin/python sliding-window-dive/repro.py
"""

import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace

from strands.agent.conversation_manager.sliding_window_conversation_manager import (
    SlidingWindowConversationManager,
)
from strands.types.exceptions import ContextWindowOverflowException

DIVE_DIR = Path(__file__).parent

# ---------- log capture ----------
captured: list[str] = []


class _Capture(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        captured.append(f"{record.levelname} {record.getMessage()}")


logging.getLogger("strands").addHandler(_Capture())
logging.getLogger("strands").setLevel(logging.DEBUG)

# ---------- history builders (dict Messages, matching strands-py types) ----------
_seq = 0


def user_text(text):
    return {"role": "user", "content": [{"text": text}]}


def assistant_text(text):
    return {"role": "assistant", "content": [{"text": text}]}


def tool_use_msg(with_text=False):
    global _seq
    _seq += 1
    content = []
    if with_text:
        content.append({"text": f"Let me check that (step {_seq})."})
    content.append({"toolUse": {"name": "get_status", "toolUseId": f"tool_{_seq}", "input": {"step": _seq}}})
    return {"role": "assistant", "content": content}


def tool_result_msg():
    return {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": f"tool_{_seq}",
                    "status": "success",
                    "content": [{"text": f"ok step={_seq}"}],
                }
            }
        ],
    }


def build_s1(total=174):
    """No plain user in tail + toolUse/toolResult never adjacent (interleaved assistant text)."""
    messages = [user_text("Build a cabin near my position and keep me posted.")]
    messages.append(assistant_text("On it — starting the survey."))
    while len(messages) < total - 1:
        messages.append(tool_use_msg())
        messages.append(assistant_text(f"Reading the result of step {_seq}..."))
        messages.append(tool_result_msg())
    del messages[total - 1 :]
    messages.append(assistant_text("Progress update: foundation laid."))
    return messages[:total]


def build_s2(total=174):
    """Adjacent pairs, no plain user anywhere."""
    messages = []
    while len(messages) < total:
        messages.append(tool_use_msg(True))
        messages.append(tool_result_msg())
    return messages[:total]


def build_s7(total=174):
    """Plain agentic: plain user at 0, adjacent pairs after."""
    messages = [user_text("Chop wood until I say stop.")]
    while len(messages) < total:
        messages.append(tool_use_msg())
        messages.append(tool_result_msg())
    return messages[:total]


def load_fixture():
    with open(DIVE_DIR / "fixtures" / "messages-174.json") as f:
        raw = json.load(f)
    return [{"role": m["role"], "content": m["content"]} for m in raw]


# ---------- runner ----------
lines: list[str] = []


def out(s):
    lines.append(s)
    print(s)


def describe(messages):
    plain = sum(
        1
        for m in messages
        if m["role"] == "user" and not any(("toolResult" in c or "toolUse" in c) for c in m["content"])
    )
    return f"len={len(messages)} plainUserMsgs={plain}"


def run_case(name, messages, window_size=120, error=None, rounds=3):
    manager = SlidingWindowConversationManager(window_size=window_size)
    agent = SimpleNamespace(messages=messages)
    out(f"\n## {name}")
    out(f"before: {describe(messages)} window_size={window_size} e={'set' if error else 'None'}")
    for rnd in range(1, rounds + 1):
        captured.clear()
        before = len(messages)
        try:
            manager.reduce_context(agent, e=error)
            reduced = len(messages) < before
            out(f"round {rnd}: reduced={reduced} after: {describe(messages)}")
        except ContextWindowOverflowException as exc:
            out(f"round {rnd}: RAISED ContextWindowOverflowException: {exc}")
        for log_line in captured:
            out(f"  log: {log_line}")
        if len(messages) >= before:
            # emulate one more agent turn while stuck over the window
            messages.append(tool_use_msg())
            messages.append(assistant_text("interleaved"))
            messages.append(tool_result_msg())
    first = messages[0]
    blocks = ",".join(sorted(k for c in first["content"] for k in c))
    out(f"post-trim first message: role={first['role']} blocks=[{blocks}] | over-window={len(messages) > window_size}")


out("# repro.py — SlidingWindowConversationManager, window=120")

run_case("S1 FIXTURE (TS-serialized real crash shape, e=None routine management)", load_fixture())
run_case("S1 FIXTURE with e set (reactive overflow recovery)", load_fixture(), error=RuntimeError("input too long"), rounds=1)
run_case("S2 adjacent pairs, no plain user anywhere (PY fallback trims w/o anchor)", build_s2())
run_case("S7 plain agentic shape", build_s7())

with open(DIVE_DIR / (sys.argv[1] if len(sys.argv) > 1 else "repro-output-py.txt"), "w") as f:
    f.write("\n".join(lines) + "\n")
