export class McpToolError extends Error {
  constructor(
    readonly code:
      | "not_connected"
      | "no_active_tab"
      | "invalid_tab_index"
      | "stale_ref"
      | "unsupported_protocol_input",
    message: string
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export function isMcpToolError(error: unknown): error is McpToolError {
  return error instanceof McpToolError;
}
