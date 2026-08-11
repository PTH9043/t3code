import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useLinkTo } from "@react-navigation/native";

import {
  extractAgentNotificationTarget,
  routeAgentNotificationResponseOnce,
} from "./notificationPayload";
import {
  resolveActiveAgentNotificationScope,
  shouldPresentAgentNotification,
  type ActiveAgentNotificationScope,
} from "./notificationPresentation";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

let foregroundContext: {
  readonly activeScope: ActiveAgentNotificationScope | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
} = { activeScope: null, threads: [] };
let foregroundHandlerInstalled = false;

function installForegroundNotificationHandler(): void {
  if (foregroundHandlerInstalled) return;
  foregroundHandlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const shouldPresent = shouldPresentAgentNotification({
        target: extractAgentNotificationTarget(notification),
        activeScope: foregroundContext.activeScope,
        threads: foregroundContext.threads,
      });
      return {
        shouldShowBanner: shouldPresent,
        shouldShowList: shouldPresent,
        shouldPlaySound: shouldPresent,
        shouldSetBadge: false,
      };
    },
  });
}

export function useAgentNotificationNavigation(input: {
  readonly activeWorkspacePathname: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}): void {
  const linkTo = useLinkTo();
  const handledResponseIds = useRef(new Set<string>());

  useEffect(() => {
    installForegroundNotificationHandler();
    foregroundContext = {
      activeScope: resolveActiveAgentNotificationScope({
        pathname: input.activeWorkspacePathname,
        threads: input.threads,
      }),
      threads: input.threads,
    };
    return () => {
      foregroundContext = { activeScope: null, threads: [] };
    };
  }, [input.activeWorkspacePathname, input.threads]);

  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse): void => {
      routeAgentNotificationResponseOnce({
        handledResponseIds: handledResponseIds.current,
        response,
        navigate: linkTo,
      });
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void consumeLastAgentNotificationResponse({
      getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
      clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
      handleResponse,
    });

    return () => {
      subscription.remove();
    };
  }, [linkTo]);
}
