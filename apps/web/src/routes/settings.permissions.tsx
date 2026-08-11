import { createFileRoute } from "@tanstack/react-router";

import { PermissionsSettingsPanel } from "../components/settings/PermissionsSettings";

function SettingsPermissionsRoute() {
  return <PermissionsSettingsPanel />;
}

export const Route = createFileRoute("/settings/permissions")({
  component: SettingsPermissionsRoute,
});
