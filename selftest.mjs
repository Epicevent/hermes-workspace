/**
 * `node selftest.mjs --json` — product-attested customer-truth self-check for the
 * hermes-runtime image (hermes-jitech#9).
 *
 * The runtime attests to its own customer truth from INSIDE the container instead
 * of the operator tool (agent-runtime-ops) reach-in-probing it from outside. The
 * image declares this command via the `com.epicevent.agent-runtime.selftest.*`
 * labels (Dockerfile.runtime); opsctl trusts the label through the root-approved
 * image digest, runs it with `docker exec`, parses the single JSON line printed
 * on stdout, and gates rollouts on the `required` checks.
 *
 * Why no HTTP auth plumbing: with a workspace password set there is deliberately
 * no localhost bypass for /api/workspace|files|hermes-config (auth-middleware
 * cookie gate). So this selftest only touches the auth-free health surfaces the
 * image HEALTHCHECK already uses (:3000/, :8642/health, :9119/api/status), the
 * dashboard's public read-only /api/model/info, and the filesystem directly.
 *
 * Required checks:
 *   - selftest_service_user_ok     runs as the `hermes` service user (drops from
 *                                  root via initgroups, so NAS group membership
 *                                  is part of the proven truth)
 *   - selftest_workspace_http_ok   GET :3000/ answers (workspace node server)
 *   - selftest_gateway_health_ok   GET :8642/health answers (hermes gateway)
 *   - selftest_dashboard_status_ok GET :9119/api/status answers (dashboard)
 *   - selftest_model_info_ok       GET :9119/api/model/info resolves a non-empty
 *                                  model (public read-only path; no completion,
 *                                  no credits burned)
 *   - selftest_config_ok           $HERMES_HOME/config.yaml parses, and when it
 *                                  declares a model it matches the live resolved
 *                                  model (the disk-vs-live drift check, moved
 *                                  inside the product)
 *   - selftest_nas_access_ok       $HERMES_WORKSPACE_DIR/nas_docs is listable as
 *                                  the service user
 *
 * A real chat completion is deliberately NOT required: the hermes chat path runs
 * a full agent turn (minutes, burns provider credits), which is why the operator
 * chat smoke has always been opt-in. /api/model/info covers the configured-model
 * truth without spending anything.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export const CONTRACT_NAME = 'hermes-selftest-v1'
export const REQUIRED_CHECKS = [
  'selftest_service_user_ok',
  'selftest_workspace_http_ok',
  'selftest_gateway_health_ok',
  'selftest_dashboard_status_ok',
  'selftest_model_info_ok',
  'selftest_config_ok',
  'selftest_nas_access_ok',
]

const SERVICE_USER = 'hermes'

/** Never let a token/secret-looking blob reach the JSON detail field. */
export function redact(value) {
  const text = value instanceof Error ? value.message : String(value)
  const [firstLine = ''] = text
    .replace(/[A-Za-z0-9._-]{24,}/g, '<redacted>')
    .split('\n', 1)
  return firstLine.slice(0, 200)
}

function required(name, ok, detail) {
  return { name, ok, detail, severity: 'required' }
}

export function resolveHermesHome(env) {
  return (
    env.HERMES_HOME ||
    env.CLAUDE_HOME ||
    join(env.HOME || '/opt/data', '.hermes')
  )
}

/**
 * The disk-vs-live model comparison (previously the operator's reach-in
 * /api/hermes-config check). config.yaml `model:` is either a plain string or
 * `{ default|name, provider, ... }` — the same shapes /api/model/info resolves.
 * An empty declaration is fine (the live fallback is authoritative then).
 */
export function evaluateConfigAgainstLive(config, liveModel) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, detail: 'config.yaml is not a mapping' }
  }
  const modelCfg = config.model
  let declared = ''
  if (typeof modelCfg === 'string') {
    declared = modelCfg.trim()
  } else if (modelCfg && typeof modelCfg === 'object') {
    declared = String(modelCfg.default ?? modelCfg.name ?? '').trim()
  }
  if (!declared) {
    return {
      ok: true,
      detail: `no model declared on disk (live=${liveModel || 'none'})`,
    }
  }
  if (liveModel && declared !== liveModel) {
    return {
      ok: false,
      detail: `disk/live model drift: disk=${declared} live=${liveModel}`,
    }
  }
  return {
    ok: true,
    detail: `model=${declared}${liveModel ? ' (matches live)' : ' (live unresolved)'}`,
  }
}

function dropToServiceUser(proc) {
  try {
    if (typeof proc.getuid !== 'function') {
      return required(
        'selftest_service_user_ok',
        false,
        'no uid support on this platform',
      )
    }
    if (proc.getuid() !== 0) {
      return required(
        'selftest_service_user_ok',
        true,
        `already uid=${proc.getuid()}`,
      )
    }
    // initgroups first (needs root), so the NAS data group from /etc/group is
    // part of the credentials this selftest proves.
    proc.initgroups(SERVICE_USER, SERVICE_USER)
    proc.setgid(SERVICE_USER)
    proc.setuid(SERVICE_USER)
    return required(
      'selftest_service_user_ok',
      true,
      `dropped to ${SERVICE_USER} uid=${proc.getuid()}`,
    )
  } catch (err) {
    return required('selftest_service_user_ok', false, redact(err))
  }
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function checkHttp(fetchImpl, name, url, timeoutMs) {
  try {
    const res = await fetchWithTimeout(fetchImpl, url, timeoutMs)
    return required(name, res.ok, `${url} status=${res.status}`)
  } catch (err) {
    return required(name, false, `${url} ${redact(err)}`)
  }
}

async function readModelInfo(fetchImpl, dashboardOrigin, timeoutMs) {
  const url = `${dashboardOrigin}/api/model/info`
  const res = await fetchWithTimeout(fetchImpl, url, timeoutMs)
  if (!res.ok) {
    return {
      check: required(
        'selftest_model_info_ok',
        false,
        `${url} status=${res.status}`,
      ),
      model: '',
    }
  }
  const info = await res.json()
  const model = typeof info.model === 'string' ? info.model.trim() : ''
  const provider =
    typeof info.provider === 'string' && info.provider ? info.provider : '?'
  if (!model) {
    return {
      check: required(
        'selftest_model_info_ok',
        false,
        'no model resolved by the live agent',
      ),
      model: '',
    }
  }
  return {
    check: required(
      'selftest_model_info_ok',
      true,
      `provider=${provider} model=${model}`,
    ),
    model,
  }
}

async function checkConfig(env, liveModel) {
  const configPath = join(resolveHermesHome(env), 'config.yaml')
  let text
  try {
    text = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    return required('selftest_config_ok', false, `${configPath} ${redact(err)}`)
  }
  let parsed
  try {
    const { default: YAML } = await import('yaml')
    parsed = YAML.parse(text)
  } catch (err) {
    return required(
      'selftest_config_ok',
      false,
      `${configPath} parse: ${redact(err)}`,
    )
  }
  const verdict = evaluateConfigAgainstLive(parsed, liveModel)
  return required(
    'selftest_config_ok',
    verdict.ok,
    `${configPath} ${verdict.detail}`,
  )
}

async function checkNasAccess(env) {
  const dir = join(env.HERMES_WORKSPACE_DIR || '/workspace', 'nas_docs')
  try {
    const entries = await fs.readdir(dir)
    return required(
      'selftest_nas_access_ok',
      true,
      `nas dir=${dir} entries=${entries.length}`,
    )
  } catch (err) {
    return required(
      'selftest_nas_access_ok',
      false,
      `nas dir=${dir} ${redact(err)}`,
    )
  }
}

export async function runSelftest(opts = {}) {
  const start = Date.now()
  const env = opts.env || process.env
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const proc = opts.processImpl || process
  const timeoutMs =
    opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 10_000

  const workspaceOrigin = `http://127.0.0.1:${env.PORT || '3000'}`
  const gatewayOrigin = env.HERMES_API_URL || 'http://127.0.0.1:8642'
  const dashboardOrigin = env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:9119'

  const checks = []
  checks.push(
    opts.skipPrivilegeDrop
      ? required('selftest_service_user_ok', true, 'drop skipped (test mode)')
      : dropToServiceUser(proc),
  )
  checks.push(
    await checkHttp(
      fetchImpl,
      'selftest_workspace_http_ok',
      `${workspaceOrigin}/`,
      timeoutMs,
    ),
  )
  checks.push(
    await checkHttp(
      fetchImpl,
      'selftest_gateway_health_ok',
      `${gatewayOrigin}/health`,
      timeoutMs,
    ),
  )
  checks.push(
    await checkHttp(
      fetchImpl,
      'selftest_dashboard_status_ok',
      `${dashboardOrigin}/api/status`,
      timeoutMs,
    ),
  )

  let liveModel = ''
  try {
    const { check, model } = await readModelInfo(
      fetchImpl,
      dashboardOrigin,
      timeoutMs,
    )
    checks.push(check)
    liveModel = model
  } catch (err) {
    checks.push(required('selftest_model_info_ok', false, redact(err)))
  }

  checks.push(await checkConfig(env, liveModel))
  checks.push(await checkNasAccess(env))

  const ok = checks.filter((c) => c.severity === 'required').every((c) => c.ok)
  return {
    ok,
    contract: CONTRACT_NAME,
    ts: start,
    durationMs: Date.now() - start,
    checks,
    required_checks: [...REQUIRED_CHECKS],
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())
if (isMain) {
  // Prints ONLY the JSON result on stdout (opsctl parses it); exit 0 iff every
  // required check passed.
  runSelftest().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exit(result.ok ? 0 : 1)
    },
    (err) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, contract: CONTRACT_NAME, error: redact(err) })}\n`,
      )
      process.exit(1)
    },
  )
}
