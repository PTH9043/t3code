export function isDownloadableDocument(path: string): boolean {
  return /\.(?:zip|7z|rar|tar|gz|bz2|xz|pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|tsv|txt|rtf|epub|png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|flac)$/i.test(
    path,
  );
}

/** Blob downloads also work in the desktop's custom origin without external navigation. */
export async function downloadFile(url: string, fileName: string): Promise<void> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`파일을 다운로드할 수 없습니다. (HTTP ${response.status})`);
  }
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the URL alive until the browser has started consuming the file.
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}
