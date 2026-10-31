import { create } from "zustand";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { DraftId } from "./composerDraftStore";

export type FileDropTarget = ScopedThreadRef | DraftId;
export const fileDropTargetKey = (target: FileDropTarget) =>
  typeof target === "string" ? `draft:${target}` : scopedThreadKey(target);

/** Files wait for the destination composer to mount, and never move with navigation. */
export const useProjectFileDropStore = create<{
  pending: Readonly<Record<string, readonly File[]>>;
  queue: (target: FileDropTarget, files: readonly File[]) => number;
  take: (target: FileDropTarget) => File[];
}>((set, get) => ({
  pending: {},
  queue: (target, files) => {
    const key = fileDropTargetKey(target);
    const previous = get().pending[key] ?? [];
    const accepted = files.slice(0, Math.max(0, 8 - previous.length));
    set((state) => ({ pending: { ...state.pending, [key]: [...previous, ...accepted] } }));
    return files.length - accepted.length;
  },
  take: (target) => {
    const key = fileDropTargetKey(target);
    const files = [...(get().pending[key] ?? [])];
    set((state) => {
      const pending = { ...state.pending };
      delete pending[key];
      return { pending };
    });
    return files;
  },
}));
