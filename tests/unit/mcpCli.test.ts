import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCliOptions, sharedOptions } from "../../src/bin/roxybrowser-mcp.js";

describe("roxybrowser-mcp CLI", () => {
  it("parses Playwright MCP server host and port environment variables", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_HOST: "0.0.0.0",
      PLAYWRIGHT_MCP_PORT: "4444"
    });

    expect(options.host).toBe("0.0.0.0");
    expect(options.port).toBe(4444);
  });

  it("lets Playwright MCP server CLI options override environment variables", () => {
    const options = parseCliOptions(["--host", "127.0.0.1", "--port", "3333"], {
      PLAYWRIGHT_MCP_HOST: "0.0.0.0",
      PLAYWRIGHT_MCP_PORT: "4444"
    });

    expect(options.host).toBe("127.0.0.1");
    expect(options.port).toBe(3333);
  });

  it("maps Playwright MCP --output-dir to the server artifacts directory", () => {
    const options = parseCliOptions(["--output-dir", "playwright-output"]);

    expect(options.artifactsDir).toBe("playwright-output");
    expect(sharedOptions(options)).toMatchObject({
      artifactsDir: "playwright-output"
    });
  });

  it("maps Playwright MCP output directory environment variable to artifactsDir", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_OUTPUT_DIR: "env-output"
    });

    expect(options.artifactsDir).toBe("env-output");
    expect(sharedOptions(options)).toMatchObject({
      artifactsDir: "env-output"
    });
  });

  it("lets explicit artifacts-dir override Playwright MCP output directory environment variable", () => {
    const options = parseCliOptions(["--artifacts-dir", "explicit-artifacts"], {
      PLAYWRIGHT_MCP_OUTPUT_DIR: "env-output"
    });

    expect(options.artifactsDir).toBe("explicit-artifacts");
  });

  it("parses Playwright MCP init page and init script CLI options", () => {
    const options = parseCliOptions([
      "--init-page",
      "hooks/page-one.ts",
      "--init-page",
      "hooks/page-two.ts",
      "--init-script",
      "hooks/script-one.js",
      "--init-script",
      "hooks/script-two.js"
    ]);

    expect(options.initPage).toEqual(["hooks/page-one.ts", "hooks/page-two.ts"]);
    expect(options.initScript).toEqual(["hooks/script-one.js", "hooks/script-two.js"]);
    expect(sharedOptions(options)).toMatchObject({
      initPage: ["hooks/page-one.ts", "hooks/page-two.ts"],
      initScript: ["hooks/script-one.js", "hooks/script-two.js"]
    });
  });

  it("parses Playwright MCP init page and init script environment variables", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_INIT_PAGE: "hooks/page.ts",
      PLAYWRIGHT_MCP_INIT_SCRIPT: "hooks/script.js"
    });

    expect(options.initPage).toEqual(["hooks/page.ts"]);
    expect(options.initScript).toEqual(["hooks/script.js"]);
  });

  it("parses Playwright MCP --secrets dotenv file into server secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-cli-secrets-"));
    const secretsFile = join(dir, "secrets.env");
    await writeFile(secretsFile, "X-PASSWORD=password123\nEMPTY_SECRET=\n");

    const options = parseCliOptions(["--secrets", secretsFile]);

    expect(options.secrets).toEqual({
      "X-PASSWORD": "password123",
      EMPTY_SECRET: ""
    });
    expect(sharedOptions(options)).toMatchObject({
      secrets: {
        "X-PASSWORD": "password123",
        EMPTY_SECRET: ""
      }
    });
  });

  it("parses Playwright MCP secrets environment variable into server secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-env-secrets-"));
    const secretsFile = join(dir, "secrets.env");
    await writeFile(secretsFile, "API_TOKEN=secret-token");

    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_SECRETS_FILE: secretsFile
    });

    expect(options.secrets).toEqual({
      API_TOKEN: "secret-token"
    });
    expect(sharedOptions(options)).toMatchObject({
      secrets: {
        API_TOKEN: "secret-token"
      }
    });
  });

  it("parses Playwright MCP --image-responses=omit into server image response mode", () => {
    const options = parseCliOptions(["--image-responses", "omit"]);

    expect(options.imageResponses).toBe("omit");
    expect(sharedOptions(options)).toMatchObject({
      imageResponses: "omit"
    });
  });

  it("maps Playwright MCP --image-responses=allow to included image responses", () => {
    const options = parseCliOptions(["--image-responses", "allow"]);

    expect(options.imageResponses).toBe("include");
    expect(sharedOptions(options)).toMatchObject({
      imageResponses: "include"
    });
  });

  it("rejects invalid Playwright MCP image response modes", () => {
    expect(() => parseCliOptions(["--image-responses", "hide"])).toThrow(
      'Unsupported image-responses "hide". Expected "allow" or "omit".'
    );
  });

  it("parses Playwright MCP image response environment variable", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_IMAGE_RESPONSES: "omit"
    });

    expect(options.imageResponses).toBe("omit");
    expect(sharedOptions(options)).toMatchObject({
      imageResponses: "omit"
    });
  });

  it("lets Playwright MCP image response CLI option override environment variables", () => {
    const options = parseCliOptions(["--image-responses", "allow"], {
      PLAYWRIGHT_MCP_IMAGE_RESPONSES: "omit"
    });

    expect(options.imageResponses).toBe("include");
  });

  it("parses Playwright MCP console level into server console options", () => {
    const options = parseCliOptions(["--console-level", "error"]);

    expect(options.consoleLevel).toBe("error");
    expect(sharedOptions(options)).toMatchObject({
      consoleLevel: "error"
    });
  });

  it("rejects invalid Playwright MCP console levels", () => {
    expect(() => parseCliOptions(["--console-level", "verbose"])).toThrow(
      'Unsupported console-level "verbose". Expected "error", "warning", "info", or "debug".'
    );
  });

  it("parses Playwright MCP console level environment variable", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_CONSOLE_LEVEL: "warning"
    });

    expect(options.consoleLevel).toBe("warning");
    expect(sharedOptions(options)).toMatchObject({
      consoleLevel: "warning"
    });
  });

  it("lets Playwright MCP console level CLI option override environment variables", () => {
    const options = parseCliOptions(["--console-level", "debug"], {
      PLAYWRIGHT_MCP_CONSOLE_LEVEL: "error"
    });

    expect(options.consoleLevel).toBe("debug");
  });

  it("parses Playwright MCP --codegen=none", () => {
    const options = parseCliOptions(["--codegen", "none"]);

    expect(options.codegen).toBe("none");
    expect(sharedOptions(options)).toMatchObject({
      codegen: "none"
    });
  });

  it("parses Playwright MCP codegen environment variable", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_CODEGEN: "none"
    });

    expect(options.codegen).toBe("none");
  });

  it("rejects invalid Playwright MCP codegen values", () => {
    expect(() => parseCliOptions(["--codegen", "python"])).toThrow(
      'Unsupported codegen "python". Expected "none" or "typescript".'
    );
  });

  it("parses Playwright MCP --caps into server capabilities", () => {
    const options = parseCliOptions([
      "--caps",
      "testing, storage, network",
      "--snapshot-mode",
      "none"
    ]);

    expect(options.capabilities).toEqual(["testing", "storage", "network"]);
    expect(sharedOptions(options)).toMatchObject({
      capabilities: ["testing", "storage", "network"],
      snapshotMode: "none"
    });
  });

  it("maps Playwright MCP legacy tracing capability to devtools", () => {
    const options = parseCliOptions(["--caps", "tracing"]);

    expect(options.capabilities).toEqual(["devtools"]);
    expect(sharedOptions(options)).toMatchObject({
      capabilities: ["devtools"]
    });
  });

  it("deduplicates Playwright MCP tracing and devtools capabilities", () => {
    const options = parseCliOptions(["--caps", "tracing,devtools,pdf"]);

    expect(options.capabilities).toEqual(["devtools", "pdf"]);
  });

  it("rejects unsupported Playwright MCP capabilities", () => {
    expect(() => parseCliOptions(["--caps", "component-testing"])).toThrow(
      'Unsupported capability "component-testing".'
    );
  });

  it("parses Playwright MCP capability environment variables", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_CAPS: "testing, storage"
    });

    expect(options.capabilities).toEqual(["testing", "storage"]);
    expect(sharedOptions(options)).toMatchObject({
      capabilities: ["testing", "storage"]
    });
  });

  it("maps Playwright MCP tracing capability environment variable to devtools", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_CAPS: "tracing"
    });

    expect(options.capabilities).toEqual(["devtools"]);
  });

  it("lets Playwright MCP capability CLI options override environment variables", () => {
    const options = parseCliOptions(["--caps", "vision"], {
      PLAYWRIGHT_MCP_CAPS: "testing"
    });

    expect(options.capabilities).toEqual(["vision"]);
  });

  it("parses Playwright MCP request origin allowlist and blocklist", () => {
    const options = parseCliOptions([
      "--allowed-origins",
      "microsoft.com;https://example.com;http://localhost:*",
      "--blocked-origins",
      "https://blocked.example;playwright.dev"
    ]);

    expect(options.network).toEqual({
      allowedOrigins: ["microsoft.com", "https://example.com", "http://localhost:*"],
      blockedOrigins: ["https://blocked.example", "playwright.dev"]
    });
    expect(sharedOptions(options)).toMatchObject({
      network: {
        allowedOrigins: ["microsoft.com", "https://example.com", "http://localhost:*"],
        blockedOrigins: ["https://blocked.example", "playwright.dev"]
      }
    });
  });

  it("parses Playwright MCP request origin allowlist and blocklist environment variables", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_ALLOWED_ORIGINS: "https://allow.example;localhost:3000",
      PLAYWRIGHT_MCP_BLOCKED_ORIGINS: "https://blocked.example;example.com"
    });

    expect(options.network).toEqual({
      allowedOrigins: ["https://allow.example", "localhost:3000"],
      blockedOrigins: ["https://blocked.example", "example.com"]
    });
  });

  it("lets Playwright MCP request origin CLI options override environment variables", () => {
    const options = parseCliOptions([
      "--allowed-origins",
      "https://cli-allow.example",
      "--blocked-origins",
      "https://cli-block.example"
    ], {
      PLAYWRIGHT_MCP_ALLOWED_ORIGINS: "https://env-allow.example",
      PLAYWRIGHT_MCP_BLOCKED_ORIGINS: "https://env-block.example"
    });

    expect(options.network).toEqual({
      allowedOrigins: ["https://cli-allow.example"],
      blockedOrigins: ["https://cli-block.example"]
    });
  });

  it("parses Playwright MCP allowed hosts", () => {
    const options = parseCliOptions([
      "--allowed-hosts",
      "localhost:3333,127.0.0.1:3333"
    ]);

    expect(options.allowedHosts).toEqual(["localhost:3333", "127.0.0.1:3333"]);
  });

  it("parses Playwright MCP allowed hosts environment variable", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_ALLOWED_HOSTS: "localhost:3333,127.0.0.1:3333"
    });

    expect(options.allowedHosts).toEqual(["localhost:3333", "127.0.0.1:3333"]);
  });

  it("lets Playwright MCP allowed hosts CLI option override environment variable", () => {
    const options = parseCliOptions(["--allowed-hosts", "*"], {
      PLAYWRIGHT_MCP_ALLOWED_HOSTS: "localhost:3333"
    });

    expect(options.allowedHosts).toEqual(["*"]);
  });

  it("supports Playwright MCP legacy --vision option", () => {
    const options = parseCliOptions(["--vision"]);

    expect(options.capabilities).toEqual(["vision"]);
    expect(sharedOptions(options)).toMatchObject({
      capabilities: ["vision"]
    });
  });

  it("combines Playwright MCP legacy --vision option with --caps", () => {
    const options = parseCliOptions(["--vision", "--caps", "pdf"]);

    expect(options.capabilities).toEqual(["pdf", "vision"]);
    expect(sharedOptions(options)).toMatchObject({
      capabilities: ["pdf", "vision"]
    });
  });

  it("parses Playwright MCP timeout options into server timeouts", () => {
    const options = parseCliOptions([
      "--timeout-action",
      "5000",
      "--timeout-navigation",
      "60000",
      "--timeout-settle",
      "750"
    ]);

    expect(options.timeouts).toEqual({
      action: 5000,
      navigation: 60000,
      settle: 750
    });
    expect(sharedOptions(options)).toMatchObject({
      timeouts: {
        action: 5000,
        navigation: 60000,
        settle: 750
      }
    });
  });

  it("rejects invalid Playwright MCP timeout values", () => {
    expect(() => parseCliOptions(["--timeout-action", "slow"])).toThrow(
      'Invalid timeout-action "slow". Expected an integer.'
    );
  });

  it("parses Playwright MCP timeout environment variables into server timeouts", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_TIMEOUT_ACTION: "9000",
      PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION: "45000",
      PLAYWRIGHT_MCP_TIMEOUT_SETTLE: "250"
    });

    expect(options.timeouts).toEqual({
      action: 9000,
      navigation: 45000,
      settle: 250
    });
    expect(sharedOptions(options)).toMatchObject({
      timeouts: {
        action: 9000,
        navigation: 45000,
        settle: 250
      }
    });
  });

  it("lets Playwright MCP timeout CLI options override environment variables", () => {
    const options = parseCliOptions(["--timeout-action", "3000"], {
      PLAYWRIGHT_MCP_TIMEOUT_ACTION: "9000"
    });

    expect(options.timeouts).toEqual({
      action: 3000
    });
  });

  it("parses Playwright MCP viewport size into server viewport options", () => {
    const options = parseCliOptions(["--viewport-size", "800x600"]);

    expect(options.viewport).toEqual({ width: 800, height: 600 });
    expect(sharedOptions(options)).toMatchObject({
      viewport: { width: 800, height: 600 }
    });
  });

  it("rejects invalid Playwright MCP viewport sizes", () => {
    expect(() => parseCliOptions(["--viewport-size", "wide"])).toThrow(
      'Invalid viewport-size "wide". Expected "<width>x<height>".'
    );
  });

  it("parses Playwright MCP viewport size environment variable", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_VIEWPORT_SIZE: "800x600"
    });

    expect(options.viewport).toEqual({ width: 800, height: 600 });
    expect(sharedOptions(options)).toMatchObject({
      viewport: { width: 800, height: 600 }
    });
  });

  it("lets Playwright MCP viewport size CLI option override environment variable", () => {
    const options = parseCliOptions(["--viewport-size", "1024x768"], {
      PLAYWRIGHT_MCP_VIEWPORT_SIZE: "800x600"
    });

    expect(options.viewport).toEqual({ width: 1024, height: 768 });
  });

  it("parses Playwright MCP output max size into server options", () => {
    const options = parseCliOptions(["--output-max-size", "1024"]);

    expect(options.outputMaxSize).toBe(1024);
    expect(sharedOptions(options)).toMatchObject({
      outputMaxSize: 1024
    });
  });

  it("parses Playwright MCP output max size environment variable", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_OUTPUT_MAX_SIZE: "2048"
    });

    expect(options.outputMaxSize).toBe(2048);
  });

  it("rejects invalid Playwright MCP output max size values", () => {
    expect(() => parseCliOptions(["--output-max-size", "1.5"])).toThrow(
      'Invalid output-max-size "1.5". Expected an integer.'
    );
  });

  it("parses Playwright MCP test id attribute into server options", () => {
    const options = parseCliOptions(["--test-id-attribute", "data-pw"]);

    expect(options.testIdAttribute).toBe("data-pw");
    expect(sharedOptions(options)).toMatchObject({
      testIdAttribute: "data-pw"
    });
  });

  it("parses Playwright MCP test id attribute environment variable", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_TEST_ID_ATTRIBUTE: "data-e2e"
    });

    expect(options.testIdAttribute).toBe("data-e2e");
  });

  it("maps Playwright MCP --block-service-workers to context options", () => {
    const options = parseCliOptions(["--block-service-workers"]);

    expect(options.contextOptions).toEqual({
      serviceWorkers: "block"
    });
    expect(sharedOptions(options).contextOptions).toEqual({
      serviceWorkers: "block"
    });
  });

  it("maps Playwright MCP block service workers environment variable to context options", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS: "1"
    });

    expect(options.contextOptions).toEqual({
      serviceWorkers: "block"
    });
    expect(sharedOptions(options).contextOptions).toEqual({
      serviceWorkers: "block"
    });
  });

  it("treats false Playwright MCP block service workers environment variable as disabled", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS: "false"
    });

    expect(options.contextOptions).toBeUndefined();
  });

  it("maps Playwright MCP --ignore-https-errors to context options", () => {
    const options = parseCliOptions(["--ignore-https-errors"]);

    expect(options.contextOptions).toEqual({
      ignoreHTTPSErrors: true
    });
    expect(sharedOptions(options).contextOptions).toEqual({
      ignoreHTTPSErrors: true
    });
  });

  it("maps Playwright MCP ignore https errors environment variable to context options", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS: "true"
    });

    expect(options.contextOptions).toEqual({
      ignoreHTTPSErrors: true
    });
  });

  it("treats false Playwright MCP ignore https errors environment variable as disabled", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS: "0"
    });

    expect(options.contextOptions).toBeUndefined();
  });

  it("maps Playwright MCP --grant-permissions to context options", () => {
    const options = parseCliOptions([
      "--grant-permissions",
      "geolocation,clipboard-read, clipboard-write"
    ]);

    expect(options.contextOptions).toEqual({
      permissions: ["geolocation", "clipboard-read", "clipboard-write"]
    });
    expect(sharedOptions(options).contextOptions).toEqual({
      permissions: ["geolocation", "clipboard-read", "clipboard-write"]
    });
  });

  it("maps Playwright MCP grant permissions environment variable to context options", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_GRANT_PERMISSIONS: "geolocation,clipboard-read"
    });

    expect(options.contextOptions).toEqual({
      permissions: ["geolocation", "clipboard-read"]
    });
  });

  it("lets Playwright MCP grant permissions CLI option override environment variable", () => {
    const options = parseCliOptions(["--grant-permissions", "clipboard-write"], {
      PLAYWRIGHT_MCP_GRANT_PERMISSIONS: "geolocation"
    });

    expect(options.contextOptions).toEqual({
      permissions: ["clipboard-write"]
    });
  });

  it("resolves Playwright MCP --mobile to the Chromium mobile device descriptor", () => {
    const options = parseCliOptions(["--mobile"]);

    expect(options.contextOptions).toMatchObject({
      viewport: { width: 360, height: 732 },
      screen: { width: 360, height: 808 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    });
    expect(options.contextOptions?.userAgent).toContain("Pixel 10");
    expect(sharedOptions(options).contextOptions).toMatchObject({
      viewport: { width: 360, height: 732 },
      isMobile: true,
      hasTouch: true
    });
  });

  it("resolves Playwright MCP --device to the named device descriptor", () => {
    const options = parseCliOptions(["--device", "iPhone 15"]);

    expect(options.contextOptions).toMatchObject({
      viewport: { width: 393, height: 659 },
      screen: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    });
    expect(options.contextOptions?.userAgent).toContain("iPhone");
  });

  it("resolves Playwright MCP mobile environment variable to the Chromium mobile device descriptor", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_MOBILE: "1"
    });

    expect(options.contextOptions).toMatchObject({
      viewport: { width: 360, height: 732 },
      isMobile: true,
      hasTouch: true
    });
    expect(options.contextOptions?.userAgent).toContain("Pixel 10");
  });

  it("treats false Playwright MCP mobile environment variable as disabled", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_MOBILE: "false"
    });

    expect(options.contextOptions).toBeUndefined();
  });

  it("resolves Playwright MCP device environment variable to the named device descriptor", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_DEVICE: "iPhone 15"
    });

    expect(options.contextOptions).toMatchObject({
      viewport: { width: 393, height: 659 },
      isMobile: true,
      hasTouch: true
    });
    expect(options.contextOptions?.userAgent).toContain("iPhone");
  });

  it("lets Playwright MCP device CLI option override mobile environment variable", () => {
    const options = parseCliOptions(["--device", "iPhone 15"], {
      PLAYWRIGHT_MCP_MOBILE: "1"
    });

    expect(options.contextOptions).toMatchObject({
      viewport: { width: 393, height: 659 },
      isMobile: true,
      hasTouch: true
    });
    expect(options.contextOptions?.userAgent).toContain("iPhone");
  });

  it("lets explicit Playwright MCP viewport size override --mobile viewport", () => {
    const options = parseCliOptions(["--mobile", "--viewport-size", "800x600"]);

    expect(options.contextOptions).toMatchObject({
      isMobile: true,
      viewport: { width: 800, height: 600 }
    });
  });

  it("maps Playwright MCP --user-agent to context options", () => {
    const options = parseCliOptions(["--user-agent", "TestAgent/1.0"]);

    expect(options.contextOptions).toEqual({
      userAgent: "TestAgent/1.0"
    });
    expect(sharedOptions(options).contextOptions).toEqual({
      userAgent: "TestAgent/1.0"
    });
  });

  it("maps Playwright MCP user agent environment variable to context options", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_USER_AGENT: "EnvAgent/1.0"
    });

    expect(options.contextOptions).toEqual({
      userAgent: "EnvAgent/1.0"
    });
  });

  it("lets Playwright MCP user agent CLI option override environment variable", () => {
    const options = parseCliOptions(["--user-agent", "CliAgent/1.0"], {
      PLAYWRIGHT_MCP_USER_AGENT: "EnvAgent/1.0"
    });

    expect(options.contextOptions).toEqual({
      userAgent: "CliAgent/1.0"
    });
  });

  it("lets explicit Playwright MCP user agent override device descriptors", () => {
    const options = parseCliOptions(["--mobile", "--user-agent", "DesktopAgent/1.0"]);

    expect(options.contextOptions).toMatchObject({
      isMobile: true,
      userAgent: "DesktopAgent/1.0"
    });
  });

  it("maps Playwright MCP --storage-state to context options", () => {
    const options = parseCliOptions(["--storage-state", "state.json"]);

    expect(options.contextOptions).toEqual({
      storageState: "state.json"
    });
    expect(sharedOptions(options).contextOptions).toEqual({
      storageState: "state.json"
    });
  });

  it("maps Playwright MCP storage state environment variable to context options", () => {
    const options = parseCliOptions([], {
      PLAYWRIGHT_MCP_STORAGE_STATE: "env-state.json"
    });

    expect(options.contextOptions).toEqual({
      storageState: "env-state.json"
    });
  });

  it("lets Playwright MCP storage state CLI option override environment variable", () => {
    const options = parseCliOptions(["--storage-state", "cli-state.json"], {
      PLAYWRIGHT_MCP_STORAGE_STATE: "env-state.json"
    });

    expect(options.contextOptions).toEqual({
      storageState: "cli-state.json"
    });
  });

  it("rejects combining Playwright MCP --mobile with --device", () => {
    expect(() => parseCliOptions(["--mobile", "--device", "iPhone 15"])).toThrow(
      "Cannot use --mobile together with --device, pick one."
    );
  });
});
