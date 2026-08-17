# Sliding-window "no valid trim point found" — deep dive

**Real-world error (TypeScript, tiny-tech / strands-minecraft session.ts, window 120):**

```
window_size=<120>, messages=<174> | unable to trim conversation context, no valid trim point found
```

Emitted from `strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts` `_reduceContext` (line ~260). History keeps growing (174 > 120 forever) because the manager returns `false` and nothing is ever trimmed.

## A. Code-path map (verified against source @ b1558143a)

### TypeScript entry points

| # | Trigger | Path | On `false` |
|---|---------|------|-----------|
| 1 | `AfterInvocationEvent` (every invocation) | `initAgent` hook (sliding-window…ts:165) → `_applyManagement` (:193) → `len > windowSize` → `_reduceContext(messages, undefined)` | warn logged, **history grows unbounded** — hook fires again next invocation, same failure |
| 2 | `AfterModelCallEvent` w/ `ContextWindowOverflowError` | base `ConversationManager.initAgent` (conversation-manager.ts:168) → `reduce({error})` → `_reduceContext(messages, error)` | `event.retry` never set → **overflow error propagates uncaught** |
| 3 | `BeforeModelCallEvent` (proactive compression, threshold) | base hook (:177) → `reduce({})` → `_reduceContext(messages, undefined)` | best-effort, swallowed; model call proceeds and likely overflows → path 2 |

### TS `_reduceContext` decision tree (sliding-window-conversation-manager.ts:217-285)

1. `startIndex = messages.length <= windowSize ? 2 : messages.length - windowSize` (:235) — for the real case: `174 - 120 = 54`.
2. `findValidTrimPoint(messages, 54)` (compression/context-compression.ts:85) — walks forward, **only accepts a `user` message that has NO toolResultBlock** (and no orphaned toolUse). In a tool-heavy agentic history every user message carries toolResult blocks → returns `messages.length`.
3. Fallback `_findToolPairTrimPoint(messages, 54)` (:465) — needs `assistant`-with-toolUse **immediately followed** by `user`-with-toolResult.
   - **FAIL-A**: no such adjacent pair at/after startIndex (interleaved histories — e.g. concurrent-fork folds putting an assistant text message between toolUse and toolResult; trailing orphaned toolUse; assistant-text-only tails) → `trimIndex` stays `messages.length` → **WARN "no valid trim point found" (:260), return false**. ← the user's error string.
   - **FAIL-B**: pair found, but `_findToolPairUserAnchor` (:498) returns `undefined` — no *plain* user message (no tool blocks) anywhere before the pair, or pinned prefix isn't a valid user-first alternating run → **`logger.debug` "declining fallback" (:249), return false — completely SILENT unbounded growth** (worse than FAIL-A: not even a warn).
   - **Off-by-one when it "works"**: anchor kept + `messages[toolPairIndex:]` where `toolPairIndex >= startIndex` → post-trim length can be `windowSize + 1` (anchor is extra). Re-triggers management every invocation.
4. Pin guard (:273): all messages in `[0, trimIndex)` pinned → second warn "all messages in trim range are protected".

### Python (`strands-py/src/strands/agent/conversation_manager/sliding_window_conversation_manager.py`)

Entry points: `apply_management` (:150, called after event loop + per_turn `BeforeModelCallEvent` :97-125) and `reduce_context` (:170, reactive `e != None` / proactive `e = None`).

Decision tree (`reduce_context` :196-274):
1. `window_size == 0` → keep pinned only, return (:204). TS reaches the same via trimIndex==len allowed when windowSize==0 (:259).
2. `e != None` → try `_truncate_tool_results` first (:211).
3. `start_index = 2 if len <= window else len - window` (:225); `find_valid_trim_point` (compression/context_compression.py:107) — same plain-user requirement as TS.
4. Fallback `_find_tool_pair_trim_point` (:276) — same adjacency requirement, **BUT trims directly to the assistant(toolUse) boundary with NO user anchor** (deliberate divergence documented in the TS docstring :489-492).
   - **FAIL-A (parity with TS)**: no adjacent pair at/after start_index → `e=None`: warn "no valid trim point found" (:249) + return (unbounded growth); `e!=None`: `raise ContextWindowOverflowException` (:247).
   - **DIVERGENCE-BUG**: when the fallback *succeeds*, the post-trim history **starts with `assistant(toolUse)`** — violates the user-first requirement of providers like Anthropic (the very requirement `find_valid_trim_point` rule 1 exists for). Next model call can 400.
   - **No FAIL-B in Python** — no anchor concept; instead it produces the invalid-prefix output above.
5. Pin guard (:260) mirrors TS.

### Compression siblings (context for the fix; not the primary bug)
- `adjustSplitPointForToolPairs` / `adjust_split_point_for_tool_pairs`: same forward-walk idea for summarization; throws on exhaustion instead of warning.
- `pin-message.(ts|py)` `isPinned`: tool-pair partner protection by toolUseId (must be respected by any new trim logic).

## Distinct trigger shapes to reproduce (milestone B checklist)
1. **S1 no-plain-user + no-adjacent-pair**: tail of window is toolUse/toolResult where pairs are NOT adjacent (extra assistant text between), no plain user message at/after startIndex. → TS WARN (the user's string), PY warn/raise.
2. **S2 anchor-missing (TS only)**: adjacent pairs exist after startIndex, but NO plain user message exists anywhere before the pair (e.g. history previously trimmed down to pure tool traffic). → TS silent debug-decline, PY trims but emits assistant-first invalid prefix.
3. **S3 trailing orphaned toolUse**: last message is assistant(toolUse) with no result yet, everything before startIndex is only-pairs. Pairs after startIndex may still exist — variant where they don't → S1.
4. **S4 pinned-prefix invalidation (TS)**: pinFirst pins a run that is not user-first alternating → anchor path returns undefined → decline.
5. **S5 all-pinned trim range**: everything in [0, trimIndex) pinned → "all messages in trim range are protected".
6. **S6 py per_turn / proactive path**: same failures reached via BeforeModelCallEvent.
7. **S7 off-by-one**: anchor fallback success leaves windowSize+1 messages (TS).

*(B/C/D/E sections to follow: repro harnesses, fixture, fix, tests, e2e evidence.)*

## B. Reproduction results (repro.ts / repro.py, fixture: fixtures/messages-174.json)

| Shape | TS outcome | PY outcome |
|---|---|---|
| S1 fixture (174 msgs, tail = toolUse / assistant-text / toolResult triples, no plain user in tail) | **exact user WARN**, `reduced=false`, grows 174→177→180 | **same WARN** (e=None); **raises ContextWindowOverflowException** (e set) |
| S2 adjacent pairs, zero plain user | silent DEBUG "declining fallback", `reduced=false`, unbounded growth | trims to 120 BUT history starts `assistant(toolUse)` — invalid user-first prefix |
| S3 = S1 + trailing orphaned toolUse | same WARN as S1 | (same class as S1) |
| S4 pinFirst over assistant-first prefix | silent decline, unbounded growth | n/a (no anchor concept) |
| S7 plain agentic (anchor exists) | trims 174→120 = windowSize+1? (here exactly 120; anchor+tail) | trims to 119 but **discards the plain user anchor** → assistant-first prefix |

Key parity findings:
- The unbounded-growth stall is present in BOTH SDKs for S1-class histories (no plain user AND no adjacent pair after startIndex).
- TS additionally stalls on S2/S4 (anchor decline — silent, debug-level only).
- PY additionally emits provider-invalid assistant-first histories on S2/S7 (the exact problem the TS anchor was built to avoid), and hard-raises on S1 during reactive overflow recovery.
- `echo` of the real error: run `node_modules/.bin/tsx sliding-window-dive/repro.ts` from repo root; `sliding-window-dive/.venv/bin/python sliding-window-dive/repro.py` (venv: uv venv + `uv pip install -e strands-py`).

## C. Root cause — synthesis

All four confirmed bugs share ONE structural root cause plus three local defects:

**ROOT CAUSE — the trim search treats "reducible" as a property the history may lack, when the manager's contract requires it to be a property the algorithm guarantees.** Both SDKs search for a *pre-existing* safe boundary (a plain user message, or an adjacent `assistant(toolUse) → user(toolResult)` pair) at/after `startIndex`. Tool-heavy agentic histories routinely have neither: every user message carries toolResults, and pairs are non-adjacent whenever assistant text (or a fold from a concurrent fork) lands between the toolUse and its toolResult. When the search exhausts, both SDKs give up — but *giving up is not a valid outcome* for a window-enforcement manager: the caller has no recovery, so history grows without bound (TS paths 1/3, PY proactive) or the overflow error propagates (TS path 2, PY reactive raise). The fix must make reduction **total**: for any history longer than `windowSize` (with < everything pinned), a valid trim must exist — by *synthesizing* the anchor the search failed to find, instead of requiring one.

**Local defect 1 — adjacency is an over-strict pairing test.** `_findToolPairTrimPoint` / `_find_tool_pair_trim_point` require the toolResult *immediately* after the toolUse. MuJoCo-style correctness: the provider constraint is only "every toolUse has its toolResult *somewhere later* and vice versa" — adjacency is incidental. Non-adjacent pairs (S1) are provider-valid histories that the search wrongly declares untrimmable.

**Local defect 2 — TS anchor decline is silent + PY skips the anchor entirely.** The two SDKs each implement *half* of the right behavior. TS knows trimmed output must be user-first (`_findToolPairUserAnchor`) but returns `false` at debug level when no plain user exists (S2/S4) — silent unbounded growth. PY doesn't know about user-first at all: its fallback trims to the assistant(toolUse) boundary, emitting provider-invalid assistant-first histories (S2/S7) — the very 400-class failure `find_valid_trim_point`'s rule 1 exists to prevent. Neither considers that when no plain user anchor survives, a minimal placeholder user message (`[earlier conversation trimmed]`) satisfies the provider constraint by construction.

**Local defect 3 — TS off-by-one.** When the anchor fallback succeeds, TS keeps `anchor + messages[toolPairIndex:]`, i.e. `windowSize + 1` messages, so `_applyManagement` re-fires every invocation (S7). The anchor must count against the window (trim to `windowSize - 1` tail + anchor, or equivalent).

**Why the pin machinery is NOT the root cause (but constrains the fix):** `isPinned` partner-protection (toolUseId pairing) and `pinFirst` are correct; S5 ("all protected") is legitimately un-trimmable and must keep warning. The fix must keep pinned messages exempt and keep the pinned-prefix validity check — but a pinned prefix that is *not* user-first alternating should degrade to placeholder-anchor synthesis, not to decline (S4).

**Invariants any fix must guarantee (checked by milestone E tests):**
1. Totality: `len > windowSize` ∧ (∃ unpinned message in trim range) ⇒ reduction occurs.
2. Provider validity: post-trim history starts with a `user` message whose content has no toolResult blocks; no orphaned toolUse/toolResult anywhere.
3. Boundedness: post-trim `len ≤ windowSize`; repeated invocation is a fixed point, not a treadmill.
4. Semantics preserved: `windowSize=0` keeps pinned-only; `pinFirst` prefix retained; pin partner-protection respected; reactive path (`error` set) still tries toolResult truncation first.

## E2 — full strands-ts suite after the fix (2026-08-17)

`npx vitest run --project unit-node`: **147 files, 4145/4145 tests passed, 0 type errors.**

The suite drove three refinements beyond the initial fix:
1. **Pin-aware fallback boundary** (found by new S4 test): pins retained inside the trim
   range ate the removal budget — history stuck at windowSize+2 forever. Boundary now
   pushes forward by the number of pins it keeps.
2. **Relaxed boundary retry** (found by `uses the pinned first user as a safe fallback anchor`):
   at tiny windows the strict anchor+pins-aware search can overshoot to end-of-history;
   retrying from startIndex accepts a slightly-over-window cut, which beats declining.
3. **Seam-aware synthetic anchor** (found by `declines fallback when a pinned prefix ends
   with an assistant message`): the synthetic anchor is placed between a retained
   user-first pinned prefix and the tail, restoring role alternation; it only goes first
   when the history would not otherwise open with a user message.

7 tests in `sliding-window-conversation-manager.test.ts` asserted `reduce() === false`
(decline) for trimmable tool-heavy shapes — the precise behavior under fix. Rewritten to
the total-reduction contract (each outcome hand-simulated first); legitimate
un-trimmability (all-pinned range, minimal anchor+pair history) still refuses.

## E3–E5 — Python parity + suites (2026-08-17)

- All three refinements ported to `strands-py` (pin-aware boundary, relaxed retry,
  seam-aware synthetic anchor) — behavior parity with TS.
- One legacy test updated: `test_sliding_window_tool_heavy_conversation_falls_back_to_tool_pair_boundary`
  asserted an **assistant-first** post-trim history (the S7 provider-invalid divergence);
  now expects the retained user anchor.
- New `tests/strands/agent/conversation_manager/test_sliding_window_trim_totality.py`
  mirrors the TS S1–S7 suite (9 tests). Semantics note: PY's proactive path (`e=None`)
  declines **quietly** on an all-pinned range; the reactive path re-raises — both asserted.
- `pytest tests/strands/agent`: **748/748 passed** (test_a2a_agent.py skipped:
  pre-existing missing optional `a2a` dependency, unrelated).
