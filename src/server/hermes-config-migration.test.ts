import { describe, expect, it } from 'vitest'
import { normalizeHermesConfigState } from './hermes-config-migration'

const paths = {
  hermesHome: '/tmp/hermes',
  configPath: '/tmp/hermes/config.yaml',
  envPath: '/tmp/hermes/.env',
  authProfilesPath: '/tmp/hermes/auth-profiles.json',
}

describe('normalizeHermesConfigState', () => {
  it('normalizes flat default provider and model config', () => {
    const state = normalizeHermesConfigState({
      paths,
      config: { provider: 'openrouter', model: 'auto' },
      env: { OPENROUTER_API_KEY: 'sk-openrouter-123456' },
      authProfiles: {},
      localProviders: [],
      localModels: [],
    })

    expect(state.activeProvider).toBe('openrouter')
    expect(state.activeModel).toBe('auto')
    expect(state.defaultModel).toEqual({
      provider: 'openrouter',
      model: 'auto',
      source: 'flat',
    })
    const openrouter = state.providers.find((p) => p.id === 'openrouter')
    expect(openrouter?.configured).toBe(true)
    expect(openrouter?.authenticated).toBe(true)
    expect(openrouter?.isDefault).toBe(true)
    expect(openrouter?.authSource).toBe('env')
  })

  it('normalizes nested default provider and model config', () => {
    const state = normalizeHermesConfigState({
      paths,
      config: { model: { provider: 'openai-codex', default: 'gpt-5.4' } },
      env: {},
      authProfiles: {},
      localProviders: [],
      localModels: [],
    })

    expect(state.activeProvider).toBe('openai-codex')
    expect(state.activeModel).toBe('gpt-5.4')
    expect(state.defaultModel).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.4',
      source: 'nested',
    })
  })

  it('falls back to nested model when only a partial flat field is set', () => {
    const state = normalizeHermesConfigState({
      paths,
      config: {
        provider: 'openrouter',
        model: { provider: 'openrouter', default: 'auto' },
      },
      env: {},
      authProfiles: {},
      localProviders: [],
      localModels: [],
    })

    expect(state.defaultModel).toEqual({
      provider: 'openrouter',
      model: 'auto',
      source: 'nested',
    })
  })

  it('reports Google Gemini as configured from GOOGLE_API_KEY', () => {
    const state = normalizeHermesConfigState({
      paths,
      config: { model: { provider: 'google', default: 'gemini-2.5-flash' } },
      env: { GOOGLE_API_KEY: 'google-key-123456' },
      authProfiles: {},
      localProviders: [],
      localModels: [],
    })

    expect(state.activeProvider).toBe('google')
    expect(state.activeModel).toBe('gemini-2.5-flash')
    const google = state.providers.find((p) => p.id === 'google')
    expect(google?.configured).toBe(true)
    expect(google?.authenticated).toBe(true)
    expect(google?.available).toBe(true)
    expect(google?.isDefault).toBe(true)
    expect(google?.authSource).toBe('env')
    expect(google?.envKeys).toEqual(['GOOGLE_API_KEY', 'GEMINI_API_KEY'])
    expect(google?.maskedCredentials.GOOGLE_API_KEY).toBe('goog...3456')
    expect(google?.models.map((model) => model.id)).toContain('gemini-2.5-flash')
  })

  it('accepts GEMINI_API_KEY as a Google Gemini key alias', () => {
    const state = normalizeHermesConfigState({
      paths,
      config: { model: { provider: 'google', default: 'gemini-2.0-flash' } },
      env: { GEMINI_API_KEY: 'gemini-key-123456' },
      authProfiles: {},
      localProviders: [],
      localModels: [],
    })

    const google = state.providers.find((p) => p.id === 'google')
    expect(google?.configured).toBe(true)
    expect(google?.authenticated).toBe(true)
    expect(google?.authSource).toBe('env')
    expect(google?.maskedCredentials.GEMINI_API_KEY).toBe('gemi...3456')
  })
})
