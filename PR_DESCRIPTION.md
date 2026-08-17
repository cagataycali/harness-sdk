<!-- PR description for fix/sliding-window-no-valid-trim-point — follows .github/PULL_REQUEST_TEMPLATE.md -->

# fix: make sliding-window context reduction total for tool-heavy histories (TS + Python)

## Description

### The bug

On a long-running agent with `SlidingWindowConversationManager` (window 120), history growth eventually produces:

```
window_size=<120>, messages=<174> | unable to trim conversation context, no valid trim point found
```

…and then **nothing is trimmed — ever**. The warn repeats on every invocation while the history grows unbounded (174 → 177 → 180 → …), inflating token cost until the model's real context window overflows.

Both SDKs share the same structural flaw: the trim search treats "reducible" as a property the history *might* have, rather than one the manager must *guarantee*. A trim point is only accepted if it is:

1. a **plain user message** (no `toolResult` blocks) at/after `startIndex`, or
2. (fallback) an assistant `toolUse` **immediately followed** by a user `toolResult`.

Real agentic histories routinely have **neither**: every user message carries tool results, and assistant narration frequently lands *between* a `toolUse` and its `toolResult` (any agent that streams text alongside tool calls, concurrent-fork folding, etc.). On exhaustion, both SDKs give up.

Beyond the shared stall, the dive found three more defects:

| # | SDK | Defect |
|---|-----|--------|
| 1 | TS | When the fallback pair *is* found but no plain-user anchor exists before it, `_findToolPairUserAnchor` returns `undefined` and reduction is declined at **debug** level — silent unbounded growth, not even a warning |
| 2 | Python | The fallback trims directly to the assistant(`toolUse`) boundary, emitting a **provider-invalid assistant-first history** (violates the user-first requirement `find_valid_trim_point` rule 1 exists to protect; e.g. Anthropic rejects it) |
| 3 | Python | On the reactive path (`e` set) the same unreducible shape **raises `ContextWindowOverflowException`** instead of recovering |
| 4 | TS | When the anchor fallback succeeds, the retained anchor is not counted against the window → post-trim length `windowSize + 1`, re-triggering management on every invocation (treadmill) |

### The fix (same algorithm in both SDKs, behaviorally aligned)

1. **Pair-safe boundary instead of adjacency search.** When no plain-user trim point exists, find the earliest cut at/after `startIndex` that splits no `toolUse`/`toolResult` pair — every `toolUse` before the cut has its result before the cut. Non-adjacent pairs are handled by construction. Pins retained inside the trim range push the boundary forward so they don't consume the removal budget.
2. **User anchor: reuse or synthesize.** The nearest plain user message before the boundary is kept as the window's opener. When none exists, a minimal `user: "[earlier conversation trimmed]"` message is synthesized — placed at the seam after a retained user-first pinned prefix (preserving role alternation), or first otherwise. Post-trim history is **user-first by construction**; Python's assistant-first divergence is gone.
3. **The anchor counts against the window** — post-trim `len(messages) <= windowSize` is a true fixed point (kills the TS off-by-one treadmill).
4. **Relaxed boundary retry.** At very small windows the strict pins-aware search can overshoot to end-of-history; a retry from `startIndex` accepts a slightly-over-window cut — reducing beats declining, and the next pass converges.
5. **Preserved semantics:** `windowSize=0` → pinned-only; an all-pinned trim range still refuses (TS warn + `false`; Python quiet on proactive, raises on reactive); the reactive path still tries tool-result truncation first; pin partner-protection (`toolUseId` pairing) is respected throughout.

Files changed:

- `strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts`
- `strands-py/src/strands/agent/conversation_manager/sliding_window_conversation_manager.py`

### Reproduction & evidence (checked in under `sliding-window-dive/`)

- `fixtures/messages-174.json` — a 174-message history in the exact incident shape (window 120, tool-heavy tail, no plain user message in the trimmable range). The bug reproduces from this fixture alone.
- `repro.ts` / `repro.py` — enumerate all seven trigger shapes (S1–S7: no-plain-user + non-adjacent pairs, anchor-missing, trailing orphaned toolUse, pinned-prefix invalidation, all-pinned range, proactive/per-turn path, anchor off-by-one). Pre-fix outputs (`repro-output-{ts,py}.txt`) capture the verbatim warn, the TS silent decline, the PY assistant-first output and the PY reactive raise; post-fix outputs (`…-fixed.txt`) show every shape reducing to ≤ window, user-first, zero warns, bounded across repeated rounds.
- `FINDINGS.md` — full dive: code-path map with file:line references, root-cause synthesis, fix invariants, and justification for every legacy test that had to change.

> Note for reviewers: the `sliding-window-dive/` directory and this file document the investigation and can be dropped from the final PR if the project prefers code + tests only — the new unit/E2E tests under each SDK stand alone.

## Related Issues

<!-- link upstream issue here if/when filed -->

## Documentation PR

N/A — behavior change is internal to conversation management; docstrings updated in place.

## Type of Change

Bug fix

## Testing

- **New totality suites** covering S1–S7 in both SDKs:
  - `strands-ts/src/conversation-manager/__tests__/sliding-window-trim-totality.test.ts` (8 tests)
  - `strands-py/tests/strands/agent/conversation_manager/test_sliding_window_trim_totality.py` (9 tests)
- **End-to-end, real agent loops** (not just unit-level `reduce()` calls):
  - `strands-ts/src/agent/__tests__/agent.sliding-window-e2e.test.ts` — mock model + real tool execution, 3 turns × 40 tool cycles, window 120: raw history peaks at 164, reduction engages, 0 stall warnings, history bounded and provider-valid after every turn.
  - `sliding-window-dive/e2e_py.py` — same scenario against `strands-py` with `MockedModelProvider`: peak 164 > 120, 2 reductions, 0 stalls, all turns complete.
- **Full regression:**
  - strands-ts: `vitest --project unit-node` → **4145/4145 across 147 files, 0 type errors**
  - strands-py: `pytest tests/strands/agent` → **748/748** (`test_a2a_agent.py` skip is a pre-existing missing optional dependency, unrelated)
- **Legacy tests updated (8 total, each hand-verified first):** 7 TS tests asserted `reduce() === false` (decline) on trimmable tool-heavy shapes — the precise behavior under fix; 1 PY test asserted the assistant-first post-trim history. All rewritten to the total-reduction contract; genuinely un-trimmable cases (all-pinned range, minimal anchor+pair history) still assert refusal.

- [ ] I ran `hatch run prepare`

## Checklist

- [x] I have read the CONTRIBUTING document
- [x] I have reviewed and understand every line of code in this PR, including any generated by AI tools, and I can explain why it works
- [x] My change is focused and reasonably small; I have split unrelated work into separate PRs
- [x] I have added any necessary tests that prove my fix is effective or my feature works
- [x] I have updated the documentation accordingly
- [x] I have added an appropriate example to the documentation to outline the feature, or no new docs are needed
- [x] My changes generate no new warnings
- [x] Any dependent changes have been merged and published

----

By submitting this pull request, I confirm that you can use, modify, copy, and redistribute this contribution, under the terms of your choice.
