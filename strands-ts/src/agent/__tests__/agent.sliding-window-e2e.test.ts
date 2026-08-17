import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { SlidingWindowConversationManager } from '../../conversation-manager/sliding-window-conversation-manager.js'
import type { Message } from '../../types/messages.js'
import { logger } from '../../logging/logger.js'

/**
 * End-to-end: a REAL agent event loop (tool execution included) driven far past the
 * sliding window by a scripted model, reproducing the original incident shape —
 * windowSize=120 with a tool-heavy history growing past 174 messages and no plain
 * user message anywhere in the trimmable tail.
 *
 * The regression under test: `reduce()` declined ("unable to trim conversation
 * context, no valid trim point found"), so the history grew without bound and the
 * next provider call overflowed again — a permanent stall.
 */

const WINDOW = 120
const TOOL_CYCLES_PER_TURN = 40
const TURNS = 3

/**
 * Routine trimming runs through the manager's private _applyManagement (registered on
 * AfterInvocationEvent), so instrumentation patches the instance method at runtime —
 * the hook looks the method up on `this` at call time.
 */
function instrument(manager: SlidingWindowConversationManager): { preLengths: number[]; reductions: () => number } {
  const preLengths: number[] = []
  let reductions = 0
  const target = manager as unknown as { _applyManagement: (messages: Message[]) => void }
  const original = target._applyManagement.bind(manager)
  target._applyManagement = (messages: Message[]) => {
    preLengths.push(messages.length)
    const before = messages.length
    original(messages)
    if (messages.length < before) {
      reductions += 1
    }
  }
  return { preLengths, reductions: () => reductions }
}

function assertProviderValid(messages: Message[], context: string): void {
  const first = messages[0]!
  expect(first.role, `${context}: history must start with user`).toBe('user')
  expect(
    first.content.some((block) => block.type === 'toolResultBlock'),
    `${context}: history starts with a toolResult`
  ).toBe(false)

  const useIds = new Set(
    messages.flatMap((message) =>
      message.content.filter((block) => block.type === 'toolUseBlock').map((block) => (block as { toolUseId: string }).toolUseId)
    )
  )
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolResultBlock') {
        expect(useIds.has((block as { toolUseId: string }).toolUseId), `${context}: orphaned toolResult`).toBe(true)
      }
    }
  }
}

describe('sliding window end-to-end (agent loop past the window)', () => {
  it('runs 3 tool-heavy turns past the window with zero stall warnings', async () => {
    const warnSpy = vi.spyOn(logger, 'warn')

    const model = new MockMessageModel()
    let step = 0
    for (let turn = 0; turn < TURNS; turn++) {
      for (let cycle = 0; cycle < TOOL_CYCLES_PER_TURN; cycle++) {
        step += 1
        model.addTurn([
          { type: 'textBlock', text: `Narrating step ${step} before acting.` },
          { type: 'toolUseBlock', name: 'get_status', toolUseId: `tool_${step}`, input: { step } },
        ])
      }
      model.addTurn({ type: 'textBlock', text: `Turn complete after step ${step}.` })
    }

    const manager = new SlidingWindowConversationManager({ windowSize: WINDOW })
    const stats = instrument(manager)
    const statusTool = createMockTool('get_status', (context) => `ok step=${JSON.stringify(context.toolUse.input)}`)
    const agent = new Agent({
      model,
      tools: [statusTool],
      conversationManager: manager,
      printer: false,
    })

    for (let turn = 1; turn <= TURNS; turn++) {
      const result = await agent.invoke(`Do the next batch of work (turn ${turn}).`)
      const text = result.lastMessage.content
        .filter((block) => block.type === 'textBlock')
        .map((block) => (block as { text: string }).text)
        .join(' ')
      expect(text, `turn ${turn}: unexpected final answer`).toContain('Turn complete')
      expect(agent.messages.length, `turn ${turn}: history not bounded`).toBeLessThanOrEqual(WINDOW)
      assertProviderValid(agent.messages, `turn ${turn}`)
    }

    // The harness only proves something if the raw history actually crossed the window.
    const rawPeak = Math.max(...stats.preLengths)
    expect(rawPeak).toBeGreaterThan(WINDOW)
    expect(stats.reductions()).toBeGreaterThan(0)

    const stallWarns = warnSpy.mock.calls.filter((call) => String(call[0]).includes('no valid trim point'))
    expect(stallWarns).toEqual([])
    warnSpy.mockRestore()
  })
})
