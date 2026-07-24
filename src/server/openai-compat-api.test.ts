import { afterEach, describe, expect, it, vi } from 'vitest'

import { openaiChat, parseOpenAIStream } from './openai-compat-api'

function createStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
      },
    },
  )
}

const ORIGINAL_HOME = process.env.HOME

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.HERMES_API_TOKEN
  delete process.env.CLAUDE_API_TOKEN
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
})

describe('openaiChat', () => {
  it('sends Hermes session continuity headers with authentication when available', async () => {
    process.env.HERMES_API_TOKEN = 'test-token'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await openaiChat([{ role: 'user', content: 'hello' }], {
      model: 'hermes-agent',
      sessionId: 'workspace-session-1',
    })

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-token')
    expect(headers['X-Hermes-Session-Id']).toBe('workspace-session-1')
    expect(headers['X-Claude-Session-Id']).toBe('workspace-session-1')
  })

  it('sends Hermes session continuity headers even without a bearer token', async () => {
    process.env.HOME = '/tmp/hermes-workspace-test-no-codex-auth'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await openaiChat([{ role: 'user', content: 'hello' }], {
      model: 'hermes-agent',
      sessionId: 'workspace-session-2',
    })

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['X-Hermes-Session-Id']).toBe('workspace-session-2')
    expect(headers['X-Claude-Session-Id']).toBe('workspace-session-2')
  })
})

describe('parseOpenAIStream', () => {
  it('passes through ordinary content chunks', async () => {
    const response = createStreamResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ])

    const chunks = []
    for await (const chunk of parseOpenAIStream(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      { type: 'content', text: 'Hello' },
      { type: 'content', text: ' world' },
    ])
  })

  it('preserves a complete provider receipt from the terminal usage chunk', async () => {
    const response = createStreamResponse([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"provider_receipt":{"provider":"gemini","configuredModel":"gemini-3.6-flash","responseId":"resp-1","modelVersion":"gemini-3.6-flash-001","evidenceSource":"gemini_response.modelVersion","usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1,"totalTokenCount":3},"finishReason":"STOP"}}}\n\n',
      'data: [DONE]\n\n',
    ])

    const chunks = []
    for await (const chunk of parseOpenAIStream(response)) chunks.push(chunk)

    expect(chunks).toEqual([
      {
        type: 'provider-receipt',
        receipt: {
          provider: 'gemini',
          configuredModel: 'gemini-3.6-flash',
          responseId: 'resp-1',
          modelVersion: 'gemini-3.6-flash-001',
          evidenceSource: 'gemini_response.modelVersion',
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
          finishReason: 'STOP',
        },
        providerModelEvidence: {
          configuredModel: 'gemini-3.6-flash',
          actualModel: 'gemini-3.6-flash-001',
          evidenceSource: 'gemini_response.modelVersion',
          responseId: 'resp-1',
        },
      },
    ])
  })

  it('does not reuse a provider receipt across sequential streams', async () => {
    const first = createStreamResponse([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"provider_receipt":{"provider":"gemini","configuredModel":"gemini-3.6-flash","responseId":"resp-1","modelVersion":"gemini-3.6-flash-001","evidenceSource":"gemini_response.modelVersion","usageMetadata":{"totalTokenCount":3},"finishReason":"STOP"}}}\n\n',
      'data: [DONE]\n\n',
    ])
    const second = createStreamResponse([
      'data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])

    const firstChunks = []
    for await (const chunk of parseOpenAIStream(first)) firstChunks.push(chunk)
    const secondChunks = []
    for await (const chunk of parseOpenAIStream(second))
      secondChunks.push(chunk)

    expect(firstChunks.some((chunk) => chunk.type === 'provider-receipt')).toBe(
      true,
    )
    expect(firstChunks[0]).toHaveProperty(
      'providerModelEvidence.actualModel',
      'gemini-3.6-flash-001',
    )
    expect(secondChunks).toEqual([{ type: 'content', text: 'second' }])
  })

  it('rejects non-Gemini and unknown-only receipt metadata', async () => {
    const response = createStreamResponse([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"provider_receipt":{"provider":"environment","responseId":"env-1","modelVersion":"gemini-3.6-flash","usageMetadata":{"inventedCount":3},"finishReason":"STOP"}}}\n\n',
      'data: [DONE]\n\n',
    ])

    const chunks = []
    for await (const chunk of parseOpenAIStream(response)) chunks.push(chunk)

    expect(chunks).toEqual([])
  })

  it('does not elevate an untrusted model evidence source', async () => {
    const response = createStreamResponse([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"provider_receipt":{"provider":"gemini","configuredModel":"gemini-3.6-flash","responseId":"resp-1","modelVersion":"gemini-3.6-flash","evidenceSource":"environment","usageMetadata":{"totalTokenCount":3},"finishReason":"STOP"}}}\n\n',
      'data: [DONE]\n\n',
    ])

    const chunks = []
    for await (const chunk of parseOpenAIStream(response)) chunks.push(chunk)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).not.toHaveProperty('providerModelEvidence')
    expect(chunks[0]).not.toHaveProperty('receipt.configuredModel')
  })

  it('emits synthetic tool events for Hermes tool progress frames', async () => {
    const response = createStreamResponse([
      'event: claude.tool.progress\n',
      'data: {"tool":"terminal","emoji":"💻","label":"ls -la"}\n\n',
      'data: [DONE]\n\n',
    ])

    const chunks = []
    for await (const chunk of parseOpenAIStream(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      {
        type: 'tool',
        name: 'terminal',
        label: '💻 ls -la',
      },
    ])
  })

  it('handles multiple tool events even when frames are split across transport chunks', async () => {
    const response = createStreamResponse([
      'event: claude.tool.progress\ndata: {"tool":"browser_get_images","emoji":"📖","la',
      'bel":"scan page"}\n\n',
      'event: claude.tool.progress\ndata: {"tool":"browser_console","emoji":"🔎","label":"inspect DOM"}\n\n',
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
      'data: [DONE]\n\n',
    ])

    const chunks = []
    for await (const chunk of parseOpenAIStream(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      {
        type: 'tool',
        name: 'browser_get_images',
        label: '📖 scan page',
      },
      {
        type: 'tool',
        name: 'browser_console',
        label: '🔎 inspect DOM',
      },
      { type: 'content', text: 'done' },
    ])
  })
})
