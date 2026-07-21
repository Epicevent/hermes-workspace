import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import type { VersionEntry } from '@/versions'
import { mergeVersionOverlay, upsertVersionNote } from '@/lib/version-info'

/**
 * Release timeline for the in-app "What's new" dialog (OpenClaw model).
 *
 * A version identifies an IMAGE BUILD: CI bakes HERMES_VERSION (CalVer) and
 * HERMES_BUILD_SHA into each image, so two different images never report the
 * same version — that is what makes the dialog usable for "what is this slot
 * actually running".
 *
 * The list is assembled from:
 *   - the operator's notes overlay (<HERMES_HOME>/version-notes.json);
 *   - plus THIS build, always shown on the owner image so he can write the
 *     note for the build he is looking at.
 *
 * Customers see only entries explicitly marked `customerRelease` — the same
 * curation OpenClaw does with its CUSTOMER_RELEASE flag. Writing a note and
 * publishing it are separate acts.
 */
function versionsMode(): 'owner' | 'customer' {
  return process.env.HERMES_VERSIONS_MODE === 'owner' ? 'owner' : 'customer'
}

function buildVersion(): string {
  return (process.env.HERMES_VERSION || '').trim()
}

function buildDate(): string {
  // Baked at build time; fall back to today so a locally-run dev server still
  // renders something sane.
  const stamped = (process.env.HERMES_BUILD_DATE || '').trim()
  if (stamped) return stamped
  return new Date().toISOString().slice(0, 10)
}

function overlayPath(): string | null {
  const home = process.env.HERMES_HOME || process.env.HOME
  return home ? join(home, 'version-notes.json') : null
}

async function readOverlay(): Promise<unknown> {
  const path = overlayPath()
  if (!path) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function writeOverlay(entries: Array<VersionEntry>): Promise<void> {
  const path = overlayPath()
  if (!path) throw new Error('no HERMES_HOME to write to')
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {})
  const tmp = `${path}.tmp.${process.pid}`
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/**
 * Notes (curated releases) + this build. On the owner image the running build
 * is always present even with no note yet, so it can be annotated in place.
 */
function assembleVersions(overlay: unknown, owner: boolean): Array<VersionEntry> {
  const version = buildVersion()
  const seed: Array<VersionEntry> =
    owner && version ? [{ version, date: buildDate(), notes: [] }] : []
  const merged = mergeVersionOverlay(seed, overlay)
  // Owner sees every build (that is how he picks what to publish);
  // customers see only what he published.
  return owner ? merged : merged.filter((entry) => entry.customerRelease === true)
}

export const Route = createFileRoute('/api/versions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const owner = versionsMode() === 'owner'
        const versions = assembleVersions(await readOverlay(), owner)
        return json({
          ok: true,
          mode: versionsMode(),
          // The running image's own version — not "newest note".
          current: buildVersion(),
          build: (process.env.HERMES_BUILD_SHA || '').slice(0, 8),
          versions,
        })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        if (versionsMode() !== 'owner') {
          return json({ ok: false, error: 'Read-only' }, { status: 403 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        try {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >
          const version =
            typeof body.version === 'string' ? body.version.trim() : ''
          const date = typeof body.date === 'string' ? body.date.trim() : ''
          const notes = Array.isArray(body.notes)
            ? body.notes.filter((n): n is string => typeof n === 'string')
            : []
          const customerRelease =
            typeof body.customerRelease === 'boolean'
              ? body.customerRelease
              : undefined
          if (!version) {
            return json({ ok: false, error: 'version required' }, { status: 400 })
          }
          const existingRaw = await readOverlay()
          const existing = Array.isArray(existingRaw)
            ? existingRaw.filter(
                (e): e is VersionEntry =>
                  typeof e === 'object' &&
                  e !== null &&
                  typeof (e as VersionEntry).version === 'string' &&
                  Array.isArray((e as VersionEntry).notes),
              )
            : []
          let next: Array<VersionEntry>
          try {
            next = upsertVersionNote(existing, version, notes, date || buildDate(), customerRelease)
          } catch (err) {
            return json(
              { ok: false, error: err instanceof Error ? err.message : String(err) },
              { status: 400 },
            )
          }
          await writeOverlay(next)
          return json({ ok: true, versions: assembleVersions(next, true) })
        } catch (err) {
          return json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },
  },
})
