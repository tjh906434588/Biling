# -*- coding: utf-8 -*-
"""M1 闭环冒烟测试：写章 → 双版本对比 → 选定 → 提取 → 续写。

用法（后端已启动在 8000 端口）：
    .venv\\Scripts\\python.exe scripts\\smoke_m1.py

覆盖：
1. 创建小说
2. 设定库 CRUD（新增 / type 过滤 / PATCH / 软删除）
3. 小说家双版本并行生成（SSE 事件流：version_start → delta* → schema_validate）
4. 章节路由（列表 / 详情 / 选定合并）
5. 提取师 → story_state 入库
6. 续写下一章（依赖前文记忆与已定稿正文）
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

BASE = "http://127.0.0.1:8000"
PASS = []
FAIL = []


def check(name: str, ok: bool, detail: str = ""):
    (PASS if ok else FAIL).append(name)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail and not ok else ""))


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        raw = r.read().decode("utf-8")
        return json.loads(raw) if raw else None


def stream(agent, novel_id, params):
    """调 SSE 接口，返回 (events, texts_by_version)。"""
    req = urllib.request.Request(
        f"{BASE}/api/stream/agents/{agent}/run",
        data=json.dumps({"novel_id": novel_id, "params": params}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    events = []
    texts: dict[str, str] = {}
    cur_ev, cur_ver = "", ""
    with urllib.request.urlopen(req, timeout=180) as r:
        for raw in r:
            line = raw.decode("utf-8").rstrip("\n")
            if line.startswith("event: "):
                cur_ev = line[7:].strip()
            elif line.startswith("data: "):
                try:
                    data = json.loads(line[6:])
                except Exception:
                    data = line[6:]
                if cur_ev == "version_start":
                    cur_ver = data.get("version", "")
                    texts.setdefault(cur_ver, "")
                elif cur_ev == "stream_delta":
                    ver = data.get("version", cur_ver)
                    texts.setdefault(ver, "")
                    texts[ver] += data.get("delta", "")
                if cur_ev not in ("stream_delta",):
                    events.append((cur_ev, data))
    return events, texts


def main():
    # 1) 创建小说
    novel = call("POST", "/api/novels", {"title": "冒烟测试之书", "premise": "失忆少年追查身世。"})
    nid = novel["id"]
    check("创建小说", nid and novel["title"] == "冒烟测试之书", f"title={novel.get('title')}")

    # 2) 设定库 CRUD
    s1 = call("POST", f"/api/novels/{nid}/settings", {"type": "character", "name": "主角 岚", "description": "前占卜师。"})
    s2 = call("POST", f"/api/novels/{nid}/settings", {"type": "location", "name": "旧王城", "description": "记忆褪色的古城。"})
    check("创建设定", bool(s1["id"]) and bool(s2["id"]))
    flt = call("GET", f"/api/novels/{nid}/settings?type=character")
    check("type 过滤", len(flt) == 1 and flt[0]["type"] == "character")
    up = call("PATCH", f"/api/novels/{nid}/settings/{s1['id']}", {"description": "前占卜师（已补强）。"})
    check("PATCH 设定", up["description"].endswith("已补强）。"))
    call("DELETE", f"/api/novels/{nid}/settings/{s2['id']}")
    after = call("GET", f"/api/novels/{nid}/settings")
    check("软删除设定", len(after) == 1 and after[0]["id"] == s1["id"])

    # 3) 双版本生成
    events, texts = stream("novelist", nid, {
        "chapter_no": 1,
        "title": "第一章 半枚印记",
        "outline": "主角发现印记发光，决定去旧档案馆。",
        "chapter_function": "progression",
        "info_control": {"reader_knows": "主角左手有印记", "protagonist_knows": "自己失忆", "must_hide": "印记与通缉令的关联", "hint_only": "出生记录"},
    })
    vers = sorted(texts.keys())
    ok_a = any(e == ("schema_validate", {"version": "novelist_A", "status": "ok", "retried": False}) for e in events)
    ok_b = any(e == ("schema_validate", {"version": "novelist_B", "status": "ok", "retried": False}) for e in events)
    stored = next((d for e, d in events if e == "stored"), {})
    check("双版本并行生成", vers == ["novelist_A", "novelist_B"], f"versions={vers}")
    check("双版本校验通过", ok_a and ok_b)
    check("双版本落库", stored.get("action") == "persisted" and len(stored.get("versions", [])) == 2,
          json.dumps(stored, ensure_ascii=False))

    # 4) 章节路由 + 选定合并
    chapters = call("GET", f"/api/novels/{nid}/chapters")
    check("章节列表", len(chapters) == 1 and chapters[0]["chapter_no"] == 1)
    detail = call("GET", f"/api/novels/{nid}/chapters/1")
    check("章节详情两版本", len(detail["versions"]) == 2)
    va = next(v for v in detail["versions"] if v["source"] == "novelist_A")
    sel = call("POST", f"/api/novels/{nid}/chapters/1/select", {"version_id": va["id"]})
    active = [v for v in sel["versions"] if v["is_active"]]
    ch1 = next(c for c in call("GET", f"/api/novels/{nid}/chapters") if c["chapter_no"] == 1)
    check("选定合并激活唯一版本", len(active) == 1 and active[0]["source"] == "novelist_A")
    check("章节正文/字数/状态同步", ch1["status"] == "complete" and ch1["word_count"] == len(ch1["active_content"] or ""))

    # 5) 提取师 → story_state
    ext_events, _ = stream("extractor", nid, {"chapter_no": 1, "chapter_text": ch1["active_content"]})
    ext_stored = next((d for e, d in ext_events if e == "stored"), {})
    check("提取师入库 story_state", ext_stored.get("table") == "story_state", json.dumps(ext_stored, ensure_ascii=False))

    # 6) 续写第 2 章（验证前文记忆连续性输入）
    ev2, texts2 = stream("novelist", nid, {"chapter_no": 2, "title": "第二章 旧档案馆", "chapter_function": "buildup"})
    stored2 = next((d for e, d in ev2 if e == "stored"), {})
    check("续写第 2 章双版本", sorted(texts2.keys()) == ["novelist_A", "novelist_B"])
    check("第 2 章落库", stored2.get("action") == "persisted")

    print(f"\n===== 结果：{len(PASS)} 通过 / {len(FAIL)} 失败 =====")
    if FAIL:
        print("失败项：", FAIL)
        sys.exit(1)


if __name__ == "__main__":
    main()
