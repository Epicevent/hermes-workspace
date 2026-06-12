import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'

import { isAuthenticated } from './auth-middleware'
import { ensureGatewayProbed } from './gateway-capabilities'
import { normalizeHermesConfigState } from './hermes-config-migration'
import {
  applyHermesConfigPatch,
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
  const state = normalizeHermesConfigState({
    paths,
    config: files.config,
    env: files.env,
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
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
    const result = applyHermesConfigPatch(paths, parsed.data)
    return Response.json({ ...result, message: ACTION_MESSAGES[parsed.data.action] })
  }

  const rawPatch = RawConfigPatchSchema.safeParse(body)
  if (rawPatch.success) {
    try {
      applyRawConfigBody(paths.configPath, rawPatch.data.raw)
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
      applyPathValueBody(paths.configPath, pathPatch.data.path, pathPatch.data.value)
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

  if (legacy.data.config) applyLegacyConfigBody(paths.configPath, legacy.data.config)
  if (legacy.data.env) applyLegacyEnvBody(paths.envPath, legacy.data.env)

  return Response.json({ ok: true, message: LEGACY_SAVE_MESSAGE })
}
