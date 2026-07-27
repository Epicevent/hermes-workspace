import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toChatMessage } from './claude-api'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Hermes history image projection', () => {
  it('restores a persisted user MEDIA reference as a native attachment', () => {
    const stateDir = resolve('/root/.hermes/workspace')
    const digest = 'a'.repeat(64)
    const mediaPath = resolve(
      stateDir,
      'artifacts',
      'chat-uploads',
      `${digest}.png`,
    )
    vi.stubEnv('HERMES_WORKSPACE_STATE_DIR', stateDir)
    const message = toChatMessage({
      id: 7,
      session_id: 'session-1',
      role: 'user',
      content: `Inspect this image\n\n![probe.png](MEDIA:${mediaPath})`,
      timestamp: 123,
    })

    expect(message.content).toEqual([
      { type: 'text', text: 'Inspect this image' },
    ])
    expect(message.text).toBe('Inspect this image')
    expect(message.attachments).toEqual([
      {
        id: `persisted-${digest}`,
        name: 'probe.png',
        contentType: 'image/png',
        size: undefined,
        url: `/api/media?path=${encodeURIComponent(mediaPath)}`,
      },
    ])
  })

  it('leaves assistant MEDIA output in text for the markdown renderer', () => {
    const message = toChatMessage({
      id: 8,
      session_id: 'session-1',
      role: 'assistant',
      content: 'MEDIA:/workspace/generated.png',
      timestamp: 124,
    })

    expect(message.content).toEqual([
      { type: 'text', text: 'MEDIA:/workspace/generated.png' },
    ])
    expect(message).not.toHaveProperty('attachments')
  })
})
