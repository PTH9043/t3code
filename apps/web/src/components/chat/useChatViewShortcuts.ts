import type { ProjectScript, ResolvedKeybindingsConfig, ThreadId } from "@t3tools/contracts";
import { useEffect, type RefObject } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { preventRepeatedTerminalCloseShortcut } from "../../lib/terminalCloseShortcut";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { projectScriptIdFromCommand } from "../../projectScripts";
import type { RightPanelSurface } from "../../rightPanelStore";
import type { ChatComposerHandle } from "./ChatComposer";
import { shouldTypeToFocusComposer } from "./chatViewHelpers";

export interface UseChatViewShortcutsInput {
  readonly isForeground: boolean;
  readonly activeThreadId: ThreadId | null | undefined;
  readonly activeProject: { readonly scripts: ReadonlyArray<ProjectScript> } | null | undefined;
  readonly activeRightPanelSurface: RightPanelSurface | null | undefined;
  readonly terminalOpen: boolean;
  readonly activeTerminalId: string;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly toggleTerminalVisibility: () => void;
  readonly toggleRightPanel: () => void;
  readonly setTerminalOpen: (open: boolean) => void;
  readonly splitTerminal: (direction?: "horizontal" | "vertical") => void;
  readonly splitPanelTerminal: (direction?: "horizontal" | "vertical") => void;
  readonly closeTerminal: (terminalId: string) => void;
  readonly closePanelTerminal: (terminalId: string) => void;
  readonly createNewTerminal: () => void;
  readonly addTerminalSurface: () => void;
  readonly onToggleDiff: () => void;
  readonly runProjectScript: (script: ProjectScript) => unknown;
}

export function useChatViewShortcuts(input: UseChatViewShortcutsInput): void {
  const {
    isForeground,
    activeThreadId,
    activeProject,
    activeRightPanelSurface,
    terminalOpen,
    activeTerminalId,
    keybindings,
    composerRef,
    toggleTerminalVisibility,
    toggleRightPanel,
    setTerminalOpen,
    splitTerminal,
    splitPanelTerminal,
    closeTerminal,
    closePanelTerminal,
    createNewTerminal,
    addTerminalSurface,
    onToggleDiff,
    runProjectScript,
  } = input;

  useEffect(() => {
    if (!isForeground) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (preventRepeatedTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      if (!activeThreadId || isCommandPaletteOpen()) {
        return;
      }
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) {
        return;
      }
      const shortcutContext = {
        terminalFocus: terminalFocusOwner !== null,
        terminalOpen,
        modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      };

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event)
      ) {
        if (composerRef.current?.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanel();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal();
          return;
        }
        if (!terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.splitVertical") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal("vertical");
          return;
        }
        if (!terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal("vertical");
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
          closePanelTerminal(activeRightPanelSurface.activeTerminalId);
          return;
        }
        if (!terminalOpen) return;
        closeTerminal(activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          addTerminalSurface();
          return;
        }
        if (!terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        composerRef.current?.toggleModelPicker();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeProject,
    activeRightPanelSurface,
    addTerminalSurface,
    terminalOpen,
    activeTerminalId,
    activeThreadId,
    closeTerminal,
    closePanelTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    splitPanelTerminal,
    keybindings,
    isForeground,
    onToggleDiff,
    toggleRightPanel,
    toggleTerminalVisibility,
    composerRef,
  ]);
}
