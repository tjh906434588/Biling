/**
 * @file ai-status.tsx
 * AI 接入状态：全局统一判断"AI 是否可用"，并给出未接入横幅、Token 消耗标注。
 * 核心机制：ready 的标准是任一服务商已配置可用凭据（服务商 Key / 环境变量 / 已接入模型的独立 Key
 * 任一存在即视为就绪，未设默认模型时后端自动回退选择）；未就绪时所有 AI 功能不可用，
 * 各调用点在执行前调用 ensureReady() 抛出带指引的错误。AI 状态经 React Context 提供给全应用，
 * AiNotReadyBanner 以右上角常驻 error 通知的形式提示接入。
 */
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getDefaultModel,
  listModelCatalog,
  type CatalogProvider,
  type DefaultModel,
} from "@/lib/api";
import {
  closeNotification,
  notification,
  removeNotification,
} from "@/components/notification";

/** 全局 AI 状态值（Context 内容）：由 AiStatusProvider 计算并下发 */
interface AiStatus {
  /** 目录与默认模型是否加载完成（加载中不弹横幅，避免闪烁） */
  loading: boolean;
  /** AI 是否已就绪（任一服务商已配置可用凭据） */
  ready: boolean;
  /** 当前使用的模型标签，如 deepseek/deepseek-chat；未配置为 null */
  label: string | null;
  /** 重新拉取目录与默认模型（模型页配置完成后调用） */
  refresh: () => void;
  /** 未就绪时抛 Error（带配置指引文案）；就绪时静默通过 */
  ensureReady: () => void;
}

/** 全局 AI 状态上下文：Provider 写入，useAiStatus 读取；null 表示 Provider 未挂载 */
const Ctx = createContext<AiStatus | null>(null);

/**
 * AI 状态 Provider：挂载于根布局，负责加载模型目录与默认模型，
 * 计算 ready / label，并对外提供 refresh（重拉）与 ensureReady（就绪校验）。
 */
export function AiStatusProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [defaultModel, setDefaultModel] = useState<DefaultModel | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cat, def] = await Promise.all([listModelCatalog(), getDefaultModel()]);
      setCatalog(cat);
      setDefaultModel(def);
    } catch {
      /* 拉取失败保持现状，不阻塞页面 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 任一服务商已配置可用凭据（服务商 Key / 环境变量 / 已接入模型的独立 Key）即视为 AI 就绪；
   *  未设默认模型时后端会自动回退选择可用模型。 */
  const ready = catalog.some((p) => p.configured);

  /** 当前默认模型展示标签（中文服务商名/模型）；未配置默认模型时为 null */
  const label = defaultModel
    ? `${catalog.find((p) => p.provider === defaultModel.provider)?.label ?? defaultModel.provider}/${defaultModel.model}`
    : null;

  const ensureReady = useCallback(() => {
    if (!ready) {
      throw new Error(
        "还没配好 AI 模型：这个功能要用到 AI（会消耗你的用量）。请先到「模型」页添加模型并填入密钥，再回来使用。",
      );
    }
  }, [ready]);

  return (
    <Ctx.Provider value={{ loading, ready, label, refresh, ensureReady }}>{children}</Ctx.Provider>
  );
}

/** 读取全局 AI 状态；必须在 <AiStatusProvider> 内调用，否则抛出错误。 */
export function useAiStatus(): AiStatus {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAiStatus 必须在 <AiStatusProvider> 内使用");
  return ctx;
}

/** 未接入 AI 模型时的全局提示：右上角常驻 error 通知（代替原页面内联横幅）。
 *  通知带「去配置模型」按钮，点击跳转模型页；就绪后自动移除，组件卸载时一并移除。 */
export function AiNotReadyBanner({ onConfigure }: { onConfigure?: () => void }) {
  const { loading, ready, label } = useAiStatus();
  // 已弹出的通知 id：避免重复弹；onConfigure 用 ref 持有，避免内联函数引起 effect 重跑
  const notifIdRef = useRef<number | null>(null);
  const onConfigureRef = useRef(onConfigure);
  useEffect(() => {
    onConfigureRef.current = onConfigure;
  });

  useEffect(() => {
    if (loading) return;
    if (!ready) {
      if (notifIdRef.current !== null) return; // 已弹出，不重复
      const button = onConfigureRef.current
        ? {
            onClick: () => {
              if (notifIdRef.current !== null) closeNotification(notifIdRef.current);
              notifIdRef.current = null;
              onConfigureRef.current?.();
            },
          }
        : null;
      notifIdRef.current = notification.error({
        title: `AI 模型还没配好${label ? `（当前选中了 ${label}，但还没填密钥）` : ""}`,
        message: (
          <>
            还没有可用的 AI 模型，写正文、提取、评价这些功能都暂时用不了。
            {button && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={button.onClick}
                  className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-red-500"
                >
                  去配置模型
                </button>
              </div>
            )}
          </>
        ),
        duration: 0, // 常驻：未接入期间一直显示，需手动关闭或配置好后自动消失
      });
    } else if (notifIdRef.current !== null) {
      // 已就绪（用户配置好模型）：移除未接入提示
      removeNotification(notifIdRef.current);
      notifIdRef.current = null;
    }
  }, [loading, ready, label]);

  // 组件卸载（离开本区域）：移除通知（不触发 onClose）
  useEffect(
    () => () => {
      if (notifIdRef.current !== null) {
        removeNotification(notifIdRef.current);
        notifIdRef.current = null;
      }
    },
    [],
  );

  return null;
}

/** 标注"该操作会调用 AI、产生 Token 消耗"的极简提示（放在 AI 按钮旁）。 */
export function CostHint({ children }: { children?: ReactNode }) {
  return (
    <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
      {children ?? "使用 AI · 会消耗你的用量"}
    </span>
  );
}
