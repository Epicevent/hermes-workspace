import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'

import { isAuthenticated } from './auth-middleware'
import {
  deleteEnvVar,
  getConfig,
  getEnvVars,
  saveConfig,
  setEnvVar,
} from './claude-dashboard-api'
import { dashboardFetch, ensureGatewayProbed } from './gateway-capabilities'
import {
  HERMES_PROVIDER_CATALOG,
  normalizeHermesConfigState,
  normalizeHermesProviderId,
} from './hermes-config-migration'
import {
  applyHermesConfigPatch,
  type HermesConfigPatch,
  type HermesConfigPatchResult,
  parseEnvFile,
  readHermesConfigFiles,
  resolveHermesConfigPaths,
  stringifyEnv,
} from './hermes-config-store'
import {
  ensureDiscovery,
  getDiscoveredModels,
  getDiscoveryStatus,
} from './local-provider-discovery'

type AuthResult = Response | true

const ACTION_MESSAGES: Record<string, string> = {
  'set-default-model': 'Default model updated.',
  'set-api-key': 'API key saved.',
  'remove-api-key': 'API key removed.',
  'set-custom-provider': 'Custom provider saved.',
  'remove-custom-provider': 'Custom provider removed.',
}

const LEGACY_SAVE_MESSAGE = 'Saved.'
const RESERVED_CONFIG_PATH_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
])
const PROVIDER_ENV_KEYS = Array.from(
  new Set(HERMES_PROVIDER_CATALOG.flatMap((provider) => provider.envKeys)),
)

const PatchActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set-default-model'),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  }),
  z.object({
    action: z.literal('set-api-key'),
    envKey: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    action: z.literal('remove-api-key'),
    envKey: z.string().min(1),
  }),
  z.object({
    action: z.literal('set-custom-provider'),
    provider: z.object({
      name: z.string().min(1),
      baseUrl: z.string().min(1),
      apiKeyEnv: z.string().optional(),
      apiMode: z.string().optional(),
    }),
  }),
  z.object({
    action: z.literal('remove-custom-provider'),
    name: z.string().min(1),
  }),
])

const RawConfigPatchSchema = z
  .object({
    raw: z.string().min(1),
    reason: z.string().optional(),
  })
  .strict()

const PathValuePatchSchema = z
  .object({
    path: z.string().min(1),
    value: z.unknown(),
  })
  .strict()

const LegacyPatchSchema = z
  .object({
    config: z.record(z.string(), z.unknown()).optional(),
    env: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  })
  .strict()

async function authorize(request: Request): Promise<AuthResult> {
  if (!isAuthenticated(request)) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  return true
}

function readProcessProviderEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PROVIDER_ENV_KEYS) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function unwrapDashboardConfig(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return {}
  const inner = value.config
  return isPlainRecord(inner) ? inner : value
}

function dashboardEnvPlaceholders(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {}
  const env: Record<string, string> = {}
  for (const key of PROVIDER_ENV_KEYS) {
    const info = value[key]
    if (!isPlainRecord(info)) continue
    const isSet =
      info.has_value === true ||
      info.is_set === true ||
      info.set_in_env === true ||
      info.set_in_file === true ||
      Boolean(info.masked_value) ||
      Boolean(info.redacted_value)
    if (isSet) env[key] = String(info.masked_value || info.redacted_value || 'configured')
  }
  return env
}

async function readDashboardConfigFallback(): Promise<Record<string, unknown>> {
  try {
    return unwrapDashboardConfig(await getConfig())
  } catch {
    return {}
  }
}

async function readDashboardEnvFallback(): Promise<Record<string, string>> {
  try {
    return dashboardEnvPlaceholders(await getEnvVars())
  } catch {
    return {}
  }
}

async function readDashboardModelInfoFallback(): Promise<{
  provider: string
  model: string
} | null> {
  if (!(await isDashboardConfigAvailable())) return null
  try {
    const response = await dashboardFetch('/api/model/info')
    if (!response.ok) return null
    const payload = (await response.json()) as unknown
    if (!isPlainRecord(payload)) return null
    const provider = normalizeHermesProviderId(
      readString(payload.provider) ||
        readString(payload.current_provider) ||
        readString(payload.currentProvider) ||
        readString(payload.default_provider) ||
        readString(payload.defaultProvider) ||
        readString(payload.model_provider) ||
        readString(payload.modelProvider),
    )
    const model =
      readString(payload.model) ||
      readString(payload.current_model) ||
      readString(payload.currentModel) ||
      readString(payload.default_model) ||
      readString(payload.defaultModel)
    if (!provider || !model) return null
    return { provider, model }
  } catch {
    return null
  }
}

async function isDashboardConfigAvailable(): Promise<boolean> {
  try {
    const capabilities = await ensureGatewayProbed()
    return Boolean(capabilities.dashboard?.available)
  } catch {
    return false
  }
}

async function saveDashboardConfigPatch(config: Record<string, unknown>): Promise<boolean> {
  if (!(await isDashboardConfigAvailable())) return false
  try {
    await saveConfig(config)
    return true
  } catch {
    return false
  }
}

function hasDefaultModel(config: Record<string, unknown>): boolean {
  const flatProvider = readString(config.provider)
  if (typeof config.model === 'string' && config.model.trim() && flatProvider) {
    return true
  }
  if (isPlainRecord(config.model)) {
    const model = config.model
    const provider = readString(model.provider) || flatProvider
    return Boolean(
      provider &&
        ((typeof model.default === 'string' && model.default.trim()) ||
          (typeof model.model === 'string' && model.model.trim())),
    )
  }
  return false
}

function mergeRuntimeEnv(...sources: Array<Record<string, string>>): Record<string, string> {
  return Object.assign({}, ...sources)
}

function withDefaultModel(
  config: Record<string, unknown>,
  defaultModel: { provider: string; model: string },
): Record<string, unknown> {
  const modelConfig = isPlainRecord(config.model) ? config.model : {}
  return {
    ...config,
    provider: defaultModel.provider,
    model: {
      ...modelConfig,
      provider: defaultModel.provider,
      default: defaultModel.model,
    },
  }
}

function nestedConfigPatch(keyPath: string, value: unknown): Record<string, unknown> {
  const parts = keyPath.split('.').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('config path is empty')

  const root: Record<string, unknown> = {}
  let cursor = root
  for (const segment of parts.slice(0, -1)) {
    assertSafeConfigPathSegment(segment)
    cursor[segment] = {}
    cursor = cursor[segment] as Record<string, unknown>
  }
  const leaf = parts[parts.length - 1]
  assertSafeConfigPathSegment(leaf)
  cursor[leaf] = value
  return root
}

async function applyDashboardPatch(
  patch: HermesConfigPatch,
): Promise<HermesConfigPatchResult | null> {
  if (!(await isDashboardConfigAvailable())) return null
  try {
    switch (patch.action) {
      case 'set-default-model':
      await saveConfig({
          provider: patch.providerId,
          model: {
            provider: patch.providerId,
            default: patch.modelId,
          },
        })
        return { ok: true }
      case 'set-api-key':
        await setEnvVar(patch.envKey, patch.value)
        process.env[patch.envKey] = patch.value
        return { ok: true }
      case 'remove-api-key':
        await deleteEnvVar(patch.envKey)
        delete process.env[patch.envKey]
        return { ok: true }
      default:
        return null
    }
  } catch {
    return null
  }
}

export async function handleHermesConfigGet({
  request,
}: {
  request: Request
}): Promise<Response> {
  const auth = await authorize(request)
  if (auth !== true) return auth

  const paths = resolveHermesConfigPaths()

  await Promise.resolve(ensureGatewayProbed()).catch(() => undefined)
  await Promise.resolve(ensureDiscovery()).catch(() => undefined)
  const files = readHermesConfigFiles(paths)
  const dashboardConfig = await readDashboardConfigFallback()
  const dashboardEnv = await readDashboardEnvFallback()
  const baseConfig = hasDefaultModel(dashboardConfig) ? dashboardConfig : files.config
  const modelInfoDefault = hasDefaultModel(baseConfig)
    ? null
    : await readDashboardModelInfoFallback()
  const config = modelInfoDefault ? withDefaultModel(baseConfig, modelInfoDefault) : baseConfig
  const env = mergeRuntimeEnv(dashboardEnv, readProcessProviderEnv(), files.env)
  const state = normalizeHermesConfigState({
    paths,
    config,
    env,
    authProfiles: files.authProfiles,
    localProviders: getDiscoveryStatus(),
    localModels: getDiscoveredModels(),
  })

  // Legacy /api/claude-config consumers read provider.maskedKeys; alias it.
  const providers = state.providers.map((p) => ({
    ...p,
    maskedKeys: p.maskedCredentials,
  }))

  return Response.json({
    ...state,
    providers,
    claudeHome: paths.hermesHome,
  })
}

function readConfigObject(configPath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = YAML.parse(raw)
    if (isPlainRecord(parsed)) return parsed
  } catch {}
  return {}
}

function writeConfigObject(
  configPath: string,
  config: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8')
}

function assertSafeConfigPathSegment(segment: string): void {
  if (!segment || RESERVED_CONFIG_PATH_SEGMENTS.has(segment)) {
    throw new Error(`Invalid config path segment: ${segment || '<empty>'}`)
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    assertSafeConfigPathSegment(key)
    if (
      isPlainRecord(value) &&
      isPlainRecord(target[key])
    ) {
      deepMerge(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      target[key] = value
    }
  }
}

function applyLegacyConfigBody(
  configPath: string,
  updates: Record<string, unknown>,
): void {
  const current = readConfigObject(configPath)

  for (const [key, value] of Object.entries(updates)) {
    assertSafeConfigPathSegment(key)
    if (value === null) {
      delete current[key]
      delete updates[key]
    }
  }
  deepMerge(current, updates)
  writeConfigObject(configPath, current)
}

function applyRawConfigBody(configPath: string, raw: string): void {
  const parsed = JSON.parse(raw) as unknown
  if (!isPlainRecord(parsed)) {
    throw new Error('raw config patch must be a JSON object')
  }
  applyLegacyConfigBody(configPath, parsed)
}

function applyPathValueBody(
  configPath: string,
  keyPath: string,
  value: unknown,
): void {
  const parts = keyPath.split('.').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('config path is empty')

  const current = readConfigObject(configPath)
  let cursor: Record<string, unknown> = current

  for (const segment of parts.slice(0, -1)) {
    assertSafeConfigPathSegment(segment)
    if (!isPlainRecord(cursor[segment])) cursor[segment] = {}
    cursor = cursor[segment] as Record<string, unknown>
  }

  const leaf = parts[parts.length - 1]
  assertSafeConfigPathSegment(leaf)
  if (value === null) delete cursor[leaf]
  else cursor[leaf] = value

  writeConfigObject(configPath, current)
}

function applyLegacyEnvBody(
  envPath: string,
  envUpdates: Record<string, string | null>,
): void {
  let current: Record<string, string> = {}
  try {
    current = parseEnvFile(fs.readFileSync(envPath, 'utf-8'))
  } catch {}

  for (const [key, value] of Object.entries(envUpdates)) {
    if (value === '' || value === null) delete current[key]
    else current[key] = value
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  fs.writeFileSync(envPath, stringifyEnv(current), 'utf-8')
}

export async function handleHermesConfigPatch({
  request,
}: {
  request: Request
}): Promise<Response> {
  const auth = await authorize(request)
  if (auth !== true) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const paths = resolveHermesConfigPaths()
  const hasAction =
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { action?: unknown }).action === 'string'

  if (hasAction) {
    const parsed = PatchActionSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'Invalid patch action body', issues: parsed.error.issues },
        { status: 400 },
      )
    }
    const dashboardResult = await applyDashboardPatch(parsed.data)
    const result = dashboardResult ?? applyHermesConfigPatch(paths, parsed.data)
    if (parsed.data.action === 'set-api-key' && result.ok) {
      process.env[parsed.data.envKey] = parsed.data.value
    }
    if (parsed.data.action === 'remove-api-key' && result.ok) {
      delete process.env[parsed.data.envKey]
    }
    return Response.json({ ...result, message: ACTION_MESSAGES[parsed.data.action] })
  }

  const rawPatch = RawConfigPatchSchema.safeParse(body)
  if (rawPatch.success) {
    try {
      const parsedRaw = JSON.parse(rawPatch.data.raw) as unknown
      if (!isPlainRecord(parsedRaw)) {
        throw new Error('raw config patch must be a JSON object')
      }
      if (!(await saveDashboardConfigPatch(parsedRaw))) {
        applyRawConfigBody(paths.configPath, rawPatch.data.raw)
      }
      return Response.json({ ok: true, message: LEGACY_SAVE_MESSAGE })
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : 'Invalid raw config patch',
        },
        { status: 400 },
      )
    }
  }

  const pathPatch = PathValuePatchSchema.safeParse(body)
  if (pathPatch.success) {
    try {
      if (
        !(await saveDashboardConfigPatch(
          nestedConfigPatch(pathPatch.data.path, pathPatch.data.value),
        ))
      ) {
        applyPathValueBody(paths.configPath, pathPatch.data.path, pathPatch.data.value)
      }
      return Response.json({ ok: true, message: LEGACY_SAVE_MESSAGE })
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : 'Invalid config path patch',
        },
        { status: 400 },
      )
    }
  }

  const legacy = LegacyPatchSchema.safeParse(body)
  if (!legacy.success) {
    return Response.json(
      { ok: false, error: 'Invalid request body', issues: legacy.error.issues },
      { status: 400 },
    )
  }

  if (!legacy.data.config && !legacy.data.env) {
    return Response.json(
      { ok: false, error: 'Invalid request body: no supported patch fields' },
      { status: 400 },
    )
  }

  if (legacy.data.config) {
    if (!(await saveDashboardConfigPatch(legacy.data.config))) {
      applyLegacyConfigBody(paths.configPath, legacy.data.config as Record<string, unknown>)
    }
  }
  if (legacy.data.env) {
    const envEntries = Object.entries(legacy.data.env)
    const canUseDashboard = await isDashboardConfigAvailable()
    let dashboardEnvSaved = canUseDashboard
    if (canUseDashboard) {
      for (const [key, value] of envEntries) {
        try {
          if (value === '' || value === null) {
            await deleteEnvVar(key)
            delete process.env[key]
          } else {
            await setEnvVar(key, value)
            process.env[key] = value
          }
        } catch {
          dashboardEnvSaved = false
          break
        }
      }
    }
    if (!dashboardEnvSaved) applyLegacyEnvBody(paths.envPath, legacy.data.env)
  }

  return Response.json({ ok: true, message: LEGACY_SAVE_MESSAGE })
}
