import { useCallback, useEffect, useSyncExternalStore } from "react";

export const UI_SCALE_STORAGE_KEY = "newautousage:ui-scale";
export const UI_SCALE_DEFAULT = 100;
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 150;
export const UI_SCALE_STEP = 10;

let cachedScale: number | null = null;
const listeners = new Set<() => void>();

export function normalizeUiScale(value: unknown): number {
  if (value === null || value === undefined || value === "") return UI_SCALE_DEFAULT;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return UI_SCALE_DEFAULT;
  const stepped = Math.round(numeric / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped));
}

function readUiScale(): number {
  if (typeof window === "undefined") return UI_SCALE_DEFAULT;
  try {
    return normalizeUiScale(window.localStorage.getItem(UI_SCALE_STORAGE_KEY));
  } catch {
    return UI_SCALE_DEFAULT;
  }
}

function applyUiScale(scale: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.fontSize = `${scale}%`;
  document.documentElement.dataset.uiScale = String(scale);
}

function getSnapshot(): number {
  cachedScale ??= readUiScale();
  return cachedScale;
}

function getServerSnapshot(): number {
  return UI_SCALE_DEFAULT;
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") return () => listeners.delete(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== UI_SCALE_STORAGE_KEY) return;
    cachedScale = readUiScale();
    applyUiScale(cachedScale);
    emitChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function persistUiScale(next: number): void {
  cachedScale = normalizeUiScale(next);
  try {
    window.localStorage.setItem(UI_SCALE_STORAGE_KEY, String(cachedScale));
  } catch {
    // The live setting still works when persistence is unavailable.
  }
  applyUiScale(cachedScale);
  emitChange();
}

export function useUiScale() {
  const scale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    applyUiScale(scale);
  }, [scale]);

  const setScale = useCallback((next: number) => persistUiScale(next), []);
  const decrease = useCallback(() => persistUiScale(getSnapshot() - UI_SCALE_STEP), []);
  const increase = useCallback(() => persistUiScale(getSnapshot() + UI_SCALE_STEP), []);
  const reset = useCallback(() => persistUiScale(UI_SCALE_DEFAULT), []);

  return {
    scale,
    setScale,
    decrease,
    increase,
    reset,
    canDecrease: scale > UI_SCALE_MIN,
    canIncrease: scale < UI_SCALE_MAX,
  } as const;
}
