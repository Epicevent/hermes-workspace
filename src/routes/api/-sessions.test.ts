import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: unknown) => options,
}))

const claude = vi.hoisted(() => ({
  ensureGatewayProbed: vi.fn(),
  listSessions: vi.fn(),
  updateSession: vi.fn(),
}))

const local = vi.hoisted(() => ({
  getLocalSession: vi.fn(),
  listLocalSessions: vi.fn(),
  updateLocalSession: vi.fn(),
}))

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

vi.mock('../../server/rate-limit', () => ({
  requireJsonContentType: () => null,
}))

vi.mock('../../server/claude-api', () => ({
  SESSIONS_API_UNAVAILABLE_MESSAGE: 'unavailable',
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  ensureGatewayProbed: claude.ensureGatewayProbed,
  getGatewayCapabilities: vi.fn(),
  listSessions: claude.listSessions,
  toSessionSummary: (session: unknown) => session,
  updateSession: claude.updateSession,
}))

vi.mock('../../server/local-session-store', () => ({
  deleteLocalSession: vi.fn(),
  getLocalSession: local.getLocalSession,
  listLocalSessions: local.listLocalSessions,
  updateLocalSession: local.updateLocalSession,
}))

async function loadHandlers() {
  vi.resetModules()
  const mod = await import('./sessions')
  return (mod as any).Route.server.handlers
}

const baseLocalSession = {
  id: 'local-1',
  title: 'Local Chat',
  model: 'gemini-3.6-flash',
  folderPath: null,
  createdAt: 100,
  updatedAt: 200,
  messageCount: 2,
}

beforeEach(() => {
  vi.clearAllMocks()
  claude.ensureGatewayProbed.mockResolvedValue({
    sessions: true,
    enhancedChat: true,
    dashboard: { available: true },
  })
  claude.listSessions.mockResolvedValue([])
  local.getLocalSession.mockReturnValue(baseLocalSession)
  local.listLocalSessions.mockReturnValue([baseLocalSession])
  local.updateLocalSession.mockImplementation(
    (_sessionId: string, updates: Record<string, unknown>) => ({
      ...baseLocalSession,
      ...updates,
      updatedAt: 300,
    }),
  )
})

describe('/api/sessions local session folders', () => {
  it('persists a normalized folderPath instead of returning a false success', async () => {
    const handlers = await loadHandlers()
    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/sessions', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionKey: 'local-1',
          friendlyId: 'local-1',
          folderPath: '/검증//이미지/',
        }),
      }),
    })

    expect(response.status).toBe(200)
    expect(local.updateLocalSession).toHaveBeenCalledWith('local-1', {
      folderPath: '검증/이미지',
    })
    expect(await response.json()).toMatchObject({
      ok: true,
      source: 'local',
      entry: {
        key: 'local-1',
        folderPath: '검증/이미지',
        title: 'Local Chat',
      },
    })
    expect(claude.updateSession).not.toHaveBeenCalled()
  })

  it('returns persisted local folderPath values from the sessions listing', async () => {
    local.listLocalSessions.mockReturnValue([
      { ...baseLocalSession, folderPath: '검증/이미지' },
    ])
    const handlers = await loadHandlers()
    const response = await handlers.GET({
      request: new Request('http://localhost/api/sessions'),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      sessions: [
        {
          key: 'local-1',
          folderPath: '검증/이미지',
          source: 'local',
        },
      ],
    })
  })
})
