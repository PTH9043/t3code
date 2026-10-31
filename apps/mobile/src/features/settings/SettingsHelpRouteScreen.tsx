import { useNavigation } from "@react-navigation/native";
import { AI_HELP_HTML, parseAiHelpMessage } from "@t3tools/shared/aiHelp";
import * as Clipboard from "expo-clipboard";
import { useRef } from "react";
import { Linking, Pressable, View } from "react-native";
import { WebView } from "react-native-webview";

import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";

export function SettingsHelpCloseHeaderButton() {
  const navigation = useNavigation();
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityLabel="AI 사용 도움말 닫기"
      accessibilityRole="button"
      hitSlop={12}
      onPress={() => navigation.goBack()}
      className="p-2 active:opacity-60"
    >
      <SymbolView
        name="xmark"
        size={18}
        tintColor={iconColor}
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}

export function SettingsHelpRouteScreen() {
  const navigation = useNavigation();
  const frame = useRef<WebView>(null);

  return (
    <View className="flex-1 bg-sheet">
      <WebView
        ref={frame}
        source={{ html: AI_HELP_HTML }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled={false}
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        setSupportMultipleWindows={false}
        onMessage={(event) => {
          const message = parseAiHelpMessage(event.nativeEvent.data);
          if (message?.action === "close") navigation.goBack();
          if (message?.action === "open-link")
            void Linking.openURL(message.url).catch(() => undefined);
          if (message?.action === "copy") {
            const sender = frame.current;
            const reply = (success: boolean) => {
              if (frame.current !== sender) return;
              sender?.injectJavaScript(
                `window.aiHelpResult(${message.requestId}, ${success}); true;`,
              );
            };
            void Clipboard.setStringAsync(message.text).then(
              () => reply(true),
              () => reply(false),
            );
          }
        }}
        onShouldStartLoadWithRequest={(request) => {
          if (request.url === "about:blank" || request.url.startsWith("about:blank#")) return true;
          const message = parseAiHelpMessage({
            channel: "t3-ai-help",
            action: "open-link",
            url: request.url,
          });
          if (message?.action === "open-link")
            void Linking.openURL(message.url).catch(() => undefined);
          return false;
        }}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
