---
name: DevTask Console
description: 本机开发任务控制台——把七个上游系统的状态拼成一屏，并把命令变成按钮
colors:
  instrument-blue: "oklch(72% 0.14 255)"
  instrument-blue-hover: "oklch(77% 0.14 255)"
  instrument-blue-strong: "oklch(58% 0.17 258)"
  instrument-blue-soft: "oklch(30% 0.06 255)"
  instrument-blue-contrast: "oklch(98% 0.01 255)"
  signal-success: "oklch(76% 0.13 160)"
  signal-warning: "oklch(80% 0.13 82)"
  signal-danger: "oklch(70% 0.16 22)"
  signal-info: "oklch(74% 0.08 235)"
  ghost-slate-deck: "oklch(18.5% 0.012 252)"
  ghost-slate-panel: "oklch(22.5% 0.014 252)"
  ghost-slate-raised: "oklch(26% 0.016 252)"
  ghost-slate-hover: "oklch(30% 0.018 252)"
  ghost-slate-inset: "oklch(16% 0.012 252)"
  hairline: "oklch(32% 0.016 252)"
  hairline-subtle: "oklch(27% 0.014 252)"
  text-strong: "oklch(96% 0.008 250)"
  text-body: "oklch(90% 0.012 250)"
  text-muted: "oklch(70% 0.018 252)"
  text-faint: "oklch(56% 0.018 252)"
typography:
  headline:
    fontFamily: "Inter, Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 640
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 620
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0.01em"
  label:
    fontFamily: "Inter, Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  metric:
    fontFamily: "Inter, Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "-0.03em"
    fontFeature: "tnum"
  data:
    fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  md: "9px"
  lg: "12px"
  xl: "16px"
spacing:
  unit: "4px"
  card: "20px"
  section: "18px"
  page: "32px / 34px 顶部 / 60px 底部"
components:
  button-primary:
    backgroundColor: "{colors.instrument-blue}"
    textColor: "{colors.instrument-blue-contrast}"
    rounded: "{rounded.sm}"
    padding: "8px 15px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.instrument-blue-hover}"
    textColor: "{colors.instrument-blue-contrast}"
    rounded: "{rounded.sm}"
  button-secondary:
    backgroundColor: "{colors.ghost-slate-panel}"
    textColor: "{colors.text-body}"
    rounded: "{rounded.sm}"
    padding: "8px 15px"
    height: "32px"
  button-danger:
    backgroundColor: "{colors.signal-danger}"
    textColor: "{colors.instrument-blue-contrast}"
    rounded: "{rounded.sm}"
    padding: "8px 15px"
    height: "32px"
  card:
    backgroundColor: "{colors.ghost-slate-panel}"
    rounded: "{rounded.lg}"
    padding: "20px"
  stat-card:
    backgroundColor: "{colors.ghost-slate-panel}"
    rounded: "{rounded.md}"
    padding: "16px 18px"
    height: "104px"
  tag:
    backgroundColor: "{colors.ghost-slate-panel}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.xl}"
    padding: "2px 7px"
    height: "16px"
  nav-link:
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "38px"
  nav-link-active:
    backgroundColor: "{colors.instrument-blue-soft}"
    textColor: "{colors.instrument-blue}"
    rounded: "{rounded.sm}"
  input:
    backgroundColor: "{colors.ghost-slate-raised}"
    textColor: "{colors.text-body}"
    rounded: "{rounded.sm}"
    height: "32px"
---

# Design System: DevTask Console

## Overview

**Creative North Star: "The Instrument Deck · 仪表台"**

DevTask Console 长得像一块校准好的仪表台，而不是一个产品页面。每个读数都标着来源和时刻，每个开关按下去就执行。界面上没有装饰性的解说：一屏之内，你既能看清当前状态，也能立刻动手。精密度来自一致：同一套刻度、同一套语义色、同一处圆角；重复使用不会让人疲劳，反而让眼睛不必每次都重新学习。

配色走冷调：仪器蓝承担主操作与当前选中，幽灵石板灰铺出页面、面板与内嵌区的层次，四种状态色只在它们真正表达状态时出现。两套主题（暗色默认 / 亮色可选）共用同一组 OKLCH 亮度刻度，因此同一状态在两种主题下的观感等级一致，不会在亮色下突然变刺眼。

手感克制：按钮与输入框只有颜色与 1px 描边的变化，没有位移、没有缩放、没有玻璃模糊。空间留给数据本身；密度高于观感。

**Key Characteristics:**
- 冷调仪器蓝 + 幽灵石墨板灰，四种状态色只用于状态
- 13px 正文、10–24px 的紧凑字号刻度；数字一律等宽（tabular-nums）
- 一层面板承载内容，内嵌区（代码、输出、日志）用更深的凹陷色区分
- 无位移动效；只有 150ms 的颜色与描边过渡
- 暗色默认，两种主题共用同一套亮度刻度

## Colors

冷色仪器调，中性色带极轻的蓝相（hue 252），让整个界面读起来像同一块金属。

### Primary
- **Instrument Blue · 仪器蓝** (`oklch(72% 0.14 255)`): 主按钮底色、导航当前项、选中态、可点链接、焦点环。只出现在「这是主操作」或「这是当前位置」的地方。
- **Instrument Blue Hover / Strong · 加深档** (`oklch(77% 0.14 255)` / `oklch(58% 0.17 258)`): 悬停与按下。悬停一律变「更亮」、按压变「更深」，顺序固定，不随组件变化。
- **Instrument Blue Soft · 软化档** (`oklch(30% 0.06 255)`): 选中项的底色、导航当前项底色。永远与仪器蓝文字配对。

### Tertiary（状态色）
- **Signal Success** (`oklch(76% 0.13 160)`): 连接正常、Phase 已通过、任务成功。
- **Signal Warning** (`oklch(80% 0.13 82)`): 需人工确认、限流冷却、进行中。
- **Signal Danger** (`oklch(70% 0.16 22)`): 失败、删除、门控禁用原因。
- **Signal Info** (`oklch(74% 0.08 235)`): 只读提示与来源标注。

### Neutral
- **Ghost Slate · 幽灵石板** (`oklch(18.5%`) → `26%` → `30%`): page / panel / raised / hover 四级。页面底 → 卡片 → 卡片内次级块 → 交互反馈。
- **Slate Inset · 凹陷色** (`oklch(16% 0.012 252)`): 代码块、终端输出、日志、只读数据区。用「更深」而不是阴影表达凹陷。
- **Hairline · 发丝线** (`oklch(32%`/`27%`): 卡片外框用 subtle 档，分隔线用常规档。卡片边界靠 1px 线，不靠阴影。
- **Ink 四级** (`96%` / `90%` / `70%` / `56%`): 标题、正文、元信息、极弱信息。四档之外不再造灰。

### Named Rules
**The Pill Exception.** `border-radius: 999px` 只允许出现在状态标签（`.tag`）、计数胶囊（`.count-pill`、`.kind-label`）与状态点；其余任何元素一律走五级圆角阶梯，胶囊形不是通用容器形状。

**The One Voice Rule.** 仪器蓝在任何一屏的面积占比不超过 10%：它标主操作与当前位置，不做装饰背景。需要强调时用字重或字号，不用颜色面积。

**The Source Rule.** 任何状态都必须能追溯到来源与快照时刻。信息不全时显示「未知」，不用灰色占位假装正常。

**The Semantic Parity Rule.** 同一状态在暗色与亮色下共用同一亮度刻度，不为某一主题单独调深或调浅。frontmatter 记录的是暗色（默认主题）取值；亮色在 `[data-theme="light"]` 下重映射同一组令牌，色相与色度不变，只调整亮度（例如仪器蓝 72% → 52%、signal-danger 70% → 53%）。

## Typography

**Display / Body / Label Font:** Inter → Segoe UI → Microsoft YaHei → system-ui（单一家族承担全部层级）
**Mono Font:** Cascadia Code → JetBrains Mono → Consolas（仅用于代码、ID、分支、路径、计数）

**Character:** 一套家族走到底，靠字号与字重分层次，不靠字族切换制造「设计感」。中文由微软雅黑回退承接，字重只用到 400 / 500 / 550 / 620 / 640 / 650 六档，避免看起来发虚的细体。

### Hierarchy
- **Headline** (640, 22px, 1.2, 跟踪 -0.02em): 页面主标题。不再叠加任何装饰性 kicker。
- **Title** (620, 15px, 1.4): 分区标题。左侧 3px × 12px 仪器蓝短竖线；分区标题与正文之间留白大于标题上方留白。
- **Body** (400, 13px, 1.55): 列表行、表单、正文。列表行不再用 12px，行内一致性优先于密度。
- **Label** (400, 11px, 1.5): 元信息、字段名、时间戳、次级说明。10px 只用于标签与计数。
- **Metric** (650, 24px, 1.0, 跟踪 -0.03em, tabular-nums): 统计数字。等宽数字避免刷新时抖动。
- **Data** (等宽, 10.5px): Story ID、分支、commit、行号、cron 表达式。

### Named Rules
**The Two-Step Rule.** 字号刻度只走 10 / 11 / 12.5 / 13 / 15 / 22 / 24 七级（对应 `--text-2xs` … `--text-xl`）；任何新文本必须落到其中一级，不允许 12.3px 这类中间值。

**The Numbers Stand Still Rule.** 所有会变化的数字（统计、计数、时长、次数）使用 `tabular-nums`；变动的数字不允许引起布局位移。

## Layout

应用外壳固定视口高度：左侧 216px 导航常驻不滚动，顶栏 54px 吸顶，右侧内容区独立滚动（`.page-scroll`）。内容最大宽 1320px 居中，内边距 34px 顶部 / 32px 两侧 / 60px 底部。

页面结构固定为四段：页面标题区（h1 + 一句副标题 + 右侧快照时刻与刷新）→ 统计条（可选，四列）→ 内容面板 → 空态或明细。标题区与内容之间 22px，面板之间 18px，面板内边距 20px。

间距基数为 4px；分组内用 4–8px，分组间用 16–24px。密度高于观感，但行高不低于 1.5。

响应式是结构性的，不是流体字号：900px 以下导航收为 66px 图标栏、统计条降为一列；640px 以下导航变为底部浮动条、行式列表改为纵向堆叠、多列表格改为明确横向滚动。

## Elevation & Depth

深度由「色调层次 + 1px 发丝线 + 极轻阴影」三者共同表达，而不是靠投影堆叠。页面底（`18.5%`）→ 面板（`22.5%`）→ 面板内块（`26%`）→ 悬停（`30%`）形成四级明度台阶；内嵌数据区反向下沉到 `16%`。阴影只在两个层级使用：面板静止时一层几乎看不见的接触阴影，浮层（抽屉、弹窗、撤销提示）使用扩散阴影。

### Shadow Vocabulary
- **Contact** (`0 1px 2px oklch(0% 0 0 / 30%)`): 卡片与统计卡静止态。只用来「把卡片按在页面上」，不承担层级。
- **Float** (`0 10px 30px oklch(0% 0 0 / 35%)`): 抽屉、弹窗、消息框。唯一的「浮起」语言。
- **Overlay** (`0 24px 80px oklch(0% 0 0 / 45%)`): 命令面板、登录卡、撤销提示等覆盖全屏的层。

### Named Rules
**The Hairline Rule.** 卡片边界永远用 1px `--line-subtle` 描边表达；禁止用 2px 以上的彩色左边框（`border-left`）标记告警或选中，改用整圈 1px 同色描边 + 淡色底。

**The No-Glass Rule.** 不使用 `backdrop-filter` 模糊做装饰。吸顶顶栏用实色面板底，滚动时文字保持清晰。

## Shapes

圆角阶梯克制，只有五级：4px（`--radius-xs`：小标签、行内代码）/ 6px（`--radius-sm`：按钮、输入框、导航项、仓库候选卡、审计条目等小卡片）/ 9px（`--radius-md`：统计卡、内嵌块、提示卡）/ 12px（`--radius-lg`：内容面板、抽屉内卡片、主要按钮）/ 16px（`--radius-xl`：登录卡）。胶囊形只用于状态标签与计数（999px）。不使用切角、斜边、异形轮廓；8px、10px、14px、20px 这类中间值一律不写。

描边一律 1px；粗细变化只出现在 3px × 12px 的分区标题短竖线与 6px 的状态点。

## Components

### Buttons
克制而精确：只有底色与描边的变化，没有位移、没有阴影跳变。
- **Shape:** 6px 圆角，高 32px，内边距 8px × 15px，13px / 500。
- **Primary:** 仪器蓝底 + 接近白色的反色字；悬停变亮一档（`77%`），按下变深一档（`58%`）。
- **Secondary:** 面板底 + 1px 描边 + 正文色；悬停底色抬到 `--bg-hover`、描边加深、文字转仪器蓝。
- **Danger:** 信号红底 + 反色字；悬停向同色相更深一档移动。
- **Plain / Text / Link:** 悬停只改文字色与描边，不加底色。
- **States:** 默认 / 悬停 / 聚焦（2px 仪器蓝外描边，偏移 2px）/ 按下 / 禁用（`--text-faint` 文字 + 极淡底）/ 加载（图标旋转，宽度不变）。

### Chips
- **Style:** 胶囊形，1px 描边，10px / 550 文字，行高 16px；文字前 5px 圆点，与文字同色（`tag::before`）。
- **State:** 中性（描边灰 + 元信息色）；成功 / 警告 / 危险各用对应状态色描边 + `*-soft` 20% 淡底。颜色永远与圆点、文字同时出现，不单靠颜色区分。

### Cards / Containers
- **Corner Style:** 12px 圆角（面板）、9px（统计卡与内嵌块）。
- **Background:** 面板 `--bg-surface`；面板内的次级块 `--bg-raised`；数据与输出区 `--bg-inset`。
- **Shadow Strategy:** 静止时只有接触阴影；不叠加第二层。
- **Border:** 1px `--line-subtle`。
- **Internal Padding:** 20px；窄屏降到 15px。

### Inputs / Fields
- **Style:** 内嵌底色（`--bg-raised`），1px 描边，6px 圆角，高 32px，13px 正文。
- **Focus:** 描边转仪器蓝 + 3px 仪器蓝 22% 外环；不使用发光阴影。
- **Error / Disabled:** 错误用信号红描边并在下方给出原因文本；禁用降不透明度至 60%，文字转 `--text-faint`。

### Navigation
- **Style:** 左侧常驻轨道，品牌标 + 七项主导航 + 底部工具入口。导航项 38px 高、6px 圆角、图标 17px + 13px 文字。
- **States:** 默认元信息色；悬停抬升底色并转正文色；当前项用 `--brand-soft` 底 + 仪器蓝文字 + 600 字重，左侧 2px 指示条。
- **Mobile:** 900px 以下收为图标栏；640px 以下变为底部浮动条，当前项改为顶部 2px 指示条。

### Stat Card（签名组件）
统计卡是仪表台的读数格：左上角一个 6px 状态点预告该指标是否需要注意，右侧 24px 等宽数字占据视觉重心，指标名 11px、补充说明 10px。悬停只把描边从 subtle 抬到常规档，不位移。

### Loading（加载态）
加载中的容器必须保持与内容同构的占位，不允许塌成空白或整屏转圈：列表用几行 12px 高的浅色条，面板用一块 `--bg-raised` 的空块。占位不使用扫光动画；按钮内的加载只有图标旋转，宽度不变。

### Data Inset（签名组件）
代码、终端输出、日志、只读 JSON 一律放进凹陷块：更深的底色 + 1px 描边 + 11px 等宽字 + 最高 220–360px 后内部滚动。它们从不与内容卡片共享底色，让「这是机器输出」一眼可辨。

## Do's and Don'ts

### Do:
- **Do** 让仪器蓝只出现在主操作、当前选中、可点链接与焦点环上，单屏面积 ≤ 10%。
- **Do** 给每个状态同时配颜色与文字/图标线索（`tag` 的圆点、`.status-dot` 的文字标签）。
- **Do** 用 `--bg-inset` 区分机器输出与内容；用 `--bg-raised` 区分卡片内次级块。
- **Do** 让所有变化的数字使用 `tabular-nums`。
- **Do** 在加载时用与内容同构的静态占位（浅色条或空块），不用扫光动画、不用整屏转圈。
- **Do** 把告警与安全边界的信息写成「原因 + 恢复方式」的具体句子，例如「Harness Phase 4-6 期间禁止发布：完成后可重试」。

### Don't:
- **Don't** 在标题上方叠加 kicker / eyebrow 文本。标题自己承担层级。
- **Don't** 用 `border-left` 3px 以上的彩色粗条标记告警、选中或分类。
- **Don't** 用 `backdrop-filter` 模糊（毛玻璃）作为装饰；吸顶栏用实色。
- **Don't** 给按钮加位移、缩放或投影动画；状态变化只用颜色与描边。
- **Don't** 在界面里使用渐变文字、渐变按钮或发光效果。
- **Don't** 把等宽字体当作「技术感」装饰用于普通标签、按钮或正文；它只服务代码、ID、路径与计数。
- **Don't** 用灰色代替状态色表达状态，也不要只靠颜色表达状态。
