import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { getStateDir } from './workspace-state-dir'

const explicitRuntimeDir = process.env.HERMES_WORKSPACE_RUNTIME_DIR?.trim()
const DATA_DIR = resolve(explicitRuntimeDir || join(getStateDir(), 'runtime'))
const SESSIONS_FILE = join(DATA_DIR, 'local-sessions.json')
const MAX_MESSAGES_PER_SESSION = 500

export type LocalSession = {
  id: string
  title: string | null
  model: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  folderPath: string | null
}

export type LocalMessage = {
  id: string
  role: string
  content: string
  timestamp: number
  toolCalls?: unknown
  toolCallId?: string
  toolName?: string
}

type StoreData = {
  sessions: Record<string, LocalSession | undefined>
  messages: Record<string, Array<LocalMessage> | undefined>
}

function emptyStore(): StoreData {
  return { sessions: {}, messages: {} }
}

let store: StoreData = emptyStore()

function refreshFromDisk(): void {
  try {
    if (!existsSync(SESSIONS_FILE)) {
      if (!existsSync(DATA_DIR) || statSync(DATA_DIR).isDirectory()) {
        store = emptyStore()
      }
      return
    }

    const raw = readFileSync(SESSIONS_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoreData>
    if (parsed.sessions && parsed.messages) {
      for (const session of Object.values(parsed.sessions)) {
        if (!session) continue
        if (typeof session.folderPath !== 'string') {
          session.folderPath = null
        }
      }
      store = parsed as StoreData
    }
  } catch {
    // Keep the last-known-good in-memory projection when the cache cannot be
    // read. Metadata writes still fail closed in saveToDisk below.
  }
}

function saveToDisk(options: { throwOnError?: boolean } = {}): void {
  let temporaryFile: string | null = null
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    temporaryFile = `${SESSIONS_FILE}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporaryFile, JSON.stringify(store, null, 2))
    renameSync(temporaryFile, SESSIONS_FILE)
    temporaryFile = null
  } catch (error) {
    if (temporaryFile && existsSync(temporaryFile)) {
      try {
        unlinkSync(temporaryFile)
      } catch {
        // Best-effort cleanup only; preserve the original write error.
      }
    }
    if (options.throwOnError) throw error
    // ignore cache write failures
  }
}

refreshFromDisk()

export function listLocalSessions(): Array<LocalSession> {
  refreshFromDisk()
  return Object.values(store.sessions)
    .filter((session): session is LocalSession => session !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getLocalSession(sessionId: string): LocalSession | null {
  refreshFromDisk()
  return store.sessions[sessionId] ?? null
}

export function ensureLocalSession(
  sessionId: string,
  model?: string,
): LocalSession {
  refreshFromDisk()
  if (!store.sessions[sessionId]) {
    store.sessions[sessionId] = {
      id: sessionId,
      title: null,
      model: model ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      folderPath: null,
    }
    store.messages[sessionId] = []
    saveToDisk()
  }
  return store.sessions[sessionId]
}

export function updateLocalSessionTitle(
  sessionId: string,
  title: string,
): void {
  updateLocalSession(sessionId, { title })
}

export function updateLocalSession(
  sessionId: string,
  updates: { title?: string; folderPath?: string | null },
): LocalSession | null {
  refreshFromDisk()
  const session = store.sessions[sessionId]
  if (!session) return null

  const previous = {
    title: session.title,
    folderPath: session.folderPath,
    updatedAt: session.updatedAt,
  }
  if (updates.title !== undefined) session.title = updates.title
  if (updates.folderPath !== undefined) {
    session.folderPath = updates.folderPath
  }
  session.updatedAt = Date.now()
  try {
    saveToDisk({ throwOnError: true })
  } catch (error) {
    session.title = previous.title
    session.folderPath = previous.folderPath
    session.updatedAt = previous.updatedAt
    throw error
  }
  return session
}

export function touchLocalSession(sessionId: string): void {
  refreshFromDisk()
  const session = store.sessions[sessionId]
  if (session) {
    session.updatedAt = Date.now()
    saveToDisk()
  }
}

export function deleteLocalSession(sessionId: string): void {
  refreshFromDisk()
  delete store.sessions[sessionId]
  delete store.messages[sessionId]
  saveToDisk()
}

export function getLocalMessages(sessionId: string): Array<LocalMessage> {
  refreshFromDisk()
  return store.messages[sessionId] ?? []
}

export function searchLocalSessions(
  query: string,
  limit = 20,
): Array<LocalSession & { snippet: string }> {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []

  const results: Array<LocalSession & { snippet: string }> = []
  const sessions = listLocalSessions()

  for (const session of sessions) {
    const title = session.title || ''
    const messages = store.messages[session.id] ?? []
    const matchingMessage = messages.find((message) =>
      message.content.toLowerCase().includes(normalized),
    )
    if (!title.toLowerCase().includes(normalized) && !matchingMessage) {
      continue
    }

    const content = matchingMessage?.content || title || session.id
    const lowerContent = content.toLowerCase()
    const matchIndex = lowerContent.indexOf(normalized)
    const start = matchIndex >= 0 ? Math.max(0, matchIndex - 80) : 0
    const snippet = content.slice(start, start + 220).trim()
    results.push({ ...session, snippet })
    if (results.length >= limit) break
  }

  return results
}

export function appendLocalMessage(
  sessionId: string,
  message: LocalMessage,
): void {
  refreshFromDisk()
  const session =
    store.sessions[sessionId] ??
    (store.sessions[sessionId] = {
      id: sessionId,
      title: null,
      model: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      folderPath: null,
    })
  const messages = store.messages[sessionId] ?? []
  store.messages[sessionId] = messages
  messages.push(message)
  if (messages.length > MAX_MESSAGES_PER_SESSION) {
    store.messages[sessionId] = messages.slice(-MAX_MESSAGES_PER_SESSION)
  }
  session.messageCount = store.messages[sessionId].length
  session.updatedAt = Date.now()
  saveToDisk()
}
