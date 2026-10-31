import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { threadEnvironment } from "../state/threads";
import { scopedRequestKey } from "../lib/scopedEntities";
import { pickComposerImages } from "../lib/composerImages";
import {
  buildPendingUserInputAnswers,
  buildPendingUserInputImages,
  derivePendingApprovals,
  derivePendingUserInputs,
  setPendingUserInputCustomAnswer,
  sortThreadActivities,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { appAtomRegistry } from "./atom-registry";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";
import { setPendingConnectionError } from "./use-remote-environment-registry";

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

function setUserInputDraftOption(requestKey: string, questionId: string, label: string): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: {
        selectedOptionLabel: label,
        ...(current[requestKey]?.[questionId]?.images?.length
          ? { images: current[requestKey]![questionId]!.images }
          : {}),
      },
    },
  });
}

function setUserInputDraftCustomAnswer(
  requestKey: string,
  questionId: string,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: setPendingUserInputCustomAnswer(
        current[requestKey]?.[questionId],
        customAnswer,
      ),
    },
  });
}

export function useSelectedThreadRequests() {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  const [pickingUserInputId, setPickingUserInputId] = useState<ApprovalRequestId | null>(null);

  // Sort once; both derivations expect the same lifecycle ordering.
  const sortedActivities = useMemo(
    () => (selectedThread ? sortThreadActivities(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingApprovals = useMemo(
    () => derivePendingApprovals(sortedActivities),
    [sortedActivities],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;
  const activePendingUserInputs = useMemo(
    () => derivePendingUserInputs(sortedActivities),
    [sortedActivities],
  );
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  useEffect(() => {
    if (!selectedThreadShell) return;
    const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
    let next: typeof current | null = null;
    for (const activity of sortedActivities) {
      if (
        activity.kind !== "user-input.resolved" ||
        !activity.payload ||
        typeof activity.payload !== "object"
      )
        continue;
      const requestId = (activity.payload as Record<string, unknown>).requestId;
      if (
        typeof requestId !== "string" ||
        activePendingUserInputs.some((item) => item.requestId === requestId)
      )
        continue;
      const requestKey = scopedRequestKey(
        selectedThreadShell.environmentId,
        ApprovalRequestId.make(requestId),
      );
      const answers = (next ?? current)[requestKey];
      if (!answers || !Object.values(answers).some((draft) => draft.images?.length)) continue;
      next ??= { ...current };
      next[requestKey] = Object.fromEntries(
        Object.entries(answers).map(([questionId, draft]) => [
          questionId,
          { ...draft, images: [] },
        ]),
      );
    }
    if (next) appAtomRegistry.set(userInputDraftsByRequestKeyAtom, next);
  }, [activePendingUserInputs, selectedThreadShell, sortedActivities, userInputDraftsByRequestKey]);
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedThreadShell
      ? (userInputDraftsByRequestKey[
          scopedRequestKey(selectedThreadShell.environmentId, activePendingUserInput.requestId)
        ] ?? {})
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, questionId: string, label: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftOption(requestKey, questionId, label);
    },
    [selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftCustomAnswer(requestKey, questionId, customAnswer);
    },
    [selectedThreadShell],
  );

  const onPickUserInputImages = useCallback(
    async (requestId: ApprovalRequestId, questionId: string) => {
      if (!selectedThreadShell || pickingUserInputId !== null) return;
      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      const drafts = appAtomRegistry.get(userInputDraftsByRequestKeyAtom)[requestKey] ?? {};
      const images = Object.values(drafts).flatMap((draft) => draft.images ?? []);
      setPickingUserInputId(requestId);
      try {
        const result = await pickComposerImages({
          existingCount: images.length,
          existingBytes: images.reduce((total, image) => total + image.sizeBytes, 0),
        });
        if (result.images.length) {
          const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
          const answers = current[requestKey] ?? {};
          const draft = answers[questionId] ?? {};
          appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
            ...current,
            [requestKey]: {
              ...answers,
              [questionId]: { ...draft, images: [...(draft.images ?? []), ...result.images] },
            },
          });
        }
        if (result.error) setPendingConnectionError(result.error);
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "이미지를 선택하지 못했습니다.",
        );
      } finally {
        setPickingUserInputId(null);
      }
    },
    [pickingUserInputId, selectedThreadShell],
  );

  const onRemoveUserInputImage = useCallback(
    (requestId: ApprovalRequestId, questionId: string, imageId: string) => {
      if (!selectedThreadShell) return;
      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
      const answers = current[requestKey];
      const draft = answers?.[questionId];
      if (!draft) return;
      appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
        ...current,
        [requestKey]: {
          ...answers,
          [questionId]: {
            ...draft,
            images: (draft.images ?? []).filter((image) => image.id !== imageId),
          },
        },
      });
    },
    [selectedThreadShell],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThreadShell) {
        return;
      }

      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
        },
      });
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [respondToApproval, selectedThreadShell],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (
      !selectedThreadShell ||
      !activePendingUserInput ||
      !activePendingUserInputAnswers ||
      pickingUserInputId
    ) {
      return;
    }

    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await respondToUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
        images: buildPendingUserInputImages(activePendingUserInputDrafts),
      },
    });
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    return result;
  }, [
    activePendingUserInput,
    activePendingUserInputAnswers,
    activePendingUserInputDrafts,
    pickingUserInputId,
    respondToUserInput,
    selectedThreadShell,
  ]);

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingApprovalId,
    respondingUserInputId,
    pickingUserInputId,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onPickUserInputImages,
    onRemoveUserInputImage,
    onSubmitUserInput,
  };
}
