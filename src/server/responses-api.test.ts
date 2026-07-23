import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamResponses } from './responses-api'

afterEach(() => vi.restoreAllMocks())

describe('streamResponses provider receipts', () => {
  it('preserves a complete Gemini receipt from response.completed', async () => {
    const encoder = new TextEncoder()
    const payload = {
      type: 'response.completed',
      response: {
        usage: {
          provider_receipt: {
            provider: 'gemini',
            responseId: 'resp-1',
            modelVersion: 'gemini-3.6-flash',
            usageMetadata: {
              promptTokenCount: 2,
              candidatesTokenCount: 1,
              totalTokenCount: 3,
            },
            finishReason: 'STOP',
          },
        },
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`))
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )))

    const events = []
    for await (const event of streamResponses({ input: 'test' })) events.push(event)

    expect(events).toEqual([{
      kind: 'completed',
      providerReceipt: {
        provider: 'gemini',
        responseId: 'resp-1',
        modelVersion: 'gemini-3.6-flash',
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        finishReason: 'STOP',
      },
    }])
  })
})
