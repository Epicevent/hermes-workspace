import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendPersistedChatImages,
  persistUploadedChatImages,
  projectPersistedChatImages,
} from './persisted-chat-attachments'

const temporaryRoots: Array<string> = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('persisted chat attachments', () => {
  it('stores an image by digest and treats an exact replay as idempotent', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hermes-chat-image-'))
    temporaryRoots.push(rootDir)
    const bytes = Buffer.from('synthetic-image-bytes')
    const attachment = {
      name: 'customer-[probe].png',
      contentType: 'image/png',
      base64: bytes.toString('base64'),
    }

    const first = persistUploadedChatImages([attachment], { rootDir })
    const replay = persistUploadedChatImages([attachment], { rootDir })

    expect(first).toEqual(replay)
    expect(first).toHaveLength(1)
    expect(first[0].name).toBe('customer-_probe_.png')
    expect(first[0].digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(readFileSync(first[0].mediaPath)).toEqual(bytes)
  })

  it('keeps non-image attachments out of the persisted image store', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hermes-chat-image-'))
    temporaryRoots.push(rootDir)
    expect(
      persistUploadedChatImages(
        [
          {
            name: 'notes.txt',
            contentType: 'text/plain',
            base64: Buffer.from('notes').toString('base64'),
          },
        ],
        { rootDir },
      ),
    ).toEqual([])
  })

  it('round-trips safe MEDIA references into native UI attachments', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hermes-chat-image-'))
    temporaryRoots.push(rootDir)
    const [image] = persistUploadedChatImages(
      [
        {
          name: 'probe.png',
          contentType: 'image/png',
          base64: Buffer.from('abc').toString('base64'),
        },
      ],
      { rootDir },
    )
    const persisted = appendPersistedChatImages('Inspect this image', [image])

    expect(persisted).toBe(
      `Inspect this image\n\n![probe.png](MEDIA:${image.mediaPath})`,
    )
    expect(projectPersistedChatImages(persisted, { rootDir })).toEqual({
      text: 'Inspect this image',
      attachments: [
        {
          id: `persisted-${image.digest.slice('sha256:'.length)}`,
          name: 'probe.png',
          contentType: 'image/png',
          size: 3,
          url: `/api/media?path=${encodeURIComponent(image.mediaPath)}`,
        },
      ],
    })
  })

  it('leaves a self-authored MEDIA path outside the upload store as text', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hermes-chat-image-'))
    temporaryRoots.push(rootDir)
    const content = `![probe.png](MEDIA:${join(rootDir, '..', `${'a'.repeat(64)}.png`)})`

    expect(projectPersistedChatImages(content, { rootDir })).toEqual({
      text: content,
      attachments: [],
    })
  })

  it('rejects malformed image bytes instead of persisting a broken receipt', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hermes-chat-image-'))
    temporaryRoots.push(rootDir)
    expect(() =>
      persistUploadedChatImages(
        [{ name: 'bad.png', contentType: 'image/png', base64: '***' }],
        { rootDir },
      ),
    ).toThrow('Invalid image attachment encoding')
  })

  it('rejects an oversized image before writing an artifact', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hermes-chat-image-'))
    temporaryRoots.push(rootDir)
    const oversized = Buffer.alloc(1024 * 1024 + 1).toString('base64')

    expect(() =>
      persistUploadedChatImages(
        [{ name: 'large.png', contentType: 'image/png', base64: oversized }],
        { rootDir },
      ),
    ).toThrow('Persisted image attachment exceeds the 1MB limit')
  })
})
