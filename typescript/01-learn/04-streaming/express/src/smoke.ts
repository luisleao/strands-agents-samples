/**
 * Smoke test: checks the parts of the sample that need no AWS credentials.
 *
 *   1. The allowlist keeps reasoning, tool input, and tool results off the wire.
 *   2. The final event carries only the text of the last message.
 *   3. A cancelled run ends with status `cancelled` and empty text.
 *   4. A run replays the events after a given ID and keeps the latest 500.
 *
 * An offline model stands in for Amazon Bedrock. Run with: npm run smoke
 */
import assert from 'node:assert/strict'
import { Agent, Model } from '@strands-agents/sdk'
import type {
  AgentStreamEvent,
  BaseModelConfig,
  Message,
  ModelStreamEvent,
  StreamOptions,
} from '@strands-agents/sdk'
import { AgentRun } from './agent-runs'
import { toFinalEvent, toPublicEvent } from './public-events'
import type { PublicEvent } from './public-events'
import { getWeather } from './weather-tool'

// Values the browser must never see. The offline model puts them in its reasoning and
// in the tool input, and the weather tool echoes the input into its result.
const REASONING_MARKER = 'private-reasoning-marker'
const TOOL_INPUT_MARKER = 'private-tool-input-marker'

const INTRO = 'Let me check the weather. '
const ANSWER = 'It is 21 degrees and sunny in Lisbon.'

/** Reasons, calls get_weather, then answers, one word at a time. */
class OfflineModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline-model' }

  updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config }
  }

  getConfig(): BaseModelConfig {
    return this.config
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    const afterTool = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock')
    )
    yield { type: 'modelMessageStartEvent', role: 'assistant' }

    yield { type: 'modelContentBlockStartEvent' }
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'reasoningContentDelta', text: `${REASONING_MARKER}: plan the answer` },
    }
    yield { type: 'modelContentBlockStopEvent' }

    yield { type: 'modelContentBlockStartEvent' }
    for (const word of (afterTool ? ANSWER : INTRO).split(/(?<= )/)) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (options?.cancelSignal?.aborted) break
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: word } }
    }
    yield { type: 'modelContentBlockStopEvent' }

    if (afterTool) {
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
      return
    }
    yield {
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', name: 'get_weather', toolUseId: 'tool-1' },
    }
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: {
        type: 'toolUseInputDelta',
        input: JSON.stringify({ city: `Lisbon ${TOOL_INPUT_MARKER}` }),
      },
    }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
  }
}

function createOfflineAgent(): Agent {
  return new Agent({ model: new OfflineModel(), tools: [getWeather], printer: false })
}

/** Streams one run the way agent-runs.ts does, and keeps what each side would see. */
async function streamRun(cancelSignal?: AbortSignal) {
  const raw: AgentStreamEvent[] = []
  const published: PublicEvent[] = []
  for await (const event of createOfflineAgent().stream('Weather in Lisbon?', { cancelSignal })) {
    raw.push(event)
    const publicEvent =
      event.type === 'agentResultEvent' ? toFinalEvent(event.result) : toPublicEvent(event)
    if (publicEvent) published.push(publicEvent)
  }
  return { raw, published }
}

async function main(): Promise<void> {
  // 1. Allowlist ----------------------------------------------------------
  const { raw, published } = await streamRun()
  const rawJson = JSON.stringify(raw)
  const wireJson = JSON.stringify(published)
  // The raw Strands events carry both markers, so forwarding them would leak.
  assert.ok(rawJson.includes(REASONING_MARKER), 'raw events include the reasoning')
  assert.ok(rawJson.includes(TOOL_INPUT_MARKER), 'raw events include the tool input')
  assert.ok(!wireJson.includes(REASONING_MARKER), 'public events drop the reasoning')
  assert.ok(!wireJson.includes(TOOL_INPUT_MARKER), 'public events drop tool input and result')
  assert.deepEqual(
    published.filter((event) => event.type === 'tool'),
    [
      { v: 1, type: 'tool', name: 'get_weather', status: 'started' },
      { v: 1, type: 'tool', name: 'get_weather', status: 'succeeded' },
    ]
  )
  console.log('  [allowlist] no reasoning, tool input, or tool result on the wire: OK')

  // 2. Final event --------------------------------------------------------
  const streamedText = published.flatMap((event) => (event.type === 'text' ? [event.text] : []))
  assert.equal(streamedText.join(''), INTRO + ANSWER, 'text events carry every text delta')
  assert.deepEqual(published.at(-1), {
    v: 1,
    type: 'final',
    status: 'complete',
    stopReason: 'endTurn',
    text: ANSWER,
  })
  assert.equal(published.filter((event) => event.type === 'final').length, 1)
  console.log('  [final] one final event with the text of the last message only: OK')

  // 3. Cancellation -------------------------------------------------------
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 8)
  const cancelled = await streamRun(controller.signal)
  assert.deepEqual(cancelled.published.at(-1), {
    v: 1,
    type: 'final',
    status: 'cancelled',
    stopReason: 'cancelled',
    text: '',
  })
  console.log('  [cancel] a cancelled run ends with status cancelled and no text: OK')

  // 4. Replay buffer ------------------------------------------------------
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
