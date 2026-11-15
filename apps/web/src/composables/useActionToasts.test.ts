import { afterEach, describe, expect, it, vi } from 'vitest'
import { useActionToasts } from './useActionToasts'

afterEach(() => {
  vi.useRealTimers()
})

describe('useActionToasts', () => {
  it('adds a toast and removes it after the lifetime', () => {
    vi.useFakeTimers()
    const { toasts, notify } = useActionToasts()

    notify('已暂停实例「demo」', 'success')

    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ kind: 'success', message: '已暂停实例「demo」' })

    vi.advanceTimersByTime(8_000)
    expect(toasts.value).toHaveLength(0)
  })

  it('keeps failure toasts distinguishable and supports manual dismiss', () => {
    vi.useFakeTimers()
    const { toasts, notify, dismiss } = useActionToasts()

    notify('暂停实例失败：HTTP 500', 'error')
    notify('已重启实例「demo」', 'success')

    expect(toasts.value.map((toast) => toast.kind)).toEqual(['error', 'success'])

    dismiss(toasts.value[0]?.id ?? '')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.kind).toBe('success')
  })
})
