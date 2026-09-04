/**
 * Server-sent events.
 *
 * Chosen over a WebSocket because the traffic is one-directional and short-lived:
 * SSE needs no connection server, survives Vercel's function model, and
 * reconnects on its own. Approval replies come back as ordinary POSTs.
 */
export function sseStream<T>(source: AsyncGenerator<T>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      // Flush immediately so proxies don't sit on the first bytes.
      controller.enqueue(encoder.encode(': open\n\n'))
      try {
        for await (const event of source) send(event)
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : 'Stream failed', fatal: true })
        send({ type: 'done', reason: 'error' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
