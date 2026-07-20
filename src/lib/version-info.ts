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

export const VERSION_NOTE_MAX_NOTES = 10
export const VERSION_NOTE_MAX_NOTE_LENGTH = 300
const VERSION_RE = /^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(-[0-9]+)?$/
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/**
 * Upsert an operator-written note entry into the overlay list (newest-first,
 * replacing an existing entry for the same version). Same rules as the
 * opsctl `runtime version-note` writer — the two pens must stay in lockstep.
 * Throws on invalid input.
 */
export function upsertVersionNote(
  entries: Array<VersionEntry>,
  version: string,
  notes: Array<string>,
  date = '',
): Array<VersionEntry> {
  if (!VERSION_RE.test(version)) {
    throw new Error(`invalid version (CalVer YYYY.M.D[-N] expected): ${version}`)
  }
  if (date && !DATE_RE.test(date)) {
    throw new Error(`invalid date (YYYY-MM-DD expected): ${date}`)
  }
  const cleaned = notes.map((note) => note.trim()).filter((note) => note.length > 0)
  if (cleaned.length > VERSION_NOTE_MAX_NOTES) {
    throw new Error(`too many notes (max ${VERSION_NOTE_MAX_NOTES})`)
  }
  for (const note of cleaned) {
    if (note.length > VERSION_NOTE_MAX_NOTE_LENGTH) {
      throw new Error(`note too long (max ${VERSION_NOTE_MAX_NOTE_LENGTH} chars)`)
    }
  }
  const entry: VersionEntry = { version, date, notes: cleaned }
  const remaining = entries.filter((e) => e.version !== version)
  // An empty notes list clears the operator entry for that version.
  return cleaned.length === 0 ? remaining : [entry, ...remaining]
}
