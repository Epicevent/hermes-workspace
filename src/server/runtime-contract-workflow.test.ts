import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

describe('runtime contract workflow inputs', () => {
  it('runs for every pull request to main', () => {
    const source = readFileSync(
      resolve(process.cwd(), '.github/workflows/runtime-contract.yml'),
      'utf8',
    )
    const workflow = parse(source) as {
      on?: { pull_request?: { branches?: Array<string>; paths?: unknown } }
    }

    expect(workflow.on?.pull_request?.branches).toEqual(['main'])
    expect(workflow.on?.pull_request).not.toHaveProperty('paths')
  })
})
