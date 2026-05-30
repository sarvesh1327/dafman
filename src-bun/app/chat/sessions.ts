// Session registry + event forwarder.
//
// Holds one entry per active SDK session. Subscribing to `session.on`
// fans every event out through a caller-supplied `emit` callback
// (typically `webview.rpc.send.sessionEvent`). On disconnect we drop
// the entry but the SDK handles its own cleanup.
//
// Also owns the per-session "pending callback" map: when the SDK
// calls one of `onPermissionRequest` / `onUserInputRequest` /
// `onElicitationRequest` we store the Promise resolver, push a
// `pendingRequest` message to the renderer, and resolve via the
// `respondToRequest` RPC. Teardown paths (disconnect, delete,
// shutdown) settle every outstanding entry with a typed
// "user-not-available" / "cancel" so the SDK never hangs.

import { type CopilotSession, type ReasoningEffort, type SessionEvent } from '../client/copilotSdk';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { tryGetClient } from '../client/client';
import { AppError } from '../shared/errors';
import { log } from '../observability/logging';
import { PendingRequestQueue } from './pendingRequests';
import { buildBuiltInTools } from '../library/tools';
import { searchWorkspaceFiles } from '../filesystem/fileSearch';
import { type AgentFileSpec, type AgentScope as AgentFileScope } from '../library/agentFiles';
import { toErrorMessage } from '../shared/errorMessage';
import { commandResultBlobAttachment } from './sessionHelpers';
import {
  type AgentLoadDiagnostics,
  wrapSdkError,
  type SessionEntryView,
  type SessionServiceContext,
} from './sessionServiceContext';
import { SessionPlanService } from './sessionPlanService';
import { SessionSkillsService } from './sessionSkillsService';
import { SessionTasksService } from './sessionTasksService';
import { SessionAgentsService } from './sessionAgentsService';
import { SessionMcpService } from './sessionMcpService';
import { SessionEventForwarder } from './sessionEventForwarder';
import { buildBaseSessionConfig } from './sessionConfigBuilder';
import { SessionMetadataService } from './sessionMetadataService';
import type {
  PendingRequestPayload,
  RespondToRequestParams,
  SendMessageAttachment,
  SessionEventPayload,
  SessionMetadataSummary,
  SessionHistoryCompactionResult,
  SessionMode,
  WorkspaceFileMatch,
  AgentInfo,
  JobRecord,
  TaskInfo,
} from '../../rpc';

/// Subset of SDK reasoning effort levels. We re-export the SDK's
/// canonical type via copilotSdk.ts so any future SDK additions
/// flow through without a silent drift.

/// S5: cap replay of `session.getEvents()` history at this many
/// events. The SDK returns the full transcript without pagination —
/// long-lived sessions can produce thousands of events. The renderer
/// reducer reconstructs the visible state from this slice; events
/// older than the cap are still on disk and could be re-fetched later
/// if needed.
const HISTORY_REPLAY_CAP = 500;

/// S5: yield to the event loop between batches of this size while
/// replaying. Avoids blocking IPC and lets the renderer paint between
/// chunks.
const HISTORY_REPLAY_BATCH = 50;

/// #20: synthetic terminator appended to the resume replay stream when
/// the persisted history ends mid-turn. Not an SDK event — the renderer
/// reducer maps `dafman.resume_settled` to "clear isThinking" (see
/// `sessionReducer.ts`). Cast through `SessionEvent` because the SDK's
/// event union doesn't (and shouldn't) know about our dafman.* control
/// events.
const RESUME_SETTLED_EVENT = {
  type: 'dafman.resume_settled',
  data: {},
} as unknown as SessionEvent;

/// #20: mirror of the renderer reducer's `isThinking` transitions over a
/// replayed history slice. Returns true when the trailing state is
/// "mid-turn" (a `turn_start` with no matching terminal boundary —
/// turn_end / idle / error / abort / task_complete) — the stuck-spinner
/// condition. A freshly-resumed session never legitimately resumes
/// mid-turn (the SDK does not auto-continue an interrupted turn:
/// `continuePendingWork` defaults to false), so a true result is always
/// safe to terminate.
function historyEndsMidTurn(events: ReadonlyArray<SessionEvent>): boolean {
  let thinking = false;

  for (const event of events) {
    switch (event.type) {
      case 'assistant.turn_start':
        thinking = true;
        break;
      case 'assistant.turn_end':
      case 'session.idle':
      case 'session.error':
      case 'abort':
      case 'session.task_complete':
        thinking = false;
        break;
    }
  }

  return thinking;
}

/// S1: per-session disconnect timeout during `shutdownAll`. If the
/// SDK's `session.disconnect()` doesn't resolve in this window we
/// force-clear the entry and move on — the OS process exit handles
/// the rest.
const SHUTDOWN_TIMEOUT_MS = 2000;

type Emit = (payload: SessionEventPayload) => void;
type EmitPending = (payload: PendingRequestPayload) => void;

interface Entry {
  session: CopilotSession;
  unsubscribe: () => void;
  /// Absolute working directory passed to `createSession` /
  /// `resumeSession`. Cached here because the SDK doesn't expose
  /// `session.workingDirectory` or a getter — and the workspace
  /// catalog (`client.listSessions()`) doesn't always contain a
  /// freshly-created session or its `cwd` field. The composer's
  /// @file picker needs this to resolve relative paths.
  workingDirectory?: string;
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();

  /// Pending SDK callbacks. Owned by the queue subobject so the
  /// extraction can be unit-tested in isolation and so the registry
  /// stays focused on session lifecycle. The queue knows nothing
  /// about approve-all (the handler short-circuits before reaching
  /// it) or the registry's entry map (callers must call
  /// `pending.settleForSession` BEFORE deleting their entry).
  private readonly pending = new PendingRequestQueue();

  /// Registry-owned per-session "approve every permission" toggle.
  /// Mirrors the SDK's `setApproveAll` (which we still call when
  /// the renderer toggles it, for any SDK-internal short-circuits),
  /// but is the authoritative source for OUR `onPermissionRequest`
  /// handler — without this, a renderer-side toggle wouldn't affect
  /// the dafman handler path.
  private readonly approveAllBySession = new Map<string, boolean>();
  private readonly modeBySession = new Map<string, SessionMode>();
  private readonly agentDiagnosticsBySession = new Map<string, AgentLoadDiagnostics>();

  /// Context port shared with sibling services (Phase D.3). Holds
  /// `getEntry` and `wrapSdk` so services don't import the entries
  /// Map directly. Set in the constructor body because both
  /// closures reference `this`.
  private readonly serviceCtx: SessionServiceContext;
  private readonly plans: SessionPlanService;
  private readonly skills: SessionSkillsService;
  private readonly tasks: SessionTasksService;
  private readonly agents: SessionAgentsService;
  private readonly mcp: SessionMcpService;
  private readonly forwarder: SessionEventForwarder;
  private readonly metadata: SessionMetadataService;

  /// `streamingResolver` is called at session create/resume time to
  /// pick the current SDK streaming mode. Decoupled from on-disk
  /// settings so this module stays framework-agnostic (per AGENTS.md
  /// `src-bun/app/` rule). The default `() => true` preserves the
  /// pre-toggle behavior when the registry is constructed by tests
  /// that don't care about the setting.
  constructor(
    private readonly emit: Emit,
    private readonly emitPending: EmitPending = () => {},
    private readonly streamingResolver: () => boolean = () => true,
    private readonly excludedToolsResolver: () => string[] = () => [],
    /// 22b: per-session allowlist source. Empty array means "no
    /// restriction" — we omit `availableTools` from the SDK config
    /// entirely in that case (passing an empty array would tell
    /// the SDK to allow no tools at all, per the SDK docs).
    private readonly allowedToolsResolver: () => string[] = () => [],
  ) {
    this.serviceCtx = {
      getEntry: (sessionId) => this.getEntryOrThrow(sessionId),
      getAgentLoadDiagnostics: (sessionId) => this.agentDiagnosticsBySession.get(sessionId),
      wrapSdk: wrapSdkError,
    };
    this.plans = new SessionPlanService(this.serviceCtx);
    this.skills = new SessionSkillsService(this.serviceCtx);
    this.tasks = new SessionTasksService(this.serviceCtx, () => this.entries.keys());
    this.agents = new SessionAgentsService(this.serviceCtx);
    this.mcp = new SessionMcpService(this.serviceCtx);
    this.forwarder = new SessionEventForwarder({
      emit: this.emit,
      modeBySession: this.modeBySession,
      pending: this.pending,
    });
    this.metadata = new SessionMetadataService({
      ctx: this.serviceCtx,
      approveAllBySession: this.approveAllBySession,
      modeBySession: this.modeBySession,
      pending: this.pending,
    });
  }

  /// Lookup helper shared with sibling services through `serviceCtx`.
  /// Throws `AppError.sessionNotFound` so the previous behavior of
  /// every per-session method (`if (!entry) throw …`) is preserved
  /// without re-inlining the check at every call site.
  private getEntryOrThrow(sessionId: string): SessionEntryView {
    const entry = this.entries.get(sessionId);

    if (!entry) throw AppError.sessionNotFound(sessionId);

    return entry;
  }

  /// Returns the live `CopilotSession` for an id, or undefined if the
  /// session is unknown. Used by built-in tools (see `app/tools.ts`)
  /// that need to call `session.ui.*` from a tool handler.
  public sessionFor(id: string): CopilotSession | undefined {
    return this.entries.get(id)?.session;
  }

  /// Config shared between `create()` and `resume()` so a resumed
  /// session behaves identically to a freshly created one
  /// (permission handler, streaming mode, etc.). Delegates to
  /// `sessionConfigBuilder` — the registry just wires in its
  /// closures + per-session maps.
  private baseSessionConfig(sessionId: () => string) {
    return buildBaseSessionConfig(
      {
        tools: buildBuiltInTools(this),
        emit: this.emit,
        emitPending: this.emitPending,
        approveAllBySession: this.approveAllBySession,
        modeBySession: this.modeBySession,
        pending: this.pending,
        streamingResolver: this.streamingResolver,
        excludedToolsResolver: this.excludedToolsResolver,
        allowedToolsResolver: this.allowedToolsResolver,
      },
      sessionId,
    );
  }

  /// Renderer → bun: respond to a pending callback. Idempotent: a
  /// double-submit on an already-resolved request returns `false`
  /// instead of throwing. Delegates to the queue subobject.
  async respondToRequest(params: RespondToRequestParams): Promise<boolean> {
    return this.pending.respond(params);
  }

  async create(
    opts: {
      workingDirectory?: string;
      model?: string;
      reasoningEffort?: string;
    } = {},
  ): Promise<string> {
    const client = tryGetClient();
    // S2: buffer events that fire BEFORE `createSession` resolves
    // (the SDK's `session.start` event can fire during creation).
    // Forwarding under a literal "pending" placeholder would orphan
    // those events on the renderer side, which keys its pending-
    // events buffer by sessionId. Drain to the real id after.
    let resolvedSessionId: string | null = null;
    const earlyEventBuffer: SessionEvent[] = [];
    const earlyForward = (event: SessionEvent) => {
      if (resolvedSessionId !== null) {
        this.forward(resolvedSessionId, event);
      } else {
        earlyEventBuffer.push(event);
      }
    };
    const wd = opts.workingDirectory?.trim();
    const session = await client.createSession({
      ...this.baseSessionConfig(() => resolvedSessionId ?? 'pending'),
      onEvent: earlyForward,
      ...(wd ? { workingDirectory: wd } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort as ReasoningEffort } : {}),
    });
    const sessionId = session.sessionId;

    resolvedSessionId = sessionId;
    // `onEvent` is one-shot for the early window; switch to `session.on`
    // for the live stream and grab its unsubscribe handle.
    const unsubscribe = session.on((event) => {
      this.forward(sessionId, event);
    });

    this.entries.set(sessionId, { session, unsubscribe, ...(wd ? { workingDirectory: wd } : {}) });
    this.modeBySession.set(sessionId, 'interactive');

    // Drain anything that fired during the createSession await.
    for (const event of earlyEventBuffer) this.forward(sessionId, event);

    log.info('session created', { sessionId, workingDirectory: wd ?? null });

    return sessionId;
  }

  /// Resumes a previously-created session by id. After resume succeeds
  /// we immediately replay `session.getEvents()` through the same
  /// forwarder so the frontend reducer rebuilds its transcript from
  /// scratch — the SDK's `session.on` does NOT replay history on its
  /// own, so without this the restored pane would render empty until
  /// the next turn.
  ///
  /// Idempotent: a duplicate resume of an already-registered id is a
  /// no-op (returns the same id).
  async resume(
    sessionId: string,
    opts: { model?: string; reasoningEffort?: string; workingDirectory?: string } = {},
  ): Promise<string> {
    if (this.entries.has(sessionId)) {
      log.debug('resume on already-registered session, returning id', {
        sessionId,
      });

      return sessionId;
    }

    const client = tryGetClient();
    // Look up the persisted cwd + title BEFORE resume so we can hand
    // them back to the SDK / UI explicitly (see readPersistedMeta).
    const { cwd: persistedCwd, summary: persistedSummary } =
      await this.readPersistedMeta(sessionId);

    const effectiveCwd = opts.workingDirectory ?? persistedCwd;
    let resolvedSessionId: string | null = null;
    const earlyForward = (event: SessionEvent) => {
      this.forward(resolvedSessionId ?? sessionId, event);
    };
    let session: CopilotSession;

    try {
      session = await client.resumeSession(sessionId, {
        ...this.baseSessionConfig(() => resolvedSessionId ?? sessionId),
        onEvent: earlyForward,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningEffort
          ? { reasoningEffort: opts.reasoningEffort as ReasoningEffort }
          : {}),
        ...(effectiveCwd ? { workingDirectory: effectiveCwd } : {}),
      });
    } catch (err) {
      const message = toErrorMessage(err);

      log.warn('session resume failed', { sessionId, error: message });
      throw AppError.sdk(message);
    }

    const actualId = session.sessionId;

    resolvedSessionId = actualId;
    const unsubscribe = session.on((event) => {
      this.forward(actualId, event);
    });

    this.entries.set(actualId, {
      session,
      unsubscribe,
      ...(effectiveCwd ? { workingDirectory: effectiveCwd } : {}),
    });
    this.modeBySession.set(actualId, 'interactive');

    // Emit the persisted title eagerly — before the (potentially
    // slow) history replay — so the tab + sidebar show the right
    // name immediately. The post-resume `pollTitleFromMetadata`
    // below is the safety net for sessions that didn't have a
    // summary at metadata-read time.
    if (persistedSummary) {
      this.emit({
        sessionId: actualId,
        eventType: 'session.title_changed',
        data: { title: persistedSummary },
      });
    }

    // Hydrate transcript. Failures here aren't fatal — the session is
    // connected and will receive live events; we just won't have the
    // scrollback.
    await this.hydrateHistory(session, actualId, effectiveCwd);

    // Poll the title immediately after resume so restored sessions show
    // their persisted title without needing a new turn (session.idle).
    this.forwarder.pollTitleFromMetadata(actualId);

    return actualId;
  }

  /// Reads the persisted cwd + title from the SDK's on-disk catalog
  /// before resume. The SDK is supposed to remember the cwd, but we hit
  /// a prod bug where resumed sessions ended up with `process.cwd()`
  /// (the Electrobun exe folder); pinning the catalog value here closes
  /// that gap. The summary is grabbed eagerly so the tab + sidebar show
  /// the right title immediately rather than waiting for the post-resume
  /// re-poll (which only fires AFTER replayHistory — 100s of ms on long
  /// sessions). Non-fatal: returns `{}` if the metadata read throws.
  private async readPersistedMeta(sessionId: string): Promise<{ cwd?: string; summary?: string }> {
    try {
      const meta = await tryGetClient().getSessionMetadata(sessionId);
      const result: { cwd?: string; summary?: string } = {};

      if (meta?.context?.workingDirectory) result.cwd = meta.context.workingDirectory;

      if (typeof meta?.summary === 'string' && meta.summary.trim()) {
        result.summary = meta.summary;
      }

      return result;
    } catch {
      return {};
    }
  }

  /// Hydrates the renderer transcript from persisted history after a
  /// resume.
  ///
  /// S5: caps history at the last `HISTORY_REPLAY_CAP` events to avoid
  /// blocking the event loop on long-lived sessions; `replayHistory`
  /// chunks the replay so the renderer can paint between batches.
  ///
  /// #20: if the replayed slice ends mid-turn (app exited while the
  /// agent was thinking), appends a synthetic terminator as the last
  /// replayed event so the renderer reducer clears its stuck
  /// `isThinking`. A NEW array is built — `capped` may alias the
  /// original history (when total <= cap), which must not be mutated.
  ///
  /// Non-fatal: a failure just means no scrollback (the live session is
  /// already connected and will receive new events).
  private async hydrateHistory(
    session: CopilotSession,
    actualId: string,
    effectiveCwd: string | undefined,
  ): Promise<void> {
    try {
      const history = await session.getEvents();
      const total = history.length;
      const capped =
        total > HISTORY_REPLAY_CAP ? history.slice(total - HISTORY_REPLAY_CAP) : history;
      const replay = historyEndsMidTurn(capped) ? [...capped, RESUME_SETTLED_EVENT] : capped;

      await this.replayHistory(actualId, replay);
      log.info('session resumed', {
        sessionId: actualId,
        historyCount: total,
        replayedCount: capped.length,
        settledMidTurn: replay.length > capped.length,
        workingDirectory: effectiveCwd ?? null,
      });
    } catch (err) {
      log.warn('failed to hydrate session history', {
        sessionId: actualId,
        error: toErrorMessage(err),
      });
    }
  }

  async getCurrentModel(sessionId: string): Promise<string | null> {
    return this.metadata.getCurrentModel(sessionId);
  }

  /// S5 helper: replays history events to `forward` in
  /// HISTORY_REPLAY_BATCH-sized batches separated by microtasks so the
  /// event loop yields between chunks. Returns when every event has
  /// been forwarded.
  private async replayHistory(
    sessionId: string,
    events: ReadonlyArray<SessionEvent>,
  ): Promise<void> {
    for (let i = 0; i < events.length; i += HISTORY_REPLAY_BATCH) {
      const chunk = events.slice(i, i + HISTORY_REPLAY_BATCH);

      for (const event of chunk) this.forward(sessionId, event);

      if (i + HISTORY_REPLAY_BATCH < events.length) {
        await new Promise<void>((r) => queueMicrotask(r));
      }
    }
  }

  async setWorkingDirectory(
    sessionId: string,
    workingDirectory: string,
    baseWorkingDirectory?: string | null,
  ): Promise<string> {
    const entry = this.entries.get(sessionId);

    if (!entry) throw AppError.sessionNotFound(sessionId);

    const requested = workingDirectory.trim();

    if (!requested) throw AppError.sdk('workingDirectory is required');

    const base = baseWorkingDirectory?.trim() || process.cwd();
    const next = isAbsolute(requested) ? requested : resolve(base, requested);
    let info: Awaited<ReturnType<typeof stat>>;

    try {
      info = await stat(next);
    } catch {
      throw AppError.sdk(`workingDirectory does not exist: ${next}`);
    }

    if (!info.isDirectory()) {
      throw AppError.sdk(`workingDirectory is not a directory: ${next}`);
    }

    // S3: settle pending FIRST, unsubscribe FIRST, but keep the entry
    // in the map until disconnect resolves. Concurrent RPCs see the
    // entry as live during the disconnect window and get a
    // predictable SessionNotFound after, instead of mid-teardown.
    this.pending.settleForSession(sessionId, 'session working directory changed');
    entry.unsubscribe();

    try {
      await entry.session.disconnect();
    } catch (err) {
      log.warn('disconnect-before-cwd-change threw', {
        sessionId,
        error: toErrorMessage(err),
      });
    }

    this.entries.delete(sessionId);

    const client = tryGetClient();
    let resumed: CopilotSession;

    try {
      resumed = await client.resumeSession(sessionId, {
        ...this.baseSessionConfig(() => sessionId),
        workingDirectory: next,
      });
    } catch (err) {
      throw AppError.sdk(toErrorMessage(err));
    }

    const actualId = resumed.sessionId;
    const unsubscribe = resumed.on((event) => {
      this.forward(actualId, event);
    });

    this.entries.set(actualId, { session: resumed, unsubscribe, workingDirectory: next });
    log.info('session working directory changed', {
      sessionId: actualId,
      workingDirectory: next,
    });

    return next;
  }

  async list(): Promise<SessionMetadataSummary[]> {
    const client = tryGetClient();
    const items = await client.listSessions();

    return items.map((m) => {
      const localEntry = this.entries.get(m.sessionId);

      return {
        sessionId: m.sessionId,
        startTime: m.startTime instanceof Date ? m.startTime.toISOString() : String(m.startTime),
        modifiedTime:
          m.modifiedTime instanceof Date ? m.modifiedTime.toISOString() : String(m.modifiedTime),
        summary: m.summary,
        isRemote: m.isRemote,
        // Enrich cwd from our local entry if the SDK catalog doesn't
        // include it — the SDK sometimes drops context.workingDirectory.
        cwd: m.context?.workingDirectory ?? localEntry?.workingDirectory,
        repository: m.context?.repository,
        branch: m.context?.branch,
      };
    });
  }

  /// Permanently deletes the CLI-side session data. If the session is
  /// currently open in this app, disconnect it first so the SDK can
  /// release its session handle cleanly before deletion.
  async deleteCliSession(sessionId: string): Promise<string> {
    // Settle any pending callbacks first so the SDK doesn't hang
    // awaiting a response that will never come once the session is
    // gone.
    this.pending.settleForSession(sessionId, 'session deleted');
    const entry = this.entries.get(sessionId);

    if (entry) {
      entry.unsubscribe();

      try {
        await entry.session.disconnect();
      } catch (err) {
        log.warn('disconnect-before-delete threw', {
          sessionId,
          error: toErrorMessage(err),
        });
      }

      // S3: delete AFTER disconnect resolves. Concurrent RPCs see
      // the entry as live during the disconnect window so they
      // can fail predictably with SessionNotFound after, rather
      // than mid-teardown.
      this.entries.delete(sessionId);
    }

    this.approveAllBySession.delete(sessionId);
    this.agentDiagnosticsBySession.delete(sessionId);
    const client = tryGetClient();

    try {
      await client.deleteSession(sessionId);
    } catch (err) {
      throw AppError.sdk(toErrorMessage(err));
    }

    log.info('session deleted', { sessionId });

    return sessionId;
  }

  /// After each turn (session.idle), fetch the session's metadata
  /// to get the auto-summarised title. The CLI sets the title via
  /// workspace rename but may not always emit `session.title_changed`
  /// to the SDK (e.g. when workspaces are disabled or ephemeral events
  /// are lost). Polling metadata is a reliable fallback.
  /// Transform + emit one SDK event. Delegates to
  /// `SessionEventForwarder` — the registry only owns the
  /// `session.on(...)` subscription that calls this.
  private forward(sessionId: string, event: SessionEvent): void {
    this.captureAgentLoadDiagnostics(sessionId, event);
    this.forwarder.forward(sessionId, event);
  }

  private captureAgentLoadDiagnostics(sessionId: string, event: SessionEvent): void {
    if (event.type !== 'session.custom_agents_updated') return;

    const data = (event as { data?: unknown }).data;

    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    const record = data as { errors?: unknown; warnings?: unknown };

    this.agentDiagnosticsBySession.set(sessionId, {
      errors: Array.isArray(record.errors)
        ? record.errors.filter((item): item is string => typeof item === 'string')
        : [],
      warnings: Array.isArray(record.warnings)
        ? record.warnings.filter((item): item is string => typeof item === 'string')
        : [],
    });
  }

  async send(
    sessionId: string,
    text: string,
    mode?: 'enqueue' | 'immediate',
    attachments?: SendMessageAttachment[],
    agentMode?: SessionMode,
  ): Promise<string> {
    const entry = this.entries.get(sessionId);

    if (!entry) throw AppError.sessionNotFound(sessionId);

    if (attachments && attachments.length > 0) {
      log.info('session.send with attachments', {
        sessionId,
        attachmentCount: attachments.length,
        kinds: attachments.map((a) => a.type),
        // Log just the type+displayName so we don't dump base64
        // blobs into the log file.
        names: attachments.map((a) => ('displayName' in a ? a.displayName : null)),
      });
    }

    try {
      const sdkAttachments = (attachments ?? []).map((attachment) =>
        attachment.type === 'commandResult'
          ? commandResultBlobAttachment(attachment.result, attachment.displayName)
          : attachment,
      );

      // #35: pass per-message agentMode through to the SDK. Defaults
      // to the session-wide mode (the toggle stays the source of
      // truth); an explicit override scopes the mode to this one send.
      const effectiveAgentMode = agentMode ?? this.modeBySession.get(sessionId) ?? 'interactive';

      return await entry.session.send({
        prompt: text,
        agentMode: effectiveAgentMode,
        ...(mode ? { mode } : {}),
        ...(sdkAttachments && sdkAttachments.length > 0
          ? {
              attachments: sdkAttachments,
            }
          : {}),
      });
    } catch (err) {
      throw AppError.sdk(toErrorMessage(err));
    }
  }

  /// File-typeahead search backing the composer's `@file` picker.
  /// Resolves the session's working directory and delegates to the
  /// shared workspace-files index (`app/fileSearch.ts`).
  async searchWorkspaceFiles(
    sessionId: string,
    query: string,
    limit = 40,
    options: { includeHidden?: boolean; includeIgnored?: boolean } = {},
  ): Promise<WorkspaceFileMatch[]> {
    const entry = this.entries.get(sessionId);

    if (!entry) return [];

    const cwd = await this.cwdFor(sessionId);

    if (!cwd) {
      log.warn('searchWorkspaceFiles: cwd unresolved', { sessionId });

      return [];
    }

    return searchWorkspaceFiles(cwd, query, limit, options);
  }

  /// Public accessor for the session's resolved working directory.
  /// Used by RPC handlers (resumeSession surfaces this to the
  /// renderer so the workspace chip stays accurate after restart).
  async getCwd(sessionId: string): Promise<string | undefined> {
    return this.cwdFor(sessionId);
  }

  /// Resolve the session's working directory. Reads from our entry
  /// (set at create/resume time — see `resume()` which actively
  /// pulls the persisted cwd from `getSessionMetadata` and pins it
  /// on the SDK call so the SDK can't drift to its default), then
  /// the catalog as a fallback. Returns undefined if neither
  /// source has a cwd — we deliberately DO NOT fall back to
  /// `process.cwd()` because that silently substitutes the
  /// Electrobun exe folder in prod, which produced the v1 export
  /// regression where every session reported the binary's `bin/`
  /// dir as its workspace.
  /// Backfill the entry's cached `workingDirectory` from a freshly-
  /// resolved cwd. Re-checks the live entry post-await per the U6
  /// invariant: a concurrent `cwdFor` / `setWorkingDirectory` may
  /// have already backfilled while we awaited, in which case we
  /// must not overwrite with a stale value.
  private adoptCwd(sessionId: string, candidate: string | undefined): string | undefined {
    if (!candidate) return undefined;

    const current = this.entries.get(sessionId);

    if (current?.workingDirectory) return current.workingDirectory;

    if (current) current.workingDirectory = candidate;

    return candidate;
  }

  private async cwdFor(sessionId: string): Promise<string | undefined> {
    const entry = this.entries.get(sessionId);

    if (entry?.workingDirectory) return entry.workingDirectory;

    const client = tryGetClient();

    if (!client) return undefined;

    try {
      const meta = await client.getSessionMetadata(sessionId);
      const adopted = this.adoptCwd(sessionId, meta?.context?.workingDirectory);

      if (adopted) return adopted;
    } catch {
      /* fall through to listSessions */
    }

    try {
      const summaries = await client.listSessions();
      const summary = summaries.find((s) => s.sessionId === sessionId);
      const adopted = this.adoptCwd(sessionId, summary?.context?.workingDirectory);

      if (adopted) return adopted;
    } catch {
      /* non-fatal */
    }

    return undefined;
  }

  async abort(sessionId: string): Promise<string> {
    return this.metadata.abort(sessionId);
  }

  async setModel(
    sessionId: string,
    model: string,
    reasoningEffort: string | null,
  ): Promise<string> {
    return this.metadata.setModel(sessionId, model, reasoningEffort);
  }

  async getMode(sessionId: string): Promise<SessionMode> {
    return this.metadata.getMode(sessionId);
  }

  async setMode(sessionId: string, mode: SessionMode): Promise<SessionMode> {
    return this.metadata.setMode(sessionId, mode);
  }

  async getName(sessionId: string): Promise<string | null> {
    return this.metadata.getName(sessionId);
  }

  async setName(sessionId: string, name: string): Promise<string> {
    return this.metadata.setName(sessionId, name);
  }

  async compactHistory(sessionId: string): Promise<SessionHistoryCompactionResult> {
    return this.metadata.compactHistory(sessionId);
  }

  /// Wraps `session.history.truncate`. The given event AND all later
  /// events are removed; callers typically follow this with a fresh
  /// `sendMessage` (Edit / Retry flows).
  async truncateHistory(sessionId: string, eventId: string): Promise<{ eventsRemoved: number }> {
    return this.metadata.truncateHistory(sessionId, eventId);
  }

  /// Wraps `sessions.fork`. Returns the new session id; we do NOT
  /// auto-register it — the renderer opens it via the regular
  /// resume flow once it has the id (keeps lifecycle uniform).
  async fork(sessionId: string, toEventId?: string): Promise<{ sessionId: string }> {
    return this.metadata.fork(sessionId, toEventId);
  }

  async setApproveAll(sessionId: string, enabled: boolean): Promise<boolean> {
    return this.metadata.setApproveAll(sessionId, enabled);
  }

  // ---------- Custom agents (Phase 19a) ----------
  //
  // SDK auto-discovers custom agents from `~/.copilot/agents/` (user
  // config) and `<workingDirectory>/.github/agents/` (project) when
  // `enableConfigDiscovery: true` is set in baseSessionConfig (which
  // we have). We don't need our own scanner — these methods just
  // wrap the @experimental `session.rpc.agent.*` surface.
  //
  // Wire shape per @github/copilot/schemas/api.schema.json#AgentInfo:
  // { name: string, displayName: string, description: string, path?: string }
  // `path` is set for file-based agents (we can derive "Project" vs
  // "User" source by checking if path contains `.github/agents/`).

  async listAgents(sessionId: string): Promise<AgentInfo[]> {
    return this.agents.list(sessionId);
  }

  async getCurrentAgent(sessionId: string): Promise<AgentInfo | null> {
    return this.agents.getCurrent(sessionId);
  }

  async selectAgent(sessionId: string, name: string): Promise<AgentInfo> {
    return this.agents.select(sessionId, name);
  }

  async deselectAgent(sessionId: string): Promise<boolean> {
    return this.agents.deselect(sessionId);
  }

  async reloadAgents(sessionId: string): Promise<AgentInfo[]> {
    return this.agents.reload(sessionId);
  }

  // ---------- Tasks (Phase 19b.1) ----------
  //
  // Wraps the @experimental `session.rpc.tasks.*` surface. Tasks may be
  // delegated agents or long-running shell tasks. The details rail and
  // global Jobs panel both consume this normalized union.

  async listTasks(sessionId: string): Promise<TaskInfo[]> {
    return this.tasks.list(sessionId);
  }

  async listJobs(): Promise<JobRecord[]> {
    return this.tasks.listJobs();
  }

  async cancelTask(sessionId: string, id: string): Promise<boolean> {
    return this.tasks.cancel(sessionId, id);
  }

  async removeTask(sessionId: string, id: string): Promise<boolean> {
    return this.tasks.remove(sessionId, id);
  }

  async promoteTask(sessionId: string, id: string): Promise<boolean> {
    return this.tasks.promote(sessionId, id);
  }

  // ---------- Fleet (Phase 19c) ----------

  async startFleet(sessionId: string, prompt?: string): Promise<boolean> {
    return this.tasks.startFleet(sessionId, prompt);
  }

  // ---------- Agent files CRUD (Phase 19b.2) ----------
  //
  // Filesystem-level wrappers around `src-bun/app/agentFiles.ts`.
  // Distinct from the @experimental `session.rpc.agent.*` surface
  // (which only sees what the SDK loaded) — these wrappers give
  // the Library tab the ability to enumerate / create / delete
  // agent definitions directly. Workspace path resolution uses
  // the entry's cached `workingDirectory`, so a session must
  // exist for Project-scope writes (User scope doesn't need one
  // — see `listAgentFilesGlobal`).

  async listAgentFiles(
    sessionId: string,
    options: { reloadSdk?: boolean } = {},
  ): Promise<
    Array<{
      scope: AgentFileScope;
      name: string;
      path: string;
      canonical: boolean;
      loadStatus: 'loaded' | 'rejected' | 'unknown';
      loadMessage?: string;
      loadWarnings?: string[];
    }>
  > {
    return this.agents.listFiles(sessionId, options);
  }

  /// User-scope only — for the Library tab when no session is
  /// open. Doesn't require sessionId / workingDirectory.
  async listAgentFilesGlobal(): Promise<
    Array<{
      scope: AgentFileScope;
      name: string;
      path: string;
      canonical: boolean;
      loadStatus: 'loaded' | 'rejected' | 'unknown';
      loadMessage?: string;
      loadWarnings?: string[];
    }>
  > {
    return this.agents.listFilesGlobal();
  }

  async writeAgentFile(
    sessionId: string,
    spec: AgentFileSpec,
    options: { allowOverwrite?: boolean; preservedTail?: string } = {},
  ): Promise<string> {
    return this.agents.writeFile(sessionId, spec, options);
  }

  async readAgentFile(
    sessionId: string,
    scope: AgentFileScope,
    name: string,
  ): Promise<{
    spec: Partial<AgentFileSpec>;
    prompt: string;
    preservedTail: string;
    path: string;
  }> {
    return this.agents.readFile(sessionId, scope, name);
  }

  async deleteAgentFile(sessionId: string, scope: AgentFileScope, name: string): Promise<boolean> {
    return this.agents.deleteFile(sessionId, scope, name);
  }

  /// Lists session skills (name, description, enabled, source).
  /// The popover renders a toggle per skill so the user can flip
  /// any skill on/off mid-session. Errors are wrapped — skill APIs
  /// are @experimental in the SDK; if they aren't wired the renderer
  /// surfaces a toast and falls back to an empty list.
  async listSkills(sessionId: string): Promise<
    Array<{
      name: string;
      description: string;
      source: string;
      enabled: boolean;
      userInvocable: boolean;
      path?: string;
    }>
  > {
    return this.skills.list(sessionId);
  }

  async setSkillEnabled(sessionId: string, name: string, enabled: boolean): Promise<boolean> {
    return this.skills.setEnabled(sessionId, name, enabled);
  }

  /// Per-session usage metrics. Returns the raw SDK response shape
  /// (totals + per-model + token details) without filtering — the
  /// renderer cherry-picks what to display.
  async getUsageMetrics(sessionId: string): Promise<Record<string, unknown>> {
    return this.metadata.getUsageMetrics(sessionId);
  }

  /// Server-scoped: built-in tool catalog. Returns a trimmed view
  /// (name + namespacedName + description) — the renderer doesn't
  /// need the full JSON schema.
  async listBuiltinTools(): Promise<
    Array<{ name: string; namespacedName?: string; description: string }>
  > {
    return this.metadata.listBuiltinTools();
  }

  /// Session-scoped: MCP server list. Per-server tool lists are
  /// Session-scoped per-MCP server state. Captures less detail than
  /// the server-scoped catalog — only name/status/source/error.
  async listSessionMcpServers(
    sessionId: string,
  ): Promise<Array<{ name: string; status: string; source?: string; error?: string }>> {
    return this.mcp.listServers(sessionId);
  }

  async setSessionMcpEnabled(
    sessionId: string,
    serverName: string,
    enabled: boolean,
  ): Promise<boolean> {
    return this.mcp.setEnabled(sessionId, serverName, enabled);
  }

  async getAccountQuota(): Promise<
    Record<
      string,
      {
        isUnlimitedEntitlement: boolean;
        entitlementRequests: number;
        usedRequests: number;
        remainingPercentage: number;
        overage: number;
        resetDate?: string;
      }
    >
  > {
    return this.metadata.getAccountQuota();
  }

  async readPlan(
    sessionId: string,
  ): Promise<{ exists: boolean; content: string | null; path: string | null }> {
    return this.plans.read(sessionId);
  }

  async writePlan(sessionId: string, content: string): Promise<boolean> {
    return this.plans.write(sessionId, content);
  }

  async deletePlan(sessionId: string): Promise<boolean> {
    return this.plans.delete(sessionId);
  }

  // ---------- MCP config registry (server-scoped, Phase 19a) ----------
  //
  // Moved to `./mcpRegistry.ts` (21a.2). Server-scoped MCP methods
  // don't touch the entries Map and shouldn't live on the session
  // registry. RPC layer calls `mcpRegistry.X` directly. The 3
  // session-scoped MCP methods (listSessionMcpServers,
  // setSessionMcpEnabled, loginToMcpServer) remain below because
  // they need entry lookup.

  async loginToMcpServer(
    sessionId: string,
    serverName: string,
    opts: { forceReauth?: boolean; clientName?: string } = {},
  ): Promise<{ authorizationUrl: string | null }> {
    return this.mcp.loginToServer(sessionId, serverName, opts);
  }

  // ---------- Skills registry (server-scoped, Phase 19b) ----------
  //
  // Moved to `./skillsRegistry.ts` (21a.3). The 2 session-scoped
  // skill methods (listSkills, setSkillEnabled) remain above in this
  // file because they need entries Map lookup.

  async resetApprovals(sessionId: string): Promise<boolean> {
    return this.metadata.resetApprovals(sessionId);
  }

  async disconnect(sessionId: string): Promise<string> {
    const entry = this.entries.get(sessionId);

    if (!entry) throw AppError.sessionNotFound(sessionId);

    // Settle pending callbacks BEFORE tearing down the session so
    // the SDK never sees a hung onPermissionRequest / etc.
    this.pending.settleForSession(sessionId, 'session disconnected');
    this.approveAllBySession.delete(sessionId);
    this.agentDiagnosticsBySession.delete(sessionId);
    entry.unsubscribe();

    try {
      await entry.session.disconnect();
    } catch (err) {
      log.warn('session disconnect threw', {
        sessionId,
        error: toErrorMessage(err),
      });
    }

    // S3: delete AFTER disconnect so concurrent RPCs see the entry
    // as live during the disconnect window.
    this.entries.delete(sessionId);
    log.info('session closed', { sessionId });

    return 'Session closed successfully';
  }

  /// S1: bounded teardown for app quit. Settles every pending callback
  /// across all sessions first (so the SDK doesn't sit on hung
  /// handlers), then disconnects each session with a 2s timeout per.
  /// On timeout we force-clear the entry; the OS process exit handles
  /// the rest. Best-effort: errors are logged, never thrown — the
  /// caller is on the way out anyway.
  async shutdownAll(): Promise<void> {
    // Settle every pending callback first as a belt-and-suspenders.
    // Each per-session disconnect below also settles, but doing it
    // up-front ensures even sessions whose disconnect hangs (and
    // gets force-cleared below) don't leave dangling Promises.
    this.pending.settleAll('app shutdown');
    const ids = [...this.entries.keys()];

    for (const id of ids) {
      const entry = this.entries.get(id);

      if (!entry) continue;

      try {
        entry.unsubscribe();
      } catch {
        /* best-effort */
      }

      try {
        await Promise.race([
          entry.session.disconnect(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('disconnect timeout')), SHUTDOWN_TIMEOUT_MS),
          ),
        ]);
      } catch (err) {
        log.warn('shutdown disconnect timed out or threw', {
          sessionId: id,
          error: toErrorMessage(err),
        });
      }

      this.entries.delete(id);
      this.approveAllBySession.delete(id);
      this.agentDiagnosticsBySession.delete(id);
    }
  }
}
