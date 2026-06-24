import { z } from 'zod';
import { defineExtraTool } from '../backend/helpers.js';
import { DynamicCdpContextFactory } from '../backend/DynamicCdpContextFactory.js';

export const BROWSER_CONNECT_ROXY = defineExtraTool(
  {
    name: 'browser_connect_roxy',
    title: 'Connect to RoxyBrowser',
    description:
      'Connect to a remote browser using a WebSocket endpoint. Supports Chrome (via CDP) and Firefox (via BiDi).',
    inputSchema: z.object({
      endpoint: z
        .string()
        .describe(
          'WebSocket URL to connect to. For Chrome, use a CDP endpoint like ws://127.0.0.1:PORT/devtools/browser/.... For Firefox, use a BiDi WebSocket endpoint.'
        ),
      browserCore: z
        .enum(['Chrome', 'Firefox'])
        .optional()
        .default('Chrome')
        .describe('Browser engine to connect to. Defaults to "Chrome".'),
    }),
    type: 'destructive',
  },
  async (context, args) => {
    const { endpoint, browserCore } = args;
    await context.closeBrowserContext();
    const factory = new DynamicCdpContextFactory(context.config, endpoint, browserCore);
    context._browserContextFactory = factory;
    await context.ensureTab();
    return {
      content: [
        {
          type: 'text',
          text: `### Result\nSuccessfully connected to ${browserCore} at ${endpoint}\nSubsequent browser actions will run in this window.`,
        },
      ],
    };
  }
);
