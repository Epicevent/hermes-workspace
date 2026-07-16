import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { getMessages, getSession } from '../../server/claude-api'
import { generateSessionTitle } from '../../server/session-title'
import { requireLocalOrAuth } from '../../server/auth-middleware'

/**
 * AI session title suggestion. Mirrors the OpenClaw `sessions.suggestLabel`
 * gateway RPC: read the session's first user message + latest message, ask the
 * session's own model for a short title, and return the sanitized suggestion.
 * Suggestion-only — the caller applies it via the existing sessions label PATCH,
 * exactly as OpenClaw's controller does (suggestLabel -> patch).
 */
export const Route = createFileRoute('/api/session-title')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!requireLocalOrAuth(request)) {
          return json({ ok: false, error: 'unauthorized' }, { status: 401 })
        }

        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const sessionKey =
          typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
        if (!sessionKey) {
          return json({ ok: false, error: 'sessionKey required' }, { status: 400 })
        }

        try {
          const messages = await getMessages(sessionKey)
          const firstUserMessage =
            messages.find((message) => message.role === 'user')?.content ?? null
          const lastMessagePreview =
            messages.length > 0
              ? (messages[messages.length - 1]?.content ?? null)
              : null

          // Best-effort: title with the session's own model. Fall back to the
          // gateway default when the session record can't be read.
          let model: string | undefined
          try {
            const session = await getSession(sessionKey)
            model = session.model ?? undefined
          } catch {
            model = undefined
          }

          const suggestion = await generateSessionTitle({
            fields: { firstUserMessage, lastMessagePreview },
            model,
          })
          return json({ ok: true, sessionKey, suggestion })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : 'title generation failed',
            },
            { status: 502 },
          )
        }
      },
    },
  },
})
