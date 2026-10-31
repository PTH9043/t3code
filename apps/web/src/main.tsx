import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasClerkPublicConfig, hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// React's dev build emits a performance.measure() per committed fiber and Blink never reclaims those
// entries, so a long-lived desktop session grows non-V8 renderer memory until Chromium OOMs it.
// Production React compiles the track out.
if (import.meta.env.DEV && typeof performance !== "undefined") {
  window.setInterval(() => {
    performance.clearMeasures();
    performance.clearMarks();
  }, 30_000);
}

const app = <AppRoot router={router} />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey && hasClerkPublicConfig() ? (
      isElectron ? (
        <ElectronClerkProvider publishableKey={clerkPublishableKey} passkeys={passkeys}>
          {hasCloudPublicConfig() ? (
            <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
          ) : (
            app
          )}
        </ElectronClerkProvider>
      ) : (
        <ClerkProvider publishableKey={clerkPublishableKey}>
          {hasCloudPublicConfig() ? (
            <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
          ) : (
            app
          )}
        </ClerkProvider>
      )
    ) : (
      app
    )}
  </React.StrictMode>,
);
