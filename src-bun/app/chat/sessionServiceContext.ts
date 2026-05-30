// Shared context port that lets sibling SDK-wrapper services
// (`SessionPlanService`, `SessionAgentsService`, etc.) talk to the
// `SessionRegistry` without touching its private `entries` Map.
//
// Per the 2026-05-26 audit's Phase D.3 plan: services receive a tiny
// context — `getEntry` for session lookup + `wrapSdk` for uniform
// SDK error handling — and must NOT mutate the registry's state.
// Lifecycle (create / resume / forward / disconnect) stays on the
// registry; everything else (agents, tasks, skills, mcp, plan)
// belongs to a sibling service.

import type { CopilotSession } from '../client/copilotSdk';
import { AppError } from '../shared/errors';
import { toErrorMessage } from '../shared/errorMessage';

/// Subset of the registry's `Entry` shape that services may read.
/// Intentionally narrower than the internal `Entry` interface so
/// services can't accidentally depend on lifecycle-only fields like
/// `unsubscribe`. The registry owns those.
export interface SessionEntryView {
  session: CopilotSession;
  workingDirectory?: string;
}

export interface AgentLoadDiagnostics {
  errors: string[];
  warnings: string[];
}

export interface SessionServiceContext {
  /// Resolve a sessionId to its entry; throws `AppError.sessionNotFound`
  /// when the session is not registered (the same behavior every
  /// registry method used to inline). Returning the entry rather
  /// than a Promise keeps service call sites trivial (`const entry
  /// = ctx.getEntry(sessionId)` followed by an `await ctx.wrapSdk
  /// (...)` for the SDK call).
  getEntry(sessionId: string): SessionEntryView;
  /// Latest `session.custom_agents_updated` diagnostics captured from
  /// the SDK event stream. Undefined means the session hasn't emitted
  /// an agent-load event yet.
  getAgentLoadDiagnostics?(sessionId: string): AgentLoadDiagnostics | undefined;
  /// Run an SDK-touching function and rewrap any rejection as
  /// `AppError.sdk(toErrorMessage(err))`. Mirrors what every registry
  /// method inlined before extraction. `AppError` rejections pass
  /// through unwrapped so downstream typed-error matching keeps
  /// working.
  wrapSdk<T>(fn: () => Promise<T>): Promise<T>;
}

/// Default `wrapSdk` shape. Exported so services / tests can build
/// their own context without re-importing the registry.
export async function wrapSdkError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw AppError.sdk(toErrorMessage(err));
  }
}
