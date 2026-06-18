import { parseEvaluationResultValue, type SerializedValue } from "../utilityScriptSerializers.js";

export const SERIALIZE_EVALUATION_RESULT_SOURCE = String.raw`
function __roxySerializeEvaluationResult(value) {
  const typedArrayConstructors = {
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
  const typedArrayToBase64 = (array) => {
    if ("toBase64" in array)
      return array.toBase64();
    const binary = Array.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).map((b) => String.fromCharCode(b)).join("");
    return btoa(binary);
  };
  const isRegExp = (obj) => {
    try { return obj instanceof RegExp || Object.prototype.toString.call(obj) === "[object RegExp]"; } catch { return false; }
  };
  const isDate = (obj) => {
    try { return obj instanceof Date || Object.prototype.toString.call(obj) === "[object Date]"; } catch { return false; }
  };
  const isURL = (obj) => {
    try { return obj instanceof URL || Object.prototype.toString.call(obj) === "[object URL]"; } catch { return false; }
  };
  const isError = (obj) => {
    try { return obj instanceof Error || (obj && Object.getPrototypeOf(obj)?.name === "Error"); } catch { return false; }
  };
  const isTypedArray = (obj, constructor) => {
    try { return obj instanceof constructor || Object.prototype.toString.call(obj) === "[object " + constructor.name + "]"; } catch { return false; }
  };
  const isArrayBuffer = (obj) => {
    try { return obj instanceof ArrayBuffer || Object.prototype.toString.call(obj) === "[object ArrayBuffer]"; } catch { return false; }
  };
  const serialize = (value, visitorInfo) => {
    if (value && typeof value === "object") {
      if (typeof globalThis.Window === "function" && value instanceof globalThis.Window)
        return "ref: <Window>";
      if (typeof globalThis.Document === "function" && value instanceof globalThis.Document)
        return "ref: <Document>";
      if (typeof globalThis.Node === "function" && value instanceof globalThis.Node)
        return "ref: <Node>";
    }
    if (typeof value === "symbol")
      return { v: "undefined" };
    if (Object.is(value, undefined))
      return { v: "undefined" };
    if (Object.is(value, null))
      return { v: "null" };
    if (Object.is(value, NaN))
      return { v: "NaN" };
    if (Object.is(value, Infinity))
      return { v: "Infinity" };
    if (Object.is(value, -Infinity))
      return { v: "-Infinity" };
    if (Object.is(value, -0))
      return { v: "-0" };
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string")
      return value;
    if (typeof value === "bigint")
      return { bi: value.toString() };
    if (isError(value)) {
      const stack = value.stack?.startsWith(value.name + ": " + value.message) ? value.stack : value.name + ": " + value.message + "\n" + value.stack;
      return { e: { n: value.name, m: value.message, s: stack } };
    }
    if (isDate(value))
      return { d: value.toJSON() };
    if (isURL(value))
      return { u: value.toJSON() };
    if (isRegExp(value))
      return { r: { p: value.source, f: value.flags } };
    for (const [k, ctor] of Object.entries(typedArrayConstructors)) {
      if (isTypedArray(value, ctor))
        return { ta: { b: typedArrayToBase64(value), k } };
    }
    if (isArrayBuffer(value))
      return { ab: { b: typedArrayToBase64(new Uint8Array(value)) } };
    const getVisited = (object) => {
      for (const entry of visitorInfo.visited) {
        if (entry.object === object)
          return entry.id;
      }
      return undefined;
    };
    const setVisited = (object, id) => visitorInfo.visited.push({ object, id });
    const existingId = getVisited(value);
    if (existingId)
      return { ref: existingId };
    if (Array.isArray(value)) {
      const id = ++visitorInfo.lastId;
      setVisited(value, id);
      return { a: value.map((entry) => serialize(entry, visitorInfo)), id };
    }
    if (typeof value === "object") {
      const id = ++visitorInfo.lastId;
      setVisited(value, id);
      const o = [];
      for (const name of Object.keys(value)) {
        let item;
        try {
          item = value[name];
        } catch {
          continue;
        }
        if (name === "toJSON" && typeof item === "function")
          o.push({ k: name, v: { o: [], id: 0 } });
        else
          o.push({ k: name, v: serialize(item, visitorInfo) });
      }
      let jsonWrapper;
      try {
        if (o.length === 0 && value.toJSON && typeof value.toJSON === "function")
          jsonWrapper = { value: value.toJSON() };
      } catch {}
      if (jsonWrapper)
        return serialize(jsonWrapper.value, visitorInfo);
      return { o, id };
    }
    return { v: "undefined" };
  };
  return serialize(value, { visited: [], lastId: 0 });
}
`;

export const PARSE_EVALUATION_RESULT_SOURCE = String.raw`
function __roxyParseEvaluationResultValue(value, handles = [], refs = []) {
  const typedArrayConstructors = {
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
  const base64ToTypedArray = (base64, TypedArrayConstructor) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1)
      bytes[i] = binary.charCodeAt(i);
    return new TypedArrayConstructor(bytes.buffer);
  };
  if (Object.is(value, undefined))
    return undefined;
  if (typeof value === "object" && value) {
    if ("ref" in value)
      return refs.find(entry => entry.id === value.ref)?.value;
    if ("v" in value) {
      if (value.v === "undefined")
        return undefined;
      if (value.v === "null")
        return null;
      if (value.v === "NaN")
        return NaN;
      if (value.v === "Infinity")
        return Infinity;
      if (value.v === "-Infinity")
        return -Infinity;
      if (value.v === "-0")
        return -0;
      return undefined;
    }
    if ("d" in value)
      return new Date(value.d);
    if ("u" in value)
      return new URL(value.u);
    if ("bi" in value)
      return BigInt(value.bi);
    if ("e" in value) {
      const error = new Error(value.e.m);
      error.name = value.e.n;
      error.stack = value.e.s;
      return error;
    }
    if ("r" in value)
      return new RegExp(value.r.p, value.r.f);
    if ("a" in value) {
      const result = [];
      refs.push({ id: value.id, value: result });
      for (const a of value.a)
        result.push(__roxyParseEvaluationResultValue(a, handles, refs));
      return result;
    }
    if ("o" in value) {
      const result = {};
      refs.push({ id: value.id, value: result });
      for (const { k, v } of value.o) {
        if (k === "__proto__")
          continue;
        result[k] = __roxyParseEvaluationResultValue(v, handles, refs);
      }
      return result;
    }
    if ("h" in value)
      return handles[value.h];
    if ("ta" in value)
      return base64ToTypedArray(value.ta.b, typedArrayConstructors[value.ta.k]);
    if ("ab" in value)
      return base64ToTypedArray(value.ab.b, Uint8Array).buffer;
  }
  return value;
}
`;

function serializeForEvaluation(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function wrapWithSerializedEvaluationResult(expression: string): string {
  return `(() => {
    ${SERIALIZE_EVALUATION_RESULT_SOURCE}
    return Promise.resolve((0, eval)(${serializeForEvaluation(expression)})).then(__roxySerializeEvaluationResult);
  })()`;
}

export function parseSerializedEvaluationResult<TResult>(value: SerializedValue): TResult {
  return parseEvaluationResultValue(value) as TResult;
}
