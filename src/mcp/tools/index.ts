import type { Tool } from "../tool.js";
import mouse from "./mouse.js";
import form from "./form.js";

export const allTools: Tool[] = [
  ...mouse,
  ...form
];
