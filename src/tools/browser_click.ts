import { z } from 'zod';
import { defineExtraTool } from '../backend/helpers.js';
import { humanClick } from '../human/index.js';
import { isBrowserSessionReadyForTools, notConnectedToolResult } from '../backend/utils.js';

// 与官方一致的 elementSchema
const elementSchema = z.object({
  element: z.string().optional().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().describe('Exact target element reference from the page snapshot')
});

export const BROWSER_CLICK = defineExtraTool(
  {
    name: 'browser_click',
    title: 'Click',
    description: 'Perform human-like click on a web page with natural mouse movement',
    inputSchema: elementSchema.extend({
      doubleClick: z.boolean().optional().describe('Whether to perform a double click instead of a single click'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Button to click, defaults to left'),
      modifiers: z.array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'])).optional().describe('Modifier keys to press')
    }),
    type: 'input',
  },
  async (context, args) => {
    if (!isBrowserSessionReadyForTools(context)) {
      return notConnectedToolResult('browser_click');
    }

    const tab = await context.ensureTab();
    const { locator } = await tab.refLocator(args);

    await tab.waitForCompletion(async () => {
      await humanClick(tab, locator, args);
    });

    return {
      content: [
        {
          type: 'text',
          text: 'Clicked with human-like mouse movement',
        },
      ],
    };
  }
);
