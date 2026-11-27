import { useState } from "react";
import { WorkspaceExecutionProfile, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  configFromExecutionProfile,
  meetingConversationKeyForFolder,
  meetingSetupFromConfig,
  useMeetingComposerConfigForFolder,
  useMeetingComposerStore,
} from "~/meetingComposerStore";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { notifyCommandFailure, notifySuccess } from "./controlCenterShared";

const SELECT_CLASS = "w-full rounded-md border border-input bg-background p-2 text-xs";
const decodeProfile = Schema.decodeUnknownOption(WorkspaceExecutionProfile);

export function ExecutionProfileSelect(props: {
  environmentId: EnvironmentId;
  value: string;
  onChange: (id: string) => void;
}) {
  const profiles = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.executionProfiles,
  );
  return (
    <label className="grid gap-1.5 text-xs font-medium">
      실행 프로필
      <select
        className={SELECT_CLASS}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <option value="">프로젝트 기본 설정</option>
        {Object.values(profiles).map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name} · v{profile.revision}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ExecutionProfiles(props: { environmentId: EnvironmentId; folderKey: string }) {
  const profiles = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.executionProfiles,
  );
  const config = useMeetingComposerConfigForFolder(props.folderKey);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [commands, setCommands] = useState("");
  const [busy, setBusy] = useState(false);
  const select = (id: string) => {
    setSelectedId(id);
    const profile = profiles[id];
    setName(profile?.name ?? "");
    setInstructions(profile?.instructions ?? "");
    setCommands(profile?.verificationCommands.join("\n") ?? "");
  };
  const save = async () => {
    const id = selectedId || `profile-${randomUUID()}`;
    const decoded = decodeProfile({
      id,
      name: name.trim(),
      revision: 0,
      instructions,
      verificationCommands: commands
        .split(/\r?\n/u)
        .map((command) => command.trim())
        .filter(Boolean),
      meeting: meetingSetupFromConfig(config),
      orchestra: {
        maxParallel: config.maxParallel,
        isolateWorktrees: config.isolateWorktrees,
        reviewPlan: config.reviewPlan === true,
        resumeAfterLimit: config.resumeAfterLimit === true,
        ...(config.maxWorkerTurns === undefined ? {} : { maxWorkerTurns: config.maxWorkerTurns }),
      },
    });
    if (decoded._tag === "None") {
      toastManager.add({
        type: "warning",
        title: "이름과 감독 AI를 설정하세요.",
        description: "지침은 4,000자, 검증 명령은 줄마다 500자·최대 8개입니다.",
      });
      return;
    }
    setBusy(true);
    try {
      const result = await updateSettings({
        environmentId: props.environmentId,
        input: { patch: { executionProfilesToUpsert: { [id]: decoded.value } } },
      });
      if (!notifyCommandFailure(result, "프로필 저장 실패")) {
        setSelectedId(id);
        notifySuccess("실행 프로필을 저장했습니다.");
      }
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const result = await updateSettings({
        environmentId: props.environmentId,
        input: { patch: { executionProfileIdsToRemove: [selectedId] } },
      });
      if (!notifyCommandFailure(result, "프로필 삭제 실패")) select("");
    } finally {
      setBusy(false);
    }
  };
  const apply = () => {
    const profile = profiles[selectedId];
    if (!profile) return;
    const target = meetingConversationKeyForFolder(props.folderKey);
    useMeetingComposerStore
      .getState()
      .updateConfig(target, (current) => configFromExecutionProfile(current, profile));
    notifySuccess(
      target === props.folderKey
        ? "대화가 없어 폴더의 기본 협업 설정에 저장했습니다."
        : "이 폴더에서 마지막으로 사용한 대화의 협업 설정에 적용했습니다.",
    );
  };
  return (
    <div className="grid gap-3 rounded-xl border border-border p-3">
      <strong className="text-sm">재사용 실행 프로필</strong>
      <p className="text-xs text-muted-foreground">
        채팅의 협업 설정에서 AI·모델·추론 강도·병렬 수를 선택하고 저장하세요. 프로필은 이 서버의
        다른 기기에서도 선택할 수 있습니다. 예약은 저장 당시 버전을 사용합니다.
      </p>
      <ExecutionProfileSelect
        environmentId={props.environmentId}
        value={selectedId}
        onChange={select}
      />
      <div className="flex gap-2">
        <Button size="xs" onClick={apply} disabled={!profiles[selectedId] || busy}>
          협업 설정에 적용
        </Button>
        <Button size="xs" variant="ghost" onClick={() => select("")} disabled={busy}>
          새 프로필
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void remove()}
          disabled={!profiles[selectedId] || busy}
        >
          삭제
        </Button>
      </div>
      <label className="grid gap-1 text-xs">
        프로필 이름
        <Input
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        공통 작업 지침
        <Textarea
          value={instructions}
          maxLength={4000}
          onChange={(event) => setInstructions(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        검증 명령 (한 줄에 하나)
        <Textarea
          value={commands}
          onChange={(event) => setCommands(event.currentTarget.value)}
          placeholder="vp test run 변경된테스트파일"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        현재 AI {config.seats.length}개 · 병렬 {config.maxParallel} · worktree{" "}
        {config.isolateWorktrees ? "격리" : "공유"}
        {config.executionProfile
          ? ` · ${config.executionProfile.name} v${config.executionProfile.revision} 기반`
          : ""}
      </p>
      <Button size="sm" onClick={() => void save()} disabled={busy}>
        {busy ? "저장 중…" : "현재 협업 설정으로 저장"}
      </Button>
    </div>
  );
}
