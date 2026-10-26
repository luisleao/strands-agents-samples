/**
 * POST /api/runs starts a run and returns its ID.
 */
import { startRun } from '@/lib/agent-runs'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { prompt?: unknown } | null
  const prompt = body?.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return Response.json({ error: 'prompt must be a non-empty string' }, { status: 400 })
  }
  return Response.json({ id: startRun(prompt).id }, { status: 201 })
}
