import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { dashboardFetch, ensureGatewayProbed } from '../../server/gateway-capabilities'
import { getConfig, getEnvVars } from '../../server/claude-dashboard-api'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: any) => opts,
}))

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

vi.mock('../../server/gateway-capabilities', () => ({
  dashboardFetch: vi.fn(),
  ensureGatewayProbed: vi.fn(),
  getCapabilities: () => ({ config: true }),
}))

vi.mock('../../server/claude-dashboard-api', () => ({
  getConfig: vi.fn(),
  getEnvVars: vi.fn(),
  saveConfig: vi.fn(async () => ({ ok: true })),
  setEnvVar: vi.fn(async () => ({ ok: true })),
  deleteEnvVar: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../../server/local-provider-discovery', () => ({
  ensureDiscovery: vi.fn(),
  getDiscoveryStatus: () => [],
  getDiscoveredModels: () => [],
}))

let tmpHome = ''
const originalEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined) {
  if (!(key in originalEnv)) originalEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-config-route-'))
  setEnv('HERMES_HOME', tmpHome)
  setEnv('CLAUDE_HOME', undefined)
  vi.resetModules()
  vi.mocked(ensureGatewayProbed).mockReset()
  vi.mocked(ensureGatewayProbed).mockResolvedValue({} as any)
  vi.mocked(dashboardFetch).mockReset()
  vi.mocked(dashboardFetch).mockRejectedValue(new Error('dashboard unavailable'))
  vi.mocked(getConfig).mockReset()
  vi.mocked(getConfig).mockRejectedValue(new Error('dashboard unavailable'))
  vi.mocked(getEnvVars).mockReset()
  vi.mocked(getEnvVars).mockRejectedValue(new Error('dashboard unavailable'))
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(originalEnv)) delete originalEnv[key]
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

async function loadHandlers(modulePath: string) {
  const mod = await import(modulePath)
  return (mod as any).Route.server.handlers
}

describe('canonical /api/hermes-config route', () => {
  it('GET returns normalized provider state with paths and active provider', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'config.yaml'),
      'provider: openrouter\nmodel: auto\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(tmpHome, '.env'),
      'OPENROUTER_API_KEY=sk-test-1234\n',
      'utf-8',
    )

    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.GET({
      request: new Request('http://localhost/api/hermes-config'),
    })
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.activeProvider).toBe('openrouter')
    expect(body.activeModel).toBe('auto')
    expect(body.paths.hermesHome).toBe(tmpHome)
    const openrouter = body.providers.find((p: any) => p.id === 'openrouter')
    expect(openrouter.configured).toBe(true)
    expect(openrouter.isDefault).toBe(true)
  })

  it('GET still returns local config when gateway probing fails', async () => {
    vi.mocked(ensureGatewayProbed).mockRejectedValue(new Error('probe failed'))
    fs.writeFileSync(
      path.join(tmpHome, 'config.yaml'),
      'provider: google\nmodel:\n  provider: google\n  default: gemini-3.1-pro-preview\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(tmpHome, '.env'),
      'GOOGLE_API_KEY=google-key-1234\n',
      'utf-8',
    )

    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.GET({
      request: new Request('http://localhost/api/hermes-config'),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.activeProvider).toBe('google')
    expect(body.activeModel).toBe('gemini-3.1-pro-preview')
  })

  it('GET merges runtime process env secrets when the mounted env file is unreadable', async () => {
    setEnv('GEMINI_API_KEY', 'gemini-key-1234')
    fs.writeFileSync(
      path.join(tmpHome, 'config.yaml'),
      'provider: google\nmodel:\n  provider: google\n  default: gemini-3.1-pro-preview\n',
      'utf-8',
    )

    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.GET({
      request: new Request('http://localhost/api/hermes-config'),
    })
    const body = await res.json()

    const google = body.providers.find((p: any) => p.id === 'google')
    expect(body.activeProvider).toBe('google')
    expect(body.activeModel).toBe('gemini-3.1-pro-preview')
    expect(google.configured).toBe(true)
    expect(google.maskedCredentials.GEMINI_API_KEY).toBeTruthy()
  })

  it('GET falls back to dashboard config and aliases gemini to Google', async () => {
    setEnv('GOOGLE_API_KEY', 'google-key-1234')
    vi.mocked(ensureGatewayProbed).mockResolvedValue({
      dashboard: { available: true, url: 'http://127.0.0.1:9119' },
    } as any)
    vi.mocked(getConfig).mockResolvedValue({
      config: {
        model: {
          provider: 'gemini',
          default: 'gemini-3.1-pro-preview',
        },
      },
    })
    vi.mocked(getEnvVars).mockResolvedValue({})

    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.GET({
      request: new Request('http://localhost/api/hermes-config'),
    })
    const body = await res.json()

    const google = body.providers.find((p: any) => p.id === 'google')
    expect(body.activeProvider).toBe('google')
    expect(body.activeModel).toBe('gemini-3.1-pro-preview')
    expect(google.isDefault).toBe(true)
    expect(google.configured).toBe(true)
  })

  it('GET falls back to dashboard model info when config omits the default model', async () => {
    setEnv('GEMINI_API_KEY', 'gemini-key-1234')
    vi.mocked(ensureGatewayProbed).mockResolvedValue({
      dashboard: { available: true, url: 'http://127.0.0.1:9119' },
    } as any)
    vi.mocked(getConfig).mockResolvedValue({ config: { ui: { theme: 'dark' } } })
    vi.mocked(getEnvVars).mockResolvedValue({})
    vi.mocked(dashboardFetch).mockResolvedValue(
      Response.json({
        provider: 'gemini',
        model: 'gemini-3.1-pro-preview',
      }),
    )

    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.GET({
      request: new Request('http://localhost/api/hermes-config'),
    })
    const body = await res.json()

    const google = body.providers.find((p: any) => p.id === 'google')
    expect(dashboardFetch).toHaveBeenCalledWith('/api/model/info')
    expect(body.activeProvider).toBe('google')
    expect(body.activeModel).toBe('gemini-3.1-pro-preview')
    expect(google.isDefault).toBe(true)
    expect(google.configured).toBe(true)
  })

  it('PATCH dispatches set-default-model and returns the action message', async () => {
    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'set-default-model',
          providerId: 'openrouter',
          modelId: 'auto',
        }),
      }),
    })
    const body = await res.json()

    expect(body).toMatchObject({ ok: true, message: 'Default model updated.' })
    expect(
      fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8'),
    ).toMatch(/provider: openrouter/)
  })

  it('PATCH legacy { config } body deep-merges and preserves siblings', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'config.yaml'),
      'memory:\n  user_profile_enabled: true\n',
      'utf-8',
    )

    const handlers = await loadHandlers('./hermes-config')
    await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({ config: { memory: { memory_enabled: true } } }),
      }),
    })

    const onDisk = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8')
    expect(onDisk).toContain('memory_enabled: true')
    expect(onDisk).toContain('user_profile_enabled: true')
  })

  it('POST /api/config-patch writes API keys through the action body', async () => {
    const handlers = await loadHandlers('./config-patch')
    const res = await handlers.POST({
      request: new Request('http://localhost/api/config-patch', {
        method: 'POST',
        body: JSON.stringify({
          action: 'set-api-key',
          envKey: 'GOOGLE_API_KEY',
          value: 'google-key-1234',
        }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, message: 'API key saved.' })
    expect(fs.readFileSync(path.join(tmpHome, '.env'), 'utf-8')).toContain(
      'GOOGLE_API_KEY=google-key-1234',
    )
  })

  it('POST /api/config-patch applies path/value settings from the settings screen', async () => {
    const handlers = await loadHandlers('./config-patch')
    const res = await handlers.POST({
      request: new Request('http://localhost/api/config-patch', {
        method: 'POST',
        body: JSON.stringify({
          path: 'agents.defaults.contextTokens',
          value: 120000,
        }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    const parsed = YAML.parse(
      fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8'),
    )
    expect(parsed.agents.defaults.contextTokens).toBe(120000)
  })

  it('PATCH accepts raw JSON config patches from older provider wizard clients', async () => {
    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({
          raw: JSON.stringify({
            auth: {
              profiles: {
                'google:default': {
                  provider: 'google',
                  apiKey: 'google-key-1234',
                },
              },
            },
          }),
          reason: 'test raw patch',
        }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    const parsed = YAML.parse(
      fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8'),
    )
    expect(parsed.auth.profiles['google:default']).toMatchObject({
      provider: 'google',
      apiKey: 'google-key-1234',
    })
  })

  it('PATCH rejects unsupported no-op payloads instead of silently succeeding', async () => {
    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({ rawConfig: '{}', note: 'unknown shape' }),
      }),
    })

    expect(res.status).toBe(400)
  })

  it('PATCH rejects malformed action bodies with 400', async () => {
    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'set-default-model' }),
      }),
    })
    expect(res.status).toBe(400)
  })

  it('PATCH writes local config without requiring gateway config capability', async () => {
    const handlers = await loadHandlers('./hermes-config')
    const res = await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'set-default-model',
          providerId: 'google',
          modelId: 'gemini-3.1-pro-preview',
        }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(
      fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8'),
    ).toContain('gemini-3.1-pro-preview')
  })
})

describe('legacy /api/claude-config alias', () => {
  it('GET aliases provider.maskedCredentials to provider.maskedKeys for the legacy /settings page', async () => {
    fs.writeFileSync(
      path.join(tmpHome, '.env'),
      'OPENROUTER_API_KEY=sk-test-1234\n',
      'utf-8',
    )

    const handlers = await loadHandlers('./claude-config')
    const res = await handlers.GET({
      request: new Request('http://localhost/api/claude-config'),
    })
    const body = await res.json()
    const openrouter = body.providers.find((p: any) => p.id === 'openrouter')

    expect(openrouter.maskedKeys).toEqual(openrouter.maskedCredentials)
    expect(openrouter.maskedKeys.OPENROUTER_API_KEY).toBeTruthy()
  })
})
