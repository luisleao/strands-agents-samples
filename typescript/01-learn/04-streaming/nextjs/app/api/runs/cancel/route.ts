/**
 * POST /api/runs/cancel?id=<run id> stops the agent. The run then ends with a final
 * event with status `cancelled`.
 */
import { getRun } from '@/lib/agent-runs'

export const runtime = 'nodejs'

export function POST(req: Request) {
  const run = getRun(new URL(req.url).searchParams.get('id') ?? '')
  if (!run) return new Response(null, { status: 404 })
  run.cancel()
  return new Response(null, { status: 202 })
}
