/**
 * Runs, event IDs, and the replay buffer.
 *
 * A run is one agent invocation that the server tracks by ID. It outlives any single
 * HTTP connection, so a browser that reconnects picks up the same run.
 */
import { randomUUID } from 'node:crypto'
import { Agent, BedrockModel } from '@strands-agents/sdk'
import { errorFinalEvent, toFinalEvent, toPublicEvent } from './public-events'
import type { PublicEnvelope, PublicEvent } from './public-events'
import { getWeather } from './weather-tool'

const BUFFER_SIZE = 500 // most recent events kept for replay
const GRACE_MS = 30_000 // cancel when nobody has listened for this long
const TTL_MS = 300_000 // forget the run this long after it ends

type Listener = (event: PublicEnvelope) => void

export class AgentRun {
  readonly id = randomUUID()
  finalEvent: PublicEnvelope | undefined
  private readonly buffer: PublicEnvelope[] = []
  private readonly listeners = new Set<Listener>()
  private readonly controller = new AbortController()
  private nextId = 1
  private graceTimer: NodeJS.Timeout | undefined

  constructor() {
    this.startGraceTimer()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  push(event: PublicEvent): void {
    const envelope: PublicEnvelope = { id: this.nextId++, ...event }
    this.buffer.push(envelope)
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift()
    if (envelope.type === 'final') this.finalEvent = envelope
    for (const listener of this.listeners) listener(envelope)
  }

  /** Replays buffered events newer than `after`, then delivers live events. */
  subscribe(after: number, listener: Listener): () => void {
    clearTimeout(this.graceTimer)
    for (const event of this.buffer) {
      if (event.id > after) listener(event)
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && !this.finalEvent) this.startGraceTimer()
    }
  }

  cancel(): void {
    this.controller.abort()
  }

  private startGraceTimer(): void {
    clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => this.cancel(), GRACE_MS)
    this.graceTimer.unref()
  }
}

// globalThis keeps one registry across Next.js route bundles and dev reloads.
const registry = globalThis as typeof globalThis & { agentRuns?: Map<string, AgentRun> }
const runs = (registry.agentRuns ??= new Map<string, AgentRun>())

export function getRun(id: string): AgentRun | undefined {
  return runs.get(id)
}

export function startRun(prompt: string): AgentRun {
  const run = new AgentRun()
  runs.set(run.id, run)
  // One agent per run: an agent handles one invocation at a time.
  const agent = new Agent({
    // Pinned so the sample behaves the same when the SDK default changes.
    model: new BedrockModel({
      modelId: process.env.MODEL_ID ?? 'global.anthropic.claude-sonnet-4-6',
    }),
    systemPrompt: 'You are a helpful assistant.',
    tools: [getWeather],
    printer: false,
  })
  void execute(run, agent, prompt).finally(() => {
    setTimeout(() => runs.delete(run.id), TTL_MS).unref()
  })
  return run
}

async function execute(run: AgentRun, agent: Agent, prompt: string): Promise<void> {
  let final = errorFinalEvent
  try {
    for await (const event of agent.stream(prompt, { cancelSignal: run.signal })) {
      if (event.type === 'agentResultEvent') {
        final = toFinalEvent(event.result)
        continue
      }
      const publicEvent = toPublicEvent(event)
      if (publicEvent) run.push(publicEvent)
    }
  } catch (error) {
    console.error(`run_id=<${run.id}>, error=<${String(error)}> | agent run failed`)
  }
  // Exactly one final event per run: on success, cancellation, and error.
  run.push(final)
}
