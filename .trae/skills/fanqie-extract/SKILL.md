---
name: fanqie-extract
description: 提取番茄小说前十章并统一归纳进题材族规则库，流程、落位、格式完全固定。当用户要求提取番茄中的某本小说、做题材族校准、或新增题材族样本时使用。不用于非番茄内容抓取或普通网页爬取。
---

# 番茄小说提取与题材族校准

把用户的一句话「提取番茄中的《XXX》」转化为**固定、可重复**的处理流程。每一次都严格按本 skill 执行：同一套工具、同一个落位、同一种格式、同一套规则分级。不允许这次和上次做法不一样。

> 涉及的工具与规则事实源（先读再动手）：
> - 工具说明：`tools/fanqie_crawler/README.md`
> - 规则库：`tools/fanqie_crawler/rules/fanqie_rules.md`
> - 规则同步目标：`backend/app/agents/platform_rules.py`（GENRE_FAMILY_REGISTRY）

> **流程变更处理**：本 skill 是静态说明，不会自动跟着业务变化。若流程改变（例如改为从番茄榜单选书、抓取章数变化、规则格式调整、新题材族口径变更），先按变化**更新本 skill** 再按新流程执行。用户说「更新提取流程」时，以用户描述为准；用户做提取时若发现当前要求与本 skill 不一致，先对齐再动手。

## 固定落位（不许变）

| 内容 | 路径 |
|---|---|
| 抓取原始章节 | `tools/fanqie_crawler/corpus/<书名>/raw_ch{n}.txt` |
| 解码后章节 | `tools/fanqie_crawler/corpus/<书名>/dec_ch{n}.txt` |
| 逐本观察记录 | `tools/fanqie_crawler/rules/fanqie_rules.md` →「逐本观察记录」节，追加 `### 《书名》（<题材族>样本）` |
| 题材族约束 | `tools/fanqie_crawler/rules/fanqie_rules.md` →「已校准题材族」节，更新对应族的【必写】【可选】 |
| 运行时规则同步 | `backend/app/agents/platform_rules.py` → `GENRE_FAMILY_REGISTRY` 与各 `GENRE_STORYTELLING_*` / `GENRE_RHYTHM_*` 常量 |

`corpus/` 是**本地临时产物，用完即删，绝不入库**（`.gitignore` 已忽略）。

## 固定流程（七步，按序执行）

1. **定位小说**：先确认本次来源——
   - (a) **用户指定书名**（默认）：用浏览器（browseruse）登录番茄，进入目标书任意章节页，确认书名、作者、bookId 与免费章节范围；
   - (b) **从榜单选书**：进入番茄榜单页（巅峰榜/新书榜/阅读榜等）抓取目标书目与 bookId 再进入该书。若榜单抓取的具体步骤与既有工具/本 skill 不一致，先按「流程变更处理」更新本 skill 再执行。
2. **验证/重建字库映射**：按 `extract_template.js` 抓 1 章测试解码：
   - 解码通顺 → 直接用 `tools/fanqie_crawler/font/mapping_ocr.json`；
   - 大量乱码 → 下载 woff2 到 `tools/fanqie_crawler/font/` → 从仓库根执行 `python tools/fanqie_crawler/build_mapping.py`（默认重建 `font/mapping_ocr.json`；如需指定路径，参数用**仓库根绝对路径**，勿用相对路径）。
3. **抓前十章**：取前十章章节 id（详情页目录数组，或 `preItemId` 逐章回退，**全程字符串勿转 Number**），逐章抓取 → 落盘 `corpus/<书名>/raw_ch{n}.txt`（n=1..10）。
4. **解码**：从仓库根执行 `python tools/fanqie_crawler/batch_decode.py "<书名>"`（书名带引号，含特殊字符时不会出错；不带参数则处理全部）→ 生成 `dec_ch{n}.txt`（已有 dec 跳过）。
5. **精读归纳**：逐章精读前十章，按 `rules/fanqie_rules.md` 的「逐本观察记录模板」写该书的观察，追加到该文件的「逐本观察记录」节。
6. **归类与融合**：
   - **先读 `rules/fanqie_rules.md` 的「待校准的空白题材族」表，确认目标族当前的样本数与校准状态**，再决定分级。
   - 题材族 key 全表（以 `platform_rules.py` 的 GENRE_FAMILY_REGISTRY 为准）：`realistic_career`（现实事业）· `strong_flow`（玄幻/仙侠/奇幻/西幻/武侠/异能）· `urban_high_wu`（都市+超凡，background=alternate）· `mystery`（悬疑/推理/灵异）· `romance`（言情/甜宠）· `sci_fi`（科幻）· `historical`（历史）· `military`（军事）· `gaming`（游戏）· `fanfic`（同人）· `campus`（校园）。
   - **优先归入已有族（含空白占位族 sci_fi/military/fanfic/campus）**；确实无对应族才新建（新建需同时：注册 `GENRE_FAMILY_REGISTRY` 条目 + 更新「待校准的空白题材族」表 + 按模板归纳）。
   - 分级：族内 ≥2 本 → 重合项【必写】、个别写法【可选】；族内仅 1 本 →【参考规律】待验证。
7. **同步与清理**：
   - 把融合结果写进 `rules/fanqie_rules.md` 对应题材族；
   - 同步 `platform_rules.py`：更新或新增 `GENRE_FAMILY_REGISTRY` 条目与 `GENRE_STORYTELLING_*` / `GENRE_RHYTHM_*` 常量（分级注释注明样本来源）；
   - **删除 `corpus/<书名>/`**，不留在工作区。

## 观察记录与分级（单一事实源：rules/fanqie_rules.md）

观察记录**模板字段**与【必写】/【可选】/【参考规律】**分级口径**，一律以 `tools/fanqie_crawler/rules/fanqie_rules.md` 的「逐本观察记录模板」「分级口径」两节为准。写观察前先读该文件确认当前格式；**若本 skill 与 rules 文件不一致，以 rules 文件为准并更新本 skill**，不要另立格式。

同族多本时允许在族内以「共性」条目合并提炼（参考既有《天渊》《开局长生万古》合并写法）。

## 已知坑（务必注意）

- `browser_evaluate` 脚本必须顶层 `return` 对象，包 IIFE 会被吞成 undefined。
- 返回结构是 `{ content: [{ text }] }`，取 `text` 再 `JSON.parse` 一次。
- 章节 id 超过 Number.MAX_SAFE_INTEGER，全程字符串。
- 番茄免费章节约前十章，更后需会员；只抓免费区。
- 解码只读 JSON，纯 Python 无浏览器依赖；仅重建映射才需 `pip install fonttools pillow ddddocr`。

## 完成检查清单（逐项核对）

- [ ] `corpus/<书名>/` 已删除
- [ ] `rules/fanqie_rules.md` 已追加该书观察记录（模板字段齐全）
- [ ] 对应题材族已更新（含【必写】/【可选】/【参考规律】分级）
- [ ] `platform_rules.py` 的 GENRE_FAMILY_REGISTRY / 常量已同步（若新增或填了空白族，同步更新「待校准的空白题材族」表状态）
- [ ] 提交信息说明本次提取的书与题材族（如 `chore: 提取《书名》前十章校准 <题材族>`）
