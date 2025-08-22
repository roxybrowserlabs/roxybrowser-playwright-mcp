/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { z } from 'zod';
import { defineTool } from './tool.js';

const roxyConnect = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_connect_roxy',
    title: 'Connect to RoxyBrowser',
    description: 'Connect to RoxyBrowser using CDP WebSocket endpoint',
    inputSchema: z.object({
      cdpEndpoint: z.string().describe('The CDP WebSocket endpoint URL from RoxyBrowser (e.g., ws://127.0.0.1:59305/devtools/browser/4d876b0b-6adc-4e9f-b572-bb68ff02a199)'),
    }),
    type: 'destructive',
  },

  handle: async (context, params, response) => {
    try {
      // Validate CDP endpoint format
      if (!params.cdpEndpoint.startsWith('ws://') && !params.cdpEndpoint.startsWith('wss://'))
        throw new Error(`Invalid CDP endpoint format. Expected WebSocket URL starting with ws:// or wss://, got: ${params.cdpEndpoint}`);


      // Use the reconnectToCDP method to connect to RoxyBrowser
      await context.reconnectToCDP(params.cdpEndpoint);

      // Verify connection by ensuring we have tabs or can create one
      await context.ensureTab();

      response.addResult(`Successfully connected to RoxyBrowser at ${params.cdpEndpoint}`);
      response.addCode(`// Connected to RoxyBrowser CDP endpoint: ${params.cdpEndpoint}`);

      // Take a snapshot to show current state
      response.setIncludeSnapshot();
    } catch (error: any) {
      response.addError(`Failed to connect to RoxyBrowser: ${error.message}`);
    }
  },
});

export default [
  roxyConnect,
];
