/**
 * Release timeline baked into the runtime image — the single source the
 * in-app "What's new" dialog renders. Newest entry first; its `version` is
 * displayed as the app's current version.
 *
 * Version names follow CalVer `YYYY.M.D` (same-day follow-ups append `-N`).
 * This is a DISPLAY name only — package.json versioning and image tags are
 * deliberately untouched.
 *
 * Release flow: the PR that ships a customer-visible change adds (or extends)
 * an entry here. Notes are read by customers — plain Korean, what changed for
 * THEM, no internal jargon, PR numbers, or operational detail.
 *
 * Per-slot corrections without a rebuild: `<HERMES_HOME>/version-notes.json`
 * overlays entries by version (see src/lib/version-info.ts).
 */
export type VersionEntry = {
  /** CalVer display name, e.g. "2026.7.17" or "2026.7.17-1". */
  version: string
  /** ISO date the release was cut. */
  date: string
  /** Customer-facing notes, one bullet per line. */
  notes: Array<string>
}

export const VERSIONS: Array<VersionEntry> = [
  {
    version: '2026.7.17',
    date: '2026-07-17',
    notes: [
      '사이드바에서 세션을 폴더로 정리할 수 있습니다 — 드래그로 이동, 하위 폴더와 이름 변경 지원',
      '새 대화의 제목이 자동으로 지어집니다',
    ],
  },
  {
    version: '2026.7.14',
    date: '2026-07-14',
    notes: ['대화 중 생성된 이미지가 안정적으로 표시됩니다'],
  },
]
