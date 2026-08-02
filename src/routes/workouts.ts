import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { ObjectId } from "mongodb";
import { AppError } from "../lib/errors.js";
import { idFilter } from "../lib/mongo.js";
import {
  deleteStoredMedia,
  presignedUpload,
  uploadProfileImage,
  uploadWorkoutVideo,
} from "../services/storage.js";
import { config } from "../config.js";
import { notifyUser } from "../services/push.js";

const workoutRequestSchema = Type.Object({
  title: Type.String({ minLength: 2, maxLength: 160 }),
  vimeoId: Type.Optional(Type.String({ maxLength: 80 })),
  videoUrl: Type.Optional(Type.String({ maxLength: 2000 })),
  videoSource: Type.Optional(
    Type.String({ pattern: "^(VIMEO|YOUTUBE|UPLOAD)$" }),
  ),
  tag: Type.String({ minLength: 1, maxLength: 80 }),
  visibility: Type.String({ pattern: "^(Published|Draft)$" }),
  thumbnail: Type.Optional(Type.String({ maxLength: 500 })),
  video_base64: Type.Optional(
    Type.String({ minLength: 32, maxLength: 40_000_000 }),
  ),
  image_base64: Type.Optional(
    Type.String({ minLength: 32, maxLength: 20_000_000 }),
  ),
  video_mime_type: Type.Optional(Type.String({ maxLength: 120 })),
  mime_type: Type.Optional(Type.String({ maxLength: 120 })),
  video_file_name: Type.Optional(Type.String({ maxLength: 255 })),
  file_name: Type.Optional(Type.String({ maxLength: 255 })),
});
const directUploadSchema = Type.Object({
  uploadType: Type.String({ pattern: "^(WORKOUT_VIDEO|COMMUNITY_VIDEO)$" }),
  contentType: Type.String({ minLength: 1, maxLength: 120 }),
  fileName: Type.Optional(Type.String({ maxLength: 255 })),
});
const publicWorkout = (record: Record<string, any>) => ({
  id: String(record._id ?? ""),
  title: String(record.title ?? ""),
  vimeoId: String(record.vimeo_id ?? record.vimeoId ?? ""),
  videoUrl: String(record.video_url ?? record.videoUrl ?? ""),
  videoSource: String(record.video_source ?? record.videoSource ?? "VIMEO"),
  tag: String(record.tag ?? "Workout"),
  thumbnail: String(record.thumbnail ?? ""),
  dateAdded: record.created_at ?? new Date(),
});
const adminWorkout = (record: Record<string, any>) => ({
  ...publicWorkout(record),
  visibility: String(record.visibility ?? "Draft"),
  providerVisibility: String(
    record.vimeo_provider_visibility ??
      record.providerVisibility ??
      "Published",
  ),
  updatedAt: record.updated_at ?? record.created_at ?? new Date(),
});
const workoutDocument = (body: Record<string, any>) => ({
  title: String(body.title ?? ""),
  vimeo_id: String(body.vimeoId ?? body.vimeo_id ?? ""),
  video_url: String(body.videoUrl ?? body.video_url ?? ""),
  video_source: String(body.videoSource ?? body.video_source ?? "VIMEO"),
  tag: String(body.tag ?? "Workout"),
  visibility: String(body.visibility ?? "Draft"),
  thumbnail: String(body.thumbnail ?? ""),
});

const normalizeExternalVideo = (
  source: string,
  rawUrl: string,
  rawVimeoId: string,
): { videoUrl: string; vimeoId: string } => {
  const videoSource = source.trim().toUpperCase() || "VIMEO";
  const videoUrl = rawUrl.trim();
  const vimeoId = rawVimeoId.trim();
  if (videoSource === "UPLOAD") return { videoUrl, vimeoId: "" };
  if (videoSource === "YOUTUBE") {
    let id = "";
    try {
      const parsed = new URL(videoUrl);
      if (parsed.hostname === "youtu.be") {
        id = parsed.pathname.split("/")[1] ?? "";
      } else if (
        ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(
          parsed.hostname,
        )
      ) {
        id = parsed.pathname.startsWith("/embed/")
          ? (parsed.pathname.split("/embed/")[1]?.split("/")[0] ?? "")
          : parsed.pathname.startsWith("/shorts/")
            ? (parsed.pathname.split("/shorts/")[1]?.split("/")[0] ?? "")
            : (parsed.searchParams.get("v") ?? "");
      }
    } catch {
      // The validation error below is the public API contract.
    }
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
      throw new AppError(400, "Use a valid YouTube link for YouTube workouts");
    }
    return {
      videoUrl: `https://www.youtube.com/embed/${id}?playsinline=1&rel=0`,
      vimeoId: "",
    };
  }
  const id =
    vimeoId || videoUrl.match(/(?:vimeo\.com\/(?:video\/)?)(\d+)/)?.[1] || "";
  if (!/^\d+$/.test(id)) {
    throw new AppError(
      400,
      vimeoId
        ? "Vimeo video ID must be numeric"
        : "Use a valid Vimeo link for Vimeo workouts",
    );
  }
  return {
    videoUrl: `https://player.vimeo.com/video/${id}?autoplay=0&title=0&byline=0&portrait=0&playsinline=1&dnt=1`,
    vimeoId: id,
  };
};

const preparedWorkoutDocument = async (
  body: Record<string, any>,
  ownerId: string,
): Promise<Record<string, any>> => {
  const videoSource =
    String(body.videoSource ?? "VIMEO")
      .trim()
      .toUpperCase() || "VIMEO";
  const prepared = body.video_base64
    ? {
        videoUrl: await uploadWorkoutVideo(
          ownerId,
          String(body.video_base64),
          String(body.video_mime_type ?? "video/mp4"),
          body.video_file_name ? String(body.video_file_name) : undefined,
        ),
        vimeoId: "",
      }
    : normalizeExternalVideo(
        videoSource,
        String(body.videoUrl ?? ""),
        String(body.vimeoId ?? ""),
      );
  if (!prepared.videoUrl) {
    throw new AppError(400, "A workout video is required");
  }
  const thumbnail = body.image_base64
    ? await uploadProfileImage(
        ownerId,
        String(body.image_base64),
        String(body.mime_type ?? "image/jpeg"),
        body.file_name ? String(body.file_name) : undefined,
        "workout-thumbnails",
      )
    : String(body.thumbnail ?? "").trim();
  return {
    ...workoutDocument(body),
    video_url: prepared.videoUrl,
    video_source: videoSource,
    vimeo_id: prepared.vimeoId,
    thumbnail,
  };
};

export default async function workoutRoutes(
  app: FastifyInstance,
): Promise<void> {
  const notifyPublishedWorkout = async (workout: Record<string, any>) => {
    const recipients = await app.mongo
      .collection("users")
      .find({ is_admin: { $ne: true } })
      .toArray();
    await Promise.allSettled(
      recipients.map((recipient) =>
        notifyUser(
          app,
          recipient,
          "New workout available",
          `${String(workout.title ?? "A new workout")} is now available in Victory Fitness.`,
          "workout_published",
          {
            type: "workout",
            workoutId: String(workout._id ?? ""),
            route: "/workout",
          },
        ),
      ),
    );
  };

  app.get("/workouts/library", async (request) => {
    const query = request.query as Record<string, unknown>;
    const filter: Record<string, unknown> = {
      visibility: { $in: ["Published", "PUBLISHED", "published"] },
    };
    if (query.query) {
      const escaped = String(query.query).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      filter.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { tag: { $regex: escaped, $options: "i" } },
      ];
    }
    const records = await app.mongo
      .collection("workouts")
      .find(filter)
      .sort({ created_at: -1, _id: -1 })
      .toArray();
    const workouts = records.map(publicWorkout);
    const categories = new Map<string, any>();
    for (const workout of workouts) {
      const name = workout.tag.trim() || "Workout";
      const category = categories.get(name) ?? {
        id: name.toLowerCase().replace(/ /g, "-"),
        name,
        count: 0,
        image: workout.thumbnail,
      };
      category.count += 1;
      categories.set(name, category);
    }
    return {
      featuredWorkout: workouts[0] ?? null,
      workouts,
      categories: [...categories.values()].sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name),
      ),
    };
  });

  app.get("/admin/workouts", async (request) => {
    await app.requireAdmin(request);
    const query = request.query as Record<string, unknown>;
    const filter: Record<string, unknown> = {};
    if (query.visibility) filter.visibility = String(query.visibility);
    if (query.tag) filter.tag = String(query.tag);
    if (query.query) {
      filter.title = { $regex: String(query.query), $options: "i" };
    }
    const records = await app.mongo
      .collection("workouts")
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();
    return { total: records.length, workouts: records.map(adminWorkout) };
  });

  app.post(
    "/admin/workouts",
    { schema: { body: workoutRequestSchema } },
    async (request, reply) => {
      const admin = await app.requireAdmin(request);
      const now = new Date();
      const body = request.body as Record<string, any>;
      const document: Record<string, any> = {
        ...(await preparedWorkoutDocument(
          body,
          `workout-${String(admin._id)}`,
        )),
        created_at: now,
        updated_at: now,
        created_by: String(admin._id),
      };
      const duplicate = await app.mongo.collection("workouts").findOne({
        $or: [
          { video_url: document.video_url },
          ...(document.vimeo_id ? [{ vimeo_id: document.vimeo_id }] : []),
        ],
      });
      if (duplicate) {
        await Promise.all([
          deleteStoredMedia(document.video_url),
          deleteStoredMedia(document.thumbnail),
        ]);
        throw new AppError(409, "A workout with this video already exists");
      }
      const result = await app.mongo.collection("workouts").insertOne(document);
      return reply
        .code(201)
        .send(adminWorkout({ ...document, _id: result.insertedId }));
    },
  );

  app.patch(
    "/admin/workouts/:workoutId",
    { schema: { body: workoutRequestSchema } },
    async (request) => {
      const admin = await app.requireAdmin(request);
      const workoutId = (request.params as { workoutId: string }).workoutId;
      const existing = await app.mongo
        .collection("workouts")
        .findOne(idFilter(workoutId));
      if (!existing) throw new AppError(404, "Workout not found");
      const document = await preparedWorkoutDocument(
        request.body as Record<string, any>,
        `workout-${workoutId}`,
      );
      const duplicate = await app.mongo.collection("workouts").findOne({
        _id: { $ne: existing._id },
        $or: [
          { video_url: document.video_url },
          ...(document.vimeo_id ? [{ vimeo_id: document.vimeo_id }] : []),
        ],
      });
      if (duplicate) {
        if (document.video_url !== existing.video_url) {
          await deleteStoredMedia(document.video_url);
        }
        if (document.thumbnail !== existing.thumbnail) {
          await deleteStoredMedia(document.thumbnail);
        }
        throw new AppError(409, "A workout with this video already exists");
      }
      const result = await app.mongo.collection("workouts").findOneAndUpdate(
        idFilter(workoutId),
        {
          $set: {
            ...document,
            updated_at: new Date(),
            updated_by: String(admin._id),
          },
        },
        { returnDocument: "after" },
      );
      if (!result) throw new AppError(404, "Workout not found");
      await Promise.all([
        existing.video_url !== result.video_url
          ? deleteStoredMedia(existing.video_url)
          : Promise.resolve(),
        existing.thumbnail !== result.thumbnail
          ? deleteStoredMedia(existing.thumbnail)
          : Promise.resolve(),
      ]);
      if (
        String(existing.visibility ?? "Draft") !== "Published" &&
        String(result.visibility ?? "") === "Published"
      ) {
        void notifyPublishedWorkout(result).catch((error) =>
          request.log.warn(
            { err: error, workoutId },
            "workout publication notification failed",
          ),
        );
      }
      return adminWorkout(result);
    },
  );

  app.delete("/admin/workouts/:workoutId", async (request) => {
    await app.requireAdmin(request);
    const collection = app.mongo.collection("workouts");
    const workoutId = (request.params as { workoutId: string }).workoutId;
    if (!ObjectId.isValid(workoutId)) {
      throw new AppError(400, "Invalid workout id");
    }
    const filter = idFilter(workoutId);
    const existing = await collection.findOne(filter);
    const result = await collection.deleteOne(filter);
    if (!result.deletedCount) throw new AppError(404, "Workout not found");
    await Promise.all([
      deleteStoredMedia(existing?.video_url),
      deleteStoredMedia(existing?.thumbnail),
    ]);
    return { status: "success", message: "Workout deleted" };
  });

  app.post("/admin/workouts/sync", async (request) => {
    await app.requireAdmin(request);
    if (!config.vimeoAccessToken) {
      throw new AppError(503, "Vimeo is not configured");
    }
    const collection = async (path: string) => {
      const items: Array<Record<string, any>> = [];
      let nextUrl = new URL(path, "https://api.vimeo.com");
      nextUrl.searchParams.set("per_page", "100");
      while (nextUrl) {
        const response = await fetch(nextUrl, {
          headers: {
            authorization: `Bearer ${config.vimeoAccessToken}`,
            accept: "application/vnd.vimeo.*+json;version=3.4",
            "user-agent": "VictoryFitnessBackend/1.0",
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          throw new AppError(
            502,
            `Vimeo sync failed with status ${response.status}`,
          );
        }
        const payload = (await response.json()) as {
          data?: Array<Record<string, any>>;
          paging?: { next?: string | null };
        };
        items.push(...(payload.data ?? []));
        if (!payload.paging?.next) break;
        nextUrl = new URL(payload.paging.next, "https://api.vimeo.com");
      }
      return items;
    };
    const containers: Array<{
      sourceType: string;
      uri: string;
      name: string;
    }> = [];
    for (const [sourceType, path] of [
      ["PROJECT", "/me/projects"],
      ["SHOWCASE", "/me/albums"],
    ] as const) {
      for (const container of await collection(path)) {
        const uri = String(container.uri ?? "").trim();
        if (!uri) continue;
        containers.push({
          sourceType,
          uri,
          name:
            String(container.name ?? "")
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 80) ||
            (sourceType === "PROJECT" ? "Project" : "Showcase"),
        });
      }
    }
    const discovered = new Map<
      string,
      {
        video: Record<string, any>;
        sourceType: string;
        sourceUri: string;
        moduleName: string;
      }
    >();
    const discover = (
      videos: Array<Record<string, any>>,
      sourceType: string,
      sourceUri: string,
      moduleName: string,
    ) => {
      for (const video of videos) {
        const candidates = [
          String(video.uri ?? ""),
          String(video.link ?? ""),
          String(video.embed?.html ?? ""),
        ];
        const vimeoId = candidates
          .map(
            (candidate) =>
              candidate.match(/\/videos?\/(\d+)/)?.[1] ??
              candidate.match(/player\.vimeo\.com\/video\/(\d+)/)?.[1] ??
              candidate.match(/vimeo\.com\/(\d+)/)?.[1] ??
              "",
          )
          .find(Boolean);
        if (vimeoId && !discovered.has(vimeoId)) {
          discovered.set(vimeoId, {
            video,
            sourceType,
            sourceUri,
            moduleName,
          });
        }
      }
    };
    for (const container of containers) {
      discover(
        await collection(`${container.uri}/videos`),
        container.sourceType,
        container.uri,
        container.name,
      );
    }
    discover(await collection("/me/videos"), "VIDEO", "/me/videos", "Vimeo");

    let syncedCount = 0;
    const syncedVideos: Array<Record<string, unknown>> = [];
    const workouts = app.mongo.collection("workouts");
    const existingRecords = discovered.size
      ? await workouts
          .find({ vimeo_id: { $in: [...discovered.keys()] } })
          .toArray()
      : [];
    const existingById = new Map(
      existingRecords.map((record) => [String(record.vimeo_id), record]),
    );
    const now = new Date();
    for (const [vimeoId, item] of discovered) {
      const { video, sourceType, sourceUri, moduleName } = item;
      const existing = existingById.get(vimeoId);
      const providerVisibility =
        video.status && String(video.status).toLowerCase() !== "available"
          ? "Draft"
          : ["disable", "nobody", "password"].includes(
                String(video.privacy?.view ?? "").toLowerCase(),
              )
            ? "Draft"
            : "Published";
      const visibility = ["Published", "Draft"].includes(
        String(existing?.visibility ?? ""),
      )
        ? String(existing!.visibility)
        : "Draft";
      const pictures = Array.isArray(video.pictures?.sizes)
        ? video.pictures.sizes
        : [];
      const thumbnail = [...pictures]
        .reverse()
        .map((picture: any) =>
          String(picture?.link ?? picture?.link_with_play_button ?? ""),
        )
        .find(Boolean);
      const title =
        String(video.name ?? "")
          .trim()
          .slice(0, 160) || `${moduleName} Workout`;
      await workouts.updateOne(
        { vimeo_id: vimeoId },
        {
          $set: {
            title,
            description: String(video.description ?? "").trim(),
            video_url: `https://player.vimeo.com/video/${vimeoId}?autoplay=0&title=0&byline=0&portrait=0&playsinline=1&dnt=1`,
            video_source: "VIMEO",
            thumbnail: thumbnail ?? "",
            vimeo_id: vimeoId,
            vimeo_provider_visibility: providerVisibility,
            vimeo_source_type: sourceType,
            vimeo_source_uri: sourceUri,
            vimeo_video_uri: String(video.uri ?? "").trim(),
            vimeo_synced_at: now,
            visibility,
            tag: moduleName,
            updated_at: now,
          },
          $setOnInsert: { created_at: now },
        },
        { upsert: true },
      );
      syncedCount += 1;
      syncedVideos.push({
        title,
        vimeoId,
        tag: moduleName,
        visibility,
        providerVisibility,
        alreadyInLibrary: Boolean(existing),
      });
    }
    return {
      status: "success",
      message: "Vimeo workout library synced successfully.",
      syncedCount,
      modulesSynced: containers.length,
      videosDiscovered: discovered.size,
      syncedVideos,
    };
  });

  app.get("/admin/workouts/sync/debug", async (request) => {
    await app.requireAdmin(request);
    const limit = Math.min(
      Math.max(
        Number((request.query as Record<string, unknown>).limit ?? 50),
        1,
      ),
      200,
    );
    const records = await app.mongo
      .collection("workouts")
      .find({ video_source: "VIMEO", vimeo_id: { $exists: true, $ne: "" } })
      .sort({ vimeo_synced_at: -1, updated_at: -1, _id: -1 })
      .limit(limit)
      .toArray();
    return {
      total: records.length,
      workouts: records.map((record) => ({
        id: String(record._id),
        title: String(record.title ?? ""),
        vimeoId: String(record.vimeo_id ?? ""),
        tag: String(record.tag ?? ""),
        visibility: String(record.visibility ?? "Draft"),
        providerVisibility: String(record.vimeo_provider_visibility ?? "Draft"),
        videoSource: String(record.video_source ?? "VIMEO"),
        vimeoSourceType: String(record.vimeo_source_type ?? ""),
        vimeoSourceUri: String(record.vimeo_source_uri ?? ""),
        vimeoSyncedAt: record.vimeo_synced_at ?? null,
        updatedAt: record.updated_at ?? null,
      })),
    };
  });

  for (const [path, admin] of [
    ["/admin/uploads/presign", true],
    ["/uploads/presign", false],
  ] as const) {
    app.post(
      path,
      { schema: { body: directUploadSchema } },
      async (request) => {
        const user = admin
          ? await app.requireAdmin(request)
          : await app.authenticate(request);
        const body = request.body as Record<string, unknown>;
        const uploadType = String(body.uploadType).toUpperCase();
        if (!admin && uploadType !== "COMMUNITY_VIDEO") {
          throw new AppError(403, "Only community video uploads are allowed");
        }
        const contentType = String(body.contentType).trim().toLowerCase();
        if (
          !["video/mp4", "video/quicktime", "video/webm"].includes(contentType)
        ) {
          throw new AppError(
            400,
            "Only MP4, MOV, and WEBM videos are supported",
          );
        }
        const folder =
          uploadType === "WORKOUT_VIDEO"
            ? "workout-videos"
            : "community-videos";
        return presignedUpload(
          folder,
          String(user._id),
          contentType,
          body.fileName ? String(body.fileName) : undefined,
        );
      },
    );
  }
}
