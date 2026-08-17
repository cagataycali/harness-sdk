/**
 * Trim-totality tests for SlidingWindowConversationManager.
 *
 * Covers the "no valid trim point found" failure family (shapes S1–S7): tool-heavy
 * histories must ALWAYS be reducible, the post-trim history must be provider-valid
 * (user-first, no orphaned toolUse/toolResult), and repeated management must reach
 * a fixed point at or below the window size instead of treadmilling at windowSize+1.
 */
import { describe, it, expect } from 'vitest'
import { SlidingWindowConversationManager } from '../sliding-window-conversation-manager.js'
import { Message, TextBlock, ToolUseBlock, ToolResultBlock } from '../../index.js'
import { pinMessage } from '../compression/pin-message.js'
import type { Agent } from '../../agent/agent.js'

const WINDOW = 120

// ---------- history builders (mirror sliding-window-dive/repro.ts) ----------

let toolSeq = 0

function userText(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] })
}

function assistantText(text: string): Message {
  return new Message({ role: 'assistant', content: [new TextBlock(text)] })
}

function toolUseMsg(withText = false): Message {
  toolSeq++
  const content: (TextBlock | ToolUseBlock)[] = []
  if (withText) content.push(new TextBlock(`Let me check that (step ${toolSeq}).`))
  content.push(new ToolUseBlock({ name: 'get_status', toolUseId: `tool_${toolSeq}`, input: { step: toolSeq } }))
  return new Message({ role: 'assistant', content })
}

function toolResultMsg(id?: string): Message {
  return new Message({
    role: 'user',
    content: [
      new ToolResultBlock({
        toolUseId: id ?? `tool_${toolSeq}`,
        status: 'success',
        content: [new TextBlock(`ok step=${toolSeq}`)],
      }),
    ],
  })
}

/** S1 — the real crash shape: non-adjacent pairs (assistant text between toolUse and toolResult). */
function buildS1(length = 174): Message[] {
  const messages: Message[] = [userText('Build a cabin near me.'), assistantText('On it.')]
  while (messages.length + 3 <= length) {
    messages.push(toolUseMsg())
    messages.push(assistantText(`Narrating step ${toolSeq} before the result arrives.`))
    messages.push(toolResultMsg())
  }
  while (messages.length < length) messages.push(assistantText('filler'))
  return messages
}

/** S2 — adjacent pairs, but zero plain user messages anywhere. */
function buildS2(length = 174): Message[] {
  const messages: Message[] = []
  while (messages.length + 2 <= length) {
    messages.push(toolUseMsg(true))
    messages.push(toolResultMsg())
  }
  while (messages.length < length) messages.push(assistantText('filler'))
  return messages
}

/** S3 — S1 plus a trailing orphaned toolUse (result not yet arrived). */
function buildS3(length = 174): Message[] {
  const messages = buildS1(length - 1)
  messages.push(toolUseMsg())
  return messages
}

/** S7 — plain agentic shape: adjacent pairs with a plain user opener (anchor exists). */
function buildS7(length = 174): Message[] {
  const messages: Message[] = [userText('Go mine some iron.'), assistantText('Heading out.')]
  while (messages.length + 2 <= length) {
    messages.push(toolUseMsg())
    messages.push(toolResultMsg())
  }
  while (messages.length < length) messages.push(assistantText('filler'))
  return messages
}

// ---------- invariant helpers ----------

function asAgent(messages: Message[]): Agent {
  return { messages } as unknown as Agent
}

function expectUserFirst(messages: Message[]): void {
  const first = messages[0]!
  expect(first.role).toBe('user')
  expect(first.content.some((b) => b.type === 'toolResultBlock')).toBe(false)
}

/** Every toolResult must have its toolUse in the history; no result orphans allowed. */
function expectNoOrphanedResults(messages: Message[]): void {
  const useIds = new Set<string>()
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'toolUseBlock') useIds.add((b as ToolUseBlock).toolUseId)
    }
  }
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'toolResultBlock') {
        expect(useIds.has((b as ToolResultBlock).toolUseId)).toBe(true)
      }
    }
  }
}

/** toolUse orphans introduced by trimming are forbidden; a pre-existing trailing orphan may remain. */
function countOrphanedUses(messages: Message[]): number {
  const resultIds = new Set<string>()
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'toolResultBlock') resultIds.add((b as ToolResultBlock).toolUseId)
    }
  }
  let orphans = 0
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'toolUseBlock' && !resultIds.has((b as ToolUseBlock).toolUseId)) orphans++
    }
  }
  return orphans
}

/** Emulate _applyManagement's loop: reduce while over the window, asserting termination. */
function reduceToFixedPoint(manager: SlidingWindowConversationManager, messages: Message[], windowSize: number): void {
  for (let round = 0; round < 10 && messages.length > windowSize; round++) {
    expect(manager.reduce({ agent: asAgent(messages) })).toBe(true)
  }
  expect(messages.length).toBeLessThanOrEqual(windowSize)
}

// ---------- tests ----------

describe('sliding window trim totality (S1–S7)', () => {
  it('S1: non-adjacent tool pairs with no plain user in the tail still reduce (the real crash shape)', () => {
    const manager = new SlidingWindowConversationManager({ windowSize: WINDOW })
    const messages = buildS1()
    expect(messages.length).toBe(174)

    expect(manager.reduce({ agent: asAgent(messages) })).toBe(true)

    expect(messages.length).toBeLessThanOrEqual(WINDOW)
    expectUserFirst(messages)
    expectNoOrphanedResults(messages)
    expect(countOrphanedUses(messages)).toBe(0)
  })

  it('S1: repeated management reaches a fixed point instead of growing without bound', () => {
    const manager = new SlidingWindowConversationManager({ windowSize: WINDOW })
    const messages = buildS1()

    reduceToFixedPoint(manager, messages, WINDOW)

    // Simulate the conversation continuing: growth past the window must stay reducible.
    while (messages.length <= WINDOW + 2) {
      messages.push(toolUseMsg())
      messages.push(assistantText('narration'))
      messages.push(toolResultMsg())
    }
    reduceToFixedPoint(manager, messages, WINDOW)
    expectUserFirst(messages)
    expectNoOrphanedResults(messages)
  })

  it('S2: zero plain user messages anywhere — synthesizes a user anchor instead of declining', () => {
    const manager = new SlidingWindowConversationManager({ windowSize: WINDOW })
    const messages = buildS2()

    expect(manager.reduce({ agent: asAgent(messages) })).toBe(true)

    expect(messages.length).toBeLessThanOrEqual(WINDOW)
    expectUserFirst(messages)
    const first = messages[0]!
    expect(first.content.some((b) => b.type === 'textBlock' && (b as TextBlock).text === '[earlier conversation trimmed]')).toBe(
      true
    )
    expectNoOrphanedResults(messages)
    expect(countOrphanedUses(messages)).toBe(0)
  })

  it('S3: trailing orphaned toolUse does not block reduction and survives the trim', () => {
    const manager = new SlidingWindowConversationManager({ windowSize: WINDOW })
    const messages = buildS3()
    const lastId = (messages[messages.length - 1]!.content.find((b) => b.type === 'toolUseBlock') as ToolUseBlock)
      .toolUseId

    expect(manager.reduce({ agent: asAgent(messages) })).toBe(true)

    expect(messages.length).toBeLessThanOrEqual(WINDOW)
    expectUserFirst(messages)
    expectNoOrphanedResults(messages)
    // The pre-existing trailing orphan is the only permitted one, and it must still be last.
    expect(countOrphanedUses(messages)).toBe(1)
    const last = messages[messages.length - 1]!
    expect((last.content.find((b) => b.type === 'toolUseBlock') as ToolUseBlock).toolUseId).toBe(lastId)
  })

  it('S4: pinFirst over a non-user-first prefix reduces via a synthesized anchor instead of declining', () => {
    const manager = new SlidingWindowConversationManager({ windowSize: WINDOW, pinFirst: 2 })
    // assistant-first prefix: pinned run is not user-first alternating
    const messages = [assistantText('system-ish assistant note'), assistantText('another note'), ...buildS1(172)]

    expect(manager.reduce({ agent: asAgent(messages) })).toBe(true)

    // Pinned messages are retained…
    const texts = messages.map((m) => (m.content[0] as TextBlock).text ?? '')
    expect(texts).toContain('system-ish assistant note')
    expect(texts).toContain('another note')
    // …and the history still opens with a (synthesized) plain user message.
    expectUserFirst(messages)
    expectNoOrphanedResults(messages)

    // Pins may leave the first round slightly over; management converges within a couple rounds.
    reduceToFixedPoint(manager, messages, WINDOW)
  })

  it('S5: an all-pinned trim range still refuses to reduce (legitimately un-trimmable)', () => {
    const manager = new SlidingWindowConversationManager({ windowSize: 2, pinFirst: 6 })
    const messages = [
      userText('u1'),
      assistantText('a1'),
      userText('u2'),
      assistantText('a2'),
      userText('u3'),
      assistantText('a3'),
    ]

    expect(manager.reduce({ agent: asAgent(messages) })).toBe(false)
    expect(messages.length).toBe(6)
  })

  it('S7: when a plain user anchor exists it is kept and the result is exactly windowSize (no off-by-one)', () => {
    const manager = new SlidingWindowConversationManager({ windowSize: WINDOW })
    const messages = buildS7()
    const anchorText = (messages[0]!.content[0] as TextBlock).text

    expect(manager.reduce({ agent: asAgent(messages) })).toBe(true)

    // The historical off-by-one left windowSize+1 messages and re-triggered management forever.
    expect(messages.length).toBeLessThanOrEqual(WINDOW)
    expectUserFirst(messages)
    expect((messages[0]!.content[0] as TextBlock).text).toBe(anchorText)
    expectNoOrphanedResults(messages)
  })

  it('windowSize=0 still keeps pinned-only', () => {
    const manager = new SlidingWindowConversationManager({ windowSize: 0 })
    const messages = buildS7(20)
    pinMessage(messages, 0)

    expect(manager.reduce({ agent: asAgent(messages) })).toBe(true)

    expect(messages.length).toBe(1)
    expect((messages[0]!.content[0] as TextBlock).text).toBe('Go mine some iron.')
  })
})
