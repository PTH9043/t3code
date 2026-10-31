import { isDesktopDirectPrimary } from "./target";

let desktopBearerTokenPromise: Promise<string> | null = null;

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }
  if (isDesktopDirectPrimary()) {
    return Promise.resolve(null);
  }

  if (!desktopBearerTokenPromise) {
    const pending = bridge.getLocalEnvironmentBearerToken().catch((error) => {
      if (desktopBearerTokenPromise === pending) desktopBearerTokenPromise = null;
      throw error;
    });
    desktopBearerTokenPromise = pending;
  }
  return desktopBearerTokenPromise;
}

export function resetDesktopPrimaryBearerToken(): void {
  desktopBearerTokenPromise = null;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  resetDesktopPrimaryBearerToken();
}
