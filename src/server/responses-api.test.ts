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

  it('does not reuse a provider receipt across sequential requests', async () => {
    const encoder = new TextEncoder()
    const completed = (providerReceipt?: Record<string, unknown>) => ({
      type: 'response.completed',
      response: {
        usage: providerReceipt ? { provider_receipt: providerReceipt } : {},
      },
    })
    const response = (payload: Record<string, unknown>) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`,
              ),
            )
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          response(
            completed({
              provider: 'gemini',
              responseId: 'resp-1',
              modelVersion: 'gemini-3.6-flash',
              usageMetadata: { totalTokenCount: 3 },
              finishReason: 'STOP',
            }),
          ),
        )
        .mockResolvedValueOnce(response(completed())),
    )

    const first = []
    for await (const event of streamResponses({ input: 'first' }))
      first.push(event)
    const second = []
    for await (const event of streamResponses({ input: 'second' }))
      second.push(event)

    expect(first[0]).toHaveProperty('providerReceipt.responseId', 'resp-1')
    expect(second).toEqual([{ kind: 'completed' }])
  })

  it('rejects non-Gemini and unknown-only receipt metadata', async () => {
    const encoder = new TextEncoder()
    const payload = {
      type: 'response.completed',
      response: {
        usage: {
          provider_receipt: {
            provider: 'environment',
            responseId: 'env-1',
            modelVersion: 'gemini-3.6-flash',
            usageMetadata: { inventedCount: 3 },
            finishReason: 'STOP',
          },
        },
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`,
                ),
              )
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    )

    const events = []
    for await (const event of streamResponses({ input: 'test' }))
      events.push(event)

    expect(events).toEqual([{ kind: 'completed' }])
  })
})
