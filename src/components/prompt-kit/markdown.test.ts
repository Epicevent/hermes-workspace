import { describe, expect, it } from 'vitest'

import { rewriteLocalMediaSources } from './markdown'

describe('rewriteLocalMediaSources', () => {
  it('rewrites markdown image MEDIA tokens that point to local files', () => {
    expect(
      rewriteLocalMediaSources('![cat](MEDIA:/Users/test/.hermes/tmp/cat.png)'),
    ).toBe('![cat](/api/media?path=%2FUsers%2Ftest%2F.hermes%2Ftmp%2Fcat.png)')
  })

  it('rewrites html image MEDIA tokens that point to local files without corrupting quotes', () => {
    expect(
      rewriteLocalMediaSources('<img src="MEDIA:/tmp/cat.png" alt="cat" />'),
    ).toBe('<img src="/api/media?path=%2Ftmp%2Fcat.png" alt="cat" />')
  })

  it('rewrites a standard markdown image that points into the Workspace root', () => {
    expect(
      rewriteLocalMediaSources(
        '![OC20 LIVE](/workspace/codex_oc20_image_verify.png)',
      ),
    ).toBe(
      '![OC20 LIVE](/api/media?path=%2Fworkspace%2Fcodex_oc20_image_verify.png)',
    )
  })

  it('rewrites a standard html image that points into the Workspace root', () => {
    expect(
      rewriteLocalMediaSources(
        '<img src="/workspace/generated.png" alt="generated" />',
      ),
    ).toBe(
      '<img src="/api/media?path=%2Fworkspace%2Fgenerated.png" alt="generated" />',
    )
  })

  it('does not reinterpret normal site-root image URLs as local files', () => {
    const content =
      '![logo](/assets/logo.png) <img src="/api/media?path=%2Ftmp%2Fa.png" />'
    expect(rewriteLocalMediaSources(content)).toBe(content)
  })

  it('leaves remote MEDIA URLs untouched', () => {
    expect(
      rewriteLocalMediaSources('![cat](MEDIA:https://example.com/cat.png)'),
    ).toBe('![cat](MEDIA:https://example.com/cat.png)')
    expect(
      rewriteLocalMediaSources(
        '<img src="MEDIA:https://example.com/cat.png" />',
      ),
    ).toBe('<img src="MEDIA:https://example.com/cat.png" />')
  })

  it('handles multiple local MEDIA tokens in one message', () => {
    const input =
      'Here is one: ![a](MEDIA:/tmp/a.png) and two: <img src="MEDIA:/tmp/b.png" />'
    const result = rewriteLocalMediaSources(input)
    expect(result).toContain('/api/media?path=%2Ftmp%2Fa.png')
    expect(result).toContain('/api/media?path=%2Ftmp%2Fb.png')
  })

  it('passes through content without MEDIA tokens unchanged', () => {
    const plain = 'Hello world, no images here.'
    expect(rewriteLocalMediaSources(plain)).toBe(plain)
  })

  it('renders a bare MEDIA image token as a markdown image (the reported case)', () => {
    // The agent emits a standalone MEDIA:/workspace/... token in prose; it used
    // to show as literal text.
    expect(
      rewriteLocalMediaSources(
        '아래 이미지를 참고하세요.\n\nMEDIA:/workspace/process_steps.png',
      ),
    ).toBe(
      '아래 이미지를 참고하세요.\n\n![process_steps.png](/api/media?path=%2Fworkspace%2Fprocess_steps.png)',
    )
  })

  it('renders a bare non-image MEDIA token as a link, not an image', () => {
    expect(rewriteLocalMediaSources('MEDIA:/workspace/report.pdf')).toBe(
      '[report.pdf](/api/media?path=%2Fworkspace%2Freport.pdf)',
    )
  })

  it('keeps trailing sentence punctuation outside the rewritten token', () => {
    expect(rewriteLocalMediaSources('See MEDIA:/workspace/a.png.')).toBe(
      'See ![a.png](/api/media?path=%2Fworkspace%2Fa.png).',
    )
  })

  it('does not double-rewrite MEDIA already inside image markup', () => {
    // The markup pass handles these; the bare pass must not touch the produced
    // /api/media URL.
    const result = rewriteLocalMediaSources('![a](MEDIA:/tmp/a.png)')
    expect(result).toBe('![a](/api/media?path=%2Ftmp%2Fa.png)')
    expect(result).not.toContain('![a.png]')
  })

  it('leaves a bare remote MEDIA token untouched', () => {
    const input = 'MEDIA:https://example.com/cat.png'
    expect(rewriteLocalMediaSources(input)).toBe(input)
  })
})
