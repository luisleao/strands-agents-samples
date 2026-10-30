'use client'
/**
 * The browser side: starts a run, reads its events with EventSource, and renders them.
 * React escapes text, so the model response never turns into HTML.
 */
import { useRef, useState, type FormEvent } from 'react'
import type { PublicEnvelope } from '@/lib/public-events'

// The run on screen: its ID, the last event ID received, its running tool calls by
// callId, and its open stream.
type Run = {
  id: string
  lastId: number
  done: boolean
  tools: Map<number, string>
  source?: EventSource
}

export default function Page() {
  const [prompt, setPrompt] = useState('What is the weather in Lisbon?')
  const [answer, setAnswer] = useState('')
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const run = useRef<Run | null>(null)

  function handle(current: Run, event: PublicEnvelope) {
    setLog((lines) => [...lines, JSON.stringify(event)])
    // Skip schema versions and event types this client does not know.
    if (event.v !== 1) return
    // The first event replaces the waiting message.
    if (current.lastId === 0) setStatus('')
    current.lastId = event.id
    switch (event.type) {
      case 'text':
        setAnswer((text) => text + event.text)
        break
      case 'redact':
        // A guardrail blocked the answer: replace everything shown so far.
        setAnswer(event.text)
        break
      case 'tool': {
        // Tools run concurrently, so track each running call by its callId.
        if (event.status === 'started') current.tools.set(event.callId, event.name)
        else current.tools.delete(event.callId)
        const names = [...current.tools.values()].join(', ')
        setStatus(names ? `Running ${names}` : '')
        break
      }
      case 'final':
        current.done = true
        current.source?.close()
        // The final event is authoritative: it replaces the streamed text.
        setAnswer(event.text || `The run ended: ${event.status}.`)
        setStatus('')
        setRunning(false)
        break
    }
  }

  // EventSource reconnects on its own and sends Last-Event-ID.
  function connect(current: Run) {
    const source = new EventSource(`/api/runs/events?id=${current.id}&after=${current.lastId}`)
    source.onmessage = (message) => handle(current, JSON.parse(message.data) as PublicEnvelope)
    source.onerror = () => {
      // CLOSED means EventSource gave up, for example after a 404 for an expired run.
      if (source.readyState === EventSource.CLOSED && !current.done) {
        setStatus('The stream closed before the run ended.')
        setRunning(false)
      }
    }
    current.source = source
  }

  async function start(submit: FormEvent<HTMLFormElement>) {
    submit.preventDefault()
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    if (!response.ok) {
      setStatus(`The run did not start: HTTP ${response.status}.`)
      return
    }
    const { id } = (await response.json()) as { id: string }
    // Leave the previous run. With no listener, it cancels itself after 30 seconds.
    run.current?.source?.close()
    const current: Run = { id, lastId: 0, done: false, tools: new Map() }
    run.current = current
    setAnswer('')
    setLog([])
    setStatus('Waiting for the agent')
    setRunning(true)
    connect(current)
  }

  // The final event of a cancelled run arrives on the open stream.
  async function stop() {
    if (!run.current) return
    setStatus('Stopping the run')
    await fetch(`/api/runs/cancel?id=${run.current.id}`, { method: 'POST' })
  }

  // Simulates a network drop, then resumes after the last event received.
  function drop() {
    const current = run.current
    if (!current) return
    current.source?.close()
    setLog((lines) => [...lines, `-- connection dropped after event ${current.lastId} --`])
    setStatus('Connection dropped. Reconnecting in 2 seconds')
    setTimeout(() => {
      if (current !== run.current || current.done) return
      setStatus('')
      connect(current)
    }, 2000)
  }

  return (
    <main>
      <h1>Stream a Strands agent to the browser</h1>
      <form id="ask" onSubmit={start}>
        <label htmlFor="prompt">Ask the agent</label>{' '}
        <input
          id="prompt"
          value={prompt}
          onChange={(change) => setPrompt(change.target.value)}
          size={40}
          required
        />{' '}
        <button>Send</button>
      </form>
      <p>
        <button type="button" id="stop" onClick={stop} disabled={!running}>
          Stop the run
        </button>{' '}
        <button type="button" id="drop" onClick={drop} disabled={!running}>
          Drop the connection
        </button>
      </p>
      <p id="status" aria-live="polite">
        {status}
      </p>
      <div id="answer" aria-busy={running}>
        {answer}
      </div>
      <h2 id="log-heading">Events on the wire</h2>
      <pre id="log" tabIndex={0} aria-labelledby="log-heading">
        {log.join('\n')}
      </pre>
    </main>
  )
}
