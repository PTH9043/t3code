export type MobileStageLabel = "개발" | "나이틀리" | "알파";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "개발";
  if (appVariant === "preview") return "나이틀리";
  return "알파";
}
