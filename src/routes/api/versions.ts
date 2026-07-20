import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { VERSIONS } from '@/versions'
import { currentVersion, mergeVersionOverlay } from '@/lib/version-info'

/**
 * Release timeline for the in-app "What's new" dialog.
 *
 * Baked entries (src/versions.ts, part of the image) merged with an
 * optional per-slot overlay at `<HERMES_HOME>/version-notes.json` — an
 * operator can correct a note on a live slot without a rebuild. `build` is
 * the image's source sha (HERMES_BUILD_SHA, stamped by Dockerfile.runtime)
 * so support can tell exactly what a slot runs.
 */
async function readOverlay(): Promise<unknown> {
  const home = process.env.HERMES_HOME || process.env.HOME
  if (!home) return undefined
  try {
    const raw = await readFile(join(home, 'version-notes.json'), 'utf8')
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
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
          current: currentVersion(versions),
          build: (process.env.HERMES_BUILD_SHA || '').slice(0, 8),
          versions,
        })
      },
    },
  },
})
