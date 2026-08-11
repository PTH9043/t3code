import { createFileRoute } from "@tanstack/react-router";

import { ControlCenterOverview } from "~/components/control-center/ControlCenterOverview";

export const Route = createFileRoute("/control-center/")({
  component: ControlCenterOverview,
});
