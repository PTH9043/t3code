export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Finder에서 보기";
  if (normalized.includes("win")) return "파일 탐색기에서 보기";
  return "파일 앱에서 보기";
}
