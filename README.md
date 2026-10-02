# 笔灵（Biling）· AI 小说写作伙伴

> “笔下有灵”——一套围绕**单一小说项目**组织的 AI 协作写作工作区。

它不是“输入关键词自动出小说的生成器”，而是让 AI 扮演多个分工角色，配合作者完成从“脑洞”到“完稿”的全过程：**概念引导、蓝图设计、大纲编排、章节写作、记忆压缩、质量评价**。

---

## 界面预览

**书架**：管理你的全部作品，一本书一个独立工作区。

![书架](docs/screenshots/bookshelf.png?v=2)

**工作台 · 设定**：角色 / 地点 / 派系 / 世界规则的结构化设定库，AI 基于设定库做冲突预检与补全建议。

![工作台·设定](docs/screenshots/workspace-settings.png?v=2)

**工作台 · 写作**：小说家基于“相关设定 + 本章大纲 + 压缩记忆 + 风格画像”流式产出正文，每次生成保留为一个版本，可对比回滚。

![工作台·写作](docs/screenshots/workspace-write.png?v=2)

---

## 核心功能

- **设定管理**：角色 / 地点 / 派系 / 规则等结构化设定库，宪法/固化项优先注入 AI 上下文，AI 提供冲突预检与补全建议
- **蓝图**：蓝图师把设定整理成含主题、核心冲突、人物弧光、分卷、伏笔计划的完整蓝图；**新增蓝图不自动生效**，须手动“设为生效中”才会把内容注入写作 / 大纲 / 设定等页面
- **大纲编排**：大纲师按生效蓝图逐章产出大纲，同时登记伏笔账本
- **章节写作**：小说家基于“相关设定 + 本章大纲 + 压缩记忆 + 风格画像”产出正文（每次生成保留为独立版本，可对比回滚），可让评价师对照蓝图与账本打分、定向修订
- **记忆与风格**：提取师把成稿章节压缩为结构化记忆，长篇小说持续推进不崩；从作者编辑 diff 中学习风格画像
- **全流程可复盘**：蓝图 / 大纲 / 章节全版本化，可对比

---

## 使用流程（新手建议按这个顺序）

1. **开一本新书**：在书架填书名、一句话简介、背景类型与题材，创建即进入工作台
2. **搭设定**：先把角色 / 地点 / 势力 / 世界规则写进「设定」，标为「不可变」的设定 AI 必须遵守
3. **定蓝图**：让蓝图师基于设定生成全书蓝图（主题、冲突、人物弧光、分卷、伏笔计划），满意后点「设为生效中」——只有生效蓝图才会注入后续写作
4. **排大纲**：大纲师按生效蓝图逐章产出大纲，确认后自动登记到伏笔账本
5. **写正文**：小说家基于“相关设定 + 本章大纲 + 压缩记忆 + 风格画像”流式生成，可反复重生成并对比版本历史；可让评价师打分后定向修订
6. **记忆自动压缩**：每写几章，提取师把成稿压成结构化记忆，长篇不崩设定
7. **写坏了想改**：蓝图 / 大纲 / 章节都有版本历史，可随时对比回滚

> 在应用「AI 设置」页配置模型 API Key 即可开始（支持 DeepSeek / Qwen / Claude / GPT / Kimi / Gemini / 火山方舟 / Ollama 本地模型等）。未配置 Key 时 AI 功能会提示你先去「模型」页配置，不会输出演示内容。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16（App Router）+ React 19 + TypeScript + Tailwind CSS 4 |
| 后端 | Python + FastAPI + Uvicorn + SQLAlchemy 2 + Alembic |
| 数据库 | SQLite（本地/桌面版默认，位于数据目录 data\）/ PostgreSQL + pgvector（云部署，语义检索） |
| LLM 网关 | LiteLLM（DeepSeek / Qwen / Claude / GPT / Ollama 可切换） |
| 流式 | SSE（正文 / 思考过程实时滚动） |
| 桌面打包 | Electron 壳 + PyInstaller（绿色版 zip；本地脚本 / GitHub Actions 自动打包） |

---

## 目录结构

```
biling/
├─ frontend/            # Next.js 前端（端口 3000）
│  └─ src/
│     ├─ app/           # 页面（书架 / 工作区）
│     └─ components/    # 各功能面板（设定/蓝图/大纲/写作/风格/体检/图谱/模型…）
├─ backend/             # FastAPI 后端（端口 8000）
│  └─ app/
│     ├─ agents/        # AI 角色（蓝图师/大纲师/小说家/评价师/提取师…）
│     ├─ api/           # REST + SSE 路由（含 diagnostics：日志收集与导出）
│     ├─ services/      # 编排与落库逻辑（pipeline.py 等）
│     ├─ llm/           # LiteLLM 网关
│     └─ db/            # 模型 / 会话 / 迁移
├─ desktop/             # Electron 桌面壳（拉起前后端、托盘、导出日志）
├─ .github/workflows/   # GitHub Actions：打 tag 自动打包桌面版
├─ build-desktop.ps1    # 本地一键打包脚本
└─ docs/                # PRD / 技术设计 / 界面截图
```

---

## 环境要求

- Node.js 20+ / 22
- Python 3.11+
- 一个或多个 LLM Provider 的 API Key（DeepSeek / Qwen / Claude / OpenAI 等，可在应用「AI 设置」页或 `backend/.env` 配置）

---

## 快速开始（开发模式）

### 1. 后端（端口 8000）

```bash
cd backend

# 创建并激活虚拟环境
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate  # macOS / Linux

# 安装依赖
pip install -r requirements.txt

# 配置环境变量（模型 Key 等）
cp .env.example .env         # 然后按需填写
# .env 已被 .gitignore 忽略，请勿提交

# 启动（开发模式，热重载；首次启动自动建表）
.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 2. 前端（端口 3000）

```bash
cd frontend

npm install
npm run dev
```

访问 http://localhost:3000 。前端通过 Next.js 代理把 `/api/*` 转发到后端 `127.0.0.1:8000`，无需额外跨域配置。

---

## 配置说明

- **模型 Key**：推荐直接在应用「AI 设置」页填写（写入本地数据库，运行时不需要 `.env`）；也可在 `backend/.env` 配置（如 `DEEPSEEK_API_KEY=sk-xxx`）。未配置 Key 时 AI 功能会报错并引导去「模型」页配置（默认不输出演示内容）；仅开发调试想无 Key 看链路时，设置 `BILING_ALLOW_MOCK_WITHOUT_KEY=true`。
- **数据目录**：所有用户数据（数据库 / 日志 / 导入文件）统一放数据目录。开发默认 `backend/data\`（首次启动自动建目录，并自动迁移旧库 `backend/biling.db`）；桌面版为程序旁的 `data\` 子文件夹，由壳层通过 `BILING_DATA_DIR` 指定。
- **数据库**：默认 SQLite 位于数据目录下（`backend/data/biling.db`），首次启动自动建表；生产迁移用 `alembic upgrade head`。
- **文风**：手动文风（`style_directive_manual`）与蓝图文风互不覆盖；蓝图切换生效时全局文风跟随生效蓝图。

---

## 桌面版（Windows 绿色版）

把前后端打成单个解压即用的 zip：`Biling-<版本>-win.zip`，无需安装 Python / Node。

- **两种打包方式（产物相同）**：
  - 本地一键打包：仓库根目录执行 `.\build-desktop.ps1`，产物在 `dist-desktop\`。
  - GitHub Actions 自动打包：在 `main` 分支打 `v*` 格式标签（如 `v1.0.0`）自动打包并上传到 Releases；普通 push / 非 main 分支打标签不触发。
- **绿色版约定**：
  - 解压后双击 `Biling.exe` 即用（自动拉起内置后端与前端服务）。
  - 用户数据（数据库 / 日志 / 导入文件 / 模型配置）保存在解压目录下的 `data\` 子文件夹；**升级 = 下载新版 zip 覆盖解压，数据不丢失**（zip 内不含 data 目录）。
  - 模型 API Key 直接在应用「AI 设置」页填写，写入本地数据库。
- **日志与排查**：前后端日志统一落盘 `data\logs\`（自动轮转，2MB × 5）。出问题时点书架顶栏「导出日志」图标（或系统托盘右键「导出日志」），会打包后端日志 + 前端日志 + 系统信息为一个 zip，发给作者即可定位问题。

---

## 安全说明

- 小说正文数据、数据库文件（`*.db`）、本地环境变量（`.env`）、运行期数据目录（`data\`）均不纳入版本库
- 本仓库仅包含源码与开发脚本，不包含任何真实的小说内容或模型密钥
- 日志与「导出日志」产物不包含模型 API Key（Key 只存本地数据库）

---

## License

[AGPL-3.0](LICENSE) — GNU Affero General Public License v3.0

本项目为开源软件。你可以自由使用、修改与分发，但**任何基于本项目的衍生作品**（包括以网络服务形式对外提供）必须同样以 AGPL-3.0 开源并公开源代码。

设计思想借鉴声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
