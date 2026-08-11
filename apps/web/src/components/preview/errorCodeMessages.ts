import { PREVIEW_ERROR_CODE_MESSAGES } from "./previewConstants";

/**
 * Resolve a friendly description for a Chromium / network error. Falls back
 * to the description string passed in when it isn't in our table.
 */
export function describePreviewError(description: string): string {
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[description];
  if (friendly) return friendly;
  if (description.length > 0) return "알 수 없는 네트워크 오류";
  return "네트워크 오류";
}
