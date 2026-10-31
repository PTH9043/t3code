import { PlusIcon } from "lucide-react";
import { useRef } from "react";
import { Button } from "../ui/button";

export function ComposerFilePicker(props: { disabled: boolean; onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        disabled={props.disabled}
        aria-label="첨부할 파일 선택"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          props.onFiles(files);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        disabled={props.disabled}
        aria-label="파일 첨부"
        title="파일 첨부 (파일당·합계 50MB, 최대 8개)"
        onClick={() => inputRef.current?.click()}
      >
        <PlusIcon />
      </Button>
    </>
  );
}
