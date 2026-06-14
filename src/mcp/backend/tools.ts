import common from "./common.js";
import files from "./files.js";
import keyboard from "./keyboard.js";
import snapshot from "./snapshot.js";

import type { Tool } from "./tool.js";

export const browserTools: Tool[] = [
  ...common,
  ...files,
  ...keyboard,
  ...snapshot
];

export default browserTools;
