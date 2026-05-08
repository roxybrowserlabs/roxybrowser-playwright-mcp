import { z } from 'zod';
import { defineExtraTool } from '../backend/helpers.js';
import { DynamicCdpContextFactory } from '../backend/DynamicCdpContextFactory.js';

export const BROWSER_CONNECT_ROXY = defineExtraTool(
  {
    name: 'browser_connect_roxy',
    title: 'Connect to RoxyBrowser',
    description:
      'Connect to RoxyBrowser using CDP WebSocket endpoint (e.g. from RoxyChrome).',
    inputSchema: z.object({
      cdpEndpoint: z
        .string()
        .describe(
          'CDP WebSocket URL from RoxyBrowser, e.g. ws://127.0.0.1:59305/devtools/browser/...'
        ),
    }),
    type: 'destructive',
  },
  async (context, args) => {
    const { cdpEndpoint } = args;
    await context.closeBrowserContext();
    const factory = new DynamicCdpContextFactory(context.config, cdpEndpoint);
    context._browserContextFactory = factory;
    await context.ensureTab();
    return {
      content: [
        {
          type: 'text',
          text: `### Result\nSuccessfully connected to RoxyBrowser at ${cdpEndpoint}\nSubsequent browser actions will run in this window.`,
        },
      ],
    };
  }
);
