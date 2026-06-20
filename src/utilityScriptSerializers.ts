/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

type TypedArrayKind =
  | "i8"
  | "ui8"
  | "ui8c"
  | "i16"
  | "ui16"
  | "i32"
  | "ui32"
  | "f32"
  | "f64"
  | "bi64"
  | "bui64";

export type SerializedValue =
  | undefined
  | boolean
  | number
  | string
  | { v: "null" | "undefined" | "NaN" | "Infinity" | "-Infinity" | "-0" }
  | { d: string }
  | { u: string }
  | { bi: string }
  | { e: { n: string; m: string; s: string } }
  | { r: { p: string; f: string } }
  | { a: SerializedValue[]; id: number }
  | { o: Array<{ k: string; v: SerializedValue }>; id: number }
  | { ref: number }
  | { h: number }
  | { ta: { b: string; k: TypedArrayKind } }
  | { ab: { b: string } };

type HandleOrValue = { h: number } | { fallThrough: any };

type VisitorInfo = {
  visited: Map<object, number>;
  lastId: number;
};

function isRegExp(obj: any): obj is RegExp {
  try {
    return obj instanceof RegExp || Object.prototype.toString.call(obj) === "[object RegExp]";
  } catch {
    return false;
  }
}

function isDate(obj: any): obj is Date {
  try {
    return obj instanceof Date || Object.prototype.toString.call(obj) === "[object Date]";
  } catch {
    return false;
  }
}

function isURL(obj: any): obj is URL {
  try {
    return obj instanceof URL || Object.prototype.toString.call(obj) === "[object URL]";
  } catch {
    return false;
  }
}

function isError(obj: any): obj is Error {
  try {
    return obj instanceof Error || (obj && Object.getPrototypeOf(obj)?.name === "Error");
  } catch {
    return false;
  }
}

function isTypedArray(obj: any, constructor: Function): boolean {
  try {
    return obj instanceof constructor || Object.prototype.toString.call(obj) === `[object ${constructor.name}]`;
  } catch {
    return false;
  }
}

function isArrayBuffer(obj: any): obj is ArrayBuffer {
  try {
    return obj instanceof ArrayBuffer || Object.prototype.toString.call(obj) === "[object ArrayBuffer]";
  } catch {
    return false;
  }
}

const typedArrayConstructors: Record<TypedArrayKind, Function> = {
  i8: Int8Array,
  ui8: Uint8Array,
  ui8c: Uint8ClampedArray,
  i16: Int16Array,
  ui16: Uint16Array,
  i32: Int32Array,
  ui32: Uint32Array,
  f32: Float32Array,
  f64: Float64Array,
  bi64: BigInt64Array,
  bui64: BigUint64Array
};

function typedArrayToBase64(array: any): string {
  if ("toBase64" in array) {
    return array.toBase64();
  }
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

function base64ToTypedArray(base64: string, TypedArrayConstructor: any): any {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TypedArrayConstructor(bytes.buffer);
}

export function parseEvaluationResultValue(
  value: SerializedValue,
  handles: any[] = [],
  refs: Map<number, object> = new Map()
): any {
  if (Object.is(value, undefined)) {
    return undefined;
  }
  if (typeof value === "object" && value) {
    if ("ref" in value) {
      return refs.get(value.ref);
    }
    if ("v" in value) {
      if (value.v === "undefined") {
        return undefined;
      }
      if (value.v === "null") {
        return null;
      }
      if (value.v === "NaN") {
        return NaN;
      }
      if (value.v === "Infinity") {
        return Infinity;
      }
      if (value.v === "-Infinity") {
        return -Infinity;
      }
      if (value.v === "-0") {
        return -0;
      }
      return undefined;
    }
    if ("d" in value) {
      return new Date(value.d);
    }
    if ("u" in value) {
      return new URL(value.u);
    }
    if ("bi" in value) {
      return BigInt(value.bi);
    }
    if ("e" in value) {
      const error = new Error(value.e.m);
      error.name = value.e.n;
      error.stack = value.e.s;
      return error;
    }
    if ("r" in value) {
      return new RegExp(value.r.p, value.r.f);
    }
    if ("a" in value) {
      const result: any[] = [];
      refs.set(value.id, result);
      for (let index = 0; index < value.a.length; index += 1) {
        result[index] = parseEvaluationResultValue(value.a[index]!, handles, refs);
      }
      return result;
    }
    if ("o" in value) {
      const result: any = {};
      refs.set(value.id, result);
      for (const { k, v } of value.o) {
        if (k === "__proto__") {
          continue;
        }
        result[k] = parseEvaluationResultValue(v, handles, refs);
      }
      return result;
    }
    if ("h" in value) {
      return handles[value.h];
    }
    if ("ta" in value) {
      return base64ToTypedArray(value.ta.b, typedArrayConstructors[value.ta.k]);
    }
    if ("ab" in value) {
      return base64ToTypedArray(value.ab.b, Uint8Array).buffer;
    }
  }
  return value;
}

export function serializeAsCallArgument(
  value: any,
  handleSerializer: (value: any) => HandleOrValue
): SerializedValue {
  return serialize(value, handleSerializer, { visited: new Map(), lastId: 0 });
}

export function serializeAsCallArgumentNoHandles(value: any): SerializedValue {
  return serializeAsCallArgument(value, (fallThrough) => ({ fallThrough }));
}

function serialize(
  value: any,
  handleSerializer: (value: any) => HandleOrValue,
  visitorInfo: VisitorInfo
): SerializedValue {
  if (value && typeof value === "object") {
    if (typeof globalThis.Window === "function" && value instanceof globalThis.Window) {
      return "ref: <Window>";
    }
    if (typeof globalThis.Document === "function" && value instanceof globalThis.Document) {
      return "ref: <Document>";
    }
    if (typeof globalThis.Node === "function" && value instanceof globalThis.Node) {
      return "ref: <Node>";
    }
  }
  return innerSerialize(value, handleSerializer, visitorInfo);
}

function innerSerialize(
  value: any,
  handleSerializer: (value: any) => HandleOrValue,
  visitorInfo: VisitorInfo
): SerializedValue {
  const result = handleSerializer(value);
  if ("fallThrough" in result) {
    value = result.fallThrough;
  } else {
    return result;
  }

  if (typeof value === "symbol") {
    return { v: "undefined" };
  }
  if (Object.is(value, undefined)) {
    return { v: "undefined" };
  }
  if (Object.is(value, null)) {
    return { v: "null" };
  }
  if (Object.is(value, NaN)) {
    return { v: "NaN" };
  }
  if (Object.is(value, Infinity)) {
    return { v: "Infinity" };
  }
  if (Object.is(value, -Infinity)) {
    return { v: "-Infinity" };
  }
  if (Object.is(value, -0)) {
    return { v: "-0" };
  }

  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return { bi: value.toString() };
  }

  if (isError(value)) {
    const stack = value.stack?.startsWith(value.name + ": " + value.message)
      ? value.stack
      : `${value.name}: ${value.message}\n${value.stack}`;
    return { e: { n: value.name, m: value.message, s: stack } };
  }
  if (isDate(value)) {
    return { d: value.toJSON() };
  }
  if (isURL(value)) {
    return { u: value.toJSON() };
  }
  if (isRegExp(value)) {
    return { r: { p: value.source, f: value.flags } };
  }
  for (const [k, ctor] of Object.entries(typedArrayConstructors) as [TypedArrayKind, Function][]) {
    if (isTypedArray(value, ctor)) {
      return { ta: { b: typedArrayToBase64(value), k } };
    }
  }
  if (isArrayBuffer(value)) {
    return { ab: { b: typedArrayToBase64(new Uint8Array(value)) } };
  }

  const id = visitorInfo.visited.get(value);
  if (id) {
    return { ref: id };
  }

  if (Array.isArray(value)) {
    const a = [];
    const id = ++visitorInfo.lastId;
    visitorInfo.visited.set(value, id);
    for (let i = 0; i < value.length; i += 1) {
      a[i] = serialize(value[i], handleSerializer, visitorInfo);
    }
    return { a, id };
  }

  if (typeof value === "object") {
    const o: Array<{ k: string; v: SerializedValue }> = [];
    const id = ++visitorInfo.lastId;
    visitorInfo.visited.set(value, id);
    let objectIndex = 0;
    for (const name of Object.keys(value)) {
      let item;
      try {
        item = value[name];
      } catch {
        continue;
      }
      if (name === "toJSON" && typeof item === "function") {
        o[objectIndex++] = { k: name, v: { o: [], id: 0 } };
      } else {
        o[objectIndex++] = { k: name, v: serialize(item, handleSerializer, visitorInfo) };
      }
    }

    let jsonWrapper;
    try {
      if (o.length === 0 && value.toJSON && typeof value.toJSON === "function") {
        jsonWrapper = { value: value.toJSON() };
      }
    } catch {}
    if (jsonWrapper) {
      return innerSerialize(jsonWrapper.value, handleSerializer, visitorInfo);
    }

    return { o, id };
  }
}
