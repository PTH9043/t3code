import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_SOURCE_BYTES,
} from "@t3tools/contracts";

/** Reserve source bytes before image compression so overlapping drops share one budget. */
export function selectComposerFiles(files: File[], existing: { count: number; bytes: number }) {
  const accepted: File[] = [];
  let count = existing.count;
  let bytes = existing.bytes;
  let error: string | null = null;
  for (const file of files) {
    const limit = file.type.startsWith("image/")
      ? PROVIDER_SEND_TURN_MAX_IMAGE_SOURCE_BYTES
      : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    if (file.size === 0) {
      error = `'${file.name}' 파일은 비어 있어 첨부할 수 없습니다.`;
    } else if (file.size > limit) {
      error = `'${file.name}' 파일은 50MB를 초과해 첨부할 수 없습니다.`;
    } else if (count >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `메시지 하나에 파일을 최대 ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}개까지 첨부할 수 있습니다.`;
      break;
    } else if (bytes + file.size > PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES) {
      error = `'${file.name}' 파일을 포함하면 첨부 합계 50MB를 초과합니다. 나누어 첨부하세요.`;
    } else {
      accepted.push(file);
      count += 1;
      bytes += file.size;
    }
  }
  return { files: accepted, reservedBytes: bytes - existing.bytes, error };
}
