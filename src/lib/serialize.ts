import { ObjectId } from "mongodb";

export const toId = (value: unknown): string => {
  if (value instanceof ObjectId) return value.toHexString();
  return String(value ?? "");
};

export const objectId = (
  value: string,
  detail = "Invalid identifier",
): ObjectId => {
  if (!ObjectId.isValid(value)) {
    throw Object.assign(new Error(detail), { statusCode: 404 });
  }
  return new ObjectId(value);
};

export const serialize = (value: unknown): unknown => {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      if (key === "_id") result.id = serialize(item);
      else result[key] = serialize(item);
    }
    return result;
  }
  return value;
};

export const publicDocument = <T extends Record<string, unknown>>(
  document: T | null,
): Record<string, unknown> | null =>
  document ? (serialize(document) as Record<string, unknown>) : null;

export const now = (): Date => new Date();
