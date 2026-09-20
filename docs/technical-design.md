# 技术设计：笔灵（Biling）· AI 小说写作伙伴

> 版本：v0.1（草案）｜日期：2026-09-10｜状态：待评审

---

## 1. 架构总览

```
┌────────────────────────────── 前端 (Next.js) ──────────────────────────────┐
│  项目列表 · 设定管理 · 蓝图/大纲 · 写作编辑器(TipTap) │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ REST + SSE（流式）
┌────────────────────────────── 后端 (FastAPI) ──────────────────────────────┐
│  API 路由层                                                               │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │ 编排层（轻量 Pipeline）：设定抽取 → 蓝图师 → 大纲师 → 小说家 → 评价师   │   │
│  │ 每节点 = 角色实现（build_context / run / parse_output）               │   │
│  ├────────────────────────────────────────────────────────────────────┤   │
│  │ 共享记忆层：设定库 · 故事状态 · 伏笔账本 · 风格画像 · 质量账本        │   │
│  ├────────────────────────────────────────────────────────────────────┤   │
│  │ RAG：embedding + pgvector 语义检索 · 实体名精确匹配 · token 预算器   │   │
│  ├────────────────────────────────────────────────────────────────────┤   │
│  │ LLM 网关：LiteLLM（DeepSeek/Qwen/Claude/GPT/Ollama 可切换）         │   │
│  └────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                   PostgreSQL + pgvector（MVP 可换 SQLite）
```

**设计原则**

1. **角色 = 有状态的节点**，不是 6 个独立 prompt。每个角色定义：输入上下文怎么装配、输出 schema 是什么、读写哪些记忆。
2. **一切记忆持久化**，聊天记录不作为状态传递的唯一途径。
3. **结构化输出为硬约束**：所有角色产出先过 Pydantic/JSON Schema 校验，失败则自纠错重试。
4. **流式 + 后台任务分离**：文本流式给前端，schema 校验/入库在后台完成。

---

## 2. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | Next.js 14+（App Router）+ TypeScript + Tailwind | 富文本编辑用 **TipTap**（块级、扩展生态好） |
| 状态/请求 | SWR 或 TanStack Query + fetch | 流式用 EventSource/fetch reader |
| 后端 | Python 3.11 + FastAPI + Uvicorn | SSE、async、后台任务 |
| ORM/迁移 | SQLAlchemy 2 + Alembic | |
| 数据库 | PostgreSQL 15 + pgvector（开发可用 SQLite 兜底） | 语义检索 |
| LLM 网关 | LiteLLM（OpenAI 兼容） | provider 可切换 |
| 结构化输出 | Pydantic v2 + JSON Schema + 自纠错重试 | |
| Embedding | bge-m3 或 text-embedding-3-small | 设定/章节向量化 |
| 任务队列 | asyncio + BackgroundTasks（MVP）；后续可换 Celery | 提取师等后处理 |
| 部署 | Docker Compose（前端 + 后端 + PG） | |

---

## 3. 目录结构

```
biling/
├─ docs/                      # 本设计文档 + PRD
├─ backend/
│  ├─ app/
│  │  ├─ main.py              # FastAPI 入口，CORS、SSE 挂载
│  │  ├─ api/                 # 路由：novels/settings/blueprints/outlines/chapters/agents/stream
│  │  ├─ agents/              # 角色：blueprint_architect outliner novelist reviser extractor critic setting_extractor style_extractor import_checker
│  │  │  └─ base.py           # 角色基类：build_context()/run()/parse_output() 约定
│  │  ├─ memory/              # 共享记忆层仓储：settings_repo ledger_repo state_repo style_repo quality_repo
│  │  ├─ rag/                 # embedding、检索、token 预算器
│  │  ├─ llm/                 # LiteLLM 封装、模型路由（按任务选模型）、流式封装
│  │  ├─ schemas/             # Pydantic：角色输入输出 schema + 数据模型 schema
│  │  ├─ db/                  # SQLAlchemy 模型、session、迁移
│  │  └─ services/            # 业务编排（agent pipeline 调用）
│  └─ tests/
└─ frontend/
   ├─ app/
   │  ├─ (dashboard)/         # 项目列表
   │  └─ novels/[id]/
   │     ├─ settings/         # 设定管理
   │     ├─ blueprint/        # 蓝图
   │     ├─ outline/          # 大纲 + 伏笔账本
   │     └─ write/            # 写作页（核心）
   ├─ components/editor/      # TipTap
   └─ lib/                    # api client、stream 工具、hooks
```

---

## 4. 数据模型

### 4.1 核心表（DDL 要点）

```sql
-- 小说项目
novels(id UUID PK, title TEXT, premise TEXT, created_at, updated_at)

-- 设定条目（统一表 + type 区分；角色/地点/派系/规则/物品/概念）
settings(
  id UUID PK, novel_id FK, type TEXT,          -- character|location|faction|world_rule|item|concept
  name TEXT, description TEXT,
  structured JSONB,                            -- 按 type 的字段：如角色{appearance, personality, goals, relations}
  is_constitution BOOLEAN DEFAULT false,       -- 小说宪法标记：不可变硬约束（世界规则/禁忌），评价师硬依据
  embedding VECTOR(1024),                      -- pgvector；SQLite 开发期可为 NULL
  created_at, updated_at, deleted_at
)
-- M2 增强（借鉴 NeuroBook nb-memory，防"同一角色两条设定"分身问题）：
--   aliases JSONB —— 别名表（如"岚"与"占卜师岚"），带别名生效章节；检索与抽取按别名归一
--   merged_into_id UUID NULL —— 分身合并：发现 A/B 是同一主体时合并并指向主条目，旧条目保留供审计

-- 概念卡片（设定抽取的沉淀物，作者在「设定」页确认转正）
concept_cards(
  id UUID PK, novel_id FK, raw_text TEXT,      -- 用户原话
  extracted JSONB,                             -- 结构化抽取结果（见设定抽取 schema）
  status TEXT,                                 -- pending|confirmed|rejected|integrated
  created_at
)

-- 蓝图（版本化，version 链）
blueprints(
  id UUID PK, novel_id FK, version INT,
  parent_id UUID NULL,                         -- 版本链
  content JSONB,                               -- 完整蓝图对象
  status TEXT,                                 -- draft|active|archived
  created_at
)

-- 章节大纲（一章节一条；含节拍与账本操作）
outlines(
  id UUID PK, novel_id FK, blueprint_id FK, chapter_no INT,
  title TEXT, content JSONB,                   -- goal/chapter_function/beats/pov/characters/locations/conflicts/plant/resolve/thread_updates
  status TEXT,                                 -- draft|approved
  created_at
)

-- 伏笔账本（可视化所有钩子；含紧迫度与超期检测）
plot_ledger(
  id UUID PK, novel_id FK,
  item_type TEXT,                              -- setup|thread|character_state|location_state|unresolved_hook
  description TEXT, related_entity TEXT,
  chapter_introduced INT, chapter_resolved INT NULL,
  urgency INT NULL,                            -- 紧迫度 1-10（大纲师/提取师标注）
  target_reveal_chapter INT NULL,              -- 计划揭示章节
  status TEXT,                                 -- open|closed|abandoned
  confidence TEXT                              -- high|medium|low（提取师置信度）
)

-- 章节（正文；多版本通过 chapter_versions 表达）
chapters(
  id UUID PK, novel_id FK, outline_id FK NULL, chapter_no INT,
  title TEXT, content TEXT,                    -- 正式版正文（用户选定/合并后的）
  status TEXT,                                 -- draft|complete
  word_count INT, created_at, updated_at
)
chapter_versions(
  id UUID PK, chapter_id FK, version_no INT,
  source TEXT,                                 -- novelist|user_edit|merged
  content TEXT,                                -- 该版本全文
  is_active BOOLEAN,                           -- 当前正式
  created_at
)

-- 故事状态快照（提取师产出，每章一条）
story_state(
  id UUID PK, novel_id FK, chapter_no INT,
  summary TEXT,                                -- 120 字摘要
  key_events JSONB, character_states JSONB, world_state_changes JSONB,
  new_foreshadowing JSONB, resolved_foreshadowing JSONB,
  unresolved_hooks JSONB, next_chapter_implications JSONB,
  created_at
)
-- M2 增强（借鉴 NeuroBook 双时间轴 + as-of 查询，解决"时间泄漏/前后矛盾"）：
--   当前为"每章覆盖式快照"，无法回答"第 N 章时世界是什么样、那时还不知道什么"。
--   M2 起为快照加失效区间：since_chapter INT / invalidated_at_chapter INT NULL；
--   查询任意时点状态 = 取 since_chapter <= N 且 (invalidated_at_chapter IS NULL OR invalidated_at_chapter > N) 的最新一条；
--   提取师产出下一章时，对已失效的状态条目补 invalidated_at_chapter（不删除，保留审计）。

-- 风格画像（版本化，随用户编辑迭代）
style_profiles(
  id UUID PK, novel_id FK, version INT,
  traits JSONB,                                -- 句式/词汇/视角/节奏偏好 + 示例片段
  avoid_list JSONB,                            -- 用户多次拒绝的写法
  source_diff_ids JSONB,                       -- 引用产生本次学习的编辑 diff
  updated_at
)

-- 质量账本（评价师产出）
quality_reviews(
  id UUID PK, novel_id FK, chapter_version_id FK,
  overall_score INT,
  rubric JSONB,                                -- 分维度 {score, comment, evidence}
  issues JSONB,                                -- [{severity, type, desc, suggested_fix, ledger_ref?}]
  strengths JSONB, revision_hints JSONB,
  created_at
)

-- 模型路由配置（运行时可改，换模型不改代码）
model_routes(
  id UUID PK, task_type TEXT,                  -- setting|creation|review|extract|chat
  provider TEXT, model TEXT, temperature REAL, max_tokens INT,
  context_window INT,                          -- 该模型上下文窗口（token 预算器按此动态装配）
  is_default BOOLEAN, updated_at
)

-- AI 生成检测配置（可选，体检性质；不设硬阈值不阻断写作）
detector_config(
  id UUID PK, enabled BOOLEAN DEFAULT false,
  backend TEXT,                                -- local_heuristic|zhuque_api
  api_key TEXT NULL, base_url TEXT NULL,       -- zhuque 经腾讯云 EdgeOne 网关（企业版）
  updated_at
)
```

### 4.2 关联关系

- `novels 1—N settings / blueprints / outlines / chapters / plot_ledger / story_state / style_profiles / concept_cards`
- `chapters 1—N chapter_versions 1—1 quality_reviews（按版本）`
- `outlines —* plot_ledger`（大纲的 plant/resolve 操作落到 ledger 行）

---

## 5. 角色设计（输入 / 输出 Schema / 实现要点）

> **编排方式（决策记录）**：产品为"逐步人工确认为主、未来可加自主成书"（先人后自）。MVP～v0.3 采用**薄自研 Pipeline**——每个角色实现统一接口 `build_context / run / parse_output`，主流程顺序调用 + 后台任务，即 §1 的 Agent 约定。**"自主成书"模式预留状态机/断点恢复扩展**：Agent 接口保持稳定，届时增加带持久化 checkpoint 的 runner 或迁移 LangGraph，角色实现原样复用，不重写。

> 通用约定：每个角色 = `build_context(novel_id, 参数) -> ContextPack` ＋ `run(context) -> stream` ＋ `parse_output(流式文本) -> Pydantic 对象`。产出 schema 校验失败 → 携带错误信息自纠错重试 1 次 → 再失败则落 `quality_reviews` 标记告警并人工介入。

> **角色区分机制（"防穿一条裤子"）**：区分角色靠 4 层隔离，不靠换不同模型（多数角色共用底层模型）：
> 1. **信息隔离（最硬）**：每个角色只能看到自己的信息切片——小说家只拿 POV 裁剪后的蓝图与"禁止角色"清单，看不到全知 synopsis 与未登场角色；提取师只看本章正文；评价师才看完整蓝图+宪法。代码上通过 `ContextPack` 字段白名单强制。
> 2. **产出协议不同**：五种互不串型的结构化产出（蓝图 / 大纲 / 正文 / 记忆 / 评分），schema 各自独立校验。
> 3. **参数不同**：温度按任务分化（蓝图 0.3 / 创作 0.9 / 提取 0.15 / 评审 0.3）。
> 4. **提示词与后处理不同**：各角色 prompt 硬约束（如写作有"有限视角/禁 AI 套话/禁全知"）+ 各角色独立的入库/聚合逻辑。
> **盲点兜底**：评审与创作同模型存在"盲点重叠"，按 §13.2 用 L1 双态冷启动 → L2 换更强模型 → L3 交叉评审逐级缓解。

### 5.2 蓝图师（Blueprint Architect）

**职责**：把确认后的概念/设定整理成完整小说蓝图（版本化）。

**输入**：已确认概念卡片 + 设定库摘要 + 用户补充要求。

**输出 schema**：

```json
{
  "title": "《灰烬与晨星》",
  "logline": "一句话故事",
  "theme": "记忆与身份的代价",
  "core_conflict": "主角必须忘记爱人才能拯救世界",
  "world_rules": [{"name": "魔法消耗寿命", "detail": "每次施法扣减寿命", "constraints": ["无法逆转"]}],
  "character_arcs": [{"character": "岚", "start": "冷漠的占卜师", "end": "为守护而自我牺牲", "turning_points": ["第2卷发现身世"]}],
  "volumes": [{"no": 1, "name": "灰烬", "focus": "结识与背叛", "chapters_range": "1-20"}],
  "foreshadowing_plan": [{"plant_chapter": 5, "payoff_chapter": 38, "desc": "主角左手的印记"}],
  "open_questions": ["世界是否真需要被拯救？"]
}
```

**实现要点**：
- 产出即生成 `blueprints` 新版本（`draft`），作者审阅后可 `approve` 并 `activate`；版本可回滚。
- **规则冲突校验**：产出后把 `world_rules` 与设定库现有规则比对，冲突写入 `open_questions` 或直接要求作者决策。
- 蓝图是后续所有角色的"宪法"，大纲师/小说家/评价师都引用 `active` 版本。

### 5.3 大纲师（Outliner）

**职责**：基于蓝图逐章产出章节大纲，并维护伏笔账本。

**输入**：active 蓝图 + 最近一章 story_state + 伏笔账本 open 项 + 已写章节标题列表。

**输出 schema（单章）**：

```json
{
  "chapter": {
    "no": 3,
    "title": "灰烬来信",
    "goal": "揭示主角身份并触发与岚的第一次冲突",
    "chapter_function": "revelation",       -- 章节功能：progression|buildup|turning|climax|revelation|resolution|interlude，派生 L3 节奏指令（§5.7）
    "pov": "岚",
    "info_control": {                       -- 章节信息控制（借鉴 NeuroBook brief* 字段，悬念管理显式化，落 outlines.content 与小说家 L3 指令）
      "reader_knows": "读者已知旧王城地图被藏",
      "protagonist_knows": "主角知道岚在说谎",
      "must_hide": "岚的真实身份",
      "hint_only": "半枚印记的来历（点到为止）"
    },
    "beats": [
      {"beat_no": 1, "type": "scene", "pov": "岚", "content": "占卜房收到署名不明的信", "length_hint": "1200字", "emotion": "不安"}
    ],
    "characters": ["岚", "主角"],
    "locations": ["旧王城·占卜房"],
    "conflicts": [{"type": "external", "with": "主角", "stakes": "身份暴露"}],
    "plant_foreshadowing": [{"desc": "信的落款只有半枚印记", "payoff_hint": "与主角左手印记呼应", "latest_payoff_chapter": 20}],
    "resolve_foreshadowing": [{"ledger_id": 12, "how": "收回第1章的旧王城地图"}],
    "thread_updates": [{"thread": "岚的伪装", "new_state": "被主角看穿破绽"}]
  }
}
```

**实现要点**：
- **生成下一章前必读伏笔账本**：`resolve_foreshadowing` 只能引用 ledger 中 `open` 且 `chapter_resolved` 未超期的项；plant 的新伏笔必须登记进 ledger。
- 产出即生成 `outlines(draft)` + 批量写 `plot_ledger`（plant/resolve/thread 操作）。作者 approve 后大纲生效。
- 连续 N 章没有任何 resolve 时，schema 校验阶段告警"伏笔积压"。

### 5.4 小说家（Novelist）

**职责**：基于装配好的上下文，一次产出 **2 个版本**。

**输入（ContextPack，由 token 预算器装配，详见 §7）**：
- 本章大纲（beats/goal/chapter_function/plant/resolve）
- 相关设定（RAG 检索结果，过滤到本章涉及实体）
- 前文压缩记忆（最近 story_state 若干条）
- 最近 1–2 章全文（保留文风连续性）
- 风格画像（traits + avoid_list）
- active 蓝图的相关片段（theme/core_conflict）
- **三层写作指令（§5.7）**：L1 通用防 AI 硬约束 + L2 作品风格画像 + L3 本章节奏/心态指令（由 `chapter_function` 与写作模式派生）
- 写作模式：`draft_free`（自由续写/初稿，放松心态）｜`outline_guided`（按大纲执行，目标推进）

**输出**：一段定稿正文（带自评 note，如"本章用到的设定：…；待回收伏笔：…"）。

**生成策略（详见 §8）**：单次 LLM 调用（`temperature` 由 `model_routes` 配置，默认 0.75）流式生成；完成后落一个 `chapter_versions(source='novelist')` 并标为正式版，用户后续编辑另存 `user_edit` 版本。

**实现要点**：
- 上下文装配是核心，杜绝"整库灌给模型"。为此在 `build_context` 里：
  1. **信息可见性过滤（POV 裁剪，借鉴 Arboris）**：先算"本章可见角色集合" = 已登场角色（从已完成章节/记忆提取）∪ 本章大纲计划登场角色；只把可见角色的设定给模型，**未登场角色连名字都不出现**；同时剔除蓝图中的剧透字段（full_synopsis、后续章节大纲等），防"主角全知"。
  2. 大纲师产出已含 `characters/locations` 清单 → 精确匹配 + embedding 召回相关设定（top-10 以内）；
  3. **三层写作指令装配（§5.7）**：L1 从系统级 prompt 模板取固定段；L2 从 `style_profiles` active 版取 traits/avoid_list/示例；L3 按 `chapter_function` + 写作模式**运行时派生**——`climax/turning` 给"加快节奏、冲突升级"指令，`buildup/interlude` 才允许"舒缓从容、不急于推进"；`draft_free` 才注入"写到哪算哪"的放松心态，`outline_guided` 注入"完成本章 goal"的目标推进指令。**L3 同时注入大纲的 `info_control`（§5.3）**：读者/主角各知道什么、必须向读者隐瞒什么、只能点到为止的伏笔——正文不得提前泄露 `must_hide` 内容；
  4. 冲突校验：设定库规则（含"小说宪法"硬约束） vs 大纲中的 plant/conflict，冲突项提示进上下文让小说家避坑；
  5. 生成后强制 schema 校验章节正文长度下限，防止空章/截断。
- 生成完成后**自动触发提取师**（后台任务）更新记忆。

### 5.5 提取师（Extractor）

**职责**：把成稿章节压缩为结构化记忆，驱动长篇一致性。

**输入**：章节全文（用户选定/合并后的正式版）+ 上一章 story_state + 伏笔账本当前状态。

**输出 schema**：

```json
{
  "summary": "120字摘要",
  "key_events": [{"event": "主角收到半印记来信", "importance": "high"}],
  "character_states": [{"character": "岚", "state": "已发现主角身份", "confidence": "high"}],
  "world_state_changes": [{"rule": "魔法消耗寿命", "change": "主角本卷累计耗寿5年"}],
  "new_foreshadowing": [{"desc": "半枚印记", "hint": "与主角左手印记同源", "suggested_payoff_chapter": null}],
  "resolved_foreshadowing": [{"ledger_id": 12}],
  "unresolved_hooks": [{"hook": "旧王城地图去向", "since_chapter": 1}],
  "next_chapter_implications": ["岚将质问主角身份"]
}
```

**实现要点**：
- 压缩不是"缩写"，是**结构化记忆**：产出直接更新 `story_state` 与 `plot_ledger`（new→open，resolved→closed）。
- 置信度标注：`confidence=low` 的条目进入待作者确认队列，不直接作为事实写入设定库。
- 每章必跑；幂等（同一 chapter 重跑覆盖旧快照）。

### 5.6 评价师（Critic）

**职责**：对照蓝图与账本评价章节质量，反哺小说家。

**输入**：章节版本全文 + active 蓝图 + 伏笔账本 + 本章大纲（含 chapter_function）+ 风格画像 + 三层写作指令（§5.7，用于核对合规）。

**输出 schema**：

```json
{
  "overall_score": 82,
  "rubric": {
    "blueprint_adherence": {"score": 90, "comment": "贴合第2卷目标", "evidence": "chapter3 完成‘揭示身份’节拍"},
    "consistency": {"score": 75, "comment": "与设定冲突1处", "evidence": "岚的占卜房在第1章为三层，此处写两层"},
    "character_voice": {"score": 80, "comment": "岚的语气偏冷冽，与画像一致", "evidence": "…原文引用…"},
    "pacing": {"score": 85, "comment": "节拍长度均衡，与 chapter_function=revelation 的节奏指令一致", "evidence": "…"},
    "style_compliance": {"score": 82, "comment": "语言自然流畅、有故事感而非散文感", "evidence": "…原文引用…", "standard": "检验标准：读者会觉得这个作者挺有意思吗？语言自然流畅吗？"},
    "foreshadowing_accountability": {"score": 88, "comment": "如期回收 ledger#12", "evidence": "…"}
  },
  "issues": [{"severity": "high", "type": "consistency", "desc": "占卜房楼层不一致", "suggested_fix": "统一为三层"}],
  "strengths": ["结尾悬念处理佳"],
  "revision_hints": ["将冲突前置到第2节拍"]
}
```

**实现要点**：
- **必须对照蓝图/账本打分**（evidence 字段强制非空），泛泛而谈"写得好"的回复视为无效输出，要求重跑。
- **评审态冷启动**（不带生成上下文）+ 降温度 + "严苛编辑"角色；模型策略按 §13.2 分级（MVP 同模型双态，进阶单独换更强模型）。
- 评分写 `quality_reviews`；`issues` 可触发"定向修订"（小说家带 issue 清单重写特定段落）。
- 对当前定稿正文评分，输出推荐与修订意见（`issues` 驱动定向修订）。

### 5.7 写作指令三层作用域（防"指令穿一条裤子"）

写作指令**不能一股脑全塞给小说家**——那样既会污染风格画像（把全局约束当作品风格学走），又会让所有章节一个节奏（高潮也写成温吞水）。按作用域拆三层，分层存储、分层装配：

| 层 | 作用域 | 内容示例 | 存储 | 装配到 |
|---|---|---|---|---|
| **L1 通用防 AI 硬约束** | 全局（所有项目） | 语言直接/少修饰、多写动作、Show don't tell、避免文学腔与散文化、禁总结性结尾、有限视角、禁 AI 套话 | 系统级 `prompts` 模板固定段（§17.1 #6） | 小说家 system prompt |
| **L2 作品风格画像** | 单部作品（每章一致） | 作品文风（如"轻松幽默+大智慧的现代混合风格、口语化、网络词、像聪明朋友讲故事"）+ avoid_list + 示例片段 | `style_profiles`（§9） | 小说家、评价师 |
| **L3 章节节奏/心态指令** | 单章（随 chapter_function 变化） | 由 `chapter_function` 派生：climax/turning → "加快节奏、冲突升级"；buildup/interlude → "舒缓从容、不急于推进"；由写作模式派生心态：`draft_free` → "写到哪算哪"，`outline_guided` → "完成本章 goal" | 运行时派生，挂 `outlines.chapter_function`（§5.3） | 小说家 |

**关键约束（实现时强制）**：

1. **节奏指令禁止套全本**：`climax/turning` 章节绝不注入"舒缓从容"指令（会写出温吞高潮，比 AI 味更穿帮）；L3 必须由 `chapter_function` 显式派生。
2. **心态指令按写作模式分流**："写到哪算哪、不追求完美"只属于 `draft_free`（自由续写/初稿找感觉）；`outline_guided`（按大纲执行）必须给目标推进指令，否则产出无推进的注水章。
3. **三层互不越界**：L1 不进 `style_profiles`（全局硬约束不属于某作品风格，避免风格学习学走系统规则）；L2 只由风格学习（§9）维护，不进系统模板；L3 由代码派生，不由模型学习。
4. **评价师用三层核对**：L1/L2 合规 → `style_compliance` 维度（"检验标准：读者会觉得这作者挺有意思吗？语言自然流畅吗？有故事感而不是散文感吗？"）；L3 合规 → `pacing` 维度对照 `chapter_function`。

---

## 6. 共享记忆层

五类记忆，全部持久化，供所有角色读写：

| 记忆 | 存储 | 写入方 | 读取方 |
|---|---|---|---|
| 设定库 | settings + embedding | 设定抽取（概念转正）、作者手动、蓝图师（规则） | 所有角色的 build_context |
| 故事状态 | story_state | 提取师 | 大纲师、小说家 |
| 伏笔账本 | plot_ledger | 大纲师、提取师 | 大纲师、小说家、评价师 |
| 风格画像 | style_profiles | 风格学习服务（§9） | 小说家、评价师（L2） |
| 质量账本 | quality_reviews | 评价师 | 小说家（修订）、评价师（趋势） |

> 风格画像只承载 **L2 作品风格**（§5.7）；**L1 通用防 AI 硬约束**由系统级 prompt 模板维护，不进 style_profiles；**L3 章节节奏指令**由代码按 chapter_function 运行时派生，不进任何记忆表。

**一致性闭环**：小说家成稿 → 提取师更新 story_state/ledger → 大纲师据此排下一章 → 评价师对照 ledger 验收。任何一环缺失，另一环的上下文里都能暴露（如 ledger 积压告警、evidence 查不到条目）。

---

## 7. 上下文装配与 Token 预算

以 32k 上下文为例（单章中文约 3000–7000 字）：

| 组件 | 预算 | 说明 |
|---|---|---|
| 系统提示 + 输出约束 | ~2.5k | 固定段：角色指令 + 输出 schema + **L1 通用防 AI 硬约束**（§5.7） |
| 三层写作指令（L2+L3） | ~1.5k | L2 风格画像 + L3 本章节奏/心态指令（由 chapter_function 派生） |
| 本章大纲（beats/goal/plant/resolve） | ~2k | |
| 相关设定（RAG top-10 过滤到本章实体） | ~4k | 精确匹配 + embedding 双路召回 |
| 前文压缩记忆（最近 3 条 story_state） | ~3k | 不用全文堆历史 |
| 最近 1–2 章全文 | ~8k | 保文风连续性 |
| 风格画像（traits + avoid_list + 示例片段） | ~1k | |
| active 蓝图相关片段 | ~1k | theme/core_conflict/本卷 focus |
| **生成余量** | **~10k** | 约 7000 中文字，足够一章 |

**RAG 流程**：
1. 取大纲中 `characters/locations/entities` 清单 → 设定库**精确匹配**；
2. 对"规则/概念"类做 embedding 相似度召回（补充遗漏）；
3. 合并去重、按 type 排序，超过预算截断并在上下文中标注"以下设定被截断"；
4. 冲突校验结果附在上下文尾部（"注意：规则 X 与大纲冲突，请规避/化解"）。

> **换模型不断片（关键认知）**：连续性是**记忆层**（数据库）保证的，不是模型上下文。每次 `build_context` 都从 story_state/plot_ledger/settings/style_profiles 重新装配，换模型 = 换一个"读记忆的人"，记忆没丢。换模型唯一要适配的是**上下文窗口大小**：
>
> 1. `model_routes` 每行带 `context_window`，token 预算器按目标模型窗口动态装配；
> 2. 超窗口时按**裁剪优先级**截断（先剪旧的）：最近全文（2章→1章）→ RAG 设定（减 top-k）→ 旧 story_state（保留最近 3 条）→ 蓝图片段；**必保**：本章大纲 + 三层写作指令（L1/L2/L3）+ 最近 1 条 story_state；
> 3. 被截断的组件在上下文末尾标注"以下设定/记忆被截断"，让模型知道自己信息不完整；
> 4. 32k 窗口即可正常跑；128k 给更多上下文但**不是质量线性提升**——"给得对"比"给得多"重要（记忆层保证给得对）。

> 模型上下文 >32k 时按比例扩容；`max_tokens` 与 `context_window` 由 `model_routes` 控制。

---

## 8. 章节生成（单版本定稿）

1. 小说家按 §5.4 装配上下文，**单次** LLM 调用流式生成正文（打字机渲染）。
2. 完成后落 `chapter_versions(source='novelist')` 并标 `is_active`，即 `chapters.content` 正式版；旧版本保留可回看/回滚。
3. 用户可直接在编辑器修改正文，落 `user_edit` 版本（作为风格学习输入，§9）。
4. 评价师对定稿评分（对照蓝图/账本），`issues` 触发"定向修订"（小说家带 issue 清单重写特定段落）。

---

## 9. 风格学习（让 AI 逐步贴合笔触）

**数据来源**：用户对 AI 成稿的手动编辑 diff（`novelist` vs `user_edit` 版本）。

**流程**：
1. 用户提交修改 → 生成"原文 vs 改文"结构化 diff（句子级）；
2. 提取师风格子任务从 diff 中提炼偏好：句式长短、词汇选择、视角习惯、对话 vs 描写比例、禁忌写法（进 `avoid_list`）；
3. 生成 `style_profiles` 新版本（记录 `source_diff_ids`），供小说家/评价师下次使用；
4. 用户连续拒绝某类写法（如超过 3 次"环境描写过多"）→ 自动进入 `avoid_list`。

**验收**：同一提示词下，风格画像 v3 生成章节的句长分布/用词习惯应明显更接近用户手改样本。

**作用域边界（对应 §5.7）**：风格学习**只产出 L2 作品层**画像——句长/词汇/对话比/禁忌写法。diff 中体现的"通用防 AI 规则"（如去掉总结句、少修饰词）**不写入 style_profiles**，属于系统级 L1，由模板统一维护；章节级节奏由代码按 `chapter_function` 派生，不由模型学习。

---

## 10. 流式与后台任务

- **SSE**：`/api/stream/agents/{agent}/run` 下发事件流：`context_ready → stream_delta → stream_end → schema_validate → stored`。
- 前端对小说家这类长文本渲染为"打字机"效果；评价师可整段返回。
- **后台任务**：提取师、章节定稿落库、风格学习均为 `BackgroundTasks` 或 asyncio 队列，不阻塞前端。
- 失败重试策略：LLM 超时/限流 → 指数退避 1 次；schema 校验失败 → 自纠错 1 次；仍失败 → 写入 review 告警 + 返回给前端"可重试"。

---

## 11. API 设计（REST）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/novels | 建项目 |
| GET | /api/novels/:id | 项目详情 |
| CRUD | /api/novels/:id/settings | 设定条目（GET 支持 `?type=&q=` 语义检索） |
| POST | /api/novels/:id/settings/conflicts | 设定冲突预检 |
| POST | /api/novels/:id/blueprints/generate | 生成蓝图（流式）→ draft |
| GET | /api/novels/:id/blueprints | 版本列表 |
| POST | /api/novels/:id/blueprints/:bpId/activate | 激活版本 |
| POST | /api/novels/:id/outlines/generate | 生成下一章大纲（流式，读账本） |
| POST | /api/novels/:id/outlines/:id/approve | 大纲生效（落 ledger） |
| POST | /api/novels/:id/chapters/generate | 章节生成（流式） |
| GET | /api/novels/:id/chapters/:cid/versions | 版本列表 + 内容 |
| POST | /api/novels/:id/chapters/:cid/versions/:vid/select | 选定为正式版（版本回滚） |
| POST | /api/novels/:id/chapters/:cid/review | 评价师（对照蓝图/账本） |
| POST | /api/novels/:id/chapters/:cid/extract | 提取师 → story_state/ledger |
| POST | /api/novels/:id/chapters/:cid/revise | 按评价师 issues 定向修订 |
| POST | /api/novels/:id/chapters/:cid/detect | AI 生成检测（可选体检，不阻断） |
| GET | /api/novels/:id/ledger?status=open | 伏笔账本 |
| GET | /api/novels/:id/story-state | 故事状态快照列表 |
| POST | /api/novels/:id/style/learn | 从编辑 diff 学习风格 |
| GET | /api/novels/:id/style | 风格画像版本 |
| POST | /api/models/probe | 探测 provider 下可用模型（填 model_routes 辅助） |
| SSE | /api/stream/agents/{agent}/run | 通用流式生成入口 |

---

## 12. 前端页面

| 路由 | 页面 | 关键交互 |
|---|---|---|
| / | 项目列表 | 新建/进入项目 |
| /novels/[id]/settings | 设定管理 | 卡片视图、类型筛选、全文/语义搜索、冲突提示 |
| /novels/[id]/blueprint | 蓝图 | 分卷结构可视化、版本切换 |
| /novels/[id]/outline | 大纲 + 账本 | 章节列表、伏笔账本（open/closed 泳道） |
| /novels/[id]/write | **写作页（核心）** | 三栏：左侧相关设定/记忆摘要 · 中间 TipTap 编辑器 · 右侧伏笔待回收与评价 |

---

## 13. 模型与多模型策略

### 13.1 一个关键认知：一致性靠账本，审美靠模型

"同一个模型写、同一个模型评，会不会查不出自己的问题"——部分成立，但要把错误分两类：

- **事实/一致性错误**（前后矛盾、伏笔未兑现、角色状态错、设定冲突）：本质是**可客观核对**的问题，靠的是**核对依据**（蓝图、伏笔账本、故事状态、设定库 + 强制原文引用 evidence），而不是"更聪明的模型"。账本是确定性数据，模型输出是随机性的。
- **审美/文笔问题**（节奏、声线、张力）：主观，依赖模型能力与提示词。

> 结论：**先用"同模型 + 强核对标准"就能解决大部分问题**；换模型主要解决评价师的"确认偏差"（用自己的思路写，容易用自己的盲点评）。

### 13.2 评价师的确认偏差与对策（分三级，成本递增、收益递减）

- **L1（MVP 基线）：同模型双态**。写手态与评审态分离：
  - 评审态**冷启动**：不给生成时的上下文，只给"章节 + 账本/蓝图/设定 + 大纲"，重新看待文本，避免"写完顺手评"的惯性；
  - 强制 `evidence` 非空（引用原文或账本条目），为空视为无效输出重跑；
  - 评审温度调低（更保守）、角色切换为"严苛编辑"。
- **L2（推荐，成本收益最优）：评审单独换更强/不同供应商模型**。评价输出仅几百 token，用强模型成本占比极小，但"批判性推理"是真正的瓶颈——这就是"用不同 AI 查问题"的落地点；写手继续用性价比创作模型。
- **L3（可选，高质量场景）：多模型交叉评审**。模型 X、Y 各评一次，取问题并集；两模型结论冲突的项，回账本/设定人工裁决。

> 不要所有角色都上最强模型。创作要"文笔好"，评审要"逻辑严苛"，能力需求不同，按 §13.3 混搭。

### 13.3 按任务混搭（model_routes）

| task_type | 角色 | 模型取向 | 理由 |
|---|---|---|---|
| setting | 概念抽取 / 冲突预检 | 性价比（DeepSeek-V3 等） | 短输出、结构化为主 |
| extract | 提取师 | 性价比 | 结构化压缩，核对依据充分 |
| review | 评价师 | **优先升级为更强/不同供应商**（Claude 或 Qwen-max） | 批判性推理是瓶颈，输出短、成本占比极小 |
| creation | 小说家 | 强文笔创作模型 | 生成是主成本，花在刀刃上 |

- LiteLLM 单入口，`model_routes` 改配置即可切 provider，**代码零改动**。
- **模型可用性 = 声明式配置**：可用模型列表即 `model_routes` 中已配置的行，前端下拉直接读此表（用户自带 API Key）。不做自动发现——模型是否可用取决于用户账号权限，系统无法替你判断。
- **探测辅助接口**：`POST /api/models/probe`，入参 provider+api_key，调该 provider 的 OpenAI 兼容 `/v1/models` 拉取账号下真实可用模型，帮助用户快速填充 `model_routes`（避免手敲模型名出错）。M1 起提供。

### 13.4 成本护栏

- 记录每次调用 token 用量；embedding 结果按 (novel, type, name) 缓存；超长自动截断 + 告警。
- 章节生成单版本（`version_count` 默认 1，字段保留便于未来扩展）。
- 本地部署可选 Ollama（`model_routes` 指向本地 endpoint）。

### 13.5 AI 生成检测（可选，体检性质）

**定位**：不是主线角色之一，是**可选触发的参考体检**。防 AI 味的根本在 §5.7 三层写作指令 + 风格画像，检测器只是事后验证、给作者参考。**不设硬阈值、不阻断写作**，任何后端失败都不影响主流程。

**"左手查右手"是否成立？——拆开看**：
- 检测器判据不是"认出谁生成的"，而是**统计分布**：LLM 采样倾向落在高概率区（PPL 低、句间波动小），人写的有更多意外选择。所以一个通用小模型即可当"打分器"，**不需要独立的警察模型**。
- 用同一模型"生成→检测"且为原始采样时，**反而最容易查出来**（自己最容易被自己抓住），不是无用功；
- 查不出来的情况 = 文本已**偏离原始采样分布**（去 AI 化指令、高温/随机、人工润色），逼近人类分布——这时任何检测器都难查，对写作工具这是**目标**而非失败；
- 真正要防的"无用功"：把概率参考当"绝对裁判"、围绕分数洗稿（会把作品改得四不像）。故检测结果只作参考展示，不进 `quality_reviews`（评价师是蓝图/账本/风格维度）。

**实现（自写为主，adapter 化，`detector_config` 切换）**：

| 后端 | 实现 | 成本 | 优先级 |
|---|---|---|---|
| `local_heuristic`（默认） | 本地小模型算 PPL + burstiness（GPTZero v1 同思路） | 离线零成本 | **M4（后期，早期不做）** |
| `local_model`（可选升级） | 离线推理开源检测模型：中文 `Hello-SimpleAI/chatgpt-detector-roberta-chinese`；或 **Binoculars 双模型（observer+reference）**——两个不同小模型组合，缓解单一分布自洽 | 离线，依赖本地小模型推理 | 参考性要求高时启用 |
| `zhuque_api`（不优先） | 腾讯朱雀 `zhuque-text`，需企业版腾讯云 + EIU 计费，接入繁琐 | 企业版 + 计费 | 弃用，有企业账号再议 |

**方法论升级（M4，借鉴 NeuroBook llmlint 的"先定位、后判断"闭环）**——不把检测做成黑箱打分，而是做成可证伪、能量化的体检：

1. **三层信号**：`regex` 词法规则（中文黑话/句式模板，如"首先…其次…最后"）→ `density` 统计指纹（比喻/连接词密度，按可见字数归一，过门槛才命中）→ `local_heuristic` 神经分布（PPL + burstiness 热力图，分 chunk 输出）。
2. **四象限交叉**：规则密集 × 文内高位 = 确认疑难；规则静默 × 高位 = 漏网新规则候选；规则密集 × 低位 = 需要人工裁决（低位不等于像人写）；静默 × 低位 = 不打扰。整篇层唯一绝对阈值（如 P(AI)≥0.85 才说"整体可疑"）。
3. **人类判定是终审，机器永不当真值**：规则命中与热区只是候选证据，是否修改由作者结合语境决定（承担剧情/人物声音/题材功能的写法照写不误）。
4. **修复纪律（防自欺）**：改动按"删 → 压 → 换"；篇幅预算删减不超过两成；复测三判据同时成立——命中减少 + 未引入新命中 + 篇幅在原文 ±20% 内；**检测分数只作参考不作目标**（防"靠删薄清零指标"）。
5. **评测闭环**：作者"留/改/问"判定回流做真值，反哺规则精度；外部检测器永不当真值。

**输出**：整篇 AI 浓度 + 分段标记（疑似 AI 段落高亮），只展示给作者。

**接入点**：写作页"体检"按钮（主动触发）；不自动跑、不拦截保存。

> 提醒：检测器对"深度人工润色、风格已高度个性化"的内容误报率高。若分数偏高，正确动作是回到 L2 风格画像与 L3 节奏指令调优，而非围绕检测器阈值"洗稿"。

---

## 14. "防挂羊头"验收清单（实现时逐条验证）

- [ ] 各角色产出均有 schema 校验，失败自纠错/告警，不存在"纯文本拉倒"。
- [ ] 小说家 `build_context` 一定包含：相关设定检索结果 + 伏笔账本 open 项 + 风格画像；代码上缺失任一即报错。
- [ ] 大纲师生成下一章前强制读账本；连续 3 章无回收触发积压告警。
- [ ] 提取师每章必跑，`story_state`/`plot_ledger` 与章节一一对应（幂等）。
- [ ] 评价师 `evidence` 字段非空校验；空则视为无效输出重跑。
- [ ] 风格画像随用户编辑迭代，且可验证下一章生成结果有可观测差异。；切模型后ovider 改`model_routes` 配置，不加代码。。
- [ ] AI 生成检测为可选体检：不设硬阈值、不阻断写作，后端失败不影响主流程
- [ ] 换新章节测试：从第 20 章继续续写，角色状态/已回收伏笔与账本一致（长文一致性冒烟测试）。

---

## 15. 风险与对策

| 风险 | 对策 |
|---|---|
| 长篇记忆衰减（写到 50 章后忘了 10 章前） | 提取师结构化记忆 + 定期"记忆审查"（对旧 story_state 二次摘要），账本兜底 |
| 模型幻觉设定（编造不存在的角色/规则） | build_context 注入设定一致性硬指令；评价师 consistency 维度 + evidence 校验 |
| 风格漂移 | 风格画像版本化 + 用户编辑修正行为进入 avoid_list |
| 结构化输出不稳定（部分模型 JSON 质量差） | 自纠错重试 1 次；仍失败降级为"宽松解析 + 人工确认"路径 |
| 提示词注入（用户把设定写成"忽略以上指令"） | 用户内容与系统指令分层，正文内容只进 content 字段不做指令拼接 |

---

## 16. 里程碑

1. **M0 骨架**：前后端脚手架、DB 迁移、LiteLLM 网关、SSE 通道、薄自研 Pipeline 核心（Agent 统一接口）。
2. **M1 MVP**：设定库 + 小说家（单版本生成）+ 提取师 + 长文一致性冒烟测试；**章节信息控制字段**（`info_control` 入大纲 schema 与小说家 L3 指令，§5.3/§5.4）。
3. **M2**：大纲师 + 伏笔账本 + 评价师（L1 同模型双态冷启动）+ 定向修订；**记忆层时间语义升级**——`story_state`/`plot_ledger` 加 `since_chapter`/`invalidated_at_chapter`（as-of 查询，§4.1）；**settings 别名与分身合并**（aliases/merged_into_id，§4.1）。
4. **M3**：蓝图师 + 设定抽取 + 风格学习；评价师升级 L2（单独换更强模型）；**风格画像版本链 as-of**（检索时只给当时版本，§6）。
5. **M4**：实体图谱、记忆审查、Ollama 支持、部署；**AI 检测方法论升级**——llmlint 式三层信号（regex/density/neural）+ 四象限交叉 + 人类终审 + 修复三判据（§13.5）。

---

## 17. 参考借鉴（Arboris-novel）

> 分析开源项目 [arboris-novel](https://github.com/t59688/arboris-novel)（FastAPI + Vue3 + SQLite/MySQL + libsql 向量库）后吸收的经验。该项目与笔灵同属"写作伙伴"方向，其六类 AI 能力与我们的角色一一对应，且印证了"自研 Pipeline（无 agent 框架，服务类编排 LLM 调用）"这一方向的可行性。

### 17.1 吸收进本设计

| # | 借鉴点 | 落点 |
|---|---|---|
| 1 | **信息可见性过滤（POV 裁剪）**：只给写手"已登场/本章计划登场"角色的设定，未登场角色连名字都不出现；剔除 full_synopsis 等剧透字段 | §5.4 小说家 build_context |
| 2 | **小说宪法（Constitution）**：不可变的世界观规则/约束/禁忌单独成"宪法"，作为评价师一致性检查的硬依据 | 设定库 `world_rule` 类型中标记 `is_constitution=true` 的条目；评价师 rubric 依据 |
| 3 | **伏笔健康度**：伏笔带 urgency、target_reveal_chapter，自动检测"埋下超期未回收"并给出健康度评分/建议 | §4.1 `plot_ledger` 已加 urgency/target_reveal_chapter；账本查询增加 overdue 视图 |
| 4 | **RAG 五层信息架构与切分参数**：L1 蓝图(JSON, 不检索) / L2 正文分块(向量) / L3 章节摘要(向量) / L4 上一章摘要+结尾500字 / L5 当前章目标；chunk≈480、overlap≈120、Top-K 正文5+摘要3 | §7 token 预算细化参数 |
| 5 | **自我批评-修订循环**：生成后同模型以评审态自检→修订→重评，最多2轮、目标分75 | §13.2 L1 双态冷启动的落地形态 |
| 6 | **提示词模板存库可配置**：prompt 存 DB，管理员/作者可后台编辑调优 | 增加 `prompts` 表 + 提示词管理接口（M4） |
| 7 | **节奏/情绪曲线指导**：按章节号/总章节数/弧线类型给出每章目标情绪强度，防止节奏失控 | M3+ 可选，情绪曲线服务 |

### 17.2 保持优于 Arboris 的设计（不复刻其短板）

| 我们的设计 | Arboris 的做法 |
|---|---|
| 统一 **Agent 接口**（build_context/run/parse_output），编排薄而集中 | 每条路由手写编排，LLM 调用散落各 service |
| **Pydantic schema 校验 + 自纠错重试** | sanitize + json.loads，解析失败直接 500 |
| **概念卡片**（pending→confirmed→integrated 中间资产） | 对话只存表，蓝图一次性从对话生成，无中间资产 |
| **蓝图版本化 + activate** | 蓝图单行可 PATCH 修改，不版本化 |
| **风格画像从用户编辑 diff 自动学习** | 风格靠手写 persona |
| **按 task 路由多模型 + 评价师升级 L2** | 单模型配置为主，无按任务混搭 |
| **SSE 流式** | 整段返回，无流式 |

---

## 18. 参考借鉴（NeuroBook）——差距与补强路线

> 分析开源项目 [neuro-book](https://github.com/neuro-book)（本地优先 AI 小说创作 IDE，Nuxt/Nitro/Prisma/Bun 的 monorepo）后，确认**我们的架构方向不变**（Web 产品、薄自研 Pipeline、记忆层保证换模型不断片），同时吸收其经实战验证的设计，补齐我们的短板。借鉴点已分别落到 §4.1 / §5.3 / §5.4 / §6 / §13.5 / §16，本节是汇总与对照。

### 18.1 NeuroBook 的定位（对比基准）

- 用软件工程方法论写长篇：世界状态由**事件溯源引擎推算**（`WorldPatch` 四 op 重放，任意时刻状态可审计），伏笔像技术债记账，360 条规则做 AI 味 lint。
- 与笔灵同方向但哲学不同：它把"设定漂移"当作**数据工程问题**解决，我们把连续性交给**记忆层 + 信息隔离**解决。
- 其产品主线仍在收敛（0.10 canary，真实 Provider 与作者实测未验收），工程质量强、产品完整度反而落后于我们。

### 18.2 我们保持的优势（不复刻其复杂度）

| 我们的设计 | NeuroBook 的做法 |
|---|---|
| 轻量两目录（FastAPI + Next.js），一人可维护 | 12+ workspace monorepo、.agents 治理、specs/standards 文档负担重 |
| 角色流水线 + 三层写作指令（L1/L2/L3），产品闭环清晰 | 多 Agent 工作室 + Profile 即代码，工程完备但产品主线未收敛 |
| 换模型连续性与模型可用性声明式配置 | 深度绑定 pi-agent-core 第三方框架 |
| Pydantic 结构化输出 + 自纠错重试 | harness 的 parse-once/validate-reuse 更严谨（M2+ 可吸收其"外部边界只 parse 一次，恢复路径只 validate"思想） |

### 18.3 需要补强的差距（已按优先级映射进里程碑）

| # | 差距 | NeuroBook 的做法 | 我们的落点 |
|---|---|---|---|
| 1 | **记忆无时间语义**：story_state 每章覆盖式快照，无法回答"第 N 章时世界什么样、那时还不知道什么"，是时间泄漏/前后矛盾的根源 | 双时间轴（tick/instant）+ 失效区间 + as-of 查询 + fail-closed | **M2**：§4.1 story_state/plot_ledger 加 since_chapter/invalidated_at_chapter |
| 2 | **主体分身无兜底**：settings 无别名/合并，"同一角色两条设定"靠人肉发现 | SubjectRegistry 别名带生效时点 + 引擎不变量自动 merge（"一个名字不能既是 A 主名又是 B 别名"） | **M2**：§4.1 settings 加 aliases/merged_into_id |
| 3 | **悬念管理未显式化**：读者/主角知道什么、必须隐瞒什么没有落到数据层 | StoryChapter.briefReaderKnows/briefProtagonistKnows/briefMustHide/briefHintOnly | **M1**：§5.3/§5.4 info_control 字段 + L3 指令 |
| 4 | **AI 检测是黑箱打分** | llmlint 方法论：三层信号（regex/density/neural）+ 四象限交叉 + **人类判定终审** + 修复三判据 + 评测回流 | **M4**：§13.5 方法论升级 |
| 5 | **风格画像只取最新版**，历史版本无法 as-of 检索 | ontology 版本链 + as-of 裁剪（检索时只给当时版本） | **M3**：§6 版本链查询 |
| 6 | **上下文裁剪未实现**（token 预算器是设计稿） | harness compaction：token 触发 + 摘要前缀 + keepRecentTokens | **M1+**：§7 token 预算器按 model_routes.context_window 动态装配 |

### 18.4 明确不吸收的（避免过度工程）

- monorepo 治理 / 事件溯源世界引擎全量重放 / nb-workflow journal 重放 —— 对单作者写作场景收益低于成本；
- Electron + Tauri 双桌面壳 —— 浏览器优先，桌面化走 Tauri 单线（M4+ 可选）；
- 透明的 token 计费模型 —— 产品验证期不做。
