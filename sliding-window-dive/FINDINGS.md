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
