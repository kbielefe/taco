import { EJSON, type Document } from "bson";

/** Relaxed Extended JSON keeps dates as `{"$date":"..."}` and ObjectIds as `{"$oid":"..."}`. */
export function encodeExtendedJson(value: unknown): string {
  return JSON.stringify(EJSON.serialize(value, { relaxed: true }), null, 2);
}

export function decodeExtendedJson(value: unknown): unknown {
  return EJSON.deserialize(value as Document);
}
