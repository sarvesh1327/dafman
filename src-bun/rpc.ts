// Shared RPC contract between the Bun main process and the Vue webview.
//
// The `bun.requests` half lists every command the frontend can invoke
// (the rough equivalent of the Tauri `CommandMap`); `bun.messages` are
// fire-and-forget pushes from bun to the webview — we use a single
// `sessionEvent` channel and route by `sessionId` on the frontend,
// replacing Tauri's per-session `Channel<SessionEventPayload>`.
//
// Keep this file the single source of truth — both `src-bun/index.ts`
// and `src/ipc/invoke.ts` import the type from here.

import type { RPCSchema } from 'electrobun/bun';
import type { AppErrorPayload } from './app/shared/errors';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ReasoningVisibility = 'hidden' | 'compact' | 'expanded';

/// Agent run mode, mirrors the SDK `SessionMode` union.
/// "interactive" prompts for permission per action; "plan" stays in
/// read-only planning mode; "autopilot" runs unattended.
export type SessionMode = 'interactive' | 'plan' | 'autopilot';

export interface SessionHistoryCompactionResult {
  /// Whether compaction completed successfully.
  success: boolean;
  /// Tokens freed by compaction (when available).
  tokensFreed: number | null;
  /// Number of messages removed during compaction (when available).
  messagesRemoved: number | null;
}

export interface Appearance {
  theme: ThemeChoice;
  reasoningVisibility: ReasoningVisibility;
  /// Default model id for newly-created sessions. Empty means let the
  /// SDK/CLI pick its own default.
  defaultModelId: string;
  /// Default reasoning effort for newly-created sessions. Null means
  /// use the selected model's default effort.
  defaultReasoningEffort: string | null;
  /// Whether the SDK streams `assistant.message_delta` events for
  /// the assistant's reply. `false` (default) renders only the
  /// final `assistant.message` per turn — feels less "live" but
  /// drops Lexical reconcile churn + per-delta jitter. `true`
  /// re-enables streaming (legacy behavior). Takes effect on the
  /// NEXT session created — existing sessions keep their original
  /// mode for their lifetime.
  streaming: boolean;
  /// Lazy-load mermaid + render ```mermaid``` code fences as
  /// diagrams. Default false to keep the main bundle slim; opt-in
  /// via Settings -> Appearance. When false, mermaid fences fall
  /// through to the standard syntax-highlighted code block.
  enableMermaid: boolean;
}

export interface Settings {
  version: number;
  appearance: Appearance;
  /// Persisted layout state. Only the dockview JSON is stored here —
  /// session content (transcripts, tool calls, …) lives CLI-side and
  /// is rehydrated via `client.resumeSession()` on startup. The
  /// dockview JSON is opaque to us; we never inspect or mutate it
  /// directly, just hand it back to `api.fromJSON()`.
  layout: Layout;
  /// Workspace MRU. Populated by the topbar's path input every time
  /// a session is successfully created with a non-empty
  /// `workingDirectory`. The most-recently-used path is at index 0.
  workspaces: Workspaces;
  /// OS-native notification preferences. Inner indicators (status
  /// dots on tabs + sidebar rows + composer banner) are always on
  /// — these toggles only gate when we actually call
  /// `new Notification()`.
  notifications: NotificationPrefs;
  /// Tool gating. `defaultExcluded` is applied at session create
  /// via `excludedTools` — the SDK does not support runtime
  /// mutation, so changes only take effect for newly created
  /// sessions. The renderer surfaces a "Restart session to apply"
  /// hint when a per-session toggle changes.
  tools: ToolsPrefs;
  /// Permission defaults. Currently just `defaultApproveAll`:
  /// when true, new sessions start with the per-session approve-all
  /// toggle on (every privileged tool call is auto-approved without
  /// a permission prompt). Off by default — explicit user choice.
  /// The SDK doesn't expose a list-approvals RPC, so we can't show
  /// what's been remembered; this is the only knob we can surface.
  permissions: PermissionsPrefs;
  terminal: TerminalPrefs;
}

export interface PermissionsPrefs {
  /// New sessions default approve-all to this value. Mirrored
  /// per-session via `setSessionApproveAll` immediately after
  /// `createSession` returns; the rail's toggle continues to drive
  /// the per-session state thereafter.
  defaultApproveAll: boolean;
}

export interface TerminalPrefs {
  defaultProfileId: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  theme: {
    background: string;
    foreground: string;
  };
  addons: TerminalAddonPrefs;
}

export interface TerminalAddonPrefs {
  search: boolean;
  webLinks: boolean;
  clipboard: boolean;
  unicode11: boolean;
  webFonts: boolean;
  progress: boolean;
  ligatures: boolean;
  image: boolean;
  unicodeGraphemes: boolean;
  webgl: boolean;
  serialize: boolean;
}

export interface ToolsPrefs {
  /// Tool names that should be excluded by default for new
  /// sessions. Matches by `Tool.namespacedName` when present,
  /// otherwise by `Tool.name` (renderer normalizes via
  /// `tool.namespacedName ?? tool.name`). Ignored at session-
  /// create time if `defaultAllowed` is non-empty (the SDK's
  /// `availableTools` takes precedence over `excludedTools`).
  defaultExcluded: string[];
  /// 22b: tool names to restrict the session to (allowlist).
  /// When non-empty, ONLY these tools are available — everything
  /// else is forbidden. Empty means "no restriction" (all tools
  /// allowed, modulo `defaultExcluded`). Same key format as
  /// `defaultExcluded` (`namespacedName ?? name`).
  defaultAllowed: string[];
}

export interface NotificationPrefs {
  /// Fire an OS notification when `assistant.turn_end` arrives on a
  /// session whose chat panel isn't the dock's active panel
  /// (and/or the app window isn't focused). Off by default —
  /// turn-end notifications are noisier than waiting-for-input.
  turnEnd: boolean;
  /// Fire an OS notification when the SDK is awaiting user input
  /// (permission.requested / user_input.requested /
  /// elicitation.requested) and the session isn't the active panel.
  /// On by default — this is the high-signal case.
  waitingForInput: boolean;
}

export interface GroupMeta {
  id: string;
  name: string;
  color: string;
}

export interface Layout {
  /// Serialized outer dockview state (`outer.api.toJSON()`). Renamed from
  /// v2's `dockview`. The v2->v3 migration wraps the old body into a
  /// single Default group on first save.
  outer?: unknown;
  groups?: GroupMeta[];
  activeGroupId?: string;
  innerBodies?: Record<string, unknown>;
  schemaVersion?: number;
  /// Legacy v2 field retained ONLY for hydration of pre-v3 layouts.
  dockview?: unknown;
}

export interface TerminalCreateParams {
  cwd?: string;
  shell?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  title?: string;
  sessionId?: string;
}

export interface TerminalSummary {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  args: string[];
  status: 'running' | 'exiting' | 'exited' | 'failed';
  createdAt: string;
  cols: number;
  rows: number;
  sessionId?: string;
  integrationNonce?: string;
  exitCode?: number | null;
  signal?: string | null;
}

export type TerminalEventPayload =
  | { terminalId: string; kind: 'output'; data: string }
  | { terminalId: string; kind: 'status'; summary: TerminalSummary }
  | { terminalId: string; kind: 'exit'; summary: TerminalSummary }
  | { terminalId: string; kind: 'error'; message: string };

export type CommandResultStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface CommandResultRecord {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  shell: string;
  status: CommandResultStatus;
  stdout: string;
  stderr: string;
  truncated: boolean;
  createdAt: string;
  completedAt?: string;
  exitCode?: number | null;
  durationMs?: number;
  displayName?: string;
}

export type CommandResultEvent =
  | {
      kind: 'started';
      sessionId: string;
      commandId: string;
      record: CommandResultRecord;
    }
  | {
      kind: 'stdout' | 'stderr';
      sessionId: string;
      commandId: string;
      data: string;
    }
  | {
      kind: 'truncated';
      sessionId: string;
      commandId: string;
      limitBytes: number;
    }
  | {
      kind: 'completed' | 'cancelled';
      sessionId: string;
      commandId: string;
      record: CommandResultRecord;
    };

export interface Workspaces {
  /// Most-recently-used absolute filesystem paths the user has spun
  /// sessions in. Capped at WORKSPACES_MRU_LIMIT (10) entries; head
  /// of the list is the most recent. Persisted as-is so the topbar
  /// AutoComplete can suggest from prior runs.
  recent: string[];
  /// Default workspace for newly-created sessions. Pre-populates the
  /// new-session form's path input. Resolved at startup to
  /// `<homedir>/dafman` (auto-created) when the user hasn't set one
  /// explicitly. May still be empty if home-directory resolution
  /// fails (e.g. headless test env) — the renderer treats empty as
  /// "no default" and leaves the input blank.
  defaultWorkspace: string;
}

export interface ModelSummary {
  id: string;
  name: string;
  supportsReasoningEffort: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

/// Summary of a CLI-side session, surfaced to the frontend for the
/// "recent sessions" picker and for startup-resume. Dates are
/// stringified (ISO 8601) so the wire payload is JSON-safe — the SDK
/// hands us `Date` objects but the RPC bridge will lose the type tag.
export interface SessionMetadataSummary {
  sessionId: string;
  startTime: string;
  modifiedTime: string;
  summary?: string;
  isRemote: boolean;
  cwd?: string;
  repository?: string;
  branch?: string;
}

/// Mirror of `@github/copilot/schemas/api.schema.json#AgentInfo`. The
/// shape the @experimental `session.rpc.agent.*` surface returns. The
/// `path` field is present for file-based agents (which is everything
/// we surface) and lets us derive a "Project" vs "User" source label
/// in the renderer by checking whether the path is under the working
/// directory's `.github/agents/` subtree vs the user's config dir.
export interface AgentInfo {
  name: string;
  displayName: string;
  description: string;
  path?: string;
}

export type TaskStatus = 'running' | 'idle' | 'completed' | 'failed' | 'cancelled';

interface BaseTaskInfo {
  id: string;
  type: 'agent' | 'shell';
  description: string;
  status: TaskStatus;
  startedAt?: string;
  completedAt?: string;
  activeTimeMs?: number;
  error?: string;
  executionMode?: 'sync' | 'background';
  canPromoteToBackground?: boolean;
}

/// Mirror of the SDK's TaskInfo union. Returned by the @experimental
/// `session.rpc.tasks.list` surface.
export type TaskInfo = TaskAgentInfo | TaskShellInfo;

export interface TaskAgentInfo extends BaseTaskInfo {
  type: 'agent';
  agentType: string;
  toolCallId?: string;
  agentName?: string;
  agentDisplayName?: string;
  prompt?: string;
  result?: string;
  model?: string;
  latestResponse?: string;
  idleSince?: string;
}

export interface TaskShellInfo extends BaseTaskInfo {
  type: 'shell';
  command: string;
  attachmentMode?: 'pty' | 'detached';
  logPath?: string;
  pid?: number;
}

export interface JobRecord {
  id: string;
  sessionId: string;
  source: 'sdk-task' | 'fleet' | 'autopilot-session';
  kind: 'agent' | 'shell' | 'fleet' | 'autopilot';
  status: 'starting' | TaskStatus;
  title: string;
  description: string;
  startedAt?: string;
  completedAt?: string;
  activeTimeMs?: number;
  agentType?: string;
  agentName?: string;
  agentDisplayName?: string;
  model?: string;
  prompt?: string;
  latestResponse?: string;
  result?: string;
  error?: string;
  toolCallId?: string;
  command?: string;
  logPath?: string;
  pid?: number;
  executionMode?: 'sync' | 'background';
  canCancel: boolean;
  canRemove: boolean;
  canPromoteToBackground: boolean;
  canOpenSession: boolean;
}

/// 19b.2: scope discriminator for filesystem-backed agent CRUD. User
/// scope writes to `~/.copilot/agents/`; project scope writes under
/// the session's workspace `.github/agents/`. Plugin and remote
/// agents are read-only from this surface (see src-bun/app/agentFiles.ts).
export type AgentFileScope = 'user' | 'project';

/// 19b.2: discovered agent file. Bun side enumerates these directly
/// from disk for the Library tab; distinct from the @experimental
/// `session.rpc.agent.list` surface (which only knows what the SDK
/// loaded).
export interface AgentFileEntry {
  scope: AgentFileScope;
  name: string;
  path: string;
  canonical: boolean;
  /// SDK load state for this file in the active session. `unknown`
  /// means no session-scoped SDK diagnostics are available (global
  /// Library view or SDK list failure).
  loadStatus: 'loaded' | 'rejected' | 'unknown';
  /// Actionable SDK/frontmatter validation message when `rejected`.
  loadMessage?: string;
  /// Non-fatal SDK warnings, such as ignored unknown frontmatter keys.
  loadWarnings?: string[];
}

export type InstructionScope = 'global' | 'project';

export interface InstructionSource {
  name: string;
  scope: InstructionScope;
  path: string;
  relativePath: string;
  exists: boolean;
  content: string | null;
  sizeBytes: number | null;
}

/// 19b.2: spec the renderer passes to `writeAgentFile`. Mirrors
/// `src-bun/app/agentFiles.ts:AgentFileSpec`. Only the simpler
/// frontmatter keys are exposed; advanced ones (`mcp-servers`,
/// `github`) are deferred to direct file edits.
export interface AgentFileSpec {
  scope: AgentFileScope;
  name: string;
  displayName?: string;
  description: string;
  tools?: string[];
  skills?: string[];
  model?: string;
  userInvocable?: boolean;
  prompt: string;
}

/// Subset of `MessageOptions.attachments` from the Copilot JSON-RPC SDK
/// that the renderer can construct. Mirrors the SDK union so we can
/// pass straight through `session.send({ attachments })` without
/// re-shaping on the bun side.
export type SendMessageAttachment =
  | { type: 'file'; path: string; displayName?: string }
  | { type: 'directory'; path: string; displayName?: string }
  | {
      type: 'selection';
      filePath: string;
      displayName: string;
      selection?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      text?: string;
    }
  | { type: 'blob'; data: string; mimeType: string; displayName?: string }
  | { type: 'commandResult'; result: CommandResultRecord; displayName?: string };

/// One file result from `searchWorkspaceFiles`. `path` is relative
/// to the session's working directory (for fuzzy mode) or preserves
/// the path-nav prefix the user typed (for `@/abs`, `@~/foo`,
/// `@../path`). `absolutePath` is the resolved fs path bun uses to
/// build SDK attachments at send-time. `kind` lets the renderer
/// pick the right AttachmentNode type + icon.
export interface WorkspaceFileMatch {
  path: string;
  absolutePath: string;
  name: string;
  kind: 'file' | 'directory';
}

/// Wire-format for a single SDK session event.
/// `eventType` mirrors the SDK's discriminated-union `type` field; `data`
/// carries the full event object verbatim so the frontend can pick out
/// event-specific fields without us hand-mirroring every variant.
/// `agentId` / `eventId` / `timestamp` are lifted off the SDK envelope so
/// the frontend can correlate sub-agent activity and order events without
/// us mirroring every variant's metadata into `data`.
export interface SessionEventPayload {
  sessionId: string;
  eventType: string;
  data: Record<string, unknown>;
  /// Sub-agent instance identifier. Absent for events from the
  /// root/main agent and session-level events.
  agentId?: string;
  /// UUID v4 generated by the SDK when the event is emitted.
  eventId?: string;
  /// ISO 8601 timestamp from the SDK envelope.
  timestamp?: string;
}

/// Permission request surfaced to the renderer. Mirrors the SDK's
/// `PermissionRequest` shape with the bits we use. `args` is the
/// opaque tool argument payload — typing it as `unknown` instead of
/// the SDK's discriminated union avoids dragging the whole SDK type
/// tree into the wire surface, and the renderer treats it as
/// display-only (formatted JSON) anyway.
export interface PermissionRequestData {
  kind:
    | 'shell'
    | 'write'
    | 'mcp'
    | 'read'
    | 'url'
    | 'custom-tool'
    | 'memory'
    | 'hook'
    | 'extension-management'
    | 'extension-permission-access';
  toolCallId?: string;
  /// Best-effort summary string we compute on the bun side from the
  /// SDK's `PermissionRequest` discriminated union (e.g. a shell
  /// command line, a path being written, the URL being fetched).
  /// Always populated so the renderer doesn't need to know the SDK
  /// shape; full request is in `raw` for diagnostics.
  summary: string;
  /// The complete SDK request as a plain JS object, for diagnostic
  /// display and any future ruleset / "approve for path" UI.
  raw: Record<string, unknown>;
}

export interface UserInputRequestData {
  question: string;
  choices?: string[];
  /// SDK default is true. Passed through so the renderer can decide
  /// whether to render the free-text input alongside the choices.
  allowFreeform: boolean;
}

export interface ElicitationRequestData {
  message: string;
  mode: 'form' | 'url';
  /// Source of the elicitation (e.g. MCP server name) when known.
  elicitationSource?: string;
  /// Present for `mode: "url"` — the URL to open in the user's
  /// default browser before they click "Done".
  url?: string;
  /// JSON Schema for the form when `mode: "form"`. Opaque to the
  /// current renderer (form mode is Cancel-only until the
  /// schema renderer lands as a follow-up).
  requestedSchema?: unknown;
}

export interface ExitPlanModeRequestData {
  summary: string;
  planContent: string;
  actions: string[];
  recommendedAction: string;
}

export interface AutoModeSwitchRequestData {
  errorCode?: string;
  retryAfterSeconds?: number;
}

/// Dafman-internal "the SDK is blocked on a callback" push, sent
/// alongside the existing SDK `*.requested` events. The renderer
/// queues these per session and responds via `respondToRequest`. The
/// `requestId` is generated on the bun side (NOT the SDK's — the SDK
/// gives a Promise, not an id) so we can correlate the response.
export type PendingRequestPayload =
  | {
      sessionId: string;
      requestId: string;
      kind: 'permission';
      request: PermissionRequestData;
    }
  | {
      sessionId: string;
      requestId: string;
      kind: 'userInput';
      request: UserInputRequestData;
    }
  | {
      sessionId: string;
      requestId: string;
      kind: 'elicitation';
      request: ElicitationRequestData;
    }
  | {
      sessionId: string;
      requestId: string;
      kind: 'exitPlanMode';
      request: ExitPlanModeRequestData;
    }
  | {
      sessionId: string;
      requestId: string;
      kind: 'autoModeSwitch';
      request: AutoModeSwitchRequestData;
    };

/// Renderer → bun response. Discriminated on `kind` so the bun side
/// resolves the awaiting Promise with the right SDK shape. The
/// renderer keeps these narrow and bun expands into the SDK's full
/// union (e.g. `approveForSession` → `{ kind: "approve-for-session" }`
/// without an approval rule — best-effort; SDK may reject if it
/// requires a rule, in which case the registry settles with
/// `{ kind: "user-not-available" }` and surfaces a toast).
export type PermissionApprovalRule =
  | { kind: 'commands'; commandIdentifiers: string[] }
  | { kind: 'read' }
  | { kind: 'write' }
  | { kind: 'mcp'; serverName: string; toolName: string | null }
  | { kind: 'mcp-sampling'; serverName: string }
  | { kind: 'memory' }
  | { kind: 'custom-tool'; toolName: string };

export type RespondToRequestParams =
  | {
      sessionId: string;
      requestId: string;
      response: {
        kind: 'permission';
        decision: 'approveOnce' | 'approveForSession' | 'reject';
        approval?: PermissionApprovalRule;
        domain?: string;
      };
    }
  | {
      sessionId: string;
      requestId: string;
      response: { kind: 'userInput'; answer: string; wasFreeform: boolean };
    }
  | {
      sessionId: string;
      requestId: string;
      response: {
        kind: 'elicitation';
        action: 'accept' | 'decline' | 'cancel';
        content?: Record<string, unknown>;
      };
    }
  | {
      sessionId: string;
      requestId: string;
      response: {
        kind: 'exitPlanMode';
        approved: boolean;
        selectedAction?: 'interactive' | 'autopilot' | 'exit_only' | 'autopilot_fleet';
        feedback?: string;
      };
    }
  | {
      sessionId: string;
      requestId: string;
      response: { kind: 'autoModeSwitch'; response: 'yes' | 'yes_always' | 'no' };
    };

export type DafmanRPC = {
  bun: RPCSchema<{
    requests: {
      createClient: { params: Record<string, never>; response: string };
      createSession: {
        /// `workingDirectory` is the absolute filesystem path the
        /// SDK uses as `cwd` for all tool invocations in this
        /// session. Empty / omitted falls back to the bun
        /// process's cwd (the SDK's own default).
        params: {
          workingDirectory?: string;
          model?: string | null;
          reasoningEffort?: string | null;
        };
        response: string;
      };
      /// Native folder picker. Returns the absolute path of the
      /// chosen directory, or `null` if the user cancelled.
      pickFolder: {
        params: { startingFolder?: string };
        response: string | null;
      };
      /// Directory autocomplete. Given a partial absolute path
      /// like `C:\repo\dafm`, lists immediate subdirectories of
      /// the parent (`C:\repo`) whose name starts with the leaf
      /// prefix (`dafm`). Used by the workspace AutoComplete in
      /// the topbar + Sessions panel to suggest filesystem
      /// completions alongside the persisted MRU. Capped at 20
      /// entries; case-insensitive prefix match. Returns `[]` on
      /// any filesystem error (path doesn't exist, permission
      /// denied, etc.) — the UI falls back to MRU-only.
      browseDirectory: {
        params: { prefix: string };
        response: string[];
      };
      disconnectSession: {
        params: { sessionId: string };
        response: string;
      };
      sendMessage: {
        params: {
          sessionId: string;
          text: string;
          /// SDK delivery mode. `"enqueue"` queues behind any
          /// in-flight turn; `"immediate"` injects into the
          /// running turn (steer). Omitted → SDK default.
          mode?: 'enqueue' | 'immediate';
          /// Optional SDK attachments — files / directories /
          /// selections / blobs (base64 data + mimeType for
          /// pasted images). Mirrors `MessageOptions.attachments`
          /// in the Copilot JSON-RPC SDK.
          attachments?: SendMessageAttachment[];
        };
        response: string;
      };
      /// Search files & directories in the session's working
      /// directory by fuzzy-substring match on name + path.
      /// Used by the composer's @file picker. Also supports
      /// path-navigation queries — when the query starts with
      /// `/`, `~/`, `./`, `../`, or a Windows drive letter, or
      /// contains a `/`, the picker switches to listing
      /// immediate children of the resolved directory whose
      /// name matches the leaf prefix. `includeHidden=true`
      /// surfaces dotfiles + ignored build-output dirs.
      searchWorkspaceFiles: {
        params: {
          sessionId: string;
          query: string;
          /// Hard cap on returned results. Default 40.
          limit?: number;
          /// Include dotfiles (names starting with `.`).
          includeHidden?: boolean;
          /// Include entries in IGNORED_DIRS (`node_modules`,
          /// `dist`, `target`, …).
          includeIgnored?: boolean;
        };
        response: WorkspaceFileMatch[];
      };
      /// Native file/directory picker. Single-pick. Caller passes
      /// `kind: "file" | "directory"` because Windows native
      /// dialogs cannot offer mixed picking — the underlying
      /// `IFileDialog` API is either an Open-File dialog
      /// or a folder dialog, not both. Forcing the kind also
      /// makes the resulting pill icon deterministic.
      /// Returns the absolute path + the requested kind, or
      /// `null` on cancel.
      pickAttachment: {
        params: { kind: 'file' | 'directory'; startingFolder?: string };
        response: { path: string; kind: 'file' | 'directory' } | null;
      };
      /// Aborts the currently-running turn for this session. The
      /// session remains valid; new sends after this point start a
      /// fresh turn. Backed by `session.abort()`.
      abortSession: {
        params: { sessionId: string };
        response: string;
      };
      listModels: {
        params: Record<string, never>;
        response: ModelSummary[];
      };
      setSessionModel: {
        params: {
          sessionId: string;
          model: string;
          reasoningEffort: string | null;
        };
        response: string;
      };
      resumeSession: {
        params: {
          sessionId: string;
          model: string | null;
          reasoningEffort: string | null;
        };
        /// `sessionId` is the SDK's actual id (may differ from the
        /// request if a fork happened). `cwd` is the resumed
        /// session's working directory if the SDK reports one — we
        /// surface it here because `getMessages()` history doesn't
        /// include `session.resume`, so the renderer otherwise has
        /// no chance to learn the workspace path on restore.
        response: { sessionId: string; cwd: string | null; model: string | null };
      };
      listSessions: {
        params: Record<string, never>;
        response: SessionMetadataSummary[];
      };
      /// Permanently deletes a session's CLI-side data. Returns the
      /// session id on success. If the session is currently
      /// registered in this app, it's disconnected first so the
      /// SDK can release its handle.
      deleteSession: {
        params: { sessionId: string };
        response: string;
      };
      getSessionMode: {
        params: { sessionId: string };
        response: SessionMode;
      };
      setSessionMode: {
        params: { sessionId: string; mode: SessionMode };
        response: SessionMode;
      };
      getSessionName: {
        params: { sessionId: string };
        response: string | null;
      };
      setSessionName: {
        params: { sessionId: string; name: string };
        response: string;
      };
      setSessionWorkingDirectory: {
        params: {
          sessionId: string;
          workingDirectory: string;
          baseWorkingDirectory?: string | null;
        };
        response: string;
      };
      compactSessionHistory: {
        params: { sessionId: string };
        response: SessionHistoryCompactionResult;
      };
      /// Truncate the session's history to (and including) the
      /// given eventId — that event AND everything after it are
      /// removed. Used by Edit / Retry actions which need to roll
      /// back the transcript before re-sending. Returns the
      /// number of events the CLI removed.
      truncateSessionHistory: {
        params: { sessionId: string; eventId: string };
        response: { eventsRemoved: number };
      };
      /// Fork the session at an optional event boundary. When
      /// `toEventId` is provided, the new session inherits only
      /// the events strictly BEFORE that id; omit it to clone the
      /// full history. Returns the new session's id; the renderer
      /// is responsible for opening the panel.
      forkSession: {
        params: { sessionId: string; toEventId?: string };
        response: { sessionId: string };
      };
      setSessionApproveAll: {
        params: { sessionId: string; enabled: boolean };
        response: boolean;
      };
      resetSessionApprovals: {
        params: { sessionId: string };
        response: boolean;
      };
      /// SDK skill list for the session. Returns the SDK's
      /// `Skill[]` shape normalised: name + description + source
      /// + enabled + userInvocable. Slash-invocation surfaces in
      /// the composer use `userInvocable`.
      listSessionSkills: {
        params: { sessionId: string };
        response: Array<{
          name: string;
          description: string;
          source: string;
          enabled: boolean;
          userInvocable: boolean;
          path?: string;
        }>;
      };
      setSessionSkillEnabled: {
        params: { sessionId: string; name: string; enabled: boolean };
        response: boolean;
      };
      /// Phase 19a. Session-scoped @experimental
      /// `session.rpc.agent.*` surface.
      listAgents: {
        params: { sessionId: string };
        response: AgentInfo[];
      };
      getCurrentAgent: {
        params: { sessionId: string };
        response: AgentInfo | null;
      };
      selectAgent: {
        params: { sessionId: string; name: string };
        response: AgentInfo;
      };
      deselectAgent: {
        params: { sessionId: string };
        response: boolean;
      };
      reloadAgents: {
        params: { sessionId: string };
        response: AgentInfo[];
      };
      /// Phase 19b.1. Session-scoped @experimental
      /// `session.rpc.tasks.*` surface.
      listTasks: {
        params: { sessionId: string };
        response: TaskInfo[];
      };
      cancelTask: {
        params: { sessionId: string; id: string };
        response: boolean;
      };
      removeTask: {
        params: { sessionId: string; id: string };
        response: boolean;
      };
      promoteTask: {
        params: { sessionId: string; id: string };
        response: boolean;
      };
      listJobs: {
        params: Record<string, never>;
        response: JobRecord[];
      };
      /// Phase 19b.2. Filesystem-backed agent CRUD. Separate from
      /// `session.rpc.agent.*` because the SDK surface only sees
      /// loaded agents; the Library tab needs to enumerate,
      /// create, and delete the .agent.md files directly. Explicit
      /// Refresh may ask this path to SDK-reload first so the file
      /// list and selectable registry do not drift mid-session.
      listAgentFiles: {
        params: { sessionId: string; reloadSdk?: boolean };
        response: AgentFileEntry[];
      };
      listAgentFilesGlobal: {
        params: Record<string, never>;
        response: AgentFileEntry[];
      };
      writeAgentFile: {
        params: {
          sessionId: string;
          spec: AgentFileSpec;
          allowOverwrite?: boolean;
          preservedTail?: string;
        };
        response: string;
      };
      readAgentFile: {
        params: { sessionId: string; scope: AgentFileScope; name: string };
        response: {
          spec: Partial<AgentFileSpec>;
          prompt: string;
          preservedTail: string;
          path: string;
        };
      };
      deleteAgentFile: {
        params: { sessionId: string; scope: AgentFileScope; name: string };
        response: boolean;
      };
      /// Phase 19c. Wraps the @experimental
      /// `session.rpc.fleet.start` surface. `prompt` is optional;
      /// the fleet size is determined by SDK internals (no caller
      /// parameter). Sub-agent activity streams via session events
      /// rendered as nested SubagentChatItem blocks.
      startFleet: {
        params: { sessionId: string; prompt?: string };
        response: boolean;
      };
      /// Raw SDK `usage.getMetrics` shape. Opaque to bun — the
      /// renderer cherry-picks `totalUserRequests` / token-detail
      /// counts / per-model breakdowns for display.
      getSessionUsageMetrics: {
        params: { sessionId: string };
        response: Record<string, unknown>;
      };
      /// Server-scoped list of built-in tools. Mirrors
      /// `rpc.tools.list` on `createServerRpc`. Returns the
      /// raw SDK shape ({ name, namespacedName?, description,
      /// parameters?, instructions? }[]).
      listBuiltinTools: {
        params: Record<string, never>;
        response: Array<{
          name: string;
          namespacedName?: string;
          description: string;
        }>;
      };
      /// Session-scoped list of MCP servers (with status).
      /// Backed by `session.rpc.mcp.list`. Used by Phase 18b's
      /// tool toggle UI to show MCP groups; per-server tool
      /// lists are not yet surfaced by the SDK.
      listSessionMcpServers: {
        params: { sessionId: string };
        response: Array<{
          name: string;
          status: string;
          source?: string;
          error?: string;
        }>;
      };
      /// Session-scoped MCP enable/disable. Toggles whether the
      /// session can use this MCP server for tool calls.
      setSessionMcpEnabled: {
        params: { sessionId: string; serverName: string; enabled: boolean };
        response: boolean;
      };
      /// Server-scoped account quota snapshot. Returns the SDK
      /// `quotaSnapshots` map verbatim — the renderer cherry-
      /// picks fields for display + warning thresholds.
      getAccountQuota: {
        params: Record<string, never>;
        response: Record<
          string,
          {
            isUnlimitedEntitlement: boolean;
            entitlementRequests: number;
            usedRequests: number;
            remainingPercentage: number;
            overage: number;
            resetDate?: string;
          }
        >;
      };
      /// Session-scoped plan read. Returns `{ exists, content,
      /// path? }`. When `exists=false` the panel renders an
      /// empty state.
      readSessionPlan: {
        params: { sessionId: string };
        response: { exists: boolean; content: string | null; path: string | null };
      };
      /// Session-scoped plan write. `content` overwrites the
      /// plan.md file. Returns void; the panel re-reads via
      /// `readSessionPlan` after a successful write.
      writeSessionPlan: {
        params: { sessionId: string; content: string };
        response: boolean;
      };
      /// Session-scoped plan delete. Returns void.
      deleteSessionPlan: {
        params: { sessionId: string };
        response: boolean;
      };
      // ---------- Phase 19a: MCP registry ----------
      /// Server-scoped MCP config CRUD. The CLI persists this to
      /// its user config; lists/edits affect new sessions only
      /// (per SDK semantics — active sessions keep their conns).
      /// `McpServerConfig` is the SDK union of Local + Http
      /// variants; we pass it through as an opaque record so we
      /// don't drift from the SDK's schema.
      listMcpConfigs: {
        params: Record<string, never>;
        response: Record<string, Record<string, unknown>>;
      };
      addMcpConfig: {
        params: { name: string; config: Record<string, unknown> };
        response: boolean;
      };
      updateMcpConfig: {
        params: { name: string; config: Record<string, unknown> };
        response: boolean;
      };
      removeMcpConfig: {
        params: { name: string };
        response: boolean;
      };
      enableMcpServers: {
        params: { names: string[] };
        response: boolean;
      };
      disableMcpServers: {
        params: { names: string[] };
        response: boolean;
      };
      /// Server-scoped MCP discovery. Returns the union of all
      /// servers the CLI can see (config + workspace + plugins).
      discoverMcpServers: {
        params: { workingDirectory?: string };
        response: Array<{
          name: string;
          type?: string;
          source: string;
          enabled: boolean;
        }>;
      };
      /// Session-scoped MCP OAuth login. Returns the URL the
      /// renderer should open; when cached tokens are still
      /// valid the SDK returns no URL and reconnects silently.
      loginToMcpServer: {
        params: {
          sessionId: string;
          serverName: string;
          forceReauth?: boolean;
          clientName?: string;
        };
        response: { authorizationUrl: string | null };
      };
      // ---------- Phase 19b: Skills library ----------
      discoverSkills: {
        params: { workingDirectory?: string };
        response: Array<{
          name: string;
          description: string;
          source: string;
          userInvocable: boolean;
          enabled: boolean;
          path?: string;
          projectPath?: string;
        }>;
      };
      setGloballyDisabledSkills: {
        params: { disabledSkills: string[] };
        response: boolean;
      };
      /// Phase 23: read-only instruction-file inventory for
      /// Library → Instructions. Includes global/user candidates
      /// plus project candidates for the active workspace.
      listInstructionSources: {
        params: { workingDirectory?: string };
        response: InstructionSource[];
      };
      createTerminal: {
        params: TerminalCreateParams;
        response: TerminalSummary;
      };
      writeTerminal: {
        params: { terminalId: string; data: string };
        response: boolean;
      };
      resizeTerminal: {
        params: { terminalId: string; cols: number; rows: number };
        response: boolean;
      };
      killTerminal: {
        params: { terminalId: string };
        response: boolean;
      };
      listTerminals: {
        params: Record<string, never>;
        response: TerminalSummary[];
      };
      startSessionCommand: {
        params: { sessionId: string; command: string };
        response: CommandResultRecord;
      };
      cancelSessionCommand: {
        params: { sessionId: string; commandId: string };
        response: boolean;
      };
      listCommandResults: {
        params: { sessionId: string };
        response: CommandResultRecord[];
      };
      getSettings: { params: Record<string, never>; response: Settings };
      updateSettings: { params: { next: Settings }; response: Settings };
      getLogDir: { params: Record<string, never>; response: string };
      openLogFolder: {
        params: Record<string, never>;
        response: boolean;
      };
      /// Reveal an arbitrary path in the OS file explorer. Used
      /// by the workspace chip in the tab strip; returns `false`
      /// when the path is empty or doesn't exist.
      revealPath: {
        params: { path: string };
        response: boolean;
      };
      /// Opens an arbitrary URL in the user's default browser.
      /// Only `http://` / `https://` schemes are accepted; anything
      /// else returns `false` (no-op) so this can't be used as a
      /// generic shell-out vector by a compromised renderer. Used
      /// by the elicitation url-mode dialog and any future
      /// "open in browser" affordances.
      openUrl: {
        params: { url: string };
        response: boolean;
      };
      /// Responds to a pending SDK callback (permission /
      /// user_input / elicitation). The bun side keeps the
      /// awaiting Promise in `SessionRegistry.pendingHandlers`
      /// keyed by `requestId`; resolving it unblocks the SDK
      /// and lets the next turn proceed. Idempotent — a double
      /// submit on an already-resolved request returns `false`
      /// instead of throwing, so the renderer's double-click
      /// guard is belt-and-suspenders.
      respondToRequest: {
        params: RespondToRequestParams;
        response: boolean;
      };
      // Lets the webview pipe console messages + uncaught errors back
      // through the existing RPC channel so they show up in bun's
      // JSON log even when WebView2 devtools is closed. Pure
      // diagnostic — not part of any product surface.
      rendererLog: {
        params: {
          level: 'debug' | 'info' | 'warn' | 'error';
          message: string;
          extra?: Record<string, unknown>;
        };
        response: undefined;
      };
      /// Returns the configured log level + the last N recent
      /// log records (capped at 1000). The renderer uses this
      /// to fill the log viewer on first open; afterwards it
      /// receives live records via the `logEvent` webview
      /// message.
      getLogState: {
        params: { recentLimit?: number };
        response: {
          level: LogLevel;
          recent: Array<LogRecord>;
        };
      };
      /// Mutates the configured level. Returns the new level for
      /// confirmation. Renderer also flips its local filter.
      setLogLevel: {
        params: { level: LogLevel };
        response: LogLevel;
      };
      /// Builds a redacted diagnostics bundle (logs + settings
      /// snapshot + README) under <userData>. Returns the
      /// directory path so the renderer can offer a "Reveal in
      /// file explorer" button.
      exportDiagnostics: {
        params: Record<string, never>;
        response: {
          path: string;
          files: string[];
          totalBytes: number;
        };
      };
      /// Writes a conversation export (markdown or JSON) to
      /// `<userData>/exports/<fileName>` and returns its path.
      /// Filename is sanitised; the renderer is expected to
      /// produce something like `my-session-2026-05-22-…md`.
      /// Returns the absolute path so the renderer can call
      /// `revealPath` afterwards.
      saveExportFile: {
        params: { fileName: string; contents: string };
        response: { path: string; bytes: number };
      };
      /// Returns the recent audit entries (capped at 500) so the
      /// renderer can fill an Activity view on first open.
      /// Live updates flow through the `auditEvent` webview
      /// message.
      getAuditState: {
        params: { recentLimit?: number };
        response: {
          recent: Array<AuditEntry>;
        };
      };
    };
    messages: Record<string, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      sessionEvent: SessionEventPayload;
      /// Pushed when the SDK calls one of the pending-callback
      /// handlers (`onPermissionRequest`, `onUserInputRequest`,
      /// `onElicitationRequest`). The renderer enqueues this on
      /// the session's pending queue and shows the modal; user
      /// response comes back via the `respondToRequest` RPC.
      /// Settlement of the pending Promise happens on the bun
      /// side when respondToRequest fires; we DON'T push a
      /// completion event from the bun side because the SDK
      /// already emits `*.completed` after the handler returns.
      pendingRequest: PendingRequestPayload;
      /// Live log record. Fanned out by `subscribeLogs()` for
      /// every emitted log line (subscribers receive EVERY
      /// record, irrespective of the configured level — the
      /// renderer applies its own client-side filter).
      logEvent: LogRecord;
      /// Live audit-log entry. Fanned out by `subscribeAudit()`
      /// for every recordPermission / recordUrl call. The
      /// in-app Activity view (Diagnostics panel) subscribes.
      auditEvent: AuditEntry;
      terminalEvent: TerminalEventPayload;
      commandResultEvent: CommandResultEvent;
    };
  }>;
};

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export interface LogRecord {
  ts: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

export type AuditEntry =
  | {
      ts: string;
      kind: 'permission';
      sessionId: string;
      requestId: string;
      permissionKind: string;
      decision: 'approveOnce' | 'approveForSession' | 'reject';
      summary?: string;
      approvalKind?: string;
      approvalDomain?: string;
    }
  | {
      ts: string;
      kind: 'url';
      url: string;
      allowed: boolean;
      reason: string;
    }
  | {
      ts: string;
      kind: 'command';
      sessionId: string;
      commandId: string;
      command: string;
      cwd: string;
      shell: string;
      status: 'started' | 'completed' | 'failed' | 'cancelled' | 'timeout';
      exitCode?: number | null;
      durationMs?: number;
      truncated?: boolean;
    }
  | {
      ts: string;
      kind: 'mcp';
      sessionId: string;
      serverName: string;
      toolName: string;
      toolCallId?: string;
      argKeys?: string[];
      argKeyCount?: number;
    };

export type { AppErrorPayload };
