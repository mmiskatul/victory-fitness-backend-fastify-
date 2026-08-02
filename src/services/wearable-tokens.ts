import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

const keyMaterial = (): Buffer => {
  if (!config.wearableTokenEncryptionKey) {
    throw new AppError(503, "Wearable token encryption is not configured");
  }
  return createHash("sha256")
    .update(config.wearableTokenEncryptionKey)
    .digest();
};

const urlSafe = (value: Buffer): string => value.toString("base64url");

/** Produces the same Fernet token format used by the Python backend. */
export function encryptWearableToken(value: string | null | undefined): string {
  if (!value) return "";
  const key = keyMaterial();
  const signingKey = key.subarray(0, 16);
  const encryptionKey = key.subarray(16, 32);
  const iv = randomBytes(16);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const signed = Buffer.concat([Buffer.from([0x80]), timestamp, iv, encrypted]);
  const signature = createHmac("sha256", signingKey).update(signed).digest();
  return urlSafe(Buffer.concat([signed, signature]));
}

const decryptLegacyFastifyToken = (value: string, key: Buffer): string => {
  const [, encodedIv, encodedTag, encodedPayload] = value.split(".");
  if (!encodedIv || !encodedTag || !encodedPayload) {
    throw new Error("invalid token");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedPayload, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

export function decryptWearableToken(value: string | null | undefined): string {
  if (!value) return "";
  const key = keyMaterial();
  try {
    if (value.startsWith("v1.")) return decryptLegacyFastifyToken(value, key);
    const token = Buffer.from(value, "base64url");
    if (token.length < 73 || token[0] !== 0x80) {
      throw new Error("invalid token");
    }
    const signed = token.subarray(0, -32);
    const suppliedSignature = token.subarray(-32);
    const expectedSignature = createHmac("sha256", key.subarray(0, 16))
      .update(signed)
      .digest();
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
      throw new Error("invalid signature");
    }
    const iv = token.subarray(9, 25);
    const encrypted = token.subarray(25, -32);
    const decipher = createDecipheriv("aes-128-cbc", key.subarray(16, 32), iv);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppError(500, "Unable to decrypt wearable token");
  }
}
