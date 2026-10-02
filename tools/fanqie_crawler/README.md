# 番茄小说内容抓取工具（可复用 · 独立于项目功能模块）

> 用途：抓取番茄小说正文 → 建立 Biling 规则库的语料与规则总结。
> 这一套方法与 `backend/` 业务模块完全独立：只产出语料/规则，不参与产品功能，不挂在任何业务接口上。

## 目录结构

```
tools/fanqie_crawler/
├── font/                     # 字库与映射（跨书复用资产，核心是 mapping_ocr.json）
│   ├── fanqie.woff2          # 番茄自定义字体（私有码位字形）
│   ├── fanqie.ttf            # 转出的 ttf（build_mapping.py 生成）
│   └── mapping_ocr.json      # 私有码位(十进制)→真实汉字，约 361 条
├── build_mapping.py          # 换字体时重建映射（ddddocr，全自动）
├── decode_text.py            # 离线解码工具（纯 Python，无浏览器依赖）
├── extract_template.js       # 浏览器提取+解码脚本模板（Exec 环境）
├── corpus/                   # 抓取样本（临时产物）：提炼完规则即删除，不入库（见「语料清理」）
│   └── 十日终焉/dec_ch{1..10}.txt   # 示例（实际不提交）
└── rules/                    # 题材族约束库（通用，样本持续追加）
    └── fanqie_rules.md        # 各族 storytelling/rhythm 规则 + 逐本观察记录
```

## 完整流程（每次抓新书照此走）

1. **浏览器登录番茄**，进入目标书任意章节页。
2. **验证字体**：先按 extract_template.js 的 `fetchChapters` 抓 1 章。
   - 解码通顺 → 直接用现有 `font/mapping_ocr.json`。
   - 大量乱码 → 页面内跑 `getFontUrl` 取 woff2 地址 → 下载到 `font/` →
     `python build_mapping.py <woff2> font/mapping_ocr.json` 重建映射。
3. **取前十章章节 id**：
   - 方案A：详情页 `https://fanqienovel.com/page/{bookId}` 目录数组。
   - 方案B：任意章节页用 `chapterData.preItemId` 逐章向前回退（章节 id 是字符串）。
4. **逐章抓取解码**：在 Exec 中跑 `fetchChapters`（模板见 extract_template.js），
   每章 navigate → evaluate → 取 `content[0].text` → JSON.parse → 解码。
5. **落盘语料**：写入 `corpus/<书名>/dec_ch{n}.txt`。
6. **提炼规则**：阅读前十章，按 `rules/fanqie_rules.md` 内的模板追加该书的规则总结
   （开篇黄金三章 / 金手指兑现节奏 / 事件组织 / 悬念管理 / 可写规则清单），
   并做同族多本比对融合（【必写】/【可选】分级），同步到 `backend/app/agents/platform_rules.py`。

## 语料清理（重要）

`corpus/` 是第三方小说正文，**只在本地用于提炼规则，提炼完即删除，绝不提交到仓库**（`.gitignore` 已忽略该目录）。规则结论沉淀在 `rules/fanqie_rules.md` 与 `backend/app/agents/platform_rules.py`，不依赖原始语料。

## 已知坑（务必看）

- `browser_evaluate` 的脚本必须**顶层 return** 返回对象，包 IIFE 会被吞成 undefined。
- `browser_evaluate` 返回 `{ content: [{ text }] }`，取 `text` 再 `JSON.parse` 一次。
- 章节 id 超过 Number.MAX_SAFE_INTEGER，**全程字符串**，勿转 Number。
- 番茄免费章节为前十章左右，更后章节需会员/付费，抓取时只取免费区。

## 依赖

- 映射重建（仅换字体时需要）：`pip install fonttools pillow ddddocr`
- 解码/抓取：无额外依赖（解码只读 JSON，抓取走浏览器）。
