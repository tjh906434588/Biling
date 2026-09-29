/**
 * @file constants/settings.ts
 * 设定页相关共享常量：设定类型规格 SETTING_SPECS（类型/标签/示例/判定标准/填写建议，驱动设定表单与类型栏）、
 * 一键复制给外部 AI 的导入指令 IMPORT_INSTRUCTION、阶段固定顺序 STAGE_ORDER。
 */
import type { SettingType } from "@/types/api";

/** 设定类型规格：每类设定的中文标签、示例、判定标准与「不可变/可变」填写建议。
 *  TYPE_LABEL / SPEC_OF 由本表派生，是设定类型文案的单一事实来源。 */
export const SETTING_SPECS: Array<{
  key: SettingType;
  label: string;
  hint: string;
  example: string;
  judge: string;
  name_hint: string;
  desc_hint: string;
  constitution_advice: string;
}> = [
  {
    key: "character",
    label: "角色",
    hint: "谁在故事里",
    example: "岚：沉默的占卜师，左眼能看到死者的记忆",
    judge: "会说话、有自我意识的（活物/系统有嘴也算）",
    name_hint: "岚",
    desc_hint: "如：左眼能看到死者记忆的占卜师，沉默寡言",
    constitution_advice: "性别/身份/血统/异能来源填「不可变」；性格成长填「可变」，交给记忆层跟踪。",
  },
  {
    key: "location",
    label: "地点",
    hint: "故事发生在哪",
    example: "旧王城：雾都，占卜房藏在第七街尽头",
    judge: "在哪：故事发生的场所",
    name_hint: "旧王城",
    desc_hint: "如：常年起雾，占卜房藏在第七街尽头",
    constitution_advice: "本质（位置、特征）填「不可变」；当前状态（被毁、废弃、易主）填「可变」。",
  },
  {
    key: "faction",
    label: "势力",
    hint: "组织 / 家族 / 阵营",
    example: "灰袍议会：暗中篡改王城记忆的组织",
    judge: "组织：家族/帮派/阵营",
    name_hint: "灰袍议会",
    desc_hint: "如：暗中篡改王城记忆的组织，首领身份不明",
    constitution_advice: "宗旨、根基填「不可变」；当前强弱、首领、敌友关系填「可变」。",
  },
  {
    key: "world_rule",
    label: "世界规则",
    hint: "这个世界的法则",
    example: "魔法消耗寿命，且不可逆转",
    judge: "法则：所有角色都遵守（如人人都有系统）",
    name_hint: "魔法耗尽寿命",
    desc_hint: "如：用一次魔法就折损一段寿命，不可逆转",
    constitution_advice: "世界法则基本都填「不可变」——违背即崩，AI 必须死守。",
  },
  {
    key: "item",
    label: "物品",
    hint: "有来历的道具 / 宝物",
    example: "旧王徽铜币：遇险会发烫，认得主人",
    judge: "道具：实体的、拿得到的",
    name_hint: "旧王徽铜币",
    desc_hint: "如：遇险会发烫，只认主人",
    constitution_advice: "核心功能、限制填「不可变」；在谁手里、是否损坏填「可变」。",
  },
  {
    key: "concept",
    label: "概念",
    hint: "世界观里的特有名词",
    example: "记忆刻印：记忆可以被人为写入和抹除",
    judge: "特有名词/机制（如主角独有的系统）",
    name_hint: "记忆刻印",
    desc_hint: "如：记忆可以被人为写入和抹除",
    constitution_advice: "概念的定义是恒定名词，基本都填「不可变」。",
  },
];

/** 一键复制的导入指令：发给外部 AI（豆包/DeepSeek 等），让它们按本产品格式输出设定 JSON。 */
export const IMPORT_INSTRUCTION = `你是小说设定整理助手。请把用户提供的关于小说的设定描述，拆解成结构化设定条目。

【输出格式】只输出一个严格的 JSON 数组，不要任何多余文字，不要用 markdown 代码块包裹。每个元素：
{
  "type": "character 或 location 或 faction 或 world_rule 或 item 或 concept",
  "name": "设定名称",
  "constitution": "不可变内容（死规矩，AI 永不违背）",
  "dynamic": "可变内容（随剧情演变的性格/状态，没有就填空字符串）",
  "role_rank": "仅 type 为 character 时必填：protagonist 或 major 或 minor 或 extra",
  "appear_from": 5,
  "appear_until": 20,
  "stages": ["early", "late"]
}

【类型判定标准】
- character 角色：会说话、有自我意识的活物/系统
- location 地点：故事发生的场所
- faction 势力：组织/家族/阵营
- world_rule 世界规则：所有角色都遵守的法则（如人人都有系统）
- item 物品：有来历的道具/宝物
- concept 概念：世界观里的特有名词/机制

【出现时机（可选，防后期设定提前出现）】
- stages：设定生效的故事阶段（大致范围），可多选：early（前期）/ middle（中期）/ late（后期）；不写表示不限制
- appear_from / appear_until：在所选阶段内的更细限定（如「后期」里第 25~30 章才出现）；不写 = 整个所选阶段生效；必须搭配 stages 使用
- appear_ranges：可指定多段不连续范围（如跳过中期、只在前/后期出现）：[{ "from": 1, "until": 266 }, { "from": 534, "until": 800 }]；与 appear_from / appear_until 二选一，出现时以前者为准

【要求】
1. 每一条必须有 type 和 name；
2. constitution 写死规矩（身份、血统、世界法则、核心功能等）；dynamic 写可演变的（性格成长、当前状态、物品去向等），没有就留空；
3. 角色按戏份定 role_rank：主角 protagonist / 重要配角 major / 次要配角 minor / 龙套 extra；
4. 拆分要细：一个角色一条、一个地点一条，不要把多个塞进一条；
5. 后期才登场的设定（如后期创立的公司）务必标上 appear_from 和/或 stages，避免前期章节提前出现。

现在请根据用户提供的描述，输出 JSON 数组。`;

/** 阶段固定顺序（前→中→后），用于展示排序，避免随点击顺序变化。 */
export const STAGE_ORDER: Record<string, number> = { early: 0, middle: 1, late: 2 };
