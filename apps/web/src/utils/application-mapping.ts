import { defaultDevOpsGroup, type ApplicationMapping } from '@devtask/shared'

/** 映射列表单元格：changed 标记该字段是否偏离默认约定 */
export interface MappingCell {
  key: 'gitlab' | 'devopsApp' | 'devopsGroup'
  value: string
  changed: boolean
}

/** 映射列表行：isDefault 表示全站唯一一份默认规则 */
export interface MappingRow {
  key: string
  repoName: string
  isDefault: boolean
  cells: MappingCell[]
}

/** 未变动字段在列表中的统一占位文案 */
const UNCHANGED_LABEL = '沿用默认'

/**
 * 判断一条映射是否真的偏离默认约定。
 * 默认约定：GitLab 按仓库名精确匹配、DevOps 应用名 = 仓库名、分组取 defaultDevOpsGroup。
 * @param mapping 待判断的映射
 * @returns 是否存在任一差异字段
 */
export function hasMappingChanges(mapping: ApplicationMapping): boolean {
  return mapping.gitlabProjectId !== undefined
    || (mapping.devopsApp !== undefined && mapping.devopsApp !== mapping.repoName)
    || (mapping.devopsGroup !== undefined && mapping.devopsGroup !== defaultDevOpsGroup)
}

/**
 * 构造源系统映射列表：首行是全站唯一一份默认规则，其余只保留人工确认的差异映射。
 * 同名仓库不产生数据行；未变动字段折叠为「沿用默认」，只突出变动项，避免列表被默认数据淹没。
 * @param mappings 已保存的差异映射
 * @returns 列表行，至少包含一条默认规则
 */
export function buildMappingRows(mappings: ApplicationMapping[]): MappingRow[] {
  const defaultRow: MappingRow = {
    key: '__default__',
    repoName: '未单独配置的仓库',
    isDefault: true,
    cells: [
      { key: 'gitlab', value: '按仓库名精确匹配', changed: false },
      { key: 'devopsApp', value: '= 仓库名', changed: false },
      { key: 'devopsGroup', value: defaultDevOpsGroup, changed: false },
    ],
  }
  const changedRows = mappings.filter(hasMappingChanges).map((mapping): MappingRow => ({
    key: mapping.repoName,
    repoName: mapping.repoName,
    isDefault: false,
    cells: [
      mapping.gitlabProjectId !== undefined
        ? { key: 'gitlab', value: `#${mapping.gitlabProjectId}`, changed: true }
        : { key: 'gitlab', value: UNCHANGED_LABEL, changed: false },
      mapping.devopsApp !== undefined && mapping.devopsApp !== mapping.repoName
        ? { key: 'devopsApp', value: mapping.devopsApp, changed: true }
        : { key: 'devopsApp', value: UNCHANGED_LABEL, changed: false },
      mapping.devopsGroup !== undefined && mapping.devopsGroup !== defaultDevOpsGroup
        ? { key: 'devopsGroup', value: mapping.devopsGroup, changed: true }
        : { key: 'devopsGroup', value: UNCHANGED_LABEL, changed: false },
    ],
  }))
  return [defaultRow, ...changedRows]
}
