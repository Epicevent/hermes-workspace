import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAllowedMediaPath } from './media'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('media path policy', () => {
  it('serves artifacts from an explicit Workspace state directory', () => {
    vi.stubEnv('HERMES_WORKSPACE_STATE_DIR', '/srv/hermes-state')

    expect(
      isAllowedMediaPath(
        resolve('/srv/hermes-state/artifacts/chat-uploads/abc.png'),
      ),
    ).toBe(true)
    expect(
      isAllowedMediaPath(resolve('/srv/hermes-state-neighbor/abc.png')),
    ).toBe(false)
  })
})
