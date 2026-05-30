// Hand-mirrored types for the Electrobun RPC bridge.
//
// The Bun side's source of truth is `src-bun/rpc.ts`; we re-state the
// payload-only types here so the Vue tree never imports from
// `electrobun/bun` (which is a Bun-only module).

export type ThemeChoice = 'system' | 'light' | 'dark';

export type ReasoningVisibility = 'hidden' | 'compact' | 'expanded';

/// Mirrors `ComposerSubmitKeybinding` in `src-bun/rpc.ts`. Which
/// keystroke submits the composer.
export type ComposerSubmitKeybinding = 'enter' | 'mod-enter';

/// Mirrors `SessionMode` in `src-bun/rpc.ts`. Agent run mode.
export type SessionMode = 'interactive' | 'plan' | 'autopilot';

/// Mirrors `SessionHistoryCompactionResult` in `src-bun/rpc.ts`.
export interface SessionHistoryCompactionResult {
  success: boolean;
  tokensFreed: number | null;
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
  /// final `assistant.message` per turn. Takes effect on the NEXT
  /// session created — existing sessions keep their original mode.
  streaming: boolean;
  /// Lazy-load mermaid and render ```mermaid``` code fences as
  /// diagrams. Default false to keep the main bundle slim.
  enableMermaid: boolean;
}

export interface Settings {
  version: number;
  appearance: Appearance;
  layout: Layout;
  workspaces: Workspaces;
  notifications: NotificationPrefs;
  tools: ToolsPrefs;
  permissions: PermissionsPrefs;
  terminal: TerminalPrefs;
  composer: ComposerPrefs;
}

/// Mirrors `ComposerPrefs` in `src-bun/rpc.ts`. Composer keybindings.
export interface ComposerPrefs {
  submitKeybinding: ComposerSubmitKeybinding;
}

export interface ToolsPrefs {
  defaultExcluded: string[];
  /// 22b: allowlist applied at session create. Empty = no
  /// restriction. Non-empty = ONLY these tools available (SDK's
  /// `availableTools` takes precedence over `excludedTools`).
  defaultAllowed: string[];
}

export interface PermissionsPrefs {
  /// 22c: when true, new sessions start with approve-all on.
  /// Default false — explicit user opt-in.
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

/// Bump when the dockview layout shape stored in `Layout.dockview`
/// changes in an incompatible way. The boot path compares the
/// persisted `schemaVersion` against this and triggers a one-time
/// narrow migration (preserve chat session IDs, re-seed edge groups)
/// on a downgrade detection.
///
/// History:
///   v1 — left edge: custom ActivityBar with `exclusive: true`; right
///        edge: ad-hoc session-details panel
///   v2 — left + right edges: native dockview vertical tab strips
///        seeded by `seedDefaultLayout`; library moved to right edge
export const LAYOUT_SCHEMA_VERSION = 3;

/// User-facing identity for a group (the "tabs at top of body" model).
/// Mirrors `GroupMeta` in `src-bun/rpc.ts`.
export interface GroupMeta {
  /// Stable id, also used as the outer dockview panel id for this group.
  id: string;
  name: string;
  /// Hex color for the tab's color dot. Defaulted from a cycling palette on
  /// create.
  color: string;
}

export interface Layout {
  /// Serialized outer dockview state (`outer.api.toJSON()`). Contains edge
  /// groups (activity bar) + body grid where each body panel id == a
  /// `groups[].id`. Renamed from v2's `dockview` field; the v2->v3 migration
  /// in `bootLayout.ts` wraps the old body into a single Default group.
  outer?: unknown;
  /// Ordered group list. Length >= 1 after hydrate (corrupt or empty input
  /// hydrates to a single Default group).
  groups?: GroupMeta[];
  /// Id of the group whose inner panel was active when the layout was
  /// persisted. Restored at boot by activating the matching outer body
  /// panel. Falls back to `groups[0].id` if missing/invalid.
  activeGroupId?: string;
  /// Per-group inner dockview JSON. Keys are subset of `groups[].id`; a
  /// missing key means an empty inner dockview at first activation.
  innerBodies?: Record<string, unknown>;
  /// Missing or older than `LAYOUT_SCHEMA_VERSION` triggers migration.
  schemaVersion?: number;
  /// Legacy v2 field retained ONLY for hydration of pre-v3 layouts.
  /// Migrated to `outer` + `innerBodies['<default>']` on first save.
  dockview?: unknown;
}

export interface Workspaces {
  recent: string[];
  /// Default workspace for new sessions. May be empty when home-dir
  /// resolution failed at startup; treat empty as "no default".
  defaultWorkspace: string;
}

/// OS-native notification preferences. Mirrors `NotificationPrefs` in
/// `src-bun/rpc.ts`. Inner indicators (status dots, banner) are
/// always on; these only gate when we call `new Notification()`.
export interface NotificationPrefs {
  turnEnd: boolean;
  waitingForInput: boolean;
}

export interface ModelSummary {
  id: string;
  name: string;
  supportsReasoningEffort: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

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

/// Mirror of the SDK's AgentInfo wire shape (see
/// `src-bun/rpc.ts:AgentInfo`). Returned by the @experimental
/// `session.rpc.agent.*` surface. `path` is set for file-based agents
/// — we use it to derive a "Project" vs "User" source label by
/// checking whether the path is under `<wd>/.github/agents/`.
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

/// Mirror of `src-bun/rpc.ts:AgentFileScope`. Library tab scope
/// discriminator for filesystem-backed agent CRUD.
export type AgentFileScope = 'user' | 'project';

/// Mirror of `src-bun/rpc.ts:AgentFileEntry`. Filesystem-discovered
/// agent file (used by the Library tab; distinct from `AgentInfo`
/// which only sees SDK-loaded agents).
export interface AgentFileEntry {
  scope: AgentFileScope;
  name: string;
  path: string;
  canonical: boolean;
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

/// Mirror of `src-bun/rpc.ts:AgentFileSpec`. The renderer-supplied
/// spec for `writeAgentFile`. v1 surface only — `mcp-servers` and
/// `github` keys are deferred to direct file edits.
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

/// Subset of `MessageOptions.attachments` from the Copilot JSON-RPC SDK.
/// Mirrored here so the renderer can construct without importing the
/// SDK types directly. Pass-through to bun → SDK at send time.
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

export interface WorkspaceFileMatch {
  path: string;
  absolutePath: string;
  name: string;
  kind: 'file' | 'directory';
}

export interface SessionEventPayload {
  sessionId: string;
  eventType: string;
  data: Record<string, unknown>;
  agentId?: string;
  eventId?: string;
  timestamp?: string;
}

/// Mirrors `PermissionRequestData` in `src-bun/rpc.ts`. Permission
/// request surfaced to the renderer for the pending-request modal.
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
  /// Best-effort summary computed bun-side (e.g. "shell: ls -la").
  summary: string;
  /// Full request payload for diagnostic display.
  raw: Record<string, unknown>;
}

export interface UserInputRequestData {
  question: string;
  choices?: string[];
  allowFreeform: boolean;
}

export interface ElicitationRequestData {
  message: string;
  mode: 'form' | 'url';
  elicitationSource?: string;
  /// Present for `mode: "url"` — the URL to open in the browser.
  url?: string;
  /// JSON Schema for form mode. Opaque to the current renderer
  /// (form mode is Cancel-only until the schema renderer ships).
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

/// Dafman-internal pending-request push. See `src-bun/rpc.ts`.
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

/// Approval scope sent with `approveForSession` decisions. Mirrors the
/// SDK's `PermissionDecisionApproveForSessionApproval` union — see
/// the Copilot JSON-RPC SDK generated rpc.d.ts.
/// `undefined` falls back to the SDK's default (kind-specific blanket
/// approval); we only send a concrete rule when the user picks one.
export type PermissionApprovalRule =
  | { kind: 'commands'; commandIdentifiers: string[] }
  | { kind: 'read' }
  | { kind: 'write' }
  | { kind: 'mcp'; serverName: string; toolName: string | null }
  | { kind: 'mcp-sampling'; serverName: string }
  | { kind: 'memory' }
  | { kind: 'custom-tool'; toolName: string };

/// Renderer → bun response shape for `respondToRequest`.
export type RespondToRequestParams =
  | {
      sessionId: string;
      requestId: string;
      response: {
        kind: 'permission';
        decision: 'approveOnce' | 'approveForSession' | 'reject';
        /// Optional approval rule for `approveForSession` decisions.
        /// When absent the SDK uses a kind-specific blanket approval.
        approval?: PermissionApprovalRule;
        /// Optional URL domain for `approveForSession` decisions on
        /// `url` permission requests. Defaults to the host extracted
        /// from the request URL when absent.
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

/// Discriminated union mirroring `AppErrorPayload` in `src-bun/app/errors.ts`.
/// RPC rejections are deserialized into this shape by `invokeCommand`.
export type AppErrorPayload =
  | { kind: 'ClientNotStarted' }
  | { kind: 'SessionNotFound'; data: string }
  | { kind: 'Settings'; data: string }
  | { kind: 'Sdk'; data: string }
  | { kind: 'Io'; data: string };

/// Single source of truth for the request surface. Adding a new RPC?
/// Add it here, then implement on the bun side in `src-bun/index.ts`.
export type CommandMap = {
  createClient: { args: Record<string, never>; result: string };
  createSession: {
    args: {
      workingDirectory?: string;
      model?: string | null;
      reasoningEffort?: string | null;
    };
    result: string;
  };
  pickFolder: {
    args: { startingFolder?: string };
    result: string | null;
  };
  pickAttachment: {
    args: { kind: 'file' | 'directory'; startingFolder?: string };
    result: { path: string; kind: 'file' | 'directory' } | null;
  };
  browseDirectory: {
    args: { prefix: string };
    result: string[];
  };
  disconnectSession: { args: { sessionId: string }; result: string };
  sendMessage: {
    args: {
      sessionId: string;
      text: string;
      mode?: 'enqueue' | 'immediate';
      attachments?: SendMessageAttachment[];
    };
    result: string;
  };
  searchWorkspaceFiles: {
    args: {
      sessionId: string;
      query: string;
      limit?: number;
      includeHidden?: boolean;
      includeIgnored?: boolean;
    };
    result: WorkspaceFileMatch[];
  };
  abortSession: { args: { sessionId: string }; result: string };
  listModels: { args: Record<string, never>; result: ModelSummary[] };
  setSessionModel: {
    args: {
      sessionId: string;
      model: string;
      reasoningEffort: string | null;
    };
    result: string;
  };
  resumeSession: {
    args: {
      sessionId: string;
      model: string | null;
      reasoningEffort: string | null;
    };
    result: { sessionId: string; cwd: string | null; model: string | null };
  };
  listSessions: { args: Record<string, never>; result: SessionMetadataSummary[] };
  deleteSession: { args: { sessionId: string }; result: string };
  getSessionMode: { args: { sessionId: string }; result: SessionMode };
  setSessionMode: {
    args: { sessionId: string; mode: SessionMode };
    result: SessionMode;
  };
  getSessionName: { args: { sessionId: string }; result: string | null };
  setSessionName: {
    args: { sessionId: string; name: string };
    result: string;
  };
  setSessionWorkingDirectory: {
    args: {
      sessionId: string;
      workingDirectory: string;
      baseWorkingDirectory?: string | null;
    };
    result: string;
  };
  compactSessionHistory: {
    args: { sessionId: string };
    result: SessionHistoryCompactionResult;
  };
  truncateSessionHistory: {
    args: { sessionId: string; eventId: string };
    result: { eventsRemoved: number };
  };
  forkSession: {
    args: { sessionId: string; toEventId?: string };
    result: { sessionId: string };
  };
  setSessionApproveAll: {
    args: { sessionId: string; enabled: boolean };
    result: boolean;
  };
  resetSessionApprovals: { args: { sessionId: string }; result: boolean };
  listSessionSkills: {
    args: { sessionId: string };
    result: Array<{
      name: string;
      description: string;
      source: string;
      enabled: boolean;
      userInvocable: boolean;
      path?: string;
    }>;
  };
  setSessionSkillEnabled: {
    args: { sessionId: string; name: string; enabled: boolean };
    result: boolean;
  };
  listAgents: {
    args: { sessionId: string };
    result: AgentInfo[];
  };
  getCurrentAgent: {
    args: { sessionId: string };
    result: AgentInfo | null;
  };
  selectAgent: {
    args: { sessionId: string; name: string };
    result: AgentInfo;
  };
  deselectAgent: {
    args: { sessionId: string };
    result: boolean;
  };
  reloadAgents: {
    args: { sessionId: string };
    result: AgentInfo[];
  };
  listTasks: {
    args: { sessionId: string };
    result: TaskInfo[];
  };
  cancelTask: {
    args: { sessionId: string; id: string };
    result: boolean;
  };
  removeTask: {
    args: { sessionId: string; id: string };
    result: boolean;
  };
  promoteTask: {
    args: { sessionId: string; id: string };
    result: boolean;
  };
  listJobs: {
    args: Record<string, never>;
    result: JobRecord[];
  };
  listAgentFiles: {
    args: { sessionId: string; reloadSdk?: boolean };
    result: AgentFileEntry[];
  };
  listAgentFilesGlobal: {
    args: Record<string, never>;
    result: AgentFileEntry[];
  };
  writeAgentFile: {
    args: {
      sessionId: string;
      spec: AgentFileSpec;
      allowOverwrite?: boolean;
      preservedTail?: string;
    };
    result: string;
  };
  readAgentFile: {
    args: { sessionId: string; scope: AgentFileScope; name: string };
    result: {
      spec: Partial<AgentFileSpec>;
      prompt: string;
      preservedTail: string;
      path: string;
    };
  };
  deleteAgentFile: {
    args: { sessionId: string; scope: AgentFileScope; name: string };
    result: boolean;
  };
  startFleet: {
    args: { sessionId: string; prompt?: string };
    result: boolean;
  };
  getSessionUsageMetrics: {
    args: { sessionId: string };
    result: Record<string, unknown>;
  };
  listBuiltinTools: {
    args: Record<string, never>;
    result: Array<{
      name: string;
      namespacedName?: string;
      description: string;
    }>;
  };
  listSessionMcpServers: {
    args: { sessionId: string };
    result: Array<{
      name: string;
      status: string;
      source?: string;
      error?: string;
    }>;
  };
  setSessionMcpEnabled: {
    args: { sessionId: string; serverName: string; enabled: boolean };
    result: boolean;
  };
  getAccountQuota: {
    args: Record<string, never>;
    result: Record<
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
  readSessionPlan: {
    args: { sessionId: string };
    result: { exists: boolean; content: string | null; path: string | null };
  };
  writeSessionPlan: {
    args: { sessionId: string; content: string };
    result: boolean;
  };
  deleteSessionPlan: {
    args: { sessionId: string };
    result: boolean;
  };
  // ---------- Phase 19a: MCP registry ----------
  listMcpConfigs: {
    args: Record<string, never>;
    result: Record<string, Record<string, unknown>>;
  };
  addMcpConfig: {
    args: { name: string; config: Record<string, unknown> };
    result: boolean;
  };
  updateMcpConfig: {
    args: { name: string; config: Record<string, unknown> };
    result: boolean;
  };
  removeMcpConfig: {
    args: { name: string };
    result: boolean;
  };
  enableMcpServers: {
    args: { names: string[] };
    result: boolean;
  };
  disableMcpServers: {
    args: { names: string[] };
    result: boolean;
  };
  discoverMcpServers: {
    args: { workingDirectory?: string };
    result: Array<{
      name: string;
      type?: string;
      source: string;
      enabled: boolean;
    }>;
  };
  loginToMcpServer: {
    args: {
      sessionId: string;
      serverName: string;
      forceReauth?: boolean;
      clientName?: string;
    };
    result: { authorizationUrl: string | null };
  };
  // ---------- Phase 19b: Skills library ----------
  discoverSkills: {
    args: { workingDirectory?: string };
    result: Array<{
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
    args: { disabledSkills: string[] };
    result: boolean;
  };
  listInstructionSources: {
    args: { workingDirectory?: string };
    result: InstructionSource[];
  };
  createTerminal: {
    args: TerminalCreateParams;
    result: TerminalSummary;
  };
  writeTerminal: {
    args: { terminalId: string; data: string };
    result: boolean;
  };
  resizeTerminal: {
    args: { terminalId: string; cols: number; rows: number };
    result: boolean;
  };
  killTerminal: {
    args: { terminalId: string };
    result: boolean;
  };
  listTerminals: {
    args: Record<string, never>;
    result: TerminalSummary[];
  };
  startSessionCommand: {
    args: { sessionId: string; command: string };
    result: CommandResultRecord;
  };
  cancelSessionCommand: {
    args: { sessionId: string; commandId: string };
    result: boolean;
  };
  listCommandResults: {
    args: { sessionId: string };
    result: CommandResultRecord[];
  };
  getSettings: { args: Record<string, never>; result: Settings };
  updateSettings: { args: { next: Settings }; result: Settings };
  getLogDir: { args: Record<string, never>; result: string };
  openLogFolder: { args: Record<string, never>; result: boolean };
  revealPath: { args: { path: string }; result: boolean };
  openUrl: { args: { url: string }; result: boolean };
  respondToRequest: { args: RespondToRequestParams; result: boolean };
  rendererLog: {
    args: {
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      extra?: Record<string, unknown>;
    };
    result: undefined;
  };
  getLogState: {
    args: { recentLimit?: number };
    result: {
      level: LogLevel;
      recent: LogRecord[];
    };
  };
  setLogLevel: { args: { level: LogLevel }; result: LogLevel };
  exportDiagnostics: {
    args: Record<string, never>;
    result: { path: string; files: string[]; totalBytes: number };
  };
  saveExportFile: {
    args: { fileName: string; contents: string };
    result: { path: string; bytes: number };
  };
  getAuditState: {
    args: { recentLimit?: number };
    result: { recent: AuditEntry[] };
  };
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

export type CommandName = keyof CommandMap;
