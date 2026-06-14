import type { Tool } from "../tool.js";
import connect from "./connect.js";
import common from "./common.js";
import tabs from "./tabs.js";
import navigate from "./navigate.js";
import mouse from "./mouse.js";
import keyboard from "./keyboard.js";
import form from "./form.js";
import screenshot from "./screenshot.js";
import consoleTools from "./console.js";
import evaluate from "./evaluate.js";
import dialog from "./dialog.js";
import network from "./network.js";
import runCode from "./runCode.js";

export const allTools: Tool[] = [
  ...connect,
  ...common,
  ...tabs,
  ...navigate,
  ...mouse,
  ...keyboard,
  ...form,
  ...screenshot,
  ...consoleTools,
  ...evaluate,
  ...dialog,
  ...network,
  ...runCode
];
