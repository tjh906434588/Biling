# -*- coding: utf-8 -*-
"""一次性脚本：为「大纲页预览」注入一本临时测试小说 + 生效蓝图(分卷) + 模拟大纲。
每次运行都会先清理旧的测试数据再重新注入（幂等）。
用完可删：python seed_outline_preview.py --clean  删除该测试小说及其数据。
"""
import json
import sqlite3
import sys
from datetime import datetime

DB = "d:/Project/personal/Biling/backend/biling.db"
NOVEL_ID = "7f0a0d3c6b9e4d2a8f1e5c9b0a3d4e5f"  # 固定 uuid(32hex)
TS = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

# 卷分组（与蓝图 volumes 一致）
VOLUMES = [
    {"no": 1, "name": "灵根初醒", "focus": "陆沉觉醒遗珠，立足外门，初识沈青桐", "chapters_range": "1-40", "word_count": "20万字", "chapter_count": "40章"},
    {"no": 2, "name": "宗门暗流", "focus": "内门考核与血丹阴谋，卷入长老暗战", "chapters_range": "41-80", "word_count": "22万字", "chapter_count": "40章"},
    {"no": 3, "name": "天骄争锋", "focus": "天骄大比夺魁，遗珠真相揭开", "chapters_range": "81-120", "word_count": "24万字", "chapter_count": "40章"},
]
BLUEPRINT_CONTENT = {
    "novel_title": "【预览】凡尘问道",
    "tagline": "杂灵根少年，问鼎大道之巅",
    "protagonist": "陆沉：杂灵根，身怀上古遗珠，从外门杂役一路崛起",
    "theme": "凡尘问道：天赋可以被定义，命运不能被定义",
    "volumes": VOLUMES,
    "foreshadowing_plan": [
        {"desc": "上古遗珠来历", "setup_chapter": 1, "reveal_chapter": 85},
        {"desc": "无名残卷", "setup_chapter": 12, "reveal_chapter": 62},
        {"desc": "沈青桐身世", "setup_chapter": 62, "reveal_chapter": 120},
    ],
    "notes": ["测试数据：仅用于大纲页效果预览，可随时删除。"],
}

# 全部章节号（分布在 3 卷内，数量足够看滚动效果）
CHAPTERS = [1, 3, 5, 8, 12, 16, 20, 25, 28, 33, 37,
            41, 45, 50, 54, 58, 62, 66, 70, 74, 78,
            81, 85, 89, 93, 97, 101, 105, 109, 113]
# 已批准的章节（每卷至少一条，其余为草稿）
APPROVED = {1, 5, 41, 62, 85, 113}

FUNCTIONS = ["buildup", "progression", "turning", "climax", "revelation", "resolution", "interlude"]
GOAL_FN = {
    "buildup": "铺垫氛围、埋设悬念",
    "progression": "推进主线、主角实力成长",
    "turning": "情节转折、局势反转",
    "climax": "正面冲突、矛盾爆发",
    "revelation": "揭晓关键真相",
    "resolution": "收束事件、沉淀收获",
    "interlude": "日常间奏、人物刻画",
}
TITLE_FN = {
    "buildup": "暗流涌动", "progression": "步步为营", "turning": "峰回路转",
    "climax": "殊死一搏", "revelation": "真相浮出", "resolution": "尘埃落定", "interlude": "山雨欲来",
}
CHARACTERS = ["陆沉", "沈青桐", "阿虎", "丹峰长老", "掌门"]
LOCATIONS = ["青云宗·演武场", "丹峰·地下丹房", "藏经阁", "外门集市", "天骄台"]


def make_content(ch: int) -> dict:
    fn = FUNCTIONS[ch % len(FUNCTIONS)]
    return {
        "goal": f"第{ch}章：{GOAL_FN[fn]}。主角与相关角色相遇或交锋，线索向前推进，并为后续章节埋下钩子。",
        "chapter_function": fn,
        "pov": "陆沉" if ch % 3 else "沈青桐",
        "characters": CHARACTERS[: 2 + ch % 3],
        "locations": [LOCATIONS[ch % len(LOCATIONS)]],
        "conflicts": ["新对手登场，主角实力尚显不足", "各方势力暗中角力"],
        "beats": [
            {"beat": "开篇推进", "detail": f"承接上一章，陆沉在{LOCATIONS[ch % len(LOCATIONS)]}发现新的线索。"},
            {"beat": "冲突升级", "detail": "对手步步紧逼，陆沉被迫亮出一部分底牌。"},
            {"beat": "收尾钩子", "detail": "危机暂解，但一道新的阴影悄然浮现。"},
        ],
        "plant": [] if ch % 5 else [{"desc": f"第{ch}章埋设的伏笔", "target_reveal_chapter": ch + 20}],
        "resolve": [] if ch % 4 else [{"desc": f"第{ch}章回收的伏笔", "resolved_at_chapter": ch}],
        "thread_updates": [],
    }


# 几个关键章节的手写丰富内容（复用第一版）
RICH = {
    1: {"goal": "主角参加青云宗入门测灵，被测出杂灵根当众遭嘲讽，却在昏厥时暗中触发体内上古遗珠共鸣，埋下\"天资\"真相的伏笔。",
        "chapter_function": "buildup", "pov": "陆沉", "characters": ["陆沉", "测灵长老", "陆青山"],
        "locations": ["青云宗·测灵台", "杂役房"], "conflicts": ["杂灵根被宗门判定为废材", "与堂兄陆青山的对比落差"],
        "beats": [{"beat": "登台测灵", "detail": "陆沉注入灵力，测灵石只亮起黯淡的三色杂光，全场哄笑。"},
                  {"beat": "当众羞辱", "detail": "堂兄陆青山被测出天灵根，长老当场收入内门，对比中陆沉沦为笑柄。"},
                  {"beat": "遗珠共鸣", "detail": "夜晚杂役房，陆沉睡梦中丹田遗珠微微发热，一缕混沌灵气涌入经脉。"}],
        "plant": [{"desc": "上古遗珠真正来历不明", "target_reveal_chapter": 85}], "resolve": [],
        "thread_updates": [{"desc": "遗珠异象首次出现", "status": "open"}]},
    5: {"goal": "陆沉在杂役房站稳脚跟，靠遗珠辅助修炼速度远超同批杂役，结识好友阿虎，并首次获得灵石收入。",
        "chapter_function": "progression", "pov": "陆沉", "characters": ["陆沉", "阿虎"],
        "locations": ["青云宗·杂役房", "外门集市"], "conflicts": ["杂役管事克扣月例", "同批杂役排挤"],
        "beats": [{"beat": "杂役日常", "detail": "陆沉靠遗珠改善体质，砍柴挑水速度远超常人，引来管事注意。"},
                  {"beat": "集市初探", "detail": "阿虎带陆沉溜去外门集市，用猎物换到第一块下品灵石。"},
                  {"beat": "暗流初显", "detail": "遗珠每夜吞纳月华，陆沉隐隐感到体内灵力凝成一颗种子。"}],
        "plant": [{"desc": "遗珠凝种，疑似功法雏形", "target_reveal_chapter": 62}], "resolve": [], "thread_updates": []},
    12: {"goal": "陆沉在藏经阁打扫时发现一本无名残卷，与内门师姐沈青桐初次交集，引出后续调查线。",
         "chapter_function": "turning", "pov": "沈青桐", "characters": ["陆沉", "沈青桐"],
         "locations": ["青云宗·藏经阁"], "conflicts": ["残卷来源不明，疑似禁书", "沈青桐对杂役的偏见"],
         "beats": [{"beat": "残卷初现", "detail": "藏经阁角落积灰的书架下，陆沉扫出一本无字残卷，触碰时字迹显形。"},
                   {"beat": "误闯", "detail": "沈青桐深夜私入藏经阁寻书，与陆沉撞个正着，误会他是偷书贼。"},
                   {"beat": "相认", "detail": "误会澄清，沈青桐认出残卷文字与宗门秘档同源，约定暗中调查。"}],
         "plant": [{"desc": "无名残卷与宗门秘档同源", "target_reveal_chapter": 62}], "resolve": [],
         "thread_updates": [{"desc": "沈青桐入调查线", "status": "open"}]},
    28: {"goal": "外门大比中，陆沉灵根异象初显，惊动闭关长老，天资疑云再起。",
         "chapter_function": "climax", "pov": "陆沉", "characters": ["陆沉", "长老", "阿虎"],
         "locations": ["青云宗·外门演武场"], "conflicts": ["大比被内门弟子刻意针对", "灵根异象暴露的风险"],
         "beats": [{"beat": "大比开赛", "detail": "外门大比，陆沉一路连胜，被内门种子弟子点名切磋。"},
                   {"beat": "异象爆发", "detail": "激战中遗珠护主，陆沉周身腾起混沌灵光，惊动演武场。"},
                   {"beat": "长老现身", "detail": "闭关长老破关而出，盯着陆沉若有所思，只说了一句\"有趣\"。"}],
         "plant": [{"desc": "长老对陆沉灵根起疑", "target_reveal_chapter": 85}], "resolve": [], "thread_updates": []},
    45: {"goal": "陆沉通过内门考核，却被分到最不受待见的丹峰，暗线是丹峰隐藏着炼丹阴谋。",
         "chapter_function": "progression", "pov": "陆沉", "characters": ["陆沉", "沈青桐", "丹峰峰主"],
         "locations": ["青云宗·内门", "丹峰"], "conflicts": ["考核成绩被压分", "丹峰峰主态度诡异"],
         "beats": [{"beat": "考核过线", "detail": "陆沉以内门垫底的成绩勉强过关，怀疑有人故意压分。"},
                   {"beat": "分入丹峰", "detail": "分配结果出来，陆沉被分到人丁稀少的丹峰，沈青桐暗觉蹊跷。"},
                   {"beat": "丹峰疑云", "detail": "陆沉在丹峰库房闻到一丝腥甜，与残卷记载的\"血丹\"隐隐吻合。"}],
         "plant": [{"desc": "丹峰库房腥甜气味疑似血丹", "target_reveal_chapter": 62}], "resolve": [],
         "thread_updates": []},
    62: {"goal": "陆沉与沈青桐联手查明丹峰\"血丹\"阴谋，回收\"残卷/腥甜\"伏笔，揭开长老真面目。",
         "chapter_function": "turning", "pov": "陆沉", "characters": ["陆沉", "沈青桐", "丹峰长老"],
         "locations": ["丹峰·地下丹房"], "conflicts": ["长老以活人炼丹的惊天秘密", "沈青桐身份被识破"],
         "beats": [{"beat": "夜探丹房", "detail": "陆沉与沈青桐夜潜地下丹房，撞见长老以活弟子为引炼制血丹。"},
                   {"beat": "身份暴露", "detail": "撤离时沈青桐面纱被掀，长老认出她与掌门血脉相似。"},
                   {"beat": "拼死出逃", "detail": "二人重伤逃出，残卷在关键时刻示警，印证\"血丹\"记载。"}],
         "plant": [],
         "resolve": [{"desc": "残卷/腥甜伏笔回收，指向长老阴谋", "resolved_at_chapter": 62}],
         "thread_updates": [{"desc": "沈青桐身世线开启", "status": "open"}]},
    85: {"goal": "宗门天骄大比开赛，陆沉首战对上种子选手，遗珠秘密在众目睽睽下部分揭开。",
         "chapter_function": "climax", "pov": "陆沉", "characters": ["陆沉", "种子选手", "掌门"],
         "locations": ["青云宗·天骄台"], "conflicts": ["种子选手碾压式实力", "遗珠暴露引发各方觊觎"],
         "beats": [{"beat": "大比开幕", "detail": "宗门上下聚焦天骄大比，陆沉以丹峰弟子身份杀入正赛。"},
                   {"beat": "强敌首战", "detail": "首战即遇上一等一种子选手，对方祭出半步神通。"},
                   {"beat": "遗珠显威", "detail": "绝境中遗珠全面苏醒，陆沉修为暴涨，灵根真貌在掌门眼前一闪而逝。"}],
         "plant": [{"desc": "遗珠真貌被掌门注意", "target_reveal_chapter": 120}], "resolve": [],
         "thread_updates": []},
}


def build_outlines():
    rows = []
    for ch in CHAPTERS:
        title = f"{TITLE_FN[FUNCTIONS[ch % len(FUNCTIONS)]]}{ch}"
        status = "approved" if ch in APPROVED else "draft"
        rows.append((ch, title, status, RICH.get(ch, make_content(ch))))
    return rows


def clean():
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    for table in ("outlines", "blueprints", "novels", "chapters", "settings", "plot_ledger"):
        try:
            cur.execute(f"DELETE FROM {table} WHERE novel_id=?", (NOVEL_ID,))
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()
    print("已清理测试小说数据")


def seed():
    clean()
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute(
        "INSERT OR REPLACE INTO novels (id, title, premise, style_directive, style_directive_manual, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (NOVEL_ID, "【预览】凡尘问道", "杂灵根少年陆沉觉醒上古遗珠，逆袭问道。测试用临时小说，可删除。", None, None, TS, TS),
    )
    bp_id = "9a1b2c3d4e5f60718293a4b5c6d7e8f9"
    cur.execute(
        "INSERT OR REPLACE INTO blueprints (id, novel_id, version, parent_id, content, status, source_doc, doc_name, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (bp_id, NOVEL_ID, 1, None, json.dumps(BLUEPRINT_CONTENT, ensure_ascii=False), "active", None, "测试蓝图.docx", TS),
    )
    for i, (ch, title, status, content) in enumerate(build_outlines(), start=1):
        o_id = f"1000{i:04d}{NOVEL_ID[:16]}{i:04d}0000"
        cur.execute(
            "INSERT OR REPLACE INTO outlines (id, novel_id, blueprint_id, chapter_no, title, content, status, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (o_id, NOVEL_ID, bp_id, ch, title, json.dumps(content, ensure_ascii=False), status, TS),
        )
    conn.commit()
    conn.close()
    n = len(build_outlines())
    print(f"已注入：测试小说 {NOVEL_ID} / 生效蓝图(3卷) / {n} 条大纲")
    print(f"预览地址：http://localhost:3000/workspace/{NOVEL_ID}?tab=outline")


if __name__ == "__main__":
    if "--clean" in sys.argv:
        clean()
    else:
        seed()
