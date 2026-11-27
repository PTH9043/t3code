import { useAtomValue } from "@effect/atom-react";
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Pressable, View } from "react-native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { buildToolActivityFacts } from "@t3tools/shared/toolActivity";
import {
  makeThreadActivitySummaryReader,
  toolEvidenceLabel,
  toolPhaseLabel,
  type PresentedToolWork,
} from "@t3tools/client-runtime/state/thread-tool-activity";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/AppText";

const summarize = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: WS_METHODS.serverSummarizeToolActivity,
  label: "mobile:tool-activity-summary",
});
const MayRead = createContext(false);
const SummaryReader = createContext<ReturnType<typeof makeThreadActivitySummaryReader> | null>(
  null,
);
export function MobileToolActivityProvider({
  environmentId,
  threadId,
  children,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  children: ReactNode;
}) {
  const session = Option.getOrNull(
    AsyncResult.value(useAtomValue(environmentSession.sessionStateAtom(environmentId))),
  );
  const run = useAtomCommand(summarize, { reportFailure: false });
  const allowed =
    session?.authenticated === true && session.scopes?.includes(AuthOrchestrationOperateScope);
  const reader = useMemo(
    () =>
      allowed
        ? makeThreadActivitySummaryReader(threadId, async (input) => {
            const result = await run({ environmentId, input });
            return result._tag === "Success" ? result.value : null;
          })
        : null,
    [allowed, environmentId, threadId, run],
  );
  return (
    <MayRead.Provider
      value={!!(session?.authenticated && session.scopes?.includes(AuthOrchestrationReadScope))}
    >
      <SummaryReader.Provider value={reader}>{children}</SummaryReader.Provider>
    </MayRead.Provider>
  );
}
export function MobileToolActivityDetail({
  row,
  technical,
}: {
  row: PresentedToolWork;
  technical?: (() => string | null) | undefined;
}) {
  const mayRead = useContext(MayRead);
  const readSummary = useContext(SummaryReader);
  const group = row.toolActivity;
  const hasRichPreview = Boolean(
    group?.preview?.intent ||
    group?.preview?.editSummary ||
    group?.preview?.outputSnippet ||
    group?.preview?.lineRange ||
    group?.preview?.searchQuery,
  );
  const request = group?.commandFailureNote || hasRichPreview ? null : readSummary;
  const [records, setRecords] = useState(false);
  const key = group ? JSON.stringify([group.id, buildToolActivityFacts([group])[0]]) : null;
  const load = useEffectEvent(() => (group ? request?.(group) : undefined));
  const [response, setResponse] = useState<{
    key: string;
    request: typeof request;
    summary?: string;
    model?: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (key && request)
      void load()?.then((value) => {
        if (active)
          setResponse({
            key,
            request,
            ...(value?.summary && value.model
              ? { summary: value.summary, model: value.model }
              : {}),
          });
      });
    return () => {
      active = false;
    };
  }, [key, request]);
  const answer = response?.key === key && response?.request === request ? response : null;
  const sources = group ? [group] : (row.unlinkedToolSignals ?? []);
  return (
    <View className="ml-3 gap-1 border-l border-neutral-300 pl-2">
      {group ? (
        <>
          <Text>{group.commandFailureNote ?? group.summary}</Text>
          {group.preview?.intent && <Text>작업 목적 · {group.preview.intent}</Text>}
          {group.preview?.commandSnippet && (
            <Text selectable className="font-mono text-2xs">
              {group.preview.commandSnippet}
            </Text>
          )}
          {group.preview?.editSummary?.excerpt && (
            <Text selectable className="font-mono text-2xs">
              핵심 변경 · {group.preview.editSummary.excerpt}
            </Text>
          )}
          {group.preview?.outputSnippet && (
            <Text selectable className="font-mono text-2xs">
              {group.preview.outputSnippet}
            </Text>
          )}
          <Text>작업자 · {group.executorLabel}</Text>
          <Text>근거 · {toolEvidenceLabel[group.evidence]}</Text>
          {group.targetPaths.length > 0 && (
            <Text selectable>작업 대상 · {group.targetPaths.join(", ")}</Text>
          )}
          {group.confirmedDiffPaths.length > 0 && (
            <Text selectable>확인된 변경 파일 · {group.confirmedDiffPaths.join(", ")}</Text>
          )}
          {request && !answer && <Text className="text-muted-foreground">로컬 설명 작성 중</Text>}
          {answer?.summary && (
            <>
              <Text>{answer.summary}</Text>
              <Text>요약자 · {answer.model}</Text>
            </>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: records }}
            onPress={() => setRecords((v) => !v)}
          >
            <Text>원본 기술 기록 {group.events.length}건</Text>
          </Pressable>
        </>
      ) : (
        <Text>종료된 턴에서 호출 ID가 없어 결과와 연결할 수 없는 시작·진행 기록입니다.</Text>
      )}
      {(records || !group) && mayRead && technical && <Text selectable>{technical()}</Text>}
      {(records || !group) &&
        sources.flatMap((g) =>
          g.events.map((e) => (
            <Text key={e.id} selectable>
              {new Date(e.createdAt).toLocaleTimeString()} · {e.kind} · {toolPhaseLabel[e.phase]}
              {e.exitCode !== undefined && ` · 종료 코드 ${e.exitCode}`}
            </Text>
          )),
        )}
    </View>
  );
}
