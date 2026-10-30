/**
 * Smoke test: checks the parts of the sample that need no AWS credentials.
 *
 *   1. The allowlist keeps reasoning, tool input, tool results, and citation sources
 *      off the wire.
 *   2. The final event carries only the text of the last message, cited text included.
 *   3. Concurrent calls to the same tool get distinct callIds.
 *   4. A guardrail redaction becomes a redact event, and the run ends blocked.
 *   5. Stop reasons map to complete, incomplete, blocked, and cancelled.
 *   6. A run replays the events after a given ID and keeps the latest 500.
 *
 * An offline model stands in for Amazon Bedrock. Run with: npm run smoke
 */
import assert from 'node:assert/strict'
import { Agent, Model } from '@strands-agents/sdk'
import type {
  AgentResult,
  AgentStreamEvent,
  BaseModelConfig,
  Message,
  ModelStreamEvent,
  StreamOptions,
} from '@strands-agents/sdk'
import { AgentRun } from './agent-runs'
import { createEventMapper, toFinalEvent } from './public-events'
import type { PublicEvent } from './public-events'
import { getWeather } from './weather-tool'

// Values the browser must never see. The offline model puts them in its reasoning, the
// tool input, the citation sources, and the redacted output. The weather tool echoes
// the input into its result.
const MARKERS = {
  reasoning: 'private-reasoning-marker',
  toolInput: 'private-tool-input-marker',
  citationSource: 'private-citation-source-marker',
  redactedOutput: 'private-redacted-output-marker',
}

const INTRO = 'Let me check the weather. '
const ANSWER = 'It is 21 degrees and sunny in Lisbon.'
const CITED = ['According to the guide, ', 'Lisbon has 300 sunny days a year.', ' Pack sunscreen.']
const BLOCKED = 'This text gets blocked. '
const REPLACEMENT = '[Assistant output redacted.]'
const PARTIAL = 'This answer stops early'

type Scenario = 'weather' | 'parallel' | 'cited' | 'redacted' | 'paused'

/** Reasons first, then streams the scenario one word at a time. */
class OfflineModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline-model' }
  private readonly scenario: Scenario

  constructor(scenario: Scenario) {
    super()
    this.scenario = scenario
  }

  updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config }
  }

  getConfig(): BaseModelConfig {
    return this.config
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    const signal = options?.cancelSignal
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield* reasoning()

    if (this.scenario === 'cited') {
      yield* text(CITED[0], signal)
      yield* citation(CITED[1])
      yield* text(CITED[2], signal)
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
      return
    }
    if (this.scenario === 'redacted') {
      yield* text(BLOCKED, signal)
      // Like Bedrock guardrails: the redaction follows the message stop.
      yield { type: 'modelMessageStopEvent', stopReason: 'guardrailIntervened' }
      yield {
        type: 'modelRedactionEvent',
        outputRedaction: { replaceContent: REPLACEMENT, redactedContent: MARKERS.redactedOutput },
      }
      return
    }
    if (this.scenario === 'paused') {
      yield* text(PARTIAL, signal)
      yield { type: 'modelMessageStopEvent', stopReason: 'pauseTurn' }
      return
    }

    const afterTool = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock')
    )
    if (afterTool) {
      yield* text(ANSWER, signal)
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
      return
    }
    yield* text(INTRO, signal)
    yield* toolUse('tool-1', 'Lisbon')
    // Two calls to the same tool in one message, so they run concurrently.
    if (this.scenario === 'parallel') yield* toolUse('tool-2', 'Porto')
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
  }
}

async function* reasoning(): AsyncGenerator<ModelStreamEvent> {
  yield { type: 'modelContentBlockStartEvent' }
  yield {
    type: 'modelContentBlockDeltaEvent',
    delta: { type: 'reasoningContentDelta', text: `${MARKERS.reasoning}: plan the answer` },
  }
  yield { type: 'modelContentBlockStopEvent' }
}

async function* text(value: string, signal?: AbortSignal): AsyncGenerator<ModelStreamEvent> {
  yield { type: 'modelContentBlockStartEvent' }
  for (const word of value.split(/(?<= )/)) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (signal?.aborted) break
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: word } }
  }
  yield { type: 'modelContentBlockStopEvent' }
}

async function* citation(value: string): AsyncGenerator<ModelStreamEvent> {
  yield { type: 'modelContentBlockStartEvent' }
  yield {
    type: 'modelContentBlockDeltaEvent',
    delta: {
      type: 'citationsDelta',
      citations: [
        {
          location: { type: 'documentChar', documentIndex: 0, start: 0, end: value.length },
          source: MARKERS.citationSource,
          sourceContent: [{ text: MARKERS.citationSource }],
          title: MARKERS.citationSource,
        },
      ],
      content: [{ text: value }],
    },
  }
  yield { type: 'modelContentBlockStopEvent' }
}

async function* toolUse(toolUseId: string, city: string): AsyncGenerator<ModelStreamEvent> {
  yield {
    type: 'modelContentBlockStartEvent',
    start: { type: 'toolUseStart', name: 'get_weather', toolUseId },
  }
  yield {
    type: 'modelContentBlockDeltaEvent',
    delta: {
      type: 'toolUseInputDelta',
      input: JSON.stringify({ city: `${city} ${MARKERS.toolInput}` }),
    },
  }
  yield { type: 'modelContentBlockStopEvent' }
}

/** Streams one run the way agent-runs.ts does, and keeps what each side would see. */
async function streamRun(scenario: Scenario, cancelSignal?: AbortSignal) {
  const agent = new Agent({ model: new OfflineModel(scenario), tools: [getWeather], printer: false })
  const toPublicEvent = createEventMapper()
  const raw: AgentStreamEvent[] = []
  const published: PublicEvent[] = []
  for await (const event of agent.stream('What is the weather?', { cancelSignal })) {
    raw.push(event)
    const publicEvent =
      event.type === 'agentResultEvent' ? toFinalEvent(event.result) : toPublicEvent(event)
    if (publicEvent) published.push(publicEvent)
  }
  return { raw: JSON.stringify(raw), wire: JSON.stringify(published), published }
}

const streamedText = (events: PublicEvent[]) =>
  events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('')

const toolEvents = (events: PublicEvent[]) =>
  events.flatMap((event) => (event.type === 'tool' ? [event] : []))

async function main(): Promise<void> {
  // 1. Allowlist ----------------------------------------------------------
  const weather = await streamRun('weather')
  // The raw Strands events carry the markers, so forwarding them would leak.
  assert.ok(weather.raw.includes(MARKERS.reasoning), 'raw events include the reasoning')
  assert.ok(weather.raw.includes(MARKERS.toolInput), 'raw events include the tool input')
  assert.ok(!weather.wire.includes(MARKERS.reasoning), 'public events drop the reasoning')
  assert.ok(!weather.wire.includes(MARKERS.toolInput), 'public events drop tool input and result')
  assert.deepEqual(toolEvents(weather.published), [
    { v: 1, type: 'tool', callId: 1, name: 'get_weather', status: 'started' },
    { v: 1, type: 'tool', callId: 1, name: 'get_weather', status: 'succeeded' },
  ])
  console.log('  [allowlist] no reasoning, tool input, or tool result on the wire: OK')

  // 2. Final event --------------------------------------------------------
  assert.equal(streamedText(weather.published), INTRO + ANSWER, 'text events carry every delta')
  assert.deepEqual(weather.published.at(-1), {
    v: 1,
    type: 'final',
    status: 'complete',
    stopReason: 'endTurn',
    text: ANSWER,
  })
  assert.equal(weather.published.filter((event) => event.type === 'final').length, 1)
  const cited = await streamRun('cited')
  assert.equal(streamedText(cited.published), CITED.join(''), 'text events carry cited text')
  const citedFinal = cited.published.at(-1)
  assert.ok(citedFinal?.type === 'final' && citedFinal.text === CITED.join(''), 'final has cited text')
  assert.ok(cited.raw.includes(MARKERS.citationSource), 'raw events include the sources')
  assert.ok(!cited.wire.includes(MARKERS.citationSource), 'public events drop the sources')
  console.log('  [final] one final event with the last message, cited text included: OK')

  // 3. Concurrent tool calls ----------------------------------------------
  const parallel = await streamRun('parallel')
  const calls = toolEvents(parallel.published)
  const started = calls.filter((call) => call.status === 'started').map((call) => call.callId)
  const finished = calls.filter((call) => call.status !== 'started').map((call) => call.callId)
  assert.deepEqual(started, [1, 2], 'each call gets its own callId')
  assert.deepEqual([...finished].sort(), [1, 2], 'each call finishes under its callId')
  assert.ok(calls.every((call) => call.name === 'get_weather'), 'both calls use the same tool')
  console.log('  [tools] two concurrent calls to one tool get callIds 1 and 2: OK')

  // 4. Redaction ----------------------------------------------------------
  const redacted = await streamRun('redacted')
  const types = redacted.published.map((event) => event.type)
  assert.equal(streamedText(redacted.published), BLOCKED, 'the blocked text streamed first')
  assert.equal(types.indexOf('redact'), types.lastIndexOf('text') + 1, 'redact follows the text')
  assert.deepEqual(redacted.published.find((event) => event.type === 'redact'), {
    v: 1,
    type: 'redact',
    text: REPLACEMENT,
  })
  assert.deepEqual(redacted.published.at(-1), {
    v: 1,
    type: 'final',
    status: 'blocked',
    stopReason: 'guardrailIntervened',
    text: REPLACEMENT,
  })
  assert.ok(redacted.raw.includes(MARKERS.redactedOutput), 'raw events include the original')
  assert.ok(!redacted.wire.includes(MARKERS.redactedOutput), 'public events drop the original')
  console.log('  [redact] a redact event replaces the text, and the run ends blocked: OK')

  // 5. Stop reasons -------------------------------------------------------
  const paused = await streamRun('paused')
  assert.deepEqual(paused.published.at(-1), {
    v: 1,
    type: 'final',
    status: 'incomplete',
    stopReason: 'pauseTurn',
    text: PARTIAL,
  })
  const expectedStatus: [string, string][] = [
    ['endTurn', 'complete'],
    ['stopSequence', 'complete'],
    ['guardrailIntervened', 'blocked'],
    ['contentFiltered', 'blocked'],
    ['refusal', 'blocked'],
    ['limitTurns', 'incomplete'],
    ['interrupt', 'incomplete'],
    ['checkpoint', 'incomplete'],
  ]
  for (const [stopReason, status] of expectedStatus) {
    const result = { stopReason, lastMessage: { content: [] } } as unknown as AgentResult
    const event = toFinalEvent(result)
    assert.ok(event.type === 'final' && event.status === status, `${stopReason} maps to ${status}`)
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 8)
  const cancelled = await streamRun('weather', controller.signal)
  assert.deepEqual(cancelled.published.at(-1), {
    v: 1,
    type: 'final',
    status: 'cancelled',
    stopReason: 'cancelled',
    text: '',
  })
  console.log('  [stop] stop reasons map to complete, incomplete, blocked, and cancelled: OK')

  // 6. Replay buffer ------------------------------------------------------
  const run = new AgentRun()
  for (let i = 1; i <= 510; i++) run.push({ v: 1, type: 'text', text: `chunk ${i}` })
  const received: number[] = []
  const unsubscribe = run.subscribe(505, (event) => received.push(event.id))
  assert.deepEqual(received, [506, 507, 508, 509, 510], 'replays the events after ID 505')
  run.push({ v: 1, type: 'final', status: 'complete', text: 'done' })
  assert.equal(received.at(-1), 511, 'delivers live events after the replay')
  assert.equal(run.finalEvent?.id, 511, 'records the final event')
  unsubscribe()
  const replayed: number[] = []
  run.subscribe(0, (event) => replayed.push(event.id))()
  assert.equal(replayed.length, 500, 'keeps the latest 500 events')
  assert.equal(replayed[0], 12, 'drops the oldest events first')
  run.cancel()
  assert.ok(run.signal.aborted, 'cancel() aborts the agent signal')
  console.log('  [replay] resumes after an event ID and keeps the latest 500: OK')

  console.log('\nSmoke test passed.')
}

main().catch((error) => {
  console.error('\nSmoke test FAILED:', error)
  process.exit(1)
})
