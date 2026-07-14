import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTRACT_NAME,
  REQUIRED_CHECKS,
  evaluateConfigAgainstLive,
  redact,
  resolveHermesHome,
  runSelftest,
} from './selftest.mjs'

describe('redact', () => {
  it('masks long token-like blobs and truncates to one line', () => {
    const out = redact(`key=sk-abcdefghijklmnopqrstuvwxyz012345\nsecond line`)
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(out).toContain('<redacted>')
    expect(out).not.toContain('second line')
  })
})

describe('resolveHermesHome', () => {
  it('prefers HERMES_HOME, then CLAUDE_HOME, then ~/.hermes', () => {
    expect(resolveHermesHome({ HERMES_HOME: '/opt/data' })).toBe('/opt/data')
    expect(resolveHermesHome({ CLAUDE_HOME: '/legacy' })).toBe('/legacy')
    expect(resolveHermesHome({ HOME: '/home/x' })).toBe(
      join('/home/x', '.hermes'),
    )
  })
})

describe('evaluateConfigAgainstLive', () => {
  it('accepts a config with no declared model', () => {
    const verdict = evaluateConfigAgainstLive({ theme: 'dark' }, 'gpt-x')
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain('no model declared')
  })

  it('accepts string model matching live', () => {
    expect(
      evaluateConfigAgainstLive(
        { model: 'gemini-3.5-flash' },
        'gemini-3.5-flash',
      ).ok,
    ).toBe(true)
  })

  it('accepts dict model via default key', () => {
    const verdict = evaluateConfigAgainstLive(
      { model: { default: 'm1', provider: 'p' } },
      'm1',
    )
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain('matches live')
  })

  it('fails on disk/live drift', () => {
    const verdict = evaluateConfigAgainstLive(
      { model: 'disk-model' },
      'live-model',
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain('drift')
  })

  it('rejects a non-mapping config', () => {
    expect(evaluateConfigAgainstLive('just a string', '').ok).toBe(false)
    expect(evaluateConfigAgainstLive(null, '').ok).toBe(false)
  })

  it('passes declared model when live is unresolved', () => {
    const verdict = evaluateConfigAgainstLive({ model: 'm1' }, '')
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain('live unresolved')
  })
})

function fakeFetch(routes) {
  return async (url) => {
    for (const [suffix, res] of Object.entries(routes)) {
      if (String(url).endsWith(suffix)) {
        return {
          ok: res.status === 200,
          status: res.status,
          json: async () => res.body ?? {},
        }
      }
    }
    throw new Error(`unexpected url ${url}`)
  }
}

async function makeEnv({ configYaml, withNas = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hermes-selftest-'))
  const home = join(root, 'data')
  const workspace = join(root, 'workspace')
  await mkdir(home, { recursive: true })
  if (withNas) {
    await mkdir(join(workspace, 'nas_docs'), { recursive: true })
    await writeFile(join(workspace, 'nas_docs', 'README.txt'), 'seed')
  } else {
    await mkdir(workspace, { recursive: true })
  }
  if (configYaml !== undefined) {
    await writeFile(join(home, 'config.yaml'), configYaml)
  }
  return { HERMES_HOME: home, HERMES_WORKSPACE_DIR: workspace, PORT: '3000' }
}

const HEALTHY_ROUTES = {
  ':3000/': { status: 200 },
  '/health': { status: 200 },
  '/api/status': { status: 200 },
  '/api/model/info': {
    status: 200,
    body: { model: 'gemini-3.5-flash', provider: 'google' },
  },
}

describe('runSelftest', () => {
  it('all green on a healthy runtime', async () => {
    const env = await makeEnv({ configYaml: 'model: gemini-3.5-flash\n' })
    const result = await runSelftest({
      env,
      fetchImpl: fakeFetch(HEALTHY_ROUTES),
      skipPrivilegeDrop: true,
    })
    expect(result.ok).toBe(true)
    expect(result.contract).toBe(CONTRACT_NAME)
    expect(result.required_checks).toEqual(REQUIRED_CHECKS)
    expect(result.checks.map((c) => c.name)).toEqual(REQUIRED_CHECKS)
    expect(result.checks.every((c) => c.severity === 'required')).toBe(true)
  })

  it('fails when the live agent resolves no model', async () => {
    const env = await makeEnv({ configYaml: '{}\n' })
    const routes = {
      ...HEALTHY_ROUTES,
      '/api/model/info': { status: 200, body: { model: '', provider: '' } },
    }
    const result = await runSelftest({
      env,
      fetchImpl: fakeFetch(routes),
      skipPrivilegeDrop: true,
    })
    expect(result.ok).toBe(false)
    const check = result.checks.find((c) => c.name === 'selftest_model_info_ok')
    expect(check.ok).toBe(false)
  })

  it('fails on disk/live model drift', async () => {
    const env = await makeEnv({ configYaml: 'model: some-other-model\n' })
    const result = await runSelftest({
      env,
      fetchImpl: fakeFetch(HEALTHY_ROUTES),
      skipPrivilegeDrop: true,
    })
    expect(result.ok).toBe(false)
    const check = result.checks.find((c) => c.name === 'selftest_config_ok')
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('drift')
  })

  it('fails when nas_docs is missing', async () => {
    const env = await makeEnv({
      configYaml: 'model: gemini-3.5-flash\n',
      withNas: false,
    })
    const result = await runSelftest({
      env,
      fetchImpl: fakeFetch(HEALTHY_ROUTES),
      skipPrivilegeDrop: true,
    })
    expect(result.ok).toBe(false)
    const check = result.checks.find((c) => c.name === 'selftest_nas_access_ok')
    expect(check.ok).toBe(false)
  })

  it('fails when a health surface is down, with the url in detail', async () => {
    const env = await makeEnv({ configYaml: 'model: gemini-3.5-flash\n' })
    const routes = { ...HEALTHY_ROUTES, '/health': { status: 503 } }
    const result = await runSelftest({
      env,
      fetchImpl: fakeFetch(routes),
      skipPrivilegeDrop: true,
    })
    expect(result.ok).toBe(false)
    const check = result.checks.find(
      (c) => c.name === 'selftest_gateway_health_ok',
    )
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('status=503')
  })

  it('missing config.yaml is a config failure, not a crash', async () => {
    const env = await makeEnv({})
    const result = await runSelftest({
      env,
      fetchImpl: fakeFetch(HEALTHY_ROUTES),
      skipPrivilegeDrop: true,
    })
    const check = result.checks.find((c) => c.name === 'selftest_config_ok')
    expect(check.ok).toBe(false)
    expect(result.ok).toBe(false)
  })
})
