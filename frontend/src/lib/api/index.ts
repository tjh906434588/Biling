/**
 * @file lib/api/index.ts
 * API 客户端统一出口：按后端域拆分到本目录各文件（novels/settings/chapters/reviews/outlines/ledger/
 * blueprints/style/graph/models/agents/prompts），此处 barrel 重新导出，业务代码一律 `import from "@/lib/api"`
 * 即可，无需关心内部文件划分；领域/API 类型集中维护在 @/types/api（此处一并 re-export 保持向后兼容）。
 */
export * from "./errors";
export * from "./novels";
export * from "./settings";
export * from "./chapters";
export * from "./reviews";
export * from "./outlines";
export * from "./ledger";
export * from "./blueprints";
export * from "./graph";
export * from "./models";
export * from "./agents";
export * from "./prompts";
export * from "@/types/api";
