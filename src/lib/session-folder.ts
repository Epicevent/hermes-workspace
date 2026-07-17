import type { SessionMeta } from '@/screens/chat/types'

export const SESSION_FOLDER_MAX_DEPTH = 4
export const SESSION_FOLDER_SEGMENT_MAX_LENGTH = 60
export const SESSION_FOLDER_MAX_LENGTH = 200

/** MIME type used to gate sidebar drag-and-drop to session rows only. */
export const SESSION_DRAG_MIME = 'text/x-hermes-session-key'

export type ParsedSessionFolderPath =
  | { ok: true; folderPath: string }
  | { ok: false; error: string }

function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Parse a user-supplied session folder path ("전구체/액상") into its canonical
 * stored form: NFC-normalized, "/"-joined trimmed segments. The rules MUST
 * stay in lockstep with the gateway-side validator
 * (hermes-jitech SessionDB.sanitize_folder_path) — the gateway is the
 * enforcement point; this port exists for instant UI feedback and for
 * deriving trees from already-canonical stored paths.
 */
export function parseSessionFolderPath(raw: unknown): ParsedSessionFolderPath {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Folder name must be text' }
  }
  const normalized = raw.normalize('NFC')
  if (hasControlChars(normalized)) {
    return { ok: false, error: 'Folder name has invalid characters' }
  }
  const segments = normalized
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return { ok: false, error: 'Folder name is empty' }
  }
  if (segments.length > SESSION_FOLDER_MAX_DEPTH) {
    return {
      ok: false,
      error: `Folders can nest at most ${SESSION_FOLDER_MAX_DEPTH} levels`,
    }
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, error: "Folder name can't be '.' or '..'" }
    }
    if (segment.length > SESSION_FOLDER_SEGMENT_MAX_LENGTH) {
      return {
        ok: false,
        error: `Folder name too long (max ${SESSION_FOLDER_SEGMENT_MAX_LENGTH} characters)`,
      }
    }
  }
  const folderPath = segments.join('/')
  if (folderPath.length > SESSION_FOLDER_MAX_LENGTH) {
    return {
      ok: false,
      error: `Folder path too long (max ${SESSION_FOLDER_MAX_LENGTH} characters)`,
    }
  }
  return { ok: true, folderPath }
}

export type SessionFolderNode = {
  /** Full canonical path of this folder ("전구체/액상"). */
  path: string
  /** Last path segment, shown as the folder's name. */
  name: string
  children: Array<SessionFolderNode>
  sessions: Array<SessionMeta>
}

/**
 * Build a folder tree from flat sessions. Pure derivation: folders exist
 * because sessions reference them — plus `pending` paths the user created in
 * the UI that no session references yet. Sessions without a folderPath land
 * on the returned root node's `sessions`.
 */
export function buildSessionFolderTree(
  sessions: Array<SessionMeta>,
  pending: Array<string> = [],
): SessionFolderNode {
  const root: SessionFolderNode = { path: '', name: '', children: [], sessions: [] }
  const byPath = new Map<string, SessionFolderNode>()

  function nodeFor(path: string): SessionFolderNode {
    const existing = byPath.get(path)
    if (existing) return existing
    let parent = root
    let current = ''
    for (const segment of path.split('/')) {
      current = current ? `${current}/${segment}` : segment
      let node = byPath.get(current)
      if (!node) {
        node = { path: current, name: segment, children: [], sessions: [] }
        byPath.set(current, node)
        parent.children.push(node)
      }
      parent = node
    }
    return parent
  }

  for (const path of pending) {
    if (path) nodeFor(path)
  }
  for (const session of sessions) {
    const folderPath = session.folderPath
    if (typeof folderPath === 'string' && folderPath.length > 0) {
      nodeFor(folderPath).sessions.push(session)
    } else {
      root.sessions.push(session)
    }
  }

  function sortNode(node: SessionFolderNode): void {
    node.children.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    node.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    node.children.forEach(sortNode)
  }
  sortNode(root)
  return root
}

/** Recursive session count for a folder's badge. */
export function countFolderSessions(node: SessionFolderNode): number {
  return node.children.reduce(
    (sum, child) => sum + countFolderSessions(child),
    node.sessions.length,
  )
}

/**
 * Drop pending (UI-created, still-empty) folder paths once a real session
 * sits at that path or anywhere under it — from then on the folder is backed
 * by server state and no longer needs the client-side placeholder.
 */
export function prunePendingFolders(
  pending: Array<string>,
  sessions: Array<SessionMeta>,
): Array<string> {
  if (pending.length === 0) return pending
  const paths = sessions
    .map((session) => session.folderPath)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  return pending.filter(
    (candidate) =>
      !paths.some(
        (path) => path === candidate || path.startsWith(`${candidate}/`),
      ),
  )
}

/** All sessions filed at `folderPath` or in any folder under it. */
export function sessionsUnderFolder(
  sessions: Array<SessionMeta>,
  folderPath: string,
): Array<SessionMeta> {
  return sessions.filter(
    (session) =>
      session.folderPath === folderPath ||
      (typeof session.folderPath === 'string' &&
        session.folderPath.startsWith(`${folderPath}/`)),
  )
}

/**
 * Rewrite a session's folderPath for a folder rename/move from `fromPath` to
 * `toPath` (prefix rewrite, preserving the subtree below).
 */
export function rewriteFolderPath(
  sessionFolderPath: string,
  fromPath: string,
  toPath: string,
): string {
  if (sessionFolderPath === fromPath) return toPath
  return `${toPath}${sessionFolderPath.slice(fromPath.length)}`
}
