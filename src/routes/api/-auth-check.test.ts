import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: any) => opts,
}))

const authState = vi.hoisted(() => ({
  authenticated: false,
  authRequired: false,
}))

const gateway = vi.hoisted(() => ({
  ensureGatewayProbed: vi.fn(),
}))

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => !authState.authRequired || authState.authenticated,
  isPasswordProtectionEnabled: () => authState.authRequired,
}))

vi.mock('../../server/gateway-capabilities', () => ({
  ensureGatewayProbed: gateway.ensureGatewayProbed,
}))

async function loadHandlers() {
  vi.resetModules()
  const mod = await import('./auth-check')
  return (mod as any).Route.server.handlers
}

beforeEach(() => {
  authState.authenticated = false
  authState.authRequired = false
  gateway.ensureGatewayProbed.mockReset()
})

describe('/api/auth-check', () => {
  it('reports required auth before probing the gateway', async () => {
    authState.authRequired = true
    authState.authenticated = false
    gateway.ensureGatewayProbed.mockResolvedValue({
      health: false,
      chatCompletions: false,
      models: false,
    })

    const handlers = await loadHandlers()
    const res = await handlers.GET({
      request: new Request('http://localhost/api/auth-check'),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      authenticated: false,
      authRequired: true,
    })
    expect(gateway.ensureGatewayProbed).not.toHaveBeenCalled()
  })

  it('keeps auth status available when the gateway is unreachable', async () => {
    gateway.ensureGatewayProbed.mockResolvedValue({
      health: false,
      chatCompletions: false,
      models: false,
    })

    const handlers = await loadHandlers()
    const res = await handlers.GET({
      request: new Request('http://localhost/api/auth-check'),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      authenticated: true,
      authRequired: false,
      error: 'claude_agent_unreachable',
    })
  })
})
