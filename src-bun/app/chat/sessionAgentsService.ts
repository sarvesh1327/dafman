// SessionAgentsService — SDK agent.* surface + filesystem-level
// agent file CRUD (Phase 19b.2).
//
// Extracted from `SessionRegistry` (Phase D.3.4, 2026-05-26).
// Includes both:
// - SDK-side: list / getCurrent / select / deselect / reload (the
//   five @experimental `session.rpc.agent.*` calls)
// - filesystem-side: list / write / delete agent files in the
//   library tree (project + user scope). The fs writes call back
//   into `session.rpc.agent.reload()` so the SDK's view stays in
//   sync; failures of the reload are logged but never thrown
//   (best-effort).

import { log } from '../observability/logging';
import { AppError } from '../shared/errors';
import { toErrorMessage } from '../shared/errorMessage';
import {
  listAgentFiles,
  writeAgent,
  deleteAgent,
  readAgentForEdit,
  type AgentFileSpec,
  type AgentScope as AgentFileScope,
} from '../library/agentFiles';
import { normalizeAgent } from './sessionHelpers';
import type { AgentInfo } from '../../rpc';
import type { SessionServiceContext } from './sessionServiceContext';

export interface AgentFileEntry {
  scope: AgentFileScope;
  name: string;
  path: string;
  canonical: boolean;
  loadStatus: 'loaded' | 'rejected' | 'unknown';
  loadMessage?: string;
  loadWarnings?: string[];
}

export class SessionAgentsService {
  constructor(private readonly ctx: SessionServiceContext) {}

  async list(sessionId: string): Promise<AgentInfo[]> {
    const entry = this.ctx.getEntry(sessionId);

    return this.ctx.wrapSdk(async () => {
      const result = (await entry.session.rpc.agent.list()) as {
        agents?: Array<{
          name?: unknown;
          displayName?: unknown;
          description?: unknown;
          path?: unknown;
        }>;
      };

      return (result.agents ?? []).filter((a) => typeof a.name === 'string').map(normalizeAgent);
    });
  }

  async getCurrent(sessionId: string): Promise<AgentInfo | null> {
    const entry = this.ctx.getEntry(sessionId);

    return this.ctx.wrapSdk(async () => {
      const result = (await entry.session.rpc.agent.getCurrent()) as {
        agent?: {
          name?: unknown;
          displayName?: unknown;
          description?: unknown;
          path?: unknown;
        } | null;
      };

      if (!result.agent || typeof result.agent.name !== 'string') return null;

      return normalizeAgent(result.agent);
    });
  }

  async select(sessionId: string, name: string): Promise<AgentInfo> {
    const entry = this.ctx.getEntry(sessionId);

    return this.ctx.wrapSdk(async () => {
      let result: {
        agent?: {
          name?: unknown;
          displayName?: unknown;
          description?: unknown;
          path?: unknown;
        };
      };

      try {
        result = await entry.session.rpc.agent.select({ name });
      } catch (err) {
        const rejected = await this.findRejectedFile(sessionId, name);

        if (rejected) {
          throw AppError.sdk(rejectedAgentMessage(rejected));
        }

        throw err;
      }

      if (!result.agent || typeof result.agent.name !== 'string') {
        throw AppError.sdk('selectAgent: SDK returned no agent');
      }

      return normalizeAgent(result.agent);
    });
  }

  async deselect(sessionId: string): Promise<boolean> {
    const entry = this.ctx.getEntry(sessionId);

    return this.ctx.wrapSdk(async () => {
      await entry.session.rpc.agent.deselect();

      return true;
    });
  }

  async reload(sessionId: string): Promise<AgentInfo[]> {
    const entry = this.ctx.getEntry(sessionId);

    return this.ctx.wrapSdk(async () => {
      const result = (await entry.session.rpc.agent.reload()) as {
        agents?: Array<{
          name?: unknown;
          displayName?: unknown;
          description?: unknown;
          path?: unknown;
        }>;
      };

      return (result.agents ?? []).filter((a) => typeof a.name === 'string').map(normalizeAgent);
    });
  }

  // ---------- Filesystem agent files (Phase 19b.2) ----------

  async listFiles(
    sessionId: string,
    options: { reloadSdk?: boolean } = {},
  ): Promise<AgentFileEntry[]> {
    const entry = this.ctx.getEntry(sessionId);
    const opts: Parameters<typeof listAgentFiles>[0] = {
      includeUser: true,
      includeProject: true,
    };

    if (options.reloadSdk) {
      try {
        await this.reload(sessionId);
      } catch (err) {
        log.warn('agent.reload before listAgentFiles failed', {
          sessionId,
          error: toErrorMessage(err),
        });
      }
    }

    if (entry.workingDirectory) opts.workingDirectory = entry.workingDirectory;

    const files = await listAgentFiles(opts);

    return this.withSdkLoadState(sessionId, files);
  }

  /// User-scope only — for the Library tab when no session is
  /// open. Doesn't require sessionId / workingDirectory.
  async listFilesGlobal(): Promise<AgentFileEntry[]> {
    const files = await listAgentFiles({ includeUser: true, includeProject: false });

    return files.map((file) => ({ ...file, loadStatus: 'unknown' }));
  }

  async writeFile(
    sessionId: string,
    spec: AgentFileSpec,
    options: { allowOverwrite?: boolean; preservedTail?: string } = {},
  ): Promise<string> {
    // User-scope writes don't need a workingDirectory; project
    // scope does. The registry resolves it from the session entry
    // (no caller-supplied workingDirectory string allowed — defense
    // in depth: a malicious renderer could otherwise pass an
    // arbitrary path).
    const entry = this.ctx.getEntry(sessionId);
    const wd = spec.scope === 'project' ? (entry.workingDirectory ?? undefined) : undefined;

    if (spec.scope === 'project' && !wd) {
      throw AppError.sdk('project scope requires a session with a working directory');
    }

    const path = await writeAgent(spec, wd, options);

    // Tell the SDK to re-scan so the new agent shows up in
    // `session.rpc.agent.list` immediately. Best-effort: a failed
    // reload doesn't block the user's write.
    try {
      await entry.session.rpc.agent.reload();
    } catch (err) {
      log.warn('agent.reload after writeAgentFile failed', {
        sessionId,
        error: toErrorMessage(err),
      });
    }

    return path;
  }

  /// Reads an agent for the Edit form. Returns the known-keys spec
  /// subset + body + any unknown frontmatter keys preserved verbatim
  /// (caller passes the tail back to `writeFile` to keep them).
  async readFile(
    sessionId: string,
    scope: AgentFileScope,
    name: string,
  ): Promise<{
    spec: Partial<AgentFileSpec>;
    prompt: string;
    preservedTail: string;
    path: string;
  }> {
    const entry = this.ctx.getEntry(sessionId);
    const wd = scope === 'project' ? (entry.workingDirectory ?? undefined) : undefined;

    if (scope === 'project' && !wd) {
      throw AppError.sdk('project scope requires a session with a working directory');
    }

    return readAgentForEdit(scope, name, wd);
  }

  async deleteFile(sessionId: string, scope: AgentFileScope, name: string): Promise<boolean> {
    const entry = this.ctx.getEntry(sessionId);
    const wd = scope === 'project' ? (entry.workingDirectory ?? undefined) : undefined;

    if (scope === 'project' && !wd) {
      throw AppError.sdk('project scope requires a session with a working directory');
    }

    const removed = await deleteAgent(scope, name, wd);

    if (removed) {
      try {
        await entry.session.rpc.agent.reload();
      } catch (err) {
        log.warn('agent.reload after deleteAgentFile failed', {
          sessionId,
          error: toErrorMessage(err),
        });
      }
    }

    return removed;
  }

  private async findRejectedFile(
    sessionId: string,
    name: string,
  ): Promise<AgentFileEntry | undefined> {
    const files = await this.listFiles(sessionId);
    const wanted = name.toLowerCase();

    return files.find(
      (file) => file.name.toLowerCase() === wanted && file.loadStatus === 'rejected',
    );
  }

  private async withSdkLoadState(
    sessionId: string,
    files: Array<Omit<AgentFileEntry, 'loadStatus' | 'loadMessage' | 'loadWarnings'>>,
  ): Promise<AgentFileEntry[]> {
    let loadedAgents: AgentInfo[] = [];

    try {
      loadedAgents = await this.list(sessionId);
    } catch (err) {
      log.warn('agent.list before annotating listAgentFiles failed', {
        sessionId,
        error: toErrorMessage(err),
      });

      return files.map((file) => ({ ...file, loadStatus: 'unknown' }));
    }

    const loadedPaths = new Set(
      loadedAgents
        .map((agent) => (agent.path ? normalizePathKey(agent.path) : null))
        .filter((path): path is string => path !== null),
    );
    const loadedNames = new Set(loadedAgents.map((agent) => agent.name.toLowerCase()));
    const diagnostics = this.ctx.getAgentLoadDiagnostics?.(sessionId);
    const hasLoadedAgents = loadedAgents.length > 0;

    return files.map((file) => {
      const pathKey = normalizePathKey(file.path);
      const warnings = matchingDiagnostics(file, diagnostics?.warnings ?? []);
      const loadWarnings = warnings.length > 0 ? warnings : undefined;
      const loaded =
        loadedPaths.has(pathKey) ||
        (loadedPaths.size === 0 && loadedNames.has(file.name.toLowerCase()));

      if (loaded) {
        return { ...file, loadStatus: 'loaded', ...(loadWarnings ? { loadWarnings } : {}) };
      }

      const errors = matchingDiagnostics(file, diagnostics?.errors ?? []);

      if (!hasLoadedAgents && errors.length === 0) {
        return { ...file, loadStatus: 'unknown', ...(loadWarnings ? { loadWarnings } : {}) };
      }

      const loadMessage =
        errors[0] ??
        `The Copilot SDK did not load this agent file. Check ${file.path} for malformed frontmatter, then refresh agents.`;

      return {
        ...file,
        loadStatus: 'rejected',
        loadMessage,
        ...(loadWarnings ? { loadWarnings } : {}),
      };
    });
  }
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function matchingDiagnostics(
  file: { name: string; path: string },
  diagnostics: string[],
): string[] {
  const filePath = normalizePathKey(file.path);
  const fileName = filePath.split('/').at(-1) ?? `${file.name}.agent.md`;
  const name = file.name.toLowerCase();
  const namePattern = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(name)}([^a-z0-9-]|$)`);

  const pathMatches = diagnostics.filter((diagnostic) => {
    const normalized = normalizePathKey(diagnostic);

    return normalized.includes(filePath) || normalized.includes(fileName);
  });

  if (pathMatches.length > 0) return pathMatches;

  return diagnostics.filter((diagnostic) => namePattern.test(normalizePathKey(diagnostic)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rejectedAgentMessage(file: AgentFileEntry): string {
  const reason = file.loadMessage ?? 'the Copilot SDK rejected its frontmatter';

  return `Custom agent "${file.name}" failed to load: ${reason} Fix ${file.path}, then refresh agents.`;
}
