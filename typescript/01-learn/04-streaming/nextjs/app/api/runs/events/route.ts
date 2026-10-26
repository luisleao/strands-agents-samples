/**
 * GET /api/runs/events?id=<run id> streams a run with server-sent events.
 */
import { getRun } from '@/lib/agent-runs'
import type { AgentRun } from '@/lib/agent-runs'

export const runtime = 'nodejs'

const encoder = new TextEncoder()

// EventSource sends Last-Event-ID when it reconnects. A new connection sends ?after.
function lastSeenId(req: Request, url: URL): number {
  const header = req.headers.get('last-event-id')
  const id = Number(header ?? url.searchParams.get('after') ?? 0)
  return Number.isInteger(id) && id > 0 ? id : 0
}

function eventStream(run: AgentRun, after: number): ReadableStream<Uint8Array> {
  let stop = () => {}
  return new ReadableStream({
    start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk))
      const heartbeat = setInterval(() => send(': ping\n\n'), 15_000)
      let unsubscribe = () => {}
      let stopped = false
      stop = () => {
        stopped = true
        clearInterval(heartbeat)
        unsubscribe()
      }
      send('retry: 3000\n\n')
      unsubscribe = run.subscribe(after, (event) => {
        send(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
        if (event.type !== 'final') return
        // Close on the next microtask, once subscribe() has returned.
        queueMicrotask(() => {
          if (stopped) return
          stop()
          controller.close()
        })
      })
    },
    // The client went away: unsubscribe and keep the run going for a reconnect.
    cancel() {
      stop()
    },
  })
}

export function GET(req: Request) {
  const url = new URL(req.url)
  const run = getRun(url.searchParams.get('id') ?? '')
  if (!run) return new Response(null, { status: 404 })
  const after = lastSeenId(req, url)
  if (run.finalEvent && after >= run.finalEvent.id) {
    // 204 tells EventSource to stop reconnecting.
    return new Response(null, { status: 204 })
  }
  return new Response(eventStream(run, after), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
