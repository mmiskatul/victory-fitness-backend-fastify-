import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { ObjectId } from "mongodb";
import { AppError } from "../lib/errors.js";
import { idFilter, paginated, requiredDocument } from "../lib/mongo.js";
import { serialize } from "../lib/serialize.js";
import {
  deleteStoredMedia,
  uploadCommunityMedia,
} from "../services/storage.js";

const flexible = Type.Object({}, { additionalProperties: true });
const adminPostBody = Type.Object(
  {
    content: Type.String({ minLength: 1, maxLength: 5_000 }),
    audience: Type.Optional(Type.String()),
    image_base64: Type.Optional(
      Type.String({ minLength: 32, maxLength: 20_000_000 }),
    ),
    video_base64: Type.Optional(
      Type.String({ minLength: 32, maxLength: 40_000_000 }),
    ),
    audio_base64: Type.Optional(
      Type.String({ minLength: 32, maxLength: 20_000_000 }),
    ),
    external_video_url: Type.Optional(Type.String({ maxLength: 2_000 })),
    mime_type: Type.Optional(Type.String({ maxLength: 120 })),
    file_name: Type.Optional(Type.String({ maxLength: 255 })),
  },
  { additionalProperties: false },
);
const adminPostUpdateBody = Type.Object({
  content: Type.Optional(Type.String()),
  audience: Type.Optional(Type.String()),
  image_base64: Type.Optional(Type.String()),
  video_base64: Type.Optional(Type.String()),
  audio_base64: Type.Optional(Type.String()),
  external_video_url: Type.Optional(Type.String()),
  mime_type: Type.Optional(Type.String()),
  file_name: Type.Optional(Type.String()),
  clear_image: Type.Optional(Type.Boolean()),
  clear_media: Type.Optional(Type.Boolean()),
  flagged: Type.Optional(Type.Boolean()),
  flag_reason: Type.Optional(Type.String()),
  moderation_status: Type.Optional(Type.String()),
  moderator_notes: Type.Optional(Type.String()),
});

const communityComment = (
  record: Record<string, any>,
  author?: Record<string, any>,
) => ({
  id: String(record._id ?? record.id),
  post_id: String(record.post_id ?? ""),
  author_name: String(author?.name ?? record.author_name ?? "Member"),
  author_role: String(
    author?.role ??
      (author?.is_admin ? "admin" : undefined) ??
      record.author_role ??
      "user",
  ),
  author_profile_image: String(
    author?.profile_image ??
      record.author_profile_image ??
      record.author_image ??
      "",
  ),
  content: String(record.content ?? ""),
  created_at: record.created_at,
});

const communityPost = (
  record: Record<string, any>,
  viewer?: Record<string, any>,
  author?: Record<string, any>,
  comments: Array<Record<string, unknown>> = [],
  viewerHasLiked = false,
  reactions: Array<Record<string, unknown>> = [],
) => ({
  id: String(record._id),
  author_id: String(record.author_id ?? ""),
  author_name: String(author?.name ?? record.author_name ?? "Member"),
  author_role: String(
    author?.role ??
      (author?.is_admin ? "admin" : undefined) ??
      record.author_role ??
      "user",
  ),
  author_profile_image: String(
    author?.profile_image ??
      record.author_profile_image ??
      record.author_image ??
      "",
  ),
  audience: String(record.audience ?? "ALL"),
  content: String(record.content ?? ""),
  image_url: String(record.image_url ?? ""),
  video_url: String(record.video_url ?? ""),
  audio_url: String(record.audio_url ?? ""),
  like_count: Number(record.like_count ?? record.reaction_count ?? 0),
  comment_count: Number(record.comment_count ?? 0),
  viewer_has_liked: viewerHasLiked,
  can_delete:
    Boolean(viewer) &&
    (Boolean(viewer?.is_admin) ||
      String(viewer?._id) === String(record.author_id)),
  comments,
  reactions,
  created_at: record.created_at,
  updated_at: record.updated_at ?? record.created_at,
  flagged: Boolean(record.flagged),
  flag_reason: String(record.flag_reason ?? ""),
  moderation_status: String(
    record.moderation_status ?? (record.flagged ? "reviewing" : "published"),
  ),
  moderator_notes: String(record.moderator_notes ?? ""),
});

async function serializeCommunityPosts(
  app: FastifyInstance,
  records: Array<Record<string, any>>,
  viewer?: Record<string, any>,
  options: { commentLimit?: number; includeReactions?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  if (!records.length) return [];
  const commentLimit = options.commentLimit ?? 3;
  const authorIds = [
    ...new Set(records.map((item) => String(item.author_id ?? ""))),
  ]
    .filter(ObjectId.isValid)
    .map((id) => new ObjectId(id));
  const postIds = records.map((item) => String(item._id ?? item.id));
  const [authors, comments, viewerReactions, allReactions] = await Promise.all([
    authorIds.length
      ? app.mongo
          .collection("users")
          .find({ _id: { $in: authorIds } })
          .toArray()
      : [],
    app.mongo
      .collection("community_comments")
      .find({ post_id: { $in: postIds } })
      .sort({ created_at: 1 })
      .toArray(),
    viewer
      ? app.mongo
          .collection("community_reactions")
          .find({ post_id: { $in: postIds }, user_id: String(viewer._id) })
          .toArray()
      : [],
    options.includeReactions
      ? app.mongo
          .collection("community_reactions")
          .find({ post_id: { $in: postIds } })
          .sort({ created_at: -1, _id: -1 })
          .limit(5_000)
          .toArray()
      : [],
  ]);
  const relatedAuthorIds = [...comments, ...allReactions]
    .map((item) => String(item.author_id ?? item.user_id ?? ""))
    .filter(ObjectId.isValid)
    .map((id) => new ObjectId(id));
  const relatedAuthors = relatedAuthorIds.length
    ? await app.mongo
        .collection("users")
        .find({ _id: { $in: relatedAuthorIds } })
        .toArray()
    : [];
  const users = new Map(
    [...authors, ...relatedAuthors].map((item) => [String(item._id), item]),
  );
  const liked = new Set(viewerReactions.map((item) => String(item.post_id)));
  return records.map((record) => {
    const postComments = comments
      .filter(
        (item) => String(item.post_id) === String(record._id ?? record.id),
      )
      .slice(
        commentLimit > 0 ? -commentLimit : 0,
        commentLimit > 0 ? undefined : 0,
      )
      .map((item) => communityComment(item, users.get(String(item.author_id))));
    const postReactions = allReactions
      .filter(
        (item) => String(item.post_id) === String(record._id ?? record.id),
      )
      .map((item) => {
        const user = users.get(String(item.user_id));
        return {
          user_id: String(item.user_id ?? ""),
          user_name: String(user?.name ?? "Member"),
          user_role: String(user?.role ?? (user?.is_admin ? "admin" : "user")),
          user_profile_image: String(user?.profile_image ?? ""),
          created_at: item.created_at ?? new Date(),
        };
      });
    return communityPost(
      record,
      viewer,
      users.get(String(record.author_id)),
      postComments,
      liked.has(String(record._id ?? record.id)),
      postReactions,
    );
  });
}

async function requestPostBody(
  request: FastifyRequest,
  userId: string,
): Promise<Record<string, unknown>> {
  if (!request.isMultipart()) {
    const body = { ...(request.body as Record<string, any>) };
    const encoded = String(
      body.image_base64 ?? body.video_base64 ?? body.audio_base64 ?? "",
    );
    if (encoded) {
      const payload = Buffer.from(
        encoded.includes(",")
          ? encoded.slice(encoded.indexOf(",") + 1)
          : encoded,
        "base64",
      );
      const uploaded = await uploadCommunityMedia(
        userId,
        payload,
        String(
          body.mime_type ??
            (body.video_base64
              ? "video/mp4"
              : body.audio_base64
                ? "audio/mpeg"
                : "image/jpeg"),
        ),
        body.file_name ? String(body.file_name) : undefined,
      );
      body[`${uploaded.kind}_url`] = uploaded.url;
    } else if (body.external_video_url) {
      body.video_url = String(body.external_video_url);
    }
    return body;
  }
  const result: Record<string, unknown> = {};
  for await (const part of request.parts()) {
    if (part.type === "file") {
      const bytes = await part.toBuffer();
      const uploaded = await uploadCommunityMedia(
        userId,
        bytes,
        part.mimetype,
        part.filename,
      );
      result[`${uploaded.kind}_url`] = uploaded.url;
    } else {
      result[part.fieldname] = part.value;
    }
  }
  return result;
}

export default async function communityRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/community/posts", async (request) => {
    const viewer = await app.requireFeature(
      request,
      "community",
      "Your current plan does not include community access",
    );
    const query = request.query as Record<string, unknown>;
    const filter: Record<string, unknown> = { deleted_at: { $exists: false } };
    if (query.audience) filter.audience = String(query.audience);
    if (query.author_id) filter.author_id = String(query.author_id);
    const result = await paginated(
      app.mongo.collection("community_posts"),
      filter,
      query,
    );
    return {
      posts: await serializeCommunityPosts(
        app,
        result.items as Array<Record<string, any>>,
        viewer,
      ),
      page: result.page,
      limit: result.pageSize,
      total: result.total,
      has_more: result.page * result.pageSize < result.total,
    };
  });

  app.post("/community/posts", async (request, reply) => {
    const user = await app.requireFeature(
      request,
      "community",
      "Your current plan does not include community access",
    );
    const body = await requestPostBody(request, String(user._id));
    const content = String(body.content ?? body.text ?? "").trim();
    if (!content && !body.image_url && !body.video_url && !body.audio_url) {
      throw new AppError(400, "Post content or media is required");
    }
    const now = new Date();
    const document = {
      author_id: String(user._id),
      author_name: String(user.name ?? ""),
      author_image: String(user.profile_image ?? ""),
      content,
      image_url: String(body.image_url ?? body.imageUrl ?? ""),
      video_url: String(body.video_url ?? body.videoUrl ?? ""),
      audio_url: String(body.audio_url ?? body.audioUrl ?? ""),
      audience: String(body.audience ?? "community"),
      post_type: String(body.post_type ?? body.type ?? "post"),
      like_count: 0,
      comment_count: 0,
      flagged: false,
      created_at: now,
      updated_at: now,
    };
    const result = await app.mongo
      .collection("community_posts")
      .insertOne(document);
    return reply
      .code(201)
      .send(communityPost({ ...document, _id: result.insertedId }, user, user));
  });

  app.delete("/community/posts/:postId", async (request, reply) => {
    const user = await app.requireFeature(
      request,
      "community",
      "Your current plan does not include community access",
    );
    const post = await requiredDocument(
      app.mongo.collection("community_posts"),
      (request.params as { postId: string }).postId,
      "Post",
    );
    if (String(post.author_id) !== String(user._id) && !user.is_admin) {
      throw new AppError(403, "You cannot delete this post");
    }
    await app.mongo.collection("community_posts").deleteOne({ _id: post._id });
    await Promise.all([
      app.mongo
        .collection("community_comments")
        .deleteMany({ post_id: String(post._id) }),
      app.mongo
        .collection("community_reactions")
        .deleteMany({ post_id: String(post._id) }),
      deleteStoredMedia(post.image_url),
      deleteStoredMedia(post.video_url),
      deleteStoredMedia(post.audio_url),
    ]);
    return reply.code(204).send();
  });

  app.get("/community/posts/:postId/comments", async (request) => {
    await app.requireFeature(
      request,
      "community",
      "Your current plan does not include community access",
    );
    const postId = (request.params as { postId: string }).postId;
    const items = await app.mongo
      .collection("community_comments")
      .find({ post_id: postId })
      .sort({ created_at: 1 })
      .toArray();
    const authorIds = items
      .map((item) => String(item.author_id ?? ""))
      .filter(ObjectId.isValid)
      .map((id) => new ObjectId(id));
    const authors = authorIds.length
      ? await app.mongo
          .collection("users")
          .find({ _id: { $in: authorIds } })
          .toArray()
      : [];
    const byId = new Map(authors.map((item) => [String(item._id), item]));
    return items.map((item) =>
      communityComment(item, byId.get(String(item.author_id))),
    );
  });

  app.post(
    "/community/posts/:postId/comments",
    { schema: { body: Type.Object({ content: Type.String() }) } },
    async (request, reply) => {
      const user = await app.requireFeature(
        request,
        "community",
        "Your current plan does not include community access",
      );
      const postId = (request.params as { postId: string }).postId;
      await requiredDocument(
        app.mongo.collection("community_posts"),
        postId,
        "Post",
      );
      const content = String(
        (request.body as Record<string, unknown>).content ?? "",
      ).trim();
      if (!content) throw new AppError(400, "Comment is required");
      const document = {
        post_id: postId,
        author_id: String(user._id),
        author_name: String(user.name ?? ""),
        author_image: String(user.profile_image ?? ""),
        content,
        created_at: new Date(),
        updated_at: new Date(),
      };
      const result = await app.mongo
        .collection("community_comments")
        .insertOne(document);
      await app.mongo
        .collection("community_posts")
        .updateOne(idFilter(postId), { $inc: { comment_count: 1 } });
      return reply
        .code(201)
        .send(communityComment({ ...document, _id: result.insertedId }, user));
    },
  );

  app.post("/community/posts/:postId/reactions/toggle", async (request) => {
    const user = await app.requireFeature(
      request,
      "community",
      "Your current plan does not include community access",
    );
    const postId = (request.params as { postId: string }).postId;
    const reactions = app.mongo.collection("community_reactions");
    const current = await reactions.findOne({
      post_id: postId,
      user_id: String(user._id),
    });
    let active = true;
    if (current) {
      await reactions.deleteOne({ _id: current._id });
      active = false;
    } else {
      await reactions.insertOne({
        post_id: postId,
        user_id: String(user._id),
        created_at: new Date(),
      });
    }
    const total = await reactions.countDocuments({ post_id: postId });
    await app.mongo.collection("community_posts").updateOne(idFilter(postId), {
      $set: { like_count: total, updated_at: new Date() },
    });
    return {
      post_id: postId,
      like_count: total,
      viewer_has_liked: active,
    };
  });

  for (const path of [
    "/admin/community/posts",
    "/admin/community/feed",
  ] as const) {
    app.get(path, async (request) => {
      await app.requireAdmin(request);
      const query = request.query as Record<string, unknown>;
      const search = String(query.search ?? "").trim();
      const filter = search
        ? {
            $or: [
              { content: { $regex: search, $options: "i" } },
              { author_name: { $regex: search, $options: "i" } },
            ],
          }
        : {};
      const result = await paginated(
        app.mongo.collection("community_posts"),
        filter,
        query,
        { created_at: -1, _id: -1 },
      );
      return {
        posts: await serializeCommunityPosts(
          app,
          result.items as Array<Record<string, any>>,
          undefined,
          { commentLimit: 200, includeReactions: true },
        ),
        page: result.page,
        limit: result.pageSize,
        total: result.total,
        has_more: result.page * result.pageSize < result.total,
      };
    });
  }

  const createAdminPost = async (
    request: FastifyRequest,
    broadcast: boolean,
  ) => {
    const admin = await app.requireAdmin(request);
    const body = await requestPostBody(request, String(admin._id));
    const now = new Date();
    const document = {
      ...(body as object),
      author_id: String(admin._id),
      author_name: String(admin.name ?? ""),
      author_image: String(admin.profile_image ?? ""),
      content: String(body.content ?? "").trim(),
      audience: String(body.audience ?? (broadcast ? "all" : "community")),
      broadcast,
      reactions: {},
      like_count: 0,
      comment_count: 0,
      flagged: false,
      created_at: now,
      updated_at: now,
    };
    const result = await app.mongo
      .collection("community_posts")
      .insertOne(document);
    if (broadcast) {
      const notification = {
        id: new ObjectId().toHexString(),
        title: String(body.title ?? "New community update"),
        message: String(body.content ?? ""),
        type: "community_broadcast",
        read: false,
        created_at: now,
        data: { post_id: result.insertedId.toHexString(), route: "/community" },
      };
      await app.mongo.collection("users").updateMany({ is_verified: true }, {
        $push: { app_notifications: notification },
      } as any);
    }
    return communityPost({ ...document, _id: result.insertedId }, admin, admin);
  };

  app.post(
    "/admin/community/posts",
    { schema: { body: adminPostBody } },
    async (request, reply) =>
      reply.code(201).send(await createAdminPost(request, false)),
  );
  app.post(
    "/admin/community/broadcast",
    { schema: { body: adminPostBody } },
    async (request, reply) =>
      reply.code(201).send(await createAdminPost(request, true)),
  );

  app.patch(
    "/admin/community/posts/:postId",
    { schema: { body: adminPostUpdateBody } },
    async (request) => {
      const admin = await app.requireAdmin(request);
      const id = (request.params as { postId: string }).postId;
      const existing = await requiredDocument(
        app.mongo.collection("community_posts"),
        id,
        "Post",
      );
      const body = await requestPostBody(
        request,
        String(existing.author_id ?? admin._id),
      );
      const update: Record<string, unknown> = { updated_at: new Date() };
      for (const field of [
        "content",
        "audience",
        "flagged",
        "moderation_status",
        "moderator_notes",
      ]) {
        if (body[field] !== undefined) update[field] = body[field];
      }
      if (body.flag_reason !== undefined || body.flagged !== undefined) {
        update.flag_reason = String(body.flag_reason ?? "").trim();
      }
      const clear = Boolean(body.clear_image || body.clear_media);
      if (clear) {
        update.image_url = "";
        update.video_url = "";
        update.audio_url = "";
      } else if (body.image_url) {
        update.image_url = body.image_url;
        update.video_url = "";
        update.audio_url = "";
      } else if (body.video_url !== undefined) {
        update.video_url = body.video_url;
        if (body.video_url) update.image_url = "";
      } else if (body.audio_url) {
        update.audio_url = body.audio_url;
        update.image_url = "";
        update.video_url = "";
      }
      const result = await app.mongo
        .collection("community_posts")
        .findOneAndUpdate(
          idFilter(id),
          { $set: update },
          { returnDocument: "after" },
        );
      if (!result) throw new AppError(404, "Post not found");
      await Promise.all([
        (clear || body.image_url) && existing.image_url !== result.image_url
          ? deleteStoredMedia(existing.image_url)
          : undefined,
        (clear || body.video_url !== undefined) &&
        existing.video_url !== result.video_url
          ? deleteStoredMedia(existing.video_url)
          : undefined,
        (clear || body.audio_url) && existing.audio_url !== result.audio_url
          ? deleteStoredMedia(existing.audio_url)
          : undefined,
      ]);
      const [serialized] = await serializeCommunityPosts(
        app,
        [result],
        undefined,
        { commentLimit: 200, includeReactions: true },
      );
      return serialized;
    },
  );

  app.delete("/admin/community/posts/:postId", async (request, reply) => {
    await app.requireAdmin(request);
    const id = (request.params as { postId: string }).postId;
    const post = await requiredDocument(
      app.mongo.collection("community_posts"),
      id,
      "Post",
    );
    const result = await app.mongo
      .collection("community_posts")
      .deleteOne(idFilter(id));
    if (!result.deletedCount) throw new AppError(404, "Post not found");
    await Promise.all([
      app.mongo.collection("community_comments").deleteMany({ post_id: id }),
      app.mongo.collection("community_reactions").deleteMany({ post_id: id }),
      deleteStoredMedia(post.image_url),
      deleteStoredMedia(post.video_url),
      deleteStoredMedia(post.audio_url),
    ]);
    return reply.code(204).send();
  });

  app.get("/admin/community/top-contributors", async (request) => {
    await app.requireAdmin(request);
    const records = await app.mongo
      .collection("community_posts")
      .find({})
      .sort({ created_at: -1 })
      .limit(500)
      .toArray();
    const posts = await serializeCommunityPosts(app, records, undefined, {
      commentLimit: 0,
    });
    const byAuthor = new Map<string, Record<string, any>>();
    for (const post of posts) {
      const authorId = String(post.author_id ?? "");
      if (!authorId) continue;
      const item = byAuthor.get(authorId) ?? {
        userId: authorId,
        name: String(post.author_name ?? "Community member"),
        profileImage: String(post.author_profile_image ?? ""),
        postCount: 0,
        likeCount: 0,
      };
      item.postCount += 1;
      item.likeCount += Math.max(Number(post.like_count ?? 0), 0);
      byAuthor.set(authorId, item);
    }
    return {
      contributors: [...byAuthor.values()]
        .sort(
          (left, right) =>
            right.likeCount - left.likeCount ||
            right.postCount - left.postCount,
        )
        .slice(0, 10),
    };
  });
  app.get("/admin/community/trending", async (request) => {
    await app.requireAdmin(request);
    const records = await app.mongo
      .collection("community_posts")
      .find({}, { projection: { content: 1 } })
      .limit(500)
      .toArray();
    const counts = new Map<string, number>();
    for (const record of records) {
      for (const match of String(record.content ?? "")
        .toLowerCase()
        .matchAll(/#[a-z0-9_]+/g)) {
        counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
      }
    }
    return {
      hashtags: [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 20)
        .map(([tag, postCount]) => ({ tag, postCount })),
    };
  });
  app.get("/admin/community/flags", async (request) => {
    await app.requireAdmin(request);
    const records = await app.mongo
      .collection("community_posts")
      .find({ flagged: true })
      .sort({ updated_at: -1 })
      .limit(200)
      .toArray();
    const posts = await serializeCommunityPosts(app, records, undefined, {
      commentLimit: 0,
    });
    return { total: posts.length, posts };
  });
  app.get("/admin/community/shortcuts", async (request) => {
    await app.requireAdmin(request);
    const flaggedCount = await app.mongo
      .collection("community_posts")
      .countDocuments({ flagged: true });
    return {
      items: [
        {
          key: "flagged_posts",
          label: "Review Flagged Posts",
          route: "/community",
          count: flaggedCount,
        },
        {
          key: "pinned_announcements",
          label: "Pinned Announcements",
          route: "/community/announcements",
        },
        {
          key: "community_guidelines",
          label: "Community Guidelines",
          route: "/community/guidelines",
        },
      ],
    };
  });
}
