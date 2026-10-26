/**
 * The public event schema and the allowlist that maps Strands events onto it.
 *
 * The browser only ever receives these events, so reasoning, tool input, and tool
 * results stay on the server.
 */
import type { AgentResult, AgentStreamEvent } from '@strands-agents/sdk'

/** Public event schema, version 1. Your app owns this contract, not the SDK. */
export type PublicEvent =
  | { v: 1; type: 'text'; text: string }
  | {
      v: 1
      type: 'tool'
      name: string
      status: 'started' | 'succeeded' | 'failed'
    }
  | {
      v: 1
      type: 'final'
      status: 'complete' | 'cancelled' | 'error'
      stopReason?: string
      text: string
    }

/** What the browser receives: the event plus its position in the run. */
export type PublicEnvelope = PublicEvent & { id: number }

/**
 * Allowlist mapping. Every Strands event that is not listed here is dropped,
 * which covers reasoning, tool input, tool results, and lifecycle events.
 */
export function toPublicEvent(event: AgentStreamEvent): PublicEvent | undefined {
  switch (event.type) {
    case 'modelStreamUpdateEvent': {
      const inner = event.event
      if (inner.type !== 'modelContentBlockDeltaEvent') return undefined
      if (inner.delta.type !== 'textDelta') return undefined
      return { v: 1, type: 'text', text: inner.delta.text }
    }
    case 'beforeToolCallEvent':
      return { v: 1, type: 'tool', name: event.toolUse.name, status: 'started' }
    case 'afterToolCallEvent': {
      const status = event.result.status === 'success' ? 'succeeded' : 'failed'
      return { v: 1, type: 'tool', name: event.toolUse.name, status }
    }
    default:
      return undefined
  }
}

/** The one authoritative final event, built from the agent result. */
export function toFinalEvent(result: AgentResult): PublicEvent {
  const { stopReason, lastMessage } = result
  if (stopReason === 'cancelled') {
    return { v: 1, type: 'final', status: 'cancelled', stopReason, text: '' }
  }
  // Read text blocks only: toString() and toJSON() also include reasoning.
  const text = lastMessage.content
    .flatMap((block) => (block.type === 'textBlock' ? [block.text] : []))
    .join('')
  return { v: 1, type: 'final', status: 'complete', stopReason, text }
}

/** Sent when the run throws. The error itself stays in the server log. */
export const errorFinalEvent: PublicEvent = {
  v: 1,
  type: 'final',
  status: 'error',
  text: '',
}
