import { defineStore } from 'pinia'
import { ref } from 'vue'
import { snapshotSchema, type Snapshot } from '@devtask/shared'
import { apiRequest } from '../api/client'

export const useConsoleStore = defineStore('console', () => {
  const snapshot = ref<Snapshot | null>(null)
  const loading = ref(false)
  const error = ref('')
  const refreshedAt = ref('')

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const payload: unknown = await apiRequest('/api/v1/snapshot')
      snapshot.value = snapshotSchema.parse(payload)
      refreshedAt.value = new Date().toISOString()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Snapshot request failed.'
      if (snapshot.value) {
        error.value = `${error.value} Showing the last successful snapshot.`
      }
    } finally {
      loading.value = false
    }
  }

  return { snapshot, loading, error, refreshedAt, refresh }
})
