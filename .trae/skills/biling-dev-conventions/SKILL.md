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
- **doc 与 code 镜像属例外**：规则文档（如 `rules/fanqie_rules.md`）与运行时代码（`platform_rules.py`）是同一内容的两种形态；文档为人类可读源、代码为运行时事实源，通过 skill 流程保证同步，不另立第三份。
- 发现重复 → 合并回单一源，并在源文件注释里说明"谁从这里派生"。

## 1. 技术栈与目录（分层固定）

| 层 | 路径 | 职责 |
|---|---|---|
| 前端页面 | `frontend/src/app/` | App Router 页面，全部 `"use client"`（layout.tsx 保持 server 组件，仅挂 Provider/宿主） |
| 前端业务 | `frontend/src/features/` | 业务功能目录，每个 feature 统一为 **`index.tsx`（主入口）+ `components/`（私有组件，与入口平级）**：`bookshelf/`（书架）、`workspace/`（工作台壳 + 各面板：writing/ outline/ settings/ blueprint/ graph/ ledger/ style/ models/ 各自也是 index.tsx + components/）；`app/` 下页面文件仅做路由转发 |
| 前端全局组件 | `frontend/src/components/` | **仅**全局共享组件（modal/message/notification/loading/confirm-dialog/info-tip/brand/title-bar/novel-meta/author-confirm…），每个组件一个文件夹 `<名>/index.tsx`；index.tsx 平级不允许有其他文件——其余文件收进 `<名>/components/` 子文件夹（如 author-confirm：`index.tsx` + `components/{store,host,dialog,panel,notifier}.tsx`）；单文件超 700 行同样按 §4.5 拆分 |
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
- 不改动全局关键配置：`next.config.ts` 的 `compress: false`（SSE 反缓冲）、`proxyTimeout`、rewrite 代理，`main.py` 的启动迁移/全局异常处理器。

## 4. 前端代码风格

- 新文件顶部写 `@file 路径 · 作用 · 关键机制` 中文头注释；关键逻辑行内注释说明"为什么"。
- 常量优先收敛到 `constants/`，业务代码从 `@/constants` 导入；**类型从常量推导**（如 `SETTING_TYPES` → `SettingType`），不重复定义枚举。
- 领域类型统一放 `types/api.ts`，经 `@/lib/api` re-export；页面禁止直接 `fetch`，一律走 `lib/api/` 的函数。
- **组件放置（自动执行）**：每个 feature/页面统一结构 = `index.tsx`（主入口/页面组件）+ `components/`（该 feature 私有组件，与 index.tsx 平级）；跨面板共享放 `workspace/components/`；跨路由全局共享 → `components/`（业务代码不放 `components/`）。页面路由文件（`app/**/page.tsx`）只做转发，页面逻辑在对应 feature 的 index.tsx。
- **API 新增（自动执行）**：新接口函数按后端域放入 `lib/api/<域>.ts`（域文件不存在则新建并在 `index.ts` barrel 追加 `export *`），业务代码统一 `import from "@/lib/api"`，不新增别的入口。
- **任务类型集合**（setting/creation/review/extract/chronicle）：前端在 `frontend/src/constants/task-types.ts` 单一维护（`types/api.ts` 的 `TaskType` 与 `models-panel.tsx` 的 UI 都由它派生）；后端在 `backend/app/api/models.py` 单独一份（跨端契约例外）。新增/修改任务类型：前端只改 `constants/task-types.ts` 即可，同时同步后端 `api/models.py`。
- 组件默认 `"use client"`；Tailwind 4，同时覆盖亮/暗色（`dark:`）；样式类名简洁、不引入多余库。
- 错误提示走全局 `message` / `notification`；**不吞异常**——catch 里至少 `log.errorFrom`（见 `@/lib/logging`）留痕，前端错误经 `POST /api/logs` 落盘供「导出日志」排查。
- 交互类改动（弹窗/确认/流式）遵循既有组件模式（modal.tsx / confirm-dialog.tsx / auto-textarea.tsx）。
- **AI 生成任务**：走 `stream/agents/*` 接口与 `AgentTask` 持久化 + SSE 事件流约定（`context_ready → stream_delta* → schema_validate → stored`），新增/改动生成流程必须沿用，不得绕过任务持久化与作者确认机制。

## 4.5 大文件自动拆分

单文件（组件 / 页面 / hook）超过约 700 行时，**自动按逻辑边界拆分，无需用户提醒**；拆完保证行为、样式、文案、时序完全不变。

- 模块级纯函数 / 类型 / 单文件常量 → 抽到同目录 `*-utils.ts` 或领域子目录。
- 渲染 return 里的大型 JSX 区块 → 抽展示型子组件（props 显式声明 + 回调）；所有 state、数据加载、时序逻辑保留在主组件，子组件只做展示。
- 编排逻辑（编辑器 / AI 流程 / 轮询恢复等）→ 抽自定义 hooks（如 `use-chapter-editor.ts` / `use-ai-flows.ts` / `use-resume-agent-task.ts`），共享状态经类型化 ctx 传入。
- 明显重复的代码块 → 收敛成小 helper（先确认行为可证明等价再合）。
- 子组件放对应 feature 的 `components/` 子目录：`features/workspace/{writing,outline,settings,blueprint,graph,ledger,style,models}/components/`、`features/bookshelf/components/` 等；跨面板共享放 `features/workspace/components/`；新文件顶部写 `@file 路径 · 作用 · 关键机制` 头注释，含 hooks 的加 `"use client"`。
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
- 提交前用 `git status --short` 确认无敏感/冗余文件混入；大改动分逻辑提交。

## 8. 改完如何验证

- **后端**：`cd backend && .venv\Scripts\python.exe -c "import app.main"` 无异常即通过；涉及数据目录/日志改动时实际启动一次，确认 `data\` 与 `data\logs\` 正常生成。
- **前端**：`cd frontend && npm run build`（含 TypeScript 检查）；有对应 smoke 脚本（`backend/scripts/smoke_*.py`）时按场景运行。
- **桌面/打包改动**：至少本地跑 `.\build-desktop.ps1` 出包验证；涉及端口/数据目录/日志的改动，用生产 standalone（`node .next/standalone/server.js`）手测关键路径。

## 9. 文档与 Skill

- **README 随改动同步**：任何改动若涉及 README 描述的内容（功能增删、页面/入口变化、目录结构、技术栈、发版流程、使用说明等），必须**同批修改 README 并一起提交**，不要等用户提醒；改完自查一遍 README 是否还有过时描述（与"完成即自动提交"配合，README 和功能改动进同一批 commit）。
- 番茄题材提取 → 走 `fanqie-extract` skill 的统一流程，不要另起做法。
- 本规范需要调整 → 先说明改动点再改本文件。

## 10. 禁止项汇总

- 硬编码 API Key / 敏感配置；用 `print` 代替日志；空 catch 吞异常。
- 把数据文件、语料、私有状态提交进 git。
- 破坏 SSE 流式（gzip 压缩）、rewrite 代理、全局异常捕获等关键链路。
- 为一次使用建不必要的抽象；重复三行可接受，不为假设的未来需求过度设计。
