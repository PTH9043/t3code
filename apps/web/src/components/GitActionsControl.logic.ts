import type {
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  type ChangeRequestTerminology,
} from "../sourceControlPresentation";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

function resolveChangeRequestTerminology(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return gitStatus?.sourceControlProvider
    ? getChangeRequestTerminology(gitStatus.sourceControlProvider)
    : DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}

export function buildGitActionProgressStages(input: {
  action: GitStackedAction;
  hasCustomCommitMessage: boolean;
  hasWorkingTreeChanges: boolean;
  pushTarget?: string;
  featureBranch?: boolean;
  shouldPushBeforePr?: boolean;
  terminology?: ChangeRequestTerminology;
}): string[] {
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  const branchStages = input.featureBranch ? ["기능 브랜치 준비 중..."] : [];
  const pushStage = input.pushTarget ? `${input.pushTarget}에 푸시 중...` : "푸시 중...";
  const prStages = [
    `${terminology.shortLabel} 준비 중...`,
    `${terminology.shortLabel} 내용 생성 중...`,
    `${terminology.shortLabel} 만드는 중...`,
  ];

  if (input.action === "push") {
    return [pushStage];
  }
  if (input.action === "create_pr") {
    return input.shouldPushBeforePr ? [pushStage, ...prStages] : prStages;
  }

  const shouldIncludeCommitStages = input.action === "commit" || input.hasWorkingTreeChanges;
  const commitStages = !shouldIncludeCommitStages
    ? []
    : input.hasCustomCommitMessage
      ? ["커밋 중..."]
      : ["커밋 메시지 생성 중...", "커밋 중..."];
  if (input.action === "commit") {
    return [...branchStages, ...commitStages];
  }
  if (input.action === "commit_push") {
    return [...branchStages, ...commitStages, pushStage];
  }
  return [...branchStages, ...commitStages, pushStage, ...prStages];
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = resolveChangeRequestTerminology(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canOpenPr = !isBusy && hasOpenPr;

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: "커밋",
    disabled: !canCommit,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  };

  if (!hasPrimaryRemote) {
    return [commitItem];
  }

  return [
    commitItem,
    {
      id: "push",
      label: "푸시",
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: `${terminology.shortLabel} 보기`,
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: `${terminology.shortLabel} 만들기`,
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
): GitQuickAction {
  if (isBusy) {
    return { label: "커밋", disabled: true, kind: "show_hint", hint: "Git 작업을 진행 중입니다." };
  }

  if (!gitStatus) {
    return {
      label: "커밋",
      disabled: true,
      kind: "show_hint",
      hint: "Git 상태를 확인할 수 없습니다.",
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = resolveChangeRequestTerminology(gitStatus);

  if (!hasBranch) {
    return {
      label: "커밋",
      disabled: true,
      kind: "show_hint",
      hint: `푸시하거나 ${terminology.shortLabel}을 만들기 전에 브랜치를 만들고 체크아웃하세요.`,
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return { label: "커밋", disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return { label: "커밋 및 푸시", disabled: false, kind: "run_action", action: "commit_push" };
    }
    return {
      label: `커밋, 푸시 및 ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      if (hasOpenPr && !isAhead) {
        return { label: `${terminology.shortLabel} 보기`, disabled: false, kind: "open_pr" };
      }
      return {
        label: "저장소 게시",
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return { label: `${terminology.shortLabel} 보기`, disabled: false, kind: "open_pr" };
      }
      return {
        label: "푸시",
        disabled: true,
        kind: "show_hint",
        hint: "푸시할 로컬 커밋이 없습니다.",
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "푸시",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `푸시 후 ${terminology.shortLabel} 만들기`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: "브랜치 동기화",
      disabled: true,
      kind: "show_hint",
      hint: "브랜치가 업스트림과 갈라졌습니다. 먼저 리베이스하거나 병합하세요.",
    };
  }

  if (isBehind) {
    return {
      label: "풀",
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "푸시",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `푸시 후 ${terminology.shortLabel} 만들기`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return { label: `${terminology.shortLabel} 보기`, disabled: false, kind: "open_pr" };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: `${terminology.shortLabel} 만들기`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: "커밋",
    disabled: true,
    kind: "show_hint",
    hint: "브랜치가 최신 상태입니다. 필요한 작업이 없습니다.",
  };
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultRef: boolean,
): boolean {
  if (!isDefaultRef) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology?: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = ` 대상은 "${branchLabel}"입니다. 이 브랜치에서 계속하거나 기능 브랜치를 만들어 같은 작업을 실행할 수 있습니다.`;
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: "기본 브랜치에 커밋하고 푸시할까요?",
        description: `변경 사항을 커밋하고 푸시합니다.${suffix}`,
        continueLabel: `${branchLabel}에 커밋 및 푸시`,
      };
    }
    return {
      title: "기본 브랜치에 푸시할까요?",
      description: `로컬 커밋을 푸시합니다.${suffix}`,
      continueLabel: `${branchLabel}에 푸시`,
    };
  }

  if (input.includesCommit) {
    return {
      title: `기본 브랜치에서 커밋, 푸시 및 ${terminology.shortLabel} 생성을 진행할까요?`,
      description: `변경 사항을 커밋하고 푸시한 뒤 ${terminology.shortLabel}을 만듭니다.${suffix}`,
      continueLabel: `커밋, 푸시 및 ${terminology.shortLabel} 만들기`,
    };
  }
  return {
    title: `기본 브랜치에서 푸시하고 ${terminology.shortLabel}을 만들까요?`,
    description: `로컬 커밋을 푸시한 뒤 ${terminology.shortLabel}을 만듭니다.${suffix}`,
    continueLabel: `푸시 후 ${terminology.shortLabel} 만들기`,
  };
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

// Re-export from shared for backwards compatibility in this module's exports
export { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
