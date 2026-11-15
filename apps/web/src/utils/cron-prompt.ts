import type { CronMode } from '@devtask/shared'

/** 生成 TAPD 缺陷巡检提示词所需的 Story 上下文 */
export interface CronPromptContext {
  /** 需求中文完整标题 */
  storyTitle: string
  /** TAPD 需求 ID；有子需求时使用逗号拼接 */
  tapdStoryId: string
  /** TAPD 项目 workspace_id 的十进制文本 */
  workspaceId: string
  /** 缺陷处理人 */
  owner: string
  /** 当前工作区固定使用的 Harness Story ID */
  storyId: string
  /** Harness plans 目录，自动修复模式使用绝对路径 */
  plansDir: string
}

/** 只查模式模板：结构来自 tapd-bug-cron/query-prompt-template */
const queryPromptTemplate = `【定时任务：轮询需求「{{STORY_TITLE}}」的关联 Bug（只查不修）】

需求：需求「{{STORY_TITLE}}」（id：{{TAPD_STORY_ID}}）的关联缺陷。

变量约定：
- 需求标题：{{STORY_TITLE}}（中文全称，照抄需求标题，不要改写、不要截断）
- 项目 workspace_id：{{WORKSPACE_ID}}（整数）
- 需求 id：{{TAPD_STORY_ID}}（有子需求时主+子 id 逗号拼接）
- 处理人：{{OWNER}}
- 状态过滤：new（新）| reopened（重新打开）—— 本项目状态枚举里只有这两个参与巡检

口径：需求关联 ∩ 处理人「{{OWNER}}」∩ 状态「new | reopened」。
关联边界只用 get_related_bugs；禁止 workspace 级全量查询；禁止标题关键词比对。

第 1 步（查询缺陷）

【1-1】取关联集合（只调一次）
get_related_bugs(workspace_id={{WORKSPACE_ID}}, options={"story_id": "{{TAPD_STORY_ID}}"})
- workspace_id 必须是整数 {{WORKSPACE_ID}}（传字符串报 must be integer）
- story_id 是字符串字面量键名（带双引号）；参数名蛇形，不要驼峰
- 有子需求时，主需求 + 全部子需求 id 用逗号拼接在同一字符串里传
- 返回 data:[{workspace_id, story_id, bug_id}]，无 count 字段 → N = data.length
- limit / page 被忽略，一次返回全量，不需要翻页
- N = 0 → 直接跳第 3 步，本轮判定 0 条

【1-2】一次批量查询（不要逐条循环调 get_bug）
get_bug(workspace_id={{WORKSPACE_ID}}, options={
  id: "<N 个 bug_id 逗号拼接>",
  current_owner: "{{OWNER}}",
  status: "new|reopened",
  limit: 200,
  fields: "id,title,status,current_owner,created,module,description"
})
- id / current_owner / status 是同一层 AND 条件，三者同时生效，一次调用即可
- id 必须放在 options 里；写顶层会报 additional properties
- limit 必须 >= N（默认 10 会把 data 截断，但 count 仍是真实匹配数，用它对账）
- N 超过 200 时按 100 个一批切片，每批都带 limit:200
- current_owner 填 TAPD 昵称，模糊匹配多人字段（"黄德鹏;蔡杰鹏;" 能被 "蔡杰鹏" 命中）
- fields 必须显式声明，否则 title / description 不返回
- 状态必须传英文 key；传中文会返回 0 条。本项目枚举：new=新 / in_progress=接受处理 / assigned=已分配 / verified=已验证 / postponed=延期 / reopened=重新打开 / resolved=已解决 / rejected=已拒绝。
  查询只认 new 与 reopened，其余状态不参与巡检

【1-3】结果判定
- data 非空 → 这些就是本轮命中的 bug
- data 为空且 count = 0 → 本轮 0 条，进第 3 步
- count > 0 但 data 为空 → limit 不足导致截断，加大 limit 重查，不要当成 0 条

硬约束：
❌ 禁止 get_bug(status="new|reopened") 不带 id 的 workspace 级全量拉取
❌ 禁止 get_bug({"story_id": ...}) —— 该字段恒为空，永远查不到
❌ 禁止按标题关键词（「客服」「会话」「忙碌」等）判定相关性或做兜底检索
❌ get_related_bugs 返回空数组时，直接判定本轮 0 条，不要改走搜索或 workspace 级兜底
✅ 归属只认「需求关联 + 处理人 + 状态」三者，不靠标题猜测
❌ 本任务只做查询与报告：不修改任何代码、不写 TAPD 评论、不改缺陷状态、
   不创建 todo list 文件、不创建 Agent 或 Team、不做根因分析

第 2 步：无 bug 时
若本轮 0 条：输出「本轮无符合条件的新 bug」+ 关联数 N + 状态命中数，然后结束。
不创建任何文件，不发起任何后续动作。

第 3 步（输出报告）
无论结果多少条，都必须在该轮输出中报告：
- 关联数 N（get_related_bugs 返回条数）
- 状态命中数、最终命中数（三者交集）
- 命中清单：id / 标题 / 状态 / 处理人 / 模块 / 创建时间 /
  链接 https://www.tapd.cn/{{WORKSPACE_ID}}/bugtrace/bugs/view/{id} / 判定理由
- 若有待解决但处理人不是「{{OWNER}}」的缺陷，单独列出并注明「处理人不匹配，不纳入」
- reopened 的缺陷单独成组标注，并注明「已重新打开，存在上次未修好的可能，转自动修复模式时会读取评论再分析」
  （只查模式自己不读评论，只提示）
- 本轮有命中时注明「如需修复请告知，本任务不会自动处理」`

/** 自动修复模板：结构来自 tapd-bug-cron/fix-prompt-template */
const fixPromptTemplate = `【定时任务：轮询需求「{{STORY_TITLE}}」的关联 Bug 并自动修复】

需求：「{{STORY_TITLE}}」（TAPD id：{{TAPD_STORY_ID}}）的关联缺陷。

变量约定：
- 需求标题：{{STORY_TITLE}}（中文全称，照抄需求标题，不要改写、不要截断）
- 项目 workspace_id：{{WORKSPACE_ID}}（整数）
- 需求 id：{{TAPD_STORY_ID}}（有子需求时主+子 id 逗号拼接）
- 处理人：{{OWNER}}
- 状态过滤：new（新）| reopened（重新打开）
- 工作流 Story ID：{{STORY_ID}}（固定不变，复用同一个 Story，禁止新建）

范围：本仓库是前端项目。分类为 backend / collab 的缺陷由 harness 写评论转交，不改代码。

════════ 第 0 步：锁检查（只读，不做任何写入）════════

读 {{PLANS_DIR}}/.harness-active（JSON：active / storyId / title / mode / activatedAt）。

| 情况 | 动作 |
|------|------|
| 文件不存在 | 正常，进入第 1 步 |
| 存在且 storyId === {{STORY_ID}} | 输出「上一轮仍在执行（Phase N），本轮跳过」，立即结束：不查 TAPD、不读 bug-list、不改任何文件 |
| 存在且 storyId !== {{STORY_ID}} | 输出「其他 Story（<storyId>）占用中，本轮跳过」，立即结束 |

若标志存在但对应 e2e-state.json 已不存在或已归档，属陈旧残留：
输出「检测到陈旧的 harness 激活标志，请先执行 /end 清理」，本轮结束。
不要自己删除该标志 —— 清理激活状态是状态操作，只能由 /end 执行。

════════ 第 1 步：查询缺陷（两次调用）════════

口径：需求关联 ∩ 处理人「{{OWNER}}」∩ 状态「new | reopened」。
关联边界只用 get_related_bugs；禁止 workspace 级全量查询；禁止标题关键词比对。

【1-1】取关联集合（只调一次）
get_related_bugs(workspace_id={{WORKSPACE_ID}}, options={"story_id": "{{TAPD_STORY_ID}}"})
- workspace_id 必须是整数；story_id 蛇形且键名带双引号
- 返回 data:[{bug_id,...}]，无 count → N = data.length；limit/page 被忽略，一次返回全量
- N = 0 → 本轮 0 条，跳第 6 步出报告（不建流、不改任何文件）

【1-2】一次批量过滤（不要逐条循环）
get_bug(workspace_id={{WORKSPACE_ID}}, options={
  id: "<N 个 bug_id 逗号拼接>",
  current_owner: "{{OWNER}}",
  status: "new|reopened",
  limit: 200,
  fields: "id,title,status,current_owner,created,module,description"
})
- id / current_owner / status 同层 AND，一次调用完成；id 必须放 options 里
- limit 必须 >= N；N > 200 时按 100 一批切片，每批 limit:200
- 状态必须传英文 key；本项目：new=新 / reopened=重新打开 / in_progress=接受处理 /
  assigned=已分配 / verified=已验证 / postponed=延期 / resolved=已解决 / rejected=已拒绝
- fields 必须显式声明，否则 title/description 不返回

【1-3】判定
- data 非空 → 命中集合，进第 3 步
- data 空且 count=0 → 0 条，跳第 6 步
- count>0 但 data 空 → limit 不够，加大重查，不许当成 0 条

════════ 第 3 步：与 bug-list.json 对账（只读，不写）════════

读 {{PLANS_DIR}}/{{STORY_ID}}/bug-list.json。
- 文件不存在 → 全部命中都是「新缺陷」（首轮），直接进第 4 步
- 文件存在 → 对每条命中按下面四态分流

对每个命中的 bugId，在 bugs[] 里查找，并按顺序判定：

【3-A】bugs[] 中找不到该 bugId
  → 判定：新缺陷。首次进入流程。

【3-B】找到，且 writeback 存在（我们曾写过评论）
  实时调 get_comments(workspace_id={{WORKSPACE_ID}}, options={bug_id: "<bugId>"})，
  按时间升序取最近 10 条，取出最新一条评论的时间 latestCommentAt。

  | 比较 | 判定 | 含义 |
  |------|------|------|
  | latestCommentAt > writeback.commentedAt | 真打回 | 我们修完后测试又复现并留言 |
  | latestCommentAt <= writeback.commentedAt | 疑似误操作 | 状态变了但没人说话，读评论确认 |

  再结合 writeback.commentKind 细分：
  - fixed      → 我们写过「已修复」被打回，重点查「修得不全 / 环境未更新」
  - to_backend → 我们只转给后端，从未修过前端代码。这是后端修完被打回，
                 重新分析并考虑改分类为 frontend（后端改过一次失败，可能需要前端配合）
  - to_collab  → 同上，重新分析并考虑改分类
  - manual     → 曾经转人工，被打回说明仍需人工判断，本轮转人工确认

  判定为「真打回」时，读到的评论要点必须写进本轮报告，并注明属于哪一类：
    A. 没修好（现象与原缺陷一致）→ 重新查根因
    B. 新问题（现象超出原缺陷范围）→ 建议测试拆分单独立缺陷
    C. 判断不出（只有「还是不行」）→ 转人工确认

【3-C】找到，但没有 writeback（我们只分析过、没写评论）
  → 判定：重新分析。可能是上一轮分析后未走到修复，或分类需要修正。

【3-D】找到，writeback 存在，但 TAPD 状态仍为 new
  → 这是正常现象（改完等人工提测，状态由人流转）。
  → 跳过，不要重复修复。报告里记「已修复待流转」。

════════ 第 4 步：交给 harness 修复 ════════

把第 3 步得出的「待处理集合」（新缺陷 + 真打回 + 疑似误操作 + 重新分析项）交给 harness。

【4-1】bug-list.json 不存在（首轮）
  按 /start skill 入口 A 建流：mode = fixbugs，storyId 用 {{STORY_ID}}，
  sources 填 tapdUrl / workspaceId / storyIdInTapd / owner。
  不要省略 storyId 让脚本自动生成。

【4-2】bug-list.json 已存在
  不手改 bug-list.json（它是 Phase 0→1 门控依据）。
  把「待处理集合」的 bugId 列表与判定结论写进 {{PLANS_DIR}}/{{STORY_ID}}/story-input.json 的
  sources.text 字段（追加，不覆盖原值），然后按 /start 入口 B 继续推进 ——
  Phase 0 需求分析师会重新拉 TAPD 并据此更新清单。

【4-3】待处理集合为空
  输出「本轮无新增缺陷」并跳第 6 步，不建流、不推进。

之后严格按 /start skill 的三步循环执行：
  Step 1 执行 dispatch.js → Step 2 按 status 四态（ready / fix_loop / blocked / terminal）分支
  → Step 3 子 Agent 汇报后回 Step 1。
修复、门控、dev-pass、TAPD 回写全部由 harness 负责，本任务不介入。

════════ 第 5 步：终态处理 ════════

dispatch 返回 terminal 时，不要自动重开工作流，输出待办并结束：

  本 Story 已完成（Phase 7）。本轮检测到 N 个新缺陷：<id> <标题>...
  建议执行 /harness archive 归档后重新发起。

不做 --rollback：定时任务无权决定「何时开启新一轮开发」。

════════ 第 6 步：输出报告 ════════

本轮必须输出（并写入 {{PLANS_DIR}}/{{STORY_ID}}/cron-report-<YYYYMMDD-HHmm>.md）：

1 锁检查结果：是否因进行中而跳过
2 查询统计：关联数 N / 状态命中数 / 待处理数
3 对账结果（逐条）：
   | bugId | 标题 | TAPD状态 | 本地记录 | 判定 | 依据 |
   判定取值：新缺陷 / 真打回 / 疑似误操作 / 重新分析 / 已修复待流转
4 harness 执行结果：本轮到哪个 Phase、是否有 blocked / fix_loop
5 待人工确认清单：bugId / 触发原因 / 待决问题

若本轮 0 条命中：只输出「本轮无符合条件的新缺陷」+ 关联数 N，不做其他动作。

════════ 铁律 ════════

- 🚫 不新建 storyId，永远复用 {{STORY_ID}}
- 🚫 不手改 bug-list.json / e2e-state.json / dev-pass.json
- 🚫 不删除 .harness-active（清理激活状态只能由 /end 执行）
- 🚫 不自行分析根因、不改代码、不建 Agent Team —— 这些是 harness 的职责
- 🚫 不执行 git commit / push，改动留在工作区由人处理
- 🚫 自动 repair 到终态后不自动重开`

/**
 * 按 tapd-bug-cron 模板生成完整定时任务提示词。
 * @param mode 只查询或查询后自动修复
 * @param context 当前 Story 的 TAPD 与工作区信息
 * @returns 已替换全部占位符的完整提示词
 */
export function buildCronPrompt(mode: CronMode, context: CronPromptContext): string {
  const replacements: Record<string, string> = {
    STORY_TITLE: context.storyTitle,
    WORKSPACE_ID: context.workspaceId,
    TAPD_STORY_ID: context.tapdStoryId,
    OWNER: context.owner,
    STORY_ID: context.storyId,
    PLANS_DIR: context.plansDir,
  }
  const template = mode === 'query_fix' ? fixPromptTemplate : queryPromptTemplate
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => (
    replacements[key]?.trim() || placeholder
  ))
}
