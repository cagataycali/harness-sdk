/**
 * Reproduction harness for the sliding-window "no valid trim point found" bug (TypeScript).
 *
 * Runs SlidingWindowConversationManager.reduce() (the same path AfterInvocationEvent's
 * _applyManagement takes) against realistic tool-heavy histories. No network, no model:
 * `reduce` only touches `agent.messages`.
 *
 * Run from repo root:  node_modules/.bin/tsx sliding-window-dive/repro.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Message, TextBlock, ToolUseBlock, ToolResultBlock } from '../strands-ts/src/types/messages.js'
import { SlidingWindowConversationManager } from '../strands-ts/src/conversation-manager/sliding-window-conversation-manager.js'
import { configureLogging } from '../strands-ts/src/logging/logger.js'
import type { LocalAgent } from '../strands-ts/src/types/agent.js'
import type { Model } from '../strands-ts/src/models/model.js'

const DIVE_DIR = dirname(fileURLToPath(import.meta.url))

// ---------- log capture ----------
const captured: string[] = []
configureLogging({
  debug: (...a) => captured.push(`DEBUG ${a.join(' ')}`),
  info: (...a) => captured.push(`INFO ${a.join(' ')}`),
  warn: (...a) => captured.push(`WARN ${a.join(' ')}`),
  error: (...a) => captured.push(`ERROR ${a.join(' ')}`),
})

// ---------- history builders ----------
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
        content: [new TextBlock(`ok: position=(133.5, 79, -69.5) health=20 food=20 step=${toolSeq}`)],
      }),
    ],
  })
}

/**
 * S1 — the user's real crash shape: 174 messages, window 120.
 * A long autonomous agentic run where toolUse and its toolResult are separated by an
 * interleaved assistant message (concurrent-fork fold-back / mid-turn injection /
 * separate reasoning message). The 120-message tail therefore contains NO plain user
 * message and NO *adjacent* assistant(toolUse)+user(toolResult) pair.
 */
function buildS1(total = 174): Message[] {
  const messages: Message[] = [userText('Build a cabin near my position and keep me posted.')]
  messages.push(assistantText('On it — starting the survey.'))
  // repeating triple: assistant(toolUse), assistant(text), user(toolResult)
  while (messages.length < total - 1) {
    messages.push(toolUseMsg())
    messages.push(assistantText(`Reading the result of step ${toolSeq}...`))
    messages.push(toolResultMsg())
  }
  while (messages.length > total - 1) messages.pop()
  messages.push(assistantText('Progress update: foundation laid.'))
  return messages.slice(0, total)
}

/** S2 — adjacent pairs exist, but NO plain user message anywhere (restored/imported session). */
function buildS2(total = 174): Message[] {
  const messages: Message[] = []
  while (messages.length < total) {
    messages.push(toolUseMsg(true))
    messages.push(toolResultMsg())
  }
  return messages.slice(0, total)
}

/** S3 — trailing orphaned toolUse; everything else non-adjacent tool traffic. */
function buildS3(total = 174): Message[] {
  const messages = buildS1(total - 1)
  messages.push(toolUseMsg()) // awaiting result — orphan
  return messages
}

/** S4 — pinFirst pins a prefix that is NOT a valid user-first alternating run. */
function buildS4(total = 174): Message[] {
  const messages: Message[] = [assistantText('System bootstrap notice (assistant-first).')]
  messages.push(userText('hi'))
  while (messages.length < total) {
    messages.push(toolUseMsg())
    messages.push(toolResultMsg())
  }
  return messages.slice(0, total)
}

/** S7 — plain agentic shape: plain user at 0, adjacent pairs after; anchor fallback "works". */
function buildS7(total = 174): Message[] {
  const messages: Message[] = [userText('Chop wood until I say stop.')]
  while (messages.length < total) {
    messages.push(toolUseMsg())
    messages.push(toolResultMsg())
  }
  return messages.slice(0, total)
}

// ---------- runner ----------
function describeHistory(messages: Message[]): string {
  const plainUsers = messages.filter(
    (m) => m.role === 'user' && !m.content.some((b) => b.type === 'toolResultBlock' || b.type === 'toolUseBlock')
  ).length
  return `len=${messages.length} plainUserMsgs=${plainUsers}`
}

type Case = { name: string; build: () => Message[]; windowSize?: number; pinFirst?: number }
const cases: Case[] = [
  { name: 'S1 no-plain-user + no-adjacent-pair (REAL CRASH SHAPE)', build: () => buildS1() },
  { name: 'S2 adjacent pairs, no plain user anywhere (anchor missing)', build: () => buildS2() },
  { name: 'S3 S1 + trailing orphaned toolUse', build: () => buildS3() },
  { name: 'S4 pinFirst=2 over assistant-first prefix', build: () => buildS4(), pinFirst: 2 },
  { name: 'S7 plain agentic (anchor works) — off-by-one check', build: () => buildS7() },
]

const lines: string[] = []
const out = (s: string) => {
  lines.push(s)
  console.log(s)
}

out(`# repro.ts — SlidingWindowConversationManager, window=120`)
for (const c of cases) {
  const windowSize = c.windowSize ?? 120
  const messages = c.build()
  const manager = new SlidingWindowConversationManager({
    windowSize,
    ...(c.pinFirst !== undefined ? { pinFirst: c.pinFirst } : {}),
  })
  const agent = { messages } as unknown as LocalAgent
  const model = {} as Model

  out(`\n## ${c.name}`)
  out(`before: ${describeHistory(messages)} windowSize=${windowSize}`)

  // Simulate 3 consecutive invocations: AfterInvocation applies reduce when over the window.
  for (let round = 1; round <= 3; round++) {
    captured.length = 0
    const reduced = manager.reduce({ agent, model } as never)
    out(`round ${round}: reduced=${reduced} after: ${describeHistory(messages)}`)
    for (const l of captured) out(`  log: ${l}`)
    // history keeps growing between invocations in real life; emulate one more turn
    if (reduced === false) {
      messages.push(toolUseMsg())
      messages.push(assistantText('interleaved'))
      messages.push(toolResultMsg())
    }
  }
  const first = messages[0]!
  out(
    `post-trim first message: role=${first.role} blocks=[${first.content.map((b) => b.type).join(',')}] | over-window=${messages.length > windowSize}`
  )
}

// ---------- fixture: serialize the exact real-crash shape ----------
const fixture = buildS1(174)
mkdirSync(join(DIVE_DIR, 'fixtures'), { recursive: true })
writeFileSync(
  join(DIVE_DIR, 'fixtures', 'messages-174.json'),
  JSON.stringify(
    fixture.map((m) => ({ role: m.role, content: m.content.map((b) => b.toJSON()) })),
    null,
    2
  )
)
out(`\nfixture written: fixtures/messages-174.json (${fixture.length} messages)`)

writeFileSync(join(DIVE_DIR, process.argv[2] ?? 'repro-output-ts.txt'), lines.join('\n') + '\n')
