export const FILE_DROP_PROJECT_TARGET = "[data-file-drop-project][data-file-drop-environment]";
export const FILE_DROP_CHAT_TARGET = "[data-chat-file-drop-zone]";
export const NATIVE_FILES_EVENT = "t3:native-files";

/** Deliver to the visible chat first; an unmounted or unavailable composer leaves the drop queued. */
export function deliverNativeFilesToChat(chat: Element, files: File[]): boolean {
  const event = new CustomEvent(NATIVE_FILES_EVENT, { detail: files, cancelable: true });
  chat.dispatchEvent(event);
  return event.defaultPrevented;
}

/** A hover tooltip may cover the drop point; blocking dialogs still own their input. */
export function nativeFileDropTargetAt(
  document: Pick<Document, "elementsFromPoint">,
  x: number,
  y: number,
): Element | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  const elements = document.elementsFromPoint(x, y);
  const modal = elements[0]?.closest('[role="dialog"][aria-modal="true"]');
  if (modal) return null;
  return (
    elements.find((element) =>
      element.closest(FILE_DROP_PROJECT_TARGET + "," + FILE_DROP_CHAT_TARGET),
    ) ?? null
  );
}
