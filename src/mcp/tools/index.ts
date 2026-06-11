import type { Tool } from "../tool.js";
import connect from "./connect.js";
import tabs from "./tabs.js";
import snapshot from "./snapshot.js";
import navigate from "./navigate.js";
import mouse from "./mouse.js";
import keyboard from "./keyboard.js";
import form from "./form.js";
import screenshot from "./screenshot.js";

export const allTools: Tool[] = [
  ...connect,
  ...tabs,
  ...snapshot,
  ...navigate,
  ...mouse,
  ...keyboard,
  ...form,
  ...screenshot
];
