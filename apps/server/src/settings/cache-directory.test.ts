import { describe, expect, it } from 'vitest'
import { getDataDirectory } from '../security/token-store.js'
import { resolveCacheDirectory } from './cache-directory.js'

describe('resolve cache directory', () => {
  it('prefers the configured cache directory', () => {
    expect(resolveCacheDirectory({ cacheDirectory: 'D:\\custom-cache' })).toBe('D:\\custom-cache')
  })

  it('trims the configured cache directory', () => {
    expect(resolveCacheDirectory({ cacheDirectory: '  D:\\custom-cache  ' })).toBe(
      'D:\\custom-cache',
    )
  })

  it('falls back to the data directory when unset or blank', () => {
    expect(resolveCacheDirectory()).toBe(getDataDirectory())
    expect(resolveCacheDirectory({})).toBe(getDataDirectory())
    expect(resolveCacheDirectory({ cacheDirectory: '   ' })).toBe(getDataDirectory())
  })
})
