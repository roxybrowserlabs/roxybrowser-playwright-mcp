import { describe, expect, it } from "vitest";

const core = await import("../../scripts/examples-runner-core.mjs");

describe("examples runner core", () => {
  it("resolves a module/script pair to an examples script", () => {
    const target = core.resolveExampleTarget(
      ["mcp", "launch-stdio", "--", "--verbose"],
      {
        rootDir: "/repo",
        existsSync: (path: string) => path === "/repo/examples/mcp/launch-stdio.mjs"
      }
    );

    expect(target).toEqual({
      moduleName: "mcp",
      scriptName: "launch-stdio.mjs",
      examplePath: "examples/mcp/launch-stdio.mjs",
      scriptPath: "/repo/examples/mcp/launch-stdio.mjs",
      scriptArgs: ["--verbose"]
    });
  });

  it("resolves nested repro scripts", () => {
    const target = core.resolveExampleTarget(
      ["repro", "bidi", "01-click-alert-blocks"],
      {
        rootDir: "/repo",
        existsSync: (path: string) =>
          path === "/repo/examples/repro/bidi/01-click-alert-blocks.mjs"
      }
    );

    expect(target.scriptPath).toBe("/repo/examples/repro/bidi/01-click-alert-blocks.mjs");
  });

  it("detects required endpoint variables from script source", () => {
    expect(
      core.detectRequiredEndpoint("/repo/examples/mcp/verify.mjs", {
        readFileSync: () => "import { requiredCdpEndpoint } from './helpers/env.mjs';"
      })
    ).toBe("cdp");
    expect(
      core.detectRequiredEndpoint("/repo/examples/page/connect-bidi.mjs", {
        readFileSync: () => "process.env.ROXY_BIDI_ENDPOINT"
      })
    ).toBe("bidi");
  });

  it("detects BiDi repro scripts from their directory", () => {
    expect(
      core.detectRequiredEndpoint("/repo/examples/repro/bidi/01-click-alert-blocks.mjs", {
        readFileSync: () => ""
      })
    ).toBe("bidi");
  });

  it("injects canonical endpoint names and legacy aliases together", () => {
    const env = core.buildExampleEnv(
      { ROXY_CDP_WS_ENDPOINT: "ws://legacy-cdp" },
      { bidi: "ws://bidi", bidiSessionId: "session-1" }
    );

    expect(env.ROXY_CDP_ENDPOINT).toBe("ws://legacy-cdp");
    expect(env.ROXY_CDP_WS_ENDPOINT).toBe("ws://legacy-cdp");
    expect(env.ROXY_BIDI_ENDPOINT).toBe("ws://bidi");
    expect(env.ROXY_BIDI_WS_ENDPOINT).toBe("ws://bidi");
    expect(env.ROXY_BIDI_SESSION_ID).toBe("session-1");
  });
});
