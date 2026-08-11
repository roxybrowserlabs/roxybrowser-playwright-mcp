import common from "./common.js";
import config from "./config.js";
import consoleTools from "./console.js";
import connect from "./connect.js";
import dialogs from "./dialogs.js";
import evaluate from "./evaluate.js";
import files from "./files.js";
import form from "./form.js";
import find from "./find.js";
import keyboard from "./keyboard.js";
import navigate from "./navigate.js";
import network from "./network.js";
import route from "./route.js";
import runCode from "./runCode.js";
import screenshot from "./screenshot.js";
import snapshot from "./snapshot.js";
import tabs from "./tabs.js";
import tracing from "./tracing.js";

import type { Tool } from "./tool.js";

export const browserTools: Tool[] = [
  ...common,
  ...config,
  ...consoleTools,
  ...connect,
  ...dialogs,
  ...evaluate,
  ...files,
  ...form,
  ...find,
  ...keyboard,
  ...navigate,
  ...network,
  ...route,
  ...runCode,
  ...screenshot,
  ...snapshot,
  ...tabs,
  ...tracing
];

export default browserTools;
