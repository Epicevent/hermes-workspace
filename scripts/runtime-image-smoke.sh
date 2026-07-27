#!/usr/bin/env bash
set -euo pipefail

image_ref="${1:?usage: runtime-image-smoke.sh IMAGE_REF}"

workspace_dir="$(mktemp -d)"
data_dir="$(mktemp -d)"
mkdir -p "$workspace_dir/nas_docs"
printf 'runtime smoke\n' > "$workspace_dir/nas_docs/README.txt"
data_gid="$(stat -c %g "$workspace_dir")"
runtime_uid="$(stat -c %u "$data_dir")"
runtime_gid="$(stat -c %g "$data_dir")"
chmod 0750 "$workspace_dir" "$workspace_dir/nas_docs" "$data_dir"
chmod 0640 "$workspace_dir/nas_docs/README.txt"

cid="$(docker run -d \
  -p 127.0.0.1:3000:3000 \
  -v "$data_dir:/opt/data" \
  -v "$workspace_dir:/workspace" \
  -e API_SERVER_KEY=ci-smoke-api-server-key \
  -e HERMES_API_TOKEN=ci-smoke-api-server-key \
  -e HERMES_UID="$runtime_uid" \
  -e HERMES_GID="$runtime_gid" \
  -e OPENCLAW_NAS_DATA_GID="$data_gid" \
  -e HERMES_ALLOW_INSECURE_REMOTE=1 \
  "$image_ref")"
trap 'docker logs "$cid" || true; docker rm -f "$cid" || true; sudo rm -rf "$workspace_dir" "$data_dir"' EXIT

for _ in $(seq 1 240); do
  status="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$cid")"
  case "$status" in
    exited*)
      echo "Runtime container exited before becoming healthy: $status"
      exit 1
      ;;
  esac

  if curl -fsS http://127.0.0.1:3000/ >/dev/null \
    && docker exec "$cid" curl -fsS http://127.0.0.1:8642/health >/dev/null \
    && docker exec "$cid" curl -fsS http://127.0.0.1:9119/api/status >/dev/null; then
    if docker exec "$cid" test -e /etc/s6-overlay/s6-rc.d/legacy-cont-init; then
      docker exec "$cid" test -e /etc/s6-overlay/s6-rc.d/hermes-workspace-server/dependencies.d/legacy-cont-init
    else
      echo "legacy-cont-init not present in base image; dependency check skipped"
    fi
    docker exec "$cid" sh -lc '
      node_pid="$(pgrep -f "node .*server-entry[.]js" | head -n1)"
      test -n "$node_pid"

      uid="$(awk "/^Uid:/ {print \$2}" /proc/"$node_pid"/status)"
      gid="$(awk "/^Gid:/ {print \$2}" /proc/"$node_pid"/status)"
      groups="$(awk "/^Groups:/ {for (i=2; i<=NF; i++) print \$i}" /proc/"$node_pid"/status)"
      test "$uid:$gid" != "10000:10000"
      printf "%s\n" "$groups" | grep -Fx "$OPENCLAW_NAS_DATA_GID" >/dev/null

      ps -o user=,group=,uid=,gid=,args= -p "$node_pid"
    '
    docker exec -i "$cid" node <<'NODE'
const http = require('http');

function getJson(path) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:3000${path}`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch (error) {
          reject(new Error(`${path} returned non-JSON status=${response.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        resolve({ status: response.statusCode, json });
      });
    });
    request.setTimeout(2000, () => request.destroy(new Error(`${path} timed out`)));
    request.on('error', reject);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const workspace = await getJson('/api/workspace');
  assert(workspace.status === 200, `/api/workspace status=${workspace.status}`);
  assert(workspace.json.isValid === true, '/api/workspace isValid must be true');
  assert(workspace.json.path === '/workspace', `/api/workspace path=${workspace.json.path}`);
  assert(workspace.json.source === 'env', `/api/workspace source=${workspace.json.source}`);

  const rootFiles = await getJson('/api/files?action=list');
  assert(rootFiles.status === 200, `/api/files?action=list status=${rootFiles.status}`);
  assert(!rootFiles.json.error, `/api/files?action=list error=${rootFiles.json.error}`);
  assert(Array.isArray(rootFiles.json.entries), '/api/files?action=list entries must be an array');

  const nasFiles = await getJson('/api/files?path=nas_docs');
  assert(nasFiles.status === 200, `/api/files?path=nas_docs status=${nasFiles.status}`);
  assert(nasFiles.json.root === 'nas_docs', `/api/files?path=nas_docs root=${nasFiles.json.root}`);
  assert(!nasFiles.json.error, `/api/files?path=nas_docs error=${nasFiles.json.error}`);
  assert(Array.isArray(nasFiles.json.entries), '/api/files?path=nas_docs entries must be an array');
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
    # The workspace layer must retain the pinned Hermes base image's
    # content-free usage ledger collector seam. Exercise both the static
    # coverage contract and the read-only export against the live runtime
    # database so a UI-only healthy image cannot hide a missing producer CLI.
    usage_coverage="$(docker exec "$cid" hermes usage-receipts coverage --json)"
    printf '%s' "$usage_coverage" | docker exec -i "$cid" node -e '
      let raw = "";
      process.stdin.on("data", (d) => { raw += d; });
      process.stdin.on("end", () => {
        const result = JSON.parse(raw);
        const expected = ["schema", "productFamily", "manifestDigest", "coverageStatus", "surfaces"].sort();
        if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected)) {
          console.error(`usage coverage fields mismatch: ${Object.keys(result)}`); process.exit(1);
        }
        if (result.schema !== "jitech-provider-usage-coverage/v1") {
          console.error(`usage coverage schema=${result.schema}`); process.exit(1);
        }
        if (result.productFamily !== "hermes" || !Array.isArray(result.surfaces) || result.surfaces.length === 0) {
          console.error("usage coverage must identify Hermes and enumerate surfaces"); process.exit(1);
        }
      });
    '

    usage_export="$(docker exec "$cid" hermes usage-receipts export --after 0 --limit 1)"
    printf '%s' "$usage_export" | docker exec -i "$cid" node -e '
      let raw = "";
      process.stdin.on("data", (d) => { raw += d; });
      process.stdin.on("end", () => {
        const result = JSON.parse(raw);
        const expected = ["schema", "after", "nextCursor", "highWatermark", "count", "hasMore", "receipts", "coverageManifests"].sort();
        if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected)) {
          console.error(`usage export fields mismatch: ${Object.keys(result)}`); process.exit(1);
        }
        if (result.schema !== "jitech-provider-usage-export/v1" || result.after !== 0) {
          console.error(`usage export identity mismatch: schema=${result.schema} after=${result.after}`); process.exit(1);
        }
        if (!Array.isArray(result.receipts) || !Array.isArray(result.coverageManifests) || result.count !== result.receipts.length) {
          console.error("usage export arrays/count mismatch"); process.exit(1);
        }
        if (!Number.isInteger(result.nextCursor) || !Number.isInteger(result.highWatermark) || typeof result.hasMore !== "boolean") {
          console.error("usage export cursor shape mismatch"); process.exit(1);
        }
      });
    ' || { echo "provider usage export contract missing from runtime image"; exit 1; }

    # Selftest contract wiring (hermes-jitech#9): the label must name a command
    # that actually runs in the image and prints the contract JSON. The smoke
    # env has no model/config, so we assert wiring + shape + the checks the
    # smoke env CAN satisfy — not ok=true.
    label_cmd="$(docker inspect --format '{{index .Config.Labels "com.epicevent.agent-runtime.selftest.command"}}' "$image_ref")"
    if [ "$label_cmd" != "node /opt/hermes-workspace/selftest.mjs --json" ]; then
      echo "selftest label command mismatch: '$label_cmd'"
      exit 1
    fi
    selftest_out="$(docker exec "$cid" $label_cmd || true)"
    printf '%s' "$selftest_out" | docker exec -i "$cid" node -e '
      let raw = "";
      process.stdin.on("data", (d) => { raw += d; });
      process.stdin.on("end", () => {
        const result = JSON.parse(raw);
        const names = result.checks.map((c) => c.name);
        const expected = [
          "selftest_service_user_ok",
          "selftest_workspace_http_ok",
          "selftest_gateway_health_ok",
          "selftest_dashboard_status_ok",
          "selftest_model_info_ok",
          "selftest_config_ok",
          "selftest_nas_access_ok",
        ];
        for (const name of expected) {
          if (!names.includes(name)) { console.error(`missing check ${name}`); process.exit(1); }
        }
        if (JSON.stringify(result.required_checks) !== JSON.stringify(expected)) {
          console.error("required_checks mismatch"); process.exit(1);
        }
        for (const name of ["selftest_service_user_ok", "selftest_workspace_http_ok", "selftest_gateway_health_ok", "selftest_dashboard_status_ok", "selftest_nas_access_ok"]) {
          const check = result.checks.find((c) => c.name === name);
          if (!check.ok) { console.error(`${name} failed in smoke: ${check.detail}`); process.exit(1); }
        }
        console.error("selftest wiring ok (model/config checks not asserted in smoke env)");
      });
    ' || { echo "selftest contract wiring failed"; exit 1; }

    echo "Runtime image served workspace, gateway, dashboard, workspace APIs, files APIs, provider usage export, and selftest contract successfully"
    exit 0
  fi

  sleep 2
done

echo "Runtime image contract did not become ready before timeout"
exit 1
