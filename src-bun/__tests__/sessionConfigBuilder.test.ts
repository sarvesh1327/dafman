// SessionConfigBuilder hook tests.
//
// Focused on the #37 `onPreMcpToolCall` hook: it must record a
// forensic MCP audit entry (server/tool/argKeys, never raw arg
// values), preserve `_meta` (return undefined), and never throw on
// the MCP critical path.

import { describe, expect, test, beforeEach } from 'bun:test';
import { buildBaseSessionConfig } from '../app/chat/sessionConfigBuilder';
import type { SessionConfigBuilderDeps } from '../app/chat/sessionConfigBuilder';
import {
  _resetAudit,
  recentAudit,
  subscribeAudit,
  type AuditEntry,
} from '../app/observability/audit';
import type { PendingRequestQueue } from '../app/chat/pendingRequests';
import type { PreMcpToolCallInput } from '../app/client/copilotSdk';

function makeDeps(): SessionConfigBuilderDeps {
  return {
    tools: [],
    emit: () => {},
    emitPending: () => {},
    approveAllBySession: new Map(),
    modeBySession: new Map(),
    // The MCP hook never touches the pending queue; a bare stub is
    // enough for these tests.
    pending: {} as PendingRequestQueue,
    streamingResolver: () => false,
    excludedToolsResolver: () => [],
    allowedToolsResolver: () => [],
  };
}

/// Minimal PreMcpToolCallInput-shaped object. The real SDK type is
/// structural; we build the fields the hook reads and cast.
function mcpInput(over: Record<string, unknown>): PreMcpToolCallInput {
  return {
    sessionId: 'sdk-sess',
    timestamp: Date.now(),
    workingDirectory: '/repo',
    serverName: 'github',
    toolName: 'create_issue',
    arguments: {},
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('sessionConfigBuilder onPreMcpToolCall (#37)', () => {
  beforeEach(() => {
    _resetAudit();
  });

  test('records an mcp audit entry with key names only and preserves _meta', () => {
    const config = buildBaseSessionConfig(makeDeps(), () => 'sess-1');
    const seen: AuditEntry[] = [];
    const unsubscribe = subscribeAudit((entry) => seen.push(entry));

    const result = config.hooks?.onPreMcpToolCall?.(
      mcpInput({
        serverName: 'github',
        toolName: 'create_issue',
        toolCallId: 'tc-9',
        arguments: { title: 'hi', token: 'super-secret' },
      }),
    );

    // Preserve _meta — the hook only observes.
    expect(result).toBeUndefined();

    // Audit entry recorded (synchronously into the ring).
    const ring = recentAudit();
    expect(ring).toHaveLength(1);
    const entry = ring[0];
    expect(entry?.kind).toBe('mcp');
    if (entry?.kind === 'mcp') {
      expect(entry.serverName).toBe('github');
      expect(entry.toolName).toBe('create_issue');
      expect(entry.toolCallId).toBe('tc-9');
      expect(entry.argKeys).toEqual(['title', 'token']);
      // Value never captured.
      expect(JSON.stringify(entry)).not.toContain('super-secret');
    }

    // Fan-out fired.
    expect(seen).toHaveLength(1);
    unsubscribe();
  });
});

/// Minimal PostToolUseFailureInput-shaped object. The real SDK type is
/// structural; we build the fields the hook reads and cast.
function failureInput(over: Record<string, unknown>): import('../app/client/copilotSdk').PostToolUseFailureInput {
  return {
    sessionId: 'sdk-sess',
    timestamp: Date.now(),
    workingDirectory: '/repo',
    toolName: 'str_replace_editor',
    toolArgs: {},
    error: 'boom',
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('sessionConfigBuilder onPostToolUseFailure (#36)', () => {
  beforeEach(() => {
    _resetAudit();
  });

  test('records a toolFailure audit entry with the SDK error and key names only', () => {
    const config = buildBaseSessionConfig(makeDeps(), () => 'sess-1');
    const seen: AuditEntry[] = [];
    const unsubscribe = subscribeAudit((entry) => seen.push(entry));

    const result = config.hooks?.onPostToolUseFailure?.(
      failureInput({
        toolName: 'str_replace_editor',
        toolArgs: { command: 'str_replace', path: '/repo/a.ts', secret: 'super-secret' },
        error: 'No replacement performed: old_str not found',
      }),
    );

    // Observe-only — never injects additionalContext.
    expect(result).toBeUndefined();

    const ring = recentAudit();
    expect(ring).toHaveLength(1);
    const entry = ring[0];
    expect(entry?.kind).toBe('toolFailure');
    if (entry?.kind === 'toolFailure') {
      expect(entry.sessionId).toBe('sess-1');
      expect(entry.toolName).toBe('str_replace_editor');
      expect(entry.error).toBe('No replacement performed: old_str not found');
      expect(entry.argKeys).toEqual(['command', 'path', 'secret']);
      // Argument VALUES are never captured.
      expect(JSON.stringify(entry)).not.toContain('super-secret');
    }

    expect(seen).toHaveLength(1);
    unsubscribe();
  });

  test('does not throw when toolArgs is exotic (returns undefined)', () => {
    const config = buildBaseSessionConfig(makeDeps(), () => 'sess-1');

    const result = config.hooks?.onPostToolUseFailure?.(
      failureInput({ toolArgs: 'not-an-object', toolName: 'fetch', error: 'timeout' }),
    );

    expect(result).toBeUndefined();
    const ring = recentAudit();
    expect(ring).toHaveLength(1);
    if (ring[0]?.kind === 'toolFailure') {
      expect(ring[0].argKeys).toEqual([]);
      expect(ring[0].argKeyCount).toBe(0);
      expect(ring[0].error).toBe('timeout');
    }
  });
});
