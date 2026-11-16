---
version: 1
slug: "src-views-consolepage-vue"
primary_target: "src/views/ConsolePage.vue"
related_targets: []
---

# 发布页方向契约 v2（开发用，不入库到任何浏览器产物）

## Direction contract

THESIS: 发布页是一块「构建发射台」，但风险由口径而非锁来承载。它拒绝把环境做成需要解锁的危险开关，也拒绝为「最近构建」查询增加负担：6 档环境各有固定的 build_other 与 origin/分支，dev→dev/origin/dev，prod→build/origin/master，构建/MR 参数一律跟随顶部所选环境，用户只需在清单里核对要操作的应用。类别默认用「上锁」表达危险；这里用「展示固定口径 + 多选清单二次确认」表达，既不误导也不添堵。

OWN-WORLD: 继承「The Instrument Deck」仪表台世界。仪器蓝只用于环境分段器选中态、主操作与焦点环（单屏 ≤10%）；幽灵石板四级明度构成页面/面板/内嵌；状态色配文字。6 档环境分段器仍是签名组件（prod 档选中时用危险色而非锁图标）；所选环境的构建分支 / build_other / MR 目标以凹陷块中的等宽字并列展示。项目表收敛到 4 列：项目 / DevOps 应用 / 检出分支（MR 源）/ 操作；操作列为「构建 + 创建 MR」两个小按钮。工作区卡头放「构建此工作区全部」与「批量创建 MR」。无位移动效，150ms 颜色/描边过渡。

STORY: 打开发布页先看护栏（Phase 4-6 / DevOps 连接），选顶部环境即看到该环境固定口径；逐项目核对应用名后点「构建」或「创建 MR」，或整工作区批量。构建为多选清单二次确认（列出应用清单，写明固定分支与 build_other），确认后逐项目等真实回执；单项目也走同一确认。MR 源分支取项目当前检出分支，目标分支跟随顶部环境（dev→dev、prod→master）。不查询构建记录、不展示最近构建、不提供刷新 DevOps。

FIRST VIEWPORT: 标题「发布」+ 副标题 + 快照时刻；护栏横幅（仅门控/通道不可用）；发射控制条（环境分段器 + 固定分支/build_other/MR 目标 + 一键构建全部项目）；工作区面板（每卡头两个批量按钮 + 4 列项目表）。

FORM: 仪表台控制条 + 工作区分组项目表。build path = code-led（Operate 表面）。seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
