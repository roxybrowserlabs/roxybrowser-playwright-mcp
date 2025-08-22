#!/usr/bin/env node

/**
 * Test script for RoxyBrowser dynamic CDP connection
 */

const { spawn } = require('child_process');

console.log('=== RoxyBrowser MCP Demo ===');
console.log('This demo shows how to connect Playwright MCP to RoxyBrowser');
console.log('');

console.log('Usage:');
console.log('1. Start RoxyBrowser and enable API mode');
console.log('2. Get WebSocket CDP endpoint from RoxyBrowser API');
console.log('3. Run this MCP server with --roxy-mode flag');
console.log('4. Use browser_connect_roxy tool with the CDP endpoint');
console.log('');

console.log('Starting Playwright MCP in RoxyBrowser mode...');
console.log('Command: node cli.js --roxy-mode');
console.log('');

const mcp = spawn('node', ['cli.js', '--roxy-mode'], {
  stdio: 'inherit',
  cwd: __dirname
});

mcp.on('error', (error) => {
  console.error('Failed to start MCP server:', error);
});

mcp.on('close', (code) => {
  console.log(`MCP server exited with code ${code}`);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  mcp.kill('SIGINT');
});