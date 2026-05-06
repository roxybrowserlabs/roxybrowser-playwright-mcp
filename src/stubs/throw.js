// Stub for optional native dependencies (utf-8-validate, bufferutil, fsevents, etc.)
// These are optional deps of packages like `ws` and `chokidar` that have
// pure-JS fallbacks inside try-catch blocks.
// Throwing here triggers the catch path, which uses the JS fallback.
// This avoids emitting require() calls in the webpack output that consumers'
// bundlers (e.g., Bun) would fail to resolve.
throw new Error('Optional native module not available');
