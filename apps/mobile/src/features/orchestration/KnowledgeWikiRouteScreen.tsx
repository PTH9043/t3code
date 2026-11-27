import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ProjectId,
  WorkspaceKnowledgeItemId,
  ORCHESTRATION_WS_METHODS,
  type WorkspaceKnowledgeDashboardFilters,
} from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { connectionAtomRuntime } from "../../connection/runtime";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";

type Scope = { environmentId: string; projectId: string };
const dashboard = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeDashboard,
  label: "knowledge:mobile-list",
  idleTtlMs: 0,
});
const links = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.getWorkspaceWikiLinks,
  label: "knowledge:mobile-links",
  idleTtlMs: 0,
});
const pageSize = 25;
const pdfRevision = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.getPdfRevisionStatus,
  label: "knowledge:mobile-pdf-status",
  idleTtlMs: 0,
});

function Action({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="p-2"
    >
      <Text className={disabled ? "text-foreground-muted" : "text-primary"}>{title}</Text>
    </Pressable>
  );
}

export function KnowledgeWikiRouteScreen({ route }: StaticScreenProps<Scope>) {
  const navigation = useNavigation();
  const scope = route.params;
  const environmentId = EnvironmentId.make(scope.environmentId);
  const projectId = ProjectId.make(scope.projectId);
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState<WorkspaceKnowledgeDashboardFilters>({});
  const [offset, setOffset] = useState(0);
  const result = useEnvironmentQuery(
    dashboard({ environmentId, input: { projectId, ...filters, offset, limit: pageSize } }),
  );
  const data = result.data?.projectId === projectId ? result.data : null;
  function apply(next: WorkspaceKnowledgeDashboardFilters) {
    setDraft(next.query ?? "");
    setFilters(next);
    setOffset(0);
  }
  return (
    <FlatList
      className="flex-1 bg-screen"
      contentContainerClassName="gap-1 p-4"
      contentInsetAdjustmentBehavior="automatic"
      data={data?.matching.items ?? []}
      keyExtractor={(item) => item.id}
      refreshing={result.isPending}
      onRefresh={result.refresh}
      ListHeaderComponent={
        <View className="gap-2">
          <View className="flex-row items-center">
            <TextInput
              accessibilityLabel="지식 검색어"
              className="min-w-0 flex-1 rounded-lg border border-border p-2 text-foreground"
              value={draft}
              onChangeText={setDraft}
              placeholder="문서 검색"
              returnKeyType="search"
              onSubmitEditing={() => apply({ query: draft.trim() })}
            />
            <Action title="검색" onPress={() => apply({ query: draft.trim() })} />
            <Action title="전체" onPress={() => apply({})} />
          </View>
          {!!data?.savedSearches.length && (
            <View className="gap-1">
              <Text className="text-xs text-foreground-muted">저장된 검색</Text>
              <View className="flex-row flex-wrap">
                {data.savedSearches.map((search) => (
                  <Action
                    key={search.id}
                    title={search.name}
                    onPress={() => apply(search.filters)}
                  />
                ))}
              </View>
            </View>
          )}
          {result.error && <ErrorBanner message={result.error} />}
          {data && (
            <Text className="text-xs text-foreground-muted">
              문서 {data.matching.total.toLocaleString()}개
            </Text>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <Action
          title={item.title}
          onPress={() =>
            navigation.navigate("KnowledgeWikiDocument", { ...scope, itemId: item.id })
          }
        />
      )}
      ListEmptyComponent={
        <Text className="py-4 text-foreground-muted">
          {data ? "표시할 문서가 없습니다." : result.error ? "" : "지식을 불러오는 중…"}
        </Text>
      }
      ListFooterComponent={
        !!data && data.matching.total > pageSize ? (
          <View className="flex-row justify-between">
            <Action
              title="이전"
              disabled={offset === 0}
              onPress={() => setOffset(Math.max(0, offset - pageSize))}
            />
            <Text className="p-2 text-foreground-muted">
              {Math.floor(offset / pageSize) + 1} / {Math.ceil(data.matching.total / pageSize)}
            </Text>
            <Action
              title="다음"
              disabled={offset + pageSize >= data.matching.total}
              onPress={() => setOffset(offset + pageSize)}
            />
          </View>
        ) : null
      }
    />
  );
}

export function KnowledgeWikiDocumentScreen({
  route,
}: StaticScreenProps<Scope & { itemId: string }>) {
  const navigation = useNavigation();
  const { environmentId: environment, projectId: project, itemId: id } = route.params;
  const environmentId = EnvironmentId.make(environment);
  const projectId = ProjectId.make(project);
  const itemId = WorkspaceKnowledgeItemId.make(id);
  const args = { environmentId, input: { projectId, itemId } };
  const doc = useEnvironmentQuery(orchestrationEnvironment.workspaceKnowledge(args));
  const refs = useEnvironmentQuery(links(args));
  const item = doc.data?.items.find((x) => x.id === itemId && x.projectId === projectId);
  const pdfAttachment =
    item?.origin === "imported" &&
    item.kind === "rag-source" &&
    !item.sourceItemId &&
    item.tags.includes("pdf-page-batch")
      ? item.research?.attachment
      : undefined;
  const pdf = useEnvironmentQuery(pdfAttachment ? pdfRevision(args) : null);
  function open(target: string | null | undefined) {
    if (target && target !== id)
      navigation.dispatch(
        StackActions.push("KnowledgeWikiDocument", { ...route.params, itemId: target }),
      );
  }
  const outgoing = new Map(
    (refs.data?.outgoing ?? [])
      .filter((ref) => ref.targetItemId)
      .map((ref) => [ref.targetItemId, ref.targetTitle]),
  );
  const incoming = new Map(
    (refs.data?.backlinks ?? []).map((ref) => [ref.sourceItemId, ref.sourceTitle]),
  );
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: item?.title ?? "지식 문서" }} />
      {doc.error && <ErrorBanner message={doc.error} />}
      {item ? (
        <FileMarkdownPreview
          markdown={item.content}
          onRefresh={() => {
            doc.refresh();
            refs.refresh();
            if (pdfAttachment) pdf.refresh();
          }}
          footer={
            <View className="mt-4 gap-1 border-t border-border pt-3">
              {pdfAttachment && (
                <>
                  {pdf.error && <ErrorBanner message={pdf.error} />}
                  {pdf.data && (
                    <Text className="text-foreground">
                      PDF 공개 버전 {pdf.data.published.version}
                    </Text>
                  )}
                  {pdf.data?.pending && (
                    <Text className="text-foreground-muted">
                      버전 {pdf.data.pending.version}{" "}
                      {pdf.data.pending.status === "failed" ? "색인 실패" : "색인 중"} ·{" "}
                      {pdf.data.pending.lastPage}쪽 처리
                      {pdf.data.pending.totalPages > 0 &&
                        ` / 전체 ${pdf.data.pending.totalPages}쪽`}
                    </Text>
                  )}
                  {pdf.data?.pending?.error && <ErrorBanner message={pdf.data.pending.error} />}
                  <Action title="상태 새로고침" onPress={pdf.refresh} />
                  <Action
                    title="원본 대화 열기"
                    onPress={() =>
                      navigation.dispatch(
                        StackActions.push("Thread", {
                          environmentId: environment,
                          threadId: pdfAttachment.threadId,
                        }),
                      )
                    }
                  />
                </>
              )}
              {item.sourceItemId && (
                <Action title="편집 전 원본" onPress={() => open(item.sourceItemId)} />
              )}
              {item.supersededBy && (
                <Action title="대표 문서" onPress={() => open(item.supersededBy)} />
              )}
              {refs.error && <ErrorBanner message={refs.error} />}
              {outgoing.size > 0 && (
                <Text className="font-t3-semibold text-foreground">연결한 문서</Text>
              )}
              {Array.from(outgoing, ([target, title]) => (
                <Action key={target} title={title} onPress={() => open(target)} />
              ))}
              {incoming.size > 0 && (
                <Text className="font-t3-semibold text-foreground">이 문서를 참조하는 문서</Text>
              )}
              {Array.from(incoming, ([target, title]) => (
                <Action key={target} title={title} onPress={() => open(target)} />
              ))}
              {refs.data?.unresolved.map((ref) => (
                <Text key={ref.start} className="text-foreground-muted">
                  {ref.targetTitle} · 연결 미확정
                </Text>
              ))}
            </View>
          }
        />
      ) : (
        !doc.error && (
          <Text className="p-4 text-foreground-muted">
            {doc.data ? "이 프로젝트에서 문서를 찾을 수 없습니다." : "문서를 불러오는 중…"}
          </Text>
        )
      )}
    </View>
  );
}
