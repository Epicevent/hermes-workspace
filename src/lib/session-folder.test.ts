import { describe, expect, it } from 'vitest'
import {
  buildSessionFolderTree,
  countFolderSessions,
  parseSessionFolderPath,
  prunePendingFolders,
  rewriteFolderPath,
  sessionsUnderFolder,
} from './session-folder'
import type { SessionMeta } from '@/screens/chat/types'

function session(key: string, folderPath?: string, updatedAt = 0): SessionMeta {
  return { key, friendlyId: key, folderPath, updatedAt }
}

describe('parseSessionFolderPath', () => {
  it('canonicalizes trimmed segments joined by slashes', () => {
    expect(parseSessionFolderPath(' 전구체 / 액상 ')).toEqual({
      ok: true,
      folderPath: '전구체/액상',
    })
    expect(parseSessionFolderPath('/a//b/')).toEqual({ ok: true, folderPath: 'a/b' })
  })

  it('NFC-normalizes', () => {
    const nfd = '전구체'.normalize('NFD')
    expect(nfd).not.toBe('전구체')
    expect(parseSessionFolderPath(nfd)).toEqual({ ok: true, folderPath: '전구체' })
  })

  it('allows spaces inside names', () => {
    expect(parseSessionFolderPath('연구 자료/고체 전구체')).toEqual({
      ok: true,
      folderPath: '연구 자료/고체 전구체',
    })
  })

  it('rejects non-strings and empties', () => {
    expect(parseSessionFolderPath(42).ok).toBe(false)
    expect(parseSessionFolderPath('').ok).toBe(false)
    expect(parseSessionFolderPath('   /  ').ok).toBe(false)
  })

  it('rejects control characters', () => {
    expect(parseSessionFolderPath('a\tb').ok).toBe(false)
  })

  it('rejects dot segments', () => {
    expect(parseSessionFolderPath('a/../b').ok).toBe(false)
    expect(parseSessionFolderPath('./a').ok).toBe(false)
  })

  it('rejects more than 4 levels', () => {
    expect(parseSessionFolderPath('a/b/c/d').ok).toBe(true)
    expect(parseSessionFolderPath('a/b/c/d/e').ok).toBe(false)
  })

  it('rejects segments over 60 chars and totals over 200', () => {
    expect(parseSessionFolderPath('x'.repeat(60)).ok).toBe(true)
    expect(parseSessionFolderPath('x'.repeat(61)).ok).toBe(false)
    expect(parseSessionFolderPath(['y'.repeat(60), 'y'.repeat(60), 'y'.repeat(60), 'y'.repeat(60)].join('/')).ok).toBe(false)
  })
})

describe('buildSessionFolderTree', () => {
  it('derives nested folders from paths and roots unfoldered sessions', () => {
    const tree = buildSessionFolderTree([
      session('s1', '전구체/액상', 10),
      session('s2', '전구체', 20),
      session('s3', undefined, 30),
    ])
    expect(tree.sessions.map((s) => s.key)).toEqual(['s3'])
    expect(tree.children).toHaveLength(1)
    const top = tree.children[0]
    expect(top.path).toBe('전구체')
    expect(top.sessions.map((s) => s.key)).toEqual(['s2'])
    expect(top.children[0].path).toBe('전구체/액상')
    expect(top.children[0].name).toBe('액상')
    expect(top.children[0].sessions.map((s) => s.key)).toEqual(['s1'])
  })

  it('seeds pending paths as empty folders', () => {
    const tree = buildSessionFolderTree([], ['새 폴더/하위'])
    expect(tree.children[0].path).toBe('새 폴더')
    expect(tree.children[0].sessions).toHaveLength(0)
    expect(tree.children[0].children[0].path).toBe('새 폴더/하위')
  })

  it('sorts folders by name and sessions by updatedAt desc', () => {
    const tree = buildSessionFolderTree([
      session('old', 'b', 1),
      session('new', 'b', 2),
      session('x', 'a', 1),
    ])
    expect(tree.children.map((c) => c.name)).toEqual(['a', 'b'])
    expect(tree.children[1].sessions.map((s) => s.key)).toEqual(['new', 'old'])
  })

  it('counts sessions recursively', () => {
    const tree = buildSessionFolderTree([
      session('s1', 'a'),
      session('s2', 'a/b'),
      session('s3', 'a/b/c'),
    ])
    expect(countFolderSessions(tree.children[0])).toBe(3)
  })
})

describe('prunePendingFolders', () => {
  it('drops a pending path once a session sits at or under it', () => {
    const pending = ['a', 'b', 'c']
    const next = prunePendingFolders(pending, [
      session('s1', 'a'),
      session('s2', 'b/deep'),
    ])
    expect(next).toEqual(['c'])
  })

  it('keeps unrelated prefixes distinct', () => {
    // "ab" must NOT prune pending "a"
    expect(prunePendingFolders(['a'], [session('s1', 'ab')])).toEqual(['a'])
  })
})

describe('folder rename helpers', () => {
  it('selects sessions at or under a folder', () => {
    const all = [session('s1', 'a'), session('s2', 'a/b'), session('s3', 'ab')]
    expect(sessionsUnderFolder(all, 'a').map((s) => s.key)).toEqual(['s1', 's2'])
  })

  it('rewrites prefixes preserving subtrees', () => {
    expect(rewriteFolderPath('a', 'a', 'z')).toBe('z')
    expect(rewriteFolderPath('a/b/c', 'a', 'z')).toBe('z/b/c')
  })
})
