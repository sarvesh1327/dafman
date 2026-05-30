// Adapter for the GitHub Copilot JSON-RPC SDK.
//
// Migration history:
// 1. Started on `copilot-sdk-supercharged` (3rd-party wrapper) — replaced
//    because it lagged the bundled SDK and lacked mode-lifecycle callbacks.
// 2. Switched to deep imports inside `@github/copilot/copilot-sdk/`. Worked
//    but reached through `node_modules/` (AGENTS.md rule 17).
// 3. (current) Use `@github/copilot-sdk@1.0.0-beta.7` — the standalone
//    GitHub-published SDK package. Type/runtime surface matches the
//    bundled SDK at beta.7 (earlier beta.4 was behind on
//    SessionContext.workingDirectory / getEvents — verify any future
//    pin against `node_modules/@github/copilot-sdk/dist/*.d.ts` before
//    downgrading).
//
// Notes for any future re-evaluation:
// - `UserInputRequest`/`Response` are exported from `dist/types.js` but
//   not from `dist/index.js` (consistent with the bundled SDK), so pull
//   them from the sub-path.
// - `SYSTEM_PROMPT_SECTIONS` was renamed to `SYSTEM_MESSAGE_SECTIONS` in
//   beta.7. We don't currently consume it; if we add a system-prompt
//   customization callsite, use the new name.
//
// Keep all SDK imports behind this module so any future export-path or
// package change is localized here.

export {
  CopilotClient,
  RuntimeConnection,
  approveAll,
  convertMcpCallToolResult,
  createSessionFsAdapter,
  defineTool,
} from '@github/copilot-sdk';

export type {
  AutoModeSwitchHandler,
  AutoModeSwitchRequest,
  AutoModeSwitchResponse,
  CommandContext,
  CommandDefinition,
  CommandHandler,
  CopilotClientOptions,
  CustomAgentConfig,
  ElicitationContext,
  ElicitationHandler,
  ElicitationResult,
  ExitPlanModeHandler,
  ExitPlanModeRequest,
  ExitPlanModeResult,
  ForegroundSessionInfo,
  MessageOptions,
  ModelInfo,
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
  SessionEventPayload,
  SessionMetadata,
  SessionUiApi,
  Tool,
  ToolInvocation,
  ToolResultObject,
} from '@github/copilot-sdk';

export { CopilotSession } from '@github/copilot-sdk';

/// UserInputRequest/Response live in `dist/types.js` but the package's
/// `exports` map only allows `.` and `./extension` (no sub-path
/// access). Derive them from `SessionConfig.onUserInputRequest` —
/// which IS exported — so we don't need to reach past the entry.
import type { SessionConfig } from '@github/copilot-sdk';

export type UserInputRequest = Parameters<NonNullable<SessionConfig['onUserInputRequest']>>[0];

export type UserInputResponse = Awaited<
  ReturnType<NonNullable<SessionConfig['onUserInputRequest']>>
>;

/// `ReasoningEffort` is also unexported from the SDK's index but it's
/// just the `SessionConfig['reasoningEffort']` literal union. Derive
/// it the same way so sessions.ts doesn't need to hand-mirror the
/// SDK's `"low" | "medium" | "high" | "xhigh"` (which would silently
/// drift if the SDK adds a level).
export type ReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;

/// `PreMcpToolCallHookInput` is not exported from the SDK index
/// (added in beta.8) — derive it from `SessionConfig['hooks']`. The
/// MCP hook lives on the SDK's `SessionHooks` surface (under
/// `config.hooks`), NOT at the top level like `onUserInputRequest`.
/// The hook fires before every MCP tool invocation; its output can
/// only rewrite `_meta` (it can't block or modify args).
export type PreMcpToolCallInput = Parameters<
  NonNullable<NonNullable<SessionConfig['hooks']>['onPreMcpToolCall']>
>[0];

/// `PostToolUseFailureHookInput` (added in beta.9) is not exported from
/// the SDK index — derive it from `SessionConfig['hooks']`. Like every
/// tool/session-lifecycle hook it lives on the SDK's `SessionHooks`
/// surface (under `config.hooks`), NOT at the top level. The host CLI
/// fires it after a tool execution whose `resultType` is `"failure"`
/// (NOT for `rejected`/`denied`/`timeout`), passing only the
/// stringified `error` message — not the full `ToolResultObject`.
/// See `node_modules/@github/copilot-sdk/dist/types.d.ts:887`
/// (`PostToolUseFailureHookInput`) and `:1031` (`onPostToolUseFailure`).
export type PostToolUseFailureInput = Parameters<
  NonNullable<NonNullable<SessionConfig['hooks']>['onPostToolUseFailure']>
>[0];
