'use client'

import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowDown01Icon,
  Delete01Icon,
  Folder01Icon,
  FolderAddIcon,
  MoreHorizontalIcon,
  Pen01Icon,
} from '@hugeicons/core-free-icons'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SessionItem } from './session-item'
import { chatQueryKeys } from '../../chat-queries'
import { useMoveSessionToFolder } from '../../hooks/use-move-session-to-folder'
import type { SessionMeta } from '../../types'
import type { SessionFolderNode } from '@/lib/session-folder'
import {
  SESSION_DRAG_MIME,
  buildSessionFolderTree,
  countFolderSessions,
  parseSessionFolderPath,
  prunePendingFolders,
  rewriteFolderPath,
  sessionsUnderFolder,
} from '@/lib/session-folder'
import { useSessionFolders } from '@/hooks/use-session-folders'
import { cn } from '@/lib/utils'
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@/components/ui/menu'

type SessionFolderTreeProps = {
  sessions: Array<SessionMeta>
  activeFriendlyId: string
  onSelect?: () => void
  onTogglePin: (session: SessionMeta) => void
  onRename: (session: SessionMeta) => void
  onDelete: (session: SessionMeta) => void
}

type DragPayload = { key: string; friendlyId?: string }

function readDragPayload(event: React.DragEvent): DragPayload | null {
  const raw = event.dataTransfer.getData(SESSION_DRAG_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DragPayload
    return typeof parsed.key === 'string' && parsed.key ? parsed : null
  } catch {
    return null
  }
}

function hasSessionDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(SESSION_DRAG_MIME)
}

async function patchSessionFolder(
  sessionKey: string,
  friendlyId: string | undefined,
  folderPath: string | null,
): Promise<void> {
  const res = await fetch('/api/sessions', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionKey, friendlyId, folderPath }),
  })
  if (!res.ok) {
    throw new Error(await res.text().catch(() => 'Failed to update folder'))
  }
}

function FolderNameEditor({
  initialValue,
  placeholder,
  onCommit,
  onCancel,
}: {
  initialValue: string
  placeholder: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <input
      ref={inputRef}
      defaultValue={initialValue}
      placeholder={placeholder}
      className={cn(
        'w-full rounded-md border border-primary-300 bg-primary-50 px-1.5 py-0.5',
        'text-sm text-primary-950 outline-none focus:border-primary-500',
      )}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit(event.currentTarget.value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
    />
  )
}

export function SessionFolderTree({
  sessions,
  activeFriendlyId,
  onSelect,
  onTogglePin,
  onRename,
  onDelete,
}: SessionFolderTreeProps) {
  const queryClient = useQueryClient()
  const {
    collapsedFolders,
    pendingFolders,
    toggleFolderCollapsed,
    addPendingFolder,
    setPendingFolders,
    renameFolderPaths,
    forgetFolder,
  } = useSessionFolders()
  const { moveSessionToFolder } = useMoveSessionToFolder()

  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  // '' = creating at root, otherwise the parent folder's path; null = idle.
  const [createParent, setCreateParent] = useState<string | null>(null)
  const [editPath, setEditPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)

  // Drop client-side placeholders once real sessions back the folder.
  useEffect(() => {
    const pruned = prunePendingFolders(pendingFolders, sessions)
    if (pruned.length !== pendingFolders.length) setPendingFolders(pruned)
  }, [pendingFolders, sessions, setPendingFolders])

  const tree = buildSessionFolderTree(sessions, pendingFolders)
  const hasFolders = tree.children.length > 0

  function dropHandlers(folderPath: string | null) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!hasSessionDrag(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDragOverPath(folderPath ?? '')
      },
      onDragLeave: () => setDragOverPath(null),
      onDrop: (event: React.DragEvent) => {
        if (!hasSessionDrag(event)) return
        event.preventDefault()
        setDragOverPath(null)
        const payload = readDragPayload(event)
        if (!payload) return
        const current = sessions.find((s) => s.key === payload.key)
        if (current && (current.folderPath ?? null) === folderPath) return
        void moveSessionToFolder(
          payload.key,
          payload.friendlyId ?? null,
          folderPath,
        )
      },
    }
  }

  function commitCreate(parent: string, value: string) {
    setCreateParent(null)
    const trimmed = value.trim()
    if (!trimmed) return
    const candidate = parent ? `${parent}/${trimmed}` : trimmed
    const parsed = parseSessionFolderPath(candidate)
    if (!parsed.ok) {
      setFolderError(parsed.error)
      return
    }
    setFolderError(null)
    addPendingFolder(parsed.folderPath)
  }

  async function commitRename(node: SessionFolderNode, value: string) {
    setEditPath(null)
    const trimmed = value.trim()
    if (!trimmed || trimmed === node.name || busy) return
    const parentPath = node.path.includes('/')
      ? node.path.slice(0, node.path.lastIndexOf('/'))
      : ''
    const candidate = parentPath ? `${parentPath}/${trimmed}` : trimmed
    const parsed = parseSessionFolderPath(candidate)
    if (!parsed.ok) {
      setFolderError(parsed.error)
      return
    }
    setFolderError(null)
    setBusy(true)
    try {
      // No folder entity server-side: rename = prefix-rewrite every session
      // filed at or under this path, then rewrite local collapse/pending.
      for (const session of sessionsUnderFolder(sessions, node.path)) {
        await patchSessionFolder(
          session.key,
          session.friendlyId,
          rewriteFolderPath(session.folderPath as string, node.path, parsed.folderPath),
        )
      }
      renameFolderPaths(node.path, parsed.folderPath)
      await queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions })
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function deleteFolder(node: SessionFolderNode) {
    if (busy) return
    const ok = window.confirm(
      'Delete this folder? Sessions inside move back to the top level.',
    )
    if (!ok) return
    setFolderError(null)
    setBusy(true)
    try {
      for (const session of sessionsUnderFolder(sessions, node.path)) {
        await patchSessionFolder(session.key, session.friendlyId, null)
      }
      forgetFolder(node.path)
      await queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions })
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function renderFolder(node: SessionFolderNode, depth: number) {
    const collapsed = collapsedFolders[node.path] ?? false
    const count = countFolderSessions(node)
    const isDropTarget = dragOverPath === node.path
    return (
      <div key={node.path}>
        <div
          className={cn(
            'group flex h-8 items-center rounded-lg pr-0.5 transition-colors',
            isDropTarget
              ? 'bg-primary-300/70'
              : 'hover:bg-primary-200',
          )}
          style={{ paddingLeft: `${6 + depth * 12}px` }}
          {...dropHandlers(node.path)}
        >
          {editPath === node.path ? (
            <FolderNameEditor
              initialValue={node.name}
              placeholder="Folder name"
              onCommit={(value) => void commitRename(node, value)}
              onCancel={() => setEditPath(null)}
            />
          ) : (
            <>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                onClick={() => toggleFolderCollapsed(node.path)}
                aria-expanded={!collapsed}
              >
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={12}
                  strokeWidth={2}
                  className={cn(
                    'shrink-0 text-primary-500 transition-transform duration-150',
                    collapsed ? '-rotate-90' : 'rotate-0',
                  )}
                />
                <HugeiconsIcon
                  icon={Folder01Icon}
                  size={14}
                  strokeWidth={1.8}
                  className="shrink-0 text-primary-600"
                />
                <span className="truncate text-sm font-[500] text-primary-950">
                  {node.name}
                </span>
                <span className="shrink-0 text-[11px] text-primary-500">
                  {count}
                </span>
              </button>
              <MenuRoot>
                <MenuTrigger
                  type="button"
                  className={cn(
                    'ml-1 inline-flex size-6 items-center justify-center rounded-md text-primary-700',
                    'opacity-0 transition-opacity group-hover:opacity-100 hover:bg-primary-200 dark:hover:bg-primary-800',
                    'aria-expanded:opacity-100 aria-expanded:bg-primary-200',
                  )}
                  aria-label="Folder options"
                >
                  <HugeiconsIcon
                    icon={MoreHorizontalIcon}
                    size={16}
                    strokeWidth={1.5}
                  />
                </MenuTrigger>
                <MenuContent side="bottom" align="end">
                  <MenuItem
                    className="gap-2"
                    onClick={() => setCreateParent(node.path)}
                  >
                    <HugeiconsIcon
                      icon={FolderAddIcon}
                      size={20}
                      strokeWidth={1.5}
                    />{' '}
                    New subfolder
                  </MenuItem>
                  <MenuItem
                    className="gap-2"
                    onClick={() => setEditPath(node.path)}
                  >
                    <HugeiconsIcon icon={Pen01Icon} size={20} strokeWidth={1.5} />{' '}
                    Rename
                  </MenuItem>
                  <MenuItem
                    className="text-red-700 gap-2 hover:bg-red-50 dark:hover:bg-red-900/30/80 data-highlighted:bg-red-50/80"
                    onClick={() => void deleteFolder(node)}
                  >
                    <HugeiconsIcon
                      icon={Delete01Icon}
                      size={20}
                      strokeWidth={1.5}
                    />{' '}
                    Delete folder
                  </MenuItem>
                </MenuContent>
              </MenuRoot>
            </>
          )}
        </div>
        {!collapsed ? (
          <div>
            {node.children.map((child) => renderFolder(child, depth + 1))}
            {createParent === node.path ? (
              <div style={{ paddingLeft: `${6 + (depth + 1) * 12}px` }}>
                <FolderNameEditor
                  initialValue=""
                  placeholder="Folder name"
                  onCommit={(value) => commitCreate(node.path, value)}
                  onCancel={() => setCreateParent(null)}
                />
              </div>
            ) : null}
            {node.sessions.map((session) => (
              <div
                key={session.key}
                style={{ paddingLeft: `${10 + (depth + 1) * 12}px` }}
              >
                <SessionItem
                  session={session}
                  active={session.friendlyId === activeFriendlyId}
                  isPinned={false}
                  draggable
                  onSelect={onSelect}
                  onTogglePin={onTogglePin}
                  onRename={onRename}
                  onDelete={onDelete}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-px">
      {tree.children.map((node) => renderFolder(node, 0))}
      {createParent === '' ? (
        <div className="pl-1.5 pr-0.5 py-0.5">
          <FolderNameEditor
            initialValue=""
            placeholder="Folder name"
            onCommit={(value) => commitCreate('', value)}
            onCancel={() => setCreateParent(null)}
          />
        </div>
      ) : (
        <button
          type="button"
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-lg pl-1.5 text-left',
            'text-[12px] text-primary-500 hover:bg-primary-200 hover:text-primary-700',
          )}
          onClick={() => setCreateParent('')}
        >
          <HugeiconsIcon icon={FolderAddIcon} size={14} strokeWidth={1.8} />
          New folder
        </button>
      )}
      {folderError ? (
        <div className="px-2 py-1 text-[11px] text-red-600">{folderError}</div>
      ) : null}
      {hasFolders && tree.sessions.length > 0 ? (
        <div className="my-1 border-t border-primary-200/80" />
      ) : null}
      <div
        className={cn(
          'flex flex-col gap-px rounded-lg transition-colors',
          dragOverPath === '' ? 'bg-primary-300/40' : undefined,
        )}
        {...dropHandlers(null)}
      >
        {tree.sessions.map((session) => (
          <SessionItem
            key={session.key}
            session={session}
            active={session.friendlyId === activeFriendlyId}
            isPinned={false}
            draggable
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  )
}
