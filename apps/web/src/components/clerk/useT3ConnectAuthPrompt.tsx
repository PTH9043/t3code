import { useClerk } from "@clerk/react";

import { isElectron } from "../../env";
import { resolveClerkAuthProps } from "./authRedirect";

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    clerk.openSignIn(resolveClerkAuthProps(window.location.href, isElectron));
  };
  const openSignUpPrompt = () => {
    clerk.openSignUp(resolveClerkAuthProps(window.location.href, isElectron));
  };
  return { authPrompt: null, openAuthPrompt, openSignUpPrompt };
}
