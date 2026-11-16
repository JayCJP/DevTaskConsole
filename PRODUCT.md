# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

单一使用者：项目作者本人。角色同时是需求承接人、开发者和发布操作者。

使用场景：本机开发机上工作，浏览器与 IDE、终端、CodeBuddy 并行开着。打开控制台是为了回答「现在该我动手的是什么」并立刻执行——启动实例、创建 MR、触发构建与部署、查询/修复 Bug 定时任务。每次会话时长以任务为单位，不是长时间驻留的看板。

## Product Purpose

DevTask Console 是既有工具链的驾驶舱：把散在 TAPD、git worktree、CodeBuddy 实例、Harness 流程、GitLab MR、DevOps 构建部署、Bug 定时修复七处的状态拼成一屏，并把原先手敲的命令变成按钮。

成功标准：需要我手动敲命令的环节变少，且在没有先看 e2e-state.json、没有切到终端的情况下，就能判断下一个动作并点下去。

## Positioning

只做「聚合显示 + 代为执行 + 守住边界」三件事，不自建任何信源，也不重造流程状态机。竞品（又一个项目管理工具）若要做同样的事，必须先放弃它自己的需求数据库与状态机。

## Operating Context

- TAPD 是需求与缺陷的唯一信源；Harness 的 e2e-state.json 是开发/修复流程的唯一状态机；GitLab 是代码与 MR 的信源；DevOps 是构建与部署的信源。
- 每个 TAPD Story 对应一个后端监督的长期 CodeBuddy `--serve` 服务，端口持久映射；每轮 run / fixbugs 是独立 Job。
- 工作区由 create-workspace skill 用 git worktree 建出，Story 位于第一个项目的 .codebuddy/plans 下。
- Bug 定时修复通过 tapd-bug-cron：cron owner 会话负责查询，命中后新建本轮 Job 执行 fixbugs。
- 控制台为本地服务（127.0.0.1）+ 网页，本机访问令牌登录，令牌保存在用户数据目录。
- 数据刷新是手动/事件驱动的：不轮询定时刷新，以避免耗尽 TAPD 配额和覆盖用户正在查看的状态。

## Capabilities and Constraints

七个主导航页：收件箱（默认首屏）、看板、流水线、实例、定时、发布、工作区；连接自检与配置在主导航之外的工具页。

已确认的约束：

- TAPD / Harness / GitLab / DevOps 始终是唯一信源；不建库、不双写；e2e-state.json 与 dev-pass.json 只读。
- 首屏统一快照不拉取 MR / 构建 / 分支数据（GitLab、DevOps 仅做连通性探测供连接自检页展示）；MR 详情按需查询，MR 创建走工作区操作。
- 生产发布必须人拍板：站点默认只开放 dev / test；Harness Phase 4-6 期间发布写操作硬禁用。
- 单机 + 本机令牌鉴权，不做权限体系。
- 桌面优先，窄屏只做基础降级，不承诺完整移动端适配。
- 站点不自动 git commit / push / 改依赖；改动只留在工作区。

明确未决：发布页目前只展示占位内容，写操作尚未开放；部分 Harness 终态归档与自动重启仍是上游 skill 的待增强能力。

## Brand Commitments

产品名为 DevTask Console。界面语言为中文，术语沿用上游：Story、Harness Phase、Job、轮次（round）、owner session、工作区、收件箱。状态一律标明来源与快照时刻，不伪装成实时。

## Evidence on Hand

- DevTask-Console-需求规格.md：产品定位、模块（M1-M7）、29 条交互模式决策与布局验收标准，是产品事实的权威来源。
- README.md：本地运行方式、各通道连接配置与安全边界说明。
- 开发进度清单.md：当前交付进度。

不存在：用户评价、客户案例、性能基准、定价或部署规模数据。未来工作不得编造。

## Product Principles

1. **信源唯一**：站点只镜像、不代言。任何展示都要能追溯到上游系统与快照时刻。
2. **执行为主**：价值在减少手敲命令；能以按钮安全完成的动作，就不该要求回终端。
3. **边界优先于便利**：门控区间、生产发布、git 写操作等硬规则一旦触发就禁用入口并说明原因，不做「确认一下就能过」。
4. **状态自证**：加载、失败、缓存与未知必须局部可见，宁可显示「未知」也不假装正常。
5. **密度服务于判断**：优先呈现做决定所需的信息，不为了铺满页面而陈列全量数据。

## Accessibility & Inclusion

单用户自用，无已声明的合规标准。既有实施遵循：状态不单靠颜色传达（同时有文字或图标）、键盘可达与可见焦点环、prefers-reduced-motion 降级。
