import { ref } from 'vue'
import { apiRequest } from '../api/client'

/**
 * 文件上传成功后返回的文件信息。
 * relativePath 相对 Story 所在项目根目录，CodeBuddy 服务以该目录为 cwd，
 * 因此可直接写进提示词供 agent 读取。
 */
export interface UploadedAsset {
  /** 服务端生成的唯一文件名（UUID + 扩展名） */
  name: string
  /** 用户选择的原始文件名，用于提示词中展示 */
  originalName: string
  /** 文件的 MIME 类型，用于区分图片与普通文件 */
  mimeType: string
  /** 相对项目根目录的路径，如 `.docs/<storyId>/<uuid>.pdf` */
  relativePath: string
  /** 落盘绝对路径，仅用于展示/排查 */
  absolutePath: string
}

/**
 * Story 文件上传封装。
 * 把文件 POST 到 `/api/v1/stories/:storyId/uploads`，服务端写入
 * `<项目根>/.docs/<storyId>/` 目录，返回可在提示词中引用的相对路径。
 *
 * @returns 上传中标记、错误信息与上传方法
 */
export function useStoryUpload() {
  /** 是否有上传请求进行中 */
  const uploading = ref(false)
  /** 最近一次上传失败信息；成功时清空 */
  const error = ref('')

  /**
   * 上传一个文件到指定 Story。
   * @param storyId 目标 Story 标识
   * @param file 用户选择的文件
   * @returns 上传成功的文件信息；失败抛出错误
   */
  async function uploadImage(storyId: string, file: File): Promise<UploadedAsset> {
    uploading.value = true
    error.value = ''
    try {
      const form = new FormData()
      form.append('file', file)
      return await apiRequest<UploadedAsset>(
        `/api/v1/stories/${encodeURIComponent(storyId)}/uploads`,
        { method: 'POST', body: form },
      )
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '文件上传失败。'
      throw cause
    } finally {
      uploading.value = false
    }
  }

  return { uploading, error, uploadImage }
}
