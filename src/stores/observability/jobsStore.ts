import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { invokeCommand, onAuditEvent } from '@/ipc/invoke';
import type { AuditEntry, JobRecord } from '@/ipc/types';
import { useLayoutStore } from '@/stores/shell/layoutStore';
import { useSessionsStore } from '@/stores/chat/sessionsStore';
import { useToastStore } from '@/stores/app/toastStore';
import { toErrorMessage } from '@/lib/errorMessage';

type LocalAutopilotMeta = {
  seenThinking: boolean;
};

function isActiveStatus(status: JobRecord['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'idle';
}

function nowIso(): string {
  return new Date().toISOString();
}

export const useJobsStore = defineStore('jobs', () => {
  const sdkJobs = ref<JobRecord[]>([]);
  const localJobs = ref<JobRecord[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  const busyJobId = ref<string | null>(null);
  const localMeta = new Map<string, LocalAutopilotMeta>();

  const jobs = computed(() =>
    [...localJobs.value, ...sdkJobs.value].sort((a, b) => {
      const rank = (j: JobRecord) => (isActiveStatus(j.status) ? 0 : 1);
      const ar = rank(a);
      const br = rank(b);

      if (ar !== br) return ar - br;

      const at = a.startedAt ? Date.parse(a.startedAt) : 0;
      const bt = b.startedAt ? Date.parse(b.startedAt) : 0;

      return bt - at;
    }),
  );
  const activeJobs = computed(() => jobs.value.filter((job) => isActiveStatus(job.status)));
  const activeCount = computed(() => activeJobs.value.length);

  async function refresh(): Promise<void> {
    isLoading.value = true;
    error.value = null;

    try {
      sdkJobs.value = await invokeCommand('listJobs', {});
    } catch (err) {
      error.value = toErrorMessage(err);
      useToastStore().error('Failed to load jobs', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  function hasActiveJobsForSession(sessionId: string): boolean {
    return jobs.value.some((job) => job.sessionId === sessionId && isActiveStatus(job.status));
  }

  async function cancelJob(job: JobRecord): Promise<void> {
    busyJobId.value = job.id;

    try {
      if (job.source === 'autopilot-session') {
        await useSessionsStore().abortSession(job.sessionId);
        updateLocalJob(job.id, {
          status: 'cancelled',
          completedAt: nowIso(),
          canCancel: false,
          canRemove: true,
        });
        useToastStore().info('Job cancelled', `Cancelled "${job.title}".`);
      } else {
        await invokeCommand('cancelTask', {
          sessionId: job.sessionId,
          id: taskIdFromJob(job),
        });
        // Mark locally as cancelled immediately — the SDK's task list
        // may still report "completed" if the cancel arrived too late.
        updateLocalJob(job.id, {
          status: 'cancelled',
          completedAt: nowIso(),
          canCancel: false,
          canRemove: true,
        });
        useToastStore().info('Job cancelled', `Cancelled "${job.title}".`);
        await refresh();
      }
    } catch (err) {
      useToastStore().error('Failed to cancel job', toErrorMessage(err));
    } finally {
      busyJobId.value = null;
    }
  }

  async function removeJob(job: JobRecord): Promise<void> {
    busyJobId.value = job.id;

    try {
      if (job.source === 'autopilot-session') {
        localJobs.value = localJobs.value.filter((j) => j.id !== job.id);
        localMeta.delete(job.id);
      } else {
        await invokeCommand('removeTask', {
          sessionId: job.sessionId,
          id: taskIdFromJob(job),
        });
        await refresh();
      }
    } catch (err) {
      useToastStore().error('Failed to remove job', toErrorMessage(err));
    } finally {
      busyJobId.value = null;
    }
  }

  async function promoteJob(job: JobRecord): Promise<void> {
    if (job.source !== 'sdk-task') return;

    busyJobId.value = job.id;

    try {
      await invokeCommand('promoteTask', {
        sessionId: job.sessionId,
        id: taskIdFromJob(job),
      });
      await refresh();
    } catch (err) {
      useToastStore().error('Failed to promote job', toErrorMessage(err));
    } finally {
      busyJobId.value = null;
    }
  }

  /// Open + activate the owning session's panel, then park a "reveal"
  /// intent so the ChatWindow scrolls to the tool-call card that
  /// spawned this job (issue #16). When the job has no `toolCallId`
  /// (autopilot-session jobs), the reveal falls back to scrolling to
  /// the bottom so the user lands on the live work. The intent is
  /// stored (not bus-emitted) so it survives a freshly-opened panel
  /// that hasn't mounted its ChatWindow yet — mitt has no replay.
  function openOwningSession(sessionId: string, toolCallId?: string): void {
    const layout = useLayoutStore();

    if (!layout.isPanelOpen(sessionId)) layout.addPanel(sessionId);

    layout.activatePanel(sessionId);
    layout.requestReveal(sessionId, { toolCallId });
  }

  async function startAutopilot(sessionId: string, goal: string): Promise<void> {
    const trimmed = goal.trim();

    if (!trimmed) return;

    // Wire the tool-failure audit listener now that a live autopilot job
    // will exist to enrich (lazy — see ensureAuditSubscription).
    ensureAuditSubscription();

    const id = `autopilot:${sessionId}:${Date.now()}`;
    const session = useSessionsStore().getSession(sessionId);
    const job: JobRecord = {
      id,
      sessionId,
      source: 'autopilot-session',
      kind: 'autopilot',
      status: 'starting',
      title: 'Autopilot run',
      description: trimmed,
      prompt: trimmed,
      startedAt: nowIso(),
      canCancel: true,
      canRemove: false,
      canPromoteToBackground: false,
      canOpenSession: true,
      latestResponse: session?.workingDirectory
        ? `Workspace: ${session.workingDirectory}`
        : 'Current session',
    };

    localJobs.value = [job, ...localJobs.value];
    localMeta.set(id, { seenThinking: false });

    try {
      const sessions = useSessionsStore();

      await sessions.setSessionMode(sessionId, 'autopilot');
      updateLocalJob(id, { status: 'running' });
      await sessions.sendMessage(sessionId, trimmed, 'steer');
    } catch (err) {
      updateLocalJob(id, {
        status: 'failed',
        error: toErrorMessage(err),
        completedAt: nowIso(),
        canCancel: false,
        canRemove: true,
      });
      throw err;
    }
  }

  function updateLocalJob(id: string, patch: Partial<JobRecord>): void {
    localJobs.value = localJobs.value.map((job) => (job.id === id ? { ...job, ...patch } : job));
  }

  /// #36: surface SDK-observed tool failures on the jobs panel.
  /// The backend `onPostToolUseFailure` hook records a `toolFailure`
  /// audit entry carrying the SDK-provided `error` string; we listen on
  /// the same audit pipeline the Activity view uses and attach that
  /// structured error context to the matching active autopilot job so
  /// the panel renders the actual failure (not just our parsed stream
  /// event).
  ///
  /// The subscription is lazy (mirrors `sessionsStore.ensureSubscription`):
  /// it's wired the first time an autopilot job is started, not at store
  /// setup. Subscribing eagerly at `defineStore` time crashes the boot
  /// smoke harness, whose minimal RPC stub omits the `on*` channel
  /// methods — and there's nothing to enrich until an autopilot job
  /// exists anyway. The subscription returns an unsubscribe stored on
  /// the store for lifecycle cleanup (rule: no background sub without
  /// teardown).
  let auditUnsubscribe: (() => void) | null = null;

  function handleToolFailureAudit(entry: AuditEntry): void {
    if (entry.kind !== 'toolFailure') return;

    for (const job of localJobs.value) {
      if (
        job.source !== 'autopilot-session' ||
        job.sessionId !== entry.sessionId ||
        !isActiveStatus(job.status)
      ) {
        continue;
      }

      updateLocalJob(job.id, {
        latestResponse: `⚠ ${entry.toolName} failed: ${entry.error}`,
      });
    }
  }

  function ensureAuditSubscription(): void {
    if (auditUnsubscribe) return;

    auditUnsubscribe = onAuditEvent(handleToolFailureAudit);
  }

  function dispose(): void {
    if (auditUnsubscribe) {
      auditUnsubscribe();
      auditUnsubscribe = null;
    }
  }

  function taskIdFromJob(job: JobRecord): string {
    return job.id.startsWith(`${job.sessionId}:`) ? job.id.slice(job.sessionId.length + 1) : job.id;
  }

  const sessionsStore = useSessionsStore();

  watch(
    () => sessionsStore.sessions.map((s) => `${s.id}:${s.tasksRefreshCounter}`).join('|'),
    () => {
      void refresh();
    },
    { immediate: true },
  );

  watch(
    () =>
      sessionsStore.sessions.map((s) => ({
        id: s.id,
        isThinking: s.isThinking,
        sawTurnBoundary: s.sawTurnBoundary,
        events: s.events.length,
      })),
    () => {
      for (const job of localJobs.value) {
        if (job.source !== 'autopilot-session' || !isActiveStatus(job.status)) continue;

        const session = sessionsStore.getSession(job.sessionId);

        if (!session) continue;

        const meta = localMeta.get(job.id);

        if (!meta) continue;

        const lastEvent = session.events[session.events.length - 1];

        if (lastEvent?.eventType === 'session.error') {
          updateLocalJob(job.id, {
            status: 'failed',
            error:
              typeof lastEvent.data.message === 'string' ? lastEvent.data.message : 'Session error',
            completedAt: nowIso(),
            canCancel: false,
            canRemove: true,
          });
          continue;
        }

        if (session.isThinking) meta.seenThinking = true;

        if (meta.seenThinking && !session.isThinking) {
          updateLocalJob(job.id, {
            status: 'completed',
            completedAt: nowIso(),
            canCancel: false,
            canRemove: true,
            latestResponse: 'Turn complete',
          });
        }
      }
    },
    { deep: true },
  );

  return {
    jobs,
    activeJobs,
    activeCount,
    isLoading,
    error,
    busyJobId,
    refresh,
    hasActiveJobsForSession,
    cancelJob,
    removeJob,
    promoteJob,
    openOwningSession,
    startAutopilot,
    dispose,
  };
});
