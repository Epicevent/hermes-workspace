/**
 * Release timeline baked into the runtime image — the skeleton the in-app
 * "What's new" dialog renders. Newest entry first; its `version` is displayed
 * as the app's current version.
 *
 * Version names follow CalVer `YYYY.M.D` (same-day follow-ups append `-N`).
 * This is a DISPLAY name only — package.json versioning and image tags are
 * deliberately untouched.
 *
 * IMPORTANT — who writes what:
 *   - This file carries version/date ONLY (automatic build facts). The PR
 *     that ships a release appends its skeleton entry here. Keep `notes`
 *     empty — dev-authored notes must not reach customers.
 *   - PATCH NOTES are authored by the OPERATOR: the per-slot overlay
 *     `<HERMES_HOME>/version-notes.json` (written with
 *     `opsctl runtime version-note`) supplies the customer-facing text and
 *     is merged over these entries live, no rebuild
 *     (see src/lib/version-info.ts).
 */
export type VersionEntry = {
  /** CalVer display name, e.g. "2026.7.17" or "2026.7.17-1". */
  version: string
  /** ISO date the release was cut. */
  date: string
  /** Customer-facing notes — operator-authored via the overlay; empty here. */
  notes: Array<string>
}

export const VERSIONS: Array<VersionEntry> = [
  { version: '2026.7.17', date: '2026-07-17', notes: [] },
  { version: '2026.7.14', date: '2026-07-14', notes: [] },
]
