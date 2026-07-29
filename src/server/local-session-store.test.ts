import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: Array<string> = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('local session metadata persistence', () => {
  it('defaults to the durable Hermes state volume instead of the image working directory', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-home-'))
    tempDirs.push(hermesHome)
    vi.stubEnv('HERMES_HOME', hermesHome)
    vi.stubEnv('HERMES_WORKSPACE_RUNTIME_DIR', '')
    vi.stubEnv('HERMES_WORKSPACE_STATE_DIR', '')

    const store = await import('./local-session-store')
    store.ensureLocalSession('durable-1', 'gemini-3.6-flash')
    store.updateLocalSession('durable-1', {
      folderPath: 'CODEX verification',
    })

    const sessionsFile = join(
      hermesHome,
      'workspace',
      'runtime',
      'local-sessions.json',
    )
    expect(existsSync(sessionsFile)).toBe(true)

    vi.resetModules()
    const reloadedStore = await import('./local-session-store')
    expect(reloadedStore.getLocalSession('durable-1')).toMatchObject({
      id: 'durable-1',
      model: 'gemini-3.6-flash',
      folderPath: 'CODEX verification',
    })
  })

  it('round-trips title and folderPath through disk reload', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'hermes-local-session-'))
    tempDirs.push(runtimeDir)
    vi.stubEnv('HERMES_WORKSPACE_RUNTIME_DIR', runtimeDir)

    const store = await import('./local-session-store')
    store.ensureLocalSession('local-1', 'gemini-3.6-flash')
    expect(
      store.updateLocalSession('local-1', {
        title: '검증 세션',
        folderPath: '검증/이미지',
      }),
    ).toMatchObject({
      id: 'local-1',
      title: '검증 세션',
      folderPath: '검증/이미지',
    })

    vi.resetModules()
    const reloadedStore = await import('./local-session-store')
    expect(reloadedStore.getLocalSession('local-1')).toMatchObject({
      id: 'local-1',
      title: '검증 세션',
      folderPath: '검증/이미지',
    })
  })

  it('refreshes stale module projections and preserves metadata across writers', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'hermes-local-session-'))
    tempDirs.push(runtimeDir)
    vi.stubEnv('HERMES_WORKSPACE_RUNTIME_DIR', runtimeDir)

    const listingModule = await import('./local-session-store')
    listingModule.ensureLocalSession('shared-1', 'gemini-3.6-flash')

    vi.resetModules()
    const patchModule = await import('./local-session-store')
    patchModule.updateLocalSession('shared-1', {
      folderPath: 'persisted/from-patch',
    })

    expect(listingModule.getLocalSession('shared-1')).toMatchObject({
      folderPath: 'persisted/from-patch',
    })

    listingModule.appendLocalMessage('shared-1', {
      id: 'message-1',
      role: 'assistant',
      content: 'stored response',
      timestamp: 123,
    })

    vi.resetModules()
    const reloadedStore = await import('./local-session-store')
    expect(reloadedStore.getLocalSession('shared-1')).toMatchObject({
      folderPath: 'persisted/from-patch',
      messageCount: 1,
    })
    expect(reloadedStore.getLocalMessages('shared-1')).toHaveLength(1)
  })

  it('persists clearing a local session folder as null', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'hermes-local-session-'))
    tempDirs.push(runtimeDir)
    vi.stubEnv('HERMES_WORKSPACE_RUNTIME_DIR', runtimeDir)

    const store = await import('./local-session-store')
    store.ensureLocalSession('local-2')
    store.updateLocalSession('local-2', { folderPath: 'before' })
    store.updateLocalSession('local-2', { folderPath: null })

    vi.resetModules()
    const reloadedStore = await import('./local-session-store')
    expect(reloadedStore.getLocalSession('local-2')?.folderPath).toBeNull()
  })

  it('fails closed and restores memory when metadata cannot be written', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'hermes-local-session-'))
    tempDirs.push(runtimeDir)
    vi.stubEnv('HERMES_WORKSPACE_RUNTIME_DIR', runtimeDir)

    const store = await import('./local-session-store')
    store.ensureLocalSession('local-3')

    rmSync(runtimeDir, { recursive: true, force: true })
    writeFileSync(runtimeDir, 'not-a-directory')

    expect(() =>
      store.updateLocalSession('local-3', { folderPath: 'must-not-stick' }),
    ).toThrow()
    expect(store.getLocalSession('local-3')?.folderPath).toBeNull()
  })
})
