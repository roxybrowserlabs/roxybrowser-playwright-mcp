export class McpToolError extends Error {
  constructor(
    readonly code:
      | "not_connected"
      | "no_active_tab"
      | "invalid_tab_index"
      | "invalid_input"
      | "invalid_target"
      | "stale_ref"
      | "no_dialog"
      | "unsupported_protocol_input"
      | "not_supported"
      | "action_failed"
      | "timeout",
    message: string
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export function isMcpToolError(error: unknown): error is McpToolError {
  return error instanceof McpToolError;
}
