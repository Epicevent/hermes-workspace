import { describe, expect, it } from 'vitest'

import {
  buildSessionTitleUserPrompt,
  sanitizeSuggestedSessionTitle,
} from './session-title'

describe('sanitizeSuggestedSessionTitle', () => {
  it('returns "" for empty input', () => {
    expect(sanitizeSuggestedSessionTitle('')).toBe('')
    expect(sanitizeSuggestedSessionTitle('   ')).toBe('')
  })

  it('keeps a clean short title unchanged', () => {
    expect(sanitizeSuggestedSessionTitle('Blue sky donut image')).toBe(
      'Blue sky donut image',
    )
  })

  it('takes only the first line', () => {
    expect(
      sanitizeSuggestedSessionTitle('Session title\nExtra reasoning here'),
    ).toBe('Session title')
  })

  it('strips wrapping straight and smart quotes and backticks', () => {
    expect(sanitizeSuggestedSessionTitle('"Deploy plan"')).toBe('Deploy plan')
    expect(sanitizeSuggestedSessionTitle('“회의 요약”')).toBe('회의 요약')
    expect(sanitizeSuggestedSessionTitle('`code review`')).toBe('code review')
  })

  it('drops trailing sentence punctuation', () => {
    expect(sanitizeSuggestedSessionTitle('Fix the bug.')).toBe('Fix the bug')
    expect(sanitizeSuggestedSessionTitle('무엇을 할까?!')).toBe('무엇을 할까')
  })

  it('collapses internal whitespace', () => {
    expect(sanitizeSuggestedSessionTitle('a   b\t c')).toBe('a b c')
  })

  it('caps length at 60 chars', () => {
    const long = 'x'.repeat(80)
    expect(sanitizeSuggestedSessionTitle(long)).toHaveLength(60)
  })

  it('keeps the conversation language (Korean)', () => {
    expect(sanitizeSuggestedSessionTitle('도넛 이미지 생성')).toBe(
      '도넛 이미지 생성',
    )
  })
})

describe('buildSessionTitleUserPrompt', () => {
  it('returns null when there is no usable context', () => {
    expect(buildSessionTitleUserPrompt({})).toBeNull()
    expect(
      buildSessionTitleUserPrompt({
        firstUserMessage: '   ',
        lastMessagePreview: '',
      }),
    ).toBeNull()
  })

  it('includes the first user message when present', () => {
    const prompt = buildSessionTitleUserPrompt({
      firstUserMessage: '도넛 하나 그려줘',
    })
    expect(prompt).toContain('First user message:')
    expect(prompt).toContain('도넛 하나 그려줘')
  })

  it('adds the most recent message when it differs from the first', () => {
    const prompt = buildSessionTitleUserPrompt({
      firstUserMessage: 'hello',
      lastMessagePreview: 'done, saved to /workspace/x.png',
    })
    expect(prompt).toContain('Most recent message:')
    expect(prompt).toContain('/workspace/x.png')
  })

  it('does not duplicate the recent message when identical to the first', () => {
    const prompt =
      buildSessionTitleUserPrompt({
        firstUserMessage: 'same text',
        lastMessagePreview: 'same text',
      }) ?? ''
    expect(prompt).toContain('First user message:')
    expect(prompt).not.toContain('Most recent message:')
  })

  it('truncates an overlong first message', () => {
    const long = 'a'.repeat(2000)
    const prompt = buildSessionTitleUserPrompt({ firstUserMessage: long }) ?? ''
    // First-message cap is 800 chars + an ellipsis marker.
    expect(prompt).toContain('a'.repeat(800))
    expect(prompt).not.toContain('a'.repeat(801))
  })
})
