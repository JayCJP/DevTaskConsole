import { describe, expect, it } from 'vitest'
import { extractJob, extractJobList } from './codebuddy-api.js'

describe('extractJobList', () => {
  it('unwraps the documented { data: { jobs } } envelope', () => {
    const job = { id: 'j1', name: 'Round', cwd: 'D:/w', state: 'working', status: 'busy' }
    expect(extractJobList({ data: { jobs: [job] } })).toEqual([job])
  })

  it('accepts a bare array and a { jobs } object', () => {
    expect(extractJobList([{ id: 'j1' }])).toHaveLength(1)
    expect(extractJobList({ jobs: [{ id: 'j1' }] })).toHaveLength(1)
    expect(extractJobList({ data: [{ id: 'j1' }] })).toHaveLength(1)
  })

  it('returns undefined for an unrecognised payload instead of an empty list', () => {
    // 无法识别时必须让上层报 502，而不是静默显示「没有实例」
    expect(extractJobList({ data: { unexpected: true } })).toBeUndefined()
    expect(extractJobList('nope')).toBeUndefined()
    expect(extractJobList(null)).toBeUndefined()
  })
})

describe('extractJob', () => {
  it('unwraps { data: AgentJob }', () => {
    expect(extractJob({ data: { id: 'j1', state: 'working' } })).toEqual({ id: 'j1', state: 'working' })
  })

  it('unwraps { data: { job: AgentJob } } used by the detail endpoint', () => {
    expect(extractJob({ data: { job: { id: 'j1', state: 'done' } } })).toEqual({ id: 'j1', state: 'done' })
  })

  it('falls back to the payload itself when there is no envelope', () => {
    expect(extractJob({ id: 'j1' })).toEqual({ id: 'j1' })
  })

  it('rejects non-object payloads', () => {
    expect(extractJob([])).toBeUndefined()
    expect(extractJob('nope')).toBeUndefined()
  })
})
