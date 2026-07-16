import common from "./common.js";
import consoleTools from "./console.js";
import connect from "./connect.js";
import dialogs from "./dialogs.js";
import evaluate from "./evaluate.js";
import files from "./files.js";
import keyboard from "./keyboard.js";
import navigate from "./navigate.js";
import network from "./network.js";
import runCode from "./runCode.js";
import screenshot from "./screenshot.js";
import snapshot from "./snapshot.js";
import tabs from "./tabs.js";

import type { Tool } from "./tool.js";

export const browserTools: Tool[] = [
  ...common,
  ...consoleTools,
  ...connect,
  ...dialogs,
  ...evaluate,
  ...files,
  ...keyboard,
  ...navigate,
  ...network,
  ...runCode,
  ...screenshot,
  ...snapshot,
  ...tabs
];

export default browserTools;
