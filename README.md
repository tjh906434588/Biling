# 笔灵（Biling）· AI 小说写作伙伴

> “笔下有灵”——一套围绕**单一小说项目**组织的 AI 协作写作工作区。

它不是“输入关键词自动出小说的生成器”，而是让 AI 扮演多个分工角色，配合作者完成从“脑洞”到“完稿”的全过程：**概念引导、蓝图设计、大纲编排、章节写作、记忆压缩、质量评价**。

## 核心能力

- **设定管理**：角色 / 地点 / 派系 / 规则等结构化设定库，按相关性检索，AI 提供冲突预检与补全建议
- **蓝图**：蓝图师把设定整理成含主题、核心冲突、人物弧光、分卷、伏笔计划的完整蓝图；**新增蓝图不自动生效**，须手动“设为生效中”才会把内容注入写作 / 大纲 / 设定等页面
- **大纲编排**：大纲师按生效蓝图逐章产出大纲，同时登记伏笔账本
- **章节写作**：小说家基于“相关设定 + 本章大纲 + 压缩记忆 + 风格画像”产出正文（双版本并行，作者选定合并），可让评价师对照蓝图与账本打分、定向修订
- **记忆与风格**：提取师把成稿章节压缩为结构化记忆，长篇小说持续推进不崩；从作者编辑 diff 中学习风格画像
- **全流程可复盘**：蓝图 / 大纲 / 章节全版本化，可对比

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16（App Router）+ React 19 + TypeScript + Tailwind CSS 4 |
| 后端 | Python + FastAPI + Uvicorn + SQLAlchemy 2 + Alembic |
| 数据库 | SQLite（开发）/ PostgreSQL + pgvector（生产，语义检索） |
| LLM 网关 | LiteLLM（DeepSeek / Qwen / Claude / GPT / Ollama 可切换） |
| 流式 | SSE（正文 / 思考过程实时滚动） |

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
│     ├─ api/           # REST + SSE 路由
│     ├─ services/      # 编排与落库逻辑（pipeline.py 等）
│     ├─ llm/           # LiteLLM 网关
│     └─ db/            # 模型 / 会话 / 迁移
└─ docs/                # PRD 与技术设计
```

## 环境要求

- Node.js 18+ / 20+
- Python 3.11+
- 一个或多个 LLM Provider 的 API Key（DeepSeek / Qwen / Claude / OpenAI 等，未配置时可用 Mock 流跑通链路）

## 快速开始

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

## 配置说明

- **模型 Key**：在 `backend/.env` 中配置（如 `DEEPSEEK_API_KEY=sk-xxx`）。未配置任何 Key 时默认用 Mock 流跑通 SSE 链路；如需强制真实模型，设置 `BILING_ALLOW_MOCK_WITHOUT_KEY=false`。
- **数据库**：默认 SQLite `backend/biling.db`（首次启动自动建表）；生产迁移用 `alembic upgrade head`。
- **文风**：手动文风（`style_directive_manual`）与蓝图文风互不覆盖；蓝图切换生效时全局文风跟随生效蓝图。

## 安全说明

- 小说正文数据、数据库文件（`*.db`）、本地环境变量（`.env`）均不纳入版本库
- 本仓库仅包含源码与开发脚本，不包含任何真实的小说内容或模型密钥

## License

MIT
