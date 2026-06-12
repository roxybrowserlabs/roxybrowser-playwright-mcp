/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0.
 *
 * Snapshot-only excerpt copied from:
 * library/playwright/packages/injected/src/injectedScript.ts
 *
 * The full Playwright InjectedScript class includes selector engines, recorder
 * overlays, highlighting, WebAuthn, and other runtime features. MCP
 * browser_snapshot only enters the accessibility snapshot path below.
 */

import type { AriaTreeOptions } from './ariaSnapshot';
import { generateAriaTree, renderAriaTree } from './ariaSnapshot';
import { setGlobalOptions } from './domUtils';

type InjectedScriptOptions = {
  browserName?: string;
};

export class InjectedScript {
  private _lastAriaSnapshotForTrack = new Map<string, ReturnType<typeof generateAriaTree>>();

  _lastAriaSnapshotForQuery?: ReturnType<typeof generateAriaTree>;

  constructor(_globalScope?: Window & typeof globalThis, options: InjectedScriptOptions = {}) {
    setGlobalOptions({ browserNameForWorkarounds: options.browserName });
  }

  ariaSnapshot(node: Node, options: AriaTreeOptions): string {
    return this.incrementalAriaSnapshot(node, options).full;
  }

  incrementalAriaSnapshot(
    node: Node,
    options: AriaTreeOptions & { track?: string, depth?: number }
  ): { full: string; incremental?: string; iframeRefs: string[]; iframeDepths: Record<string, number> } {
    if (node.nodeType !== Node.ELEMENT_NODE)
      throw new Error('Can only capture aria snapshot of Element nodes.');
    const ariaSnapshot = generateAriaTree(node as Element, options);
    const rendered = renderAriaTree(ariaSnapshot, options);
    let incremental: string | undefined;
    if (options.track) {
      const previousSnapshot = this._lastAriaSnapshotForTrack.get(options.track);
      if (previousSnapshot)
        incremental = renderAriaTree(ariaSnapshot, options, previousSnapshot).text;
      this._lastAriaSnapshotForTrack.set(options.track, ariaSnapshot);
    }
    this._lastAriaSnapshotForQuery = ariaSnapshot;
    return {
      full: rendered.text,
      incremental,
      iframeRefs: ariaSnapshot.iframeRefs,
      iframeDepths: rendered.iframeDepths,
    };
  }
}

(globalThis as any).__roxyPlaywrightSnapshotBundle = { InjectedScript };
