# DevTask Console · 需求规格说明

> 开发任务管理站点 —— 把 TAPD、git worktree、CodeBuddy 实例、Harness 流程、GitLab MR、DevOps 构建部署、Bug 定时修复串成一条可视可控的闭环流水线。
>
> **版本 v2.8** · 2026-11-13 · 单机自用 · 本地服务 + 网页控制台
> v2 变更：补入 GitLab 与 DevOps 两条通道，新增 M6 发布与部署模块，闭环「提测」环节。
> v2.1 变更：新增技术栈选型；按评审 H1 修正环境核对为「四信号判定」；H2 / H3 标为开工前阻塞项。
> **v2.2 变更（合并方案评审结论）**：① 交付顺序重排为「精简 MVP + 扩展」双轨，MVP 收敛到 20 条；② 新增 M7 收件箱模块与「聚合器先行」架构决策；③ Phase 4-6 期间发布写操作改为硬禁用；④ 补齐评审遗漏项 G1-G5（站点鉴权、失败恢复、磁盘成本、度量、统一快照时刻）；⑤ 新增第 11 节交互模式采纳决策摘要（29 条）。
> **v2.3 变更**：第 11 节由摘要升级为**完整决策记录**——29 条模式逐条补齐「结论 / 依据 / 落地 / 验收」（不抄类为「替代做法」），规格本身即可直接照着实现。内容与用户导出的决策快照一致，无改判。
> **v2.4 变更（历史版本，入口后由 v2.5 修正）**：曾按 `/harness start` / `/harness fixbugs` 描述开发与缺陷修复入口，并移除站点自建的 Bug 状态机。
> **v2.5 变更**：按当前 `start` / `tapd-bug-cron` skill 更新入口、同一 storyId 多轮与定时任务职责；终态自动归档并启动下一轮列为 cron skill 待增强能力，本版不修改插件或 README。
> **v2.6 变更**：确认每个 TAPD Story 使用一个由控制台后端监督的长期 CodeBuddy `--serve` 服务；服务按需启动、端口持久映射，cron owner 与每轮 Job 分离，并补齐代理、安全边界、服务恢复及删除规则。终态自动归档/重启仍是插件/skill 待增强能力。
> **v2.7 变更**：前端原子 CSS 从 UnoCSS 改为 Tailwind CSS；明确 cron task 与持久 owner session 的一对一关系、每次触发与 StoryRound session 的边界，以及多任务场景的映射和生命周期管理。
> **v2.8 变更**：补充站点公共框架、七个主导航页面的信息布局、窄屏基础降级和布局验收标准；连接自检与配置作为主导航外的工具页。

---

## 0. 一句话定位

**它不是又一个项目管理工具，而是你现有工具链的「驾驶舱」。**

TAPD 仍是需求与缺陷的唯一信源，Harness 是需求开发与缺陷修复的唯一流程状态机，`tapd-bug-cron` skill 负责创建查询/修复 scheduled task，GitLab 与 DevOps 仍是代码与发布的唯一信源。
每个 TAPD Story 映射一个由控制台后端监督的长期 CodeBuddy 服务；服务仅在首次 CodeBuddy/cron 操作时启动，轮次 Job 与 cron owner 分离。本站只做三件事：**聚合显示**（把散在六处的状态拼成一屏）、**代为执行**（把你现在手敲的命令变成按钮）、**守住边界**（不越过各工具已有的铁律）。

### 明确不做

| 不做 | 原因 |
|---|---|
| 自建需求/缺陷数据库并双向同步 | TAPD 是信源，双写必然打架。站点只缓存快照 |
| 自己实现一套开发流程状态机 | Harness 的 `e2e-state.json` 已经是了，重复造会互相污染 |
| 自己实现 Bug 分析修复逻辑 | 通过 `/start fixbugs <storyId>` 进入 Harness 7 Phase 流程；站点只提供启动入口与状态展示 |
| 代替 AI 改 `e2e-state.json` / `dev-pass.json` | Harness 铁律，站点同样遵守，只读 |
| 自动 git commit / push / 依赖变更 | 与现有安全边界一致，改动只留工作区 |
| **默认自动触发 pre / prod 发布** | 生产发布必须人来拍板，站点默认只开放 dev / test |
| **在 Harness Phase 4-6 期间触发构建 / 创建 MR** | v2.2 升级为硬规则：该区间站点发布写操作**直接禁用**，只读展示。避免与发布助手竞态、避免用错 env/buildOther 污染门控判定 |
| 多人权限体系 | 本期单机自用 |

---

## 1. 方案目标流程：Harness 驱动的需求与缺陷闭环

```mermaid
flowchart TD
    A["领导在 TAPD 分配需求"] --> B["理解需求<br/>确定涉及哪些仓库"]
    B --> C["create-workspace<br/>git worktree + npm install + graphify"]
    C --> D["首次 CodeBuddy / cron 操作<br/>后端按需启动或接管 Story 服务"]
    D --> E["控制台按 Story / StoryRound<br/>创建独立 CodeBuddy Job"]
    E --> F["Harness dispatch 自动调度<br/>run 模式 · Phase 0→6"]
    F --> G{"需求输入 / 接口文档<br/>是否齐备？"}
    G -->|"否 / 被阻塞"| H["补充 story-input.json<br/>按 Harness skill 刷新输入"]
    H --> I["Harness 重新判门控<br/>按提示从合法 Phase 继续"]
    G -->|"是"| J["Harness dispatch 自动执行<br/>Phase 2-6 + 门控 / fix-loop"]
    I --> J
    J --> K["开发审查 → 提交 + MR<br/>知识库更新 → 构建部署"]
    K --> O["部署 → 拿到部署 URL"]
    O --> P["提测（test 环境构建+部署）"]
    P --> Q["测试提 Bug 到 TAPD"]
    Q --> R["Harness tapd-bug-cron skill<br/>创建并配置定时任务"]
    R --> S{"任务模式"}
    S -->|"只查"| T["cron owner 查询 TAPD 并报告"]
    S -->|"查询+修复"| U["cron owner 查询匹配 Bug"]
    U --> V{"有匹配 Bug？"}
    V -->|"否"| N["等待下一计划周期"]
    V -->|"是"| W{"当前 Story 状态？"}
    W -->|"未终态"| X
    W -->|"terminal"| Y["（待增强）归档 round-N<br/>复用 storyId 启动新 fixbugs Job"]
    W -->|"无当前轮，直接启动（目标行为）"| Z
    Y --> Z["新建本轮 Job 并发送<br/>/start fixbugs <storyId>"]
    Z --> AA["Harness fixbugs<br/>完整 7 Phase + 门控 / fix-loop"]
    AA --> N
    T --> N
    X --> N
    N --> U
```

### 痛点（站点要解决的具体问题）

| # | 痛点 | 现在的做法 | 代价 |
|---|---|---|---|
| P1 | 不知道手上有几个需求、各到哪一步 | 翻 TAPD + 翻各 worktree 的 `e2e-state.json` | 上下文切换成本高，容易漏 |
| P2 | 建工作区要手敲 PowerShell、选仓库、等 5~10 分钟 | 命令行 + 人肉盯着 | 中断后不知道跑到哪一步 |
| P3 | 多个 CodeBuddy 实例分不清谁是谁 | 靠窗口标题和记忆 | 发错指令、看错输出 |
| P4 | 定时任务列表全是泛称，认不出属于哪个需求 | 已知坑 #28 | 改错任务、重复建任务 |
| P5 | 改轮询间隔要删了重建 | 手工 | 容易留下两条任务并行跑 |
| P6 | Harness 阻塞项不易发现和回复 | 需要切回对应 CodeBuddy 实例查看 | 阻塞项积压，忘记处理 |
| P7 | 前端先行、后端接口后到，需要补充输入并继续流程 | 手动改 `story-input.json` 后还要按 Harness skill 刷新输入、重判门控 | 漏掉回填导致门控不生效 |
| P8 | 不知道定时任务上一轮到底干了什么 | 翻 CodeBuddy 执行记录与 Harness Story 产物 | 出问题才发现 |
| **P9** | **MR 建了没合、卡在 Phase 4 不知道** | **翻 GitLab** | **流程停滞，误以为在开发** |
| **P10** | **构建成功没有、部署到哪个环境了** | **翻 DevOps 平台** | **提测时说不清版本** |
| **P11** | **reopened 到底是没修好还是环境没更新** | **人工跨 TAPD、工作区、MR 与构建记录排查** | **反复切换工具，可能重复修复** |
| **P12** | **多仓库需求要逐个构建再手工收集制品 URL 批量发布** | **手工复制 file_url** | **易漏应用、易发错环境** |
| **P13** | **DevOps 会话过期后 403，不知道是凭据问题还是平台挂了** | **看报错猜** | **排查浪费时间** |

---

## 2. 已核实的技术底座

> 以下路径与接口均已在本机核实，是实现时的直接依据。

### 2.1 本机目录约定

| 项 | 值 |
|---|---|
| 源仓库根 | `D:\workfile`（40+ 个 git 仓库，基线分支 `master`） |
| 工作区根 | `D:\test-blanch\<工作区名>\` |
| 分支命名 | `feat/<工作区名>` |
| 多根工作区文件 | `<工作区名>.code-workspace` |
| 工作区初始化脚本 | `~/.codebuddy/skills/create-workspace/scripts/create-workspace.ps1` |
| Harness 插件 | `~/.codebuddy/harness-marketplace/plugins/harness/` |
| Harness 定时缺陷 skill | `~/.codebuddy/harness-marketplace/plugins/harness/skills/tapd-bug-cron/` |
| MCP 配置 | `~/.codebuddy/mcp.json`（TAPD / GitLab / Devops / Figma / Playwright） |
| DevOps MCP 源码与文档 | `D:\other\devops\`（`PROJECT_INTRODUCTION.md` / `mcp-server.js` / `devops-api.js`） |

### 2.2 每个 worktree 内的状态文件（站点的主要数据源）

```
<worktree>/.codebuddy/
├── plans/<storyId>/
│   ├── e2e-state.json          # ★ 阶段状态：{storyId,title,phase,status,phases{}}
│   ├── story-input.json        # 原始输入（可写，非状态文件）
│   ├── requirement-analysis.md # Phase 0 产出
│   ├── acceptance-criteria.json
│   ├── task-dag.json / task-dag.md
│   ├── code-review.json        # Phase 3 产出
│   ├── open-questions.json     # 待确认项（confirmation 才是放行依据）
│   ├── scope-amendments.json   # 范围外改动
│   ├── repos.json              # 多仓库映射（primary + repos）
│   ├── bug-list.json           # Harness fixbugs 产出的缺陷状态与回写凭证
│   ├── {需求标题}_bug分析报告.md # Harness 需求分析师的 Bug 分析报告
│   └── archive/<round-N>/      # ★ 已归档轮次；同 storyId 保留开发/修复历史
├── scheduled_tasks.json        # ★ 定时任务 {tasks:[{id,cron,prompt,expiresAt,...}]}
├── scheduled_task_executions.json  # ★ 执行记录
└── teams/
```

`e2e-state.json` 实测样例：

```json
{"storyId":"ZZ-GUARD-TEST","title":"guard test","phase":2,"status":"running",
 "phases":{"0_requirement":{"status":"completed"},"1_planning":{"status":"completed"},"2_development":{"status":"running"}}}
```

### 2.3 CodeBuddy HTTP API（能力已覆盖，无需自造）

**服务拓扑与启动**：每个 TAPD Story 对应一个长期 CodeBuddy HTTP 服务，端口稳定；工作区创建时不启动服务，首次 CodeBuddy 或 cron 操作时由控制台后端惰性启动。每个 StoryRound 的 run/fixbugs 执行创建独立 Job/session，复用该 Story 服务的 endpoint/port；cron owner session 与这些轮次 Job 分离。服务启动命令：

```powershell
codebuddy --serve --host 127.0.0.1 --port <port> --permission-mode bypassPermissions --auth none
```

不要用 `codebuddy daemon start` 分配 Story 端口：该命令为幂等调用，只返回既有 daemon，不能据此取得独立的每 Story 端口。`--serve` 进程由控制台后端监督，不交给 daemon supervisor。已在本机 CLI 验证多个不同端口的 `codebuddy --serve` 服务可并行运行。

**生命周期与端口**：后端持久化 Story 与服务实例映射、端口、cwd、PID/健康状态及 cron owner。后端启动时按映射对原端口做健康检查，接管存活服务，否则在同一端口启动；意外故障最多重试 3 次，间隔依次为 5s / 15s / 30s，仍失败则标记服务失败并通知。浏览器关闭不影响服务；终态/归档也不停止服务，必须由用户显式手动停止。端口从 60200 起分配，可配置范围上限但不得高于 65535（默认上限 65535）；已分配端口持久保留，直到显式删除 Story 映射。冲突或耗尽时报错，不得改写映射或复用保留端口。

**HTTP 转发与安全边界**：浏览器只向控制台后端发请求，由后端按 `instanceId`/Story 映射代理到 `http://127.0.0.1:<port>/api/v1/...`；浏览器不得直接选择或访问 CodeBuddy 端口。上游每个请求发送 `X-CodeBuddy-Request: 1`。本设计明确使用 `--auth none`，不配置密码或 Bearer/X-Access-Token；该 Header 只是请求标记，不是认证。任何本机进程都可能访问对应服务的执行、文件等 API，属于已接受的本机信任边界，不能把 loopback 或该 Header 描述为认证保护。

| 站点动作 | 接口 |
|---|---|
| 列出实例 | `GET /api/v1/jobs?all=1&cwd=<path>` |
| 启动实例 | `POST /api/v1/jobs` `{prompt,cwd,name,agent,model,effort,permissionMode,bash,bgIsolation}` |
| 实例变更推送 | `GET /api/v1/jobs/events`（SSE：snapshot/added/changed/removed/keepalive） |
| 实时输出 | `GET /api/v1/jobs/:id/stream`（SSE，先回放尾部再跟随） |
| 历史对话 | `GET /api/v1/jobs/:id/transcript`（≤1000 行，不启动 worker） |
| 与实例对话 | `POST /api/v1/jobs/:id/reply` `{text,bash:false}` |
| 暂停 / 重启 / 删除 | `POST /jobs/:id/stop` / `POST /jobs/:id/respawn` / `DELETE /jobs/:id` |
| 重命名 | `PATCH /api/v1/jobs/:id/name` `{name}` |
| 可恢复会话 | `GET /jobs/resumable?cwd=` → `POST /jobs/resume` `{sessionId}` |
| 定时任务列表 | `GET /api/v1/scheduled-tasks?sessionId=xxx`（新建由 Harness skill 负责） |
| **改间隔 / 启停** | `PATCH /api/v1/scheduled-tasks/:id` `{cron}` / `{enabled:false,sessionId}` |
| 删除任务 / 执行记录 | `DELETE /scheduled-tasks/:id` / `GET /scheduled-tasks/:id/executions` |
| 会话列表 | `GET /api/v1/sessions?cwd=*` |
| 内嵌终端 | `POST /api/v1/pty` → `GET /pty/:id/output`(SSE) → `POST /pty/:id/input/send` |
| 读文件 / 列目录 / 监听 | `GET /files/download?path=` / `POST /fs/list` / `POST /fs/watch`(SSE) |
| 健康与资源 | `GET /api/v1/health` / `GET /api/v1/metrics`（含 instances: cwd/pid/rssMib） |

以上均为后端代理至 Story 对应服务的上游 API；浏览器请求使用控制台自身路由和 `instanceId`，不暴露或接受上游端口选择。

**实例生命周期字段**：`state`(working/blocked/done/failed/stopped)、`status`(busy/waiting/idle/stopped)、`tempo`(active/idle/blocked)、`alive`、`settled`。
历史实例判定 = `settled===true && alive===false`。`webUrl` 仅在本机 loopback 有监听时非空。

### 2.4 TAPD 取数口径（必须照抄，已被实测验证）

```
结果 = get_related_bugs(story_id) 返回的 bug_id 集合
     ∩ current_owner 命中处理人
     ∩ status ∈ {new, reopened}
```

| 约束 | 说明 |
|---|---|
| `workspace_id` | 整数 `38260062`，传字符串报 must be integer |
| 两段式查询 | `get_related_bugs` 拿 id → `get_bug` 批量过滤，**只调两次** |
| 主+子需求 | id 用逗号拼接在同一字符串（实测 18+81→99 条） |
| `id` 位置 | 必须放进 `options`，写顶层报 additional properties |
| 参数命名 | 蛇形 `story_id`，不是 `storyId` |
| `owner` / `story_id`（get_bug 内） | **恒为空，禁用**；处理人用 `current_owner`（模糊匹配多人字段） |
| 状态值 | 必须英文 key：`new` / `reopened`；中文返回 0 条 |
| `limit` | 默认 10 会截断，传 ≥N（如 200）；用 `count` 判断真 0 条还是被截断 |
| `fields` | 不声明不返回，显式写 `id,title,status,current_owner,created,module,description` |
| `get_related_bugs` | 无 count、忽略 limit/page，数量 = `data.length`，一次全量 |
| 空数组 | 是「需求未关联缺陷」，不是失败，不重试、不用 workspace 级兜底 |

**其他可用工具**：`get_stories_or_tasks`、`get_iterations`、`get_release_info`、`get_bug_count`、`get_comments`、`get_workflows_status_map`。
**状态枚举**：`new` / `reopened` / `in_progress`(接受·处理) / `assigned` / `verified` / `resolved` / `postponed` / `rejected`。查询只认 `new`/`reopened`；回写只写 `in_progress`。

### 2.5 GitLab（`gitlab.vzan.com`）· v2 新增

MCP 名 `GitLab`（`npx gitlab-mcp`），API 基址 `https://gitlab.vzan.com/api/v4`，Personal Access Token 鉴权。

**已授权工具白名单**（`GITLAB_ALLOWED_TOOLS`，站点能力不得超出此范围）：

```
list_projects, search_repositories, get_project,
list_branches, get_branch, create_branch, get_branch_diffs,
list_merge_requests, get_merge_request, create_merge_request, merge_merge_request,
list_merge_request_changed_files, get_merge_request_approval_state,
create_tag, delete_tag, create_release, delete_release, update_release
```

**站点直连 REST 等价端点**：

| 用途 | 端点 |
|---|---|
| 找项目 | `GET /projects?search=<仓库名>` |
| 按分支找 MR | `GET /projects/:id/merge_requests?source_branch=feat/<工作区名>&state=all` |
| MR 详情 / 变更 / 审批 | `GET /projects/:id/merge_requests/:iid` / `/changes` / `/approvals` |
| 分支与提交 | `GET /projects/:id/repository/branches` / `/commits?ref_name=` |
| 判断提交是否在某分支 | `GET /projects/:id/repository/compare?from=<部署commit>&to=<修复commit>` |

**与 Harness 的关系**：Phase 4 = 提交开发分支 + 创建 MR（→ `dev`）+ **确认已合并**。
**关键关联键**：worktree 分支 `feat/<工作区名>` → MR 的 `source_branch`；目标分支固定 `dev`。

### 2.6 DevOps（`devops.vzan.com`）· v2 新增

MCP 名 `Devops_MCP`（`npx vzan-devops-mcp`，STDIO）。源码与完整文档在 `D:\other\devops\`。

**鉴权（重要）**：Cookie 会话制 —— `login_id` / `user` / `csrftoken` / `sessionid` 四个值拼成 Cookie，另需 `x-csrftoken` 头与 `Referer: https://devops.vzan.com/index.html`。
**这些值从浏览器开发者工具获取，会过期，过期表现为 HTTP 403。站点无法自动续期，必须提供刷新引导。**

**7 个工具与对应 REST**：

| 工具 | 入参 | REST | 用途 |
|---|---|---|---|
| `get-groups` | 无 | `GET /deploy/group` | 分组列表（如 `JenkinsFrontweb`） |
| `get-applications` | `group` | `GET /deploy/application?group=` | 分组下应用列表 |
| `get-branches` | `app` | `GET /deploy/branch?app=` | 分支列表，返回 `name`(origin/xxx)、`commit_id`、`last_commit_time` |
| `get-records` | `app`, `pageNo`, `pageSize` | `GET /deploy/build?app=&page_no=&page_size=` | 构建记录 + 当前状态 |
| `get-build-app` | `group`, `app`, `branch`, `env`, `buildType`, `buildOther` | `POST /deploy/build` | 触发构建 |
| `get-deploy-multiple` | `urls[]`, `env`, `force`, `timeout` | `POST /deploy/deploy_multiple` | 批量发布制品 |
| `get-build-stop` | `app` | `POST /deploy/build_stop` | 停止构建 |

**构建记录字段**（`detail[]` + `total`）：
`id`、`alias`(应用名)、`last_name`(操作人)、`build_date`、`commit_id`、`number`(构建号)、`branch`、`file_url`(制品地址)、`succeed`(1=成功)、`duration_time`(秒)。

**构建参数约定**：
- `branch` 格式必须是 `origin/<分支名>`
- `env` ∈ `test` / `dev` / `pre` / `prod`
- `buildType` 默认 `docker_build`；`buildOther` 为附加构建参数
- Harness Phase 6 固定用 `env=dev` + `build_other=dev`

**特殊分支逻辑（必须复刻，不能自己猜）**：应用 `live-h5-2` 会按环境自动选分支 ——
`test` → 找 `origin/test_*`；`dev` → 找 `origin/dev_*`；`pre` → 固定 `origin/pre2`。

**四类错误**：

| 错误 | 原因 | 站点应对 |
|---|---|---|
| `HTTP 403 Forbidden` | csrftoken / sessionid 过期 | 明确提示「DevOps 会话已过期」+ 刷新引导，不静默重试 |
| `fetch failed` / `ECONNREFUSED` | 网络或平台不可用 | 降级显示缓存 + 离线标识 |
| `Invalid input parameters` | 参数缺失或格式错 | 表单前置校验（branch 必须带 origin/ 前缀等） |
| **`上一任务尚未完成`** | 同应用有进行中构建 | 提交前检查，命中则给「查看进度 / 停止构建」入口 |

---

## 3. 架构方案

```mermaid
flowchart LR
    subgraph Browser["浏览器 · 控制台前端"]
        UI["看板 / 工作区 / 实例 / 定时任务 / 发布"]
    end
    subgraph Local["本机 Node 服务 (127.0.0.1:7788)"]
        API["REST + SSE 网关"]
        AGG["状态聚合器"]
        EXE["命令执行器"]
        CACHE["本地缓存 SQLite/JSON"]
    end
    subgraph External["被编排的对象"]
        SUP["CodeBuddy 服务监督器<br/>按 TAPD Story 映射端口"]
        CB["每 Story 一个 CodeBuddy --serve<br/>127.0.0.1:<port>"]
        JOB["StoryRound Job/session<br/>复用 Story 服务"]
        OWNER["专属 cron owner<br/>agentId / sessionId"]
        TAPD["api.tapd.cn"]
        GL["gitlab.vzan.com/api/v4"]
        DO["devops.vzan.com"]
        FS["D:\\test-blanch<br/>状态文件"]
        PS["create-workspace.ps1"]
    end
    UI <-->|"同源，无 CORS"| API
    API --> AGG --> CACHE
    API --> EXE
    API -->|"instanceId / Story 映射代理"| SUP
    SUP --> CB
    CB --> JOB
    OWNER -->|"cron 触发时经后端 dispatch"| API
    AGG --> TAPD
    AGG --> GL
    AGG --> DO
    AGG -->|"只读状态文件"| FS
    EXE -->|"后台长任务"| PS
```

**启动 / 恢复顺序**：首次 CodeBuddy 或 cron 动作触发后端 `ensureStoryService`：读取 Story 映射；若无映射则从 60200 起分配并持久化端口与 cwd，再启动上述 `--serve` 命令；若已有映射则先在原端口健康检查并接管存活服务，否则仍在原端口启动。所有浏览器 API 经后端映射代理。后端进程启动时对已登记服务执行同一健康检查/接管流程。用户手动停止 Story 服务时自动暂停其 cron；恢复时先恢复 cron owner/agent/session，再重新启用任务。意外停机期间跳过已错过或排队的 cron，不补跑。

### 五条数据通道

| 通道 | 用途 | 刷新策略 |
|---|---|---|
| **TAPD（走 MCP，见 10.2）** | 需求、Bug 数量与明细、迭代、版本 | 手动 + 定时（默认 5 分钟）+ 进入页面 |
| **CodeBuddy API** | 后端经 Story 映射代理实例列表/流/对话、定时任务 CRUD、终端；服务由后端监督 | SSE 长连 + 断线重连 + 30 秒轮询兜底 |
| **本地文件**（只读） | Harness 阶段、Story 产物、活动流程标记 | `fs.watch` + 变更即推 |
| **GitLab 直连** · v2 | MR 状态、审批、变更文件、分支与提交比对 | 手动 + 进入需求详情时 + Phase 4 期间加密 |
| **DevOps 直连** · v2 | 应用/分支/构建记录、部署环境、制品 URL | 手动 + 构建中轮询（10 秒）+ 403 即停 |

### 关键架构决策

| # | 决策 | 理由 |
|---|---|---|
| A1 | **前端由本地 Node 服务同源提供** | 彻底绕开 CORS 与混合内容问题；令牌不下发浏览器 |
| A2 | **凭据只存后端；CodeBuddy 明确无密码认证** | TAPD token、GitLab PAT、DevOps 四件套均敏感；CodeBuddy 使用 `--auth none`，请求标记不构成认证，本机任意进程可访问其高权限 API |
| A3 | **每个 TAPD Story 一个长期 CodeBuddy 服务** | Story 服务按需启动并固定端口；同一 Story 的多个 StoryRound Job/session 复用 endpoint，彼此隔离；后端负责监督、恢复与端口映射 |
| A4 | **站点是编排层，不是状态机** | 状态以被编排方为准，缓存只用于展示与离线兜底 |
| A5 | **长任务一律后台 + 进度上报** | npm install 1~3 分钟/仓库、graphify 20 秒~5 分钟/仓库、构建数分钟，不能用默认 120 秒超时 |
| **A6** | **发布侧「读直连、写兜底」** | MR/构建状态直连 REST 实时读；创建 MR、触发构建默认由 Harness Phase 4/6 执行，站点手动触发需二次确认 |
| **A7** | **DevOps 凭据失效即熔断** | 403 后停止轮询并挂起该通道，避免用过期凭据反复打平台；等用户刷新后恢复 |
| **A8** | **聚合器先行，渲染层可抛弃** · v2.2 | 先把六源状态聚合成统一 `state.json`，这是真正的资产。看板 / 收件箱 / 流水线都是它的投影，形态选错也能换，核心投入不浪费 |
| **A9** | **收件箱为默认首屏** · v2.2 | 单人工具的核心问题是「现在该我做什么」。打开先看待决策项，需要全局时再切看板 |
| **A10** | **发布写操作在 Phase 4-6 硬禁用** · v2.2 | 不是「建议兜底」而是硬规则，避免与发布助手竞态、避免用错 env/buildOther 污染门控 |
| **A11** | **后端代理与服务监督** · v2.6 | 浏览器只给 `instanceId`/Story，由控制台后端代理上游 API；每 Story 服务由后端监督，终态或归档不自动停止，须显式手动停止 |
| **A12** | **Story 服务端口持久保留** · v2.6 | 60200 起分配且不超过 65535；端口与 Story 映射同生命周期，映射显式删除前不释放；冲突/耗尽显式报错 |

---

## 4. 功能需求

编号规则：`模块-序号`。每条含**验收标准**，可直接当测试用例。

### M1 · 任务总览看板

| # | 需求 | 验收标准 |
|---|---|---|
| M1-1 | 需求列表 | 显示需求 ID、中文标题（含「【微赞+星享】」等前缀，不截断）、状态、优先级、处理人、迭代名 |
| M1-2 | Bug 数量徽标 | 三档：`待处理(new)` / `重新打开(reopened)` / `关联总数`；点击展开明细 |
| M1-3 | 需求链接直达 TAPD | 新标签打开，链接由 ID 拼接，不猜测 |
| M1-4 | 迭代与版本信息 | 迭代名称、起止日期、版本/发布计划；支持按迭代筛选分组 |
| M1-5 | **Harness 阶段进度条** | 读 `e2e-state.json` 渲染 Phase 0→6；当前 phase 高亮，`fix_loop` 显示回退，`blocked` 红色告警 |
| M1-6 | 四向关联 | 需求卡上直接看到：工作区路径、运行中实例数、cron 任务数与下次执行时间 |
| M1-7 | 未关联工作区给「去初始化」入口 | 一键跳 M2 并预填需求信息 |
| M1-8 | Bug 明细抽屉 | bug_id、标题、状态、处理人、创建时间、模块；`reopened` 打标并提示「需读评论」 |
| M1-9 | Harness 修复进度对照 | 并排展示 TAPD 状态与 Harness `bug-list.json` 中的分诊/回写状态；仅展示文件事实，不推导或写入流程状态 |
| M1-10 | 全局搜索与筛选 | 按标题/ID、迭代、阶段、有无阻塞项筛选；`/` 聚焦 |
| M1-11 | 数据新鲜度标识 | 每块显示「更新于 x 秒前」+ 手动刷新；失败降级显示缓存并标注 |
| **M1-12** | **发布侧状态列** · v2 | 需求卡显示：MR 状态（未建/待合并/已合并）、最近构建号与结果、当前部署环境 |
| **M1-13** | **全链路一条链** · v2 | 需求 → 工作区 → Phase → MR → 构建 → 部署 → 提测 → Bug，一屏看完，断点标红 |
| **M1-14** | **链路断点告警** · v2.1 | 展示工作区改动、MR、构建与 Harness Phase 的状态差异作为诊断线索；不替代 Harness 判定或推进流程 |

### M2 · 工作区一键初始化

| # | 需求 | 验收标准 |
|---|---|---|
| M2-1 | 仓库候选清单 | 扫描 `D:\workfile` 下含 `.git` 的目录，列出全部候选 |
| M2-2 | **仓库必须人工勾选，禁止猜测** | 未勾选时「创建」禁用；不得按工作区名或需求标题推断 |
| M2-3 | 工作区名校验 | 只允许 ASCII 字母/数字/`.`/`_`/`-`；输入中文时当场给拼音/英文候选 |
| M2-4 | 参数可覆盖 | 分支名、基线分支、源根、目标根、跳过 install、跳过 graphify |
| M2-5 | DryRun 预演 | 展示将创建的 worktree、工作区文件、安装与建图动作 |
| M2-6 | **后台执行 + 实时日志** | 超时 ≥600000ms；分阶段进度：worktree → workspace 文件 → npm install → graphify |
| M2-7 | 逐仓库进度 | 每仓库独立三态 `ok / skip / fail`，`skip` 是正常结果 |
| M2-8 | 幂等重跑 | 已存在 worktree 跳过；`node_modules` 与 `.package-lock.json` 同时存在才跳过安装 |
| M2-9 | 结果复核表 | 直接展示 `BranchOk / InstallOk / GraphifyOk / Pass` |
| M2-10 | **副作用提示** | 列出各仓库 `git status --porcelain`，标注 lock 文件、`.eslintrc-auto-import.json`、husky hooks、`graphify-out/*` 属预期 |
| M2-11 | 不自动 git pull | 明示「基于创建时的本地 master」 |
| M2-12 | 一键打开 | 用 VS Code 打开 `.code-workspace` 或复制路径 |
| **M2-13** | **仓库 ↔ DevOps 应用映射** · v2 | 初始化时确认每个仓库对应的 DevOps 应用名与分组，写入映射表供 M6 使用；不一致时人工确认，不猜 |

### M3 · 实例管理与对话

| # | 需求 | 验收标准 |
|---|---|---|
| M3-1 | 实例列表 | `GET /jobs?all=1`，按工作区分组；显示 name、cwd、state、status、tempo、alive |
| M3-2 | **命名规范** | 默认名 = `需求中文标题 · <用途>`，杜绝「实例1/实例2」 |
| M3-3 | 启动实例 | 提供「需求开发」「Bug 修复」两个明确入口；选择后以 CodeBuddy job 调用 Harness skill，不直接调用内部状态机脚本 |
| M3-4 | 快捷启动模板 | ① 需求开发：`/start` + storyId / 需求输入（当前 skill 推断 `run`，不使用未文档化的 `/start run`）；② Bug 修复：`/start fixbugs <storyId>`；③ 自由对话 |
| M3-5 | **实时输出** | SSE 渲染；断线自动重连并回放尾部，不丢行 |
| M3-6 | 历史回看 | `transcript`，未运行实例也能看历史（≤1000 行） |
| M3-7 | 与实例对话 | `POST /jobs/:id/reply`，多行输入 + 快捷指令，发送即回显 |
| M3-8 | 暂停/恢复/重启/删除 | stop / respawn / resume / delete；删除二次确认，`{deleted:false}` 如实展示原因 |
| M3-9 | **多实例不串线** | 每实例独立 SSE 与滚动位置；切换不影响其他流 |
| M3-10 | 阻塞态醒目提示 | `blocked` 高亮 + 顶部汇总「N 个实例等你回复」 |
| M3-11 | 内嵌终端（可选） | PTY，与实例对话区分，不混用 |
| M3-12 | **接口对齐后继续流程** | 更新 `story-input.json` sources → 按当前 Harness start skill 刷新输入并重判门控 → 继续当前合法 Phase；不得重复创建 Story 或盲目再次 start。**必须提醒回填不可跳过** |
| M3-13 | Harness 状态只读 | 绝不写 `e2e-state.json` / `dev-pass.json`；推进一律通过给实例发指令 |
| M3-14 | 待确认项 surfaced | 读 `open-questions.json`，未 `confirmation` 的项上看板；**站点不替用户确认** |
| **M3-15** | **Phase 4-6 联动** · v2 | 进入 Phase 4 提示「MR 待创建/待合并」并给 GitLab 直达；Phase 6 展示构建进度与部署 URL |
| M3-16 | 同一 storyId 多模式轮次 | `run` / `fixbugs` 各轮模式固定；活动 Story 不允许切换模式；手动跨模式仅在当前轮终态后，经用户确认归档并用同一 storyId 新建目标模式轮次 |
| **M3-17** | **Story 服务按需启动与轮次 Job 隔离** · v2.6 | 工作区创建不启动 CodeBuddy；首次 CodeBuddy 或 cron 操作时后端按 Story 映射惰性启动/接管固定端口服务。每个 TAPD Story 恰有一个长期服务；每个 StoryRound 有独立 Job/session，共用该服务 endpoint/port。浏览器只传 `instanceId`/Story，经后端代理，不可选择上游端口 |
| **M3-18** | **服务监督、恢复与手动生命周期** · v2.6 | 后端监督每个 `--serve` 进程；后端重启时健康检查并接管存活进程，否则同端口重启。意外失败最多重试 3 次（5s/15s/30s），耗尽后标记 failed 并通知。关浏览器、Story terminal 或归档均不停止服务；仅显式手动停止会停止服务并自动暂停关联 cron，恢复时先恢复 cron owner/session 再启用 cron |
| **M3-19** | **Story 服务映射与端口回收** · v2.6 | 端口从 60200 起，在配置范围内分配且上限≤65535（默认 65535）；映射保存端口并持续预留至映射显式删除，冲突/耗尽报错，不偷偷改映射或复用端口。删除须二次确认，先删除关联 scheduled task、再停止服务、最后移除映射并释放端口；若任务删除失败，保留映射/端口且报告失败，StoryRound 历史始终保留 |

### M4 · 定时任务管理

| # | 需求 | 验收标准 |
|---|---|---|
| M4-1 | 任务列表 | 合并 API 与本地 `scheduled_tasks.json`；**首行显示需求中文标题** |
| M4-2 | 任务类型标识 | 标注「只查」/「查询+修复」；意图不清默认只查，自动修复任务用警示色并展示完整副作用 |
| M4-3 | **修改轮询间隔** | `PATCH {cron}`，不删不建；提供 20/30/60 分钟预设 |
| M4-4 | **cron 避开 0 分与 30 分** | 20 分钟→`7,27,47 * * * *`；30 分钟→`11,41 * * * *`；60 分钟→`13 * * * *`；自定义时拦截含 0/30 分 |
| M4-5 | 启用 / 暂停 | `PATCH {enabled:false,sessionId}`，暂停不删除 |
| M4-6 | **同一需求只保留一个启用任务** | 每个 TAPD Story 最多一个启用 cron；创建前检测 Story 映射，命中则展示旧任务 id/cron/prompt 前 50 字；用户确认后才替换，避免并行 cron。每个 Story 同时最多一个 active StoryRound，轮次模式固定 |
| M4-7 | 创建任务 | `tapd-bug-cron` skill 创建该 TAPD Story 唯一的 durable scheduled task，并绑定专属 `agentId`/cron-owner session；该 owner 与各 StoryRound Job/session 不同。站点不自拼 prompt 或直接 POST 创建 |
| M4-8 | **修复任务一次性授权** | 创建「查询+修复」任务前确认完整副作用：代码修改、TAPD 评论/状态回写、7 Phase 后续提交/MR、知识库更新、dev 构建部署，以及终态归档并以同一 storyId 开启新轮；授权适用于后续各轮 |
| M4-9 | 持久化与有效期 | 默认 `durable:true`，30 天；显示到期时间 |
| M4-10 | `.gitignore` 提醒 | 提醒把 `.codebuddy/` 加入 gitignore，**不擅自修改** |
| M4-11 | 执行记录 | 展示 CodeBuddy API 返回的执行时间、结果与 runId |
| M4-12 | 流程产物 | 按 Harness Story 展示 `bug-list.json` 与 `{需求标题}_bug分析报告.md` |
| M4-13 | **Harness 活跃流程状态** | 只读展示 `.codebuddy/plans/.harness-active` 对应的 Story 与 Phase；站点不创建、清理或接管 Harness 状态 |
| M4-14 | Bug 状态可视化 | 解析 Harness `bug-list.json`：bug_id / TAPD 状态 / 分诊分类 / 评论摘要 / 回写状态 |
| M4-15 | **待确认项入口** | 展示 Harness `open-questions.json` 未确认项，并跳转到对应实例供用户回复；后续由 Harness 门控推进，站点不直接修改流程状态 |
| M4-16 | 状态推进边界 | 站点只展示待确认项并向实例发送用户答复；**不写 Harness 状态文件或 Bug 流程产物** |
| M4-17 | 活跃流程提示 | Harness 已有未终态 Story 时展示 Story / Phase；cron 按 Harness 规则跳过本轮并记录原因，不并发启动或切换模式 |
| M4-18 | sessionId 绑定 | cron 使用 Story 映射中的专属 owner `agentId`/sessionId，不复用 StoryRound 会话；恢复服务时先恢复该 owner/session，再重新启用 scheduled task |
| **M4-19** | **同 storyId 定时多轮** · v2.5（待增强） | 查询+修复模式每轮先查 TAPD：无匹配 Bug 时仅报告、不归档；有匹配 Bug 且当前 Story 未终态时跳过；有匹配 Bug 且当前轮已 terminal 时，目标行为是归档至 `archive/round-N/`，再以相同 storyId 新建独立 fixbugs Job 并发送 `/start fixbugs <storyId>`；无当前轮时直接启动。只查模式永不归档。归档成功但启动失败时保留归档、记录并报告失败；下个周期先重读 Harness 状态，再决定重试/跳过。**终态自动归档/重启及 dispatch 到新轮次 Job 当前均非已安装 `tapd-bug-cron` skill 能力，属于待增强插件/skill，不得视为现有行为** |
| **M4-20** | **cron owner dispatch 与停机语义** · v2.6（目标行为；dispatch 待增强） | 每次匹配的查询+修复运行由专属 owner 经控制台后端 dispatch；后端在该 Story 服务上创建独立轮次 Job，再发送 `/start fixbugs <storyId>`。**此 dispatch-to-round-job 流程当前非已安装 `tapd-bug-cron` skill 能力，须作为待增强项实现，不是现有行为。**查询-only 只查询并报告。手动停止服务自动暂停 cron；非预期停机时跳过错过/排队的运行，不追赶补跑；Story terminal/归档不自动停服务 |
| **M4-21** | **显式删除 Story 映射** · v2.6 | 二次确认后删除关联 scheduled task、停止 Story 服务、移除映射并释放端口；task 删除失败时不继续移除映射或释放端口并报告失败；删除操作不删除任何 StoryRound/archive 历史 |
| **M4-22** | **cron 与 owner session 一对一** · v2.7 | 每个 scheduled task 绑定一个持久 owner `agentId`/`sessionId`；同一任务的多次触发复用 owner，不为每次触发新建 owner session。每个 Story 当前最多一个启用 cron，因此多个 Story 的 cron 分别有各自 owner session；同 Story 的第二个启用 cron 仍按 M4-6 替换确认规则处理。未来若放宽为同 Story 多个 cron，每个 task 仍独立绑定 owner，禁止多个 task 共用会话上下文 |

**Cron session 管理原则**：
- **owner session 是任务身份，不是单次执行记录**：由稳定的 `taskId → ownerAgentId/ownerSessionId` 关联；后端持久化映射，重启后按 `sessionId` 恢复，确认恢复成功后再启用 scheduled task。prompt 不依赖此前对话上下文。
- **每次触发不额外创建 owner session**：执行时间、结果与 `runId` 记在 `Execution`；查询+修复由 owner dispatch 到独立的 `StoryRound` Job/session。各轮执行会话与 owner 分开，避免任务调度上下文和修复对话混在一起。
- **多任务的数量边界**：多 Story 的定时任务意味着多个 owner session；本规格目前限制每个 Story 最多一个启用 cron。若未来确需同 Story 多任务，则是每个 task 一个 owner session，而不是一个 Story 共用一个 owner。
- **启停与清理**：暂停保留 task-owner 绑定以便恢复；替换/删除 task 时先成功停用或删除旧 scheduled task，再解除活动绑定并将 owner 标记为归档。`Execution` 和 owner transcript 默认保留；只有用户显式确认后才清理 owner session。删除 task 失败要保留映射并报错，不能静默创建新 owner。删除 Story 映射仍遵循 M4-21，且不删除 StoryRound/archive 历史。

**取舍**：每 cron 一个持久 owner session 能隔离任务上下文、清楚归属执行记录，也便于单独暂停、恢复和排障；代价是 session 数随 cron 数增长，需要持久化映射和明确清理流程。多个 cron 共用 session 可减少会话数量，但会增加上下文串扰、并发冲突和审计归因难度；每次触发都新建 session 则会造成会话膨胀、恢复与历史管理复杂，因此都不作为默认方案。

### M6 · 发布与部署 · v2 新增

| # | 需求 | 验收标准 |
|---|---|---|
| M6-1 | **MR 看板** | 按需求列出 MR（`source_branch=feat/<工作区名>` → `dev`），显示标题、状态、审批状态、变更文件数、链接 |
| M6-2 | MR 详情 | 变更文件清单、diff 摘要、审批人、是否已合并、合并时间 |
| M6-3 | **未合并阻断提示** | Phase 4 要求「确认已合并」才能进 Phase 5；未合并时需求卡标红并提示卡点 |
| M6-4 | 应用映射管理 | 仓库名 ↔ DevOps 应用名 ↔ 分组（默认 `JenkinsFrontweb`），可编辑，首次人工确认 |
| M6-5 | 分支列表 | `get-branches`，显示 `origin/xxx` + `commit_id` + 最后提交时间 |
| M6-6 | **构建记录** | `get-records` 分页；显示构建号、分支、commit、时间、成功与否、耗时、操作人、制品 URL |
| M6-7 | 触发构建（兜底） | 选 group/app/branch/env/buildType/buildOther → `POST /deploy/build`；**默认只开放 dev / test** |
| M6-8 | **pre / prod 护栏** | pre/prod 默认禁用，需显式解锁 + 二次确认 + 写审计；解锁状态不持久化，每次重新确认 |
| M6-9 | **构建冲突处理** | 提交前检查是否有进行中构建；命中「上一任务尚未完成」时给「查看进度 / 停止构建」入口，不盲目重试 |
| M6-10 | 停止构建 | `get-build-stop`，二次确认，显示结果 |
| M6-11 | **多应用批量发布** | 收集本需求各应用的 `file_url` → `get-deploy-multiple(urls, env, force, timeout)`；发布前逐项列出应用与制品，确认后才提交 |
| M6-12 | **reopened 诊断线索** · v2.4 | 展示 TAPD 评论、工作区改动、MR 状态、Harness Phase 与最近构建记录及其更新时间；只提供人工诊断线索，不判定真假复现、不阻断或重跑 Harness |
| M6-13 | 部署 URL 展示 | Phase 6 产出的部署地址挂在需求卡，一键打开对应环境 |
| M6-14 | **凭据过期处理** | 403 时明确提示「DevOps 会话已过期」，给出从浏览器开发者工具重新获取四个值的指引；**熔断该通道停止轮询**，刷新后恢复 |
| M6-15 | **特殊分支逻辑** | `live-h5-2` 按环境自动选分支（test→`origin/test_*`，dev→`origin/dev_*`，pre→`origin/pre2`）；站点复刻或透传，**不自己猜分支** |
| M6-16 | **写操作硬边界** · v2.2 升级 | **Harness Phase 4-6 期间，站点所有发布写操作（触发构建 / 创建 MR / 批量发布 / 停止构建）直接禁用**，按钮置灰并提示「Harness 正在执行 Phase N，由发布助手负责」。仅当流程处于该区间之外才开放手动兜底，且需二次确认 + 审计 |
| M6-17 | 提测动作 | 「提测」= 选 test 环境构建 + 部署 + 本地标记；**是否回写 TAPD 状态待确认（R4）**，默认只标记不写 |

### M5 · 支撑能力

| # | 需求 | 验收标准 |
|---|---|---|
| M5-1 | **连接自检页** | 逐项检测：Story 服务映射/端口健康与后端监督状态（不做 CodeBuddy 密码鉴权）、TAPD token、**GitLab PAT**、**DevOps 会话（403 即判过期）**、工作区根可读写、脚本存在；每项给失败原因与修复建议 |
| M5-2 | 配置管理 | CodeBuddy 端口分配起点与上限（上限≤65535）、TAPD workspace_id、处理人昵称、源/目标根、默认轮询周期、**GitLab 地址与目标分支**、**DevOps 分组与默认环境**；凭据掩码显示 |
| M5-3 | **操作审计** | 所有写操作（建工作区、起实例、改 cron、删任务、下发指令、**触发构建、发布、停止构建**）记录时间、动作、参数、结果 |
| M5-4 | 危险操作护栏 | 站点自身不执行 git 写与依赖变更；bash 型 job 下发命令时做关键字提示（commit/push/rm/install） |
| M5-5 | 离线降级 | 任一通道不可达时显示缓存 + 明确「离线」标识，不白屏、不假报成功 |
| M5-6 | 键盘效率 | `/` 搜索、`⌘K` 命令面板（跳需求/起实例/改 cron/触发构建）、`Esc` 关闭抽屉 |
| **M5-7** | **站点自身鉴权** · v2.2（G1） | 后端聚合 TAPD token、GitLab PAT、DevOps 会话，并代理无密码认证的 CodeBuddy 高权限 API。绑 127.0.0.1 不等于安全；启动时生成控制台本地 token，前端首次访问注入，所有控制台 `/api` 校验。该 token 不会保护 CodeBuddy 上游端口，本机任何进程仍可访问其执行/文件 API |
| **M5-8** | **长任务失败恢复** · v2.2（G2） | 每个长任务（npm install / graphify / 构建）落盘进度文件（阶段、已完成仓库、时间戳）。进程重启或中断后可从断点续跑，而不是从头重来。这是个人工具的生死线 |
| **M5-9** | **磁盘占用可见** · v2.2（G3） | 看板显示各工作区占用（worktree + node_modules + graphify-out）。40+ 仓库 × N 个并行需求会迅速吃满磁盘。提供「归档 + 清理」引导，**不自动删除** |
| **M5-10** | **效果度量** · v2.2（G4） | 第一版就记录：需求分配→提测时长、reopened 诊断后的人工处理结果、每周手动操作次数。没有基线就无法判断这个站点值不值得继续投入 |
| **M5-11** | **统一快照时刻** · v2.2（G5） | 五条通道刷新策略不同，看板会出现「TAPD 3 个 bug + 本地 5 个 + 构建 10 分钟前」的混合时刻。引入统一 `snapshotAt`，跨通道数据标注是否同一时刻，避免基于过期数据做决策 |

### M7 · 收件箱 · v2.2 新增（评审首推形态）

> 评审结论：单人工具的核心问题是「**现在该我做什么**」，不是「所有东西的状态」。全量看板大部分时候是噪音。
> 收件箱与看板共享同一份聚合快照，是同一数据的两种投影，不是两套数据。

| # | 需求 | 验收标准 |
|---|---|---|
| M7-1 | 只聚合需要人决策的事项 | 五类：实例 blocked、Bug 待人工确认、reopened 打回、MR 待合并、构建失败；外加 DevOps 凭据临期预警。其余一律不进 |
| M7-2 | 每项给出原因 + 一键动作 | 动作必须跳到**能真正解决它**的界面：去回复 Harness 实例 / 查看 reopened 诊断 / 去看 MR / 看构建记录 |
| M7-3 | 处理即消失，可撤销 | 标记已处理后从列表移除，5 秒内可撤销；不做软删除堆积 |
| M7-4 | 空态有明确文案 | 清空后显示「现在没有需要你决策的事」，而不是空白或「暂无数据」 |
| M7-5 | 顶部四项统计 | 待决策数、高优先级数、实例运行中、今日已处理 |
| M7-6 | 与看板共享快照 | 切到收件箱不触发取数；同一需求在两个视图中的状态完全一致 |
| M7-7 | 作为默认首屏 | 打开站点先看到「该我做什么」，需要全局时再切看板 |

---

## 5. 数据模型

> 站点本地只存**缓存与关联关系**，不存业务真相。

| 实体 | 关键字段 | 来源 |
|---|---|---|
| `Requirement` | storyId, title, tapdUrl, status, priority, owner, iterationId, iterationName, releaseId, bugTotal, bugNew, bugReopened, fetchedAt | TAPD |
| `Iteration` | id, name, startdate, enddate, status | TAPD |
| `Bug` | id, title, status, current_owner, severity, created, module, storyId | TAPD |
| `BugAnalysis` | bugId, triage, commentDigest, writeback, status | Harness `bug-list.json` |
| `Workspace` | name, path, repos[], branch, baseBranch, workspaceFile, initStatus{}, createdAt | 本地扫描 + 脚本 |
| **`StoryService`** · v2.6 | tapdStoryId, harnessStoryId, serviceInstanceId, endpoint, port, cwd, pid, health, supervisorStatus, cronOwnerAgentId, cronOwnerSessionId, cronTaskId, reservedAt | 控制台持久映射 + 后端进程/健康检查 |
| `Instance` | jobId, name, cwd, state, status, tempo, alive, settled, sessionId, webUrl, tapdStoryId, harnessStoryId, serviceInstanceId, round | Story 服务上的 CodeBuddy Job |
| `CronTask` | id, ownerAgentId, ownerSessionId, cron, promptFirstLine, mode(query_only/query_fix), enabled, durable, expiresAt, tapdStoryId, harnessStoryId, nextRun | `tapd-bug-cron` skill + CodeBuddy |
| `Execution` | cronId, startedAt, finishedAt, result, runId, reportPath | executions + API |
| `PhaseState` | storyId, phase, status, phases{}, fixLoopCount | `e2e-state.json` |
| `HarnessActive` | storyId, phase, status | `.codebuddy/plans/.harness-active` + `e2e-state.json`（只读） |
| `StoryRound` | storyId, round, mode(run/fixbugs), status, jobId, sessionId, serviceInstanceId, archivePath, startedAt, terminalAt | 当前 Story 状态 + CodeBuddy Job + `archive/round-N/`；归档历史持续保留 |
| **`MergeRequest`** · v2 | iid, projectId, title, sourceBranch, targetBranch, state, mergeStatus, approvals, changesCount, webUrl, mergedAt | GitLab |
| **`BuildRecord`** · v2 | id, app, group, number, branch, commitId, buildDate, succeed, durationTime, fileUrl, operator | DevOps |
| **`Deployment`** · v2 | env, app, commitId, buildNumber, deployedAt, url | DevOps + Phase 6 产出 |
| **`AppMapping`** · v2 | repoName, devopsApp, group, specialBranchRule | 人工确认 + 配置 |
| `AuditLog` | ts, action, target, params, result | 站点自产 |
| **`Snapshot`** · v2.2 | snapshotAt, channels{id:{fetchedAt,ok,stale}}, reqs[], bugs[], jobs[], crons[], builds[], mrs[] | 聚合器产出，三视图共用 |
| **`JobProgress`** · v2.2 | jobId, kind(install/graphify/build), stage, doneRepos[], startedAt, updatedAt, resumable | 长任务落盘，支持断点续跑 |
| **`DiskUsage`** · v2.2 | workspacePath, worktreeBytes, nodeModulesBytes, graphifyBytes, totalBytes, scannedAt | 本地扫描 |
| **`Metric`** · v2.2 | storyId, assignedAt, testedAt, reopenCount, reopenOutcomes[], manualOps | 站点自产；reopenOutcomes 记录用户确认的诊断结论 |

**关联主键**：稳定的 Harness `storyId` 是流程主线，与 TAPD `storyId` 分开存映射。一个 StoryService mapping 持久关联 TAPD storyId / Harness storyId / serviceInstanceId、endpoint/port、cwd、PID/health、专属 cron owner agent/session/task；端口在 mapping 显式删除前一直 reserved。每个 StoryRound 独立关联其 Job/session 与服务。工作区通过 `plans/<storyId>/` 反查；同一 storyId 下按轮保存 `run` / `fixbugs` 历史，映射删除不删除这些归档；**MR 通过 `source_branch=feat/<工作区名>`，构建通过 `AppMapping`**。

> ⚠️ 两个脆弱关联：① cron 无 storyId 字段，**必须通过 StoryService mapping 维护 TAPD/Harness storyId ↔ owner/task ID 关系，不得依赖 prompt 标题**；② 仓库名与 DevOps 应用名不一定一致 → **必须维护 `AppMapping`，首次人工确认**。

---

## 6. 状态机

### 需求生命周期（稳定 storyId，多轮模式固定）

```
需求输入 → Harness agent 指定并固定 storyId（与 TAPD ID 建映射）
  ├─ Round N: run      → Phase 0-6 → terminal
  └─ Round N: fixbugs  → Phase 0-6 → terminal
                       ↓ 归档至同一 Story 的 archive/round-N/
       下一轮按目标模式重启；run / fixbugs 不在轮内互相切换
```

手动跨模式：当前轮 terminal 后提示并经用户确认归档，再用同一 storyId 启动目标模式。定时自动修复：只查模式永不归档；查询+修复无匹配 Bug 时报告且不归档，有匹配 Bug 但当前流程非终态时跳过；有匹配 Bug 且 terminal 时的目标行为是归档并以相同 storyId 新建 fixbugs Job（归档成功而启动失败则保留归档并报告，下周期重读状态）。**terminal 自动归档/重启及 dispatch 到新轮次 Job 当前未被已安装 `tapd-bug-cron` skill 支持，均为待增强能力，不是现有行为。**

### Story 服务与 cron 生命周期

```
首次 CodeBuddy / cron 动作
  → 后端读取 TAPD Story ↔ Harness storyId ↔ serviceInstanceId 映射
  → 新 Story：分配并持久化端口（60200 起）；已有 Story：原端口健康检查/接管
  → 后端启动并监督该 Story 唯一的 --serve 服务
  → 用户操作创建 StoryRound 专属 Job/session；cron task 则由独立 owner agent/session 持有
  → 匹配的查询+修复 cron 经后端 dispatch 创建新轮次 Job，发送 /start fixbugs <storyId>
```

显式手动停服务会先自动暂停 cron；恢复服务时恢复 owner/session 后再启用 cron。服务意外停机期间跳过错过及排队运行，不追赶补跑。terminal/归档不停止服务。显式删除 mapping 必须先删除关联 task、再停止服务、最后释放端口；task 删除失败时保留 mapping/端口，StoryRound 历史始终保留。

### Bug 双状态对照

| TAPD 状态 | Harness 缺陷记录 | 站点显示 | 流程处理 |
|---|---|---|---|
| new | 未纳入当前 Story | 待处理 | 由用户启动 Harness fixbugs 或等待 cron |
| new | `bug-list.json` 已记录 | 显示 Harness 分诊 / 回写结果 | 由 Harness 门控决定 |
| **reopened** | Harness fixbugs 分析中 | **测试打回 · 展示评论摘要与分析进度** | 由 Harness fixbugs 决定 |
| 任意 | `open-questions.json` 有未确认项 | 阻塞 · 等用户在 Harness 实例答复 | Harness 收到答复后继续 |

### reopened 的诊断视图（只读）

> 需求开发与 Bug 修复均由 Harness 7 Phase 流程管理。定时任务触发 fixbugs 后，后续提交/MR、知识库更新与构建部署按 Harness Phase 4-6 执行；站点只读展示实际的工作区、MR 与构建状态，不假定修复一定未提交或一定已部署。

```
reopened
 ├ 展示 TAPD 评论与 Harness bug-list 中的 commentDigest
 ├ 展示工作区未提交改动（git status）
 ├ 展示 MR 合并状态与关联构建记录
 └ 展示 Harness 当前 Story / Phase；由用户或 Harness fixbugs 决定后续处理
```

> ⚠️ DevOps 只能查构建记录，查不到「当前部署版本」。构建成功 ≠ 已部署，因此环境滞后只能作为疑似线索；该诊断视图不得取代 Harness 流程判断。

---

## 7. 非功能需求

| 类别 | 要求 |
|---|---|
| 安全 | 凭据只存后端，前端永不见明文；服务只绑 `127.0.0.1`；所有写操作二次确认；**pre/prod 默认禁用** |
| **站点鉴权** · v2.2 | 后端是本机最高权限聚合点，**必须有自己的本地 token**，不能因为绑了 loopback 就裸奔（G1） |
| **CodeBuddy 上游信任边界** · v2.6 | 每 Story 服务按确认设计使用 `--auth none`；`X-CodeBuddy-Request: 1` 仅为请求标记，非认证。本机任意进程可访问执行/文件 API；控制台 token 与后端代理不改变此风险，不得声称上游已认证 |
| 性能 | 看板首屏 <1s（走缓存）；SSE 推送 <1s；实例列表 100 个不卡 |
| 长任务 | npm install / graphify / 构建均后台执行，超时 ≥600s，进度可见、可中断、可幂等重跑 |
| **Story 服务可靠性** · v2.6 | 控制台后端监督每个 `--serve`；重启时同端口健康检查/接管；意外故障最多重试 3 次，间隔 5s/15s/30s，耗尽通知并标记 failed；浏览器关闭无影响 |
| **失败恢复** · v2.2 | 每个长任务落盘进度，进程重启/中断后**从断点续跑**；SSE 断线重连后回放尾部不丢行（G2） |
| 可靠性 | SSE 断线重连；文件监听失效降级轮询；**DevOps 403 熔断不空转**；任何外部失败都不假报成功 |
| **数据一致性** · v2.2 | 三视图共享同一 `snapshotAt`；跨通道数据标注是否同一时刻；切视图不重新取数（G5） |
| **磁盘** · v2.2 | 工作区占用可见；归档与清理分离，清理必须二次确认，不自动删（G3） |
| **度量** · v2.2 | 记录分配→提测时长、reopened 诊断后的人工处理结果、手动操作次数，用于判断工具是否真的省时间（G4） |
| 可观测 | 每块标注来源与更新时间；错误显示原始报错而非「操作失败」 |
| 可维护 | 查询口径、cron 规则、Harness 启动提示词模板、应用映射集中配置 |
| 边界 | 不写 Harness 状态文件或 Bug 流程产物；不自建修复锁/指纹/状态机；**Phase 4-6 期间发布写操作硬禁用** |

---

## 8. 交付顺序 · v2.2 重排

> **评审结论**：原 S1 就要三条直连 + 本地扫描 + 14 条看板需求 + 环境核对，是 2-3 周的量。
> 个人工具最常见的死法是做到一半弃坑。因此改为**双轨**：先用约 20 条做出一个一周内能跑起来、立刻有用的最小闭环，再按依赖长肉。
> **核心原则：聚合器是资产，渲染层是可抛弃的。** 先把「聚合」这个真正的价值做出来，即使 UI 形态选错，核心投入也不浪费。

### 8.1 精简 MVP（约 20 条 · 目标一周）

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| **A · 聚合器**（3-4 天） | ① Node 服务 + 本地 token 鉴权 + 连接自检页；② TAPD 走 MCP、GitLab/DevOps 走 REST，**全部只读**，含 403 熔断与离线降级；③ 本地状态扫描（`e2e-state.json` / `scheduled_tasks.json` / Harness Story 产物 / `.codebuddy/plans/.harness-active`）+ chokidar；④ 产出统一快照 `state.json`（带 `snapshotAt`） | 一个 JSON 里能拿到六源状态；任一通道挂掉不影响其余 |
| **B · 收件箱 + 看板**（2-3 天） | ⑤ **M7 收件箱全部 7 条**（默认首屏）；⑥ M1 精简六条：需求列表、Bug 徽标、阶段进度条、四向关联、搜索筛选、新鲜度标识；⑦ **M6-12 reopened 诊断视图（只读）** | 打开就知道「该我做什么」；reopened 能查看关联诊断信息 |
| **C · 三个按钮**（1-2 天） | ⑧ 起实例 + 发指令（M3-3 / M3-7 精简版）；⑨ 改 cron 间隔 + 启停（M4-3/4/5，PATCH 不删建）；⑩ ⌘K 命令面板 | 高频操作不用离开网页；改间隔不删建任务 |

**MVP 明确不含**：工作区初始化表单、SSE 完整流、Harness 阻塞项回复入口、发布写操作、审计、磁盘与度量。这些进扩展轨。

### 8.2 扩展轨（MVP 跑通后按依赖推进）

| 阶段 | 内容 | 前置 |
|---|---|---|
| **S3 实例管理完整** | SSE 实时流、多实例不串线、暂停/重启/恢复、接口对齐二次 start（M3 全部） | MVP-C |
| **S4 工作区初始化** | 脚本编排、后台长任务 + 断点续跑、结果复核表、应用映射（M2 全部） | MVP-A |
| **S5 定时任务完整** | 执行记录、Harness fixbugs 产物与活动流程状态展示、待确认项跳转（M4 全部） | **按 R18 验收 Story 服务与 cron owner 生命周期** |
| **S6 发布写操作** | 触发构建、批量发布、停止构建、提测动作、prod 护栏（M6 剩余） | **R16 / R17 确认通过** |
| **S7 打磨** | 审计、磁盘占用、效果度量、失败恢复完善、离线降级、键盘导航 | 前面各阶段 |

> **为什么 reopened 诊断视图放进 MVP**：它只读已有数据、不需新增接口，可快速查看 Harness 已有产物与发布链路状态。
>
> ⚠️ **前置阻塞**：R18 的多 `--serve` 本机 CLI 验证已通过，拓扑与 cron owner 设计已确认；S5 实现仍须通过 R18 验收清单。S6 仍依赖 R16 / R17 确认，未确认前不要动发布写操作。MVP 不受这两项阻塞，可以立即开工。

---

## 9. 风险与验证

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| R1 | **Story 服务拓扑** · v2.6（已确认） | 需固定端口映射并监督多个服务 | 每个 TAPD Story 一个长期 `--serve`；本机 CLI 已验证多端口服务可并行。禁止用 `codebuddy daemon start` 分配端口（其幂等行为返回现有 daemon）；按 M3-17/18 实现 |
| R2 | **cron owner session 持久性** · v2.6 | scheduled task 绑定 `sessionId`；服务重启时 owner 不可丢 | Story mapping 持久化专属 `agentId`/owner session/task；恢复先恢复 owner/session，再重新启用任务，按 R18 验收 |
| R3 | **TAPD token 权限**：能否读迭代/版本/评论 | 影响 M1-4、M4-15 | 自检页逐项探测，缺权限降级 |
| R4 | **提测是否写回 TAPD** | 现有 skill 明确不自动改状态 | 建议遵守：只做本地标记 + 提醒，状态由人在 TAPD 改 |
| R5 | **cron 与 Story 关联** | prompt 标题改了会失联 | 由 Story mapping 保存 TAPD storyId/Harness storyId/service instance 与唯一 cron owner/task 关系，不依赖 prompt 标题 |
| R6 | **多仓库需求** | Harness 有 `repos.json`，工作区多根 | M2 支持多仓库勾选；M1 展示 primary + repos |
| R7 | **Figma / 原型链接** | `story-input.json` sources 决定是否触发硬门控 | M3-12 表单一并支持录入，避免漏填 |
| R8 | **worktree 清理** | 需求完成后目录堆积 | 本期只做归档标记，删除走脚本 + 二次确认 |
| **R9** | **DevOps 会话过期** · v2 | cookie/sessionid 失效即 403，无法自动续期 | 自检 + 熔断 + 刷新引导；这是运行期最常见的故障 |
| **R10** | **仓库名 ↔ 应用名不一致** · v2 | 构建/发布找错应用 | `AppMapping` 首次人工确认，不猜 |
| **R11** | **`live-h5-2` 特殊分支** · v2 | 自己猜分支会发错 | 复刻或透传 MCP 逻辑 |
| **R12** | **构建冲突「上一任务尚未完成」** · v2 | 盲目重试会一直失败 | 提交前检查 + stop 入口 |
| **R13** | **误发 prod** · v2 | 生产事故 | 默认禁用 + 显式解锁 + 二次确认 + 审计 |
| **R14** | **GitLab PAT 权限范围** · v2 | 白名单外能力不可用 | 站点能力不得超出 `GITLAB_ALLOWED_TOOLS`；直连同样受 PAT 权限约束 |
| **R15** | ~~修复提交如何确定~~ **已调整** · v2.4 | 原方案假设 cron 改动始终留在工作区；Harness fixbugs 会按 7 Phase 流程推进，提交与发布状态以实际产物为准 | 不自行推断修复提交；聚合 Harness Story、GitLab MR 与 DevOps 构建事实 |
| **R16** 🔴 | **DevOps 查不到「当前部署版本」** · 阻塞 | 7 个工具只有构建记录，无部署状态查询；构建成功 ≠ 已部署 | **开工前确认**平台是否有部署记录接口；没有则只能展示疑似环境滞后，不得表述为确定结论 |
| **R17** 🔴 | **dev 与 test 的关系未定义** · 阻塞 | Harness Phase 6 用 `env=dev`，而提测写的是 `test` | **开工前确认**：dev 即测试环境？还是两套？按应用不同？不确认则发布链按钮全错 |
| **R18** | **服务/cron 生命周期验收** · v2.6 | 持久端口、进程接管、专属 owner 恢复、停机暂停与跳过 missed run 必须保持一致 | 本机 CLI 已实测多个不同端口的 `codebuddy --serve` 可并行；实现验收：① 使用精确启动参数且端口稳定；② 后端重启可健康检查/接管；③ 杀掉服务后仅重试 3 次并按 5/15/30s 间隔通知失败；④ 手动停止暂停 cron、恢复 owner/session 后重启 cron；⑤ 非预期停机不补跑；⑥ 映射删除失败时端口仍保留。`codebuddy daemon start` 不适用于多 Story 端口 |
| **R19** | **CodeBuddy 无认证的本机风险** · v2.6（已接受） | 本机任意进程可能调用服务的执行/文件 API；请求 Header 不是认证 | 如实展示信任边界；不擅自增加密码认证；控制台代理仅用于映射与限制浏览器选端口，不宣称能隔离本机进程 |

> 🔴 **R16 / R17 仍是发布写操作的开工前阻塞项**。R18 拓扑与本机 CLI 验证已确认，但 M4 实现必须通过其生命周期验收；不再作为尚待决策的开工阻塞。其余风险可在开发中逐步收敛。

---

## 10. 技术栈选型 · v2.1 新增

### 10.1 选型依据：本机环境与日常栈（已实测）

| 项 | 实测值 | 对选型的影响 |
|---|---|---|
| Node | **v22.20.0** | 内置 `fetch`、`node:sqlite`，无需额外依赖 |
| 包管理 | npm 10.9.3 / **pnpm 11.22.0** | 用 pnpm workspace 组织 monorepo |
| Shell | **PowerShell 7.6.10（pwsh）** | 与 `create-workspace.ps1` 要求一致 |
| 日常项目栈 | **Vue 3 + Vite + Element Plus + Pinia + vue-router + axios + echarts**（ESM，配 unplugin-auto-import） | **前端直接沿用，零学习成本** |
| 工具链运行时 | CodeBuddy / MCP / graphify 全是 Node | 后端选 Node，不引入第二套心智 |

**核心原则：贴着你已有的技能走，不推一套你还得学的。**

### 10.2 后端

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Node 22 + TypeScript + ESM** | 与 CodeBuddy、MCP 同运行时；MCP 官方 SDK 的 TS 版最完整 |
| Web 框架 | **Fastify 5** | Schema 校验内置、SSE 直接写 `reply.raw`、pino 日志自带、TS 支持好 |
| MCP 客户端 | **`@modelcontextprotocol/sdk`**（StdioClientTransport） | 复用 `mcp.json` 里的 TAPD server，**凭据只有一份、查询口径天然一致** |
| HTTP 客户端 | **原生 fetch** | Node 22 内置，后端无需 axios |
| 文件监听 | **chokidar** | Windows 上比 `fs.watch` 可靠；监听 `e2e-state.json` / Harness Story 产物 / `.codebuddy/plans/.harness-active` |
| 子进程 | **`node:child_process` spawn pwsh** | 跑 `create-workspace.ps1`，流式收 stdout，超时自管（≥600s） |
| 存储 | **v1：JSON 文件 + 内存 Map**；审计与历史用 **`node:sqlite`** | Node 22 自带 SQLite，零安装零运维；若嫌实验特性不稳，退 `better-sqlite3` |
| 校验 | **zod** | 与 MCP server 同一套；放 shared 包，前后端共用推导类型 |
| 日志 | **pino** | Fastify 默认，结构化便于排查 |
| 凭据 | **运行时读 `~/.codebuddy/mcp.json`** | 不复制到站点，避免双份管理与过期不同步 |
| 长任务 | **内存 job registry + 落盘进度 JSON** | 单用户单进程，不需要 Redis / BullMQ |

**取数通道分工（按评审 A1 修正）**：

| 通道 | 方式 | 理由 |
|---|---|---|
| TAPD | **走 MCP** | 口径最复杂（`owner` 恒空、`id` 放 options、limit 截断、状态英文 key），复用已踩平的 skill 口径 |
| GitLab | **直连 REST** | 接口标准简单，PAT 鉴权直接 |
| DevOps | **直连 REST** | 7 个端点明确，Cookie + CSRF 直接拼 |
| CodeBuddy | **控制台后端代理 Story HTTP API** | 每 Story 一个由后端监督的 `--serve`；浏览器不直连、不选端口 |
| 本地文件 | **直接读 + chokidar** | 只读 |

### 10.3 前端

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | **Vue 3 + Vite + TypeScript** | 你的日常栈 |
| UI 组件 | **Element Plus** | 项目里已在用，组件肌肉记忆直接复用；暗色密集风格用 CSS 变量覆盖 |
| 状态 | **Pinia** | 已在用 |
| 路由 | **vue-router** | 页面少，常规用法 |
| 原子 CSS | **Tailwind CSS** | 使用成熟的 utility-first 样式体系；与 Vue/Vite 配合，和 Element Plus 分工，不再引入 UnoCSS |
| 实时流 | **原生 EventSource** | 需带鉴权头时改用 fetch + ReadableStream |
| 长输出虚拟化 | **@tanstack/vue-virtual** | agent 输出上千行，不虚拟化会卡 |
| 终端 | **xterm.js + addon-fit** | 接 CodeBuddy PTY 接口 |
| Markdown | **markdown-it + shiki** | 渲染 Harness Bug 分析报告与 Story 产物 |
| Diff | **diff2html** | 看 MR 变更，比 monaco 轻一个量级 |
| 图表 | **echarts** | 已在用，做度量趋势 |

### 10.4 工程组织

```
devtask-console/
├── apps/
│   ├── server/              # Fastify + MCP 客户端 + 状态聚合器 + 命令执行器
│   │   ├── src/
│   │   │   ├── channels/    # tapd(mcp) / gitlab(rest) / devops(rest) / codebuddy / localfs
│   │   │   ├── aggregator/  # 六处状态 → 统一快照
│   │   │   ├── executor/    # pwsh 长任务、job registry、进度落盘
│   │   │   └── routes/      # REST + SSE
│   │   └── package.json
│   └── web/                 # Vue3 + Vite
│       ├── src/
│       │   ├── views/       # 看板 / 需求详情 / 实例 / 定时任务 / 发布 / 自检
│       │   ├── components/
│       │   └── stores/      # Pinia
│       └── package.json
├── packages/
│   └── shared/              # zod schema → 推导 TS 类型，前后端契约单一信源
└── pnpm-workspace.yaml
```

| 项 | 约定 |
|---|---|
| 开发 | Vite dev server proxy `/api` → Fastify；Fastify 再按 Story 映射代理 CodeBuddy |
| 生产 | Vite build → Fastify 静态托管，**同源，无 CORS** |
| 端口 | 控制台 **7788**；CodeBuddy Story 服务独立分配 **60200–65535**（范围上限可配置但不得超过 65535） |
| 绑定 | **仅 127.0.0.1** |
| 启动 | pm2（devops 项目已有 `start-pm2.bat`，熟）+ 开机自启 |
| 类型契约 | shared 包 zod schema 推导，前后端不各写一份 interface |

### 10.5 明确不选

| 不选 | 理由 |
|---|---|
| Python / Go 后端 | 工具链全是 Node，MCP 官方 TS SDK 最完整，换语言等于多养一套心智 |
| Nuxt / Next | 本地控制台不是内容站，SSR 零收益，纯 SPA + 本地 API 更简单 |
| Redis / BullMQ | 单用户单进程，内存 registry + 落盘进度足够，上消息队列是自找运维 |
| Electron | 浏览器够用，打包与更新成本无收益。**除非**要托盘通知——那时考虑 Tauri |
| Postgres / MySQL | 单机自用，SQLite 零运维 |
| axios（后端） | Node 22 原生 fetch 够用 |
| monaco-editor | 只读 diff 用 diff2html 就够，monaco 太重 |

### 10.6 安全补充（按评审 G1）

站点后端聚合 TAPD token、GitLab PAT、DevOps 会话，并可通过 CodeBuddy 执行命令、读写文件，**等于本机最高权限点**。每个 CodeBuddy Story 服务都使用 `--auth none`，且监听 `127.0.0.1`；这只限制网络接口，不提供进程级访问控制。本机任何进程都可能访问其执行/文件 API。`X-CodeBuddy-Request: 1` 只是请求标记，不能当作认证；本设计不添加密码认证。控制台自己的 token 只保护控制台 API，不会改变此 CodeBuddy 上游风险。

| 措施 | 说明 |
|---|---|
| 站点自身鉴权 | 启动时生成本地 token，前端首次访问注入；所有控制台 `/api` 校验 |
| 凭据不落前端 | 前端只见掩码，明文永不下发 |
| 凭据存储 | 优先运行时读 `mcp.json`；站点自有配置加密存储 |
| 写操作审计 | 全部落 SQLite，含参数与结果 |
| pre/prod 护栏 | 默认禁用，显式解锁 + 二次确认，解锁状态不持久化 |
| CodeBuddy 信任边界 | 后端代理防止浏览器选端口，但不是上游认证；因明确采用 `--auth none`，本机任意进程可访问 loopback 服务，须接受为本机信任边界，不得宣传为已由 Header 或控制台 token 防护 |

### 10.7 历史备选：零后端方案（已否决）

CodeBuddy HTTP 服务已提供 `jobs` / `scheduled-tasks` / `sessions` / `fs` / `pty` / `process` 全套；本设计仍由控制台后端代理请求并监督按 Story 启动的服务。

纯静态前端直连 CodeBuddy 的零后端方案不适用于 v2.6：它会暴露各 Story 端口选择并绕过控制台的 Story/instance 映射与服务监督。

此处仅保留为已否决的历史备选，不是当前架构或可切换配置。

---

## 11. 页面布局与交互模式决策

### 11.1 页面信息架构与布局

#### 页面与导航范围

主导航固定为七项，顺序和键盘快捷键沿用 11.2 的决策：收件箱（默认首屏）、看板、流水线、实例、定时、发布、工作区。**连接自检与配置属于工具页**，从顶栏连接状态/设置入口进入，不占主导航名额；连接异常时可从状态提示直接跳转自检页。工具页沿用同一公共框架，不另建导航体系。

#### 公共页面框架

| 区域 | 布局职责 |
|---|---|
| 左侧导航 rail | 桌面端固定常驻，提供七个主页面入口与当前页标识；不随页面内容滚动。空间不足时可折叠为图标态 |
| 顶栏 | 显示当前位置/面包屑、全局搜索与 `⌘K` 入口、统一快照时刻和通道健康状态；自检/配置从工具入口访问 |
| 页面标题区 | 每页提供标题、简短说明、该页主操作及必要的筛选/视图切换；主操作位置保持稳定 |
| 内容区 | 页面独立滚动，按该页任务选择列表、表格、时间线或对话布局；优先展示决策所需信息，不重复铺陈全量数据 |
| 详情层 | 需求、Bug、MR 等对象的详情优先使用侧滑抽屉，保留来源列表的筛选、滚动位置和选中项；需要连续操作的实例对话留在实例页面主内容区 |
| 全局浮层 | 命令面板、确认框和快捷动作覆盖在当前页面之上；关闭后恢复触发前的焦点与上下文 |

#### 七个主页面结构

| 页面 | 页面内容布局 | 主要交互与状态 |
|---|---|---|
| **收件箱** | 页首展示待决策数、高优先级数、运行中实例、今日已处理；主体按优先级展示待处理事项，每项呈现来源需求、原因、更新时间和能解决问题的动作 | 默认首屏。处理后从列表移除并提供 5 秒撤销；空态显示「现在没有需要你决策的事」。数据来自共享快照 |
| **看板** | 页首为搜索、筛选和视图切换；主体为需求列表/卡片，显示标题、负责人/迭代、Harness 阶段、Bug 徽标及工作区、实例、cron、MR/构建等关联摘要 | 点需求打开侧滑详情；列表保持筛选和滚动位置。详情聚合关联 Bug、Harness、MR、构建和快捷入口；MVP 先做精简需求列表 |
| **流水线** | 主体按需求展示端到端阶段链：需求/工作区 → Harness Phase → MR → 构建 → 部署/提测；每段标注状态、来源与更新时间，异常断点突出显示 | 点节点进入对应详情或外部系统；仅呈现观测事实，不代替 Harness 判定/推进。MVP 阶段复用看板的只读链路摘要，不要求先实现独立完整页面 |
| **实例** | 桌面端采用实例列表与当前会话工作区并列：列表按 Story/工作区分组并显示状态；主区显示所选实例的实时输出、历史和回复输入；可选终端与对话明确分区 | 切换实例不串流、不丢各实例滚动位置；阻塞提示与恢复/停止等操作在所选实例上下文内出现。窄屏转为列表页与会话页切换 |
| **定时** | 主体按 Story 列出 cron：需求标题优先，随后显示模式、启停状态、下次运行、最近结果与 owner 关联；执行历史和 Harness 产物在行内展开或详情层查看 | 间隔行内修改、启停与删除入口按风险分级；查询+修复明确展示副作用。owner session 与单次执行记录分开呈现 |
| **发布** | 以需求/发布批次为主线，分区展示目标环境、关联应用、分支/commit、构建记录、制品和部署结果；批量操作前先列清应用与制品 | 写操作遵循 M6-16、环境护栏及二次确认；Phase 4-6 时禁用相关写按钮并说明原因。流水线页用于全链路状态概览，本页承载发布操作与记录 |
| **工作区** | 页首提供工作区搜索/筛选与新建入口；主体列出工作区、仓库、分支和初始化状态；新建/初始化采用分步表单，执行期间展示阶段与逐仓库进度，完成后展示复核结果 | 仓库必须人工勾选；显示 DryRun、副作用与失败原因。归档和磁盘信息按能力提供，不自动删除文件 |

#### 响应式与状态呈现

- **桌面优先**：布局围绕桌面浏览器设计，不规定固定像素宽度；导航、内容、详情层的宽度允许按视口伸缩。主信息和关键动作不得只靠悬停才可见。
- **窄屏基础降级**：导航 rail 收入菜单/抽屉；两栏内容改为列表与详情分屏切换；侧滑详情改为全屏层；多列数据可转卡片或明确提供横向滚动，不得静默隐藏关键字段；主要操作保持可触达。此规则不构成完整移动端适配承诺。
- **加载/错误/空态**：首次加载使用与内容结构一致的骨架；局部通道加载或失败只影响对应区域，并标示来源、更新时间及缓存/离线状态；无数据时显示有针对性的空态和下一步入口，不用全屏空白或无限转圈。
- **视觉基线**：延续暗色默认、亮色可选、4px 间距基数、13px 正文；状态必须同时使用文字/图标等非颜色线索，密度不得以牺牲可读性为代价。

#### 布局验收

1. 七个主导航入口在所有主页面位置稳定，当前页清晰可辨；自检/配置可从工具入口及连接异常提示到达，但不混入七项主导航。
2. 打开站点默认进入收件箱；跳转看板与流水线不重复取数，数据更新时间与状态可见。
3. 从看板打开并关闭需求详情后，原筛选、滚动位置和键盘焦点可恢复。
4. 每页首屏能辨认页面目的和主操作；连接失败、加载中、无数据均有局部且明确的呈现。
5. 窄屏下导航、详情及主要操作仍可访问；重要字段不会因响应式折叠而丢失。
6. 发布写操作的禁用态/确认态与 M6 护栏一致；布局不得弱化危险操作提示。

> 本节定义信息层级和交互承载方式，不是视觉稿；不锁定具体像素、颜色值或组件库实现。新页面实现仍按 MVP / 扩展轨交付。

## 11.2 交互模式采纳决策 · v2.3 升级为完整记录

> 来源：对 23 组协作与流程产品的交互调研，逐条放到本项目真实约束下重判，共 **29 条模式**。
> 本小节为**完整决策记录**（含落地方式与验收标准），可直接照着实现，无需再翻决策板。
> 可交互决策板见 `outputs/devtask-pattern-adoption/`；用户导出的决策快照见 `Downloads/DevTask-Console-交互采纳决策.md`（2026-11-12 20:54，与本文一致，无改判）。
> 结论：**13 条直接采纳 · 10 条改造后采纳 · 6 条明确不抄**，其中 P0 共 16 项。

### 11.2.1 直接采纳（13）

#### 命令面板 ⌘K
`P0 · 全局 · 成本 M` · 来源：Linear / Notion / ClickUp
- **结论**：我们要跨六个数据源跳转，搜索是唯一低成本的统一入口，优先级最高。
- **依据**：需求在 TAPD、阶段在本地文件、实例在 CodeBuddy、cron 在网关、MR 在 GitLab、构建在 DevOps。靠点击导航找东西，跨源跳转成本极高。命令面板把「功能多」从界面搬进搜索框，主界面因此能保持极简。
- **落地**：索引 reqs / jobs / crons / builds / mrs 五类对象 + 屏幕跳转 + 动作命令。模糊匹配（子序列即可），结果右侧标注类型与所属需求，无输入时置顶最近使用。动作命令直接执行，例如「把惠康的巡检改成 30 分钟」→ PATCH scheduled-tasks。
- **验收**：100ms 内出现；输入即过滤不卡顿；↑↓ 选择、↵ 执行、Esc 关闭；执行完不需要回到鼠标。

#### 渐进披露 + 侧滑详情
`P0 · M1 看板 · 成本 M` · 来源：Linear / monday.com
- **结论**：列表只留决策必需字段，六源详情收进侧滑抽屉，不打断空间上下文。
- **依据**：一个需求要展示的信息横跨六个源，全铺在卡片上必然过载。侧滑而非整页跳转，关掉后滚动位置和选中行都还在。
- **落地**：卡片只留标题、阶段进度条、Bug 徽标（new/reopened/待确认）、工作区、MR/CI/实例/cron 四个小角标。点开抽屉聚合六源详情 + 关联 Bug 列表 + 快捷动作。行内次要操作可悬停显示且隐藏时 `pointer-events:none`；关键操作不能只靠悬停才可见。
- **验收**：抽屉打开不改变列表滚动位置；Esc 关闭并把焦点还给触发行；抽屉内可直接跳转到流水线/实例/发布。

#### 骨架屏替代转圈
`P0 · 全局 · 成本 S` · 来源：Linear / ClickUp
- **结论**：五条通道延迟不一，骨架屏给出内容形状与心理预期，比转圈更耐等。
- **依据**：TAPD 走 MCP 有进程延迟、DevOps 会话可能 403、本地文件很快。混用转圈会让整个看板看起来「都在等」。
- **落地**：首屏与切换筛选时用卡片形状骨架；单通道慢时只骨架该区块，其余照常显示。超过 2 秒追加「仍在拉取 DevOps…」并提供取消；失败降级为缓存 + 离线标识，绝不白屏。
- **验收**：骨架形状与真实卡片一致；超 2 秒有文字进度与取消入口；任何通道失败都不导致整页空白。

#### 暗色默认 + 4px 高密度网格
`P0 · 全局 · 成本 M` · 来源：Linear
- **结论**：开发者长时间盯屏，且要与 CodeBuddy、终端视觉连成一片。
- **依据**：我们的控制台夹在 CodeBuddy 与终端之间，亮色会造成视觉割裂。高密度靠 4px 网格与对齐实现，不是靠挤。
- **落地**：暗色默认、亮色可切换且状态色在两套主题下分别调对比度。4px 间距基数、13px 正文、等宽字体用于 ID/cron/commit。只有状态与告警给饱和色，其余用中性色，靠字重与透明度分层。
- **验收**：两套主题下所有文字达到可读对比度；状态色在色觉障碍模拟下仍可区分（颜色+图标+文字至少两种编码）。

#### 多视图共享同一份数据
`P0 · 全局 · 成本 L` · 来源：Notion / Airtable / 飞书项目
- **结论**：看板、流水线、收件箱是同一份状态的三种投影，切视图不重新取数。
- **依据**：这是参考产品里最值得抄的一条架构级决策。三个视图各拉各的，必然出现「看板说 3 个 bug、收件箱说 5 个」的时刻错位。
- **落地**：后端聚合器产出统一快照 `state.json`（带 `snapshotAt`），前端三个视图都读它。切视图只做渲染切换，不触发重新拉取；刷新是显式动作，刷新后三个视图同步更新。
- **验收**：切换视图无网络请求；同一需求在三个视图中的阶段/Bug 数完全一致；快照时刻在界面上可见。

#### 收件箱：只放待决策项
`P0 · M7 收件箱 · 成本 M` · 来源：Basecamp 的克制 + 单人场景推导
- **结论**：单人工具的核心问题是「现在该我做什么」，不是「所有东西的状态」。
- **依据**：全量看板大部分时候是噪音。真正需要人介入的只有五类：实例 blocked、bug 待人工确认、reopened 打回、MR 待合并、构建失败/凭据过期。
- **落地**：只聚合这五类 + 凭据预警，每项给出原因与一键动作。处理完即从列表消失，可撤销。顶部四个统计：待决策数、高优先级、实例运行中、今日已处理。
- **验收**：清空后显示明确的空态文案；每项都能一键跳到能真正解决它的界面；标记已处理可撤销。

#### Harness 定时修复可观测性
`P0 · M4 定时 · 成本 S` · 来源：Harness cron 与 7 Phase 流程
- **结论**：将 cron 是否触发、Harness 当前 Story / Phase、修复产物与最终结果放在一起展示。
- **依据**：定时任务只负责触发 `/start fixbugs <storyId>`；跳过、阻塞、重试与阶段推进由 Harness 管理，站点不能再造一套并行状态。
- **落地**：任务行展示下一次运行时间、执行记录、Harness 活跃 Story / Phase、`bug-list.json` 与分析报告入口；活动流程存在时按 Harness 规则跳过，不提供接管或删锁操作。
- **验收**：用户可区分「未触发 / 正在执行 / Harness 阻塞 / 执行结束」；站点不修改 Harness 状态或 Bug 产物。

#### reopened 诊断面板
`P0 · M6 发布 · 成本 M` · 来源：自有增量 · 借鉴 CI 诊断视图
- **结论**：把 reopened 的相关诊断信息集中展示，让用户基于同一视图作出判断。
- **依据**：Harness fixbugs 可能继续执行提交/MR/构建阶段；站点应使用实际观测到的状态解释 reopened，不假设修复改动一定未提交或一定已部署。
- **落地**：reopened 时展示 TAPD 评论、工作区改动、MR 合并状态、Harness Phase 与最近构建记录，作为人工诊断线索；站点不自行判定真/假复现，不重跑修复。
- **验收**：每项诊断显示数据来源和更新时间；没有部署查询接口时，构建记录只能标为「疑似环境滞后」；流程判断及后续动作交由 Harness fixbugs 与用户处理。

#### 聚合视图不做二次录入
`P0 · 全局 · 成本 S` · 来源：ONES
- **结论**：给管理层/自己一层聚合视图，但底层永远是同一份工作项。
- **依据**：一旦允许在站点里手动改 Bug 数或阶段，就会与 TAPD / Harness 分叉，之后所有判断都不可信。
- **落地**：所有业务字段只读聚合，本地只存三类自有数据：关联映射（storyId↔cronId、仓库↔DevOps应用）、用户偏好（视图/排序/改判）、操作审计。任何业务字段的修改都必须回到源系统。
- **验收**：代码里不存在写 TAPD 业务字段或 `e2e-state.json` 的路径；本地存储只含映射、偏好、审计三类。

#### 统一导航 + 全局搜索
`P0 · 全局 · 成本 S` · 来源：Huly
- **结论**：多形态合一时先统一导航与搜索，其余界面各自保留习惯。
- **依据**：七个屏幕来自六个系统，如果每个屏幕各造一套导航，切换成本会抵消聚合带来的收益。
- **落地**：左侧固定 rail 七项 + 数字键 1-7 直达；顶部面包屑显示当前屏幕与关键统计；⌘K 跨屏幕跳转。各屏幕内部布局按自身需要设计，不强求一致。
- **验收**：任意屏幕两次按键内可达另一屏幕；rail 常驻不随滚动消失；当前屏幕在导航上有明确标识。

#### 保存视图
`P1 · M1 看板 · 成本 S` · 来源：Notion / Airtable
- **结论**：把常用筛选组合存成一键视图，例如「我的阻塞项」「本周提测」。
- **依据**：每天关心的切面是固定的几个，每次重新点筛选是重复劳动。低成本高回报。
- **落地**：当前筛选（阶段 + 关键词 + 排序）可保存为命名视图，显示为一排 chip。内置三个常用视图，用户可新增。视图只存偏好，不复制数据。
- **验收**：保存后一键恢复完整筛选组合；视图切换不触发取数；可删除自建视图。

#### 行内编辑
`P1 · M4 定时 · 成本 S` · 来源：Linear
- **结论**：改 cron 间隔、改实例名这类高频小改动，不该开弹窗。
- **依据**：改轮询间隔是最高频的操作之一，如果每次都弹表单，人会懒得改，进而留着不合适的周期跑。
- **落地**：间隔用行内下拉（20/30/60），选中即 PATCH 并乐观更新 cron 字符串；实例名点击即变输入框，失焦提交。所有行内编辑都走乐观更新 + 撤销。
- **验收**：从点击到看到新值 <100ms；失败回滚并显示原始错误；不需要打开任何弹窗。

#### g + 字母 键盘导航
`P1 · 全局 · 成本 S` · 来源：Linear
- **结论**：vim 式双键导航，让常驻用户彻底离开鼠标。
- **依据**：使用者是开发者，本来就有终端与编辑器的快捷键肌肉记忆，迁移成本几乎为零。
- **落地**：`g d` 看板 / `g i` 收件箱 / `g p` 流水线 / `g c` 实例 / `g t` 定时 / `g r` 发布 / `g w` 工作区；`/` 聚焦搜索；`T` 切主题；`Esc` 关闭浮层。命令面板里显示这些快捷键，形成学习路径。
- **验收**：输入框内不触发；快捷键在命令面板与页脚可见；不与浏览器默认冲突。

### 11.2.2 改造后采纳（10）—— 照搬会出事

#### 乐观更新 + 撤销
`P0 · 全局 · 成本 M` · 来源：Linear / Things 3
- **结论**：可逆操作全部乐观更新；但触发构建、发布、创建 Harness fixbugs cron 任务绝不能乐观。
- **依据**：Linear 的前提是「操作几乎不会失败且可回滚」。我们一半操作满足，另一半是不可回滚的外部副作用——构建一旦提交就会真的跑，TAPD 评论一旦写出就会被同事看到。
- **落地**：分两类封装。① 可逆类（PATCH cron、enabled 开关、归档需求、改实例名）本地先改 → 后台提交 → 失败回滚并显示原始错误 + 5 秒撤销吐司。② 不可逆类（触发构建、批量发布、删除 cron、创建 Harness fixbugs cron 任务）必须等真实回执，按钮进入 loading 且禁用重复点击。
- **验收**：可逆操作界面响应 <50ms 且失败能回滚；不可逆操作在回执前不得显示成功；两类在代码里用不同封装，避免误用。

#### 状态药丸单击切换
`P0 · M1 看板 · 成本 S` · 来源：monday.com / Airtable
- **结论**：学它的形式，但不能学它的自由循环——我们的状态受 Harness 状态机约束。
- **依据**：monday 的状态是自定义枚举、无强约束。我们不行：Harness 相位由 dispatch.js 判定，TAPD 回写边界由 Harness 负责。乱循环会破坏门控与去重。
- **落地**：药丸保留彩色 + 单击直达的手感，但点击后弹出的是「当前合法目标状态」列表（由状态机计算），不是无限循环。Harness 相位药丸完全只读，点击只跳转到流水线对应节点。
- **验收**：任何状态变更都经过合法性校验；Harness 相位不可通过 UI 直接改写；非法目标态不出现在选项里。

#### 节点流可视化 + 条件裁剪
`P0 · 流水线 · 成本 M` · 来源：飞书项目 Meego
- **结论**：把流程图画成主界面这一招直接学，但我们只展示不配置。
- **依据**：Harness 七相位天然就是节点流，而且比飞书项目更严格（dev-pass、门控、fix-loop）。但配置权在 Harness，站点不能抢。
- **落地**：读 `e2e-state.json` 渲染 Harness 七相位（P0-P6）；另以关联卡片展示提测与 Bug 状态，不将站点自定义节点混入 Harness 流程。当前节点高亮、fix_loop 标 amber、blocked 标红。点节点展示负责角色、关键产出物、门控条件、状态文件路径。
- **验收**：节点状态与 `e2e-state.json` 完全一致；点节点能看到产出物与门控；站点没有任何写入该文件的代码路径。

#### 自动化写成自然语言句子
`P0 · M4 定时 · 成本 M` · 来源：Asana Rules
- **结论**：把 cron 的 prompt 翻译成「当…且…则…」，让人能审计这条任务到底会干什么。
- **依据**：定时任务 prompt 长达数百字，列表里只显示开头几十字——这正是已知坑 #28。我们需要的是让自己三个月后还能看懂这条任务会做什么。
- **落地**：解析任务类型（只查 / 定时触发 Harness fixbugs）、查询口径（`get_related_bugs` → `get_bug`，`current_owner`，`new|reopened`）与副作用，渲染成三行句子卡：「每 60 分钟查询该需求关联且由我处理、状态为 new/reopened 的缺陷」「命中后启动 Harness fixbugs 7 Phase 流程」「可能修改代码、写 TAPD 评论/状态并执行 MR/构建」。修复任务整卡用警示色。
- **验收**：不读 prompt 原文也能说清触发条件、动作与副作用；创建 Harness fixbugs 定时任务前必须显式确认。

#### 字段类型驱动控件与护栏
`P0 · M6 发布 · 成本 S` · 来源：Airtable
- **结论**：环境字段的类型直接决定控件形态：dev/test 普通，pre/prod 带锁。
- **依据**：env 字段应该由类型驱动护栏，而不是靠人记得别点 prod。分支字段必须带 `origin/` 前缀，也应该由控件保证而不是靠校验报错。
- **落地**：env 渲染为分段控件，pre/prod 默认带锁图标且不可选，解锁需二次确认且不持久化。branch 下拉只给 get-branches 返回的真实分支（已带 origin/），不允许自由输入。`live-h5-2` 应用自动按环境选分支并标注「已按特殊规则选择」。
- **验收**：未解锁时无法选中 pre/prod；分支值一定来自真实列表；特殊应用的分支规则可见且不可被手动覆盖成错误值。

#### 撤销优先于确认的边界
`P0 · 全局 · 成本 S` · 来源：Linear（反例学习）
- **结论**：Linear 说危险操作用撤销不用确认——这条在我们这里必须划出例外清单。
- **依据**：直接照搬会出事。我们的发布、TAPD 评论、Harness fixbugs 定时任务都是对外部系统的不可逆写入。
- **落地**：明确例外清单：触发构建、批量发布（尤其 pre/prod）、删除 cron、创建 Harness fixbugs 定时任务、停止他人正在跑的构建 —— 一律二次确认 + 写审计。其余操作走撤销。确认弹窗要写清具体副作用，不是笼统的「确定吗」。
- **验收**：例外清单内操作没有确认就无法提交；确认文案列出具体副作用；所有确认过的写操作可在审计里回溯。

#### 看板拖拽
`P1 · M1 看板 · 成本 S` · 来源：Trello
- **结论**：拖拽只用于手动排序与分组，绝不用于改阶段。
- **依据**：Trello 的拖拽即流转成立，是因为它的列就是用户自定义状态。我们的阶段由 Harness 决定，拖卡片改阶段等于伪造状态。
- **落地**：卡片可拖拽调整顺序，落点虚线高亮，松手后自动切到「手动排序」。提供键盘替代：选中卡片后 ←→ 移动。阶段变更一律走状态机，不走拖拽。
- **验收**：拖拽只改 order 不改 phase；有明确落点提示；键盘可完成同样操作。

#### 快捷指令模板
`P1 · M3 实例 · 成本 S` · 来源：Things 3 魔法命令 / 滴答清单
- **结论**：学它的「少点几下」，但用在给实例发指令，而不是建需求。
- **依据**：我们不建需求（需求来自 TAPD），但给实例发指令是高频动作，且有几条是固定套路：start、接口对齐二次 start、跑一次巡检、汇报进度。
- **落地**：输入框上方一排快捷 chip，点击填入模板。特别是「接口对齐」要自动带上完整步骤：更新 `story-input.json` → 按当前 Harness skill 刷新输入并重判门控 → 继续当前合法 Phase；不得重复创建 Story，并提示回填不可跳过。
- **验收**：快捷指令覆盖四个高频场景；接口对齐模板明确包含输入刷新、门控重判与继续当前流程。

#### 在制品限制 WIP
`P1 · M3 实例 · 成本 S` · 来源：PingCode / Worktile 泳道看板
- **结论**：限制的不是看板列，而是并行运行的 CodeBuddy 实例数。
- **依据**：我们的瓶颈不是任务列，而是本机资源——每个实例都在跑 AI、每个 worktree 都有 node_modules。并行开太多会互相拖慢，且注意力被切碎。
- **落地**：顶部显示「3/4 实例运行中」，阈值可配置。超限时告警并显示 `/metrics` 的 CPU 与内存占用。新建实例时若已达上限，提示先停一个而不是直接拒绝。
- **验收**：运行数与阈值实时可见；超限有明确视觉告警；资源数据来自网关 `/metrics` 而非估算。

#### Hill Chart 表达模糊进度
`P2 · M1 看板 · 成本 M` · 来源：Basecamp
- **结论**：用它表达「需求口径想清楚了没」，而不是完成百分比。
- **依据**：我们正好有一个没法用百分比衡量的量：`open-questions.json` 里未确认的口径问题。问题多的需求看着在开发，其实随时会返工。
- **落地**：需求卡上一条小爬坡：左半坡代表待确认问题多（还在想清楚），右半坡代表口径已定在收尾。数据来自 `open-questions.json` 的 confirmation 字段，不是估算。站点不替用户确认。
- **验收**：爬坡位置由未确认项数量驱动；点击可看到具体问题清单；确认动作只能由用户在源流程完成。

### 11.2.3 明确不抄（6）—— 拒绝也是设计决策

#### 完成音效与彩带动效
`P2 · 全局 · 成本 S` · 来源：Amie
- **结论**：常驻工作台不需要声音，正反馈保留视觉即可。
- **依据**：Amie 的音效在个人待办里讨喜，因为完成是人主动触发的高光时刻。我们的控制台长时间常驻，构建完成、巡检结束可能在你根本没看屏幕时发生，声音会变成噪音；而且很多完成事件一小时发生三次。
- **替代**：保留轻量视觉反馈——构建成功只更新角标与状态色；需要提醒时走可选的系统通知，默认关闭。

#### 每日计划仪式
`P2 · 全局 · 成本 M` · 来源：Sunsama
- **结论**：你的任务由领导分配、由 TAPD 驱动，不是自己规划一天。
- **依据**：Sunsama 的价值前提是使用者自己决定今天做什么。我们的需求来自 TAPD 分配，优先级由领导与迭代决定，强行加一段每日规划仪式是纯负担，而且很快会被跳过。
- **替代**：改为只读的「每日晨报」：昨天哪些相位推进了、今天有哪些阻塞项、哪些 MR 待合并。不要求任何输入。

#### AI 自动排期
`P2 · 全局 · 成本 L` · 来源：Motion
- **结论**：排期不由你决定，而且 Harness 的 task-dag 已经做了拆解与并行。
- **依据**：Motion 自动排期的前提是个人对时间有完全支配权。我们的排期受迭代、提测窗口、后端接口就绪时间约束，且 Harness Phase 1 已产出可并行任务 DAG。再加一层自动排期只会与既有规划打架。
- **替代**：只做「依赖可视化」：把后端接口未就绪导致的前端先行标成显式状态，并提供二次 start 的入口。

#### 话题与任务分离
`P2 · 全局 · 成本 M` · 来源：Tower
- **结论**：讨论已经在 TAPD 评论和 CodeBuddy 会话里，不另建讨论区。
- **依据**：我们的讨论天然分两处：业务口径在 TAPD 评论、执行过程在实例会话。再建第三个地方只会让上下文更碎。
- **替代**：把 TAPD 评论与实例输出在需求抽屉里并排呈现，而不是新建讨论区。reopened 时强制拉取评论正是这个思路。

#### 泳道看板
`P2 · M1 看板 · 成本 M` · 来源：PingCode / Worktile / TAPD
- **结论**：按工作区分组已经够，泳道会挤占本就紧张的横向空间。
- **依据**：泳道适合「同一个看板里区分多条并行流水线」。我们一个人同时最多三四个需求，卡片已带工作区标签与阶段色，再加一层泳道维度是过度设计。
- **替代**：用筛选 + 分组切换满足同样诉求：按工作区分组、按迭代分组，而不是固定泳道。

#### 插件化扩展位
`P2 · 全局 · 成本 L` · 来源：Huly / Plane
- **结论**：单人自用工具，本期不需要给第三方留扩展位。
- **依据**：Huly 与 Plane 做插件架构是因为它们面向不确定的多团队场景。我们的使用者只有一个人、流程已经固定，插件系统带来的抽象成本远大于收益。
- **替代**：保留清晰的通道分层（`channels` 目录）即可。将来真要扩展，加一个通道比现在做插件框架便宜得多。

---

## 12. 一句话总结

**看板的价值在「聚合」，控制台的价值在「代劳」，而这个站点最重要的设计是「克制」——
凡是被编排方已经定好的铁律（Harness 状态文件与 Bug 流程、TAPD 状态回写边界、生产发布权限），站点一律只读不写。
把边界守住，它才是加速器而不是新的故障源。**

**v2.4 的流程原则是：需求开发、Bug 修复与定时触发统一由 Harness 流程承接，控制台负责入口、聚合展示与诊断，不另造状态机。**

**v2.6 的服务原则是：一个 TAPD Story 一个按需启动、固定端口并由控制台后端监督的 CodeBuddy 服务；StoryRound Job 与 cron owner 分离，浏览器只通过后端映射代理。**

**v2.2 的最大增量不是加了功能，而是砍了范围：先用约 20 条做出「聚合器 + 收件箱 + 三个按钮」的一周闭环，让它先活下来，再长肉。**
