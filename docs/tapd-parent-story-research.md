# TAPD 父子需求调研 + 看板展示父需求链接方案

> 调研日期：2026-11-17
> 触发问题：按处理人「蔡杰鹏」查询看板数据，查到的全是**子需求**；父需求只挂 leader，不挂开发。
> 测试提 bug 关联的是**父需求**，因此只看子需求会漏掉父需求下的 bug。
> 期望：看板展示**父需求的链接**；工作区绑定也应绑定到父需求。

---

## 一、结论速览

1. **TAPD 支持子需求反查父需求**，而且不止一种方式（`parent_id` / `ancestor_id` / `children_id`），无需任何额外权限或接口。
2. **当前代码查询时根本没请求这些字段**：`listOwnedStories()` 的 `fields` 只有 `id,name,status,priority_label,owner,iteration_id,iteration_name,created`，所以快照里既没有父 ID 也没有父链接。
3. **实测确认问题真实存在**：owner=蔡杰鹏 的 55 条需求全是叶子子需求（`children_id='|'`），每条都有 `parent_id`；父需求 `parent_id=0`、owner 是 leader（杜鹏 / hupengfei）。
4. **实测确认 bug 关联在父需求上**：父需求 `...1699` 关联 6 条 bug，其子需求 `...1733` 一条都没有。
5. 方案：在 `listOwnedStories` 增加 `parent_id`/`ancestor_id` 字段，批量补查父需求并把父需求链接注入看板行；工作区绑定统一以父需求为准。

---

## 二、当前数据查询链路（代码事实）

| 环节 | 文件:行 | 说明 |
|---|---|---|
| 看板默认处理人 | `apps/server/src/aggregator/board.ts:4` | `defaultBoardOwner = '蔡杰鹏'` |
| 看板聚合 | `apps/server/src/aggregator/board.ts:36` `buildBoard()` | 调 `tapd.listOwnedStories(owner)` 作为唯一数据元 |
| 按处理人查需求 | `apps/server/src/integrations/tapd.ts:340` `listOwnedStories()` | `get_stories_or_tasks(options={ entity_type:'stories', owner, limit:200, fields: ownedStoryFields })` |
| 查询字段 | `apps/server/src/integrations/tapd.ts:8-10` | `storyFields = id,name,status,priority_label,owner,iteration_id,iteration_name`；`ownedStoryFields = storyFields + created` —— **无 parent_id** |
| 关联 bug 查询 | `apps/server/src/integrations/tapd.ts:239-242` | `get_related_bugs(options={ story_id: storyIds.join(',') })` —— 用**子需求 ID** 查，故查不到父需求上的 bug |
| bug↔需求匹配 | `apps/server/src/integrations/tapd.ts:293-294` + `hasOwnerMatch()` L537 | 额外用 `current_owner` 与需求 owner 做模糊匹配 |
| 需求 → 看板行 | `apps/server/src/aggregator/board.ts:133` `toBoardStory()` | 直接把 `story.tapdUrl` 当看板链接，无任何父子概念 |
| 看板行 schema | `packages/shared/src/index.ts` `boardStorySchema` | 字段 `storyId/title/status/.../tapdUrl/inTapdList/...`，**无 parent 相关字段** |
| 工作区绑定 | `apps/server/src/workspaces/bindings.ts:20` `normalizeTapdStoryId()` | 绑定存的是用户粘贴的 TAPD 需求 ID（当前是子需求 ID） |
| cron 缺陷巡检 | `apps/web/src/utils/cron-prompt.ts:27,40` | 提示词已写「有子需求时主+子 id 逗号拼接」查 bug —— 说明系统早知父子结构，但看板未落地 |

**关键**：`cron-prompt.ts` 的约定是「主需求 + 全部子需求 id 一起查 bug」，而看板 `listOwnedStories` 只有子需求 ID，因此看板链路与巡检链路口径不一致。

---

## 三、TAPD 能力调研（基于 MCP 工具 schema + 真实数据验证）

### 3.1 `get_stories_or_tasks` 支持的父子字段（权威，来自工具 schema）

- `parent_id`：父需求 ID；**`parent_id=0` 表示根需求（父）**。
- `ancestor_id`：祖先需求，查询指定需求下所有子需求。
- `children_id`：子需求；`|` 表示无子需求（叶子）；`!= |` 可只查父需求。
- `workitem_type_id` / `workitem_type_name`：需求类别。
- `fields`：可显式请求上述字段返回。

### 3.2 真实数据验证（workspace_id=38260062）

按 owner=蔡杰鹏 查询，返回 55 条，**全部是子需求**：

```
id=...31896  name=【客服】客服优化六期…前端  owner=蔡杰鹏;
  parent_id=...31818  children_id=|  ancestor_id=...31818
id=...31733  name=【大众】红包领取上限支持按照时间段 前端  owner=蔡杰鹏;
  parent_id=...31699  children_id=|  ancestor_id=...31699
```

反查父需求（用 `parent_id` 列表查）：

```
id=...31818  owner=杜鹏;hupengfei;  parent_id=0
  children_id=||...31896           ← 子需求被挂在父需求下
id=...31699  parent_id=0
  children_id=||...31733|...31804|...31821
```

→ 父需求 owner 是 leader，**不含开发蔡杰鹏**，这解释了「按开发查只看得到子需求」。

### 3.3 bug 关联的验证

`get_related_bugs(story_id=父,子)` 实测：

```
父 ...31699 → 6 条 bug：...219082 / ...219093 / ...219097 / ...219105 / ...219342 / ...219345
子 ...31733 → 0 条
```

→ **bug 确实挂在父需求上**，看板只查子需求 `...31733` 必然漏掉这 6 条。用户判断完全正确。

### 3.4 反查父需求的可行路径（三选一）

| 方式 | 做法 | 评价 |
|---|---|---|
| A. 直接读 `parent_id`（推荐） | owner 查询时 fields 带上 `parent_id,ancestor_id`，拿到子→父 ID 映射；再用 `get_stories_or_tasks(id=父ID列表)` 批量取父需求详情+链接 | 最省调用：1 次 owner 查询（多带字段）+ 1 次父需求批量查询。**无需改查询条件**。 |
| B. 按 `children_id` 查父 | `get_stories_or_tasks(children_id='<子ID>')` 反查父 | 需每个子需求调一次（或验证是否支持多值），调用多；不如 A。 |
| C. `ancestor_id` 查整棵树 | `get_stories_or_tasks(ancestor_id='<父ID>')` 取全部子孙 | 适合「父→所有子」展开 bug 查询，作为 A 的补充。 |

**推荐 A 为主，用 `ancestor_id`/`children_id` 做父→子展开以补全 bug 查询口径**（对齐 cron-prompt 的「主+子」约定）。

---

## 四、方案设计

### 4.1 总体思路

看板行的数据源从「子需求」升级为「父需求 + 其子需求集合」：

1. `listOwnedStories` 查询 owner 需求时，fields 增加 `parent_id,ancestor_id`（以及 `children_id` 备用）。
2. 对每个子需求取 `parent_id`（若 `parent_id=0` 则自身即父）；去重得到父需求 ID 集合。
3. 批量 `get_stories_or_tasks(id=父ID列表, fields=...)` 取父需求标题/链接。
4. 返回的 `TapdStory` 增加 `parentStoryId` / `parentTapdUrl` / `parentTitle` 字段（可选），`tapdUrl` 改为父需求链接（或在前端优先展示父链接）。
5. 看板行 `BoardStory` 同步增加父需求字段，前端展示父链接。
6. 工作区绑定统一指向父需求：绑定时若粘贴的是子需求 ID，自动解析为父需求 ID 存储。

### 4.2 涉及改动点（待实施时逐项落地 + 写测试）

| 文件 | 改动 |
|---|---|
| `packages/shared/src/index.ts` | `tapdStorySchema` / `boardStorySchema` 增加 `parentStoryId`、`parentTitle`、`parentTapdUrl`（均 optional）；`tapdUrl` 保留兼容。 |
| `apps/server/src/integrations/tapd.ts` | ① `storyFields` / `ownedStoryFields` 增加 `parent_id,ancestor_id,children_id`；② `parseStories`/`listOwnedStories` 解析父子字段；③ 新增批量取父需求方法 `fetchParents(childStories)`；④ bug 查询口径改为「父 + 全部子」ID 拼接（对齐 cron-prompt）；⑤ `listOwnedStories` 返回值注入父链接。 |
| `apps/server/src/aggregator/board.ts` | `toBoardStory()` 透传父需求字段；看板链接优先父需求。 |
| `apps/server/src/workspaces/bindings.ts` | 绑定保存时把子需求 ID 解析为父需求 ID（可选开关，需确认）。 |
| `apps/web/src/views/ConsolePage.vue` / `useBoardStories.ts` | 看板行链接渲染为父需求链接（可保留子需求作为副标题）。 |
| 测试 | `tapd-owned-stories.test.ts`、`board.test.ts`、`bindings.test.ts` 增加父子场景；新增 mock 覆盖「子→父解析」「父 bug 聚合」。 |

### 4.3 关键风险与对策

- **缓存口径**：`enrichmentCache` 以子需求 ID 为键；父需求 bug 聚合需注意缓存键与 force 刷新一致性，避免父 bug 数变化后仍显示旧值。
- **调用量**：父需求批量查询仅 1 次；但 bug 查询若要「父+所有子」需多 ID，注意 `get_bug` limit 与截断处理（现有 `limit:200` + count 对账已覆盖）。
- **owner 匹配**：现有 `hasOwnerMatch(bug.currentOwner, story.owner)` 用子需求 owner（蔡杰鹏）匹配 bug current_owner；切到父需求后 owner 变 leader，匹配逻辑需重新定义（建议：bug 归属按「关联到父或任一子 + bug current_owner 是目标开发」判定，而不是需求 owner）。
- **工作区绑定迁移**：历史绑定存的是子需求 ID，需提供一次性迁移或双写兼容，避免旧绑定在看板上「消失」。
- **幂等/去重**：多个子需求可能共享同一父需求，父需求在看板是否合并为一行（推荐合并，子需求作为附属展示）需要产品确认。

---

## 五、待确认问题

1. 看板是「一个父需求一行（子需求折叠）」还是「仍按子需求一行、只把链接换成父链接」？—— 方案 4.1 默认后者，4.3 风险项建议前者。
2. 工作区绑定是否强制迁移到父需求？历史子需求绑定如何处理？
3. bug 的 owner 匹配口径改成什么（当前用需求 owner，父需求 owner 是 leader）？
4. 父需求无 `statusLabel` 时（父需求状态码可能与子不同），"已发布"过滤以谁为准？

---

## 六、调研证据索引

- 工具 schema：`mcp__TAPD_MCP_Server__get_stories_or_tasks`（parent_id / ancestor_id / children_id 字段说明）。
- 实测查询：owner=蔡杰鹏 返回 55 条子需求；父 `...31818`/`...31699` owner=leader、children_id 列出子；父 `...31699` 关联 6 bug、子 `...31733` 0 bug。
- 代码：`apps/server/src/integrations/tapd.ts:8-13,226-327,340-378`；`apps/server/src/aggregator/board.ts:36,133`；`apps/web/src/utils/cron-prompt.ts:27,40`；`packages/shared/src/index.ts:187,boardStorySchema`。
