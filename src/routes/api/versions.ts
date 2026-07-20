import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import type { VersionEntry } from '@/versions'
import { VERSIONS } from '@/versions'
import {
  currentVersion,
  mergeVersionOverlay,
  upsertVersionNote,
} from '@/lib/version-info'

/**
 * Release timeline for the in-app "What's new" dialog.
 *
 * Baked entries (src/versions.ts, version/date skeleton) merged with the
 * per-slot overlay `<HERMES_HOME>/version-notes.json`, which carries the
 * operator-written patch notes.
 *
 * Mode (OpenClaw parity): the image is built as either `owner` or `customer`
 * (HERMES_VERSIONS_MODE, baked by Dockerfile.runtime). Owner-mode images —
 * deployed to the operator's dev slot only — expose note EDITING: the dialog
 * shows a textarea per version and saves through POST here, straight into
 * the overlay (live, no rebuild). Customer images are read-only; POST
 * answers 403 even if called directly.
 */
function versionsMode(): 'owner' | 'customer' {
  return process.env.HERMES_VERSIONS_MODE === 'owner' ? 'owner' : 'customer'
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

export const Route = createFileRoute('/api/versions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const versions = mergeVersionOverlay(VERSIONS, await readOverlay())
        return json({
          ok: true,
          mode: versionsMode(),
          current: currentVersion(versions),
          build: (process.env.HERMES_BUILD_SHA || '').slice(0, 8),
          versions,
        })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        if (versionsMode() !== 'owner') {
          // Read-only on customer images — editing exists only on the
          // operator's owner-mode build.
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
            next = upsertVersionNote(existing, version, notes, date)
          } catch (err) {
            return json(
              { ok: false, error: err instanceof Error ? err.message : String(err) },
              { status: 400 },
            )
          }
          await writeOverlay(next)
          const versions = mergeVersionOverlay(VERSIONS, next)
          return json({ ok: true, versions })
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
