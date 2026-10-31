import { useEffect, useRef, useState, type ReactNode } from "react";
import { NATIVE_FILES_EVENT } from "../../lib/nativeFileDrop";

export function ComposerFileDropZone(props: {
  children: ReactNode;
  onFiles: (files: File[]) => boolean | void;
}) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const receive = (event: Event) => {
      const files: unknown = (event as CustomEvent<unknown>).detail;
      if (!Array.isArray(files) || !files.every((file) => file instanceof File)) return;
      if (props.onFiles(files) !== false) event.preventDefault();
    };
    element.addEventListener(NATIVE_FILES_EVENT, receive);
    return () => element.removeEventListener(NATIVE_FILES_EVENT, receive);
  }, [props.onFiles]);
  useEffect(() => {
    if (!active) return;
    const reset = () => {
      depth.current = 0;
      setActive(false);
    };
    window.addEventListener("dragend", reset);
    return () => window.removeEventListener("dragend", reset);
  }, [active]);
  return (
    <div
      ref={container}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      data-chat-file-drop-zone="true"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        depth.current += 1;
        setActive(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        depth.current = 0;
        setActive(false);
        if (event.defaultPrevented) return;
        event.preventDefault();
        props.onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {props.children}
      {active && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-primary bg-background/80">
          <span className="rounded-xl bg-background px-5 py-3 text-sm font-medium shadow-sm">
            파일을 놓으면 대화에 첨부됩니다 · 최대 8개
          </span>
        </div>
      )}
    </div>
  );
}
