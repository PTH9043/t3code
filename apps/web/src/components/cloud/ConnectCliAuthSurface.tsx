import { useAuth, useClerk, useUser } from "@clerk/react";
import { encodeConnectAuthCode, readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useEffect, useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  readConnectCliAuthState,
  readConnectCliCallbackResult,
  rememberConnectCliAuthState,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";

function ConnectCliAuthMessage({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <>
      {eyebrow ? (
        <p className="text-[10px] font-semibold tracking-[0.18em] text-blue-600 uppercase dark:text-blue-400">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

const invalidLinkMessage = {
  eyebrow: "승인 요청",
  title: "연결 링크가 완전하지 않습니다",
  description:
    "링크에 승인 요청 정보가 없습니다. 터미널에서 `t3 connect`를 다시 실행한 뒤 새로 표시된 URL을 여세요.",
} as const;

/**
 * /connect: the URL a headless CLI prints. Waits for a Clerk session, then
 * forwards the CLI's PKCE request to Clerk's authorize endpoint.
 */
export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  useEffect(() => {
    if (!request || !isLoaded || redirecting.current) {
      return;
    }
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
      }
      return;
    }
    const authorizeUrl = buildConnectCliClerkAuthorizeUrl(request);
    if (!authorizeUrl) {
      return;
    }
    redirecting.current = true;
    rememberConnectCliAuthState(request.state);
    window.location.assign(authorizeUrl);
  }, [clerk, isLoaded, isSignedIn, request]);

  if (!request) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage {...invalidLinkMessage} />
      </AuthSurfaceShell>
    );
  }

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="1/2단계 · 브라우저 승인"
        title="터미널 연결 중"
        description={
          isSignedIn
            ? "CLI의 T3 Connect 승인을 위해 이동하고 있습니다…"
            : "CLI에서 T3 Connect를 계속 승인하려면 로그인하세요."
        }
      />
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button
            type="button"
            onClick={() =>
              clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron))
            }
          >
            로그인
          </Button>
        </div>
      ) : null}
    </AuthSurfaceShell>
  );
}

/**
 * /connect/callback: Clerk's redirect target. Shows the one-time code the
 * user enters in the waiting terminal.
 */
export function ConnectCliCallbackSurface() {
  const [result] = useState(readConnectCliCallbackResult);
  const [expectedState] = useState(readConnectCliAuthState);
  const { user } = useUser();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "승인 코드" });

  if (!result) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow="2/2단계 · 터미널 전달"
          title="승인이 완료되지 않았습니다"
          description="승인 코드가 반환되지 않았습니다. 터미널에서 `t3 connect`를 다시 실행한 뒤 다시 시도하세요."
        />
      </AuthSurfaceShell>
    );
  }

  // Fail closed: the legitimate callback always lands in the same browser
  // that visited /connect (which recorded the state), so a missing or
  // mismatched state means this page was reached some other way — the CSRF
  // shape the state parameter exists to stop. Refuse to display a code.
  if (expectedState === null || expectedState !== result.state) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow="2/2단계 · 터미널 전달"
          title="다른 요청에 속한 코드입니다"
          description="이 승인 응답은 이 브라우저에서 시작한 연결 요청과 일치하지 않습니다. 터미널에서 `t3 connect`를 다시 실행하고 새로 표시된 URL을 이 브라우저에서 여세요."
        />
      </AuthSurfaceShell>
    );
  }

  const accountLabel = user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;
  const authCode = encodeConnectAuthCode(result);

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="2/2단계 · 터미널 전달"
        title="연결이 거의 완료되었습니다"
        description={
          accountLabel
            ? `대기 중인 터미널에 이 코드를 입력해 ${accountLabel} 계정으로 연결하세요.`
            : "연결을 마치려면 대기 중인 터미널에 이 코드를 입력하세요."
        }
      />

      <div className="mt-6 overflow-hidden rounded-xl border border-border/80 bg-background/65">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            일회용 승인 코드
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">곧 만료됨</span>
        </div>
        <code
          className="block p-4 font-mono text-sm leading-relaxed break-all select-all"
          data-testid="connect-auth-code"
        >
          {authCode}
        </code>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button type="button" onClick={() => copyToClipboard(authCode)}>
          {isCopied ? "복사됨" : "승인 코드 복사"}
        </Button>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        직접 시작한 터미널 세션에만 이 코드를 입력하세요. 코드가 유효한 동안 이를 가진 사람은 자신의
        컴퓨터를 사용자의 T3 Connect 계정에 연결할 수 있습니다.
      </p>
    </AuthSurfaceShell>
  );
}
