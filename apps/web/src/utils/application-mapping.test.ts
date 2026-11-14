import { defaultDevOpsGroup, type ApplicationMapping } from '@devtask/shared'
import { describe, expect, it } from 'vitest'
import { buildMappingRows, hasMappingChanges } from './application-mapping'

describe('源系统映射列表', () => {
  it('始终只有一份默认规则，同名的仓库不产生数据行', () => {
    const rows = buildMappingRows([])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.isDefault).toBe(true)
    expect(rows[0]?.cells.every((cell) => !cell.changed)).toBe(true)

    const equivalent: ApplicationMapping[] = [
      { repoName: 'same-repo', devopsApp: 'same-repo', devopsGroup: defaultDevOpsGroup },
    ]
    expect(buildMappingRows(equivalent)).toHaveLength(1)
  })

  it('只突出变动字段，未变动字段折叠为沿用默认', () => {
    const rows = buildMappingRows([
      { repoName: 'web-repo', gitlabProjectId: 42, devopsApp: 'ConsoleWeb' },
    ])
    const cells = rows[1]?.cells ?? []

    expect(rows).toHaveLength(2)
    expect(cells.map((cell) => cell.changed)).toEqual([true, true, false])
    expect(cells[0]?.value).toBe('#42')
    expect(cells[1]?.value).toBe('ConsoleWeb')
    expect(cells[2]?.value).toBe('沿用默认')
  })

  it('仅分组不同也算差异映射，不会被同名规则吞掉', () => {
    const mapping: ApplicationMapping = { repoName: 'api', devopsApp: 'api', devopsGroup: 'AnotherGroup' }

    expect(hasMappingChanges(mapping)).toBe(true)
    expect(buildMappingRows([mapping])[1]?.cells[2]).toEqual({
      key: 'devopsGroup',
      value: 'AnotherGroup',
      changed: true,
    })
  })
})
