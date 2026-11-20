<div align="center">

# DevTask Console

**开发者任务驾驶舱 —— 把散落在各处的开发状态，拼成一屏，化为一个个按钮。**

基于 Vue 3 + Vite + Tailwind CSS + Fastify + Node.js 22 构建的本地开发任务控制台。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![pnpm](https://img.shields.io/badge/pnpm-11-F9BC02?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

## 目录

- [为什么做这个项目](#为什么做这个项目)
- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [界面预览](#界面预览)
- [架构设计](#架构设计)
- [与 HarnessFlow 的关系](#与-harnessflow-的关系)
- [配置说明](#配置说明)
- [功能模块](#功能模块)
  - [实例管理](#实例管理)
  - [Story 服务的进程托管方式](#story-服务的进程托管方式)
- [安全边界](#安全边界)
- [验证与构建](#验证与构建)
- [路线图](#路线图)
- [项目结构](#项目结构)

---

## 为什么做这个项目

日常开发中，一个任务的状态往往散落在七个不同的地方：TAPD 的需求与缺陷、git worktree 工作区、CodeBuddy 实例、Harness 流程状态机、GitLab 合并请求、DevOps 构建部署，以及 Bug 定时修复任务。要判断「现在该我动手的是什么」，不得不反复切换终端、网页和配置文件，还要手动敲一堆命令。

**DevTask Console 就是这套工具链的驾驶舱。** 它不自建信源、不重造流程状态机，只做三件事：

1. **聚合显示** —— 把各系统的状态拼成一屏，并标注来源与快照时刻；
2. **代为执行** —— 把原先手敲的命令变成页面上的按钮；
3. **守住边界** —— 生产发布、Git 写操作等硬规则一旦触发，入口即禁用并说明原因。

成功标准很朴素：**不用先看 `e2e-state.json`、不用切到终端，就能判断下一个动作并点下去。**

## 核心特性

- **一屏总览** —— 收件箱、看板、实例、定时、发布五个主导航页，覆盖从需求到发布的完整链路。
- **状态自证** —— 加载、失败、缓存与未知状态局部可见，宁可显示「未知」也不假装正常。
- **执行为主** —— 实例启停、工作区初始化、MR 创建、构建触发等操作均可点按完成。
- **分路由视图** —— 前端由共享壳层 `ConsoleShell.vue` 承载状态，各页面拆为独立 View 并按路由懒加载。
- **信源唯一** —— TAPD / Harness / GitLab / DevOps 始终是唯一信源，站点只镜像、不双写。
- **本地安全** —— 单机 `127.0.0.1` 服务 + 本机访问令牌登录，连接器凭据仅服务端读取。
- **边界优先** —— 发布写操作默认禁用，Git 写操作不自动执行，门控区间显式提示。

## 快速开始

### 环境要求

| 依赖                           | 版本                           |
| ------------------------------ | ------------------------------ |
| Node.js                        | `>= 22`                        |
| pnpm                           | `11.x`                         |
| PowerShell 7（`pwsh`）         | 工作区初始化所需               |
| herdr-app + herdr-core（`hc`） | 默认进程托管所需（可选，见下） |

### 可选依赖：herdr-app / herdr-core

默认进程托管方式（`app-hc`）依赖本机安装 [herdr-app](https://github.com/herdrdev/herdr-app) 桌面端及其核心 herdr-core 的命令行工具 `hc`。两者分工：

- **herdr-app** —— 桌面 GUI，把 Story 服务显示成 `devtask-services` space 下的 tab（以 storyId 命名），便于人工查看；创建 tab 依赖桌面窗口。
- **hc** —— herdr-core 的 CLI，真正托管常驻终端（`codebuddy --serve` 跑在它里面），窗口关闭也不会中断服务；服务端用它查状态、停止和清理。
- **herdr**（老的多路复用器）—— 仅作为可回退的 launcher 保留，无需桌面 GUI。

> 若本机没有 herdr-app/hc，设置 `DEVTASK_STORY_LAUNCHER=herdr` 或 `spawn` 即可在不装该依赖的情况下运行；详情见 [Story 服务的进程托管方式](#story-服务的进程托管方式) 与 [`docs/herdr-app-hc-替换方案.md`](docs/herdr-app-hc-替换方案.md)。

### 安装与启动

```powershell
pnpm install
pnpm dev
```

Web 应用运行在 Vite 上，`/api` 请求会被代理到 `127.0.0.1:7788` 的 Fastify 服务。

### 首次登录

服务首次启动会在 `%LOCALAPPDATA%\DevTaskConsole\control-panel-token` 生成本机访问令牌。在浏览器登录页输入该令牌即可进入控制台。

## 界面预览

> 控制台包含五个主导航页：收件箱（默认首屏）、看板、实例、定时、发布；连接自检与配置位于主导航之外的工具页。

| 页面      | 作用                                                   |
| --------- | ------------------------------------------------------ |
| 📥 收件箱 | 默认首屏，聚合当前需要你处理的任务                     |
| 📋 看板   | 按父需求聚合展示 Story 状态及分阶段进展                |
| 🖥️ 实例   | 启动或接管 Story 的本地 CodeBuddy HTTP 服务            |
| ⏰ 定时   | 管理 Bug 定时查询与修复任务映射                        |
| 🚀 发布   | 工作区管理、构建触发与 MR 创建（写操作受环境门控约束） |

> 原「流水线」页与独立「工作区」页已移除：工作区管理、工作区初始化与 MR 操作并入发布页；开发 / 修复流程进展在收件箱与看板中呈现。

## 架构设计

项目采用 pnpm workspace 多包结构，前后端分离、共享类型：

```
DevTaskConsole/
├── apps/
│   ├── web/        # Vue 3 + Vite 前端控制台
│   └── server/     # Fastify 服务端
│       ├── routes/         # HTTP 路由
│       ├── aggregator/     # 快照 / 看板 / 定时任务聚合
│       ├── integrations/   # TAPD / GitLab / DevOps / MCP 适配器
│       ├── services/       # Story 服务、定时任务、审计日志
│       └── workspaces/     # 工作区初始化、绑定、MR
└── packages/
    └── shared/     # 前后端共享类型与工具
```

**设计原则：**

- 数据刷新为**手动 / 事件驱动**，不轮询，以免耗尽 TAPD 配额或覆盖用户正在查看的状态。
- 所有上游系统均为只读信源；`e2e-state.json` 与 `dev-pass.json` 只读。
- 状态展示统一标注来源与快照时刻，不伪装成实时数据。

## 与 HarnessFlow 的关系

> 项目地址：[JayCJP/harnessflow](https://github.com/JayCJP/harnessflow)

**HarnessFlow 是「引擎」，DevTask Console 是「仪表盘 + 方向盘」。** 理解这一点，就理解了本项目存在的意义。

### HarnessFlow 是什么

HarnessFlow 是为 AI 编程助手（Claude Code / CodeBuddy Code）接入的一条端到端自动化研发流水线。它用一条 `/start` 命令驱动完整的 7 Phase 工作流：

| Phase | 阶段          | 负责 Agent     | 关键产出物                                            |
| ----- | ------------- | -------------- | ----------------------------------------------------- |
| 0     | 需求分析      | 需求分析师     | `requirement-analysis.md`、`acceptance-criteria.json` |
| 1     | 任务规划      | 任务规划师     | `task-dag.md` / `task-dag.json`（可并行任务 DAG）     |
| 2     | 代码开发      | 前端开发工程师 | 代码变更（dev-pass 限时写保护）                       |
| 3     | 代码审查      | 代码审查师     | `code-review.json`（AC 逐条核对）                     |
| 4     | Git 提交 + MR | 发布助手       | 提交开发分支 + 创建 MR（→ dev）                       |
| 5     | 知识库更新    | 发布助手       | 增量知识库文档（kb-update）                           |
| 6     | 云端部署      | 发布助手       | dev 分支构建 + 部署                                   |

它的核心设计是**契约驱动 + 硬门控 + 权限控制**：`dispatch.js` 是只读调度器（只读状态、判门控、说下一步，零写权限），`advance-phase.js` 是相位跃迁唯一执行者；AI 不手改 `e2e-state.json` / `dev-pass.json`，只机械执行调度指令。此外还提供 Bug 定时巡检（`tapd-bug-cron`）、知识库全生命周期管理、Figma 设计稿协作等能力。

### 对本项目的意义

HarnessFlow 定义了「**研发流程应该如何运转**」，但它工作在命令行与文件里——状态藏在 `.codebuddy/plans/<Story>/e2e-state.json` 中，推进靠人敲 `/start`、`/kb-query` 这类命令，多个 Story 并行时很难一眼看清全局。DevTask Console 正是为补齐这块而存在：

1. **让隐状态可见** —— 把 Harness 的状态机（`e2e-state.json`、`dev-pass.json`、Job 轮次、owner session）从文件搬进浏览器，以看板、收件箱、发布页的形式呈现。这与 HarnessFlow「状态自证」的设计一脉相承：宁可显示「未知」，也不假装正常。

2. **让流程可操作** —— 把 `/start run`、`/start fixbugs`、创建 MR、触发构建部署等命令变成按钮。HarnessFlow 负责「怎么安全地做」，控制台负责「让人一键触发」。

3. **尊重并依赖它的边界** —— 控制台**不重造流程状态机**：`e2e-state.json` 与 `dev-pass.json` 始终只读，生产发布必须人工拍板，Harness Phase 4-6 期间发布写操作硬禁用。这与 PRODUCT.md 中「信源唯一、边界优先于便利」的原则完全一致。

4. **串联整个工具链** —— HarnessFlow 管理流程本身，而 DevTask Console 把 Harness 与 TAPD（需求信源）、git worktree（工作区）、GitLab（代码与 MR 信源）、DevOps（构建部署信源）、Bug 定时修复任务拼成一屏。HarnessFlow 是其中「开发 / 修复流程」这一环的权威状态机，控制台则是环绕它的全景驾驶舱。

**一句话总结：HarnessFlow 保证每一步都走得对，DevTask Console 保证你看得见走到了哪、并能伸手推一把。**

## 配置说明

所有配置通过环境变量提供，均为可选项，未设置时使用本机默认值。

### 路径配置

| 变量                      | 说明                    | 默认值                              |
| ------------------------- | ----------------------- | ----------------------------------- |
| `DEVTASK_WORKSPACES_ROOT` | 工作区根目录            | `D:\test-blanch`                    |
| `DEVTASK_SOURCE_ROOT`     | 只读 Git 仓库候选根目录 | Windows 默认 `D:\workfile`          |
| `DEVTASK_MCP_CONFIG`      | MCP 连接配置文件路径    | `%USERPROFILE%\.codebuddy\mcp.json` |
| `DEVTASK_DATA_DIR`        | 应用数据存放目录        | `%LOCALAPPDATA%\DevTaskConsole`     |

### 进程托管配置

| 变量                     | 说明                                                     | 默认值   |
| ------------------------ | -------------------------------------------------------- | -------- |
| `DEVTASK_STORY_LAUNCHER` | Story 服务托管方式：`app-hc` / `herdr` / `spawn`（见下） | `app-hc` |

> 默认由桌面端 herdr-app 起终端、herdr-core 的 `hc` 查停，服务会出现在 herdr-app 的 `devtask-services` space 下。若桌面端未打开，请改用 `herdr` 或 `spawn`。

### 连接配置

服务端默认从 `%USERPROFILE%\.codebuddy\mcp.json` 读取 MCP 连接设置。**请勿提交该文件到版本库**，连接器凭据仅由服务端读取。

## 功能模块

### 工作区初始化与发布

工作区能力集中在发布页：只列出来自 `DEVTASK_SOURCE_ROOT` 的仓库，需显式选择。初始化前会调用本地 `~\.codebuddy\skills\create-workspace\scripts\create-workspace.ps1` 执行 `-DryRun`。确认后会创建 git worktree 与 `.code-workspace` 文件，并执行所选的 `npm install` 与 graphify 阶段。发布页同时提供工作区删除、按环境触发构建与批量创建 MR。

- 不会执行 pull、commit、push，也不会删除 worktree。
- 任务状态与有界日志持久化在 `workspace-initialization-jobs.json`。
- 服务重启后，原「运行中」的任务会被标记为已中断（子进程无法安全重新挂载）。

### 数据连接

- **仓库映射**：手动确认的「仓库 ↔ GitLab 项目」「仓库 ↔ DevOps 应用 / 组」映射保存在 `application-mappings.json`，用于从工作区创建 MR；未映射的仓库不会被猜测。
- **快照**：仅探测 GitLab / DevOps 连通性供连接自检页展示，不拉取 MR、构建记录或分支列表。
- **定时任务**：读取各需求工作区的 `.codebuddy/scheduled_tasks.json`，任务归属通过 `cron-mappings.json` 显式映射，不从提示文本推断意图。

### 实例管理

实例页面可显式启动或接管某个 Story 的本地 CodeBuddy HTTP 服务：

- Story / 端口 / 工作区占用关系持久化在 `story-services.json`。
- 以 `codebuddy --serve` 在回环地址启动，附加 `--auth none`，健康检查通过后才报告成功。
- 服务启动时检查已注册实例，不健康者按 5 / 15 / 30 秒退避在同端口重试。
- Job 的列表 / 创建、对话记录、SSE 输出、回复、停止、重启与删除均通过带鉴权的控制台路由代理，浏览器不会直接接触上游端口。

### Story 服务的进程托管方式

实例页启动的 CodeBuddy HTTP 服务由服务端托管，共三种实现，共用同一套端口分配、健康检查、退避重启与注册表逻辑。通过 `DEVTASK_STORY_LAUNCHER` 选择：

| 值               | 托管方式                                   | 说明                                                                                         |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `app-hc`（默认） | herdr-app 起终端 + herdr-core 的 `hc` 查停 | 服务显示在 herdr-app 桌面 tab（space 名 `devtask-services`，tab 名为 storyId）；需桌面端常开 |
| `herdr`          | 老 herdr 常驻 pane                         | 不依赖桌面 GUI；pid 记的是 pane shell 进程号                                                 |
| `spawn`          | 内置 detached 子进程                       | 无外部依赖，但 Windows 上可能弹出独立控制台窗口                                              |

关于默认方式（`app-hc`）的几点说明：

- **前置条件**：herdr-app 桌面端需保持打开——创建 tab 依赖它的窗口；服务本身跑在 herdr-core 上，窗口关掉不会中断已启动的服务。
- **身份登记**：注册表 `story-services.json` 里这类服务的 `pid` 是字符串形式的终端 address（如 `t1w`），而非数字进程号；可用 `hc get <address>` 查看真实进程。
- **旧服务不自动迁移**：`ensureRunning` 对已 `running` 的服务直接复用，不会重新 launch。若某 Story 之前用 `herdr`/`spawn` 启动过，需先停止再启动，才会以 `app-hc` 方式重建并显示 tab。
- **回退**：桌面端不可用时，设 `DEVTASK_STORY_LAUNCHER=herdr` 或 `spawn` 重启服务端即可。

详细方案与实测记录见 [`docs/herdr-app-hc-替换方案.md`](docs/herdr-app-hc-替换方案.md)。

## 安全边界

本项目为**单用户本地工具**，明确以下边界：

- 站点仅监听 `127.0.0.1`，使用本机令牌鉴权，不构建权限体系。
- TAPD / Harness / GitLab / DevOps 始终是唯一信源，不建库、不双写。
- 生产发布需人工拍板：站点默认只开放 dev / test；Harness Phase 4-6 期间发布写操作硬禁用。
- 站点不会自动执行 git commit / push 或修改依赖，改动只留在工作区。
- 上游 `--auth none` 服务可被本机其他进程访问，控制台令牌不保护该服务。
- 桌面优先，窄屏仅做基础降级，不承诺完整移动端适配。

## 验证与构建

```powershell
pnpm dev          # 并行启动 Web 与 Server 开发服务
pnpm typecheck    # 类型检查
pnpm test         # 运行测试
pnpm lint         # ESLint 检查
pnpm format       # Prettier 格式化
pnpm check        # lint + format:check + typecheck 一次性校验
pnpm build        # 构建所有包
pnpm start        # 构建后启动生产服务
```

提交时 Husky 的 pre-commit 钩子会自动执行 ESLint 与 Prettier 双重检查。

## 路线图

- [ ] Harness 终态归档与自动重启（依赖上游 skill 增强）
- [ ] 定时任务编辑 / 暂停 / 删除与执行历史（待上游 CodeBuddy 定时任务 API 与执行记录结构确认）
- [ ] 服务级停止 / 删除与端口释放

## 项目结构

| 路径              | 说明                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `apps/web`        | Vue 3 前端，`ConsoleShell.vue` 为共享壳层，各页面为独立路由 View |
| `apps/server`     | Fastify 服务端，含聚合、集成、服务与工作区模块                   |
| `packages/shared` | 前后端共享的类型定义                                             |
| `PRODUCT.md`      | 产品定位、用户、能力与约束                                       |
| `DESIGN.md`       | 界面设计与视觉规范                                               |
| `docs/`           | 需求规格、开发进度等文档                                         |

---

<div align="center">

如果这个项目对你有帮助，欢迎 Star ⭐

**DevTask Console · 本地开发任务驾驶舱**

</div>
