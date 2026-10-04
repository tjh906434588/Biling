---
name: biling-dev-conventions
description: 笔灵（Biling）项目开发规范：新增功能与代码优化必须遵守的统一约定（目录分层、代码风格、数据目录、日志、提交规范）。当用户要求新增功能、优化或重构代码、审查或提交本项目代码时使用。
---

# Biling 项目开发规范

本项目为「Next.js 前端 + FastAPI 后端 + Electron 桌面壳」的 AI 小说写作工作区。任何新增功能、代码优化、重构、提交都按本规范执行，保证全项目风格一致、可排查、可重复。

## 0. 核心原则：单一维护源

同一份数据、配置、规则、文案，**只在一个地方维护**（Single Source of Truth）。新增代码前先问"这份东西原来定义在哪"，去那里改，不要另起一份。

- **类型从常量推导**：`types/api.ts` 引用 `@/constants`（如 `SETTING_TYPES`、`TASK_TYPES`），不重复写枚举/联合。
- **常量收敛 constants/**：UI 标签、key、枚举值集中在 `frontend/src/constants/`（按领域分文件：task-types / agents / outline / settings / meta / writing / api / storage），业务代码从 `@/constants` 导入。
- **常量粒度边界（自动执行，无需用户提醒）**：仅被单个文件用到的常量**就地保留**（靠近使用处更可读），**不要**把所有常量物理塞进一个文件；拆分大文件时顺带把「跨文件重复」的常量提升到 `constants/`——提升的是消除重复，不是搬位置。
- **跨端契约属例外**：后端 `backend/` 与前端 `frontend/` 各自维护一份接口契约（如任务类型、API 路径），这是合理的分端例外；变更时必须**两端同步**并在此类单源文件头部注释里写明"另一端在哪"。
- **枚举字典统一收敛（自动执行，无需用户提醒）**：会变动的枚举/字典数据——**文案、数据列表、下拉选项、预置集合等一切枚举性质数据**——统一在后端 `app/api/meta.py` 的 `DICT_BUILDERS` 注册（一个 key 一个构建函数），经 `GET /api/meta?keys=...` 按 key 下发——**不一个枚举一个接口**；前端统一经 `lib/meta-dict.ts` 的 `loadMetaDict(key)` 拉取（模块缓存 + TTL 过期自动重拉，命中未过期不请求），各业务 loader 从它取值并做失败兜底。**固定死文案前端写死；会变动的枚举/字典数据（文案或数据列表）一律走字典接口**（枚举变化不再导致前端文案或选项过时）。**新增枚举：后端 `meta.py` 的 `DICT_BUILDERS` 加一项即可；前端需类型约束时补静态 key 清单（如 `task-types.ts` 的 `TASK_TYPES`），无需另起接口**。
  - **双层字典（用户可自定义的枚举，如题材）**：内置枚举在 `DICT_BUILDERS` 代码里只读；允许用户新增/删除的 key 加入 `CUSTOMIZABLE_KEYS`，用户自定义项存 `meta_dict_items` 表（**存库而非代码 → 升级版本不重置**），`GET /api/meta` 合并下发（自定义项带 `custom: True` 标记供前端区分）、`POST /api/meta/{key}/items` 新增、`DELETE /api/meta/{key}/items/{value}` 删除（内置项不可删）。前端增删后调 `lib/meta-dict.ts` 的 `invalidateMetaDict(key)` 失效缓存再重拉。题材即此模式：输入即正式入库（无临时态），删除走删除接口。后端侧需要程序化登记自定义项时复用 `meta.py::_upsert_custom_items`（如蓝图导入 AI 新增题材自动入库）。
- **doc 与 code 镜像属例外**：规则文档（如 `rules/fanqie_rules.md`）与运行时代码（`platform_rules.py`）是同一内容的两种形态；文档为人类可读源、代码为运行时事实源，通过 skill 流程保证同步，不另立第三份。
- 发现重复 → 合并回单一源，并在源文件注释里说明"谁从这里派生"。

## 1. 技术栈与目录（分层固定）

| 层 | 路径 | 职责 |
|---|---|---|
| 前端页面 | `frontend/src/app/` | App Router 页面，全部 `"use client"`（layout.tsx 保持 server 组件，仅挂 Provider/宿主） |
| 前端业务 | `frontend/src/features/` | 业务功能目录，每个 feature 统一为 **`index.tsx`（主入口）+ `components/`（私有组件，与入口平级）**：`bookshelf/`（书架）、`workspace/`（工作台壳 + 各面板：writing/ outline/ settings/ blueprint/ graph/ ledger/ style/ models/ 各自也是 index.tsx + components/）；跨面板共享放 `workspace/components/`；`app/` 下页面文件仅做路由转发 |
| 前端全局组件 | `frontend/src/components/` | **仅**全局共享组件（modal/message/notification/loading/confirm-dialog/info-tip/brand/title-bar/novel-meta/author-confirm…），每个组件一个文件夹 `<名>/index.tsx`；index.tsx 平级不允许有其他文件——其余文件收进 `<名>/components/` 子文件夹（如 author-confirm：`index.tsx` + `components/{store,host,dialog,panel,notifier}.tsx`） |
| 前端 API 客户端 | `frontend/src/lib/api/` | 按后端域拆分（novels/settings/chapters/reviews/outlines/ledger/blueprints/style/graph/models/agents/prompts），`index.ts` barrel 统一出口 |
| 前端共享逻辑 | `frontend/src/lib/` | API 客户端、状态、工具逻辑 |
| 前端常量 | `frontend/src/constants/` | 共享常量（单一事实源，类型由常量推导） |
| 前端类型 | `frontend/src/types/` | API/UI/工作区类型 |
| 前端工具 | `frontend/src/utils/` | 纯函数工具 |
| 后端路由 | `backend/app/api/` | REST + SSE 路由（薄层，只做入参校验与调用 service） |
| 后端编排 | `backend/app/services/` | 落库、跨模块编排逻辑 |
| 后端 AI 角色 | `backend/app/agents/` | 各 AI 角色（prompt + 解析 + 状态机） |
| 后端数据 | `backend/app/db/` | 模型 / 会话 / 迁移 |
| 后端 schema | `backend/app/schemas/` | pydantic 出入参 |
| 后端网关 | `backend/app/llm/` | LiteLLM 网关与路由 |
| 桌面壳 | `desktop/` | Electron 主进程（拉起前后端、托盘、导出日志） |

**后端业务模块 → 文件映射（一眼定位模块）**：

| 业务模块 | 路由 `api/` | 契约 `schemas/` | 主要逻辑 `services/` |
|---|---|---|---|
| 小说项目 | novels.py | novel.py | — |
| 设定库（含概念转正） | novels.py + concepts.py | concept.py | setting_checker.py |
| 章节与版本 | chapters.py | chapter.py | — |
| 章节大纲 | outlines.py | （在 agents.py 大纲师段） | outline_checker.py |
| 蓝图 | blueprints.py | blueprint.py | blueprint_checker.py / blueprint_outline_template.py / file_import.py |
| 伏笔账本 | ledger.py | ledger.py | — |
| 实体图谱 | graph.py | graph.py | entity_checker.py / detector.py |
| 风格画像 | style.py | style.py | — |
| 记忆审查 | memory.py | （内联/通用类型） | — |
| 写作指令 | prompts.py | prompts.py | — |
| 模型接入/路由 | models.py | （内联） | llm/（gateway.py + routes.py） |
| AI 角色（SSE 流式） | stream.py | agents.py | pipeline.py + agents/*.py |
| 诊断/日志 | diagnostics.py | — | — |

命名对齐约定（新增代码遵守，不强制搬动既有文件）：`api/<业务模块>.py` 与 `schemas/<业务模块>.py` 同名对齐；某业务契约目前散落在别处（如大纲在 agents.py）属既有现状，新增该模块的 schema 时优先补独立 `<模块>.py` 归拢。

## 2. 数据目录与配置约定

- 所有用户数据（数据库、日志、导入文件）放**数据目录**：开发默认 `backend/data\`，桌面版为程序旁 `data\`（由 `BILING_DATA_DIR` 指定）。**不得把数据写进源码目录**。
- SQLite 文件 = `<data_dir>/biling.db`；日志 = `<data_dir>/logs/`。
- 配置走 pydantic-settings（`backend/app/config.py`），环境变量前缀 `BILING_`，字段用小写蛇形。
- **模型 API Key 一律存数据库**（`provider_keys` / `app_preference`），页面「AI 设置」填写；禁止硬编码 Key、禁止运行时依赖 `.env` 才能工作。
- 新增表：改 `backend/app/db/models.py`；兼容旧库用 `app/db/migrate.py` 的幂等补列；schema 大改再考虑 alembic。

## 3. 后端代码风格

- 中文 docstring + 中文注释；模块顶部写「用途 + 关键机制」说明。
- 类型注解齐全（含 `Optional` / `list[dict]` 等）；方法级 docstring 说明行为与边界。
- 日志用 `logger = logging.getLogger(__name__)`，禁止 `print`；异常捕获后必须 `logger.exception(...)` 或至少 `logger.warning`，**禁止空 except 吞异常**。
- 分层调用：api → services → db，避免路由里写复杂业务；跨角色复用放 services。
- **命名对齐（自动执行）**：新增路由/契约文件时 `api/<业务模块>.py` 与 `schemas/<业务模块>.py` 同名对齐（见 §1 业务模块映射表），同一业务模块在 api/schema/service 各层的文件命名保持一致，便于一眼对应。
- 不改动全局关键配置：`next.config.ts` 的 `compress: false`（SSE 反缓冲）、`proxyTimeout`、rewrite 代理，`main.py` 的启动迁移/全局异常处理器。

## 4. 前端代码风格

- 新文件顶部写 `@file 路径 · 作用 · 关键机制` 中文头注释；关键逻辑行内注释说明"为什么"。
- 领域类型统一放 `types/api.ts`，经 `@/lib/api` re-export；页面禁止直接 `fetch`，一律走 `lib/api/` 的函数。
- **API 新增（自动执行）**：新接口函数按后端域放入 `lib/api/<域>.ts`（域文件不存在则新建并在 `index.ts` barrel 追加 `export *`），业务代码统一 `import from "@/lib/api"`，不新增别的入口。
- **任务类型（枚举字典统一收敛）**：key 静态清单在 `frontend/src/constants/task-types.ts`（`types/api.ts` 的 `TaskType` 由它推导，编译期约束）；label/hint/角色由后端 `app/api/meta.py` 的 `TASK_TYPES` 维护、经 `GET /api/meta` 的 `task_types` 字典下发（角色由角色注册表动态聚合），前端经 `loadTaskTypes()`（统一缓存）取值。新增/修改任务类型：后端 `meta.py` 改 `TASK_TYPES` 即可，前端 key 清单补 key（漏补编译报错提醒），文案自动下发，不另起接口。
- 组件默认 `"use client"`；Tailwind 4，同时覆盖亮/暗色（`dark:`）；样式类名简洁、不引入多余库。
- 错误提示走全局 `message` / `notification`；**不吞异常**——catch 里至少 `log.errorFrom`（见 `@/lib/logging`）留痕，前端错误经 `POST /api/logs` 落盘供「导出日志」排查。
- 交互类改动（弹窗/确认/流式）遵循既有组件模式（modal.tsx / confirm-dialog.tsx / auto-textarea.tsx）。
- **AI 生成任务**：走 `stream/agents/*` 接口与 `AgentTask` 持久化 + SSE 事件流约定（`context_ready → stream_delta* → schema_validate → stored`），新增/改动生成流程必须沿用，不得绕过任务持久化与作者确认机制。
- **AI 任务恢复协议**：所有会展示「生成中 / 思考过程 / 正文流式输出」的 AI 功能，必须把任务持久化到 `AgentTask`，并与 HTTP/SSE 客户端生命周期解耦。工作台进入时统一调用 `GET /api/stream/agents/tasks?novel_id=...` 获取全部 `running` 任务；返回必须包含可恢复业务上下文的完整 `params`、任务时间、`thinking/draft` 进度和待作者确认点。前端按 `agent + params` 恢复对应业务页面、表单和过程弹窗；关闭弹窗、切换 Tab、页面卸载或刷新都不得取消后台任务，重新进入后继续显示任务进度。任务结束或失败后停止恢复「生成中」弹窗并刷新业务数据。禁止仅依赖 `localStorage`、React state 或模块级缓存判断任务是否仍在生成；禁止在多个页面各自实现互相冲突的 running 轮询。跨后端重启仍需恢复完整思考/正文时，必须增加数据库快照或事件持久化，不能依赖进程内 `PROGRESS`。
- **人工协作正文协议**：AI 初稿、人工编辑、AI 扩写、AI 优化都必须创建版本，不直接覆盖其他来源版本。**确认式版本化**：在 AI 版本上的编辑只是临时改动（前端内存暂存，切版本来回可恢复，改回原样即清除），不会自动派生版本；只有作者点「存为新版本」确认后才派生 `source=user_edit` 子版本（原版本保留不变），避免改一点就多一个版本。`user_edit` 版本自身的编辑仍原地 PATCH 自动保存（防抖 2s + 切版本/卸载兜底）。AI 流程（定稿/提取/评价/优化/扩写）发起前若检测到未确认的临时修改，必须拦截并提示先「存为新版本」。AI 扩写使用 `novelist` 的 `mode=expand`，落库为 `source=expanded` 子版本，并保留原稿。评价始终绑定具体 `chapter_version_id`，人工编辑派生新版本后旧评价不自动迁移。定稿只是激活当前非空版本，不自动提取记忆；记忆提取必须由作者明确触发，且只允许已定稿、非空正文。AI 评价、优化、扩写均为可选辅助动作，不得阻塞定稿或记忆提取。新增下一章前，最新章节必须完成定稿并成功提取记忆；空白人工草稿允许退出，但不得评价、扩写、定稿或提取。标题只允许通过正文区人工编辑入口修改，并同步章节与当前人工版本。

## 4.5 大文件自动拆分

单文件（组件 / 页面 / hook）超过约 700 行时，**自动按逻辑边界拆分，无需用户提醒**；拆完保证行为、样式、文案、时序完全不变。

- 模块级纯函数 / 类型 / 单文件常量 → 抽到同目录 `*-utils.ts` 或领域子目录。
- 渲染 return 里的大型 JSX 区块 → 抽展示型子组件（props 显式声明 + 回调）；所有 state、数据加载、时序逻辑保留在主组件，子组件只做展示。
- 编排逻辑（编辑器 / AI 流程 / 轮询恢复等）→ 抽自定义 hooks（如 `use-chapter-editor.ts` / `use-ai-flows.ts` / `use-resume-agent-task.ts`），共享状态经类型化 ctx 传入。
- 明显重复的代码块 → 收敛成小 helper（先确认行为可证明等价再合）。
- 子组件按 §1 的 features/components 结构落位（跨面板共享放 `workspace/components/`）；含 hooks 的加 `"use client"`。
- 红线：不改防抖 / 竞态守卫 / useEffect 依赖 / SSE 与持久化逻辑；不把「依赖父组件闭包且无法干净传 props」的 JSX 强行抽出；不为拆分引入大型 ctx「上帝对象」之外的不必要抽象。
- 页面文件（`app/**/page.tsx`）：默认导出必须留在 page 且导出名不变（Next.js 要求）；内联弹窗/表单/区块可拆到对应领域子目录。
- 拆完必须 `cd frontend && npm run build`（含 TS 检查）验证通过后再提交。

## 5. 日志与诊断（添加 / 修改 / 删除规范）

**可读性**：后端日志落盘 `data/logs/biling.log`（2MB×5 轮转，级别 `BILING_LOG_LEVEL` 控制，默认 INFO）；前端错误经 `POST /api/logs` 落盘 `frontend.log`；「导出日志」打包两者 + 系统信息。出问题时必须能从日志直接定位根因。

**添加（新增代码必须带）**：
- 关键路径入口/出口打 `info`（带 novel_id / task_id / agent 等上下文，方便按小说/任务检索）；
- 异常/失败一律 `logger.exception(...)`（带 traceback）或至少 `logger.warning(...)`，**禁止空 except 吞异常**；
- 前端 catch 至少 `log.errorFrom(context, err)`（见 `@/lib/logging`），**禁止只弹提示不留日志**。

**级别选择**：
- `error`：异常/失败（含 traceback）；`warning`：可恢复 / 降级 / 兼容分支；`info`：关键事件（不逐条打细节）；`debug`：细节排查（默认关闭）。
- 全局音量由 `BILING_LOG_LEVEL`（DEBUG/INFO/WARNING/ERROR）控制，默认 INFO。

**不要打**：请求/响应正文全文（可能含小说正文与 Key）、模型 API Key、一次性临时调试输出。

**修改**：改日志级别/文案时注意「用户友好文案」与「技术细节」的分工（友好文案进提示、技术细节进日志）；改事件/上报结构时同步 `@/lib/logging` 与导出格式。

**删除**：过时/无用的日志及时删，不保留调试残留；同一错误不要在多处重复打（收敛到单一出口），避免日志冗余。

## 6. 桌面版与打包（涉及桌面化时必须同步）

- 任何改动若影响前后端启动、端口、数据目录、日志，必须同步检查 `desktop/main.js`（拉起/退出/托盘/导出日志）与 `build-desktop.ps1`。
- 数据目录用 `BILING_DATA_DIR` 传给后端；zip 不含 `data\`，升级覆盖不丢数据。
- 发版：改 `desktop/package.json` 的 version → main 打 `v*` tag → Actions 自动打包上传 Releases（普通 push / 非 main tag 不打包）。
- **版本号约定**：`desktop/package.json` 的 version 是唯一发版号，会自动体现在三处——窗口标题与托盘提示（`vX.Y.Z`）、压缩包名（`Biling-X.Y.Z-win.zip`）、GitHub Release tag。发版只改这一处即可，勿在多处手写版本号。
- 图标改动：改 `desktop/build/icon.svg` → `cd desktop && npm run make:icon` 重新生成。

## 7. 提交规范

- **完成即自动提交**：每次功能/优化/修复改动验证通过后，直接提交并推送到 `main` 分支，按逻辑拆分多个 commit，**无需再询问用户**；提交信息遵循下方格式约定。
- **README 随改动同步**：改动若涉及 README 描述的内容（功能增删、页面/入口变化、目录结构、技术栈、发版流程、使用说明等），必须**在本次改动中同步更新 README 再一起提交**，不要等用户提醒；提交前自查 README 是否还有过时描述。
- Conventional Commits + 中文描述：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:`（如 `feat: 桌面版打包落地`）。
- **禁止提交**：`data\`、`.env`、`*.db`、构建产物（`build/ dist-desktop/ backend/dist/`）、`.workbuddy/`、`tools/fanqie_crawler/corpus/`、`desktop/node_modules/`、图标中间产物 `desktop/build/icon-*.png`。
- 提交前用 `git status --short` 确认无敏感/冗余文件混入。

### 7.5 发版版本号（SemVer，提交驱动 + 建议确认）

- 版本号单一事实源 = `desktop/package.json` 的 `version`（桌面版标题栏经 preload 读取展示，前端不要手写）。
- 采用语义化版本 `v主.次.修`：小修 `fix/refactor` → 修（v1.0.0 → v1.0.1）；新增功能 `feat` → 次（→ v1.1.0）；不兼容大改/改头换面 → 主（→ v2.0.0）。
- **发版判断（自动执行）**：发版时对比 `上次 v* tag → 当前 HEAD` 的提交类型，取最高档给出版号建议：
  1. 有 `breaking`（提交信息含 `BREAKING CHANGE` 或明显不兼容/改头换面）→ 建议 major，**必须用户确认**；
  2. 否则有 `feat` → 建议 minor；
  3. 否则（仅 `fix`/`refactor`/`docs`/`chore`）→ 建议 patch。
- **发版动作**：把建议版号报给用户并说明依据，用户点头后：改 `desktop/package.json` 的 `version` → 提交（`chore: 发布 vX.Y.Z`）→ `git tag vX.Y.Z` → `git push --tags`。除 major 外无需再问。

## 8. 改完如何验证

- **后端**：`cd backend && .venv\Scripts\python.exe -c "import app.main"` 无异常即通过；涉及数据目录/日志改动时实际启动一次，确认 `data\` 与 `data\logs\` 正常生成。
- **前端**：`cd frontend && npm run build`（含 TypeScript 检查）；有对应 smoke 脚本（`backend/scripts/smoke_*.py`）时按场景运行。
- **桌面/打包改动**：至少本地跑 `.\build-desktop.ps1` 出包验证；涉及端口/数据目录/日志的改动，用生产 standalone（`node .next/standalone/server.js`）手测关键路径。

## 9. 文档与 Skill

- 番茄题材提取 → 走 `fanqie-extract` skill 的统一流程，不要另起做法。
- 本规范需要调整 → 先说明改动点再改本文件。

## 10. 禁止项汇总

- 硬编码 API Key / 敏感配置；用 `print` 代替日志；空 catch 吞异常。
- 把数据文件、语料、私有状态提交进 git。
- 破坏 SSE 流式（gzip 压缩）、rewrite 代理、全局异常捕获等关键链路。
- 为一次使用建不必要的抽象；重复三行可接受，不为假设的未来需求过度设计。
