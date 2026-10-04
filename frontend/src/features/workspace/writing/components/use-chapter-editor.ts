/**
 * @file writing/use-chapter-editor.ts
 * 正文就地编辑机制（从 writing-panel.tsx 按职责拆分，行为完全不变）：
 * - 编辑区内容 + 镜像 ref（防抖保存 / AI 操作前落盘读到的最新输入）；
 * - 「防抖 2s 自动落盘 + 切版本/卸载兜底落盘」，切章用请求序号防竞态覆盖；
 * - 版本化人工编辑：第一次改动 AI 版本先派生 user_edit，后续同一编辑会话继续保存该人工版本。
 * 关键机制：editTargetRef 记录当前编辑目标（章节号 + 版本 id + source），切版本/卸载时据此把旧编辑落盘。
 */
"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { deriveManualVersion, updateChapterVersion, type ChapterDetail, type ChapterVersion } from "@/lib/api";
import type { ShowToast } from "./panel-utils";

/** 编辑器 hook 的入参：面板侧传入选中版本、详情章号与详情写入通道。 */
interface UseChapterEditorOptions {
  novelId: string;
  /** 当前预览选中的正文版本；null = 无版本（编辑目标清空）。 */
  selectedVersion: NonNullable<ChapterDetail["versions"]>[number] | null;
  /** 当前详情章节号（编辑目标的一部分；null = 无详情）。 */
  detailChapterNo: number | null | undefined;
  /** 详情写入通道：落盘成功后把新内容回填进版本列表（避免旧内容覆盖新内容）。 */
  setDetail: Dispatch<SetStateAction<ChapterDetail | null>>;
  setSelectedVersionId: Dispatch<SetStateAction<string | null>>;
  showToast: ShowToast;
}

export function useChapterEditor({
  novelId,
  selectedVersion,
  detailChapterNo,
  setDetail,
  setSelectedVersionId,
  showToast,
}: UseChapterEditorOptions) {
  const [editText, setEditText] = useState("");
  const editTextRef = useRef("");
  const lastSavedTextRef = useRef("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const saveTimerRef = useRef<number | null>(null);
  const editTargetRef = useRef<{ chapterNo: number; versionId: string; source: string } | null>(null);

  /** 把正文保存到人工版本：AI 版本第一次修改先派生 user_edit，后续同一编辑会话继续 PATCH 该人工版本。 */
  const persistText = useCallback(
    async (target: { chapterNo: number; versionId: string; source: string }, text: string, selectDerived: boolean) => {
      let versionId = target.versionId;
      let updated: ChapterVersion;
      if (target.source === "user_edit") {
        updated = await updateChapterVersion(novelId, target.chapterNo, versionId, { content: text });
      } else {
        updated = await deriveManualVersion(novelId, target.chapterNo, versionId, {
          source: "user_edit",
          content: text,
        });
        versionId = updated.id;
        if (selectDerived) setSelectedVersionId(versionId);
        editTargetRef.current = { chapterNo: target.chapterNo, versionId, source: "user_edit" };
      }
      setDetail((d) => {
        if (!d || d.chapter_no !== target.chapterNo) return d;
        const exists = d.versions.some((v) => v.id === updated.id);
        return { ...d, versions: exists ? d.versions.map((v) => (v.id === updated.id ? updated : v)) : [...d.versions, updated] };
      });
      return updated;
    },
    [novelId, setDetail, setSelectedVersionId],
  );

  /** 立即落盘当前未保存编辑（防抖触发 / AI 操作前 / 切版本 / 卸载时复用）。返回落库后的文本。 */
  const flushSave = useCallback(async (): Promise<string | null> => {
    const target = editTargetRef.current;
    if (!target) return null;
    const text = editTextRef.current;
    if (text === lastSavedTextRef.current) return text;
    setSaveState("saving");
    try {
      const updated = await persistText(target, text, true);
      if (editTextRef.current === text) {
        lastSavedTextRef.current = updated.content;
        setSaveState("saved");
      }
      return updated.content;
    } catch (e) {
      setSaveState("dirty");
      showToast((e as Error).message, "error");
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistText]);

  // ── 正文就地编辑：镜像 ref + 切版本落盘 + 防抖自动保存 + 卸载兜底 ──
  /** 编辑区内容镜像到 ref：防抖保存 / AI 操作前落盘读到的永远是最新输入。 */
  useEffect(() => {
    editTextRef.current = editText;
  }, [editText]);

  /** 选中版本变化：先把上一版本未保存的编辑静默落盘，再切换编辑目标到新版本内容。 */
  useEffect(() => {
    const old = editTargetRef.current;
    if (old && editTextRef.current !== lastSavedTextRef.current) {
      const text = editTextRef.current;
      void persistText(old, text, false)
        .then((v) => {
          if (editTargetRef.current?.versionId === old.versionId) lastSavedTextRef.current = v.content;
        })
        .catch((e) => showToast((e as Error).message, "error"));
    }
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!selectedVersion) {
      editTargetRef.current = null;
      lastSavedTextRef.current = "";
      setEditText("");
      setSaveState("saved");
      return;
    }
    editTargetRef.current = { chapterNo: detailChapterNo ?? 0, versionId: selectedVersion.id, source: selectedVersion.source };
    lastSavedTextRef.current = selectedVersion.content;
    setEditText(selectedVersion.content);
    setSaveState("saved");

    // 仅依赖选中版本 id；详情章号变化不触发重切编辑目标
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersion?.id]);

  /** 防抖自动保存：停止输入 2s 后自动落盘；无改动不触发。 */
  useEffect(() => {
    if (!editTargetRef.current) return;
    if (editText === lastSavedTextRef.current) {
      // 输入又回到已落盘内容：无未保存改动，撤销「已修改」标记
      setSaveState("saved");
      return;
    }
    setSaveState("dirty");

    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, 2000);
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editText]);

  /** 卸载兜底：防抖还没到就切页/关面板，把未保存编辑静默落盘。 */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const target = editTargetRef.current;
      if (target && editTextRef.current !== lastSavedTextRef.current) {
        void persistText(target, editTextRef.current, false).catch((e) => showToast((e as Error).message, "error"));
      }
    };
  // 卸载时使用当前闭包中的持久化函数，确保人工编辑也不会回写 AI 原版本。
  }, [novelId, persistText, showToast]);

  return {
    editText,
    setEditText,
    saveState,
    flushSave,
    editTextRef,
    editTargetRef,
  };
}
