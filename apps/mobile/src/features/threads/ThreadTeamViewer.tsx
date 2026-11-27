import { MobileToolActivityDetail, MobileToolActivityProvider } from "./MobileToolActivity";
import {
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerConfig,
  type ThreadTeamMember,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { StatusPill } from "../../components/StatusPill";
import { buildModelMenuActions, buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SheetActionButton } from "./git/gitSheetComponents";
import { ThreadResponseStyleSettings } from "./ThreadResponseStyleSettings";
import {
  confirmsRoomTeam,
  readRoomTeam,
  recordedAgents,
  sameTeam,
  teamRoleLabels,
  turnEvidence,
} from "./ThreadTeamViewer.logic";

interface SavedRoomProps {
  environmentId: EnvironmentId;
  thread: OrchestrationThreadShell;
  detail: OrchestrationThread | null;
  serverConfig: ServerConfig | null;
  connected: boolean;
  live: boolean;
  onClose: () => void;
}

interface DraftProps {
  selection: ModelSelection;
  members: readonly ThreadTeamMember[] | null;
  onSaveDraft: (members: readonly ThreadTeamMember[] | null) => Promise<void>;
  serverConfig: ServerConfig | null;
  onClose: () => void;
}

interface GlobalProps {
  global: true;
  environmentId: EnvironmentId;
  serverConfig: ServerConfig | null;
  connected: boolean;
  onClose: () => void;
}

export function ThreadTeamViewer(props: SavedRoomProps | DraftProps | GlobalProps) {
  const [openAction, setOpenAction] = useState<string | null>(null);
  const { serverConfig, onClose } = props;
  const room = "thread" in props ? props : null;
  const global = "global" in props;
  const thread = room?.thread;
  const detail = room?.detail;
  const selection = "selection" in props ? props.selection : room?.thread.modelSelection;
  const scope = selection && {
    answeringInstanceId: selection.instanceId,
    forModel: selection.model,
  };
  const settings = serverConfig?.settings ?? null;
  // A conversation or draft holds null while it follows the global team.
  const observed =
    "members" in props
      ? props.members
      : room
        ? readRoomTeam(settings, room.thread.id)
        : (settings?.globalSubordinateTeam ?? []);
  const defaults = settings?.globalSubordinateTeam ?? [];
  const [confirmed, setConfirmed] = useState<{
    before: readonly ThreadTeamMember[] | null;
    value: readonly ThreadTeamMember[] | null;
  } | null>(null);
  const saved = confirmed && sameTeam(confirmed.before, observed) ? confirmed.value : observed;
  useEffect(() => {
    if (confirmed && !sameTeam(confirmed.before, observed)) setConfirmed(null);
  }, [confirmed, observed]);
  type EditableMember = ThreadTeamMember & { rowKey: string };
  const [draft, setDraft] = useState<readonly EditableMember[] | null | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(!room);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const override = draft === undefined ? saved : draft;
  const nextRow = useRef(0);
  const members = draft ?? (override ?? defaults).map((m, i) => ({ ...m, rowKey: "saved-" + i }));
  const duplicate =
    new Set(members.map((m) => JSON.stringify([m.instanceId, m.model.toLowerCase(), m.role])))
      .size !== members.length;
  const ready =
    !pending &&
    (global
      ? props.connected && Array.isArray(settings?.globalSubordinateTeam)
      : !room ||
        (room.connected &&
          typeof settings?.threadSubordinateTeams === "object" &&
          settings.threadSubordinateTeams !== null));
  const edit = (value: readonly EditableMember[] | null) => {
    if (!ready || inFlight.current) return;
    setMessage(null);
    setDraft(value);
  };
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  async function save() {
    if (!ready || inFlight.current || draft === undefined || duplicate) return;
    const normalized =
      draft?.map(({ instanceId, model, role, instructions }) => ({
        instanceId,
        model,
        role,
        ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
      })) ?? null;
    inFlight.current = true;
    setPending(true);
    setMessage(null);
    try {
      if ("onSaveDraft" in props) {
        await props.onSaveDraft(normalized);
        setDraft(undefined);
        setMessage("첫 요청에 적용할 팀을 기기에 저장했습니다.");
        return;
      }
      const roomUpdate =
        "thread" in props ? { threadId: props.thread.id, members: normalized } : null;
      const patch =
        roomUpdate === null
          ? { globalSubordinateTeam: normalized ?? [] }
          : { threadSubordinateTeamUpdate: roomUpdate };
      const result = await update({
        environmentId: props.environmentId,
        input: { patch },
      });
      if (
        result._tag !== "Success" ||
        (roomUpdate === null
          ? !Array.isArray(result.value.globalSubordinateTeam) ||
            !sameTeam(result.value.globalSubordinateTeam, normalized ?? [])
          : !confirmsRoomTeam(result.value, roomUpdate))
      ) {
        setMessage("저장을 확인하지 못했습니다. 연결과 서버 설정을 확인해 주세요.");
        return;
      }
      setConfirmed({ before: observed, value: normalized });
      setDraft(undefined);
      setMessage("다음 요청에 적용할 팀을 저장했습니다.");
    } catch {
      setMessage("팀을 저장하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  const options = useMemo(() => buildModelOptions(serverConfig, null), [serverConfig]);
  const groups = useMemo(() => groupByProvider(options), [options]);
  const modelActions = useMemo(() => buildModelMenuActions(groups, null), [groups]);
  const chooseModel = (event: string, index?: number) => {
    const option = options.find((item) => "model:" + item.key === event);
    if (!option) return;
    const { instanceId, model } = option.selection;
    edit(
      index === undefined
        ? [...members, { instanceId, model, role: "worker", rowKey: "new-" + nextRow.current++ }]
        : members.map((member, i) => (i === index ? { ...member, instanceId, model } : member)),
    );
  };
  const rows = useMemo(
    () => (thread ? recordedAgents(thread, detail?.activities ?? []) : []),
    [thread, detail?.activities],
  );
  const evidence = useMemo(
    () => (thread ? turnEvidence(thread, detail ?? null) : null),
    [thread, detail],
  );
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);
  const actions = evidence?.actions ?? [];
  const showAll = expandedTurn != null && expandedTurn === evidence?.turnId;
  const live = rows.filter((row) => row.active);
  const history = rows.filter((row) => !row.active);
  const session = thread?.session;
  const answering = session?.status === "running";
  const close = () => {
    if (!inFlight.current) onClose();
  };
  const rowView = (row: (typeof rows)[number]) => (
    <View key={row.key} className="gap-1 border-b border-border py-2">
      <Text className="font-t3-bold text-sm">
        {row.title} · {row.status}
      </Text>
      {row.detail ? <Text className="text-sm text-muted-foreground">{row.detail}</Text> : null}
    </View>
  );
  const panel = (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
          <Text accessibilityRole="header" className="font-t3-bold text-base">
            {global ? "전역 하위 모델 팀" : room ? "대화 뷰어" : "첫 요청의 팀"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={room ? "대화 뷰어 닫기" : "팀 설정 닫기"}
            disabled={pending}
            onPress={close}
            className="px-3 py-2"
          >
            <Text>닫기</Text>
          </Pressable>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 20, gap: 14 }}
        >
          {thread && room && (
            <>
              <View className="flex-row items-center justify-between">
                <Text accessibilityRole="header" className="font-t3-bold">
                  현재 실행
                </Text>
                <StatusPill
                  label={room.live ? "실시간" : room.connected ? "동기화 중" : "연결 끊김"}
                  size="compact"
                  pillClassName="bg-subtle"
                  textClassName="text-foreground"
                />
              </View>
              {!room.live ? (
                <Text>현재 실행 상태를 확인하는 중입니다.</Text>
              ) : (
                <>
                  {answering && (
                    <Text>
                      답변 중 ·{" "}
                      {session?.providerInstanceId ?? session?.providerName ?? "계정 미보고"}
                    </Text>
                  )}
                  {evidence?.approvals.map((approval) => (
                    <Text key={approval.requestId}>
                      승인 대기 · {approval.detail ?? approval.requestKind}
                    </Text>
                  ))}
                  {live.map(rowView)}
                  {!detail ? (
                    <Text>대화 기록을 불러오는 중입니다.</Text>
                  ) : !answering && !live.length ? (
                    <Text>실행 중으로 보고된 에이전트가 없습니다.</Text>
                  ) : null}
                </>
              )}
              <Text accessibilityRole="header" className="font-t3-bold">
                최근 요청의 실행 기록
              </Text>
              {evidence?.turnId && (
                <Text>
                  요청 {evidence.turnId}
                  {thread.latestTurn?.turnId === evidence.turnId
                    ? " · " +
                      (
                        {
                          running: "진행 중",
                          completed: "완료",
                          interrupted: "중단",
                          error: "오류",
                        } as const
                      )[thread.latestTurn.state]
                    : ""}
                </Text>
              )}
              <Text>
                이번 요청에 지정한 모델 ·{" "}
                {evidence?.assigned
                  ? evidence.assigned.instanceId + " · " + evidence.assigned.model
                  : "지정 기록 없음"}
              </Text>
              <Text>
                제공자 보고 모델 ·{" "}
                {evidence?.models.length ? evidence.models.join(", ") : "보고 없음"}
              </Text>
              {(showAll ? actions : actions.slice(-1)).map((action) => (
                <View key={action.id} className="gap-1">
                  {action.presented ? (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: openAction === action.id }}
                        onPress={() => setOpenAction(openAction === action.id ? null : action.id)}
                      >
                        <Text>{action.title}</Text>
                      </Pressable>
                      {openAction === action.id && (
                        <MobileToolActivityDetail
                          row={action.presented}
                          technical={action.technical}
                        />
                      )}
                    </>
                  ) : (
                    <Text>
                      {new Date(action.createdAt).toLocaleTimeString()} · {action.title}
                    </Text>
                  )}
                  {action.detail && (
                    <Text selectable className="text-sm text-muted-foreground">
                      {action.detail}
                    </Text>
                  )}
                  {action.files.map((file) => (
                    <Text key={file}>{file}</Text>
                  ))}
                </View>
              ))}
              {actions.length > 1 && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setExpandedTurn(showAll ? null : (evidence?.turnId ?? null))}
                >
                  <Text>{showAll ? "최근 활동만 보기" : `요청 활동 ${actions.length}개 보기`}</Text>
                </Pressable>
              )}
              {evidence?.files.length ? <Text>변경 파일 · {evidence.files.join(", ")}</Text> : null}
              {evidence?.result?.text ? (
                <Text numberOfLines={4} selectable>
                  {evidence.result.streaming ? "작성 중인 답변" : "답변 결과"} ·{" "}
                  {evidence.result.text}
                </Text>
              ) : null}
              {evidence?.handoff && (
                <Text>
                  최근 인계 · {new Date(evidence.handoff.at).toLocaleString()} ·{" "}
                  {evidence.handoff.text}
                </Text>
              )}
              <Text accessibilityRole="header" className="font-t3-bold">
                하위 AI 작업 기록
              </Text>
              {history.map(rowView)}
              {!history.length && <Text>불러온 대화에 종료된 하위 AI 기록이 없습니다.</Text>}
            </>
          )}

          <Text accessibilityRole="header" className="font-t3-bold">
            {global ? "전역 팀" : room ? "다음 요청의 팀" : "첫 메시지에 사용할 팀"}
          </Text>
          {scope && (
            <Text>
              답변 모델 · {scope.answeringInstanceId} · {scope.forModel}
            </Text>
          )}
          {(settings || saved !== null) && (
            <Text className="text-xs text-muted-foreground">
              {global ? "전역 팀" : saved === null ? "전역 팀 사용 중" : "이 대화의 팀"} ·{" "}
              {(saved ?? defaults).length}명
            </Text>
          )}
          {(saved ?? defaults).map((member, i) => (
            <Text key={JSON.stringify([member.instanceId, member.model, member.role, i])}>
              {teamRoleLabels[member.role]} · {member.instanceId} · {member.model}
            </Text>
          ))}
          {!settings && <Text>환경 설정을 불러오는 중입니다.</Text>}
          {room && (
            <ThreadResponseStyleSettings
              key={`room-style:${room.environmentId}:${room.thread.id}`}
              environmentId={room.environmentId}
              threadId={room.thread.id}
            />
          )}
          {!global && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="하위 AI 설정"
              accessibilityState={{ expanded: editing }}
              onPress={() => setEditing(!editing)}
              className="rounded-lg border border-border p-3"
            >
              <Text>하위 AI 설정 {editing ? "▴" : "▾"}</Text>
            </Pressable>
          )}
          {editing && (
            <>
              {draft !== undefined && (
                <Text>
                  {draft === null
                    ? "전역 팀 사용"
                    : `${global ? "전역 팀" : "이 대화의 팀"} · ${draft.length}명`}{" "}
                  · 저장 전
                </Text>
              )}
              {members.map((member, index) => {
                const option = options.find(
                  (item) =>
                    item.selection.instanceId === member.instanceId &&
                    item.selection.model === member.model,
                );
                const label = option
                  ? option.providerLabel + " · " + option.label
                  : `${member.instanceId} · ${member.model} (목록에 없음)`;
                return (
                  <View key={member.rowKey} className="rounded-lg border border-border p-3 gap-2">
                    {ready && options.length ? (
                      <ControlPillMenu
                        title="하위 모델 변경"
                        actions={modelActions}
                        onPressAction={({ nativeEvent }) => chooseModel(nativeEvent.event, index)}
                      >
                        <Text
                          accessibilityRole="button"
                          accessibilityLabel={`${index + 1}번 하위 모델 변경`}
                        >
                          {label} ▾
                        </Text>
                      </ControlPillMenu>
                    ) : (
                      <Text>{label}</Text>
                    )}
                    <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
                      {(Object.keys(teamRoleLabels) as (keyof typeof teamRoleLabels)[]).map(
                        (role) => (
                          <Pressable
                            key={role}
                            accessibilityRole="radio"
                            accessibilityLabel={`${index + 1}번 ${teamRoleLabels[role]}`}
                            accessibilityState={{
                              selected: member.role === role,
                              disabled: !ready,
                            }}
                            disabled={!ready}
                            className="rounded border border-border px-3 py-2"
                            onPress={() =>
                              edit(members.map((m, i) => (i === index ? { ...m, role } : m)))
                            }
                          >
                            <Text>
                              {member.role === role ? "●" : "○"} {teamRoleLabels[role]}
                            </Text>
                          </Pressable>
                        ),
                      )}
                    </View>
                    <TextInput
                      accessibilityLabel={`${index + 1}번 하위 모델 지시`}
                      placeholder="이 모델의 지시 (선택)"
                      multiline
                      value={member.instructions ?? ""}
                      editable={ready}
                      className="rounded border border-border p-2 text-foreground"
                      onChangeText={(instructions) =>
                        edit(members.map((m, i) => (i === index ? { ...m, instructions } : m)))
                      }
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${index + 1}번 하위 모델 제거`}
                      disabled={!ready}
                      onPress={() => edit(members.filter((_, i) => i !== index))}
                    >
                      <Text>제거</Text>
                    </Pressable>
                  </View>
                );
              })}
              {ready && options.length ? (
                <ControlPillMenu
                  title="하위 모델 추가"
                  actions={modelActions}
                  onPressAction={({ nativeEvent }) => chooseModel(nativeEvent.event)}
                >
                  <Text accessibilityRole="button" className="rounded-lg border border-border p-3">
                    하위 모델 추가 ▾
                  </Text>
                </ControlPillMenu>
              ) : ready ? (
                <Text>현재 선택할 수 있는 계정 모델이 없습니다.</Text>
              ) : null}
              <View className="flex-row flex-wrap gap-3">
                <Pressable
                  disabled={!ready}
                  accessibilityRole="button"
                  onPress={() => edit([])}
                  className="py-2"
                >
                  <Text>하위 모델 없음</Text>
                </Pressable>
                {!global && (
                  <Pressable
                    disabled={!ready}
                    accessibilityRole="button"
                    onPress={() => edit(null)}
                    className="py-2"
                  >
                    <Text>전역 팀 사용</Text>
                  </Pressable>
                )}
              </View>
              {message && <Text accessibilityRole="alert">{message}</Text>}
              {duplicate && (
                <Text accessibilityRole="alert">
                  같은 계정과 모델에 같은 역할이 중복되었습니다.
                </Text>
              )}
              <SheetActionButton
                icon="checkmark"
                label={
                  pending
                    ? "저장 중…"
                    : global
                      ? "전역 팀 저장"
                      : room
                        ? "이 대화의 팀 저장"
                        : "초안에 팀 저장"
                }
                tone="primary"
                disabled={!ready || draft === undefined || sameTeam(saved, draft) || duplicate}
                onPress={() => void save()}
              />
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
  return room ? (
    <MobileToolActivityProvider environmentId={room.environmentId} threadId={room.thread.id}>
      {panel}
    </MobileToolActivityProvider>
  ) : (
    panel
  );
}
