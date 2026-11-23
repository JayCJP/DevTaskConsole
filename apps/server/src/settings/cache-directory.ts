import { getDataDirectory } from '../security/token-store.js'

/**
 * 解析缓存数据目录：优先使用配置中的 cacheDirectory，为空则回退数据目录。
 *
 * 配置文件固定留在数据目录（见 SettingsStore），因此这里接收已读取的配置对象，
 * 自身不读盘；调用方在 server 启动时用 SettingsStore.getSync() 传入配置，
 * 得到的目录在本次进程内固定——修改 cacheDirectory 后需重启服务生效。
 *
 * @param settings 已读取的配置（cacheDirectory 可缺省）
 * @returns 生效的缓存目录绝对路径
 */
export function resolveCacheDirectory(settings?: { cacheDirectory?: string }): string {
  const configured = settings?.cacheDirectory?.trim()
  if (configured) return configured
  return getDataDirectory()
}
