import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
