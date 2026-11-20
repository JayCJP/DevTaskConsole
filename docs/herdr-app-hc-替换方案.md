# 用 herdr-app 启动 + hc 管理替换 herdr 的方案

> 状态：**已实施完成**（2026-11-19）。typecheck / lint / 284 单测全绿，端到端真实 CLI 闭环验证通过。
> 前提：herdr-app 桌面端常开（`do` 命令依赖窗口）。

## 实施结果

| 文件                           | 状态                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `app-hc-story-service.ts`      | 新增：runner + launch（清理同名 tab、建 tab、keep off、轮询 pid）+ stop（幂等）                                   |
| `app-hc-story-service.test.ts` | 新增 12 测试，覆盖 argv/folder/address/keep off/stop + 3 补充用例                                                 |
| `story-service-supervisor.ts`  | pid 类型放宽 `number → number \| string`（含默认 killProcessTree 包装、isStoryService 校验、cleanupFailedLaunch） |
| `service-monitor.ts`           | restart 的 previousPid 放宽为 `number \| string`                                                                  |
| `herdr-story-service.ts`       | stop 签名放宽并加数字句柄守卫（herdr/spawn 回归 11 项全绿）                                                       |
| `server.ts`                    | 工厂加 `app-hc` 分支，统一用 `resolveStoryServiceLauncher`，workspacesRoot 作 space folder                        |

端到端验证（真实 CLI）：space 创建/复用、tab.new 起 codebuddy、keep off、foreground.pid 轮询、health 200、同名 tab 处理、stop 幂等、端口释放，全部通过。

切换方式：**默认即为 `app-hc`**（无需配置，herdr-app 桌端常开即可）。显式设 `DEVTASK_STORY_LAUNCHER=herdr` 回退老 herdr；设 `spawn` 走内置实现。

> **升级注意**：默认 launcher 由 herdr 改为 app-hc 属行为变更（`resolveStoryServiceLauncher` 中空值/未知值均映射为 app-hc）。未显式设置环境变量的存量环境升级后会切到 app-hc，需保证 herdr-app 桌面端常开；否则请显式设 `DEVTASK_STORY_LAUNCHER=herdr` 或 `spawn`。

## Code Review 后的修正（2026-11-19）

双轴审查（Standards / Spec）后落实：

1. **统一 launcher resolver**：删除 app-hc 文件里重复的 `resolveAppHcStoryServiceLauncher`，扩展原 `resolveStoryServiceLauncher` 值域支持 `app-hc`，两处不再漂移。
2. **stop/清理只吞 not_found**：引入带 `kind` 的 `CliError`，`stop` 与 `closeOldTerminal` 仅忽略 `not_found`，真实 CLI 故障（如桌面端未开）透传，不再静默掩盖。
3. **同名清理顺序测试**：改用跨工具共享事件序列，断言 `['kill:old','rm:old','tab.new']` 时序，防止回归成先建后杀。
4. **新增透传用例**：验证真实 CLI 失败不被吞。

复核说明：审查提出的「`herdr-app ls` 结构未验证」为误报——实施阶段已用真实 CLI 确认 `spaces[].tabs[].terminals[].terminal` 结构并据此建 tab、截图验证。桌面端关闭时 `ls` 输出非 JSON，runner 会正确抛错，符合「桌面端常开」前提。

复核后验证：typecheck / lint / 284 单测全绿。

## 1. 背景与目标

`apps/server/src/services/herdr-story-service.ts` 当前通过 herdr CLI（`workspace`/`pane` 子命令）托管每个 Story 的 CodeBuddy 服务进程。

本方案改为 **herdr-app 起终端 + hc 查/停终端**：

- **herdr-app**（GPUI 桌面 GUI）：负责创建 space/tab 并显示，给人看。
- **hc**（herdr-core CLI）：负责查状态、停止、清理，给脚本用。
- 两者共享 herdr-core 的终端注册表，通过 **terminal address**（如 `t1w`）互相操作。

不变量：端口分配、`/api/v1/health` 就绪探测、退避重启、注册表、status 语义全部不动，只替换"进程怎么起、怎么停"。

## 2. 实测已验证的事实

| 项                        | 结果                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| herdr-app 起终端、hc 可见 | ✅ `hc get t1w` 拿到完整信息                                     |
| 健康检查                  | ✅ 端口 200，`foreground.pid` 与 health 返回的 pid 一致          |
| 停止链路                  | ✅ `hc kill` + `hc rm`，端口释放、app 侧 tab 联动消失            |
| 显示在 UI                 | ✅ 截图确认 tab 名=storyId、cwd 正确、CodeBuddy Serve 输出可见   |
| space/tab 新建            | ✅ `space.new` / `tab.new --name --space --folder --argv` 均成功 |
| `hc keep --off`           | ✅ True→False 生效                                               |
| 异常退出不谎报 running    | ✅ kill 真实进程后 health 000，supervisor 标 failed              |

## 3. Review 发现的 4 个遗漏点（已实测）

| #   | 遗漏点                               | 证据                                                                                                                                    | 处理                                                           |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | launch 前必须关闭同名旧 tab/terminal | `tab.new --name story-dup` 两次都成功，建出 t20/t21 两个 tab，旧的仍占端口。herdr 靠 label 反查关旧实例                                 | launch 前 `herdr-app ls` 找同名 tab → `hc kill/rm` 旧 terminal |
| 2   | stop 必须幂等                        | `hc kill/rm` 对不存在终端返回 `{error:not_found}` 但 **exit code=0**。只看 exit code 会误判成功，直接抛错则违反 herdr"找不到就兜底"语义 | not_found 视为已停止，忽略                                     |
| 3   | `foreground.pid` 就绪时机不稳定      | `hc run --bg` 立即 get 为 null（需重试），`tab.new` 时立即有值                                                                          | 带超时重试轮询（如 10s）                                       |
| 4   | runner 不能只看 exit code            | hc/app 把错误写在 stdout `{error:{kind,message,hint}}` 且 exit 0                                                                        | 解析 stdout JSON 的 error 字段                                 |

## 4. 覆盖度矩阵（herdr 行为契约 → app-hc）

| herdr 行为契约                    | 覆盖   | 实现要点                                                  |
| --------------------------------- | ------ | --------------------------------------------------------- |
| launch 先清理旧实例，保证新 pid   | ⚠️需补 | launch 前查同名 tab 并关旧 terminal                       |
| launch 返回变化的 pid             | ✅     | 返回 address，每次新建必变                                |
| launch 失败明确抛错               | ⚠️需补 | tab.new 无 terminal / hc get 超时无 foreground.pid → 抛错 |
| launch 起 codebuddy 参数一致      | ✅     | argv 数组含 port/auth/permission，实测 health 200         |
| stop 按标签关 workspace           | ✅     | `hc kill address` + `hc rm`                               |
| stop 找不到就兜底（幂等）         | ⚠️需补 | kill not_found 视为已停止；不再 taskkill                  |
| 错误提示引导 fallback             | ✅     | 文案改成 `DEVTASK_STORY_LAUNCHER=spawn`                   |
| runner 非 JSON / error 信封当失败 | ⚠️需补 | 解析 stdout JSON 的 error 字段，不依赖 exit code          |
| 进程不随终端窗口消失              | ✅     | hc 核心特性 + 桌面常开前提                                |
| 显示在 UI（herdr 无，新增）       | ✅增强 | tab 名=storyId                                            |

## 5. 关键实现要点

```
launch(cwd, port, storyId):
  1. herdr-app ls → 找固定 spaceName 下名为 storyId 的 tab，取 terminal address
     若有 → hc kill + hc rm 旧 terminal（幂等，not_found 忽略）
  2. herdr-app do tab.new --name storyId --space <id> --folder cwd --argv JSON数组
     → 取 terminal address（无 address 则抛错）
  3. hc keep <address> --off（错误忽略）
  4. 轮询 hc get <address> 取 foreground.pid（带超时）→ 确认真实进程起来
  5. 返回 address

stop(pid=address, storyId):
  hc kill address → not_found 视为已停止
  hc rm address → not_found 忽略
  （不再 taskkill；端口释放由 supervisor waitUntilPortReleased 兜底）

runner(binary):
  execFile → stdout.trim() → JSON.parse
  若 parsed.error → 抛错（即使 exit=0）
  若非 JSON → 抛错
```

## 6. 改动文件清单

| 文件                                | 改动                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 新增 `app-hc-story-service.ts`      | lifecycle（launch/stop）+ runner + 类型                                                               |
| 新增 `app-hc-story-service.test.ts` | mock execFile，覆盖 argv/folder/address/keep off/stop + 3 个补充用例                                  |
| `story-service-supervisor.ts`       | pid 类型 `number → number \| string`（约 6 处签名 + isStoryService 校验）；`cleanupFailedLaunch` 分支 |
| `server.ts`                         | `createStoryServiceSupervisor()` 加 `app-hc` 分支；导入新 lifecycle；`storyServiceLauncher` 值域      |
| 前端（可选）                        | 展示层同步 `app-hc` 值                                                                                |

不改动 `herdr-story-service.ts` 及其测试——herdr/spawn 两种 launcher 完整保留，可随时切回。

## 7. 测试方案

1. **单测**（mock execFile）：
   - 原有覆盖：argv 含 port/auth/permission、folder、address 返回、keep off、stop 调 kill/rm
   - **补充**：同名旧 tab 被清理、stop 对 not_found 幂等、runner 解析 error 信封（exit=0）
2. **类型**：`pnpm --filter @devtask/server typecheck`
3. **端到端**：`DEVTASK_STORY_LAUNCHER=app-hc` 起后端 → 通过现有 API 起 Story 服务 → 确认 UI 出现 tab、health 200、停止后 tab 消失端口释放、手动 kill codebuddy 不谎报 running
4. **回归**：显式 `herdr`、`spawn` 两种 launcher 的现有测试全绿（默认已切为 app-hc）

## 8. 风险与缓解

| 风险                                | 缓解                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| app 桌面端关掉后无法启动服务        | 前提已确认常开；可选：检测 app 不可用时回退 `hc run --bg`（无需 GUI） |
| `keep:true` 被 app 在窗口重开时重置 | launch 后 `hc keep --off`；health 轮询兜底不谎报 running              |
| 注册表旧数据是纯数字 pid            | 新校验同时接受 number/string，老数据原样可读                          |
| 多 Story 并发建 tab                 | space 复用 + tab 名=storyId（唯一）+ launch 前清理同名                |

## 9. 结论

替换可行且改动可控：1 个新文件 + 1 个测试 + supervisor 类型放宽（约 6 处）+ server.ts 接线。herdr/spawn 完全保留，可随时切回。
