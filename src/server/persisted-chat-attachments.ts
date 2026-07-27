import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { getStateDir } from './workspace-state-dir'

const MAX_IMAGE_BYTES = 1024 * 1024

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
}

const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_EXTENSION_BY_MIME).map(([mime, extension]) => [
    extension,
    mime,
  ]),
)

export type PersistedChatImage = {
  name: string
  mediaPath: string
  contentType: string
  size: number
  digest: string
}

export type ProjectedChatAttachment = {
  id: string
  name: string
  contentType?: string
  size?: number
  url: string
}

function isWithinDirectory(rootDir: string, target: string): boolean {
  const targetRelativeToRoot = relative(rootDir, target)
  return (
    targetRelativeToRoot === '' ||
    (!targetRelativeToRoot.startsWith('..') &&
      !isAbsolute(targetRelativeToRoot))
  )
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function safeDisplayName(value: unknown, extension: string): string {
  const normalized = readString(value).replaceAll('\\', '/')
  const leaf = basename(normalized) || `image${extension}`
  const safe = leaf.replace(/[[\]\r\n]/g, '_').slice(0, 160)
  return safe || `image${extension}`
}

function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, '')
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('Invalid image attachment encoding')
  }
  if (compact.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error('Persisted image attachment exceeds the 1MB limit')
  }
  const bytes = Buffer.from(compact, 'base64')
  const canonical = compact.replace(/=+$/g, '')
  if (
    bytes.length === 0 ||
    bytes.toString('base64').replace(/=+$/g, '') !== canonical
  ) {
    throw new Error('Invalid image attachment encoding')
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Persisted image attachment exceeds the 1MB limit')
  }
  return bytes
}

function verifyExistingTarget(target: string, digest: string): void {
  const existingDigest = createHash('sha256')
    .update(readFileSync(target))
    .digest('hex')
  if (existingDigest !== digest) {
    throw new Error('Persisted image digest collision')
  }
}

function writeContentAddressedFile(
  rootDir: string,
  target: string,
  bytes: Buffer,
  digest: string,
): void {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  if (existsSync(target)) {
    verifyExistingTarget(target, digest)
    return
  }

  const temporary = resolve(rootDir, `.${digest}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    try {
      renameSync(temporary, target)
    } catch (error) {
      if (!existsSync(target)) throw error
      verifyExistingTarget(target, digest)
      rmSync(temporary, { force: true })
    }
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Persist image bytes before the provider call and return content-free MEDIA
 * references suitable for a session transcript. Files are content addressed,
 * private to the slot's Hermes state volume, and exact replays are idempotent.
 */
export function persistUploadedChatImages(
  attachments: Array<Record<string, unknown>> | undefined,
  options: { rootDir?: string } = {},
): Array<PersistedChatImage> {
  if (!attachments || attachments.length === 0) return []

  const rootDir = resolve(
    options.rootDir ?? resolve(getStateDir(), 'artifacts', 'chat-uploads'),
  )
  const persisted: Array<PersistedChatImage> = []

  for (const attachment of attachments) {
    const contentType = (
      readString(attachment.contentType) ||
      readString(attachment.mimeType) ||
      readString(attachment.mediaType)
    ).toLowerCase()
    const extension = IMAGE_EXTENSION_BY_MIME[contentType]
    if (!extension) continue

    const encoded =
      readString(attachment.base64) ||
      readString(attachment.content) ||
      readString(attachment.data)
    const bytes = decodeBase64(encoded)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const target = resolve(rootDir, `${digest}${extension}`)
    if (!isWithinDirectory(rootDir, target)) {
      throw new Error('Persisted image escaped the attachment directory')
    }
    writeContentAddressedFile(rootDir, target, bytes, digest)
    persisted.push({
      name: safeDisplayName(attachment.name ?? attachment.fileName, extension),
      mediaPath: target,
      contentType,
      size: bytes.length,
      digest: `sha256:${digest}`,
    })
  }

  return persisted
}

export function appendPersistedChatImages(
  message: string,
  images: Array<PersistedChatImage>,
): string {
  if (images.length === 0) return message
  const references = images.map(
    (image) => `![${image.name}](MEDIA:${image.mediaPath})`,
  )
  return `${message}${message.trim() ? '\n\n' : ''}${references.join('\n')}`
}

/**
 * Convert the safe transcript projection back into native UI attachments.
 * The marker lines are removed from text so optimistic and reloaded messages
 * retain the same text identity and do not render as duplicates.
 */
export function projectPersistedChatImages(
  content: string,
  options: { rootDir?: string } = {},
): {
  text: string
  attachments: Array<ProjectedChatAttachment>
} {
  const attachments: Array<ProjectedChatAttachment> = []
  const rootDir = resolve(
    options.rootDir ?? resolve(getStateDir(), 'artifacts', 'chat-uploads'),
  )
  const marker = /^\s*!\[([^\]\r\n]{1,160})\]\(MEDIA:([^\r\n)]+)\)\s*$/gm
  const text = content.replace(
    marker,
    (match, name: string, mediaPath: string) => {
      const resolvedMediaPath = resolve(mediaPath)
      const extension = extname(resolvedMediaPath).toLowerCase()
      const digest = basename(resolvedMediaPath, extension)
      if (
        !isWithinDirectory(rootDir, resolvedMediaPath) ||
        !MIME_BY_EXTENSION[extension] ||
        !/^[a-f0-9]{64}$/.test(digest)
      ) {
        return match
      }

      let size: number | undefined
      try {
        const stat = statSync(resolvedMediaPath)
        if (stat.isFile()) size = stat.size
      } catch {
        size = undefined
      }

      attachments.push({
        id: `persisted-${digest}`,
        name,
        contentType: MIME_BY_EXTENSION[extension],
        size,
        url: `/api/media?path=${encodeURIComponent(mediaPath)}`,
      })
      return ''
    },
  )

  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    attachments,
  }
}
