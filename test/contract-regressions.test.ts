import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  normalizeHealthMetric,
  storeHealthMetrics,
} from "../src/services/health.js";
import {
  uploadCommunityMedia,
  uploadMasterclassAudio,
  uploadWorkoutVideo,
} from "../src/services/storage.js";
import { config } from "../src/config.js";
import {
  decryptWearableToken,
  encryptWearableToken,
} from "../src/services/wearable-tokens.js";
import { buildReportPng } from "../src/services/report-image.js";
import { extractDocumentText } from "../src/services/document-text.js";

const metric = {
  metric_type: "steps",
  value: 1_234,
  unit: "count",
  start_time: "2026-08-01T00:00:00Z",
  end_time: "2026-08-01T23:59:59Z",
  source_device: "this-phone",
};

describe("ported FastAPI contract regressions", () => {
  it("normalizes wearable metrics deterministically", () => {
    const first = normalizeHealthMetric("user-1", "apple-health", metric);
    const second = normalizeHealthMetric("user-1", "apple-health", metric);

    expect(first.metric_type).toBe("steps");
    expect(first.type).toBe("steps");
    expect(first.dedupe_key).toBe(second.dedupe_key);
    expect(first.current_key).toBe(
      "user-1|apple-health|steps|2026-08-01|this-phone",
    );
  });

  it("rejects unsupported wearable metric types", () => {
    expect(() =>
      normalizeHealthMetric("user-1", "apple-health", {
        ...metric,
        metric_type: "unknown",
      }),
    ).toThrow("Unsupported metric_type: unknown");
  });

  it("deduplicates repeated health samples across syncs", async () => {
    const snapshots = new Map<string, Record<string, unknown>>();
    const fakeApp = {
      mongo: {
        collection(name: string) {
          return {
            find() {
              return {
                async toArray() {
                  const value = snapshots.get(name);
                  return value ? [value] : [];
                },
              };
            },
            async replaceOne(
              _filter: unknown,
              document: Record<string, unknown>,
            ) {
              snapshots.set(name, document);
            },
            async deleteMany() {},
          };
        },
      },
    } as unknown as FastifyInstance;

    const first = await storeHealthMetrics(fakeApp, "user-1", "apple-health", [
      metric,
    ]);
    const second = await storeHealthMetrics(fakeApp, "user-1", "apple-health", [
      metric,
    ]);

    expect(first).toMatchObject({ inserted: 1, skipped: 0 });
    expect(second).toMatchObject({ inserted: 0, skipped: 1 });
  });

  it("preserves FastAPI community upload limits", async () => {
    await expect(
      uploadCommunityMedia(
        "user-1",
        Buffer.alloc(1024 * 1024 + 1),
        "image/jpeg",
      ),
    ).rejects.toThrow("Image must be 1MB or smaller");
    await expect(
      uploadCommunityMedia(
        "user-1",
        Buffer.alloc(20 * 1024 * 1024 + 1),
        "video/mp4",
      ),
    ).rejects.toThrow("Video must be 20MB or smaller");
    await expect(
      uploadCommunityMedia(
        "user-1",
        Buffer.alloc(25 * 1024 * 1024 + 1),
        "audio/mpeg",
      ),
    ).rejects.toThrow("Audio must be 25MB or smaller");
  });

  it("preserves workout and masterclass upload validation", async () => {
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");
    await expect(
      uploadWorkoutVideo("workout-1", oversized, "video/mp4"),
    ).rejects.toThrow("Video must be 25MB or smaller");
    await expect(
      uploadMasterclassAudio("admin-1", oversized, "audio/mpeg"),
    ).rejects.toThrow("Audio must be 25MB or smaller");
    await expect(
      uploadWorkoutVideo("workout-1", "a".repeat(32), "video/avi"),
    ).rejects.toThrow("Only MP4, MOV, and WEBM videos are supported");
  });

  it("reads Python Fernet tokens and writes compatible wearable tokens", () => {
    const mutableConfig = config as unknown as Record<string, unknown>;
    const previous = mutableConfig.wearableTokenEncryptionKey;
    mutableConfig.wearableTokenEncryptionKey = "compatibility-test-key";
    try {
      const pythonToken =
        "gAAAAABqbe4XgSMG1YGs_1Phclz3kRmCxjsNvIgatxlQQiVo-U7d3_o3vRs7lxfpjcjW-DqFGmqvcfgPd94L6HEX2ylGZQqEBiX_0r5R6QiqfGouflYUnms=";
      expect(decryptWearableToken(pythonToken)).toBe("python-oauth-token");
      expect(
        decryptWearableToken(encryptWearableToken("fastify-oauth-token")),
      ).toBe("fastify-oauth-token");
    } finally {
      mutableConfig.wearableTokenEncryptionKey = previous;
    }
  });

  it("creates personalized PNG completion reports", () => {
    const first = buildReportPng({
      title: "Strength Day",
      subtitle: "Workout completed",
      member: "Member One",
      metric: "Plan days 2/3",
      progress: 2 / 3,
    });
    const second = buildReportPng({
      title: "Cardio Day",
      subtitle: "Workout completed",
      member: "Member Two",
      metric: "Plan days 1/3",
      progress: 1 / 3,
    });

    expect(first.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(first.equals(second)).toBe(false);
    expect(first.length).toBeGreaterThan(1_000);
  });

  it("extracts readable meal text documents", async () => {
    const encoded = Buffer.from("Chicken, rice, and vegetables").toString(
      "base64",
    );
    await expect(
      extractDocumentText(encoded, "text/plain", "meal.txt"),
    ).resolves.toBe("Chicken, rice, and vegetables");
    await expect(
      extractDocumentText(encoded, "application/msword", "meal.doc"),
    ).rejects.toThrow("Legacy .doc files are not supported yet");
  });
});
