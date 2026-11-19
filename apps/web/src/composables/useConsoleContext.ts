import { inject, provide, type InjectionKey } from 'vue'
import type { useConsole } from './useConsole'

/** useConsole 返回值的类型：壳层提供、各页面注入的共享上下文 */
export type ConsoleContext = ReturnType<typeof useConsole>

/**
 * 共享上下文的注入键。
 * 用 Symbol 作为 key，避免与 vue-router 等库的注入值冲突。
 */
export const consoleContextKey: InjectionKey<ConsoleContext> = Symbol('devtask-console-context')

/**
 * 在壳层提供共享上下文。
 * @param ctx useConsole() 的返回值
 */
export function provideConsoleContext(ctx: ConsoleContext): void {
  provide(consoleContextKey, ctx)
}

/**
 * 在页面中注入共享上下文。
 * 页面由 ConsoleShell 包裹，必定存在该上下文；缺失属于编程错误，直接抛出便于定位。
 * @returns 共享的控制台上下文
 */
export function useConsoleContext(): ConsoleContext {
  const ctx = inject(consoleContextKey)
  if (!ctx) throw new Error('控制台上下文缺失：页面必须渲染在 ConsoleShell 内')
  return ctx
}
