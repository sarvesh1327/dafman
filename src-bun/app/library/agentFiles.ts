// Filesystem CRUD for user-authored custom agent definitions
// (Phase 19b.2). The SDK auto-discovers agents from disk on
// session create / resume / reload; this module writes the same
// shape so newly-created agents surface in the picker after a
// `session.rpc.agent.reload` call.
//
// Scope:
//   - User:    `<userConfigDir>/agents/<name>.agent.md`
//   - Project: `<workingDirectory>/.github/agents/<name>.agent.md`
//
// We use `.agent.md` (not bare `.md`) so the SDK's loader (which
// prefers `.agent.md` when both forms exist) treats our files as
// agents unambiguously, and so we don't conflict with arbitrary
// markdown the user might have in the same directory.
//
// **Edit safety (added 2026-05-27, corrected 2026-05-31).** The SDK
// strips genuinely-unknown top-level frontmatter keys with a warning,
// but `github` and `mcp-servers` are modeled strictly (wrong shape
// rejects the whole agent file). Dafman's `displayName` is currently
// unknown to the SDK and is stripped + warned. Editing any key outside
// our minimal model via our serializer would silently strip it. We
// solve this WITHOUT a YAML round-trip library:
// `readAgentForEdit` parses known keys into the spec subset AND
// captures unknown keys as a verbatim byte-for-byte tail; `writeAgent`
// appends that tail back after our own frontmatter emit. So Edit
// preserves unknown keys exactly even though we can't reason about
// their shape.

import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { AppError } from '../shared/errors';
import { log } from '../observability/logging';
import { toErrorMessage } from '../shared/errorMessage';

/// Per the SDK app.js: `userConfigDir` resolves to `~/.copilot/`
/// (Linux/macOS) or %APPDATA%/.copilot on Windows in practice. We
/// match by defaulting to `homedir()/.copilot/agents/` — Electrobun
/// also persists settings under `Utils.paths.userData` which differs
/// per platform; but the SDK's agent loader specifically reads from
/// the homedir-derived path so we have to match THAT, not Electrobun's
/// userData.
export function userAgentsDir(): string {
  return join(homedir(), '.copilot', 'agents');
}

export function projectAgentsDir(workingDirectory: string): string {
  return join(workingDirectory, '.github', 'agents');
}

export type AgentScope = 'user' | 'project';

export interface AgentFileSpec {
  scope: AgentScope;
  /// Base filename (no `.agent.md` suffix, no path). Validated
  /// against `NAME_RE` + Windows reserved names before any I/O.
  name: string;
  /// Optional `displayName` frontmatter key. SDK falls back to
  /// `name` if missing — we keep undefined out of the file rather
  /// than emit `displayName: name` to avoid noise.
  displayName?: string;
  /// REQUIRED by the SDK's frontmatter schema. Empty string would
  /// pass Zod but is user-hostile; we reject empty descriptions
  /// at write time.
  description: string;
  /// `tools` frontmatter: empty array means inherit ("*").
  tools?: string[];
  /// `skills` frontmatter: which preloaded skills the agent gets.
  skills?: string[];
  /// `model` frontmatter (optional model override).
  model?: string;
  /// `user-invocable` frontmatter, defaults true in the SDK.
  userInvocable?: boolean;
  /// Markdown body — the agent's prompt. Stored verbatim AFTER the
  /// frontmatter; lexer treats it as the prompt template.
  prompt: string;
}

export interface DiscoveredAgentFile {
  scope: AgentScope;
  name: string;
  path: string;
  /// True iff the file's basename ends with `.agent.md` (our
  /// written form). Files ending in `.md` without the `.agent`
  /// segment may exist (e.g. user-edited or SDK-discovered files
  /// from older conventions) — we surface them but recommend
  /// using `.agent.md` for new entries.
  canonical: boolean;
}

/// Filename validation: alphanumerics, dot, hyphen, underscore.
/// Allows `my-agent`, `my.agent.v2`, `my_agent_v2`; rejects path
/// separators, drive prefixes, leading/trailing dots, spaces, etc.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/// Windows reserved device names (case-insensitive) that can't be
/// used as filenames. Per Microsoft's docs.
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/// Validates an agent `name` before any path construction. Throws
/// `AppError.sdk` on rejection so the renderer gets a typed error
/// surface. Exported for tests + so the renderer can pre-validate.
export function validateAgentName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw AppError.sdk('agent name is required');
  }

  if (name.length > 64) {
    throw AppError.sdk('agent name too long (max 64 chars)');
  }

  if (!NAME_RE.test(name)) {
    throw AppError.sdk(
      'agent name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} (letters, digits, dot, hyphen, underscore)',
    );
  }

  if (WINDOWS_RESERVED.has(name.toLowerCase())) {
    throw AppError.sdk(`agent name "${name}" is a Windows reserved device name`);
  }
}

/// Resolves the target file path for a (scope, name) pair and
/// verifies the result is contained within the expected root. The
/// root-check is defense in depth — `validateAgentName` already
/// rejects path traversal characters, but normalizing + checking
/// the prefix catches platform-specific edge cases (NTFS short
/// names, etc.).
function resolveTargetPath(
  scope: AgentScope,
  name: string,
  workingDirectory?: string,
): { path: string; root: string } {
  validateAgentName(name);
  let root: string;

  if (scope === 'user') {
    root = userAgentsDir();
  } else if (scope === 'project') {
    if (!workingDirectory) {
      throw AppError.sdk('project scope requires a workingDirectory');
    }

    if (!isAbsolute(workingDirectory)) {
      throw AppError.sdk('workingDirectory must be absolute');
    }

    root = projectAgentsDir(workingDirectory);
  } else {
    throw AppError.sdk(`unknown agent scope: ${scope as string}`);
  }

  const normalizedRoot = normalize(root);
  const filename = `${name}.agent.md`;
  const candidate = resolve(normalizedRoot, filename);
  const rel = relative(normalizedRoot, candidate);

  if (rel.startsWith('..') || isAbsolute(rel) || rel.includes('..')) {
    throw AppError.sdk(
      `resolved agent path escapes scope root: ${candidate} not under ${normalizedRoot}`,
    );
  }

  return { path: candidate, root: normalizedRoot };
}

/// Hand-rolled minimal YAML serializer for the frontmatter we
/// support. Limits: only flat key/value pairs (strings, booleans,
/// string arrays). No nested objects (`mcp-servers`, `github`).
/// This is intentional — see the v1 scope note at the top of the
/// file. If the rendered output ever needs to include nested keys,
/// switch to the `yaml` npm dep at that point.
function serializeFrontmatter(spec: AgentFileSpec): string {
  const lines: string[] = [];
  const quote = (s: string): string => {
    // JSON.stringify gives us double-quoted YAML strings with
    // correct escaping (`\n`, `\"`, etc.). Sufficient for our
    // scope; doesn't handle YAML-specific quirks like leading
    // `>` block-scalar markers, which we never emit.
    return JSON.stringify(s);
  };
  const emitArray = (key: string, items: string[]): void => {
    if (items.length === 0) {
      lines.push(`${key}: []`);

      return;
    }

    lines.push(`${key}:`);

    for (const item of items) lines.push(`  - ${quote(item)}`);
  };

  lines.push(`name: ${quote(spec.name)}`);

  if (spec.displayName !== undefined && spec.displayName !== spec.name) {
    lines.push(`displayName: ${quote(spec.displayName)}`);
  }

  lines.push(`description: ${quote(spec.description)}`);

  if (spec.tools && spec.tools.length > 0) emitArray('tools', spec.tools);

  if (spec.skills && spec.skills.length > 0) emitArray('skills', spec.skills);

  if (spec.model) lines.push(`model: ${quote(spec.model)}`);

  if (spec.userInvocable === false) lines.push('user-invocable: false');

  return lines.join('\n');
}

/// Atomic write: temp file in the same directory, then rename.
/// Renames on the same filesystem are atomic on every OS we care
/// about; the temp file gets a `.tmp-<rand>` suffix so concurrent
/// writes don't collide. On crash the temp leaks but we ignore it.
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${randomSuffix()}`;

  await writeFile(tmp, content, 'utf-8');

  try {
    // Use writeFile to do an atomic-enough overwrite via rename
    // fallback. Node's rename is atomic on POSIX; on Windows we
    // rely on it overwriting the destination if it exists (Node
    // 22+ supports it; otherwise we'd unlink first).
    const { rename } = await import('node:fs/promises');

    await rename(tmp, path);
  } catch (err) {
    // Cleanup tmp on failure so we don't leave it on disk.
    try {
      await rm(tmp, { force: true });
    } catch {
      /* ignore */
    }

    throw err;
  }
}

/// Splits a raw agent file into front-matter (between `---` fences)
/// and body. Empty front-matter is `""`. If the file has no opening
/// `---`, the whole file is body and front-matter is `""`.
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  // Accept both `\n` and `\r\n` line endings.
  const normalized = raw.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) {
    return { frontmatter: '', body: normalized };
  }

  const rest = normalized.slice(4);
  const closeIdx = rest.indexOf('\n---');

  if (closeIdx === -1) {
    // Unterminated front-matter — treat whole file as body.
    return { frontmatter: '', body: normalized };
  }

  const frontmatter = rest.slice(0, closeIdx);
  // The closing `---` is followed by `\n` or EOF; skip the marker
  // and one optional trailing newline (the canonical `---\n\n<body>`
  // emit form leaves a leading blank line in the body which we
  // preserve by not stripping it here).
  const afterClose = rest.slice(closeIdx + '\n---'.length);
  const body = afterClose.startsWith('\n') ? afterClose.slice(1) : afterClose;

  return { frontmatter, body };
}

/// Keys we model in `AgentFileSpec`. Anything else in the front-matter
/// is preserved verbatim by the Edit path. Keep in sync with
/// `serializeFrontmatter` above.
const KNOWN_FRONTMATTER_KEYS = new Set<string>([
  'name',
  'displayName',
  'description',
  'tools',
  'skills',
  'model',
  'user-invocable',
]);

/// Parses raw agent front-matter into a known-keys subset (returned
/// as a partial `AgentFileSpec`) and a raw-preserved tail of any
/// keys we don't model. The tail is the original source lines, not
/// re-serialized — guarantees byte-perfect preservation of unknown
/// keys including comments and unusual quoting we don't emit ourselves.
///
/// This is the v2 Edit path's safety net: we never have to round-trip
/// `mcp-servers` / `github.toolsets` / etc. through a YAML library
/// to preserve them — we just leave the original bytes alone.
export function parseAgentFrontmatter(frontmatter: string): {
  spec: Partial<AgentFileSpec>;
  preservedTail: string;
} {
  const spec: Partial<AgentFileSpec> = {};
  const preservedLines: string[] = [];

  // Walk lines top-down; for each, decide if it starts a known key
  // (drop until next top-level key or block end) or is part of an
  // unknown key block (push to preservedLines).
  const lines = frontmatter.split('\n');
  let i = 0;

  function readTopLevelKey(line: string): string | null {
    // Top-level YAML key: `^[a-zA-Z_-]+:`. Indented lines belong to
    // the previous key's block.
    const m = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:/.exec(line);

    return m ? m[1] : null;
  }

  function unquote(raw: string): string {
    const trimmed = raw.trim();

    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      // Both JSON.parse and a manual single-quote strip would work;
      // double-quoted strings are what `serializeFrontmatter` emits
      // so JSON.parse round-trips them exactly. Single-quoted is
      // handled as a literal strip — sufficient for hand-written files.
      if (trimmed.startsWith('"')) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return trimmed.slice(1, -1);
        }
      }

      return trimmed.slice(1, -1);
    }

    return trimmed;
  }

  while (i < lines.length) {
    const line = lines[i];
    const key = readTopLevelKey(line);

    if (key === null) {
      // Stray indented line or blank line at top level; preserve.
      preservedLines.push(line);
      i++;
      continue;
    }

    // Collect the key's block: this line + any indented continuation.
    const blockStart = i;

    i++;

    while (i < lines.length) {
      const peek = lines[i];

      if (peek === '' || /^\s/.test(peek)) {
        i++;
        continue;
      }

      // Next top-level key (or end-of-front-matter sentinel) → stop.
      break;
    }

    const blockLines = lines.slice(blockStart, i);

    if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
      preservedLines.push(...blockLines);
      continue;
    }

    // Known key: extract value(s).
    const head = blockLines[0];
    const valueRaw = head.slice(head.indexOf(':') + 1);

    if (key === 'tools' || key === 'skills') {
      // Array — either `tools: []` or block form:
      //   tools:
      //     - "read"
      //     - "shell"
      const items: string[] = [];
      const inline = valueRaw.trim();

      if (inline === '[]') {
        // empty
      } else if (inline.startsWith('[') && inline.endsWith(']')) {
        // Flow-style array. Best-effort split on commas, then unquote.
        const inner = inline.slice(1, -1).trim();

        if (inner.length > 0) {
          for (const part of inner.split(',')) items.push(unquote(part));
        }
      } else {
        for (const cont of blockLines.slice(1)) {
          const m = /^\s*-\s*(.*)$/.exec(cont);

          if (m) items.push(unquote(m[1]));
        }
      }

      spec[key] = items;
    } else if (key === 'user-invocable') {
      spec.userInvocable = unquote(valueRaw).toLowerCase() === 'true';
    } else if (key === 'displayName') {
      spec.displayName = unquote(valueRaw);
    } else if (key === 'name' || key === 'description' || key === 'model') {
      spec[key] = unquote(valueRaw);
    }
  }

  // Trim leading/trailing blank lines from preserved tail so the
  // joined output doesn't accumulate them across edits.
  while (preservedLines.length > 0 && preservedLines[0].trim() === '') {
    preservedLines.shift();
  }

  while (preservedLines.length > 0 && preservedLines[preservedLines.length - 1].trim() === '') {
    preservedLines.pop();
  }

  return { spec, preservedTail: preservedLines.join('\n') };
}

/// Reads an agent file from disk and returns the parsed spec + body
/// + preserved unknown-keys tail. Used by the Edit form to prefill;
/// the writePath uses `preservedTail` to keep unknown keys intact.
export async function readAgentForEdit(
  scope: AgentScope,
  name: string,
  workingDirectory?: string,
): Promise<{ spec: Partial<AgentFileSpec>; prompt: string; preservedTail: string; path: string }> {
  const { path } = resolveTargetPath(scope, name, workingDirectory);

  if (!existsSync(path)) {
    throw AppError.sdk(`agent not found at ${path}`);
  }

  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(path, 'utf-8');
  const { frontmatter, body } = splitFrontmatter(raw);
  const { spec, preservedTail } = parseAgentFrontmatter(frontmatter);

  // Set scope/name on the partial spec for round-trip convenience.
  spec.scope = scope;

  if (spec.name === undefined) spec.name = name;

  return { spec, prompt: body.trim(), preservedTail, path };
}

function randomSuffix(): string {
  // 6 hex chars from random. crypto.randomBytes is overkill for
  // a temp-file suffix.
  return Math.random().toString(16).slice(2, 8);
}

/// Lists discovered agent files from disk for the given scopes.
/// Does NOT call the SDK — this is the file-list view for the
/// Library tab, which needs to know what we can edit/delete
/// independently of whether they're loaded into an active session.
/// Returns empty arrays for any scope whose directory doesn't
/// exist (not an error).
export async function listAgentFiles(opts: {
  includeUser?: boolean;
  includeProject?: boolean;
  workingDirectory?: string;
}): Promise<DiscoveredAgentFile[]> {
  const out: DiscoveredAgentFile[] = [];
  const tasks: Array<Promise<void>> = [];

  if (opts.includeUser !== false) {
    tasks.push(scanDir(userAgentsDir(), 'user', out));
  }

  if (opts.includeProject !== false && opts.workingDirectory) {
    tasks.push(scanDir(projectAgentsDir(opts.workingDirectory), 'project', out));
  }

  await Promise.all(tasks);

  return out;
}

async function scanDir(dir: string, scope: AgentScope, out: DiscoveredAgentFile[]): Promise<void> {
  if (!existsSync(dir)) return;

  let entries: string[];

  try {
    entries = await readdir(dir, { encoding: 'utf-8' });
  } catch (err) {
    log.warn('listAgentFiles: failed to read dir', {
      dir,
      error: toErrorMessage(err),
    });

    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const canonical = entry.endsWith('.agent.md');
    const name = entry.replace(/(\.agent)?\.md$/, '');

    out.push({
      scope,
      name,
      path: join(dir, entry),
      canonical,
    });
  }
}

/// Creates or overwrites an agent file. To preserve unknown
/// frontmatter keys on Edit, pass `preservedTail` from
/// `readAgentForEdit`. When `allowOverwrite` is true, an existing
/// file will be replaced; otherwise we refuse (matching the original
/// create-only semantics).
export async function writeAgent(
  spec: AgentFileSpec,
  workingDirectory?: string,
  options: { allowOverwrite?: boolean; preservedTail?: string } = {},
): Promise<string> {
  if (!spec.description || spec.description.trim().length === 0) {
    throw AppError.sdk('description is required');
  }

  const { path, root } = resolveTargetPath(spec.scope, spec.name, workingDirectory);

  if (existsSync(path) && !options.allowOverwrite) {
    throw AppError.sdk(`agent already exists at ${path}; delete it first to overwrite`);
  }

  await mkdir(root, { recursive: true });
  let frontmatter = serializeFrontmatter(spec);

  if (options.preservedTail && options.preservedTail.length > 0) {
    // Append unknown keys verbatim so things like `mcp-servers` or
    // `github.toolsets` survive an Edit. The byte-perfect preserved
    // tail comes from `parseAgentFrontmatter`.
    frontmatter = `${frontmatter}\n${options.preservedTail}`;
  }

  const body = spec.prompt.trim().length > 0 ? `${spec.prompt.trim()}\n` : '';
  const content = `---\n${frontmatter}\n---\n\n${body}`;

  await atomicWrite(path, content);
  log.info('wrote agent file', { path, scope: spec.scope, name: spec.name });

  return path;
}

/// Deletes an agent file. Verifies the resolved path is under the
/// expected root before any unlink. Returns true if a file was
/// removed, false if it didn't exist.
export async function deleteAgent(
  scope: AgentScope,
  name: string,
  workingDirectory?: string,
): Promise<boolean> {
  const { path } = resolveTargetPath(scope, name, workingDirectory);

  if (!existsSync(path)) return false;

  const info = await stat(path);

  if (!info.isFile()) {
    throw AppError.sdk(`refusing to delete non-file at ${path}`);
  }

  await rm(path, { force: true });
  log.info('deleted agent file', { path, scope, name });

  return true;
}
