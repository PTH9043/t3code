import { create } from "zustand";

export const useAiHelpStore = create<{
  isOpen: boolean;
  setOpen: (isOpen: boolean) => void;
}>((set) => ({ isOpen: false, setOpen: (isOpen) => set({ isOpen }) }));

export function openAiHelp() {
  useAiHelpStore.getState().setOpen(true);
}
