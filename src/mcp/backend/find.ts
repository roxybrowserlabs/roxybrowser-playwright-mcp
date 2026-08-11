import { z } from "zod";
import { defineTabTool } from "./tool.js";

const contextLines = 3;

const find = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_find",
    title: "Find in page snapshot",
    description: "Search the accessibility snapshot of the current page for text or a regular expression. Returns matching snapshot nodes with a few lines of surrounding context (like search snippets), each shown under its path from the root of the tree, which is cheaper than capturing the whole snapshot when you only need to locate an element and its ref.",
    inputSchema: z.object({
      text: z.string().optional().describe("Plain text to search for in the page snapshot (case-insensitive substring match). Provide either text or regex, not both."),
      regex: z.string().optional().refine((value) => !value || isValidRegex(value), { message: "Invalid regular expression" }).describe("Regular expression to search for in the page snapshot. Matching is case-sensitive by default; wrap the pattern in slashes to add flags, e.g. \"/error/i\" for case-insensitive. Provide either text or regex, not both.")
    }),
    type: "readOnly"
  },

  handle: async (tab, params, response) => {
    if (!params.text && !params.regex) {
      response.addError('Provide either "text" or "regex" to search for.');
      return;
    }
    if (params.text && params.regex) {
      response.addError('Provide only one of "text" or "regex", not both.');
      return;
    }

    let query: string;
    let matches: (line: string) => boolean;
    if (params.regex) {
      const regex = compileRegex(params.regex);
      query = String(regex);
      matches = (line) => {
        regex.lastIndex = 0;
        return regex.test(line);
      };
    } else {
      query = `"${params.text}"`;
      const needle = params.text!.toLowerCase();
      matches = (line) => line.toLowerCase().includes(needle);
    }

    const snapshot = await tab.context.runtime.ariaSnapshot();
    const lines = snapshot.split("\n");
    const indents = lines.map(indentOf);
    const matchedLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (matches(lines[i]!)) {
        matchedLines.push(i);
      }
    }

    if (!matchedLines.length) {
      response.addTextResult(`No matches found for ${query}.`);
      return;
    }

    const windows: Array<{ start: number; end: number }> = [];
    for (const line of matchedLines) {
      const start = Math.max(0, line - contextLines);
      const end = Math.min(lines.length - 1, line + contextLines);
      const last = windows[windows.length - 1];
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
      } else {
        windows.push({ start, end });
      }
    }

    const path = new Set<number>();
    for (const match of matchedLines) {
      path.add(match);
      for (const ancestor of ancestorIndices(lines, indents, match)) {
        path.add(ancestor);
      }
    }

    const snippets = windows.map((window) => {
      const indices = ancestorIndices(lines, indents, window.start);
      for (let i = window.start; i <= window.end; i++) {
        indices.push(i);
      }
      const out: string[] = [];
      for (let i = 0; i < indices.length; i++) {
        const index = indices[i]!;
        const previous = indices[i - 1];
        if (
          previous !== undefined
          && index > previous + 1
          && !path.has(index)
          && !path.has(previous)
        ) {
          out.push(" ".repeat(indents[index]!) + "...");
        }
        out.push(lines[index]!);
      }
      return out.join("\n");
    });
    const matchWord = matchedLines.length === 1 ? "match" : "matches";
    response.addTextResult(`Found ${matchedLines.length} ${matchWord} for ${query}:\n\n${snippets.join("\n\n----\n\n")}`);
  }
});

function compileRegex(source: string): RegExp {
  const literal = /^\/(.*)\/([a-z]*)$/.exec(source);
  const pattern = literal ? literal[1] ?? "" : source;
  const flags = literal ? (literal[2] ?? "").replace(/g/g, "") : "";
  return new RegExp(pattern, flags);
}

function isValidRegex(source: string): boolean {
  try {
    compileRegex(source);
    return true;
  } catch {
    return false;
  }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function ancestorIndices(lines: string[], indents: number[], index: number): number[] {
  const result: number[] = [];
  let indent = indents[index]!;
  for (let i = index - 1; i >= 0 && indent > 0; i--) {
    if (!lines[i]!.trim()) {
      continue;
    }
    if (indents[i]! < indent) {
      result.push(i);
      indent = indents[i]!;
    }
  }
  return result.reverse();
}

export default [find];
