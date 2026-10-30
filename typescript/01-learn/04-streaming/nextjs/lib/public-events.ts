/**
 * The public event schema and the allowlist that maps Strands events onto it.
 *
 * The browser only ever receives these events, so reasoning, tool input, tool results,
 * and citation sources stay on the server.
 */
import type { AgentResult, AgentStreamEvent, ModelStreamEvent } from '@strands-agents/sdk'

/** Public event schema, version 1. Your app owns this contract, not the SDK. */
export type PublicEvent =
  | { v: 1; type: 'text'; text: string }
  | { v: 1; type: 'redact'; text: string }
  | {
      v: 1
      type: 'tool'
      callId: number
      name: string
      status: 'started' | 'succeeded' | 'failed'
    }
  | {
      v: 1
      type: 'final'
      status: 'complete' | 'incomplete' | 'blocked' | 'cancelled' | 'error'
      stopReason?: string
      text: string
    }

/** What the browser receives: the event plus its position in the run. */
export type PublicEnvelope = PublicEvent & { id: number }

/** Turns one Strands event into a public event, or drops it. */
export type EventMapper = (event: AgentStreamEvent) => PublicEvent | undefined

/**
 * Allowlist mapping. Every Strands event that is not listed here is dropped,
 * which covers reasoning, tool input, tool results, and lifecycle events.
 * Create one mapper per run: it numbers the run's tool calls.
 */
export function createEventMapper(): EventMapper {
  // Tools run concurrently, and a retried call repeats its toolUseId,
  // so each call gets a number of its own while it runs.
  const runningCalls = new Map<string, number>()
  let lastCallId = 0

  return (event) => {
    switch (event.type) {
      case 'modelStreamUpdateEvent':
        return fromModelEvent(event.event)
      case 'beforeToolCallEvent': {
        const callId = ++lastCallId
        runningCalls.set(event.toolUse.toolUseId, callId)
        return { v: 1, type: 'tool', callId, name: event.toolUse.name, status: 'started' }
      }
      case 'afterToolCallEvent': {
        const callId = runningCalls.get(event.toolUse.toolUseId) ?? ++lastCallId
        runningCalls.delete(event.toolUse.toolUseId)
        const status = event.result.status === 'success' ? 'succeeded' : 'failed'
        return { v: 1, type: 'tool', callId, name: event.toolUse.name, status }
      }
      default:
        return undefined
    }
  }
}

function fromModelEvent(event: ModelStreamEvent): PublicEvent | undefined {
  // A guardrail blocked the output: send the replacement, never the original.
  if (event.type === 'modelRedactionEvent') {
    const replacement = event.outputRedaction?.replaceContent
    if (replacement === undefined) return undefined
    return { v: 1, type: 'redact', text: replacement }
  }
  if (event.type !== 'modelContentBlockDeltaEvent') return undefined
  const { delta } = event
  if (delta.type === 'textDelta') return { v: 1, type: 'text', text: delta.text }
  // A cited answer arrives as citation deltas: keep the generated text, drop the sources.
  if (delta.type !== 'citationsDelta') return undefined
  const text = delta.content.map((content) => content.text).join('')
  return text ? { v: 1, type: 'text', text } : undefined
}

// The answer is done after these stop reasons, and blocked after these.
const COMPLETE_REASONS = new Set(['endTurn', 'stopSequence'])
const BLOCKED_REASONS = new Set(['guardrailIntervened', 'contentFiltered', 'refusal'])

/** The one authoritative final event, built from the agent result. */
export function toFinalEvent(result: AgentResult): PublicEvent {
  const { stopReason, lastMessage } = result
  if (stopReason === 'cancelled') {
    return { v: 1, type: 'final', status: 'cancelled', stopReason, text: '' }
  }
  // Read text and cited text only: toString() and toJSON() also include reasoning.
  const text = lastMessage.content
    .flatMap((block) => {
      if (block.type === 'textBlock') return [block.text]
      if (block.type === 'citationsBlock') return block.content.map((part) => part.text)
      return []
    })
    .join('')
  return { v: 1, type: 'final', status: finalStatus(stopReason), stopReason, text }
}

/** Limits, interrupts, and checkpoints stop a run before its answer is done. */
function finalStatus(stopReason: string): 'complete' | 'incomplete' | 'blocked' {
  if (COMPLETE_REASONS.has(stopReason)) return 'complete'
  if (BLOCKED_REASONS.has(stopReason)) return 'blocked'
  return 'incomplete'
}

/** Sent when the run throws. The error itself stays in the server log. */
export const errorFinalEvent: PublicEvent = {
  v: 1,
  type: 'final',
  status: 'error',
  text: '',
}
