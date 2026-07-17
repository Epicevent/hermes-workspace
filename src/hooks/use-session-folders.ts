import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type SessionFoldersState = {
  /** Collapsed folders keyed by full folder path. Folders default expanded. */
  collapsedFolders: Record<string, boolean>
  /** UI-created folders no session references yet (full paths). */
  pendingFolders: Array<string>
  toggleFolderCollapsed: (path: string) => void
  addPendingFolder: (path: string) => void
  removePendingFolder: (path: string) => void
  setPendingFolders: (paths: Array<string>) => void
  /** Rewrite collapse + pending state when a folder is renamed/moved. */
  renameFolderPaths: (fromPath: string, toPath: string) => void
  /** Drop collapse + pending state for a deleted folder subtree. */
  forgetFolder: (path: string) => void
}

function isAtOrUnder(candidate: string, path: string): boolean {
  return candidate === path || candidate.startsWith(`${path}/`)
}

function rewrite(candidate: string, fromPath: string, toPath: string): string {
  return candidate === fromPath
    ? toPath
    : `${toPath}${candidate.slice(fromPath.length)}`
}

export const useSessionFoldersStore = create<SessionFoldersState>()(
  persist(
    (set) => ({
      collapsedFolders: {},
      pendingFolders: [],
      toggleFolderCollapsed: (path) =>
        set((state) => ({
          collapsedFolders: {
            ...state.collapsedFolders,
            [path]: !state.collapsedFolders[path],
          },
        })),
      addPendingFolder: (path) =>
        set((state) => {
          if (state.pendingFolders.includes(path)) return state
          return { pendingFolders: [...state.pendingFolders, path] }
        }),
      removePendingFolder: (path) =>
        set((state) => ({
          pendingFolders: state.pendingFolders.filter((p) => p !== path),
        })),
      setPendingFolders: (paths) => set({ pendingFolders: paths }),
      renameFolderPaths: (fromPath, toPath) =>
        set((state) => {
          const collapsedFolders: Record<string, boolean> = {}
          for (const [path, collapsed] of Object.entries(
            state.collapsedFolders,
          )) {
            collapsedFolders[
              isAtOrUnder(path, fromPath)
                ? rewrite(path, fromPath, toPath)
                : path
            ] = collapsed
          }
          return {
            collapsedFolders,
            pendingFolders: state.pendingFolders.map((path) =>
              isAtOrUnder(path, fromPath)
                ? rewrite(path, fromPath, toPath)
                : path,
            ),
          }
        }),
      forgetFolder: (path) =>
        set((state) => ({
          collapsedFolders: Object.fromEntries(
            Object.entries(state.collapsedFolders).filter(
              ([candidate]) => !isAtOrUnder(candidate, path),
            ),
          ),
          pendingFolders: state.pendingFolders.filter(
            (candidate) => !isAtOrUnder(candidate, path),
          ),
        })),
    }),
    { name: 'session-folders' },
  ),
)

export function useSessionFolders() {
  const collapsedFolders = useSessionFoldersStore((s) => s.collapsedFolders)
  const pendingFolders = useSessionFoldersStore((s) => s.pendingFolders)
  const toggleFolderCollapsed = useSessionFoldersStore(
    (s) => s.toggleFolderCollapsed,
  )
  const addPendingFolder = useSessionFoldersStore((s) => s.addPendingFolder)
  const removePendingFolder = useSessionFoldersStore(
    (s) => s.removePendingFolder,
  )
  const setPendingFolders = useSessionFoldersStore((s) => s.setPendingFolders)
  const renameFolderPaths = useSessionFoldersStore((s) => s.renameFolderPaths)
  const forgetFolder = useSessionFoldersStore((s) => s.forgetFolder)
  return {
    collapsedFolders,
    pendingFolders,
    toggleFolderCollapsed,
    addPendingFolder,
    removePendingFolder,
    setPendingFolders,
    renameFolderPaths,
    forgetFolder,
  }
}
