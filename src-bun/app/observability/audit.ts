// Append-only audit log writers.
//
// Separate from the diagnostic JSON log (which can be redacted /
// rotated / cleared). Audit entries record privileged decisions —
// permission grants/denials, URL opens — for forensic review, never
// auto-deleted. One JSONL file per category under
// `<userData>/audit/`:
//
//   audit/permissions.jsonl   — every respondToRequest decision
//   audit/urls.jsonl          — every openUrl + decision
//   audit/commands.jsonl      — direct user-initiated shell commands
//   audit/mcp.jsonl           — every MCP tool call (server/tool/argKeys)
//   audit/toolFailures.jsonl  — every failed tool execution (tool/error)
//
// Schema: each line a JSON object with `ts` (ISO8601), `kind`, and
// kind-specific fields. Stable; future readers (an in-app Activity
// view) will parse this verbatim. Avoid raw user prompts or
// command bytes — record only what's strictly needed to answer
// "what was approved, when, by whom, on which session".

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logging';
import { toErrorMessage } from '../shared/errorMessage';

type PermissionAuditDecision = 'approveOnce' | 'approveForSession' | 'reject';

export interface PermissionAuditEntry {
  ts: string;
  kind: 'permission';
  sessionId: string;
  requestId: string;
  permissionKind: string; // shell / write / read / mcp / url / custom-tool / memory / hook
  decision: PermissionAuditDecision;
  /// One-line summary (matches what surfaced in the UI). Already
  /// redaction-safe — bun side derived this for the modal.
  summary?: string;
  /// For `approveForSession` decisions, the rule kind (`commands`,
  /// `read`, `write`, `mcp`, `url`, …). Lets a reader correlate
  /// "user granted blanket reads" without re-deriving from the raw
  /// SDK shape.
  approvalKind?: string;
  /// For `approveForSession` URL decisions, the domain that was
  /// allowed.
  approvalDomain?: string;
}

export interface UrlAuditEntry {
  ts: string;
  kind: 'url';
  url: string;
  allowed: boolean;
  /// "scheme-blocked" / "ok" — why the URL was/wasn't opened.
  reason: string;
}

export interface CommandAuditEntry {
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

/// One MCP tool invocation, recorded by the SDK `onPreMcpToolCall`
/// hook. Deliberately records NO argument values — only the MCP
/// server name, tool name, and the top-level argument key names
/// (`argKeys`, capped) so a reader can answer "which MCP tool ran,
/// when, on which session, shaped by which inputs" without the raw
/// (possibly secret-bearing) argument payload landing on disk.
export interface McpToolCallAuditEntry {
  ts: string;
  kind: 'mcp';
  sessionId: string;
  serverName: string;
  toolName: string;
  /// SDK-supplied correlation id when present.
  toolCallId?: string;
  /// Top-level own-enumerable string keys of the arguments object,
  /// capped at `ARG_KEYS_CAP`. Empty when arguments isn't a plain
  /// object. Key NAMES only — never values.
  argKeys?: string[];
  /// Total key count before the `ARG_KEYS_CAP` truncation, so a
  /// reader can tell when `argKeys` was clipped.
  argKeyCount?: number;
}

/// One failed tool execution, recorded by the SDK `onPostToolUseFailure`
/// hook (beta.9). The hook fires only for tool results whose
/// `resultType` is `"failure"` and carries the SDK's stringified
/// `error` message — the structured failure context, distinct from the
/// transcript event we parse from the stream. Like the mcp entry it
/// records argument key NAMES only (`argKeys`, capped) — never the raw
/// (possibly secret-bearing) argument values.
export interface ToolFailureAuditEntry {
  ts: string;
  kind: 'toolFailure';
  sessionId: string;
  toolName: string;
  /// SDK-provided failure message (the `error` field of the
  /// `PostToolUseFailureHookInput`).
  error: string;
  /// Top-level own-enumerable string keys of the tool arguments,
  /// capped at `ARG_KEYS_CAP`. Key NAMES only — never values.
  argKeys?: string[];
  /// Total key count before the `ARG_KEYS_CAP` truncation.
  argKeyCount?: number;
}

export type AuditEntry =
  | PermissionAuditEntry
  | UrlAuditEntry
  | CommandAuditEntry
  | McpToolCallAuditEntry
  | ToolFailureAuditEntry;

interface AuditConfig {
  dir: string | null;
}

const config: AuditConfig = { dir: null };

type Subscriber = (entry: AuditEntry) => void;
const subscribers = new Set<Subscriber>();

const RECENT_CAP = 500;
const recent: AuditEntry[] = [];

/// Cap on how many top-level argument key names land in an mcp
/// audit entry. Bounds the on-disk record size for tools called
/// with very wide argument objects.
const ARG_KEYS_CAP = 20;

/// Maps each audit kind to its JSONL filename. Exhaustive over the
/// `AuditEntry` union so adding a kind without a file is a compile
/// error (vs the previous ternary that silently defaulted unknown
/// kinds to commands.jsonl).
const AUDIT_FILES: Record<AuditEntry['kind'], string> = {
  permission: 'permissions.jsonl',
  url: 'urls.jsonl',
  command: 'commands.jsonl',
  mcp: 'mcp.jsonl',
  toolFailure: 'toolFailures.jsonl',
};

export interface InitAuditOptions {
  dir: string;
}

export async function initAudit(opts: InitAuditOptions): Promise<void> {
  config.dir = opts.dir;

  try {
    await mkdir(opts.dir, { recursive: true });
  } catch {
    // Best-effort — never block startup on audit log init.
  }

  // Hydrate the in-memory ring from the persisted JSONL files so
  // the Activity view shows history immediately on app restart
  // (otherwise the panel reads empty until the next live event).
  // Bounded by RECENT_CAP: read the last ~N lines from each file.
  await hydrateRecent();
}

/// Parse one JSONL audit-file line. Returns null for blanks and
/// malformed entries instead of throwing so the caller can stay flat.
function tryParseAuditLine(line: string): AuditEntry | null {
  if (!line.trim()) return null;

  try {
    const parsed = JSON.parse(line) as AuditEntry;

    if (parsed && typeof parsed === 'object' && (parsed as { kind?: string }).kind) {
      return parsed;
    }
  } catch {
    /* skip malformed line */
  }

  return null;
}

async function hydrateRecent(): Promise<void> {
  const dir = config.dir;

  if (!dir) return;

  const files = [
    'permissions.jsonl',
    'urls.jsonl',
    'commands.jsonl',
    'mcp.jsonl',
    'toolFailures.jsonl',
  ];
  const collected: AuditEntry[] = [];

  for (const name of files) {
    const path = join(dir, name);

    if (!existsSync(path)) continue;

    try {
      const raw = await readFile(path, 'utf8');
      const lines = raw.split(/\r?\n/);
      // Take the tail of the file; sufficient for the ring cap.
      const tail = lines.slice(Math.max(0, lines.length - RECENT_CAP));

      for (const line of tail) {
        const parsed = tryParseAuditLine(line);

        if (parsed) collected.push(parsed);
      }
    } catch (err) {
      log.warn('audit hydrate failed', {
        file: path,
        error: toErrorMessage(err),
      });
    }
  }

  // Sort by ts so interleaved categories restore in chronological
  // order. Trim to ring cap.
  collected.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const start = Math.max(0, collected.length - RECENT_CAP);

  for (let i = start; i < collected.length; i++) {
    recent.push(collected[i]);
  }
}

export function subscribeAudit(fn: Subscriber): () => void {
  subscribers.add(fn);

  return () => {
    subscribers.delete(fn);
  };
}

export function recentAudit(limit?: number): AuditEntry[] {
  if (limit === undefined || limit >= recent.length) return recent.slice();

  return recent.slice(recent.length - limit);
}

async function append(entry: AuditEntry): Promise<void> {
  pushRecent(entry);

  for (const sub of subscribers) {
    try {
      sub(entry);
    } catch {
      /* swallow */
    }
  }

  const dir = config.dir;

  if (!dir) return;

  const file = join(dir, AUDIT_FILES[entry.kind]);
  const line = `${JSON.stringify(entry)}\n`;

  try {
    await appendFile(file, line);
  } catch (err) {
    log.warn('audit append failed', {
      file,
      error: toErrorMessage(err),
    });
  }
}

function pushRecent(entry: AuditEntry): void {
  recent.push(entry);

  if (recent.length > RECENT_CAP) {
    recent.splice(0, recent.length - RECENT_CAP);
  }
}

/// Public surface: append-only writers. Returned promise resolves
/// when the record has been written + fanned out; callers (including
/// tests) can await it to deterministically observe the side-effects.
/// The shape lets the existing `void recordPermission(...)` /
/// `void recordUrl(...)` sites keep their fire-and-forget posture.
export function recordPermission(entry: Omit<PermissionAuditEntry, 'ts' | 'kind'>): Promise<void> {
  return append({ ts: new Date().toISOString(), kind: 'permission', ...entry });
}

export function recordUrl(entry: Omit<UrlAuditEntry, 'ts' | 'kind'>): Promise<void> {
  return append({ ts: new Date().toISOString(), kind: 'url', ...entry });
}

export function recordCommand(entry: Omit<CommandAuditEntry, 'ts' | 'kind'>): Promise<void> {
  return append({ ts: new Date().toISOString(), kind: 'command', ...entry });
}

export function recordMcpToolCall(
  entry: Omit<McpToolCallAuditEntry, 'ts' | 'kind'>,
): Promise<void> {
  return append({ ts: new Date().toISOString(), kind: 'mcp', ...entry });
}

/// Record a failed tool execution observed via the SDK
/// `onPostToolUseFailure` hook. Fire-and-forget like the other
/// recorders; returns a promise so tests can await the side-effect.
export function recordToolFailure(
  entry: Omit<ToolFailureAuditEntry, 'ts' | 'kind'>,
): Promise<void> {
  return append({ ts: new Date().toISOString(), kind: 'toolFailure', ...entry });
}

/// Derive the forensic-safe `argKeys` / `argKeyCount` for an mcp
/// audit entry from an MCP tool's raw `arguments` value. Records
/// only top-level own-enumerable string key NAMES (never values),
/// capped at `ARG_KEYS_CAP`. Returns empty key list for non-plain
/// objects (arrays, primitives, null). Defensive: never throws —
/// `Object.keys` on an exotic/proxy object that throws degrades to
/// an empty list rather than breaking the MCP call path.
export function extractArgKeys(args: unknown): {
  argKeys: string[];
  argKeyCount: number;
} {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { argKeys: [], argKeyCount: 0 };
  }

  try {
    const keys = Object.keys(args as Record<string, unknown>);

    return { argKeys: keys.slice(0, ARG_KEYS_CAP), argKeyCount: keys.length };
  } catch {
    return { argKeys: [], argKeyCount: 0 };
  }
}

/// Test-only.
export function _resetAudit(): void {
  config.dir = null;
  recent.length = 0;
  subscribers.clear();
}
