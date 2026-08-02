import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

const imageTypes: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const communityMediaTypes: Record<string, string> = {
  ...imageTypes,
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "application/ogg": ".ogg",
};
const videoTypes: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};
const audioTypes: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "application/ogg": ".ogg",
};

const client = config.aws.region
  ? new S3Client({
      region: config.aws.region,
      credentials:
        config.aws.accessKeyId && config.aws.secretAccessKey
          ? {
              accessKeyId: config.aws.accessKeyId,
              secretAccessKey: config.aws.secretAccessKey,
            }
          : undefined,
    })
  : null;

const decodeBase64 = (value: string): Buffer => {
  const encoded = value.includes(",")
    ? value.slice(value.indexOf(",") + 1)
    : value;
  try {
    return Buffer.from(encoded, "base64");
  } catch {
    throw new AppError(400, "Invalid base64 image");
  }
};

export async function uploadProfileImage(
  userId: string,
  imageBase64: string,
  mimeType: string,
  fileName?: string,
  folder = "profile-images",
): Promise<string> {
  const mime = mimeType.trim().toLowerCase();
  const extension = imageTypes[mime];
  if (!extension) {
    throw new AppError(
      400,
      "Only JPEG, PNG, WEBP, and GIF images are supported",
    );
  }
  const payload = decodeBase64(imageBase64);
  if (!payload.length) throw new AppError(400, "Image is empty");
  if (payload.length > 10 * 1024 * 1024) {
    throw new AppError(400, "Image must be 10MB or smaller");
  }
  if (!client || !config.aws.bucket || !config.aws.region) {
    throw new AppError(500, "S3 storage is not configured");
  }
  const requestedExtension = extname(fileName ?? "").toLowerCase();
  const safeExtension = Object.values(imageTypes).includes(requestedExtension)
    ? requestedExtension
    : extension;
  const safeFolder =
    folder.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "uploads";
  const key = `${safeFolder}/${userId}/${Date.now()}-${randomUUID()}${safeExtension}`;
  await client.send(
    new PutObjectCommand({
      Bucket: config.aws.bucket,
      Key: key,
      Body: payload,
      ContentType: mime,
      CacheControl: "public, max-age=31536000",
    }),
  );
  return `https://${config.aws.bucket}.s3.${config.aws.region}.amazonaws.com/${key}`;
}

export async function uploadCommunityMedia(
  userId: string,
  payload: Buffer,
  mimeType: string,
  fileName?: string,
): Promise<{ url: string; kind: "image" | "video" | "audio" }> {
  const mime = mimeType.trim().toLowerCase();
  const extension = communityMediaTypes[mime];
  const kind = mime.startsWith("image/")
    ? "image"
    : mime.startsWith("audio/") || mime === "application/ogg"
      ? "audio"
      : "video";
  if (!extension) throw new AppError(400, "Unsupported community attachment");
  const maximum =
    kind === "image"
      ? 1024 * 1024
      : kind === "audio"
        ? 25 * 1024 * 1024
        : 20 * 1024 * 1024;
  if (payload.length > maximum) {
    throw new AppError(
      400,
      `${kind[0]!.toUpperCase()}${kind.slice(1)} must be ${maximum / 1024 / 1024}MB or smaller`,
    );
  }
  if (!payload.length) throw new AppError(400, `${kind} is empty`);
  if (!client || !config.aws.bucket || !config.aws.region) {
    throw new AppError(500, "S3 storage is not configured");
  }
  const requestedExtension = extname(fileName ?? "").toLowerCase();
  const safeExtension = Object.values(communityMediaTypes).includes(
    requestedExtension,
  )
    ? requestedExtension
    : extension;
  const folder =
    kind === "image"
      ? "community-images"
      : kind === "audio"
        ? "community-audio"
        : "community-videos";
  const key = `${folder}/${userId}/${Date.now()}-${randomUUID()}${safeExtension}`;
  await client.send(
    new PutObjectCommand({
      Bucket: config.aws.bucket,
      Key: key,
      Body: payload,
      ContentType: mime,
      CacheControl: "public, max-age=31536000",
    }),
  );
  return {
    url: `https://${config.aws.bucket}.s3.${config.aws.region}.amazonaws.com/${key}`,
    kind,
  };
}

export async function uploadWorkoutVideo(
  ownerId: string,
  videoBase64: string,
  mimeType: string,
  fileName?: string,
  folder = "workout-videos",
): Promise<string> {
  const mime = mimeType.trim().toLowerCase();
  const extension = videoTypes[mime];
  if (!extension) {
    throw new AppError(400, "Only MP4, MOV, and WEBM videos are supported");
  }
  const payload = decodeBase64(videoBase64);
  if (!payload.length) throw new AppError(400, "Video is empty");
  if (payload.length > 25 * 1024 * 1024) {
    throw new AppError(400, "Video must be 25MB or smaller");
  }
  if (!client || !config.aws.bucket || !config.aws.region) {
    throw new AppError(500, "S3 storage is not configured");
  }
  const requestedExtension = extname(fileName ?? "").toLowerCase();
  const safeExtension = Object.values(videoTypes).includes(requestedExtension)
    ? requestedExtension
    : extension;
  const safeFolder =
    folder.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "workout-videos";
  const key = `${safeFolder}/${ownerId}/${Date.now()}-${randomUUID()}${safeExtension}`;
  await client.send(
    new PutObjectCommand({
      Bucket: config.aws.bucket,
      Key: key,
      Body: payload,
      ContentType: mime,
      CacheControl: "public, max-age=31536000",
    }),
  );
  return `https://${config.aws.bucket}.s3.${config.aws.region}.amazonaws.com/${key}`;
}

export async function uploadMasterclassAudio(
  ownerId: string,
  audioBase64: string,
  mimeType: string,
  fileName?: string,
): Promise<string> {
  const mime = mimeType.trim().toLowerCase();
  const extension = audioTypes[mime];
  if (!extension) {
    throw new AppError(
      400,
      "Only MP3, M4A, WAV, OGG, and WEBM audio files are supported",
    );
  }
  const payload = decodeBase64(audioBase64);
  if (!payload.length) throw new AppError(400, "Audio is empty");
  if (payload.length > 25 * 1024 * 1024) {
    throw new AppError(400, "Audio must be 25MB or smaller");
  }
  if (!client || !config.aws.bucket || !config.aws.region) {
    throw new AppError(500, "S3 storage is not configured");
  }
  const requestedExtension = extname(fileName ?? "").toLowerCase();
  const safeExtension = Object.values(audioTypes).includes(requestedExtension)
    ? requestedExtension
    : extension;
  const key = `masterclass-audio/${ownerId}/${Date.now()}-${randomUUID()}${safeExtension}`;
  await client.send(
    new PutObjectCommand({
      Bucket: config.aws.bucket,
      Key: key,
      Body: payload,
      ContentType: mime,
      CacheControl: "public, max-age=31536000",
    }),
  );
  return `https://${config.aws.bucket}.s3.${config.aws.region}.amazonaws.com/${key}`;
}

export async function deleteStoredMedia(url: unknown): Promise<void> {
  if (!client || !config.aws.bucket || !url) return;
  try {
    const parsed = new URL(String(url));
    const expectedHost = `${config.aws.bucket}.s3.${config.aws.region}.amazonaws.com`;
    if (parsed.hostname !== expectedHost) return;
    const key = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!key) return;
    await client.send(
      new DeleteObjectCommand({ Bucket: config.aws.bucket, Key: key }),
    );
  } catch {
    /* deleting the database record must not fail for an invalid legacy URL */
  }
}

export async function presignedUpload(
  folder: string,
  userId: string,
  mimeType: string,
  fileName?: string,
): Promise<{
  uploadUrl: string;
  fileUrl: string;
  headers: Record<string, string>;
}> {
  if (!client || !config.aws.bucket || !config.aws.region) {
    throw new AppError(
      400,
      "Direct upload is not available because S3 storage is not configured",
    );
  }
  const extension = extname(fileName ?? "").toLowerCase() || ".bin";
  const safeFolder =
    folder.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "uploads";
  const key = `${safeFolder}/${userId}/${Date.now()}-${randomUUID()}${extension}`;
  const cacheControl = "public, max-age=31536000";
  const command = new PutObjectCommand({
    Bucket: config.aws.bucket,
    Key: key,
    ContentType: mimeType,
    CacheControl: cacheControl,
  });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 900 });
  return {
    uploadUrl,
    fileUrl: `https://${config.aws.bucket}.s3.${config.aws.region}.amazonaws.com/${key}`,
    headers: { "Content-Type": mimeType, "Cache-Control": cacheControl },
  };
}
