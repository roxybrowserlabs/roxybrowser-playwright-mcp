# RoxyBrowser Integration Guide

This guide shows how to use Playwright MCP with RoxyBrowser for dynamic browser automation.

## Overview

The implementation adds dynamic CDP (Chrome DevTools Protocol) connection capability to Playwright MCP, allowing it to connect to RoxyBrowser instances at runtime without requiring static configuration.

## Key Features

- **Dynamic Connection**: Connect to different RoxyBrowser instances without restarting MCP
- **Runtime Switching**: Switch between different browser instances using WebSocket endpoints
- **Minimal Modification**: Uses existing MCP architecture with minimal changes

## Setup

### 1. Start RoxyBrowser
1. Open RoxyBrowser application
2. Enable API mode in settings
3. Note the API endpoint (default: http://127.0.0.1:50000)

### 2. Start Playwright MCP in RoxyBrowser Mode
```bash
node cli.js --roxy-mode
```

### 3. Get CDP WebSocket Endpoint from RoxyBrowser
RoxyBrowser will provide a WebSocket endpoint like:
```
ws://127.0.0.1:59305/devtools/browser/4d876b0b-6adc-4e9f-b572-bb68ff02a199
```

## Usage

### Connect to RoxyBrowser
Use the `browser_connect_roxy` tool to connect to a RoxyBrowser instance:

```json
{
  "name": "browser_connect_roxy",
  "arguments": {
    "cdpEndpoint": "ws://127.0.0.1:59305/devtools/browser/4d876b0b-6adc-4e9f-b572-bb68ff02a199"
  }
}
```

### Switch Between Browsers
To connect to a different RoxyBrowser instance, simply call `browser_connect_roxy` with a new endpoint:

```json
{
  "name": "browser_connect_roxy", 
  "arguments": {
    "cdpEndpoint": "ws://127.0.0.1:52314/devtools/browser/857b2d0d-aae6-4852-ab3c-0784f0b2c1fb"
  }
}
```

### Normal Automation
After connecting, use standard Playwright MCP tools:
- `browser_navigate` - Navigate to URLs
- `browser_click` - Click elements
- `browser_screenshot` - Take screenshots
- And all other available tools

## Implementation Details

### Architecture Changes
1. **DynamicCdpContextFactory**: New factory class supporting runtime endpoint changes
2. **Context.reconnectToCDP()**: Method to dynamically switch CDP connections
3. **browser_connect_roxy**: Tool for connecting to RoxyBrowser instances
4. **--roxy-mode**: CLI flag to enable RoxyBrowser mode

### Files Modified
- `src/browserContextFactory.ts` - Added DynamicCdpContextFactory class
- `src/context.ts` - Added reconnectToCDP method
- `src/tools/roxy.ts` - New connection tool
- `src/tools.ts` - Tool registration
- `src/program.ts` - CLI option and mode handling

## Error Handling

The implementation includes comprehensive error handling for:
- Invalid CDP endpoints (validates WebSocket URL format)
- Connection failures with detailed error messages
- Network issues and timeouts
- Browser disconnections and reconnection scenarios
- State consistency during reconnection operations

### Fixed Issues (v2)
- **Browser Context Creation**: Fixed issue where opening new tabs failed after initial connection
- **State Management**: Improved CDP endpoint state persistence across operations
- **Connection Validation**: Added pre-establishment of browser context to verify connections
- **Error Messages**: Enhanced error messages with usage examples

## Testing

Use the provided test script:
```bash
node test-roxy-demo.js
```

## Limitations

- Only supports single browser context (not multiple concurrent browsers)
- Requires RoxyBrowser to provide valid CDP endpoints
- Chrome/Chromium-based browsers only (via CDP protocol)

## Example Workflow

1. Start RoxyBrowser and enable API
2. Start MCP with `node cli.js --roxy-mode`
3. Get WebSocket endpoint from RoxyBrowser
4. Connect using `browser_connect_roxy` tool
5. Use normal browser automation tools
6. Switch to different browser by calling `browser_connect_roxy` with new endpoint