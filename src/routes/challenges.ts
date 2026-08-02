import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { ObjectId } from "mongodb";
import { AppError } from "../lib/errors.js";
import { idFilter, paginated, requiredDocument } from "../lib/mongo.js";
import { serialize } from "../lib/serialize.js";
import { buildReportPng } from "../services/report-image.js";
import { deleteStoredMedia, uploadProfileImage } from "../services/storage.js";
import { notifyUser } from "../services/push.js";
import { generateText } from "../services/llm.js";

const messageCreateSchema = Type.Object({
  content: Type.Optional(Type.String()),
  image_base64: Type.Optional(Type.String()),
  mime_type: Type.Optional(Type.String()),
  file_name: Type.Optional(Type.String()),
  reply_to_message_id: Type.Optional(Type.String()),
});
const completionSchema = Type.Object({
  completed: Type.Optional(Type.Boolean()),
});
const challengeExerciseSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  details: Type.String(),
  notes: Type.Optional(Type.String()),
  workout_id: Type.Optional(Type.String()),
  workout_title: Type.Optional(Type.String()),
  workout_vimeo_id: Type.Optional(Type.String()),
  workout_video_url: Type.Optional(Type.String()),
  workout_video_source: Type.Optional(Type.String()),
  workout_thumbnail: Type.Optional(Type.String()),
});
const challengeSectionSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  estimated_minutes: Type.Optional(Type.Integer()),
  exercises: Type.Optional(Type.Array(challengeExerciseSchema)),
});
const challengeDaySchema = Type.Object({
  day_number: Type.Integer(),
  title: Type.String(),
  focus: Type.String(),
  notes: Type.Optional(Type.String()),
  sections: Type.Optional(Type.Array(challengeSectionSchema)),
});
const adminChallengeSchema = Type.Object({
  title: Type.String(),
  description: Type.String(),
  whyItMatters: Type.Optional(Type.String()),
  planText: Type.Optional(Type.String()),
  planDays: Type.Optional(Type.Array(challengeDaySchema)),
  category: Type.String(),
  durationDays: Type.Integer(),
  points: Type.Integer(),
  difficulty: Type.String(),
  status: Type.String(),
  thumbnail: Type.Optional(Type.String()),
  image_base64: Type.Optional(Type.String()),
  mime_type: Type.Optional(Type.String()),
  file_name: Type.Optional(Type.String()),
});
const sockets = new Map<
  string,
  Set<{ send: (value: string) => void; readyState: number }>
>();

const broadcast = (challengeId: string, payload: unknown) => {
  const encoded = JSON.stringify(serialize(payload));
  for (const socket of sockets.get(challengeId) ?? []) {
    if (socket.readyState === 1) socket.send(encoded);
  }
};

const adminChallenge = (
  record: Record<string, any>,
  participants = 0,
  completions = 0,
) => ({
  id: String(record._id ?? record.id ?? ""),
  title: String(record.title ?? ""),
  description: String(record.description ?? ""),
  whyItMatters: String(record.why_it_matters ?? record.whyItMatters ?? ""),
  planText: String(record.plan_text ?? record.planText ?? ""),
  planDays: record.plan_days ?? record.planDays ?? [],
  category: String(record.category ?? "Challenge"),
  durationDays: Number(record.duration_days ?? record.durationDays ?? 0),
  points: Number(record.points ?? 0),
  difficulty: String(record.difficulty ?? "BEGINNER"),
  status: String(record.status ?? "DRAFT"),
  thumbnail: String(record.thumbnail ?? ""),
  participantCount: participants,
  completionCount: completions,
  createdAt: record.created_at ?? record.createdAt ?? new Date(),
  updatedAt:
    record.updated_at ?? record.updatedAt ?? record.created_at ?? new Date(),
});

const chatMessage = (
  record: Record<string, any>,
  viewerId = "",
  reactionRecords: Array<Record<string, any>> = [],
) => {
  const authorId = String(record.author_id ?? "");
  const reactionSource = reactionRecords.length
    ? reactionRecords
    : Array.isArray(record.reactions)
      ? record.reactions
      : [];
  const reactions = reactionSource.length
    ? [...new Set(reactionSource.map((item) => String(item.emoji ?? "")))]
        .filter(Boolean)
        .map((emoji) => ({
          emoji,
          count: reactionSource.filter((item) => String(item.emoji) === emoji)
            .length,
          reacted_by_viewer: reactionSource.some(
            (item) =>
              String(item.emoji) === emoji &&
              String(item.user_id ?? "") === viewerId,
          ),
        }))
    : Object.entries(
        record.reactions && typeof record.reactions === "object"
          ? record.reactions
          : {},
      ).map(([emoji, count]) => ({
        emoji,
        count: Number(count),
        reacted_by_viewer: false,
      }));
  return {
    id: String(record._id ?? record.id ?? ""),
    challenge_id: String(record.challenge_id ?? ""),
    author_id: authorId,
    author_name: String(record.author_name ?? "Member"),
    author_role: String(record.author_role ?? "user"),
    author_profile_image: String(record.author_profile_image ?? ""),
    message_type: String(record.message_type ?? "message"),
    content: String(record.content ?? ""),
    image_url: String(record.image_url ?? ""),
    reply_to_message_id: record.reply_to_message_id
      ? String(record.reply_to_message_id)
      : null,
    progress_payload:
      record.progress_payload && typeof record.progress_payload === "object"
        ? record.progress_payload
        : null,
    created_at: record.created_at ?? new Date(),
    updated_at: record.updated_at ?? record.created_at ?? new Date(),
    can_delete: Boolean(viewerId) && viewerId === authorId,
    can_edit:
      Boolean(viewerId) &&
      viewerId === authorId &&
      !["system", "coach_bot"].includes(authorId) &&
      !record.deleted_at,
    is_edited: Boolean(record.edited_at ?? record.is_edited),
    is_deleted: Boolean(record.deleted_at ?? record.is_deleted),
    reactions,
  };
};

const planProgressItems = (membership: Record<string, any> | null) => {
  const progress = membership?.plan_progress;
  if (Array.isArray(progress)) return progress;
  if (!progress || typeof progress !== "object") return [];
  return Object.entries(progress)
    .map(([day, value]) => {
      const item = value && typeof value === "object" ? (value as any) : {};
      return {
        day_number: Number(day),
        completed: Boolean(item.completed),
        completed_section_ids: Array.isArray(item.completed_section_ids)
          ? item.completed_section_ids.map(String)
          : [],
        completed_exercise_ids: Array.isArray(item.completed_exercise_ids)
          ? item.completed_exercise_ids.map(String)
          : [],
      };
    })
    .filter((item) => Number.isFinite(item.day_number))
    .sort((a, b) => a.day_number - b.day_number);
};

const planTextFrom = (days: Array<Record<string, any>>): string =>
  days
    .map((day) => {
      const sections = (day.sections ?? [])
        .map(
          (section: any) =>
            `${section.title}: ${(section.exercises ?? [])
              .map((exercise: any) => exercise.name)
              .filter(Boolean)
              .join(", ")}`,
        )
        .join("\n");
      return `Day ${day.day_number}: ${day.title}\n${sections}`.trim();
    })
    .join("\n\n");

async function syncChallengeWorkouts(
  app: FastifyInstance,
  days: Array<Record<string, any>>,
  category: string,
) {
  const workouts = app.mongo.collection("workouts");
  for (const day of days) {
    for (const section of day.sections ?? []) {
      for (const exercise of section.exercises ?? []) {
        const workoutId = String(exercise.workout_id ?? "");
        const vimeoId = String(exercise.workout_vimeo_id ?? "");
        const videoUrl = String(exercise.workout_video_url ?? "");
        if (!workoutId && !vimeoId && !videoUrl) continue;
        const filter = ObjectId.isValid(workoutId)
          ? { _id: new ObjectId(workoutId) }
          : vimeoId
            ? { vimeo_id: vimeoId }
            : { video_url: videoUrl };
        const now = new Date();
        await workouts.updateOne(
          filter,
          {
            $set: {
              title: String(
                exercise.workout_title ??
                  exercise.name ??
                  `${category} Exercise`,
              ),
              vimeo_id: vimeoId,
              video_url: videoUrl,
              video_source: String(
                exercise.workout_video_source ?? "VIMEO",
              ).toUpperCase(),
              tag: category || "Challenge",
              visibility: "Published",
              thumbnail: String(exercise.workout_thumbnail ?? ""),
              updated_at: now,
            },
            $setOnInsert: { created_at: now },
          },
          { upsert: true },
        );
      }
    }
  }
}

export default async function challengeRoutes(
  app: FastifyInstance,
): Promise<void> {
  const challengeMembership = async (
    challengeId: string,
    userId: string,
    write = false,
  ) => {
    const membership = await app.mongo
      .collection("challenge_memberships")
      .findOne({ challenge_id: challengeId, user_id: userId });
    const status = String(membership?.status ?? "").toUpperCase();
    const allowed = ["ACTIVE", "COMPLETED"].includes(status);
    if (!membership || !allowed) {
      throw new AppError(
        403,
        write
          ? "You do not have permission to post in this challenge chat"
          : "Challenge membership required",
      );
    }
    return membership;
  };

  const ensureChatAvailability = (
    challenge: Record<string, any>,
    write = false,
  ) => {
    const status = String(challenge.status ?? "").toUpperCase();
    if (!write && status === "DRAFT") {
      throw new AppError(403, "This challenge is not available");
    }
    if (!write || status === "ACTIVE") return;
    if (status === "UPCOMING") {
      throw new AppError(403, "This challenge has not started yet");
    }
    if (status === "ARCHIVED") {
      throw new AppError(403, "This challenge has been archived");
    }
    throw new AppError(403, "This challenge is not available");
  };

  const notifyChallengeAvailable = async (challenge: Record<string, any>) => {
    const challengeId = String(challenge._id ?? "");
    if (!challengeId) return;
    const users = app.mongo.collection("users");
    const recipients = await users
      .find({ is_admin: { $ne: true }, is_verified: true })
      .toArray();
    for (const recipient of recipients) {
      const marked = await users.updateOne(
        {
          _id: recipient._id,
          challenge_availability_notification_ids: { $ne: challengeId },
        },
        { $addToSet: { challenge_availability_notification_ids: challengeId } },
      );
      if (!marked.modifiedCount) continue;
      await notifyUser(
        app,
        recipient,
        "New challenge available",
        `${String(challenge.title ?? "A new challenge")} is ready. Start today and complete each day to keep your points.`,
        "challenge_available",
        {
          type: "challenge",
          challengeId,
          durationDays: Math.max(Number(challenge.duration_days ?? 0), 0),
          route: `/challenges/${challengeId}`,
        },
      );
    }
  };

  const notifyChatParticipants = async (
    challengeId: string,
    authorId: string,
    challengeTitle: string,
    content: string,
  ) => {
    const memberships = await app.mongo
      .collection("challenge_memberships")
      .find({ challenge_id: challengeId, user_id: { $ne: authorId } })
      .toArray();
    const recipientIds = [
      ...new Set(
        memberships
          .map((item) => String(item.user_id ?? ""))
          .filter(ObjectId.isValid),
      ),
    ].map((value) => new ObjectId(value));
    if (!recipientIds.length) return;
    const recipients = await app.mongo
      .collection("users")
      .find({ _id: { $in: recipientIds }, is_admin: { $ne: true } })
      .toArray();
    const preview =
      content.trim().replace(/\s+/g, " ").slice(0, 120) ||
      "Sent an image in the challenge chat.";
    await Promise.allSettled(
      recipients.map((recipient) =>
        notifyUser(
          app,
          recipient,
          `New message in ${challengeTitle || "your challenge"}`,
          preview,
          "challenge_chat_message",
          {
            type: "challenge_chat",
            challengeId,
            route: `/challenges/${challengeId}`,
          },
        ),
      ),
    );
  };

  const notifyChallengeMilestone = async (
    user: Record<string, any>,
    challenge: Record<string, any>,
    day: number,
    totalDays: number,
    status: string,
  ) => {
    const name = String(user.name ?? "there").trim() || "there";
    const title = String(challenge.title ?? "your challenge").trim();
    const message =
      status === "COMPLETED"
        ? `Amazing work, ${name}! You completed all ${totalDays} days of ${title}. You finished what you started.`
        : day === 1
          ? `Great first step, ${name}! You completed day 1 of ${title}. Come back tomorrow and keep the streak alive.`
          : day * 2 >= totalDays
            ? `You are past the halfway point, ${name}! Day ${day} of ${title} is complete. Keep your momentum going.`
            : `Well done, ${name}! Day ${day} of ${title} is complete. One more milestone added to your progress.`;
    const challengeId = String(challenge._id ?? "");
    await notifyUser(
      app,
      user,
      "Challenge milestone reached",
      message,
      "challenge_milestone",
      {
        type: "challenge",
        challengeId,
        day,
        totalDays,
        milestone: true,
        route: `/challenges/progress/${challengeId}`,
      },
    );
  };

  const createCoachReply = async (
    challenge: Record<string, any>,
    membership: Record<string, any>,
    triggerMessage: Record<string, any>,
    user: Record<string, any>,
  ) => {
    const coachPrompt = String(triggerMessage.content ?? "")
      .replace(/(?:^|\s)@coach\b/gi, " ")
      .trim();
    if (!coachPrompt) return;
    const challengeId = String(challenge._id ?? "");
    const recent = await app.mongo
      .collection("challenge_chat_messages")
      .find({ challenge_id: challengeId })
      .sort({ created_at: -1, _id: -1 })
      .limit(12)
      .toArray();
    recent.reverse();
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      {
        role: "system",
        content:
          "You are Coach Victor inside a group fitness challenge chat. Give concise, practical, supportive, safety-conscious coaching.",
      },
      {
        role: "user",
        content: [
          "Challenge context:",
          `- Title: ${String(challenge.title ?? "")}`,
          `- Category: ${String(challenge.category ?? "Challenge")}`,
          `- Duration days: ${Math.max(Number(challenge.duration_days ?? 0), 0)}`,
          `- Difficulty: ${String(challenge.difficulty ?? "BEGINNER")}`,
          `- User progress days completed: ${Math.max(Number(membership.progress_days_completed ?? 0), 0)}`,
          `- User question: ${coachPrompt}`,
          "Respond as Coach Victor inside a group challenge chat. Keep it concise, practical, and supportive.",
        ].join("\n"),
      },
    ];
    for (const item of recent) {
      const content = String(item.content ?? "").trim();
      if (
        !content ||
        !["message", "progress_update", "ai_reply"].includes(
          String(item.message_type ?? "message"),
        )
      ) {
        continue;
      }
      if (String(item.author_id) === "coach_bot") {
        messages.push({ role: "assistant", content });
      } else {
        messages.push({
          role: "user",
          content: `${String(item.author_name ?? "Member")}: ${content}`,
        });
      }
    }
    const reply = (await generateText(messages)).trim();
    if (!reply) return;
    const now = new Date();
    const document = {
      challenge_id: challengeId,
      author_id: "coach_bot",
      author_name: "Coach Victor",
      author_role: "coach",
      author_profile_image: "",
      message_type: "ai_reply",
      content: reply,
      image_url: "",
      reply_to_message_id: String(triggerMessage._id ?? ""),
      progress_payload: null,
      created_at: now,
      updated_at: now,
    };
    const result = await app.mongo
      .collection("challenge_chat_messages")
      .insertOne(document);
    const serialized = chatMessage({ ...document, _id: result.insertedId });
    broadcast(challengeId, {
      event: "message_created",
      challenge_id: challengeId,
      message: serialized,
      message_id: String(result.insertedId),
    });
    await notifyUser(
      app,
      user,
      "Coach Victor replied",
      "Coach Victor replied to your challenge message.",
      "challenge_coach_reply",
      {
        type: "challenge_chat",
        challengeId,
        route: `/challenges/${challengeId}`,
      },
    );
  };

  app.get("/challenges/overview", async (request) => {
    const user = await app.requireFeature(
      request,
      "challenge",
      "Your current plan does not include challenge access",
    );
    const [challenges, memberships] = await Promise.all([
      app.mongo
        .collection("challenges")
        .find({ status: { $ne: "ARCHIVED" } })
        .sort({ created_at: -1 })
        .toArray(),
      app.mongo
        .collection("challenge_memberships")
        .find({ user_id: String(user._id) })
        .toArray(),
    ]);
    const challengeById = new Map(
      challenges.map((item) => [String(item._id), item]),
    );
    const byChallenge = new Map(
      memberships.map((item) => [String(item.challenge_id), item]),
    );
    const allMemberships = await app.mongo
      .collection("challenge_memberships")
      .find({ status: { $in: ["ACTIVE", "COMPLETED"] } })
      .toArray();
    const participantCount = (challengeId: string) =>
      allMemberships.filter((item) => String(item.challenge_id) === challengeId)
        .length;
    const activeMemberships = memberships.filter(
      (item) => String(item.status).toUpperCase() === "ACTIVE",
    );
    const completedMemberships = memberships.filter(
      (item) => String(item.status).toUpperCase() === "COMPLETED",
    );
    const activeChats = await Promise.all(
      activeMemberships.map(async (membership) => {
        const challengeId = String(membership.challenge_id);
        const challenge = challengeById.get(challengeId);
        const latest = await app.mongo
          .collection("challenge_chat_messages")
          .find({ challenge_id: challengeId })
          .sort({ created_at: -1, _id: -1 })
          .limit(1)
          .next();
        const unreadFilter: Record<string, any> = {
          challenge_id: challengeId,
          author_id: { $ne: String(user._id) },
        };
        if (membership.last_chat_read_at) {
          unreadFilter.created_at = { $gt: membership.last_chat_read_at };
        }
        return {
          id: String(membership._id),
          challenge_id: challengeId,
          name: String(challenge?.title ?? "Challenge"),
          last_message: String(latest?.content ?? ""),
          last_message_at: latest?.created_at ?? null,
          unread_count: await app.mongo
            .collection("challenge_chat_messages")
            .countDocuments(unreadFilter),
          avatar: String(challenge?.thumbnail ?? ""),
        };
      }),
    );
    return {
      active_chats: activeChats,
      active_challenges: activeMemberships
        .map((membership) => {
          const challengeId = String(membership.challenge_id);
          const challenge = challengeById.get(challengeId);
          if (!challenge) return null;
          const totalDays = Math.max(Number(challenge.duration_days ?? 0), 1);
          const completed = Math.min(
            Number(membership.progress_days_completed ?? 0),
            totalDays,
          );
          return {
            id: String(membership._id),
            challenge_id: challengeId,
            title: String(challenge.title ?? ""),
            description: String(challenge.description ?? ""),
            why_it_matters: String(challenge.why_it_matters ?? ""),
            type: String(challenge.category ?? "Challenge"),
            plan_text: String(challenge.plan_text ?? ""),
            duration_days: totalDays,
            days_left: Math.max(totalDays - completed, 0),
            total_days: totalDays,
            progress: Math.round((completed / totalDays) * 100),
            points: Number(challenge.points ?? 0),
            participants: participantCount(challengeId),
            thumbnail: String(challenge.thumbnail ?? ""),
            color: String(challenge.color ?? "#4F8EF7"),
            created_at: membership.started_at ?? challenge.created_at ?? null,
          };
        })
        .filter(Boolean),
      completed_challenges: completedMemberships
        .map((membership) => {
          const challengeId = String(membership.challenge_id);
          const challenge = challengeById.get(challengeId);
          if (!challenge) return null;
          return {
            id: String(membership._id),
            challenge_id: challengeId,
            title: String(challenge.title ?? ""),
            description: String(challenge.description ?? ""),
            why_it_matters: String(challenge.why_it_matters ?? ""),
            duration_days: Number(challenge.duration_days ?? 0),
            type: String(challenge.category ?? "Challenge"),
            earned_points: Number(challenge.points ?? 0),
            participants: participantCount(challengeId),
            thumbnail: String(challenge.thumbnail ?? ""),
            completed_at: membership.completed_at ?? membership.updated_at,
            color: String(challenge.color ?? "#22C55E"),
            created_at: challenge.created_at ?? null,
          };
        })
        .filter(Boolean),
      ready_to_start: challenges
        .filter(
          (challenge) =>
            !byChallenge.has(String(challenge._id)) &&
            ["ACTIVE", "UPCOMING"].includes(
              String(challenge.status).toUpperCase(),
            ),
        )
        .map((challenge) => ({
          id: String(challenge._id),
          title: String(challenge.title ?? ""),
          description: String(challenge.description ?? ""),
          why_it_matters: String(challenge.why_it_matters ?? ""),
          plan_text: String(challenge.plan_text ?? ""),
          duration_days: Number(challenge.duration_days ?? 0),
          type: String(challenge.category ?? "Challenge"),
          points: Number(challenge.points ?? 0),
          participants: participantCount(String(challenge._id)),
          difficulty: String(challenge.difficulty ?? "BEGINNER"),
          difficulty_color: String(challenge.difficulty_color ?? "#22C55E"),
          status: String(challenge.status ?? "ACTIVE"),
          can_start: String(challenge.status).toUpperCase() === "ACTIVE",
          thumbnail: String(challenge.thumbnail ?? ""),
          created_at: challenge.created_at ?? null,
        })),
    };
  });

  app.get("/challenges/:challengeId", async (request) => {
    const user = await app.requireFeature(
      request,
      "challenge",
      "Your current plan does not include challenge access",
    );
    const id = (request.params as { challengeId: string }).challengeId;
    const challenge = await requiredDocument(
      app.mongo.collection("challenges"),
      id,
      "Challenge",
    );
    const membership = await app.mongo
      .collection("challenge_memberships")
      .findOne({ user_id: String(user._id), challenge_id: id });
    const memberRecords = await app.mongo
      .collection("challenge_memberships")
      .find({ challenge_id: id, status: { $in: ["ACTIVE", "COMPLETED"] } })
      .toArray();
    const memberIds = memberRecords
      .map((record) => String(record.user_id))
      .filter(ObjectId.isValid)
      .map((value) => new ObjectId(value));
    const members = memberIds.length
      ? await app.mongo
          .collection("users")
          .find({ _id: { $in: memberIds } })
          .toArray()
      : [];
    const membersById = new Map(
      members.map((record) => [String(record._id), record]),
    );
    const joined = ["ACTIVE", "COMPLETED"].includes(
      String(membership?.status ?? "").toUpperCase(),
    );
    const messageRecords = joined
      ? await app.mongo
          .collection("challenge_chat_messages")
          .find({ challenge_id: id })
          .sort({ created_at: -1, _id: -1 })
          .limit(50)
          .toArray()
      : [];
    messageRecords.reverse();
    const durationDays = Math.max(Number(challenge.duration_days ?? 0), 1);
    const completedDays = Number(membership?.progress_days_completed ?? 0);
    const currentDay = membership?.started_at
      ? Math.min(
          Math.floor(
            (Date.now() - new Date(membership.started_at).getTime()) /
              86_400_000,
          ) + 1,
          durationDays,
        )
      : null;
    return {
      challenge_id: id,
      title: String(challenge.title ?? ""),
      description: String(challenge.description ?? ""),
      why_it_matters: String(challenge.why_it_matters ?? ""),
      plan_text: String(challenge.plan_text ?? ""),
      plan_days: challenge.plan_days ?? [],
      category: String(challenge.category ?? "Challenge"),
      duration_days: durationDays,
      points: Number(challenge.points ?? 0),
      difficulty: String(challenge.difficulty ?? "BEGINNER"),
      status: String(challenge.status ?? "ACTIVE"),
      thumbnail: String(challenge.thumbnail ?? ""),
      participant_count: memberRecords.length,
      participants: memberRecords.map((record) => {
        const member = membersById.get(String(record.user_id));
        return {
          user_id: String(record.user_id),
          name: String(member?.name ?? "Member"),
          profile_image: String(member?.profile_image ?? ""),
        };
      }),
      viewer_membership_status: String(membership?.status ?? "NOT_JOINED"),
      viewer_progress_days_completed: completedDays,
      viewer_points_earned: Math.round(
        (Number(challenge.points ?? 0) *
          Math.min(completedDays, durationDays)) /
          durationDays,
      ),
      viewer_plan_progress: planProgressItems(membership),
      unread_count: joined
        ? messageRecords.filter(
            (message) =>
              String(message.author_id) !== String(user._id) &&
              (!membership?.last_chat_read_at ||
                new Date(message.created_at) >
                  new Date(membership.last_chat_read_at)),
          ).length
        : 0,
      can_start: !joined && String(challenge.status).toUpperCase() === "ACTIVE",
      can_post:
        String(membership?.status).toUpperCase() === "ACTIVE" &&
        String(challenge.status).toUpperCase() === "ACTIVE",
      has_joined: joined,
      current_day_number: currentDay,
      can_complete_today:
        currentDay !== null &&
        String(membership?.status).toUpperCase() === "ACTIVE",
      completed_today: planProgressItems(membership).some(
        (item) => item.day_number === currentDay && item.completed,
      ),
      messages: messageRecords.map((message) => {
        const author = membersById.get(String(message.author_id));
        return chatMessage(
          {
            ...message,
            author_name: message.author_name ?? author?.name,
            author_role:
              message.author_role ??
              (author?.is_admin ? "admin" : (author?.role ?? "user")),
            author_profile_image:
              message.author_profile_image ?? author?.profile_image,
          },
          String(user._id),
        );
      }),
      started_at: membership?.started_at ?? null,
    };
  });

  app.get("/challenges/:challengeId/chat", async (request) => {
    const user = await app.requireFeature(
      request,
      "challenge",
      "Your current plan does not include challenge access",
    );
    const id = (request.params as { challengeId: string }).challengeId;
    const challenge = await requiredDocument(
      app.mongo.collection("challenges"),
      id,
      "Challenge",
    );
    ensureChatAvailability(challenge);
    const membership = await challengeMembership(id, String(user._id));
    const membershipRecords = await app.mongo
      .collection("challenge_memberships")
      .find({ challenge_id: id, status: { $in: ["ACTIVE", "COMPLETED"] } })
      .toArray();
    const userIds = [
      ...new Set(membershipRecords.map((item) => String(item.user_id))),
    ];
    const objectUserIds = userIds
      .filter(ObjectId.isValid)
      .map((value) => new ObjectId(value));
    const participantUsers = objectUserIds.length
      ? await app.mongo
          .collection("users")
          .find({ _id: { $in: objectUserIds } })
          .toArray()
      : [];
    const usersById = new Map(
      participantUsers.map((record) => [String(record._id), record]),
    );
    const messages = await app.mongo
      .collection("challenge_chat_messages")
      .find({ challenge_id: id })
      .sort({ created_at: -1, _id: -1 })
      .limit(50)
      .toArray();
    messages.reverse();
    const messageIds = messages.map((message) => String(message._id));
    const reactions = messageIds.length
      ? await app.mongo
          .collection("challenge_message_reactions")
          .find({ message_id: { $in: messageIds } })
          .toArray()
      : [];
    const unreadCount = messages.filter(
      (message) =>
        String(message.author_id) !== String(user._id) &&
        (!membership.last_chat_read_at ||
          new Date(message.created_at) >
            new Date(membership.last_chat_read_at)),
    ).length;
    await app.mongo
      .collection("challenge_memberships")
      .updateOne(
        { _id: membership._id },
        { $set: { last_chat_read_at: new Date(), updated_at: new Date() } },
      );
    const durationDays = Math.max(Number(challenge.duration_days ?? 0), 1);
    const completedDays = Number(membership.progress_days_completed ?? 0);
    return {
      challenge_id: id,
      title: String(challenge.title ?? ""),
      description: String(challenge.description ?? ""),
      why_it_matters: String(challenge.why_it_matters ?? ""),
      plan_text: String(challenge.plan_text ?? ""),
      plan_days: challenge.plan_days ?? [],
      category: String(challenge.category ?? "Challenge"),
      duration_days: durationDays,
      points: Number(challenge.points ?? 0),
      difficulty: String(challenge.difficulty ?? "BEGINNER"),
      status: String(challenge.status ?? "ACTIVE"),
      thumbnail: String(challenge.thumbnail ?? ""),
      participant_count: membershipRecords.length,
      participants: membershipRecords.map((item) => {
        const member = usersById.get(String(item.user_id));
        return {
          user_id: String(item.user_id),
          name: String(member?.name ?? "Member"),
          profile_image: String(member?.profile_image ?? ""),
        };
      }),
      viewer_membership_status: String(membership.status ?? "ACTIVE"),
      viewer_progress_days_completed: completedDays,
      viewer_points_earned: Math.round(
        (Number(challenge.points ?? 0) *
          Math.min(completedDays, durationDays)) /
          durationDays,
      ),
      viewer_plan_progress: planProgressItems(membership),
      unread_count: unreadCount,
      messages: messages.map((message) => {
        const author = usersById.get(String(message.author_id));
        return chatMessage(
          {
            ...message,
            author_name: message.author_name ?? author?.name,
            author_role:
              message.author_role ??
              (author?.is_admin ? "admin" : (author?.role ?? "user")),
            author_profile_image:
              message.author_profile_image ?? author?.profile_image,
          },
          String(user._id),
          reactions.filter(
            (reaction) => String(reaction.message_id) === String(message._id),
          ),
        );
      }),
      started_at: membership.started_at ?? null,
    };
  });

  app.get(
    "/ws/challenges/:challengeId/chat",
    { websocket: true },
    async (socket, request) => {
      const id = (request.params as { challengeId: string }).challengeId;
      try {
        const user = await app.requireFeature(
          request,
          "challenge",
          "Your current plan does not include challenge access",
        );
        const challenge = await requiredDocument(
          app.mongo.collection("challenges"),
          id,
          "Challenge",
        );
        ensureChatAvailability(challenge);
        await challengeMembership(id, String(user._id));
      } catch {
        socket.close(1008, "Unauthorized");
        return;
      }
      const set = sockets.get(id) ?? new Set();
      set.add(socket);
      sockets.set(id, set);
      socket.on("close", () => {
        set.delete(socket);
        if (!set.size) sockets.delete(id);
      });
      socket.send(JSON.stringify({ event: "connected", challenge_id: id }));
    },
  );

  app.post(
    "/challenges/:challengeId/chat/messages",
    { schema: { body: messageCreateSchema } },
    async (request, reply) => {
      const user = await app.requireFeature(
        request,
        "challenge",
        "Your current plan does not include challenge access",
      );
      const challengeId = (request.params as { challengeId: string })
        .challengeId;
      const body = request.body as Record<string, any>;
      const challenge = await requiredDocument(
        app.mongo.collection("challenges"),
        challengeId,
        "Challenge",
      );
      const membership = await challengeMembership(
        challengeId,
        String(user._id),
        true,
      );
      ensureChatAvailability(challenge, true);
      const content = String(body.content ?? "").trim();
      if (!content && !body.image_base64) {
        throw new AppError(400, "Message content or image is required");
      }
      const imageUrl = body.image_base64
        ? await uploadProfileImage(
            String(user._id),
            String(body.image_base64),
            String(body.mime_type ?? "image/jpeg"),
            body.file_name ? String(body.file_name) : undefined,
            "challenge-chat",
          )
        : "";
      const replyTo = String(body.reply_to_message_id ?? "").trim() || null;
      if (replyTo) {
        if (!ObjectId.isValid(replyTo)) {
          throw new AppError(400, "Invalid reply_to_message_id");
        }
        const replied = await app.mongo
          .collection("challenge_chat_messages")
          .findOne({ _id: new ObjectId(replyTo), challenge_id: challengeId });
        if (!replied) throw new AppError(404, "Message not found");
      }
      const now = new Date();
      const document = {
        challenge_id: challengeId,
        author_id: String(user._id),
        author_name: String(user.name ?? "Member").trim() || "Member",
        author_role: String(user.role ?? (user.is_admin ? "admin" : "user")),
        author_profile_image: String(user.profile_image ?? ""),
        content,
        image_url: imageUrl,
        reply_to_message_id: replyTo,
        progress_payload: null,
        message_type: "message",
        created_at: now,
        updated_at: now,
      };
      const result = await app.mongo
        .collection("challenge_chat_messages")
        .insertOne(document);
      const response = { ...document, _id: result.insertedId };
      await app.mongo
        .collection("challenge_memberships")
        .updateOne(
          { _id: membership._id },
          { $set: { last_chat_read_at: now, updated_at: now } },
        );
      const serialized = chatMessage(response, String(user._id));
      broadcast(challengeId, {
        event: "message_created",
        challenge_id: challengeId,
        message: serialized,
        message_id: String(result.insertedId),
      });
      void notifyChatParticipants(
        challengeId,
        String(user._id),
        String(challenge.title ?? "Challenge"),
        content,
      ).catch((error) =>
        request.log.warn(
          { err: error, challengeId },
          "challenge chat notification failed",
        ),
      );
      if (/(?:^|\s)@coach\b/i.test(content)) {
        await createCoachReply(challenge, membership, response, user);
      }
      return reply.code(201).send(serialized);
    },
  );

  app.patch(
    "/challenges/:challengeId/chat/messages/:messageId",
    { schema: { body: Type.Object({ content: Type.String() }) } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "challenge",
        "Your current plan does not include challenge access",
      );
      const { challengeId, messageId } = request.params as {
        challengeId: string;
        messageId: string;
      };
      const challenge = await requiredDocument(
        app.mongo.collection("challenges"),
        challengeId,
        "Challenge",
      );
      ensureChatAvailability(challenge, true);
      await challengeMembership(challengeId, String(user._id), true);
      const message = await requiredDocument(
        app.mongo.collection("challenge_chat_messages"),
        messageId,
        "Message",
      );
      if (String(message.challenge_id) !== challengeId) {
        throw new AppError(404, "Message not found");
      }
      if (String(message.author_id) !== String(user._id)) {
        throw new AppError(403, "You can only edit your own messages");
      }
      if (["coach_bot", "system"].includes(String(message.author_id))) {
        throw new AppError(400, "This message cannot be edited");
      }
      const content = String(
        (request.body as Record<string, unknown>).content ?? "",
      ).trim();
      if (!content) throw new AppError(400, "Message content is required");
      const result = await app.mongo
        .collection("challenge_chat_messages")
        .findOneAndUpdate(
          { _id: message._id },
          {
            $set: {
              content,
              edited_at: new Date(),
              updated_at: new Date(),
            },
          },
          { returnDocument: "after" },
        );
      const serialized = chatMessage(result!, String(user._id));
      broadcast(challengeId, {
        event: "message_updated",
        challenge_id: challengeId,
        message: serialized,
        message_id: messageId,
      });
      return serialized;
    },
  );

  app.delete(
    "/challenges/:challengeId/chat/messages/:messageId",
    async (request, reply) => {
      const user = await app.requireFeature(
        request,
        "challenge",
        "Your current plan does not include challenge access",
      );
      const { challengeId, messageId } = request.params as {
        challengeId: string;
        messageId: string;
      };
      const challenge = await requiredDocument(
        app.mongo.collection("challenges"),
        challengeId,
        "Challenge",
      );
      ensureChatAvailability(challenge, true);
      await challengeMembership(challengeId, String(user._id), true);
      const message = await requiredDocument(
        app.mongo.collection("challenge_chat_messages"),
        messageId,
        "Message",
      );
      if (String(message.challenge_id) !== challengeId) {
        throw new AppError(404, "Message not found");
      }
      if (String(message.author_id) !== String(user._id)) {
        throw new AppError(403, "You can only delete your own messages");
      }
      if (["coach_bot", "system"].includes(String(message.author_id))) {
        throw new AppError(400, "This message cannot be deleted");
      }
      const now = new Date();
      await app.mongo.collection("challenge_chat_messages").updateOne(
        { _id: message._id },
        {
          $set: {
            content: "",
            image_url: "",
            is_deleted: true,
            deleted_at: now,
            updated_at: now,
          },
        },
      );
      await deleteStoredMedia(message.image_url);
      broadcast(challengeId, {
        event: "message_deleted",
        challenge_id: challengeId,
        message_id: messageId,
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/challenges/:challengeId/chat/messages/:messageId/reactions/toggle",
    { schema: { body: Type.Object({ emoji: Type.String() }) } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "challenge",
        "Your current plan does not include challenge access",
      );
      const { challengeId, messageId } = request.params as {
        challengeId: string;
        messageId: string;
      };
      const challenge = await requiredDocument(
        app.mongo.collection("challenges"),
        challengeId,
        "Challenge",
      );
      ensureChatAvailability(challenge, true);
      await challengeMembership(challengeId, String(user._id), true);
      const targetMessage = await requiredDocument(
        app.mongo.collection("challenge_chat_messages"),
        messageId,
        "Message",
      );
      if (String(targetMessage.challenge_id) !== challengeId) {
        throw new AppError(404, "Message not found");
      }
      if (targetMessage.is_deleted || targetMessage.deleted_at) {
        throw new AppError(400, "This message has been deleted");
      }
      const emoji = String(
        (request.body as Record<string, unknown>).emoji ?? "like",
      );
      const collection = app.mongo.collection("challenge_message_reactions");
      const filter = {
        message_id: messageId,
        user_id: String(user._id),
        emoji,
      };
      const existing = await collection.findOne(filter);
      if (existing) await collection.deleteOne({ _id: existing._id });
      else await collection.insertOne({ ...filter, created_at: new Date() });
      const items = await collection.find({ message_id: messageId }).toArray();
      const grouped = items.reduce<Record<string, number>>((acc, item) => {
        acc[String(item.emoji)] = (acc[String(item.emoji)] ?? 0) + 1;
        return acc;
      }, {});
      const message = await app.mongo
        .collection("challenge_chat_messages")
        .findOneAndUpdate(
          idFilter(messageId),
          { $set: { reactions: grouped, updated_at: new Date() } },
          { returnDocument: "after" },
        );
      const serialized = chatMessage(message!, String(user._id), items);
      broadcast(challengeId, {
        event: "reaction_updated",
        challenge_id: challengeId,
        message: serialized,
        message_id: messageId,
      });
      return serialized;
    },
  );

  const updatePlanProgress = async (
    request: any,
    mutate: (context: {
      sections: any[];
      completedSections: Set<string>;
      completedExercises: Set<string>;
    }) => void,
    options: { dayNumber?: number; completed?: boolean } = {},
  ) => {
    const user = await app.requireFeature(
      request,
      "challenge",
      "Your current plan does not include challenge access",
    );
    const challengeId = String(request.params.challengeId);
    const dayNumber = Number(
      options.dayNumber ?? request.params.dayNumber ?? 1,
    );
    const [challenge, membership] = await Promise.all([
      requiredDocument(
        app.mongo.collection("challenges"),
        challengeId,
        "Challenge",
      ),
      app.mongo
        .collection("challenge_memberships")
        .findOne({ user_id: String(user._id), challenge_id: challengeId }),
    ]);
    if (!membership) {
      throw new AppError(403, "Join the challenge before updating progress");
    }
    if (
      !["ACTIVE", "JOINED", "IN_PROGRESS"].includes(
        String(membership.status ?? "ACTIVE").toUpperCase(),
      )
    ) {
      throw new AppError(403, "Challenge progress cannot be updated");
    }
    const planDays = Array.isArray(challenge.plan_days)
      ? challenge.plan_days
      : [];
    const planDay = planDays.find(
      (day: any) => Number(day.day_number ?? day.day) === dayNumber,
    );
    if (!planDay) throw new AppError(404, "Challenge plan day not found");
    const sections = Array.isArray(planDay.sections) ? planDay.sections : [];
    const existing = membership.plan_progress?.[String(dayNumber)] ?? {};
    const wasCompleted = Boolean(existing.completed);
    const completedSections = new Set<string>(
      (existing.completed_section_ids ?? []).map(String),
    );
    const completedExercises = new Set<string>(
      (existing.completed_exercise_ids ?? []).map(String),
    );
    mutate({ sections, completedSections, completedExercises });
    for (const section of sections) {
      const sectionId = String(section.id ?? "");
      const exerciseIds = (section.exercises ?? [])
        .map((exercise: any) => String(exercise.id ?? ""))
        .filter(Boolean);
      if (
        exerciseIds.length &&
        exerciseIds.every((id: string) => completedExercises.has(id))
      ) {
        completedSections.add(sectionId);
      } else if (exerciseIds.length) completedSections.delete(sectionId);
    }
    const validSections = sections
      .map((section: any) => String(section.id ?? ""))
      .filter(Boolean);
    const completed = validSections.length
      ? validSections.every((id: string) => completedSections.has(id))
      : Boolean(options.completed ?? (request.body as any)?.completed);
    const planProgress = {
      ...(membership.plan_progress ?? {}),
      [String(dayNumber)]: {
        completed,
        completed_section_ids: [...completedSections].filter((id) =>
          validSections.includes(id),
        ),
        completed_exercise_ids: [...completedExercises],
        updated_at: new Date().toISOString(),
      },
    };
    let progressDaysCompleted = 0;
    for (
      let day = 1;
      day <= Math.max(Number(challenge.duration_days ?? planDays.length), 1);
      day += 1
    ) {
      if (planProgress[String(day)]?.completed) progressDaysCompleted += 1;
      else break;
    }
    const duration = Math.max(
      Number(challenge.duration_days ?? planDays.length),
      1,
    );
    const status = progressDaysCompleted >= duration ? "COMPLETED" : "ACTIVE";
    const now = new Date();
    const update: Record<string, unknown> = {
      plan_progress: planProgress,
      progress_days_completed: progressDaysCompleted,
      status,
      updated_at: now,
    };
    if (status === "COMPLETED") update.completed_at = now;
    await app.mongo.collection("challenge_memberships").updateOne(
      { _id: membership._id },
      {
        $set: update,
        ...(status !== "COMPLETED" ? { $unset: { completed_at: "" } } : {}),
      },
    );
    if (completed && !wasCompleted) {
      const messageDocument = {
        challenge_id: challengeId,
        author_id: String(user._id),
        author_name: String(user.name ?? "Member").trim() || "Member",
        author_role: String(user.role ?? (user.is_admin ? "admin" : "user")),
        author_profile_image: String(user.profile_image ?? ""),
        message_type: "progress_update",
        content: `Completed day ${dayNumber}.`,
        image_url: "",
        reply_to_message_id: null,
        progress_payload: {
          completed_day: dayNumber,
          total_days: duration,
          membership_status: status,
        },
        created_at: now,
        updated_at: now,
      };
      const messageResult = await app.mongo
        .collection("challenge_chat_messages")
        .insertOne(messageDocument);
      broadcast(challengeId, {
        event: "message_created",
        challenge_id: challengeId,
        message: chatMessage({
          ...messageDocument,
          _id: messageResult.insertedId,
        }),
        message_id: String(messageResult.insertedId),
      });
      await notifyChallengeMilestone(
        user,
        challenge,
        dayNumber,
        duration,
        status,
      );
    }
    return {
      challenge_id: challengeId,
      viewer_membership_status: status,
      viewer_progress_days_completed: progressDaysCompleted,
      viewer_points_earned: Math.round(
        (Math.max(Number(challenge.points ?? 0), 0) * progressDaysCompleted) /
          duration,
      ),
      viewer_plan_progress: planProgressItems({ plan_progress: planProgress }),
    };
  };

  app.post(
    "/challenges/:challengeId/plan/days/:dayNumber/sections/:sectionId/complete",
    { schema: { body: completionSchema } },
    async (request) =>
      updatePlanProgress(
        request,
        ({ sections, completedSections, completedExercises }) => {
          const sectionId = String(
            request.params && (request.params as any).sectionId,
          );
          const section = sections.find(
            (item: any) => String(item.id) === sectionId,
          );
          if (!section) {
            throw new AppError(404, "Challenge plan section not found");
          }
          const ids = (section.exercises ?? [])
            .map((exercise: any) => String(exercise.id ?? ""))
            .filter(Boolean);
          if ((request.body as any).completed) {
            completedSections.add(sectionId);
            ids.forEach((id: string) => completedExercises.add(id));
          } else {
            completedSections.delete(sectionId);
            ids.forEach((id: string) => completedExercises.delete(id));
          }
        },
      ),
  );

  const completeExercise = async (request: any) =>
    updatePlanProgress(request, ({ sections, completedExercises }) => {
      const exerciseId = String(request.params.exerciseId);
      const sectionId = request.params.sectionId
        ? String(request.params.sectionId)
        : null;
      const section = sections.find(
        (item: any) =>
          (!sectionId || String(item.id) === sectionId) &&
          (item.exercises ?? []).some(
            (exercise: any) => String(exercise.id) === exerciseId,
          ),
      );
      if (!section) {
        throw new AppError(404, "Challenge plan exercise not found");
      }
      if (request.body?.completed) completedExercises.add(exerciseId);
      else completedExercises.delete(exerciseId);
    });
  app.post(
    "/challenges/:challengeId/plan/days/:dayNumber/exercises/:exerciseId/complete",
    { schema: { body: completionSchema } },
    completeExercise,
  );
  app.post(
    "/challenges/:challengeId/plan/days/:dayNumber/sections/:sectionId/exercises/:exerciseId/complete",
    { schema: { body: completionSchema } },
    completeExercise,
  );

  const completeDay = async (
    request: any,
    explicitDay?: number,
    enforceDailyLimit = false,
  ) => {
    const user = await app.requireFeature(
      request,
      "challenge",
      "Your current plan does not include challenge access",
    );
    const challengeId = String(request.params.challengeId);
    const [challenge, membership] = await Promise.all([
      requiredDocument(
        app.mongo.collection("challenges"),
        challengeId,
        "Challenge",
      ),
      app.mongo.collection("challenge_memberships").findOne({
        user_id: String(user._id),
        challenge_id: challengeId,
      }),
    ]);
    if (!membership) throw new AppError(404, "Challenge membership not found");
    if (enforceDailyLimit) {
      const today = new Date().toISOString().slice(0, 10);
      const completedToday = Object.values(membership.plan_progress ?? {}).some(
        (entry: any) =>
          Boolean(entry?.completed) &&
          String(entry?.updated_at ?? "").slice(0, 10) === today,
      );
      if (completedToday) {
        throw new AppError(
          409,
          "You can only complete one challenge day per day",
        );
      }
    }
    const planDays = Array.isArray(challenge.plan_days)
      ? challenge.plan_days
      : [];
    const duration = Math.max(
      Number(challenge.duration_days ?? planDays.length),
      1,
    );
    let currentDay = Math.min(
      Math.max(Number(membership.progress_days_completed ?? 0) + 1, 1),
      duration,
    );
    if (membership.started_at) {
      const startedAt = new Date(membership.started_at);
      if (!Number.isNaN(startedAt.getTime())) {
        const todayUtc = Date.UTC(
          new Date().getUTCFullYear(),
          new Date().getUTCMonth(),
          new Date().getUTCDate(),
        );
        const startedUtc = Date.UTC(
          startedAt.getUTCFullYear(),
          startedAt.getUTCMonth(),
          startedAt.getUTCDate(),
        );
        currentDay = Math.min(
          Math.max(Math.floor((todayUtc - startedUtc) / 86_400_000) + 1, 1),
          duration,
        );
      }
    }
    const day = explicitDay ?? currentDay;
    const completed = (request.body as any)?.completed ?? true;
    return updatePlanProgress(
      request,
      ({ sections, completedSections, completedExercises }) => {
        const validSectionIds = sections
          .map((section: any) => String(section.id ?? ""))
          .filter(Boolean);
        const validExerciseIds = sections.flatMap((section: any) =>
          (section.exercises ?? [])
            .map((exercise: any) => String(exercise.id ?? ""))
            .filter(Boolean),
        );
        if (!completed) {
          completedSections.clear();
          completedExercises.clear();
          return;
        }
        if (
          validExerciseIds.length &&
          validExerciseIds.some((id: string) => !completedExercises.has(id))
        ) {
          throw new AppError(
            400,
            "Complete every exercise before marking the day done",
          );
        }
        if (
          !validExerciseIds.length &&
          validSectionIds.length &&
          validSectionIds.some((id: string) => !completedSections.has(id))
        ) {
          throw new AppError(
            400,
            "Complete every section before marking the day done",
          );
        }
      },
      { dayNumber: day, completed },
    );
  };

  app.post(
    "/challenges/:challengeId/plan/days/:dayNumber/complete",
    { schema: { body: completionSchema } },
    async (request) =>
      completeDay(
        request,
        Number((request.params as { dayNumber: string }).dayNumber),
      ),
  );
  app.post("/challenges/:challengeId/complete-today", async (request) =>
    completeDay(request, undefined, true),
  );
  app.post("/challenges/:challengeId/current-day/complete", async (request) =>
    completeDay(request, undefined, true),
  );

  app.post(
    "/challenges/:challengeId/progress",
    {
      schema: {
        body: Type.Object({
          completed_day: Type.Integer(),
          note: Type.Optional(Type.String()),
          image_base64: Type.Optional(Type.String()),
          mime_type: Type.Optional(Type.String()),
          file_name: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const user = await app.requireFeature(
        request,
        "challenge",
        "Your current plan does not include challenge access",
      );
      const challengeId = (request.params as { challengeId: string })
        .challengeId;
      const body = request.body as Record<string, any>;
      const [challenge, membership] = await Promise.all([
        requiredDocument(
          app.mongo.collection("challenges"),
          challengeId,
          "Challenge",
        ),
        app.mongo.collection("challenge_memberships").findOne({
          challenge_id: challengeId,
          user_id: String(user._id),
        }),
      ]);
      if (!membership || String(membership.status).toUpperCase() !== "ACTIVE") {
        throw new AppError(403, "Active challenge membership required");
      }
      const totalDays = Math.max(Number(challenge.duration_days ?? 0), 1);
      const completedDay = Math.min(Number(body.completed_day), totalDays);
      const planDays = Array.isArray(challenge.plan_days)
        ? challenge.plan_days
        : [];
      const planDay = planDays.find(
        (day: any) => Number(day.day_number) === completedDay,
      );
      const planProgress = { ...(membership.plan_progress ?? {}) };
      if (planDay) {
        planProgress[String(completedDay)] = {
          completed: true,
          completed_section_ids: (planDay.sections ?? [])
            .map((section: any) => String(section.id ?? ""))
            .filter(Boolean),
          updated_at: new Date().toISOString(),
        };
      }
      let progressDays = 0;
      for (let day = 1; day <= totalDays; day += 1) {
        if (planProgress[String(day)]?.completed) progressDays += 1;
        else break;
      }
      const status = progressDays >= totalDays ? "COMPLETED" : "ACTIVE";
      const imageUrl = body.image_base64
        ? await uploadProfileImage(
            String(user._id),
            String(body.image_base64),
            String(body.mime_type ?? "image/jpeg"),
            body.file_name ? String(body.file_name) : undefined,
            "challenge-chat",
          )
        : "";
      const now = new Date();
      const document = {
        challenge_id: challengeId,
        author_id: String(user._id),
        author_name: String(user.name ?? "Member").trim() || "Member",
        author_role: String(user.role ?? (user.is_admin ? "admin" : "user")),
        author_profile_image: String(user.profile_image ?? ""),
        content:
          String(body.note ?? "").trim() || `Completed day ${completedDay}.`,
        image_url: imageUrl,
        message_type: "progress_update",
        reply_to_message_id: null,
        progress_payload: {
          completed_day: completedDay,
          total_days: totalDays,
          membership_status: status,
        },
        created_at: now,
        updated_at: now,
      };
      const result = await app.mongo
        .collection("challenge_chat_messages")
        .insertOne(document);
      await app.mongo.collection("challenge_memberships").updateOne(
        { _id: membership._id },
        {
          $set: {
            progress_days_completed: progressDays,
            plan_progress: planProgress,
            status,
            updated_at: now,
            ...(status === "COMPLETED" ? { completed_at: now } : {}),
          },
        },
      );
      broadcast(challengeId, {
        event: "progress_updated",
        challenge_id: challengeId,
        message: chatMessage(
          { ...document, _id: result.insertedId },
          String(user._id),
        ),
        message_id: String(result.insertedId),
      });
      return reply
        .code(201)
        .send(
          chatMessage(
            { ...document, _id: result.insertedId },
            String(user._id),
          ),
        );
    },
  );

  app.get("/challenges/:challengeId/progress/report", async (request) => {
    const user = await app.requireFeature(
      request,
      "challenge",
      "Your current plan does not include challenge access",
    );
    const challengeId = (request.params as { challengeId: string }).challengeId;
    const membership = await app.mongo
      .collection("challenge_memberships")
      .findOne({ user_id: String(user._id), challenge_id: challengeId });
    if (!membership) throw new AppError(404, "Challenge membership not found");
    const challenge = await requiredDocument(
      app.mongo.collection("challenges"),
      challengeId,
      "Challenge",
    );
    const totalDays = Math.max(
      Number(challenge.duration_days ?? challenge.plan_days?.length ?? 0),
      1,
    );
    const completedDays = Number(
      membership.progress_days_completed ??
        Object.values(membership.plan_progress ?? {}).filter(
          (entry: any) => entry?.completed,
        ).length,
    );
    const planDays = Array.isArray(challenge.plan_days)
      ? challenge.plan_days
      : [];
    const completedNumbers = new Set(
      Object.entries(membership.plan_progress ?? {})
        .filter(([, value]: [string, any]) =>
          Boolean(
            value?.completed ||
            value?.completed_section_ids?.length ||
            value?.completed_exercise_ids?.length,
          ),
        )
        .map(([day]) => Number(day)),
    );
    const latest = [...planDays]
      .reverse()
      .find((day: any) => completedNumbers.has(Number(day.day_number)));
    const challengeName = String(
      latest?.title ?? challenge.title ?? "Challenge",
    );
    const member = String(user.name ?? "Victory Member") || "Victory Member";
    const challengePoints = Math.max(Number(challenge.points ?? 0), 0);
    const earnedPoints = Math.round(
      (challengePoints * Math.min(completedDays, totalDays)) / totalDays,
    );
    const png = buildReportPng({
      title: challengeName,
      subtitle: "WORKOUT COMPLETED",
      member,
      metric: `STREAK ${completedDays} POINTS ${earnedPoints}/${challengePoints}`,
      progress: completedDays / totalDays,
    });
    return {
      file_name: "victory-fitness-progress-report.png",
      mime_type: "image/png",
      image_base64: png.toString("base64"),
      share_message: [
        "Victory Fitness",
        `${challengeName} completed by ${member}`,
        `Streak: ${completedDays} | Points: ${earnedPoints}/${challengePoints}`,
      ].join("\n"),
    };
  });

  app.post("/challenges/:challengeId/start", async (request, reply) => {
    const user = await app.requireFeature(
      request,
      "challenge",
      "Your current plan does not include challenge access",
    );
    const challengeId = (request.params as { challengeId: string }).challengeId;
    const challenge = await requiredDocument(
      app.mongo.collection("challenges"),
      challengeId,
      "Challenge",
    );
    const challengeStatus = String(challenge.status ?? "").toUpperCase();
    if (challengeStatus === "UPCOMING") {
      throw new AppError(
        400,
        "This challenge is coming soon and cannot be started yet",
      );
    }
    if (challengeStatus !== "ACTIVE") {
      throw new AppError(400, "This challenge cannot be started");
    }
    const memberships = app.mongo.collection("challenge_memberships");
    const existing = await memberships.findOne({
      user_id: String(user._id),
      challenge_id: challengeId,
    });
    if (String(existing?.status ?? "").toUpperCase() === "ACTIVE") {
      return reply.code(201).send({
        status: "success",
        membership_id: String(existing!._id),
      });
    }
    if (String(existing?.status ?? "").toUpperCase() === "COMPLETED") {
      throw new AppError(409, "You already completed this challenge");
    }
    const now = new Date();
    let membershipId: unknown;
    if (existing) {
      await memberships.updateOne(
        { _id: existing._id },
        {
          $set: {
            status: "ACTIVE",
            plan_progress:
              existing.plan_progress &&
              typeof existing.plan_progress === "object"
                ? existing.plan_progress
                : {},
            started_at: existing.started_at ?? now,
            updated_at: now,
          },
        },
      );
      membershipId = existing._id;
    } else {
      const result = await memberships.insertOne({
        user_id: String(user._id),
        challenge_id: challengeId,
        status: "ACTIVE",
        progress_days_completed: 0,
        plan_progress: {},
        joined_at: now,
        started_at: now,
        updated_at: now,
      });
      membershipId = result.insertedId;
    }
    const systemMessage = {
      challenge_id: challengeId,
      author_id: "system",
      author_name: "Coach",
      author_role: "system",
      message_type: "system_event",
      content: `${String(user.name ?? "A member")} joined the challenge.`,
      image_url: "",
      reply_to_message_id: null,
      progress_payload: null,
      created_at: now,
      updated_at: now,
    };
    const systemResult = await app.mongo
      .collection("challenge_chat_messages")
      .insertOne(systemMessage);
    broadcast(challengeId, {
      event: "message_created",
      challenge_id: challengeId,
      message: chatMessage({ ...systemMessage, _id: systemResult.insertedId }),
      message_id: String(systemResult.insertedId),
    });
    await notifyUser(
      app,
      user,
      "Challenge started",
      `You are ready for ${String(challenge.title ?? "your challenge")}. Complete day 1 today to build your streak.`,
      "challenge_started",
      {
        type: "challenge",
        challengeId,
        route: `/challenges/progress/${challengeId}`,
      },
    );
    return reply.code(201).send({
      status: "success",
      membership_id: String(membershipId),
    });
  });

  app.get("/admin/challenges", async (request) => {
    await app.requireAdmin(request);
    const [challenges, memberships] = await Promise.all([
      app.mongo
        .collection("challenges")
        .find({})
        .sort({ created_at: -1 })
        .toArray(),
      app.mongo.collection("challenge_memberships").find({}).toArray(),
    ]);
    return {
      total: challenges.length,
      challenges: challenges.map((challenge) => {
        const related = memberships.filter(
          (membership) =>
            String(membership.challenge_id) === String(challenge._id),
        );
        return adminChallenge(
          challenge,
          related.length,
          related.filter(
            (membership) =>
              String(membership.status).toUpperCase() === "COMPLETED",
          ).length,
        );
      }),
    };
  });
  app.post(
    "/admin/challenges/generate-plan",
    {
      schema: {
        body: Type.Object({
          title: Type.String(),
          description: Type.String(),
          category: Type.String(),
          difficulty: Type.String(),
          durationDays: Type.Optional(Type.Integer()),
        }),
      },
    },
    async (request) => {
      await app.requireAdmin(request);
      const body = request.body as Record<string, any>;
      const duration = Math.min(
        Math.max(Number(body.durationDays ?? 7), 1),
        365,
      );
      const planDays = Array.from({ length: duration }, (_, index) => ({
        day_number: index + 1,
        title: `Day ${index + 1}`,
        focus: String(body.category ?? "Challenge"),
        notes: "",
        sections: [],
      }));
      return {
        title: String(body.title ?? "Generated Challenge"),
        description: String(body.description ?? ""),
        planText: planTextFrom(planDays),
        planDays,
        durationDays: duration,
      };
    },
  );
  app.post(
    "/admin/challenges",
    { schema: { body: adminChallengeSchema } },
    async (request, reply) => {
      const admin = await app.requireAdmin(request);
      const now = new Date();
      const body = request.body as Record<string, any>;
      const planDays = Array.isArray(body.planDays) ? body.planDays : [];
      const thumbnail = body.image_base64
        ? await uploadProfileImage(
            String(admin._id),
            String(body.image_base64),
            String(body.mime_type ?? "image/jpeg"),
            body.file_name ? String(body.file_name) : undefined,
            "challenge-thumbnails",
          )
        : String(body.thumbnail ?? "").trim();
      const derivedDuration = Math.max(
        Number(body.durationDays),
        ...planDays.map((day: any) => Number(day.day_number) || 0),
      );
      const document = {
        title: String(body.title).trim(),
        description: String(body.description).trim(),
        why_it_matters: String(body.whyItMatters ?? "").trim(),
        plan_text:
          planDays.length > 0
            ? planTextFrom(planDays)
            : String(body.planText ?? "").trim(),
        plan_days: planDays,
        category: String(body.category).trim(),
        duration_days: derivedDuration,
        points: Number(body.points),
        difficulty: String(body.difficulty),
        status: String(body.status),
        thumbnail,
        created_at: now,
        updated_at: now,
        created_by: String(admin._id),
      };
      const result = await app.mongo
        .collection("challenges")
        .insertOne(document);
      await syncChallengeWorkouts(app, planDays, document.category);
      if (["ACTIVE", "UPCOMING"].includes(document.status.toUpperCase())) {
        void notifyChallengeAvailable({
          ...document,
          _id: result.insertedId,
        }).catch((error) =>
          request.log.warn(
            { err: error, challengeId: String(result.insertedId) },
            "challenge availability notification failed",
          ),
        );
      }
      return reply
        .code(201)
        .send(adminChallenge({ ...document, _id: result.insertedId }));
    },
  );
  app.patch(
    "/admin/challenges/:challengeId",
    { schema: { body: adminChallengeSchema } },
    async (request) => {
      const admin = await app.requireAdmin(request);
      const id = (request.params as { challengeId: string }).challengeId;
      const existing = await requiredDocument(
        app.mongo.collection("challenges"),
        id,
        "Challenge",
      );
      const body = request.body as Record<string, any>;
      const planDays = Array.isArray(body.planDays) ? body.planDays : [];
      const thumbnail = body.image_base64
        ? await uploadProfileImage(
            String(admin._id),
            String(body.image_base64),
            String(body.mime_type ?? "image/jpeg"),
            body.file_name ? String(body.file_name) : undefined,
            "challenge-thumbnails",
          )
        : String(body.thumbnail ?? "").trim();
      const update = {
        title: String(body.title).trim(),
        description: String(body.description).trim(),
        why_it_matters: String(body.whyItMatters ?? "").trim(),
        plan_text: planDays.length
          ? planTextFrom(planDays)
          : String(body.planText ?? "").trim(),
        plan_days: planDays,
        category: String(body.category).trim(),
        duration_days: Math.max(
          Number(body.durationDays),
          ...planDays.map((day: any) => Number(day.day_number) || 0),
        ),
        points: Number(body.points),
        difficulty: String(body.difficulty),
        status: String(body.status),
        thumbnail,
        updated_at: new Date(),
      };
      const result = await app.mongo
        .collection("challenges")
        .findOneAndUpdate(
          idFilter(id),
          { $set: update },
          { returnDocument: "after" },
        );
      if (!result) throw new AppError(404, "Challenge not found");
      await syncChallengeWorkouts(app, planDays, update.category);
      if (existing.thumbnail && existing.thumbnail !== thumbnail) {
        await deleteStoredMedia(existing.thumbnail);
      }
      const wasAvailable = ["ACTIVE", "UPCOMING"].includes(
        String(existing.status ?? "").toUpperCase(),
      );
      const isAvailable = ["ACTIVE", "UPCOMING"].includes(
        String(result.status ?? "").toUpperCase(),
      );
      if (isAvailable && !wasAvailable) {
        void notifyChallengeAvailable(result).catch((error) =>
          request.log.warn(
            { err: error, challengeId: id },
            "challenge availability notification failed",
          ),
        );
      }
      return adminChallenge(result);
    },
  );
  app.delete("/admin/challenges/:challengeId", async (request) => {
    await app.requireAdmin(request);
    const id = (request.params as { challengeId: string }).challengeId;
    if (!ObjectId.isValid(id)) {
      throw new AppError(400, "Invalid challenge id");
    }
    const existing = await requiredDocument(
      app.mongo.collection("challenges"),
      id,
      "Challenge",
    );
    const result = await app.mongo
      .collection("challenges")
      .deleteOne(idFilter(id));
    if (!result.deletedCount) throw new AppError(404, "Challenge not found");
    const messages = await app.mongo
      .collection("challenge_chat_messages")
      .find({ challenge_id: id })
      .project({ _id: 1, image_url: 1 })
      .toArray();
    const messageIds = messages.map((message) => String(message._id));
    await Promise.all([
      app.mongo
        .collection("challenge_memberships")
        .deleteMany({ challenge_id: id }),
      app.mongo
        .collection("challenge_chat_messages")
        .deleteMany({ challenge_id: id }),
      messageIds.length
        ? app.mongo
            .collection("challenge_message_reactions")
            .deleteMany({ message_id: { $in: messageIds } })
        : undefined,
      deleteStoredMedia(existing.thumbnail),
      ...messages.map((message) => deleteStoredMedia(message.image_url)),
    ]);
    return { status: "success", message: "Challenge deleted" };
  });
  app.get("/admin/challenges/:challengeId/chat", async (request) => {
    await app.requireAdmin(request);
    const challengeId = (request.params as { challengeId: string }).challengeId;
    const challenge = await requiredDocument(
      app.mongo.collection("challenges"),
      challengeId,
      "Challenge",
    );
    const memberships = await app.mongo
      .collection("challenge_memberships")
      .find({
        challenge_id: challengeId,
        status: { $in: ["ACTIVE", "COMPLETED"] },
      })
      .sort({ started_at: 1, joined_at: 1, _id: 1 })
      .toArray();
    const userIds = [
      ...new Set(
        memberships
          .map((membership) => String(membership.user_id ?? ""))
          .filter(Boolean),
      ),
    ];
    const objectUserIds = userIds
      .filter(ObjectId.isValid)
      .map((value) => new ObjectId(value));
    const users = objectUserIds.length
      ? await app.mongo
          .collection("users")
          .find({ _id: { $in: objectUserIds } })
          .toArray()
      : [];
    const usersById = new Map(
      users.map((record) => [String(record._id), record]),
    );
    const messages = await app.mongo
      .collection("challenge_chat_messages")
      .find({ challenge_id: challengeId })
      .sort({ created_at: -1, _id: -1 })
      .limit(200)
      .toArray();
    messages.reverse();
    const missingAuthorIds = [
      ...new Set(
        messages
          .map((message) => String(message.author_id ?? ""))
          .filter(
            (authorId) =>
              ObjectId.isValid(authorId) && !usersById.has(authorId),
          ),
      ),
    ].map((value) => new ObjectId(value));
    if (missingAuthorIds.length) {
      const messageAuthors = await app.mongo
        .collection("users")
        .find({ _id: { $in: missingAuthorIds } })
        .toArray();
      for (const author of messageAuthors) {
        usersById.set(String(author._id), author);
      }
    }
    const messageIds = messages.map((message) => String(message._id));
    const reactions = messageIds.length
      ? await app.mongo
          .collection("challenge_message_reactions")
          .find({ message_id: { $in: messageIds } })
          .toArray()
      : [];
    return {
      challenge_id: challengeId,
      title: String(challenge.title ?? ""),
      description: String(challenge.description ?? ""),
      why_it_matters: "",
      plan_text: String(challenge.plan_text ?? ""),
      plan_days: challenge.plan_days ?? [],
      category: String(challenge.category ?? "Challenge"),
      duration_days: Math.max(Number(challenge.duration_days ?? 0), 0),
      points: Math.max(Number(challenge.points ?? 0), 0),
      difficulty: String(challenge.difficulty ?? "BEGINNER"),
      status: String(challenge.status ?? "ACTIVE"),
      thumbnail: String(challenge.thumbnail ?? ""),
      participant_count: memberships.length,
      participants: userIds.map((userId) => {
        const user = usersById.get(userId);
        return {
          user_id: userId,
          name: String(user?.name ?? "Member").trim() || "Member",
          profile_image: String(user?.profile_image ?? ""),
        };
      }),
      viewer_membership_status: "ADMIN",
      viewer_progress_days_completed: 0,
      viewer_points_earned: 0,
      viewer_plan_progress: [],
      unread_count: 0,
      messages: messages.map((message) => {
        const author = usersById.get(String(message.author_id));
        return chatMessage(
          {
            ...message,
            author_name: message.author_name ?? author?.name,
            author_role:
              message.author_role ??
              (author?.is_admin ? "admin" : (author?.role ?? "user")),
            author_profile_image:
              message.author_profile_image ?? author?.profile_image,
          },
          undefined,
          reactions.filter(
            (reaction) => String(reaction.message_id) === String(message._id),
          ),
        );
      }),
      started_at: null,
    };
  });
  app.delete(
    "/admin/challenges/:challengeId/chat/messages/:messageId",
    async (request, reply) => {
      await app.requireAdmin(request);
      const { challengeId, messageId } = request.params as {
        challengeId: string;
        messageId: string;
      };
      const collection = app.mongo.collection("challenge_chat_messages");
      const message = await collection.findOne(idFilter(messageId));
      if (!message || String(message.challenge_id) !== challengeId) {
        throw new AppError(404, "Message not found");
      }
      const now = new Date();
      const result = await collection.updateOne(
        { _id: message._id },
        {
          $set: {
            content: "",
            image_url: "",
            is_deleted: true,
            deleted_at: now,
            deleted_by_admin: true,
            updated_at: now,
          },
        },
      );
      if (!result.modifiedCount && !result.matchedCount) {
        throw new AppError(404, "Message not found");
      }
      await deleteStoredMedia(message.image_url);
      broadcast(challengeId, {
        event: "message_deleted",
        challenge_id: challengeId,
        message_id: messageId,
      });
      return reply.code(204).send();
    },
  );
}
