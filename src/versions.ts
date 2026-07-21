/**
 * Shape of one release entry shown in the in-app "What's new" dialog.
 *
 * There is deliberately NO hand-written list here. Following the OpenClaw
 * model, a version identifies an IMAGE BUILD: CI computes a CalVer name
 * (`YYYY.M.D`, `-2`/`-3` for later builds the same day) and bakes it into
 * the image as HERMES_VERSION, so two different images can never report the
 * same version. See src/routes/api/versions.ts.
 *
 * Which builds customers SEE is curated EXPLICITLY by the operator, the same
 * way OpenClaw does it (its build history carries `customerRelease`): a build
 * reaches the customer dialog only when it is marked as a customer release.
 * Writing a note is not the same act as publishing it — an unmarked build,
 * notes or not, stays visible on the owner image only.
 */
export type VersionEntry = {
  /** CalVer display name of the image build, e.g. "2026.7.21" or "2026.7.21-2". */
  version: string
  /** ISO date the image was built. */
  date: string
  /** Customer-facing notes — operator-authored via the overlay. */
  notes: Array<string>
  /** Explicitly published to customers (OpenClaw's `customerRelease`). */
  customerRelease?: boolean
}
