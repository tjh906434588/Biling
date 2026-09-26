/**
 * 番茄小说章节提取 + 解码模板
 *
 * 运行环境：TRAE 的 integrated_code_mode（Exec）+ 浏览器工具。
 * 前置条件：
 *   1) 浏览器已登录番茄小说（可免费阅读前十章）。
 *   2) MAP：把 tools/fanqie_crawler/font/mapping_ocr.json 的内容粘贴到下方 MAP 处。
 *   3) 新书如果解码出来大量乱码，说明字体与 fanqie.woff2 不同，需：
 *      页面内跑 getFontUrl 拿到 woff2 地址 -> 下载 -> build_mapping.py 重建映射。
 *
 * 三个必踩的坑（都实际踩过）：
 *   1. browser_evaluate 的脚本必须用【顶层 return】返回对象，不要包 IIFE！
 *      (() => { ... })() 这种块状箭头函数 IIFE 的返回值会被 harness 吞成 undefined。
 *   2. browser_evaluate 返回结构是 { content: [{ type:'text', text }] }，
 *      要先取 content[0].text，再 JSON.parse 一次。
 *   3. 章节 itemId 超过 Number.MAX_SAFE_INTEGER，全程用字符串比较，不要转 Number。
 */

/* ============ 1. MAP：粘贴 mapping_ocr.json 的内容 ============ */
const MAP = {
  "58345": "在",
  /* ... 共约 361 条，整份粘贴自 tools/fanqie_crawler/font/mapping_ocr.json ... */
};

/* ============ 2. 字体 URL 提取（新书乱码时才需要） ============ */
const getFontUrl = `(() => {
  const urls = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules || []) {
        if (rule instanceof CSSFontFaceRule && rule.style.src) {
          const m = rule.style.src.match(/url\\(['"]?([^'")]+)/);
          if (m) urls.push(m[1]);
        }
      }
    } catch (e) {}
  }
  return urls;
})()`;

/* ============ 3. 单章提取+解码脚本（顶层 return，勿包 IIFE） ============ */
const buildChapterScript = (MAP, id) => `
const MAP = ${JSON.stringify(MAP)};
const id = ${JSON.stringify(id)};
const cd = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.reader && window.__INITIAL_STATE__.reader.chapterData;
if (!cd) return { st: 'no_data' };
if (String(cd.itemId) !== id) return { st: 'stale', got: String(cd.itemId) };
const plain = (cd.content || '').replace(/<[^>]*>/g, '');
const dec = [...plain].map(c => { const cp = c.codePointAt(0); return MAP[cp] !== undefined ? MAP[cp] : c; }).join('');
return { st: 'ok', title: cd.title, dec };
`;

/* ============ 4. 逐章抓取循环 ============ */
async function fetchChapters(tools, MAP, chapterIds) {
  const out = [];
  for (const id of chapterIds) {
    let ok = false, r = null;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      await tools.browser_navigate({ url: 'https://fanqienovel.com/reader/' + id });
      const raw = await tools.browser_evaluate({ script: buildChapterScript(MAP, id) });
      const txt = raw && raw.content && raw.content[0] && raw.content[0].text;
      try { r = JSON.parse(txt); } catch (e) { r = { st: 'parse_err', txt: String(txt).slice(0, 150) }; }
      if (r && r.st === 'ok') ok = true;
    }
    out.push(ok ? { id, title: r.title, dec: r.dec } : { id, error: 'failed after retries' });
  }
  return out;
}

/* ============ 5. 章节 id 获取 ============ */
// 方案A（详情页目录）：进 https://fanqienovel.com/page/{bookId}，从 __INITIAL_STATE__ 找目录数组。
// 方案B（preItemId 回退）：从任意章节页读 chapterData.preItemId 逐章向前拿 id（《十日终焉》用此法）。
const walkBack = `const d = window.__INITIAL_STATE__.reader.chapterData;
return { itemId: String(d.itemId), pre: d.preItemId ? String(d.preItemId) : null, title: d.title };`;

/* ============ 6. 落盘 ============ */
// 每章 decoded 写入 tools/fanqie_crawler/corpus/<书名>/dec_ch{n}.txt
// await tools.write_to_file({ rewrite: false, file_path: '...', content: '《书名》' + title + '\\n\\n' + dec });
