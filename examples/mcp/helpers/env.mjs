export function requiredCdpEndpoint() {
  const endpoint = process.env.ROXY_CDP_ENDPOINT ?? process.env.ROXY_CDP_WS_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      "Set ROXY_CDP_ENDPOINT to a ws://.../devtools/browser/<id> endpoint, or run through `pnpm examples` so the runner can inject it."
    );
  }
  return endpoint;
}
