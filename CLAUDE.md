# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Testing
- `npm run build` - Compile TypeScript to JavaScript
- `npm run watch` - Compile TypeScript in watch mode
- `npm test` - Run all tests using Playwright
- `npm run ctest` - Run Chrome-only tests
- `npm run ftest` - Run Firefox-only tests
- `npm run wtest` - Run WebKit-only tests

### Code Quality
- `npm run lint` - Run ESLint and type checking (includes dependency checks and README updates)
- `npm run lint-fix` - Auto-fix ESLint issues
- `npm run check-deps` - Verify dependency imports match DEPS.list files
- `npm run update-readme` - Auto-generate tool documentation in README

### Other
- `npm run clean` - Remove compiled files
- `npm run run-server` - Start standalone MCP server

## Architecture Overview

This is a Model Context Protocol (MCP) server that provides browser automation capabilities using Playwright. The architecture follows a modular design:

### Core Components

**Entry Point (`src/index.ts`)**
- Main export point providing `createConnection()` function
- Creates MCP server with BrowserServerBackend and browser context factory

**MCP Server Layer (`src/mcp/`)**
- `server.ts` - MCP protocol implementation and server lifecycle
- `tool.ts` - Tool schema conversion from internal format to MCP format  
- `http.ts` - HTTP transport for standalone server mode

**Backend Implementation (`src/browserServerBackend.ts`)**
- Implements ServerBackend interface for MCP
- Manages tool registry, context lifecycle, and session logging
- Handles tool invocation and response serialization

**Browser Context Management (`src/browserContextFactory.ts`)**
- Multiple factory implementations for different browser modes:
  - `PersistentContextFactory` - Default persistent profile mode
  - `IsolatedContextFactory` - Isolated sessions for testing
  - `CdpContextFactory` - Connect to existing browser via CDP
  - `RemoteContextFactory` - Connect to remote Playwright server

**Tools System (`src/tools/`)**
- Modular tool architecture with individual tool files
- Each tool exports schema and handler function
- Tools are filtered based on capabilities configuration
- Core tools always available, optional tools require capability flags

### Key Directories

- `src/tools/` - Individual browser automation tools (click, navigate, snapshot, etc.)
- `src/extension/` - Browser extension for connecting to existing tabs
- `src/vscode/` - VS Code integration components  
- `src/loop/` - Loop mode for autonomous operation
- `extension/` - Chrome extension for tab connection
- `tests/` - Playwright test suite

### Configuration

The server supports extensive configuration via:
- Command-line arguments (see `--help` output)
- JSON configuration files (`--config` flag)
- Browser modes: persistent, isolated, CDP connection, remote
- Capability system for optional tools (vision, pdf, tabs, install)

### Testing

Tests use Playwright's test framework with multiple browser projects. The test setup creates MCP server instances and validates tool functionality across different browsers and modes.