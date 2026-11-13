import { describe, expect, it } from 'vitest'
import { tokenMatches } from './token-store.js'

describe('tokenMatches', () => {
  it('compares valid same-length tokens', () => {
    expect(tokenMatches('a'.repeat(64), 'a'.repeat(64))).toBe(true)
    expect(tokenMatches('a'.repeat(64), 'b'.repeat(64))).toBe(false)
  })

  it('rejects different-length tokens without timingSafeEqual throwing', () => {
    expect(tokenMatches('short', 'a'.repeat(64))).toBe(false)
  })
})
