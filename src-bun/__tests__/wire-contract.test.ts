import { describe, expect, test } from 'bun:test';
import type {
  ModelSummary,
  JobRecord,
  PendingRequestPayload,
  PermissionRequestData,
  RespondToRequestParams,
  SessionHistoryCompactionResult,
  SessionMode,
  Settings,
  SessionEventPayload,
  InstructionSource,
  TaskInfo,
  TerminalCreateParams,
  TerminalEventPayload,
  TerminalSummary,
  CommandResultEvent,
  CommandResultRecord,
  SendMessageAttachment,
  AgentFileEntry,
} from '../rpc';
import type { AppErrorPayload } from '../app/shared/errors';

// Wire-shape snapshots — equivalent to the old `insta` snapshots in
// `src-tauri/tests/ipc_contract.rs`. The whole point is that if anyone
// renames a field, this test breaks loudly. Keep these in sync with the
// types in `../rpc.ts`.

const DEFAULT_TERMINAL_ADDONS = {
  search: true,
  webLinks: true,
  clipboard: true,
  unicode11: true,
  webFonts: true,
  progress: true,
  ligatures: true,
  image: true,
  unicodeGraphemes: true,
  webgl: true,
  serialize: true,
} as const;

function makeTerminalPrefs(defaultProfileId: string): import('../rpc').TerminalPrefs {
  return {
    defaultProfileId,
    fontFamily: 'Cascadia Mono, Consolas, ui-monospace, monospace',
    fontSize: 13,
    scrollback: 10_000,
    theme: { background: '#111827', foreground: '#d1d5db' },
    addons: { ...DEFAULT_TERMINAL_ADDONS },
  };
}

describe('IPC wire contracts', () => {
  test('Settings shape', () => {
    const sample: Settings = {
      version: 13,
      appearance: {
        theme: 'dark',
        reasoningVisibility: 'compact',
        defaultModelId: 'auto',
        defaultReasoningEffort: null,
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: {
        recent: ['D:\\repo\\dafman', 'C:\\code\\demo'],
        defaultWorkspace: 'D:\\repo\\dafman',
      },
      notifications: { turnEnd: false, waitingForInput: true },
      tools: { defaultExcluded: [], defaultAllowed: [] },
      permissions: { defaultApproveAll: false },
      terminal: makeTerminalPrefs('platform-default'),
      composer: { submitKeybinding: 'enter' },
    };
    expect(sample).toMatchSnapshot();
  });

  test('Settings with persisted layout', () => {
    const sample: Settings = {
      version: 13,
      appearance: {
        theme: 'dark',
        reasoningVisibility: 'compact',
        defaultModelId: 'gpt-5.5',
        defaultReasoningEffort: 'medium',
        streaming: true,
        enableMermaid: false,
      },
      layout: {
        dockview: {
          grid: {
            root: {},
            height: 600,
            width: 800,
            orientation: 'HORIZONTAL',
          },
          panels: { 'sess-1': { id: 'sess-1', contentComponent: 'chat' } },
          activeGroup: 'g1',
        },
      },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: true, waitingForInput: true },
      tools: { defaultExcluded: ['bash'], defaultAllowed: [] },
      permissions: { defaultApproveAll: true },
      terminal: makeTerminalPrefs('pwsh'),
      composer: { submitKeybinding: 'mod-enter' },
    };
    expect(sample).toMatchSnapshot();
  });

  test('Settings with v3 groups layout', () => {
    const sample: Settings = {
      version: 13,
      appearance: {
        theme: 'dark',
        reasoningVisibility: 'compact',
        defaultModelId: 'auto',
        defaultReasoningEffort: null,
        streaming: true,
        enableMermaid: false,
      },
      layout: {
        schemaVersion: 3,
        outer: {
          grid: { root: {}, height: 800, width: 1200, orientation: 'HORIZONTAL' },
          panels: {
            'grp-default': { id: 'grp-default', contentComponent: 'group' },
            'grp-other': { id: 'grp-other', contentComponent: 'group' },
          },
          activeGroup: 'g-outer-1',
        },
        groups: [
          { id: 'grp-default', name: 'Default', color: '#3b82f6' },
          { id: 'grp-other', name: 'Work', color: '#f59e0b' },
        ],
        innerBodies: {
          'grp-default': {
            grid: { root: {}, height: 600, width: 1000, orientation: 'HORIZONTAL' },
            panels: { 'sess-1': { id: 'sess-1', contentComponent: 'chatPanel' } },
            activeGroup: 'g1',
          },
          'grp-other': {
            grid: { root: {}, height: 600, width: 1000, orientation: 'HORIZONTAL' },
            panels: {},
            activeGroup: 'g2',
          },
        },
      },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: true, waitingForInput: true },
      tools: { defaultExcluded: [], defaultAllowed: [] },
      permissions: { defaultApproveAll: false },
      terminal: makeTerminalPrefs('platform-default'),
      composer: { submitKeybinding: 'enter' },
    };
    expect(sample).toMatchSnapshot();
  });

  test('ComposerPrefs shape', () => {
    const enterMode: import('../rpc').ComposerPrefs = { submitKeybinding: 'enter' };
    const modEnterMode: import('../rpc').ComposerPrefs = { submitKeybinding: 'mod-enter' };

    expect({ enterMode, modEnterMode }).toMatchSnapshot();
  });

  test('ModelSummary shape', () => {
    const sample: ModelSummary = {
      id: 'claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    };
    expect(sample).toMatchSnapshot();
  });

  test('SessionEventPayload shape', () => {
    const sample: SessionEventPayload = {
      sessionId: 'sess-1',
      eventType: 'assistant.message_delta',
      data: { deltaContent: 'hi' },
    };
    expect(sample).toMatchSnapshot();
  });

  test('SessionEventPayload with envelope metadata (tool event)', () => {
    const sample: SessionEventPayload = {
      sessionId: 'sess-1',
      eventType: 'tool.execution_complete',
      data: {
        toolCallId: 'call-abc',
        success: true,
        result: { content: 'ok', detailedContent: 'ok\n' },
      },
      agentId: 'sub-agent-7',
      eventId: '00000000-0000-0000-0000-000000000001',
      timestamp: '2026-05-17T15:00:00.000Z',
    };
    expect(sample).toMatchSnapshot();
  });

  test('SessionMetadataSummary shape', () => {
    const sample: import('../rpc').SessionMetadataSummary = {
      sessionId: 's-1',
      startTime: '2026-05-17T10:00:00.000Z',
      modifiedTime: '2026-05-17T11:30:00.000Z',
      summary: 'refactor auth',
      isRemote: false,
      cwd: '/repo',
      repository: 'AsafMah/dafman',
      branch: 'main',
    };
    expect(sample).toMatchSnapshot();
  });

  test('AppErrorPayload variants', () => {
    const variants: AppErrorPayload[] = [
      { kind: 'ClientNotStarted' },
      { kind: 'SessionNotFound', data: 'sess-42' },
      { kind: 'Settings', data: 'disk full' },
      { kind: 'Sdk', data: 'rpc closed' },
    ];
    expect(variants).toMatchSnapshot();
  });

  test('SessionMode union', () => {
    const variants: SessionMode[] = ['interactive', 'plan', 'autopilot'];
    expect(variants).toMatchSnapshot();
  });

  test('TaskInfo — agent task', () => {
    const sample: TaskInfo = {
      id: 'agent-1',
      type: 'agent',
      description: 'Investigate CI',
      status: 'running',
      agentType: 'explore',
      toolCallId: 'tool-1',
      startedAt: '2026-05-22T10:00:00.000Z',
      executionMode: 'background',
      canPromoteToBackground: false,
      agentName: 'ci-helper',
      agentDisplayName: 'CI Helper',
      model: 'gpt-5.5',
      prompt: 'Find the CI failure',
      latestResponse: 'Checking logs',
    };
    expect(sample).toMatchSnapshot();
  });

  test('TaskInfo — shell task', () => {
    const sample: TaskInfo = {
      id: 'shell-1',
      type: 'shell',
      description: 'Run check',
      status: 'idle',
      command: 'bun run check',
      startedAt: '2026-05-22T10:00:00.000Z',
      executionMode: 'background',
      canPromoteToBackground: false,
      attachmentMode: 'detached',
      logPath: 'C:\\logs\\check.log',
      pid: 1234,
    };
    expect(sample).toMatchSnapshot();
  });

  test('JobRecord shape', () => {
    const sample: JobRecord = {
      id: 'sess-1:agent-1',
      sessionId: 'sess-1',
      source: 'sdk-task',
      kind: 'agent',
      status: 'running',
      title: 'CI Helper',
      description: 'Investigate CI',
      startedAt: '2026-05-22T10:00:00.000Z',
      activeTimeMs: 1200,
      agentType: 'explore',
      agentName: 'ci-helper',
      model: 'gpt-5.5',
      prompt: 'Find the CI failure',
      latestResponse: 'Checking logs',
      toolCallId: 'tool-1',
      executionMode: 'background',
      canCancel: true,
      canRemove: false,
      canPromoteToBackground: false,
      canOpenSession: true,
    };
    expect(sample).toMatchSnapshot();
  });

  test('TerminalSummary shape', () => {
    const sample: TerminalSummary = {
      id: 'term-1',
      title: 'PowerShell',
      cwd: 'C:\\repo\\dafman',
      shell: 'pwsh.exe',
      args: ['-NoLogo'],
      status: 'running',
      createdAt: '2026-05-23T06:00:00.000Z',
      cols: 100,
      rows: 30,
      sessionId: 'sess-1',
    };
    expect(sample).toMatchSnapshot();
  });

  test('TerminalEventPayload — output', () => {
    const sample: TerminalEventPayload = {
      terminalId: 'term-1',
      kind: 'output',
      data: 'hello',
    };
    expect(sample).toMatchSnapshot();
  });

  test('CommandResultRecord shape', () => {
    const sample: CommandResultRecord = {
      id: 'cmd-1',
      sessionId: 'sess-1',
      command: 'bun test',
      cwd: 'C:\\repo\\dafman',
      shell: 'pwsh.exe',
      status: 'completed',
      stdout: 'ok',
      stderr: '',
      truncated: false,
      createdAt: '2026-05-23T10:00:00.000Z',
      completedAt: '2026-05-23T10:00:01.000Z',
      exitCode: 0,
      durationMs: 1000,
    };
    expect(sample).toMatchSnapshot();
  });

  test('CommandResultEvent — stdout', () => {
    const sample: CommandResultEvent = {
      kind: 'stdout',
      sessionId: 'sess-1',
      commandId: 'cmd-1',
      data: 'hello',
    };
    expect(sample).toMatchSnapshot();
  });

  test('SendMessageAttachment — command result', () => {
    const sample: SendMessageAttachment = {
      type: 'commandResult',
      displayName: 'command-result.md',
      result: {
        id: 'cmd-1',
        sessionId: 'sess-1',
        command: 'echo hi',
        cwd: 'C:\\repo\\dafman',
        shell: 'pwsh.exe',
        status: 'completed',
        stdout: 'hi',
        stderr: '',
        truncated: false,
        createdAt: '2026-05-23T10:00:00.000Z',
        exitCode: 0,
      },
    };
    expect(sample).toMatchSnapshot();
  });

  test('sendMessage request — default mode (omitted)', () => {
    const sample = { sessionId: 'sess-1', text: 'hello' };
    expect(sample).toMatchSnapshot();
  });

  test('sendMessage request — explicit enqueue mode', () => {
    const sample = {
      sessionId: 'sess-1',
      text: 'queue this',
      mode: 'enqueue' as const,
    };
    expect(sample).toMatchSnapshot();
  });

  test('sendMessage request — explicit immediate mode', () => {
    const sample = {
      sessionId: 'sess-1',
      text: 'steer this',
      mode: 'immediate' as const,
    };
    expect(sample).toMatchSnapshot();
  });

  test('createSession request — model defaults', () => {
    const sample = {
      workingDirectory: 'D:\\repo\\dafman',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
    };
    expect(sample).toMatchSnapshot();
  });

  test('resumeSession response — cwd and current model', () => {
    const sample = {
      sessionId: 'sess-1',
      cwd: 'D:\\repo\\dafman',
      model: 'gpt-5.5',
    };
    expect(sample).toMatchSnapshot();
  });

  test('promoteTask request shape', () => {
    const sample = { sessionId: 'sess-1', id: 'agent-1' };
    expect(sample).toMatchSnapshot();
  });

  test('listAgentFiles refresh request shape', () => {
    const sample: { sessionId: string; reloadSdk?: boolean } = {
      sessionId: 'sess-1',
      reloadSdk: true,
    };
    expect(sample).toMatchSnapshot();
  });

  test('listAgentFiles response shape', () => {
    const sample: AgentFileEntry[] = [
      {
        scope: 'project',
        name: 'dropped',
        path: 'C:\\repo\\dafman\\.github\\agents\\dropped.agent.md',
        canonical: true,
      },
    ];
    expect(sample).toMatchSnapshot();
  });

  test('createTerminal request shape', () => {
    const sample: TerminalCreateParams = {
      cwd: 'C:\\repo\\dafman',
      shell: 'pwsh.exe',
      args: ['-NoLogo'],
      cols: 80,
      rows: 24,
      title: 'Session Shell',
      sessionId: 'sess-1',
    };
    expect(sample).toMatchSnapshot();
  });

  test('listJobs response shape', () => {
    const sample: JobRecord[] = [
      {
        id: 'sess-1:shell-1',
        sessionId: 'sess-1',
        source: 'sdk-task',
        kind: 'shell',
        status: 'idle',
        title: 'bun run check',
        description: 'Run check',
        command: 'bun run check',
        startedAt: '2026-05-22T10:00:00.000Z',
        logPath: 'C:\\logs\\check.log',
        pid: 1234,
        canCancel: true,
        canRemove: false,
        canPromoteToBackground: false,
        canOpenSession: true,
      },
    ];
    expect(sample).toMatchSnapshot();
  });

  test('abortSession request shape', () => {
    const sample = { sessionId: 'sess-1' };
    expect(sample).toMatchSnapshot();
  });

  test('SessionHistoryCompactionResult shape', () => {
    const sample: SessionHistoryCompactionResult = {
      success: true,
      tokensFreed: 1234,
      messagesRemoved: 5,
    };
    expect(sample).toMatchSnapshot();
  });

  test('setSessionWorkingDirectory request shape', () => {
    const sample = {
      sessionId: 'sess-1',
      workingDirectory: '..\\other',
      baseWorkingDirectory: 'C:\\repo\\dafman',
    };
    expect(sample).toMatchSnapshot();
  });

  test('PendingRequestPayload — permission', () => {
    const permission: PermissionRequestData = {
      kind: 'shell',
      toolCallId: 'tc-abc',
      summary: 'shell: rm -rf /tmp/x',
      raw: { command: 'rm -rf /tmp/x', cwd: '/home/user' },
    };
    const sample: PendingRequestPayload = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-1',
      kind: 'permission',
      request: permission,
    };
    expect(sample).toMatchSnapshot();
  });

  test('PendingRequestPayload — userInput', () => {
    const sample: PendingRequestPayload = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-2',
      kind: 'userInput',
      request: {
        question: 'What is your name?',
        choices: ['Alice', 'Bob'],
        allowFreeform: true,
      },
    };
    expect(sample).toMatchSnapshot();
  });

  test('PendingRequestPayload — elicitation url', () => {
    const sample: PendingRequestPayload = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-3',
      kind: 'elicitation',
      request: {
        message: 'Authenticate to GitHub',
        mode: 'url',
        elicitationSource: 'mcp/github',
        url: 'https://github.com/login/oauth/authorize',
      },
    };
    expect(sample).toMatchSnapshot();
  });

  test('PendingRequestPayload — exit plan mode', () => {
    const sample: PendingRequestPayload = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-4',
      kind: 'exitPlanMode',
      request: {
        summary: '- Implement the plan',
        planContent: '# Plan: Do the thing.',
        actions: ['interactive', 'autopilot', 'exit_only', 'autopilot_fleet'],
        recommendedAction: 'interactive',
      },
    };
    expect(sample).toMatchSnapshot();
  });

  test('PendingRequestPayload — auto mode switch', () => {
    const sample: PendingRequestPayload = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-5',
      kind: 'autoModeSwitch',
      request: { errorCode: 'rate_limit', retryAfterSeconds: 60 },
    };
    expect(sample).toMatchSnapshot();
  });

  test('RespondToRequestParams — permission approve once', () => {
    const sample: RespondToRequestParams = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-1',
      response: { kind: 'permission', decision: 'approveOnce' },
    };
    expect(sample).toMatchSnapshot();
  });

  test('RespondToRequestParams — permission approve for session (commands rule)', () => {
    const sample: RespondToRequestParams = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-1c',
      response: {
        kind: 'permission',
        decision: 'approveForSession',
        approval: { kind: 'commands', commandIdentifiers: ['git'] },
      },
    };
    expect(sample).toMatchSnapshot();
  });

  test('RespondToRequestParams — permission approve for session (mcp tool)', () => {
    const sample: RespondToRequestParams = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-1m',
      response: {
        kind: 'permission',
        decision: 'approveForSession',
        approval: { kind: 'mcp', serverName: 'github', toolName: 'list_issues' },
      },
    };
    expect(sample).toMatchSnapshot();
  });

  test('RespondToRequestParams — permission approve for session (url domain)', () => {
    const sample: RespondToRequestParams = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-1u',
      response: {
        kind: 'permission',
        decision: 'approveForSession',
        domain: 'github.com',
      },
    };
    expect(sample).toMatchSnapshot();
  });

  test('RespondToRequestParams — userInput freeform', () => {
    const sample: RespondToRequestParams = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-2',
      response: { kind: 'userInput', answer: 'Alice', wasFreeform: false },
    };
    expect(sample).toMatchSnapshot();
  });

  test('RespondToRequestParams — elicitation accept', () => {
    const sample: RespondToRequestParams = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-3',
      response: { kind: 'elicitation', action: 'accept' },
    };
    expect(sample).toMatchSnapshot();
  });

  test('RespondToRequestParams — exit plan mode autopilot fleet', () => {
    const sample: RespondToRequestParams = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-4',
      response: {
        kind: 'exitPlanMode',
        approved: true,
        selectedAction: 'autopilot_fleet',
      },
    };
    expect(sample).toMatchSnapshot();
  });

  test('RespondToRequestParams — auto mode switch yes always', () => {
    const sample: RespondToRequestParams = {
      sessionId: 'sess-1',
      requestId: 'req-uuid-5',
      response: { kind: 'autoModeSwitch', response: 'yes_always' },
    };
    expect(sample).toMatchSnapshot();
  });
});

describe('IPC wire contracts — diagnostics', () => {
  test('LogRecord shape (info + warn + error variants)', () => {
    const samples: import('../rpc').LogRecord[] = [
      {
        ts: '2026-05-21T20:00:00.000Z',
        level: 'info',
        message: 'session resumed',
        sessionId: 'sess-1',
      },
      { ts: '2026-05-21T20:00:01.123Z', level: 'warn', message: 'ratelimited', retryMs: 1200 },
      {
        ts: '2026-05-21T20:00:02.456Z',
        level: 'error',
        message: 'boot failed',
        error: 'spawn ENOENT',
      },
    ];
    expect(samples).toMatchSnapshot();
  });

  test('getLogState response shape', () => {
    const sample = {
      level: 'info' as import('../rpc').LogLevel,
      recent: [
        {
          ts: '2026-05-21T20:00:00.000Z',
          level: 'info' as import('../rpc').LogLevel,
          message: 'ready',
        },
      ],
    };
    expect(sample).toMatchSnapshot();
  });

  test('exportDiagnostics result shape', () => {
    const sample = {
      path: 'C:/Users/mahle/AppData/Local/Dafman/dafman-diagnostics-2026-05-21-2030',
      files: ['logs/dafman-2026-05-21.log', 'logs/recent.json', 'settings.json', 'README.md'],
      totalBytes: 12345,
    };
    expect(sample).toMatchSnapshot();
  });

  test('saveExportFile result shape', () => {
    const sample = {
      path: 'C:/Users/mahle/AppData/Local/Dafman/exports/refactor-session-2026-05-22-…md',
      bytes: 4242,
    };
    expect(sample).toMatchSnapshot();
  });

  test('AuditEntry permission + url + mcp shapes', () => {
    const samples: import('../rpc').AuditEntry[] = [
      {
        ts: '2026-05-22T00:00:00.000Z',
        kind: 'permission',
        sessionId: 'sess-1',
        requestId: 'req-1',
        permissionKind: 'shell',
        decision: 'approveOnce',
        summary: 'shell: git status',
      },
      {
        ts: '2026-05-22T00:00:01.000Z',
        kind: 'permission',
        sessionId: 'sess-1',
        requestId: 'req-2',
        permissionKind: 'url',
        decision: 'approveForSession',
        approvalDomain: 'github.com',
      },
      {
        ts: '2026-05-22T00:00:02.000Z',
        kind: 'url',
        url: 'https://github.com/login',
        allowed: true,
        reason: 'ok',
      },
      {
        ts: '2026-05-22T00:00:03.000Z',
        kind: 'mcp',
        sessionId: 'sess-1',
        serverName: 'github',
        toolName: 'create_issue',
        toolCallId: 'tc-1',
        argKeys: ['title', 'body'],
        argKeyCount: 2,
      },
    ];
    expect(samples).toMatchSnapshot();
  });

  test('WorkspaceFileMatch carries kind', () => {
    const samples: import('../rpc').WorkspaceFileMatch[] = [
      { path: 'README.md', absolutePath: '/r/README.md', name: 'README.md', kind: 'file' },
      { path: 'src', absolutePath: '/r/src', name: 'src', kind: 'directory' },
      {
        path: '~/Documents',
        absolutePath: '/home/u/Documents',
        name: 'Documents',
        kind: 'directory',
      },
    ];
    expect(samples).toMatchSnapshot();
  });

  test('InstructionSource shape', () => {
    const samples: InstructionSource[] = [
      {
        name: 'AGENTS.md',
        scope: 'project',
        path: 'C:\\repo\\dafman\\AGENTS.md',
        relativePath: 'AGENTS.md',
        exists: true,
        content: '# Rules',
        sizeBytes: 7,
      },
      {
        name: 'Copilot user instructions',
        scope: 'global',
        path: 'C:\\Users\\me\\.copilot\\instructions.md',
        relativePath: 'C:\\Users\\me\\.copilot\\instructions.md',
        exists: false,
        content: null,
        sizeBytes: null,
      },
    ];
    expect(samples).toMatchSnapshot();
  });

  test('pickAttachment result shape', () => {
    const cancel: { path: string; kind: 'file' | 'directory' } | null = null;
    const file = { path: 'C:/abs/foo.txt', kind: 'file' as const };
    const dir = { path: 'C:/abs/repo', kind: 'directory' as const };
    expect({ cancel, file, dir }).toMatchSnapshot();
  });
});
