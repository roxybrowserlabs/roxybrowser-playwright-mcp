import type { BrowserSnapshot, BrowserTab } from "./types.js";

export function formatTabs(tabs: BrowserTab[]): string {
  if (tabs.length === 0) {
    return "### Open tabs\n- (none)";
  }

  const lines = ["### Open tabs"];
  for (const [index, tab] of tabs.entries()) {
    lines.push(
      `- ${index}: ${tab.active ? "(current) " : ""}[${tab.title || "(untitled)"}](${tab.url || "about:blank"})`
    );
  }

  return lines.join("\n");
}

export function formatSnapshot(snapshot: BrowserSnapshot): string {
  const url = snapshot.url || "about:blank";
  const title = snapshot.title || "(untitled)";
  return [
    "### Page",
    `- Page URL: ${url}`,
    `- Page Title: ${title}`,
    ...(snapshot.console && (snapshot.console.errors || snapshot.console.warnings)
      ? [`- Console: ${snapshot.console.errors} errors, ${snapshot.console.warnings} warnings`]
      : []),
    "### Snapshot",
    "```yaml",
    snapshot.text,
    "```",
    ...(snapshot.consoleLink
      ? ["### Events", `- New console entries: ${snapshot.consoleLink}`]
      : [])
  ].join("\n");
}

export function formatConnectResult(input: {
  browserName: string;
  protocol: string;
  version: string;
  tabs: BrowserTab[];
  snapshot?: BrowserSnapshot;
}): string {
  const parts = [
    `Connected to ${input.browserName} via ${input.protocol}.`,
    `Version: ${input.version}`,
    formatTabs(input.tabs)
  ];

  if (input.snapshot) {
    parts.push(formatSnapshot(input.snapshot));
  }

  return parts.join("\n\n");
}

export function formatTabsWithOptionalSnapshot(tabs: BrowserTab[], snapshot?: BrowserSnapshot): string {
  const parts = [formatTabs(tabs)];
  if (snapshot) {
    parts.push(formatSnapshot(snapshot));
  }
  return parts.join("\n\n");
}
