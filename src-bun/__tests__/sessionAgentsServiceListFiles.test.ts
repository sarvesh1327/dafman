// Regression test for #23 — "Library Agents tab does not show project agents".
//
// The file-layer `listAgentFiles` is covered by agentFiles.test.ts. The gap
// this test closes is the SERVICE boundary: `SessionAgentsService.listFiles`
// must resolve `entry.workingDirectory` from the session context and pass it
// through with `includeProject: true`, so a project agent dropped at
// `<cwd>/.github/agents/<name>.agent.md` surfaces in the Library Agents tab's
// Project section. Before the #51/#52 refresh work the tab silently showed
// user-scope only; this guards the resolved path end-to-end at the service.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAgentsService } from '../app/chat/sessionAgentsService';
import {
  wrapSdkError,
  type SessionEntryView,
  type SessionServiceContext,
} from '../app/chat/sessionServiceContext';
import type { CopilotSession } from '../app/client/copilotSdk';
import type { AgentLoadDiagnostics } from '../app/chat/sessionServiceContext';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'dafman-agentsvc-'));
});

afterEach(() => {
  if (workspaceDir) {
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/// Builds a context whose single registered session reports the given
/// workingDirectory. `listFiles` never touches the SDK session, so a bare
/// object cast is sufficient for the `session` field.
function makeSession(
  agents: Array<{ name: string; displayName?: string; description?: string; path?: string }> = [],
): CopilotSession {
  return {
    rpc: {
      agent: {
        list: async () => ({ agents }),
        select: async ({ name }: { name: string }) => {
          const agent = agents.find((a) => a.name === name);

          if (!agent) throw new Error(`unknown agent: ${name}`);

          return { agent };
        },
      },
    },
  } as unknown as CopilotSession;
}

function makeCtx(
  workingDirectory?: string,
  options: {
    agents?: Array<{ name: string; displayName?: string; description?: string; path?: string }>;
    diagnostics?: AgentLoadDiagnostics;
  } = {},
): SessionServiceContext {
  const entry: SessionEntryView = {
    session: makeSession(options.agents),
    ...(workingDirectory ? { workingDirectory } : {}),
  };

  return {
    getEntry: () => entry,
    getAgentLoadDiagnostics: () => options.diagnostics,
    wrapSdk: wrapSdkError,
  };
}

async function dropProjectAgent(name: string): Promise<void> {
  const dir = join(workspaceDir, '.github', 'agents');

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.agent.md`),
    `---\nname: ${name}\ndescription: a project agent\n---\n\nbody\n`,
    'utf-8',
  );
}

describe('SessionAgentsService.listFiles (#23 project agents)', () => {
  test('surfaces a project agent from the session working directory', async () => {
    await dropProjectAgent('reviewer');

    const agentPath = join(workspaceDir, '.github', 'agents', 'reviewer.agent.md');
    const svc = new SessionAgentsService(
      makeCtx(workspaceDir, {
        agents: [
          {
            name: 'reviewer',
            displayName: 'Reviewer',
            description: 'Reviews code',
            path: agentPath,
          },
        ],
      }),
    );
    const files = await svc.listFiles('s1');

    const project = files.filter((f) => f.scope === 'project');

    expect(project.length).toBeGreaterThan(0);

    const reviewer = project.find((f) => f.name === 'reviewer');

    expect(reviewer).toBeDefined();
    expect(reviewer?.canonical).toBe(true);
    // Acceptance: the row path matches the actual file location.
    expect(reviewer?.path).toBe(agentPath);
    expect(reviewer?.loadStatus).toBe('loaded');
  });

  test('returns no project agents when the session has no working directory', async () => {
    await dropProjectAgent('reviewer');

    const svc = new SessionAgentsService(makeCtx(undefined));
    const files = await svc.listFiles('s1');

    expect(files.filter((f) => f.scope === 'project')).toHaveLength(0);
  });

  test('keeps filesystem agents unknown when SDK list is empty and no diagnostics have loaded', async () => {
    await dropProjectAgent('reviewer');

    const svc = new SessionAgentsService(makeCtx(workspaceDir));
    const files = await svc.listFiles('s1');
    const reviewer = files.find((f) => f.scope === 'project' && f.name === 'reviewer');

    expect(reviewer).toMatchObject({
      loadStatus: 'unknown',
    });
  });

  test('marks filesystem agent files missing from SDK agent.list as rejected with diagnostics', async () => {
    await dropProjectAgent('reviewer');
    await dropProjectAgent('broken');

    const reviewerPath = join(workspaceDir, '.github', 'agents', 'reviewer.agent.md');
    const brokenPath = join(workspaceDir, '.github', 'agents', 'broken.agent.md');
    const svc = new SessionAgentsService(
      makeCtx(workspaceDir, {
        agents: [
          {
            name: 'reviewer',
            displayName: 'Reviewer',
            description: 'Reviews code',
            path: reviewerPath,
          },
        ],
        diagnostics: {
          errors: [
            `${brokenPath}: custom agent markdown frontmatter is malformed: mcp-servers.github.tools: Required`,
          ],
          warnings: [`${reviewerPath}: unknown field ignored: displayName`],
        },
      }),
    );

    const files = await svc.listFiles('s1');
    const reviewer = files.find((f) => f.scope === 'project' && f.name === 'reviewer');
    const broken = files.find((f) => f.scope === 'project' && f.name === 'broken');

    expect(reviewer).toMatchObject({
      loadStatus: 'loaded',
      loadWarnings: [`${reviewerPath}: unknown field ignored: displayName`],
    });
    expect(broken).toMatchObject({
      loadStatus: 'rejected',
      loadMessage: `${brokenPath}: custom agent markdown frontmatter is malformed: mcp-servers.github.tools: Required`,
    });
  });

  test('does not cross-attribute diagnostics between substring agent names', async () => {
    await dropProjectAgent('review');
    await dropProjectAgent('code-review-helper');

    const reviewPath = join(workspaceDir, '.github', 'agents', 'review.agent.md');
    const helperPath = join(workspaceDir, '.github', 'agents', 'code-review-helper.agent.md');
    const helperMessage = `${helperPath}: custom agent markdown frontmatter is malformed: mcp-servers.github.tools: Required`;
    const svc = new SessionAgentsService(
      makeCtx(workspaceDir, {
        agents: [
          {
            name: 'review',
            displayName: 'Review',
            description: 'Reviews code',
            path: reviewPath,
          },
        ],
        diagnostics: {
          errors: [helperMessage],
          warnings: [],
        },
      }),
    );

    const files = await svc.listFiles('s1');
    const review = files.find((f) => f.scope === 'project' && f.name === 'review');
    const helper = files.find((f) => f.scope === 'project' && f.name === 'code-review-helper');

    expect(review).toMatchObject({
      loadStatus: 'loaded',
    });
    expect(review?.loadMessage).toBeUndefined();
    expect(helper).toMatchObject({
      loadStatus: 'rejected',
      loadMessage: helperMessage,
    });
  });

  test('select rejects a filesystem-only agent with an actionable SDK-load message', async () => {
    await dropProjectAgent('broken');

    const brokenPath = join(workspaceDir, '.github', 'agents', 'broken.agent.md');
    const svc = new SessionAgentsService(
      makeCtx(workspaceDir, {
        agents: [],
        diagnostics: {
          errors: [
            `${brokenPath}: custom agent markdown frontmatter is malformed: description: Required`,
          ],
          warnings: [],
        },
      }),
    );

    await expect(svc.select('s1', 'broken')).rejects.toThrow(
      `Custom agent "broken" failed to load: ${brokenPath}: custom agent markdown frontmatter is malformed: description: Required Fix ${brokenPath}, then refresh agents.`,
    );
  });

  test('select still allows an SDK-loaded agent when a rejected duplicate file exists', async () => {
    await dropProjectAgent('reviewer');

    const loadedPath = join(workspaceDir, '.github', 'agents', 'reviewer.agent.md');
    const svc = new SessionAgentsService(
      makeCtx(workspaceDir, {
        agents: [
          {
            name: 'reviewer',
            displayName: 'Loaded Reviewer',
            description: 'Loaded from another scope',
            path: 'C:\\Users\\mahle\\.copilot\\agents\\reviewer.agent.md',
          },
        ],
        diagnostics: {
          errors: [
            `${loadedPath}: custom agent markdown frontmatter is malformed: description: Required`,
          ],
          warnings: [],
        },
      }),
    );

    await expect(svc.select('s1', 'reviewer')).resolves.toMatchObject({
      name: 'reviewer',
      displayName: 'Loaded Reviewer',
    });
  });
});
