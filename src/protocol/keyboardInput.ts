/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

type KeyDefinition = {
  key: string;
  keyCode: number;
  keyCodeWithoutLocation?: number;
  shiftKey?: string;
  shiftKeyCode?: number;
  text?: string;
  location?: number;
};

type KeyboardLayout = Record<string, KeyDefinition>;

export type KeyboardModifierName = "Alt" | "Control" | "Meta" | "Shift";

export type KeyDescription = {
  keyCode: number;
  keyCodeWithoutLocation: number;
  key: string;
  text: string;
  code: string;
  location: number;
  shifted?: KeyDescription;
};

export const keypadLocation = 3;

const USKeyboardLayout: KeyboardLayout = {
  Escape: { keyCode: 27, key: "Escape" },
  F1: { keyCode: 112, key: "F1" },
  F2: { keyCode: 113, key: "F2" },
  F3: { keyCode: 114, key: "F3" },
  F4: { keyCode: 115, key: "F4" },
  F5: { keyCode: 116, key: "F5" },
  F6: { keyCode: 117, key: "F6" },
  F7: { keyCode: 118, key: "F7" },
  F8: { keyCode: 119, key: "F8" },
  F9: { keyCode: 120, key: "F9" },
  F10: { keyCode: 121, key: "F10" },
  F11: { keyCode: 122, key: "F11" },
  F12: { keyCode: 123, key: "F12" },
  Backquote: { keyCode: 192, shiftKey: "~", key: "`" },
  Digit1: { keyCode: 49, shiftKey: "!", key: "1" },
  Digit2: { keyCode: 50, shiftKey: "@", key: "2" },
  Digit3: { keyCode: 51, shiftKey: "#", key: "3" },
  Digit4: { keyCode: 52, shiftKey: "$", key: "4" },
  Digit5: { keyCode: 53, shiftKey: "%", key: "5" },
  Digit6: { keyCode: 54, shiftKey: "^", key: "6" },
  Digit7: { keyCode: 55, shiftKey: "&", key: "7" },
  Digit8: { keyCode: 56, shiftKey: "*", key: "8" },
  Digit9: { keyCode: 57, shiftKey: "(", key: "9" },
  Digit0: { keyCode: 48, shiftKey: ")", key: "0" },
  Minus: { keyCode: 189, shiftKey: "_", key: "-" },
  Equal: { keyCode: 187, shiftKey: "+", key: "=" },
  Backslash: { keyCode: 220, shiftKey: "|", key: "\\" },
  Backspace: { keyCode: 8, key: "Backspace" },
  Tab: { keyCode: 9, key: "Tab" },
  KeyQ: { keyCode: 81, shiftKey: "Q", key: "q" },
  KeyW: { keyCode: 87, shiftKey: "W", key: "w" },
  KeyE: { keyCode: 69, shiftKey: "E", key: "e" },
  KeyR: { keyCode: 82, shiftKey: "R", key: "r" },
  KeyT: { keyCode: 84, shiftKey: "T", key: "t" },
  KeyY: { keyCode: 89, shiftKey: "Y", key: "y" },
  KeyU: { keyCode: 85, shiftKey: "U", key: "u" },
  KeyI: { keyCode: 73, shiftKey: "I", key: "i" },
  KeyO: { keyCode: 79, shiftKey: "O", key: "o" },
  KeyP: { keyCode: 80, shiftKey: "P", key: "p" },
  BracketLeft: { keyCode: 219, shiftKey: "{", key: "[" },
  BracketRight: { keyCode: 221, shiftKey: "}", key: "]" },
  CapsLock: { keyCode: 20, key: "CapsLock" },
  KeyA: { keyCode: 65, shiftKey: "A", key: "a" },
  KeyS: { keyCode: 83, shiftKey: "S", key: "s" },
  KeyD: { keyCode: 68, shiftKey: "D", key: "d" },
  KeyF: { keyCode: 70, shiftKey: "F", key: "f" },
  KeyG: { keyCode: 71, shiftKey: "G", key: "g" },
  KeyH: { keyCode: 72, shiftKey: "H", key: "h" },
  KeyJ: { keyCode: 74, shiftKey: "J", key: "j" },
  KeyK: { keyCode: 75, shiftKey: "K", key: "k" },
  KeyL: { keyCode: 76, shiftKey: "L", key: "l" },
  Semicolon: { keyCode: 186, shiftKey: ":", key: ";" },
  Quote: { keyCode: 222, shiftKey: "\"", key: "'" },
  Enter: { keyCode: 13, key: "Enter", text: "\r" },
  ShiftLeft: { keyCode: 160, keyCodeWithoutLocation: 16, key: "Shift", location: 1 },
  KeyZ: { keyCode: 90, shiftKey: "Z", key: "z" },
  KeyX: { keyCode: 88, shiftKey: "X", key: "x" },
  KeyC: { keyCode: 67, shiftKey: "C", key: "c" },
  KeyV: { keyCode: 86, shiftKey: "V", key: "v" },
  KeyB: { keyCode: 66, shiftKey: "B", key: "b" },
  KeyN: { keyCode: 78, shiftKey: "N", key: "n" },
  KeyM: { keyCode: 77, shiftKey: "M", key: "m" },
  Comma: { keyCode: 188, shiftKey: "<", key: "," },
  Period: { keyCode: 190, shiftKey: ">", key: "." },
  Slash: { keyCode: 191, shiftKey: "?", key: "/" },
  ShiftRight: { keyCode: 161, keyCodeWithoutLocation: 16, key: "Shift", location: 2 },
  ControlLeft: { keyCode: 162, keyCodeWithoutLocation: 17, key: "Control", location: 1 },
  MetaLeft: { keyCode: 91, key: "Meta", location: 1 },
  AltLeft: { keyCode: 164, keyCodeWithoutLocation: 18, key: "Alt", location: 1 },
  Space: { keyCode: 32, key: " " },
  AltRight: { keyCode: 165, keyCodeWithoutLocation: 18, key: "Alt", location: 2 },
  AltGraph: { keyCode: 225, key: "AltGraph" },
  MetaRight: { keyCode: 92, key: "Meta", location: 2 },
  ContextMenu: { keyCode: 93, key: "ContextMenu" },
  ControlRight: { keyCode: 163, keyCodeWithoutLocation: 17, key: "Control", location: 2 },
  PrintScreen: { keyCode: 44, key: "PrintScreen" },
  ScrollLock: { keyCode: 145, key: "ScrollLock" },
  Pause: { keyCode: 19, key: "Pause" },
  PageUp: { keyCode: 33, key: "PageUp" },
  PageDown: { keyCode: 34, key: "PageDown" },
  Insert: { keyCode: 45, key: "Insert" },
  Delete: { keyCode: 46, key: "Delete" },
  Home: { keyCode: 36, key: "Home" },
  End: { keyCode: 35, key: "End" },
  ArrowLeft: { keyCode: 37, key: "ArrowLeft" },
  ArrowUp: { keyCode: 38, key: "ArrowUp" },
  ArrowRight: { keyCode: 39, key: "ArrowRight" },
  ArrowDown: { keyCode: 40, key: "ArrowDown" },
  AudioVolumeMute: { keyCode: 173, key: "AudioVolumeMute" },
  AudioVolumeDown: { keyCode: 174, key: "AudioVolumeDown" },
  AudioVolumeUp: { keyCode: 175, key: "AudioVolumeUp" },
  MediaTrackNext: { keyCode: 176, key: "MediaTrackNext" },
  MediaTrackPrevious: { keyCode: 177, key: "MediaTrackPrevious" },
  MediaPlayPause: { keyCode: 179, key: "MediaPlayPause" },
  NumLock: { keyCode: 144, key: "NumLock" },
  NumpadDivide: { keyCode: 111, key: "/", location: 3 },
  NumpadMultiply: { keyCode: 106, key: "*", location: 3 },
  NumpadSubtract: { keyCode: 109, key: "-", location: 3 },
  Numpad7: { keyCode: 36, shiftKeyCode: 103, key: "Home", shiftKey: "7", location: 3 },
  Numpad8: { keyCode: 38, shiftKeyCode: 104, key: "ArrowUp", shiftKey: "8", location: 3 },
  Numpad9: { keyCode: 33, shiftKeyCode: 105, key: "PageUp", shiftKey: "9", location: 3 },
  Numpad4: { keyCode: 37, shiftKeyCode: 100, key: "ArrowLeft", shiftKey: "4", location: 3 },
  Numpad5: { keyCode: 12, shiftKeyCode: 101, key: "Clear", shiftKey: "5", location: 3 },
  Numpad6: { keyCode: 39, shiftKeyCode: 102, key: "ArrowRight", shiftKey: "6", location: 3 },
  NumpadAdd: { keyCode: 107, key: "+", location: 3 },
  Numpad1: { keyCode: 35, shiftKeyCode: 97, key: "End", shiftKey: "1", location: 3 },
  Numpad2: { keyCode: 40, shiftKeyCode: 98, key: "ArrowDown", shiftKey: "2", location: 3 },
  Numpad3: { keyCode: 34, shiftKeyCode: 99, key: "PageDown", shiftKey: "3", location: 3 },
  Numpad0: { keyCode: 45, shiftKeyCode: 96, key: "Insert", shiftKey: "0", location: 3 },
  NumpadDecimal: { keyCode: 46, shiftKeyCode: 110, key: "\u0000", shiftKey: ".", location: 3 },
  NumpadEnter: { keyCode: 13, key: "Enter", text: "\r", location: 3 }
};

const keyboardModifiers: KeyboardModifierName[] = ["Alt", "Control", "Meta", "Shift"];

const aliases = new Map<string, string[]>([
  ["ShiftLeft", ["Shift"]],
  ["ControlLeft", ["Control"]],
  ["AltLeft", ["Alt"]],
  ["MetaLeft", ["Meta"]],
  ["Enter", ["\n", "\r"]]
]);

const usKeyboardLayout = buildLayoutClosure(USKeyboardLayout);

export function resolveSmartModifierString(key: string): string {
  if (key === "ControlOrMeta") {
    return process.platform === "darwin" ? "Meta" : "Control";
  }
  return key;
}

export function splitKeyboardShortcut(keyString: string): string[] {
  const keys: string[] = [];
  let building = "";
  for (const char of keyString) {
    if (char === "+" && building) {
      keys.push(building);
      building = "";
    } else {
      building += char;
    }
  }
  keys.push(building);
  return keys;
}

export function isKeyboardModifier(key: string): key is KeyboardModifierName {
  return keyboardModifiers.includes(key as KeyboardModifierName);
}

export function isUsKeyboardLayoutKey(key: string): boolean {
  return usKeyboardLayout.has(key);
}

export function keyDescriptionForString(str: string, pressedModifiers: Set<string>): KeyDescription {
  const keyString = resolveSmartModifierString(str);
  let description = usKeyboardLayout.get(keyString);
  if (!description) {
    throw new Error(`Unknown key: "${keyString}"`);
  }

  const shift = pressedModifiers.has("Shift");
  description = shift && description.shifted ? description.shifted : description;

  if (pressedModifiers.size > 1 || (!pressedModifiers.has("Shift") && pressedModifiers.size === 1)) {
    return { ...description, text: "" };
  }
  return description;
}

export function keyboardModifierMask(modifiers: Iterable<string>): number {
  let mask = 0;
  for (const modifier of modifiers) {
    switch (modifier) {
      case "Alt":
        mask |= 1;
        break;
      case "Control":
        mask |= 2;
        break;
      case "Meta":
        mask |= 4;
        break;
      case "Shift":
        mask |= 8;
        break;
    }
  }
  return mask;
}

function buildLayoutClosure(layout: KeyboardLayout): Map<string, KeyDescription> {
  const result = new Map<string, KeyDescription>();
  for (const code in layout) {
    const definition = layout[code];
    if (!definition) {
      continue;
    }
    const description: KeyDescription = {
      key: definition.key || "",
      keyCode: definition.keyCode || 0,
      keyCodeWithoutLocation: definition.keyCodeWithoutLocation || definition.keyCode || 0,
      code,
      text: definition.text || "",
      location: definition.location || 0
    };
    if (definition.key.length === 1) {
      description.text = description.key;
    }

    let shiftedDescription: KeyDescription | undefined;
    if (definition.shiftKey) {
      shiftedDescription = { ...description };
      shiftedDescription.key = definition.shiftKey;
      shiftedDescription.text = definition.shiftKey;
      if (definition.shiftKeyCode) {
        shiftedDescription.keyCode = definition.shiftKeyCode;
      }
    }

    result.set(
      code,
      shiftedDescription ? { ...description, shifted: shiftedDescription } : description
    );

    if (aliases.has(code)) {
      for (const alias of aliases.get(code) ?? []) {
        result.set(alias, description);
      }
    }

    if (definition.location) {
      continue;
    }

    if (description.key.length === 1) {
      result.set(description.key, description);
    }

    if (shiftedDescription) {
      const { shifted: _shifted, ...unshiftedDescription } = shiftedDescription;
      result.set(shiftedDescription.key, unshiftedDescription);
    }
  }
  return result;
}
