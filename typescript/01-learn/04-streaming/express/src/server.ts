/**
 * Express routes: start a run, stream it with server-sent events, poll it as a
 * fallback, and cancel it.
 */
import express, { type Request } from 'express'
import { getRun, startRun } from './agent-runs'
import type { PublicEnvelope } from './public-events'

const app = express()
app.use(express.json())
// Serves public/index.html, the browser page of the complete example.
app.use(express.static('public'))

app.post('/runs', (req, res) => {
  const prompt = req.body?.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'prompt must be a non-empty string' })
    return
  }
  res.status(201).json({ id: startRun(prompt).id })
})

// EventSource sends Last-Event-ID when it reconnects. A new connection sends ?after.
function lastSeenId(req: Request): number {
  const id = Number(req.get('Last-Event-ID') ?? req.query.after ?? 0)
  return Number.isInteger(id) && id > 0 ? id : 0
}

// How far a client may fall behind before the server drops it.
const MAX_PENDING_BYTES = 256 * 1024

app.get('/runs/:id/events', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) {
    res.sendStatus(404)
    return
  }
  const after = lastSeenId(req)
  if (run.finalEvent && after >= run.finalEvent.id) {
    // 204 tells EventSource to stop reconnecting.
    res.sendStatus(204)
    return
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  res.write('retry: 3000\n\n')

  const open = () => !res.writableEnded && !res.destroyed
  const heartbeat = setInterval(() => {
    if (open()) res.write(': ping\n\n')
  }, 15_000)
  const unsubscribe = run.subscribe(after, (event) => {
    if (!open()) return
    res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
    if (event.type === 'final') res.end()
    // Drop a client that stopped reading, so unsent events can't pile up.
    // EventSource reconnects with Last-Event-ID, and the buffer replays the rest.
    else if (res.writableLength > MAX_PENDING_BYTES) res.destroy()
  })
  // A dropped connection only unsubscribes. The run keeps going for a reconnect.
  res.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
})

// Long polling fallback, for networks that buffer streaming responses.
app.get('/runs/:id/poll', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) {
    res.sendStatus(404)
    return
  }
  const events: PublicEnvelope[] = []
  const stopWaiting = () => {
    clearTimeout(timeout)
    unsubscribe()
  }
  const respond = () => {
    stopWaiting()
    if (!res.headersSent) res.json({ events })
  }
  // Answer after the replayed batch or the first live event, or after 25 seconds.
  const unsubscribe = run.subscribe(lastSeenId(req), (event) => {
    if (events.push(event) === 1) queueMicrotask(respond)
  })
  const timeout = setTimeout(respond, 25_000)
  // The client went away: stop waiting, and write nothing to the closed connection.
  res.on('close', stopWaiting)
})

// Stops the agent. The run then ends with a final event with status `cancelled`.
app.post('/runs/:id/cancel', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) {
    res.sendStatus(404)
    return
  }
  run.cancel()
  res.sendStatus(202)
})

const port = Number(process.env.PORT ?? 3000)
app.listen(port, (error) => {
  if (error) throw error
  console.log(`Open http://localhost:${port} in your browser`)
})
