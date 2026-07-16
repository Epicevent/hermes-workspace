// AI-suggested session titles. Ported from the OpenClaw product's
// sessions.suggestLabel path (src/sessions/session-title.ts): same prompt,
// context-building, and sanitizer. The gateway owns the model call — we ask
// it via the OpenAI-compatible /v1/chat/completions transport, using the
// session's own model, so the customer's configured provider generates the
// title. The UI never calls a model provider directly.

import { CLAUDE_API } from './gateway-capabilities'
import { buildRequestBody, getBearerToken } from './openai-compat-api'

export const SESSION_TITLE_SYSTEM_PROMPT =
  'You name chat sessions. Given a conversation, reply with a short, specific title ' +
  '(at most 6 words) that captures its topic, written in the same language as the ' +
  'conversation. Reply with ONLY the title — no quotes, no surrounding punctuation, no preamble.'

// Headroom, not a target: it caps the completion. Non-thinking models emit the
// short title and stop early; thinking models (e.g. gemini-2.5-flash) spend
// tokens on reasoning first, so a small cap leaves no room for the visible
// title and yields an empty suggestion. 512 covers both.
export const SESSION_TITLE_MAX_TOKENS = 512
export const SESSION_TITLE_TIMEOUT_MS = 10_000

const MAX_TITLE_CHARS = 60
const FIRST_MESSAGE_MAX_CHARS = 800
const LAST_MESSAGE_MAX_CHARS = 400

export type SessionTitleContextFields = {
  firstUserMessage?: string | null
  lastMessagePreview?: string | null
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * Build the user prompt from the transcript-derived title fields. Returns null
 * when there is no usable context (so the caller can no-op with an empty
 * suggestion instead of spending a model call).
 */
export function buildSessionTitleUserPrompt(
  fields: SessionTitleContextFields,
): string | null {
  const first = fields.firstUserMessage?.trim() ?? ''
  const last = fields.lastMessagePreview?.trim() ?? ''
  const parts: Array<string> = []
  if (first) {
    parts.push(`First user message:\n${truncate(first, FIRST_MESSAGE_MAX_CHARS)}`)
  }
  if (last && last !== first) {
    parts.push(`Most recent message:\n${truncate(last, LAST_MESSAGE_MAX_CHARS)}`)
  }
  if (parts.length === 0) {
    return null
  }
  return `${parts.join('\n\n')}\n\nGenerate a short title (max 6 words) for this conversation. Reply with only the title.`
}

/**
 * Normalize a raw model completion into a safe single-line session title:
 * first line only, quotes/backticks stripped, whitespace collapsed, trailing
 * punctuation removed, length-capped. Returns "" when nothing usable remains.
 */
export function sanitizeSuggestedSessionTitle(raw: string): string {
  if (!raw) {
    return ''
  }
  let title = raw.trim()
  const newlineIndex = title.search(/\r?\n/)
  if (newlineIndex >= 0) {
    title = title.slice(0, newlineIndex).trim()
  }
  // Strip wrapping straight/smart quotes and backticks.
  title = title.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '')
  title = title.replace(/\s+/g, ' ').trim()
  // Drop trailing sentence punctuation a model may append.
  title = title.replace(/[.,;:!?]+$/, '').trim()
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).trim()
  }
  return title
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>
}

/**
 * Full title-generation path: prompt -> the session's model (via the gateway's
 * OpenAI-compatible completions endpoint) -> sanitize. Returns "" when there is
 * no usable context; throws when the completion request fails (caller maps to
 * an error the UI surfaces as `autoNameFailed`).
 */
export async function generateSessionTitle(params: {
  fields: SessionTitleContextFields
  model?: string
}): Promise<string> {
  const userPrompt = buildSessionTitleUserPrompt(params.fields)
  if (!userPrompt) {
    return ''
  }

  const requestBody = await buildRequestBody(
    [
      { role: 'system', content: SESSION_TITLE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { model: params.model, stream: false },
  )

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const bearer = getBearerToken()
  if (bearer) {
    headers['Authorization'] = `Bearer ${bearer}`
  }

  const response = await fetch(`${CLAUDE_API}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...requestBody, max_tokens: SESSION_TITLE_MAX_TOKENS }),
    signal: AbortSignal.timeout(SESSION_TITLE_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`session title completion failed: HTTP ${response.status}`)
  }
  const data = (await response.json()) as ChatCompletionResponse
  const content = data.choices?.[0]?.message?.content ?? ''
  return sanitizeSuggestedSessionTitle(content)
}
