export function looksLikeFunctionExpression(expression: string): boolean {
  const trimmed = expression.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("function") || trimmed.startsWith("async function")) {
    return true;
  }

  if (trimmed.startsWith("async ")) {
    return /^\s*async\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/s.test(trimmed);
  }

  return /^\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/s.test(trimmed);
}
