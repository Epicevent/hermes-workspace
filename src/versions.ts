/**
 * Shape of one release entry shown in the in-app "What's new" dialog.
 *
 * There is deliberately NO hand-written list here. Following the OpenClaw
 * model, a version identifies an IMAGE BUILD: CI computes a CalVer name
 * (`YYYY.M.D`, `-2`/`-3` for later builds the same day) and bakes it into
 * the image as HERMES_VERSION, so two different images can never report the
 * same version. See src/routes/api/versions.ts.
 *
 * Which builds customers SEE is curated by the operator: a build appears in
 * the customer dialog once he writes a note for it (the version-notes
 * overlay) — the same role OpenClaw's CUSTOMER_RELEASE flag plays. Builds
 * without notes stay visible only on the owner image.
 */
export type VersionEntry = {
  /** CalVer display name of the image build, e.g. "2026.7.21" or "2026.7.21-2". */
  version: string
  /** ISO date the image was built. */
  date: string
  /** Customer-facing notes — operator-authored via the overlay. */
  notes: Array<string>
}
