# 本地 SQL 存储迁移方案（草案 v1）

> 状态：方案设计，尚未实施。本文只做设计，不改代码。
> 目标：把 DevTaskConsole 后端当前「本地 JSON 文件 + 原子写 + 进程内串行队列」的持久化，迁移到轻量本地 SQL（SQLite），解决全量重写、`*.tmp` 孤儿文件、并发/崩溃一致性问题，同时保持路由层、前端、共享 schema 不变。

---

## 1. 现状盘点

### 1.1 持久化分布

**固定数据目录** `%LOCALAPPDATA%\DevTaskConsole`（由 `getDataDirectory()` 决定，可被 `DEVTASK_DATA_DIR` 自举覆盖）：

| 文件                        | 所有者                    | 内容形态           | 体量（本机实测） |
| --------------------------- | ------------------------- | ------------------ | ---------------- |
| `console-settings.json`     | `SettingsStore`           | 单对象，三项配置   | 121 B            |
| `control-panel-token`       | `token-store.ts`          | 单值（自举凭据）   | 5 B              |
| `audit-log.json`            | `AuditLog`                | 数组，500 条上限   | 34 KB            |
| `story-services.json`       | `StoryServiceSupervisor`  | 数组（服务注册表） | 1 KB             |
| `cron-mappings.json`        | `CronMappingStore`        | 数组（键值映射）   | 485 B            |
| `cron-dispatches.json`      | `CronDispatchStore`       | 数组（派发轮次）   | —                |
| `workspace-bindings.json`   | `WorkspaceBindingStore`   | 数组（一对一绑定） | 1.8 KB           |
| `application-mappings.json` | `ApplicationMappingStore` | 数组（差异映射）   | 568 B            |

**可配置缓存目录**（默认同上，由 `resolveCacheDirectory()` 决定）：

| 文件                               | 内容形态     | 体量   |
| ---------------------------------- | ------------ | ------ |
| `board-cache.json`                 | 派生数据整块 | 13 KB  |
| `snapshot-cache.json`              | 派生数据整块 | 20 KB  |
| `repository-candidates-cache.json` | 派生数据整块 | 4.6 KB |

**注意**：`workspace-initialization-jobs.json` 虽然在职责上属于「运行期状态」而非缓存，但它**实际写在数据目录**（`initializer.ts:59-62` 用 `dataDirectory ?? getDataDirectory()`），并未走 `resolveCacheDirectory()`。迁移后 `devtask.db` 也固定跟随 `getDataDirectory()`，与之一致。

当前总量约 384 KB，但数据目录里残留**几十个 `*.tmp` 孤儿文件**（主要来自 `workspace-initialization-jobs.json` 的原子写中断）。这是「读全量 → 改对象 → 写全量」模式的典型副作用：文件越大、写越频繁，风险越明显。

### 1.2 共性代码模式

所有 store 都是同一套路：

1. `readFile` 整份 JSON → `JSON.parse` → zod `safeParse`（含去重/唯一性校验）；
2. 内存里改数组 → 排序；
3. `serialize()`（进程内 Promise 队列）串行化写操作；
4. `writeFile` 临时文件 → `rename` 原子替换。

几个 store 实现了**应用层 CAS**：`AuditLog.claimUndo`（撤销占用）、`CronDispatchStore.reserve`（同任务未归档轮次占坑）、`WorkspaceInitializer.start`（同名工作区 running 冲突检查）。这些语义必须在 SQL 层用事务 + 唯一约束等价保留。

### 1.3 数据特点

- 单进程、单机、无网络并发；数据量小（KB~百 KB 级）。
- 写多读多但都是本地操作，SQLite 的性能余量巨大，真正价值在**事务、行级更新、唯一约束**，而不是查询性能。
- Zod schema 是事实上的数据契约，源在 `packages/shared/src/index.ts`，共享给前端。

---

## 2. 方案选型

| 方案              | 形态                                | 优点                                                        | 代价 / 风险                                                                   |
| ----------------- | ----------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `better-sqlite3`  | 原生模块，嵌入式单文件 DB           | 生态成熟、同步 API、事务/索引完备                           | 需原生编译；Windows + pnpm + Node 22 要处理预编译包匹配，升级 Node 可能要重编 |
| **`node:sqlite`** | Node 22 内置实验模块 `DatabaseSync` | **零依赖**、无原生编译、同步 API 与 better-sqlite3 几乎一致 | Node 22.x 仍为 experimental（启动警告）；API 未来可能微调；要求 Node >= 22.5  |
| `sql.js`          | SQLite 编译成 WASM                  | 纯 JS、跨平台无编译                                         | 数据库在内存，需手动序列化落盘，复杂度反而高于现状，不推荐                    |

**推荐：优先 `node:sqlite`**。理由：

1. 项目 `package.json` 已声明 `engines.node >= 22`，天然契合；
2. 零新依赖，规避原生编译的构建风险；
3. 现有 store 是同步/async 混合的串行队列写法，`DatabaseSync` 的同步 API 可直接替换 `readFile`/`writeFile`，改动局部化；
4. experimental 警告可接受；若将来不稳定，换 better-sqlite3 只需替换 DB 适配层（见 §4.1 的隔离设计）。

**兜底**：若团队不接受 experimental 依赖，选 `better-sqlite3`，API 几乎一致，后续迁移只换 import。

---

## 3. 迁移边界：哪些进库、哪些保持文件

### 3.1 进 SQLite（结构化、会增删改查、会增长）

| Store                             | 理由                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| `AuditLog`                        | 追加 + 分页查询 + CAS 撤销，行级更新避免每次重写 34 KB     |
| `WorkspaceInitializer`            | 最大且写最频繁（日志 5000 行），拆表后按行追加日志         |
| `CronMappingStore`                | 键值映射，天然表结构                                       |
| `CronDispatchStore`               | 轮次登记 + 唯一约束（同任务只能一个 open）可由 DB 原子保证 |
| `WorkspaceBindingStore`           | 一对一绑定，两个唯一约束由 DB 保证                         |
| `ApplicationMappingStore`         | 差异映射，主键 `repoName`                                  |
| `StoryServiceSupervisor` 的登记表 | 服务注册表，主键 `storyId`；含端口唯一性约束               |

### 3.2 保持 JSON 文件（不进库）

| 文件                                                                                         | 理由                                                                                           |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `console-settings.json`                                                                      | 读一次、极少写，且参与**自举**（解析缓存目录、源根目录）；必须保证「无 DB 也能读」，保持独立性 |
| `control-panel-token`                                                                        | 自举凭据，必须最先可用，且格式就是单值文件                                                     |
| `board-cache.json` / `snapshot-cache.json` / `repository-candidates-cache.json`              | 本质是「派生数据 + 整块失效」，文件语义比表自然；也符合既有「配置归配置、缓存归缓存」约定      |
| 工作区内由其它工具生成的文件（`scheduled_tasks.json`、`open-questions.json`、`mcp.json` 等） | 不属于本控制台自有状态，只读不写                                                               |

---

## 4. 总体架构

### 4.1 DB 适配层（隔离 experimental 风险）

新增 `apps/server/src/storage/database.ts`：

```
getDataDirectory()/devtask.db
```

- 单例 `DatabaseSync`，`PRAGMA journal_mode = WAL`（减少 Windows 文件占用冲突）、`PRAGMA busy_timeout = 5000`。
- `CREATE TABLE IF NOT EXISTS ...` 在首次打开时建全部表（幂等，兼容空库的新用户）。
- 对外只暴露 `getDatabase()` 与 `withTransaction(fn)`；**只有这一层 import `node:sqlite`**。将来换 better-sqlite3 只改此文件。
- 数据库文件路径固定跟随 `getDataDirectory()`，不随 `cacheDirectory` 迁移（与 token/settings 同一自举目录）。

**并发模型**：`DatabaseSync` 是同步 API。store 的 public 方法仍是 `async`（保持调用方签名），但内部用同步 SQL + 一个进程内 `serialize()` 队列（保留现有模式，避免 Node 事件循环被长事务阻塞时可平滑切到 worker）。跨进程并发由 SQLite 文件锁 + WAL + `busy_timeout` 处理，不再需要 `replaceFile` 的 EPERM 重试。

### 4.2 数据映射通则

- **时间**：统一存 ISO UTC 字符串 `TEXT`（与 zod schema、前端展示一致，避免 `Date` 序列化差异）。
- **可选字段**：用 `NULL` 表示缺省，读出时按 zod schema 省略或保留 `undefined`。
- **快照字段**（`before`/`after`/`request`/`logs` 等 `Record<string, unknown>` 或数组）：存 `TEXT` 中的 JSON 串，读出 `JSON.parse`。SQLite 5.0+ 可用 JSON 函数，但本方案只在应用层解析，保持简单。
- **布尔**：存 `INTEGER 0/1`，读出转boolean。
- **枚举**：存 `TEXT`，读出仍经 zod `safeParse` 校验后返回（保留现有防御性校验）。

---

## 5. 表结构设计

### 5.1 `audit_entries`（审计流水）

对应 `AuditEntry`（`packages/shared/src/index.ts`）。

```sql
CREATE TABLE IF NOT EXISTS audit_entries (
  id           TEXT PRIMARY KEY,
  action       TEXT NOT NULL,
  target       TEXT NOT NULL,
  story_id     TEXT,
  before_json  TEXT,
  after_json   TEXT,
  reversible   INTEGER NOT NULL CHECK (reversible IN (0,1)),
  undone       INTEGER NOT NULL CHECK (undone IN (0,1)),
  undone_at    TEXT,
  result       TEXT NOT NULL CHECK (result IN ('succeeded','failed')),
  error        TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_story   ON audit_entries(story_id);
```

- **条数上限 500**：`record()` 插入后执行 `DELETE FROM audit_entries WHERE id NOT IN (SELECT id FROM audit_entries ORDER BY rowid DESC LIMIT 500)`。**必须按 `rowid`（单调递增）裁剪，不能按 `created_at`**——同毫秒插入的时间戳排序不稳定，会误删最新条目。取代原来的整数组切片。
- `list(limit)`：`SELECT ... ORDER BY created_at DESC LIMIT ?`。
- `find(id)`：主键查询。
- `claimUndo(id, predicate)`：`BEGIN IMMEDIATE` → 查行 → 校验 `undone=0` 与 predicate → `UPDATE undone=1, undone_at=?` → `COMMIT`。原 `isReversible` 回调在事务内执行（保持可注入测试的签名）。
- `releaseUndo(id, error)`：`UPDATE undone=0, undone_at=NULL, error=? WHERE id=?`。注意原实现（`audit-log.ts:144-145`）是从对象中**删除 `undoneAt` 字段**而非写 null，读出时必须按 zod schema 省略 `undoneAt`，不能返回 `undoneAt: null`，否则前端类型不符。
- 同一 id 的并发撤销：唯一主键 + `BEGIN IMMEDIATE` 保证只有一个成功，另一个看到 `undone=1` 返回 `null`。

### 5.2 `workspace_jobs` + `workspace_job_logs`（初始化任务）

对应 `WorkspaceInitializationJob`。把大数组拆成主表 + 日志子表，是本次迁移收益最大的一处。

```sql
CREATE TABLE IF NOT EXISTS workspace_jobs (
  id           TEXT PRIMARY KEY,
  workspace_name TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted','orphaned')),
  stage        TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  exit_code    INTEGER,
  pid          INTEGER,
  resume_count INTEGER NOT NULL DEFAULT 0,
  request_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ws_active ON workspace_jobs(workspace_name)
  WHERE status = 'running';   -- 部分索引：同名工作区只能有一个 running

CREATE TABLE IF NOT EXISTS workspace_job_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL REFERENCES workspace_jobs(id) ON DELETE CASCADE,
  line    TEXT NOT NULL,
  seq     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_logs ON workspace_job_logs(job_id, seq);
```

关键设计：

- **日志按行存**：`recordLog` 变成单行 `INSERT`，不再重写 194 KB 文件。每个 job 最多 5000 行，超出时 delete old rows。
- **`stage` 枚举**：必须严格采用 `workspaceInitializationJobSchema`（`packages/shared/src/index.ts:91-100`）的 8 个值：`worktree`/`workspace_file`/`install`/`graphify`/`verify`/`complete`/`failed`；SQL CHECK 或应用层校验不能漏。`pid` 为正整数可空。
- **partial unique index** `uq_ws_active` 直接把 `start()` 的同名 running 冲突检查下推到 DB：`INSERT` 违反唯一约束 → 映射为 `WorkspaceConflictError`。这消除了原代码「先查再写」的 TOCTOU 窗口。
- **读 job**：`getJob()` 查主表 + `SELECT line FROM workspace_job_logs WHERE job_id=? ORDER BY seq LIMIT 5000`。
- **`resume()` 的业务前置条件不可省**（`initializer.ts:144-160`）：job 必须存在；`running` 或 `orphaned` 拒绝（有外部进程）；`succeeded` 拒绝（无需续跑）；`request` 必须存在（否则无法重放）。全部校验通过后，才在同一事务内执行 `UPDATE status='running', exit_code=NULL, resume_count=resume_count+1, updated_at=? WHERE id=?` + 插入一条「从阶段 X 开始第 N 次续跑」日志。**只做 UPDATE 会跳过这些拒绝分支，导致对已成功/仍在跑的任务误续跑。**
- **`pruneCompletedJobs()` 的语义必须对齐原实现**（`initializer.ts:284-292`）：原逻辑是「当 `this.jobs.size > 50` 时，从非 running 的任务中最旧删起，直到总数 ≤ 50」，**running 任务不计入 50 的限额但也不被删除**。SQL 必须等价为「总数 > 50 时，删 oldest 非 running 行」：`DELETE FROM workspace_jobs WHERE id IN (SELECT id FROM workspace_jobs WHERE status != 'running' ORDER BY updated_at ASC LIMIT (SELECT MAX(0, COUNT(*) - 50) FROM workspace_jobs))`；`ON DELETE CASCADE` 自动清日志。原草案写的 `OFFSET 50` 语义完全不同（会保留 50 个非 running、但可能在总数远大于 50 时行为不一致），必须按此修正。
- **服务重启恢复**：`loadPersistedJobs()` 改为 `SELECT ... WHERE status='running'`，逐条用 `process.kill(pid, 0)` 判活（**EPERM 也视为存活**，见 `initializer.ts:486-493`）；PID 存活 → `status='orphaned'`，否则 → `status='interrupted'` 且 **`stage='failed'`、`exit_code=NULL`**（原草案遗漏这两个字段的复位），同时插日志。
- **flush()/schedulePersistence()**：DB 是即时写，不再需要 150 ms 防抖定时器。但 `recordLog` 高频调用时需要批处理：用 `serialize()` 队列 + 同一事务内多条 insert（见 §7.2 性能考量）。

### 5.3 `cron_mappings`（定时映射）

```sql
CREATE TABLE IF NOT EXISTS cron_mappings (
  task_id          TEXT PRIMARY KEY,
  story_id         TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('query_only','query_fix')),
  owner_verified_at TEXT,
  paused_by_service_stop INTEGER NOT NULL DEFAULT 0 CHECK (paused_by_service_stop IN (0,1))
);
```

- `list()`：`SELECT ... ORDER BY task_id`。`save()`（按 taskId 覆盖写，对应原 `CronMappingStore.save()`）/ `find()` / `update()` / `remove()` 都是单行 SQL。
- `update()` 用动态拼列（只允许 schema 内的固定字段名，杜绝 SQL 注入）。
- 唯一性检查（原 `new Set(...).size`）由主键保证。

### 5.4 `cron_dispatches`（派发轮次）

```sql
CREATE TABLE IF NOT EXISTS cron_dispatches (
  round_id TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL,
  story_id TEXT NOT NULL,
  owner_session_id TEXT,
  job_id   TEXT,
  state    TEXT NOT NULL CHECK (state IN ('open','archived')),
  outcome  TEXT CHECK (outcome IN ('succeeded','failed','stopped')),
  label    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_dispatch ON cron_dispatches(task_id) WHERE state = 'open';
```

- `reserve()`：`BEGIN IMMEDIATE` → `INSERT` → 违反 `uq_open_dispatch` 则抛 `CronDispatchConflictError`。完美保留原「先占坑再建 Job」语义，且并发安全。
- `openFor()` / `archive()` / `attachJob()` / `removeByTask()` 单行 SQL。

### 5.5 `workspace_bindings`（需求 ↔ 工作区）

```sql
CREATE TABLE IF NOT EXISTS workspace_bindings (
  tapd_story_id TEXT PRIMARY KEY,
  workspace_name TEXT NOT NULL UNIQUE,
  story_title TEXT,
  tapd_url TEXT,
  updated_at TEXT NOT NULL
);
```

- 两个唯一约束直接对应 `ensureUnique()`原来的运行时校验。
- `upsert()`：`INSERT ... ON CONFLICT(tapd_story_id) DO UPDATE SET ...`；若 `workspace_name` 撞到别的 story → 唯一约束抛错，映射为 `WorkspaceBindingConflictError`。
- `remove()` / `list()` 简单 SQL。

### 5.6 `application_mappings`（外部身份差异映射）

```sql
CREATE TABLE IF NOT EXISTS application_mappings (
  repo_name TEXT PRIMARY KEY,
  gitlab_project_id INTEGER,
  devops_app TEXT,
  devops_group TEXT
);
```

- `upsert()`：若 `isDefaultApplicationMapping()` 为真 → `DELETE WHERE repo_name=?`（回归默认）；否则 `INSERT ... ON CONFLICT DO UPDATE`。
- **约束不要写错**：`applicationMappingSchema`（`packages/shared/src/index.ts:29-43`）要求的是「`gitlabProjectId` 或 `devopsApp` 至少一个存在」且「`devopsApp` 与 `devopsGroup` 同时存在或同时缺省」。因此**允许存在纯 GitLab 映射（`gitlabProjectId` 有值、`devopsApp`/`devopsGroup` 都为空）**——原草案声称「二者必须同时存在」并建议加 `CHECK ((devops_app IS NULL) = (devops_group IS NULL))`，该 CHECK 本身是对的（同时存在/同时空），但文字表述会误导实现成「必须有 devops 配置」。正确 SQL 约束：`CHECK (gitlab_project_id IS NOT NULL OR devops_app IS NOT NULL)` + `CHECK ((devops_app IS NULL) = (devops_group IS NULL))`。

### 5.7 `story_services`（服务注册表）

```sql
CREATE TABLE IF NOT EXISTS story_services (
  story_id TEXT PRIMARY KEY,
  port     INTEGER NOT NULL UNIQUE,
  cwd      TEXT NOT NULL,
  pid_kind TEXT CHECK (pid_kind IN ('number','string')),
  pid_number INTEGER,
  pid_string TEXT,
  status   TEXT NOT NULL CHECK (status IN ('starting','running','failed','stopped')),
  error    TEXT,
  updated_at TEXT NOT NULL
);
```

- **`pid` 是 `number | string`**（数字 PID 或 herdr/hc 的 address 字符串），SQLite 没有联合类型，用 `pid_kind` + 两列存储，读出时按 kind 还原成 `number | string`。这是本表最特别的设计点。注意 `stop()` 会**保留 stopped 服务的 pid**（`story-service-supervisor.ts:173-181`），便于排查「端口意外复活」时再次停止，迁移不得清空它。
- `port UNIQUE` 与 `story_id` 唯一性来自 `readRegistry()` 的应用层校验（`story-service-supervisor.ts:392-396`）；SQL 层用 `UNIQUE` 固化，且要在写入错误时映射回原有错误类型。
- `recoverPersistedServices()`：`SELECT ... WHERE status != 'stopped'`，逐条 `ensureRunning`。
- `upsert` / `markFailed` / `remove` 都是单行 SQL。

---

## 6. 查询关系设计

各实体间的关系（用 ID 做逻辑外键，**不强制物理 FK**，因为部分实体来自工作区文件、生命周期不同）：

```
workspace_bindings.tapd_story_id ──┐
cron_mappings.story_id ────────────┤
cron_dispatches.story_id ──────────┼── 逻辑关联（TAPD Story ID / 本地 storyId）
audit_entries.story_id ────────────┤     无物理外键：Story 数据源在工作区本地文件，可能先于本库记录消失
story_services.story_id ───────────┘

cron_dispatches.task_id ──→ cron_mappings.task_id
   （定时任务 ID；dispatches 的 task 可能没有本地 mapping，所以不强制 FK）

workspace_jobs.workspace_name ──→ workspace_bindings.workspace_name
   （工作区名；初始化任务与绑定通过名字关联，同样允许单边存在）

workspace_job_logs.job_id ──→ workspace_jobs.id
   （唯一使用物理外键 + ON DELETE CASCADE 的一对多关系，因为子记录完全从属于父记录）
```

**设计原则**：

- 只在**强从属**关系（logs → jobs）用物理 FK；其余用逻辑关联 + 索引，避免删除顺序耦合。
- `storyId` 在不同表里含义略有差异（TAPD ID / Harness story ID），统一作为 `TEXT` 存储，不建跨表 join，由聚合层（`cron-data.ts`、`board.ts`）在内存中组装，保持现有聚合逻辑不变。
- 查询模式都是点查（按主键 / 唯一键）或有序全表扫描，不超过 500 条，索引设计以主键 + 少量 `ORDER BY` 字段为主。

---

## 7. 迁移实施策略

### 7.1 分阶段推进（每阶段可单独测试、可回滚）

| 阶段 | 内容                                                                     | 风险                   |
| ---- | ------------------------------------------------------------------------ | ---------------------- |
| P0   | 新增 `storage/database.ts`，建表、WAL、迁移工具（见 §7.3）               | 低，纯新增             |
| P1   | 迁移 `ApplicationMappingStore` + `WorkspaceBindingStore`（最小、纯映射） | 低                     |
| P2   | 迁移 `CronMappingStore` + `CronDispatchStore`                            | 中（CAS 语义）         |
| P3   | 迁移 `AuditLog`（CAS 撤销 + 上限裁剪）                                   | 中                     |
| P4   | 迁移 `StoryServiceSupervisor` 的注册表部分（pid 联合类型）               | 中                     |
| P5   | 迁移 `WorkspaceInitializer`（日志拆表，收益最大）                        | 高（写频率、恢复逻辑） |
| P6   | 清理旧 JSON 文件（保留备份一个版本周期）、文档与测试收尾                 | 低                     |

每阶段：保留 store 类名、public 方法签名、错误类型；内部实现替换；跑对应 vitest 测试。

### 7.2 性能与事件循环

- `DatabaseSync` 同步调用会阻塞事件循环。单条 SQL 都在微秒级，可接受。
- `WorkspaceInitializer.recordLog` 在 PowerShell 输出高峰时每秒可能几十~几百行：用现有 `serialize()` + `schedulePersistence()` 的防抖模式改造为「积压日志 → 一次性事务批量 insert」，避免每条日志一次事务。
- WAL 模式让读不阻塞写；`busy_timeout=5000` 处理另一控制台实例同时打开的情况。

### 7.3 旧数据一次性迁移（import）

新增 `scripts/migrate-json-to-sqlite.ts`（或在 P0 中提供 `migrateLegacyJson()`）：

1. 对每个旧 JSON 文件：`readFile` → zod `safeParse`（复用现有校验逻辑）→ 批量 `INSERT`（`INSERT OR REPLACE`）。
2. 按依赖顺序：先简单映射表，再Jobs，最后 audits。
3. 迁移前把旧文件复制到 `backup/<timestamp>/`，不删除原文件；P6 再决定是否清理。
4. 幂等：用 `meta` 表记录 `schema_version` 与 `migrated_at`，重复执行不会重复插入。

### 7.4 测试策略

- 现有 vitest 测试全部保留。为让测试继续用临时目录，DB 适配层需支持 `dataDirectory` 注入（测试传 `tmpdir()`）。
- 新增测试：
  - 并发 CAS：`claimUndo` / `reserve` / `start` 的并发冲突只成功一个；
  - 上限裁剪：audit 500 条、jobs 50 条、日志 5000 行；
  - 旧数据迁移：用小 fixture JSON 验证字段映射（尤其 `pid_kind`、可选字段）；
  - 崩溃恢复：模拟 `running` -> `orphaned/interrupted` 的判定。

---

## 8. 风险与开放问题（供评审）

1. **`node:sqlite` experimental**：启动时会打印 `(node:...) ExperimentalWarning: SQLite is an experimental feature`。需确认是否可接受；CI/打包脚本是否过滤警告？
2. **Node 版本下限（必须改）**：`node:sqlite` 从 Node **22.5** 起可用；仓库根 `package.json` 的 `engines.node` 是 `>=22`，允许 22.0~22.4，低版本会直接运行失败。实施前必须把下限提升到 `>=22.5.0`，并在 CI 锁定一个 Node 22 minor 版本——`DatabaseSync` API 在 22.x 小版本间仍有变化。
3. **数据库文件损坏**：SQLite 有 WAL + 事务，但磁盘满/断电仍可能损坏。是否需要一个「检测到 DB 不可打开时回退旧 JSON」的降级路径？本方案默认不降级（复杂且掩盖问题），仅保留备份文件供人工恢复。
4. **多实例同时写**：本机可能开两个控制台实例指向同一数据目录。WAL + `busy_timeout` 能处理，但 `serialize()` 只在单进程内有效；需要确认是否有真实的双实例场景。
5. **迁移时机**：建议在某个版本启动时自动检测「DB 不存在且旧 JSON 存在」→ 自动 import，还是要求用户手动跑迁移脚本？自动更顺畅但增加启动复杂度。
6. **缓存文件是否保留**：本方案保留三个 cache 为 JSON。如果未来缓存体量变大，可单独再议。
7. **约束冲突到领域错误的映射（必须实现）**：DB 唯一约束抛的是 SQLite 错误码，必须显式映射回原有领域错误类型——`workspace_bindings.upsert()` 要区分 `tapd_story_id` 冲突（同需求编辑，允许）与 `workspace_name` 冲突（抛 `WorkspaceBindingConflictError`）；`cron_dispatches.reserve()` 的 `uq_open_dispatch` 冲突要抛 `CronDispatchConflictError`；`workspace_jobs` 的 `uq_ws_active` 冲突要抛 `WorkspaceConflictError`。不能把原始 DB 错误直接透传给前端。
8. **重复导入覆盖（必须防）**：迁移脚本不要用裸 `INSERT OR REPLACE`——它会覆盖用户新写入的数据并触发 FK 级联。改用 `INSERT ... ON CONFLICT DO UPDATE` 且配一张 `meta` 表记录每个源文件的 sha256，重复执行时跳过已导入文件。
9. **测试隔离**：多个 store 的构造函数都默认 `getDataDirectory()`；若 DB 单例按进程缓存，vitest 并发用例会互相串库。适配层必须支持 `dataDirectory` 注入（测试传 `tmpdir()`），且测试间要能重置单例。

## 8.1 更保守的替代路径（先做最痛的一处）

评审指出：当前总量仅 384 KB，真正痛点是 jobs 文件（194 KB + 大量 `.tmp` 孤儿）。若 7 个 store 一次性迁移被认为风险过高，可**先只把 `workspace_job_logs` 拆到 SQLite（或一条 append-only 日志文件），其他 store 保持现状**。这样：

- 最大文件从 194 KB 降到几 KB，`.tmp` 孤儿问题基本消失；
- 只改 `WorkspaceInitializer` 一处，测试面小、可回滚；
- 验证 SQLite 适配层在真实环境（Node 22.5、Windows 文件占用）稳定后，再按 §7.1 的 P1→P4 推进其余 store。

这条路径与 §7.1 的 P5 并不冲突，可视为「P0 + 精简版 P5 先行」。

---

## 9. 工作量预估（仅规模，不作时间承诺）

- P0 适配层 + 建表 + 迁移工具：约 250~350 行 TS。
- P1~P4 四个 store：每个约 80~150 行改动。
- P5 WorkspaceInitializer：约 200~250 行改动（日志拆表 + 恢复逻辑）。
- 测试补充：约 300~500 行。
- 总计约 7 个 store，总体是「中等规模重构」，建议按 P0→P5 顺序推进，每个阶段独立提交。
