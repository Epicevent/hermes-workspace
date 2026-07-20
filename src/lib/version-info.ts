import type { VersionEntry } from '@/versions'

/**
 * Merge the baked release timeline with an optional per-slot overlay
 * (`<HERMES_HOME>/version-notes.json`). The overlay lets an operator fix or
 * add a note on a live slot without rebuilding the image (the OpenClaw
 * version-notes pattern). Overlay shape = same as the baked list.
 *
 * Rules: an overlay entry with a version already in the baked list replaces
 * that entry's notes/date; an unknown version is inserted. Order: baked order
 * kept, inserted overlay entries first (assumed newer). Malformed overlay
 * entries are skipped — a bad overlay file must never break the dialog.
 */
export function mergeVersionOverlay(
  baked: Array<VersionEntry>,
  overlay: unknown,
): Array<VersionEntry> {
  if (!Array.isArray(overlay)) return baked
  const valid = overlay.filter(
    (entry): entry is VersionEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as VersionEntry).version === 'string' &&
      (entry as VersionEntry).version.length > 0 &&
      Array.isArray((entry as VersionEntry).notes) &&
      (entry as VersionEntry).notes.every((n) => typeof n === 'string'),
  )
  if (valid.length === 0) return baked
  const byVersion = new Map(valid.map((entry) => [entry.version, entry]))
  const merged = baked.map((entry) => {
    const override = byVersion.get(entry.version)
    if (!override) return entry
    byVersion.delete(entry.version)
    return {
      version: entry.version,
      date: typeof override.date === 'string' && override.date ? override.date : entry.date,
      notes: override.notes,
    }
  })
  return [...byVersion.values(), ...merged]
}

/** The displayed current version = newest entry's CalVer name. */
export function currentVersion(entries: Array<VersionEntry>): string {
  return entries[0]?.version ?? ''
}
