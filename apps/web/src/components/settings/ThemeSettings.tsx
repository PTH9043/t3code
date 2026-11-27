import {
  CopyIcon,
  DownloadIcon,
  PenLineIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import {
  getThemeDefinition,
  getThemeModes,
  removeCustomTheme,
  serializeThemeFile,
  type ThemeAppearance,
  type ThemeDefinition,
  type ThemeHalves,
  T3_CHAT_THEME,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
} from "../../themePalette";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { ThemeImportDialog } from "./ThemeImportDialog";
import { useThemeEditorStore } from "./themeEditorStore";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  previewColorsOf,
  ThemePreviewCircles,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";
import { ThemeWireframe } from "./ThemeWireframe";

const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = [
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
];

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers; give the
  // browser time to open the stream first.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function ThemeLibraryCard({
  theme,
  isActive,
  onUse,
  onUseMode,
  activeModes,
  onEdit,
  onDuplicate,
  onDownload,
  onRemove,
}: {
  theme: ThemeCardDefinition;
  isActive: boolean;
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
  activeModes: ReadonlyArray<ThemeMode>;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
}) {
  // A one-appearance theme can only take its own side of the mix, so the card
  // tooltip promises exactly what clicking it does.
  const cardModes = theme.previews.map((preview) => preview.mode);
  return (
    // The card surface stays a plain div (buttons cannot nest inside a button
    // role); the title button and mode circles carry the accessible actions,
    // while the card click is a pointer-only convenience.
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:bg-accent/10",
              isActive && "bg-accent/30",
            )}
            data-theme-library-card={theme.id}
            onClick={onUse}
            style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
          >
            <ThemePreviewCircles
              label={theme.label}
              activeModes={activeModes}
              onSelectMode={onUseMode}
              previews={theme.previews}
            />
            <div className="flex items-center gap-2 px-3 pb-3 pt-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <button
                    aria-label={`${theme.label} 테마 사용${isActive ? ", 현재 사용 중" : ""}`}
                    aria-pressed={isActive}
                    className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onUse();
                    }}
                  >
                    {theme.label}
                  </button>
                </div>
              </div>
              {onEdit || onDuplicate || onDownload || onRemove ? (
                <div className="flex shrink-0 items-center gap-1">
                  {onDuplicate ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`${theme.label} 복제`}
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDuplicate();
                            }}
                          >
                            <CopyIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>테마 복제</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onEdit ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`${theme.label} 편집`}
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onEdit();
                            }}
                          >
                            <PenLineIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>테마 편집</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onDownload ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`${theme.label} 내보내기`}
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDownload();
                            }}
                          >
                            <DownloadIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>테마 파일 내보내기</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onRemove ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`${theme.label} 제거`}
                            size="icon-xs"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={(event) => {
                              event.stopPropagation();
                              onRemove();
                            }}
                          >
                            <Trash2Icon />
                          </Button>
                        }
                      />
                      <TooltipPopup>테마 제거</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        }
      />
      <TooltipPopup>
        {cardModes.length > 1
          ? "밝은 모드와 어두운 모드 모두에 사용"
          : `${cardModes[0] === "light" ? "밝은" : "어두운"} 모드에만 사용`}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ThemeLibrary({
  theme,
  setTheme,
  appearanceMode,
  setAppearanceMode,
  customThemes,
  initialAppearance,
  refreshTheme,
  isImportOpen,
  onImportOpenChange,
  themeHalves,
  setThemeHalf,
}: {
  theme: string;
  setTheme: (theme: string) => boolean;
  appearanceMode: ThemeMode;
  setAppearanceMode: (mode: ThemeMode) => boolean;
  customThemes: ReadonlyArray<ThemeDefinition>;
  initialAppearance: ThemeAppearance;
  refreshTheme: () => void;
  isImportOpen: boolean;
  onImportOpenChange: (open: boolean) => void;
  themeHalves: ThemeHalves | null;
  setThemeHalf: (appearance: ThemeAppearance, themeId: string | null) => boolean;
}) {
  const openThemeEditor = useThemeEditorStore((store) => store.openThemeEditor);
  const [themeToRemove, setThemeToRemove] = useState<ThemeDefinition | null>(null);
  // Keep the last removal target so the dialog title stays populated while the
  // close animation plays after confirming.
  const lastThemeToRemoveRef = useRef<ThemeDefinition | null>(null);
  useEffect(() => {
    if (themeToRemove) lastThemeToRemoveRef.current = themeToRemove;
  }, [themeToRemove]);
  const removeDialogTheme = themeToRemove ?? lastThemeToRemoveRef.current;

  const notifyThemeSaveFailure = useCallback(() => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "테마 선택을 저장하지 못했습니다",
        description: "다시 시도해 주세요.",
      }),
    );
  }, []);

  const notifyThemeRemovalFailure = useCallback(() => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "테마를 제거하지 못했습니다",
        description: "다시 시도해 주세요.",
      }),
    );
  }, []);

  const persistTheme = useCallback(
    (nextTheme: string) => {
      const didSave = setTheme(nextTheme);
      if (!didSave) notifyThemeSaveFailure();
      return didSave;
    },
    [notifyThemeSaveFailure, setTheme],
  );

  const handleRemoveTheme = useCallback((customTheme: ThemeDefinition) => {
    setThemeToRemove(customTheme);
  }, []);

  const handleConfirmRemoveTheme = useCallback(() => {
    if (!themeToRemove) return;
    const removesBase = getThemeDefinition(theme)?.id === themeToRemove.id;
    // Keep the theme installed if we cannot move the selection off it; the
    // dialog stays open so the user can retry or cancel.
    if (removesBase && !persistTheme(appearanceMode === "system" ? "system" : appearanceMode)) {
      return;
    }
    for (const appearance of ["light", "dark"] as const) {
      const half = themeHalves?.[appearance];
      if (half === undefined) continue;
      // Writing a base preference clears the whole mix, so halves that name a
      // surviving theme are written back; halves on the removed theme fall
      // back to the base.
      const next = half === themeToRemove.id ? null : removesBase ? half : undefined;
      if (next !== undefined && !setThemeHalf(appearance, next)) {
        notifyThemeRemovalFailure();
        return;
      }
    }
    try {
      removeCustomTheme(themeToRemove.id);
    } catch {
      notifyThemeRemovalFailure();
      return;
    }
    setThemeToRemove(null);
  }, [
    appearanceMode,
    notifyThemeRemovalFailure,
    persistTheme,
    setThemeHalf,
    theme,
    themeHalves,
    themeToRemove,
  ]);

  // ----- Automatic-mode mixing -------------------------------------------
  // The pair model: one theme owns light, one owns dark, and the global
  // appearance mode (light / dark / auto) decides which is showing.
  const baseCardId = getThemeDefinition(theme)?.id ?? null;
  const lightOwner = themeHalves?.light ?? baseCardId;
  const darkOwner = themeHalves?.dark ?? baseCardId;

  const assignHalf = useCallback(
    (appearance: ThemeAppearance, cardId: string | null) => {
      const otherAppearance = appearance === "light" ? "dark" : "light";
      // Picking the default over a themed base cannot be stored as a half:
      // the base would still own that appearance. Convert the base into an
      // explicit half on the other side so this side falls back to default.
      if (cardId === null && baseCardId !== null) {
        const otherOwner = themeHalves?.[otherAppearance] ?? baseCardId;
        if (!persistTheme(appearanceMode === "system" ? "system" : appearanceMode)) return;
        if (!setThemeHalf(otherAppearance, otherOwner)) {
          // Best-effort rollback: restore the whole-theme selection rather
          // than leaving the user with no theme at all.
          setTheme(theme);
          notifyThemeSaveFailure();
        }
        return;
      }
      if (!setThemeHalf(appearance, cardId)) {
        notifyThemeSaveFailure();
      }
    },
    [
      appearanceMode,
      baseCardId,
      notifyThemeSaveFailure,
      persistTheme,
      setTheme,
      setThemeHalf,
      theme,
      themeHalves,
    ],
  );

  // "Create theme" starts from whatever is on screen for the appearance being
  // edited, so tuning the theme you already use never means rebuilding it.
  const activeThemeForAppearance =
    getThemeDefinition((initialAppearance === "light" ? lightOwner : darkOwner) ?? "") ?? null;

  const cardDefById = (id: string | null): ThemeCardDefinition => {
    if (id === null) return STANDARD_THEME_CARDS[0]!;
    const definition = getThemeDefinition(id);
    return definition ? getThemeCardDefinition(definition) : STANDARD_THEME_CARDS[0]!;
  };

  const pickColors = (id: string | null, appearance: ThemeAppearance) => {
    const card = cardDefById(id);
    return previewColorsOf(card, appearance) ?? card.previews[0]!.colors;
  };

  const setMode = (mode: ThemeMode) => {
    if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
  };

  // ----- Wireframe tiles on top, two-ball cards below --------------------
  const handlePairPick = (cardId: string | null) => (mode: ThemeMode) => {
    if (mode === "system") return;
    assignHalf(mode, cardId);
  };

  // Rings always show the effective owner of each appearance: an unpicked
  // half belongs to the default card (a null owner), so a fresh install
  // shows T3 Code selected instead of nothing.
  const pickedModesFor = (cardId: string | null): ThemeMode[] => {
    const rings: ThemeMode[] = [];
    if (lightOwner === cardId) rings.push("light");
    if (darkOwner === cardId) rings.push("dark");
    return rings;
  };

  const wireframeColors = (appearance: ThemeAppearance) =>
    pickColors(appearance === "light" ? lightOwner : darkOwner, appearance);

  const renderWireframe = (mode: ThemeMode) => (
    <ThemeWireframe
      className="h-[8.75rem]"
      panes={
        mode === "system"
          ? [
              { clip: "left", colors: wireframeColors("light") },
              { clip: "right", colors: wireframeColors("dark") },
            ]
          : [{ colors: wireframeColors(mode === "dark" ? "dark" : "light") }]
      }
    />
  );

  const renderModeTiles = () => (
    <div
      aria-label="화면 모드"
      className="mx-auto grid w-full max-w-[56rem] grid-cols-3 gap-3 px-3 sm:px-4"
      role="group"
    >
      {(["system", "light", "dark"] as const).map((mode) => {
        const isActive = appearanceMode === mode;
        return (
          <button
            aria-label={
              mode === "system"
                ? "시스템 화면 설정 따르기"
                : `${mode === "light" ? "밝은" : "어두운"} 모드 사용`
            }
            aria-pressed={isActive}
            className={cn(
              "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "border-transparent bg-accent/30"
                : "border-border/70 bg-card/60 hover:bg-accent/10",
            )}
            key={mode}
            style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
            onClick={() => setMode(mode)}
            type="button"
          >
            {renderWireframe(mode)}
            <span
              className={cn(
                "flex items-center justify-center text-xs font-medium",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {mode === "system" ? "시스템" : mode === "light" ? "밝게" : "어둡게"}
            </span>
          </button>
        );
      })}
    </div>
  );

  const renderPairGrid = () => (
    // One shared provider so every tooltip in the grid hands off instantly to
    // the next hovered trigger instead of stacking on top of it. The card
    // tooltip briefly showing while crossing between a card's two circles is
    // accepted — scoping the group tighter makes the handoffs feel sluggish.
    <TooltipProvider>
      <div
        className="mx-auto grid w-full max-w-[56rem] gap-2 px-3 sm:px-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17rem), 1fr))" }}
      >
        {STANDARD_THEME_CARDS.map((standardTheme) => (
          <ThemeLibraryCard
            activeModes={pickedModesFor(null)}
            isActive={false}
            key={standardTheme.id}
            onUse={() => persistTheme(appearanceMode === "system" ? "system" : appearanceMode)}
            onUseMode={handlePairPick(null)}
            theme={standardTheme}
          />
        ))}
        {MAINTAINER_THEMES.map((maintainerTheme) => {
          const card = getThemeCardDefinition(maintainerTheme);
          return (
            <ThemeLibraryCard
              activeModes={pickedModesFor(maintainerTheme.id)}
              isActive={false}
              key={maintainerTheme.id}
              onDuplicate={() =>
                openThemeEditor({
                  editingThemeId: null,
                  seedThemeId: maintainerTheme.id,
                  seedName: `${maintainerTheme.label} 복사본`,
                  initialAppearance,
                })
              }
              onUse={() => persistTheme(maintainerTheme.id)}
              onUseMode={handlePairPick(maintainerTheme.id)}
              theme={card}
            />
          );
        })}
        {customThemes.map((customTheme) => {
          const card = getThemeCardDefinition(customTheme);
          return (
            <ThemeLibraryCard
              activeModes={pickedModesFor(customTheme.id)}
              isActive={false}
              key={customTheme.id}
              onDuplicate={() =>
                openThemeEditor({
                  editingThemeId: null,
                  seedThemeId: customTheme.id,
                  seedName: `${customTheme.label} 복사본`,
                  initialAppearance,
                })
              }
              onEdit={() =>
                openThemeEditor({
                  editingThemeId: customTheme.id,
                  seedThemeId: null,
                  seedName: null,
                  initialAppearance,
                })
              }
              onDownload={() =>
                downloadThemeFile(`${customTheme.id}.json`, serializeThemeFile(customTheme))
              }
              onRemove={() => handleRemoveTheme(customTheme)}
              onUse={() => {
                const modes = getThemeModes(customTheme);
                if (modes.length === 1) assignHalf(modes[0]!, customTheme.id);
                else persistTheme(customTheme.id);
              }}
              onUseMode={handlePairPick(customTheme.id)}
              theme={card}
            />
          );
        })}
      </div>
    </TooltipProvider>
  );

  return (
    <div className="space-y-3">
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        T3 Code의 화면 스타일을 선택하세요. 기본 테마를 사용하거나 직접 만들 수 있습니다.
      </p>
      <div
        aria-label="시맨틱 상태 색상 분리 기준"
        className="mx-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card/70 px-3 py-2 text-xs sm:mx-4"
      >
        <span className="mr-1 font-medium text-muted-foreground">고정 상태 배지</span>
        <span
          className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
          style={{
            backgroundColor: "var(--status-danger-surface)",
            borderColor: "var(--status-danger-border)",
            color: "var(--status-danger-fg)",
          }}
        >
          오류
        </span>
        <span
          className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
          style={{
            backgroundColor: "var(--status-warning-surface)",
            borderColor: "var(--status-warning-border)",
            color: "var(--status-warning-fg)",
          }}
        >
          경고
        </span>
        <span
          className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
          style={{
            backgroundColor: "var(--status-success-surface)",
            borderColor: "var(--status-success-border)",
            color: "var(--status-success-fg)",
          }}
        >
          성공
        </span>
        <span
          className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
          style={{
            backgroundColor: "var(--status-info-surface)",
            borderColor: "var(--status-info-border)",
            color: "var(--status-info-fg)",
          }}
        >
          정보
        </span>
        <span className="text-[11px] text-muted-foreground">
          모든 테마에서 브랜드 색상과 분리되어 고정 대비를 유지합니다.
        </span>
      </div>
      <h3 className="px-3 text-sm font-medium tracking-[-0.005em] text-foreground sm:px-4">
        색상 모드
      </h3>
      {renderModeTiles()}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 px-3 pt-2 sm:px-4">
        <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">테마</h3>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button
            className="h-7 rounded-md border border-border/70 bg-muted/30 px-2 text-xs font-medium text-foreground shadow-none hover:bg-accent/40"
            size="xs"
            variant="ghost"
            onClick={() =>
              openThemeEditor({
                editingThemeId: null,
                seedThemeId: activeThemeForAppearance?.id ?? null,
                seedName: null,
                initialAppearance,
              })
            }
          >
            <PlusIcon />
            테마 만들기
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onImportOpenChange(true)}>
            <UploadIcon />
            테마 가져오기
          </Button>
        </div>
      </div>
      {renderPairGrid()}
      <ThemeImportDialog
        onImportedMany={(importedThemes, { updated }) => {
          // An updated theme that is showing (as the base or either half)
          // needs its palette re-applied.
          if (
            updated &&
            importedThemes.some(
              (imported) =>
                getThemeDefinition(theme)?.id === imported.id ||
                themeHalves?.light === imported.id ||
                themeHalves?.dark === imported.id,
            )
          ) {
            refreshTheme();
          }
          const verb = updated ? "업데이트됨" : "추가됨";
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title:
                importedThemes.length === 1
                  ? `${importedThemes[0]!.label} ${verb}`
                  : `테마 ${importedThemes.length}개 ${verb}`,
              description: importedThemes.map((imported) => imported.label).join(", "),
            }),
          );
        }}
        onImported={(importedTheme) => {
          // Same rule as clicking the card: a one-appearance theme takes its
          // side of the mix instead of becoming the base for both.
          const modes = getThemeModes(importedTheme);
          if (modes.length === 1) {
            assignHalf(modes[0]!, importedTheme.id);
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: `${importedTheme.label} 추가됨`,
                description: `${modes[0] === "light" ? "밝은" : "어두운"} 모드 테마로 설정했습니다.`,
              }),
            );
            return true;
          }
          if (!persistTheme(importedTheme.id)) return false;
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${importedTheme.label} 추가됨`,
              description: "현재 테마로 설정했습니다.",
            }),
          );
          return true;
        }}
        onOpenChange={onImportOpenChange}
        open={isImportOpen}
      />
      <AlertDialog
        open={themeToRemove !== null}
        onOpenChange={(open) => {
          if (!open) setThemeToRemove(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>“{removeDialogTheme?.label}” 테마를 제거할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              JSON 파일을 다시 가져오면 언제든 복원할 수 있습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>취소</AlertDialogClose>
            <Button variant="destructive" onClick={handleConfirmRemoveTheme}>
              테마 제거
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
