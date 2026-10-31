import { useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { WebView } from "react-native-webview";
import type { WorkspaceAutomationEvidence } from "@t3tools/contracts";
import {
  workspaceEvidenceBytes,
  workspaceEvidenceHtml,
  workspaceEvidenceText,
} from "@t3tools/shared/workspaceEvidence";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";

export function WorkspaceAutomationEvidencePreview({
  evidence,
}: {
  evidence: WorkspaceAutomationEvidence;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = workspaceEvidenceText(evidence.contents);
  const openFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const { File, Paths } = await import("expo-file-system");
      const sharing = await import("expo-sharing");
      if (!(await sharing.isAvailableAsync())) {
        setError("이 기기에서는 파일을 열 앱을 선택할 수 없습니다.");
        return;
      }
      const filename = /^[a-f0-9]{64}$/u.test(evidence.sha256 ?? "") ? evidence.sha256 : "document";
      const pdf = evidence.mediaType === "application/pdf";
      const file = new File(Paths.cache, `t3-evidence-${filename}.${pdf ? "pdf" : "txt"}`);
      file.create({ overwrite: true, intermediates: true });
      file.write(workspaceEvidenceBytes(evidence));
      await sharing.shareAsync(file.uri, {
        mimeType: pdf ? "application/pdf" : "text/plain",
        UTI: pdf ? "com.adobe.pdf" : "public.plain-text",
        dialogTitle: evidence.label,
      });
    } catch {
      setError("파일을 열지 못했습니다. 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="flex-1 gap-3">
      <Text className="text-xs text-foreground-muted">
        {evidence.byteLength.toLocaleString()}바이트{evidence.sha256 ? " · 검증 당시 저장본" : ""}
      </Text>
      {error ? <ErrorBanner message={error} /> : null}
      {evidence.mediaType?.startsWith("image/") ? (
        <Image
          source={{ uri: `data:${evidence.mediaType};base64,${evidence.contents}` }}
          resizeMode="contain"
          style={{ flex: 1, width: "100%" }}
          accessibilityLabel={evidence.label}
          onError={() => setError("이미지 미리보기를 표시하지 못했습니다.")}
        />
      ) : evidence.mediaType === "text/html" ? (
        <>
          <Text className="text-xs text-foreground-muted">
            읽기 전용 미리보기 · 스크립트와 외부 자료는 제한됩니다.
          </Text>
          <WebView
            source={{ html: workspaceEvidenceHtml(evidence.contents), baseUrl: "about:blank" }}
            originWhitelist={["about:blank"]}
            javaScriptEnabled={false}
            domStorageEnabled={false}
            mixedContentMode="never"
            allowFileAccess={false}
            onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
            onError={() => setError("HTML 미리보기를 표시하지 못했습니다.")}
            style={{ flex: 1 }}
          />
        </>
      ) : evidence.mediaType === "application/pdf" ? (
        <View className="gap-3">
          <Text className="text-sm text-foreground">
            PDF를 열 앱을 선택해 검증 결과물을 확인할 수 있습니다.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void openFile()}
            className="rounded-xl border border-border p-3"
          >
            <Text className="text-center text-primary">
              {busy ? "PDF를 준비하는 중…" : "PDF 열기·공유"}
            </Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView className="flex-1">
          <Text selectable className="text-xs text-foreground">
            {text.contents || "자료가 비어 있습니다."}
          </Text>
          {evidence.truncated ? (
            <Text className="mt-3 text-xs text-foreground-muted">
              앞 64 KiB 표시 · 전체 {evidence.byteLength.toLocaleString()}바이트
            </Text>
          ) : null}
          {text.shortened ? (
            <View className="mt-3 gap-2">
              <Text className="text-xs text-foreground-muted">
                긴 텍스트는 앞부분만 미리 봅니다.
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void openFile()}
                className="rounded-xl border border-border p-3"
              >
                <Text className="text-center text-primary">
                  {busy ? "파일을 준비하는 중…" : "텍스트 파일 열기·공유"}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
