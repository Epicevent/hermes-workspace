import { describe, expect, it } from 'vitest'
import { currentVersion, mergeVersionOverlay } from './version-info'
import type { VersionEntry } from '@/versions'

const baked: Array<VersionEntry> = [
  { version: '2026.7.17', date: '2026-07-17', notes: ['폴더 정리'] },
  { version: '2026.7.14', date: '2026-07-14', notes: ['이미지 표시'] },
]

describe('mergeVersionOverlay', () => {
  it('returns baked list when overlay is absent or not an array', () => {
    expect(mergeVersionOverlay(baked, undefined)).toEqual(baked)
    expect(mergeVersionOverlay(baked, { nope: true })).toEqual(baked)
    expect(mergeVersionOverlay(baked, null)).toEqual(baked)
  })

  it('replaces notes of a matching baked version', () => {
    const merged = mergeVersionOverlay(baked, [
      { version: '2026.7.17', date: '', notes: ['수정된 노트'] },
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual({
      version: '2026.7.17',
      date: '2026-07-17', // empty overlay date keeps the baked date
      notes: ['수정된 노트'],
    })
  })

  it('inserts unknown overlay versions ahead of baked entries', () => {
    const merged = mergeVersionOverlay(baked, [
      { version: '2026.7.18', date: '2026-07-18', notes: ['핫픽스 안내'] },
    ])
    expect(merged.map((e) => e.version)).toEqual([
      '2026.7.18',
      '2026.7.17',
      '2026.7.14',
    ])
  })

  it('skips malformed overlay entries without breaking', () => {
    const merged = mergeVersionOverlay(baked, [
      { version: '', date: 'x', notes: ['bad'] },
      { version: '2026.7.14', notes: [42] },
      'garbage',
    ])
    expect(merged).toEqual(baked)
  })
})

describe('currentVersion', () => {
  it('is the newest entry name, empty when no entries', () => {
    expect(currentVersion(baked)).toBe('2026.7.17')
    expect(currentVersion([])).toBe('')
  })
})
