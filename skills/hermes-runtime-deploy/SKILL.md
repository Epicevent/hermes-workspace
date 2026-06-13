---
name: hermes-runtime-deploy
description: Use when developing Hermes Workspace and preparing or verifying a Hermes runtime image deployment through dev-hermess, dev-hermes-img, oc20 canary, or customer promotion. This deployment is runtime product/wrapper image rollout, not installing or updating opsctl.
---

# Hermes Runtime Deploy

This skill does not define a second deployment procedure. The source of truth is the installed
`agent-runtime-ops` skill and its `Image Rollout` runbook on the operating server.

## Required Source

Use the existing operating MCP first:

```text
agent-runtime-ops
```

The project Cursor MCP config points that tool at:

```bash
ssh svcops /usr/local/bin/agent-runtime-ops-mcp
```

If MCP is unavailable, read the installed runbook directly:

```bash
ssh svcops "sed -n '/^## Image Rollout/,/^## /p' /home/svcops/.codex/skills/agent-runtime-ops/references/runbooks.md"
```

Do not copy the runbook into this repository. If the procedure is wrong or incomplete, update
`agent-runtime-ops` and deploy that approved repo update first.

## Runtime Deployment Shape

Use this route:

```text
dev-hermess source check
-> fast Hermes runtime product image
-> fast Hermes wrapper image
-> dev-hermes-img image-mode validation
-> oc20 customer canary
-> image-promote from oc20 to explicit customer targets
```

Rules:

- `dev-hermess` is source mode.
- `dev-hermes-img` is image mode with `runtime_class=customer`; use `image-canary`, not
  `image-dev-apply`, for that target.
- `dev-hermes-img` must not have a source mount.
- `dev-hermes-img` must not be an `image-promote` source or target.
- `oc20` is the customer canary and the valid promotion source after it passes checks.
- Use digest-pinned wrapper/product images only.
- Do not use release-state rollout commands for this path.

## Verification Gate

Before promoting beyond `oc20`, verify with the existing MCP tools or equivalent `opsctl` commands:

```text
rollout_image_plan
rollout_image_canary target=dev-hermes-img
target_check target=dev-hermes-img
projection_verify_target target=dev-hermes-img live=true
checklist_pack target=dev-hermes-img pack=hermes-runtime gemini_chat_smoke=true
rollout_image_canary target=oc20
target_check target=oc20
projection_verify_target target=oc20 live=true
checklist_pack target=oc20 pack=hermes-runtime gemini_chat_smoke=true
rollout_image_promote from_target=oc20 targets=<explicit customer list>
```

## Reporting

Report:

- product digest
- wrapper digest
- `dev-hermes-img` check result
- `oc20` check result
- promotion source and explicit targets
- whether Gemini chat smoke ran
- `secret_value_printed=no`
