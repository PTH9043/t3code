export interface ClerkAuthProps {
  forceRedirectUrl?: string;
}

export type ClerkSignInProps = ClerkAuthProps;

// Clerk's native-app allowlist only authorizes the bare renderer root
// (t3code://app/), which @clerk/electron's OAuth transport already supplies,
// so any page-derived redirect override gets the whole sign-in/sign-up request
// rejected. On Electron, omit the override and let Clerk use its defaults.
export function resolveClerkAuthProps(href: string, isElectron: boolean): ClerkAuthProps {
  if (isElectron) return {};
  return { forceRedirectUrl: href };
}

export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  return resolveClerkAuthProps(href, isElectron);
}
