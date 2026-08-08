import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo } from "react";
import { Alert } from "react-native";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";
import {
  parseSlashSnoozeDuration,
  parseStandaloneComposerSlashCommand,
} from "@t3tools/shared/composerTrigger";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useAtomCommand } from "../state/use-atom-command";
import { threadEnvironment } from "./threads";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const selectedThreadFeed = useMemo(
    () => (selectedThreadDetail ? buildThreadFeed(selectedThreadDetail) : []),
    [selectedThreadDetail],
  );

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");

  const snoozeCommand = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnoozeCommand = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const archiveCommand = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveCommand = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const pinCommand = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinCommand = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const settleCommand = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleCommand = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const updateMetadataCommand = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const interruptTurnCommand = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  /**
   * Execute a built-in slash command against the selected thread. Returns
   * true when the command was handled (and the composer draft should be
   * cleared); false for commands the mobile surface cannot execute, letting
   * callers fall back to sending the text.
   */
  const dispatchSlashCommand = useCallback(
    (command: string, args: string): boolean => {
      if (!selectedThreadShell) {
        return false;
      }
      const environmentId = selectedThreadShell.environmentId;
      const threadId = selectedThreadShell.id;
      const threadKey = scopedThreadKey(environmentId, threadId);

      switch (command) {
        case "plan":
        case "default":
          updateComposerDraftSettings(threadKey, { interactionMode: command });
          return true;
        case "stop":
          void interruptTurnCommand({ environmentId, threadId }).catch(() => undefined);
          return true;
        case "snooze": {
          const snoozedUntil = parseSlashSnoozeDuration(args);
          if (snoozedUntil === null) {
            Alert.alert("Snooze", 'Give a duration like "/snooze 30m" or "/snooze 2h".');
          } else {
            void snoozeCommand({ environmentId, threadId, snoozedUntil }).catch(() => undefined);
          }
          return true;
        }
        case "unsnooze":
          void unsnoozeCommand({ environmentId, threadId }).catch(() => undefined);
          return true;
        case "archive":
          void archiveCommand({ environmentId, threadId }).catch(() => undefined);
          return true;
        case "unarchive":
          void unarchiveCommand({ environmentId, threadId }).catch(() => undefined);
          return true;
        case "pin":
          void pinCommand({ environmentId, threadId }).catch(() => undefined);
          return true;
        case "unpin":
          void unpinCommand({ environmentId, threadId }).catch(() => undefined);
          return true;
        case "settle":
          void settleCommand({ environmentId, threadId }).catch(() => undefined);
          return true;
        case "unsettle":
          void unsettleCommand({ environmentId, threadId }).catch(() => undefined);
          return true;
        case "rename": {
          const title = args.trim();
          if (title.length === 0) {
            Alert.alert("Rename thread", 'Give it a name, like "/rename bug hunt".');
            return true;
          }
          void updateMetadataCommand({ environmentId, threadId, title }).catch(() => undefined);
          return true;
        }
        case "help":
          Alert.alert(
            "Slash commands",
            "/plan, /default, /stop, /rename <title>, /snooze <duration>, /unsnooze, /archive, /unarchive, /pin, /unpin, /settle, /unsettle, /clear, /todos",
          );
          return true;
        case "clear":
          Alert.alert(
            "Start a new thread",
            "Head to the thread list and start a new one to clear this conversation.",
          );
          return true;
        case "todos":
          Alert.alert("Plan and tasks", "Open the plan for this thread from the details panel.");
          return true;
        case "context":
        case "stats":
          Alert.alert(
            "Not available on mobile",
            "Context and usage stats are shown in the full app.",
          );
          return true;
        case "revert":
          Alert.alert(
            "Not available on mobile",
            "Reverting a thread needs the checkpoint picker in the full app.",
          );
          return true;
        default:
          return false;
      }
    },
    [
      archiveCommand,
      interruptTurnCommand,
      pinCommand,
      selectedThreadShell,
      settleCommand,
      snoozeCommand,
      unarchiveCommand,
      unpinCommand,
      unsettleCommand,
      unsnoozeCommand,
      updateMetadataCommand,
    ],
  );

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    if (attachments.length === 0) {
      const standalone = parseStandaloneComposerSlashCommand(text);
      if (standalone) {
        const handled = dispatchSlashCommand(standalone.command, standalone.args);
        if (handled) {
          clearComposerDraftContent(threadKey);
          return null;
        }
      }
    }

    // Enqueue publishes the queued atom synchronously (the durable write
    // happens behind it), so clearing the draft here gives send feedback on
    // the tap frame instead of after file I/O. If the write fails the message
    // is rolled out of the queue and the content is merged back into the
    // draft, preserving anything typed since.
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      modelSelection: draft.modelSelection ?? thread.modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: draft.interactionMode ?? thread.interactionMode,
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey);
    enqueuePromise.catch((error: unknown) => {
      // Restore text via merge (idempotent) but attachments via the uncapped
      // append: the merge path slots existing attachments first and truncates
      // at the send limit, which would silently drop this message's images if
      // the user attached new ones while the write was in flight.
      void mergeComposerDraftContent(threadKey, { text, attachments: [] });
      appendComposerDraftAttachments(threadKey, attachments);
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    });
    return messageId;
  }, [dispatchSlashCommand, selectedThreadDetail, selectedThreadShell]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
    dispatchSlashCommand,
  };
}
