# Biling 项目长期备忘

## 设计系统（frontend/src/app/globals.css）
- 主题「书房」：宣纸米白 + 墨色 + 传统色点缀（朱砂/靛青/竹青/赭石）。
- **zinc 色阶已被整体重映射**为墨—纸暖色阶，green/red/blue/amber 映射为竹青/朱砂/靛青/赭石。
  老面板无需改动即自动换肤；新写组件可继续用 Tailwind 原生写法。
- 深浅色都走 CSS 变量（`:root` + `prefers-color-scheme`），`@theme inline` 注册进 Tailwind。
- 深色模式有一层**受控的 zinc 工具类翻转**（text-zinc-900/700/600、bg-zinc-100、border-zinc-300），
  取值与老面板的 `dark:*` 一致，因此对老面板无副作用。
- 例外：`bg-zinc-900` **不会**翻转（它是主按钮底色）。主按钮请用 `.btn-primary`，
  次按钮用 `.btn-ghost`，两者内部用 `--btn-bg/--btn-fg` 自适应深浅色。
- 新增语义按钮类（2026-09-27）：正向确认/批准用 `.btn-approve`（竹青 `--jade` 底），
  破坏性动作（删除）用 `.btn-danger`（朱砂描边）。散落的 `bg-green-700`/`border-red-200` 原始类统一收敛到这两类。
- **图谱面板配色**：节点/箭头/图例不再硬编码 hex，改用 `:root` 里的 `--g-character/--g-location/--g-faction/--g-world_rule/--g-item/--g-concept/--g-other/--g-protagonist` 基础色，
  在 graph-panel 里用 `color-mix(in oklab, 基础色 22%, var(--paper))` 算填充、`...82%, var(--ink-strong)` 算文字，一套值自动适配深浅色。改图谱配色只动这 8 个变量，别再写死 hex。
- 语义变量：`--ink-strong`（标题主色）、`--ink-body`、`--prose`（阅读正文）、`--rule`（发丝边框）。
- 版心：`.shell`（1320px）与 `.shell-wide`（1560px，工作台用），两者都自带 clamp 内边距。
- 阅读正文加 `.reading`（宋体 + 行距 1.95），竖排用 `.vertical`，入场动画 `.rise` / `.ink-in`。
- **功能区块一律用 `.panel` 卡片系统**（2026-09-17 去拥挤化重构引入）：一个功能 = 一张有边界的卡，
  配 `.panel-head`（标题+说明）/ `.panel-title` / `.panel-step`（①②③ 序号徽标）/ `.panel-hint`。
  禁止再把多个无关功能堆在同一个 `<section>` 里只用 gap 分隔。
  嵌套卡片内部不要再描边，改用 `bg-sunken/40` 之类的底色区分。
- 侧栏/卡片里的操作按钮**一律 `w-full` 等宽**；解释用的 `<InfoTip>` 不要放在按钮外（会把按钮挤窄），
  要放进按钮内：按钮加 `relative`，InfoTip 包一层 `absolute right-2 top-1/2 -translate-y-1/2`
  的 span，并 `onClick={e => e.stopPropagation()}` 防止点问号误触发按钮动作。

## 后端契约
- 小说简介字段是 **`premise`**，不是 `description`（前端曾用错导致简介永远存不上，已修复）。
- `GET /api/novels` 无删除接口；后端跑在 127.0.0.1:8000，前端经 next.config.ts 的 rewrite 代理 `/api/*`。
- **关 uvicorn 要杀子进程**：Stop-Process 杀父进程后端口仍被子 python 占着，必须杀实际持端口的那个 PID。
- **评价与正文版本必须对齐**：`quality_reviews` 挂在 `chapter_versions` 上，`ReviewRead` 带
  `version_no / version_source / is_current`；只有 `is_current` 的评价才能触发「按评价优化」，
  否则会拿旧版本的毛病去改新正文。切版本 / 切章都要重拉 reviews（归属会变）。
- **评价面板只展示当前正文版本的最新一条评价**（`is_current` 过滤后取第一条，接口已按 created_at 倒序）；
  历史版本的评价一律不展示，只在 panel-hint 里标「另有 N 条旧版本评价已折叠」。
  当前版本还没评价时，面板显示一行虚线空状态引导去点「评价本章」（面板常驻，不再消失）。

## 设定漏检防护（services/setting_checker.py）
- 评价师原本**只看得见蓝图，看不见设定库**，且只有整体印象打分 → 设定被漏写也评不出来。
  已修：critic 现在也会拿到设定库（同 novelist 的 `filter_settings_for_chapter`）。
- `services/setting_checker.py` 做确定性核对：**共现约束**——一组必现项（如
  天赋清单+兴趣爱好+适配推荐）只要出现任意一个，其余缺失即为漏写；全不出现则不算。
- 降噪四件套：只认 `+/＋//／`；术语边界修正（靠语料频次砍掉误吞前缀）；组内术语语料 ≥2 次；
  **必现锚点**（组前需有 固定内容/必须/包含/包括/组成/要素/字段/必备），否则按"备选枚举"丢弃。
- 蓝图 `content.setting_checks` 可写死显式清单（优先级最高、完全免抽取）。
- 结果注入 critic prompt，要求逐条"写进 issues 或说明不适"，不允许沉默。

## 设定「写不出来」防护（写前清单 + 写后自检）
- **上下文曾静默丢数据**：`context.format_blueprint_for_prompt` 只取 world_rule 的 `name+detail`，
  `constraints`（本例 14 条硬规则）**整个没进任何 Agent**，已修：现以「。硬性约束：…」拼接带上。
- 即使规则在上下文里也会被**淹没**：那条要求藏在 288 字的 detail 长句中、位于蓝图全文 81% 处，
  中间位置 + 长段落 = 模型注意不到。→ `setting_checker.extract_checklist` + `format_required_list`
  把它抽成独立条款，**放在 user_content 最末尾**（末位注意力最高），novelist 与 reviser 都注入。
- `pipeline._check_setting_gaps` 做**写后自检**：novelist/reviser 输出后跑同一套核对，
  命中则 emit SSE `setting_warning` 事件，前端在「①写新的一章」卡底部渲染琥珀色告警条。
- 教训：这类"成组必须同时出现"的规则属于确定性约束，**不要指望 LLM 通读后自觉遵循**，
  必须显式抽出 + 事后字面核对两道保险。

## AI 拟人 / 反检测（提示词三层结构）
- L1 `agents/l1.py` 的 `L1_ANTI_AI_CONSTRAINTS` 是全局约束，novelist 与 reviser 共用；
  内含【反「AI 味」量化自检】硬指标：极短句 ≥15%、连接词密度 ≤3.5/千字、禁止排比与总分总、
  允许口语瑕疵、禁止每段升华、结尾落在具象画面。
- L3 会把**上一章实测指标**（`services.detector.detect()` 的 burstiness / short_ratio /
  transition_density）喂回模型，防止跨章节奏趋同——续写越写越"AI"的主因。
- `novelist.temperature = 0.82`（原 0.75）。想更稳更规整就调回 0.75。
- 本地 `services/detector.py` 只是启发式信号（`朱雀`才是外部真值），用来做相对趋势监控，别当绝对判定。

## 本地开发 / 验证
- **Next dev 有源站保护：只信任 `localhost`。** 用 `127.0.0.1:3000` 访问时 HMR 握手 404、
  React 不水合（页面能看但点不动）——测试一律用 `http://localhost:3000`。生产构建无此限制。
- 前端视觉回归：`scripts/shot.mjs`（走 CDP 的截图脚本，用法见文件头注释）。
  headless 的 `--screenshot` 等不到客户端 fetch，也等不到入场动画，别用。
- 临时验证：`next build` 后 `next start -p 3100`（完事记得停掉）。
- **真实数据库是 `backend/biling.db`**（`database_url = sqlite:///./biling.db`，相对 CWD）——
  仓库根的 `biling.db` 是空壳（0 表），别被误导。后端 uvicorn 跑在 `127.0.0.1:8000`。
  截图前先确认 3000/8000 都在线（用户常年开着这两个服务）。
- **工作台 tab 深链走 query `?tab=`**：`blueprint`(默认，会删 tab 参数) / `write` / `outline` /
  `settings` / `ledger` / `style` / `detect` / `graph` / `models` / `tools`。
- 截图等待正文渲染用 waitExpr：`!!document.querySelector('.reading') && (…textContent||'').length>200`。
  `PROBE` 环境变量可注入 JS（支持 `awaitPromise`）——可用来「点击某按钮后再截图」或测量元素宽度自证布局。
- 写工作台的布局要点（2026-09-27 定稿）：
  - 内容画布：`write`/`outline` tab 用 `max-w-[1728px]`，其余 `max-w-[1280px]`（页面 `main` 里按 tab 切换）——
    1080p(1920) 下 1280 会在两侧各空 226px，正文被挤窄，故放宽。
  - 写页三列：nav 侧栏(188) + 章节目录列(340) + [正文 flex-1 + 分隔条 + 评价栏]；并排断点是 **xl 不是 lg**
    （因为 nav 侧栏从 lg 起就出现，lg 宽度不够并排）。
  - **评价栏宽度是「可调」的**（`writing-panel.tsx`，2026-09-27 二次迭代）：
    `reviewWidth` 状态 + `--review-w` CSS 变量驱动 `xl:w-[var(--review-w)]`；
    三档预设 `REVIEW_W_PRESETS`（窄 420 / 中 620 / 宽 860，默认 620）、
    正文与评价之间的**分隔条可拖拽**（`startReviewResize`，clamp 340–1000，双击复位，聚焦后 ←/→ 微调）；
    偏好存 localStorage `biling.reviewWidth`。评价栏另有 `reviewCollapsed` 折叠成 w-12 竖条。
  - **章节目录也可折叠**（`dirCollapsed`）：折叠后网格变 `lg:grid-cols-[48px_minmax(0,1fr)]`
    ——注意必须保留**两列**，早期误写成单列会把正文/评价挤到第二行、直接掉出视口。
  - 1920(1080p) 实测（`?tab=write`，正文可读区 `.reading` 宽 / 评价栏宽）：
    目录展开+中档 → 566 / 620；**目录折叠+中档 → 858 / 620**；目录折叠+宽档 → 618 / 860（此处评价栏容器 ≥672px，维度卡自动转 2 列）。
    结论：1080p 下「目录 340 + 正文 + 评价」三者互斥，想两头都宽就折叠目录或折叠评价栏。
  - 评价栏内容用**容器查询**（`.@container` + `@2xl:grid-cols-2`）：栏 <672px 时六维评分卡单列（好读），
    ≥672px 才并两列——别再写 `md:grid-cols-2`（跟视口走，300px 的窄栏里也会硬并两列 → 挤成一团）。
  - nav 侧栏断点 `lg:flex`，中窄屏横滑标签条 `lg:hidden`。
  - 表单类弹窗（新增章节、信息控制）里，**新增章节已改右侧滑入抽屉**（`fixed right-0` 的 `aside`，不遮正文），
    其余表单仍可用居中 `Modal`（属合理范式）。
