import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { ObjectId } from "mongodb";
import { AppError } from "../lib/errors.js";
import { idFilter, requiredDocument } from "../lib/mongo.js";
import { serialize } from "../lib/serialize.js";
import { generateJson, generateText } from "../services/llm.js";
import { config } from "../config.js";
import {
  fullCoachMessages,
  saveCoachMessages,
} from "../services/coach-archive.js";
import { buildReportPng } from "../services/report-image.js";
import { extractDocumentText } from "../services/document-text.js";
import { recordTrialEngagement } from "../services/trial-engagement.js";

const journalEntryBody = Type.Object({
  mood: Type.String({ minLength: 1, maxLength: 40 }),
  content: Type.String({ minLength: 1, maxLength: 10_000 }),
});
const nutritionRequestSchema = Type.Object({
  goal: Type.Optional(Type.String()),
  cuisine: Type.Optional(Type.String()),
  favorite_meal: Type.Optional(Type.String()),
  diet: Type.Optional(Type.String()),
  allergies: Type.Optional(Type.String()),
  activity_level: Type.Optional(Type.String()),
  age: Type.Optional(Type.String()),
  gender: Type.Optional(Type.String()),
  height: Type.Optional(Type.String()),
  weight: Type.Optional(Type.String()),
  health_conditions: Type.Optional(Type.Array(Type.String())),
});
const nutritionCompletionSchema = Type.Object({
  day: Type.String(),
  meal_key: Type.String(),
  completed: Type.Optional(Type.Boolean()),
});
const nutritionAdviceSchema = Type.Object({
  goal: Type.Optional(Type.String()),
  meal_query: Type.Optional(Type.String()),
  daily_calories: Type.Optional(Type.Integer()),
  daily_protein: Type.Optional(Type.Integer()),
  daily_carbs: Type.Optional(Type.Integer()),
  daily_fat: Type.Optional(Type.Integer()),
  cuisine: Type.Optional(Type.String()),
  favorite_meal: Type.Optional(Type.String()),
  allergies: Type.Optional(Type.String()),
});
const mealAnalysisSchema = Type.Object({
  image_base64: Type.Optional(Type.String()),
  document_base64: Type.Optional(Type.String()),
  text_content: Type.Optional(Type.String()),
  mime_type: Type.Optional(Type.String()),
  file_name: Type.Optional(Type.String()),
});
const strengthRequestSchema = Type.Object({
  goal: Type.Optional(Type.String()),
  level: Type.Optional(Type.String()),
  split: Type.Optional(Type.String()),
  height: Type.Optional(Type.String()),
  gender: Type.Optional(Type.String()),
  bench: Type.Optional(Type.String()),
  squat: Type.Optional(Type.String()),
  deadlift: Type.Optional(Type.String()),
  equipment: Type.Optional(Type.Array(Type.String())),
  frequency: Type.Optional(Type.String()),
  days: Type.Optional(Type.Array(Type.String())),
  age: Type.Optional(Type.String()),
  weight: Type.Optional(Type.String()),
});
const videoPlanSchema = Type.Object({
  goal: Type.Optional(Type.String()),
  level: Type.Optional(Type.String()),
  days: Type.Optional(Type.String()),
  duration: Type.Optional(Type.String()),
  countryCode: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  equipment: Type.Optional(Type.String()),
  time: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const journalEntry = (record: Record<string, any>) => ({
  id: String(record._id),
  user_id: String(record.user_id),
  mood: String(record.mood),
  content: String(record.content),
  created_at: record.created_at,
  updated_at: record.updated_at,
});

const nutritionPlan = (record: Record<string, any> | null) => {
  if (!record) return null;
  return {
    ...(record.plan ?? record),
    plan_id: String(record._id ?? record.plan_id ?? "") || null,
    meal_completions:
      record.plan?.meal_completions ??
      record.meal_completions ??
      record.completions ??
      {},
    profile: record.plan?.profile ?? record.profile ?? null,
  };
};

const nutritionJob = (record: Record<string, any>) => ({
  job_id: String(record._id),
  status: String(record.status),
  plan_id:
    record.plan_id === null || record.plan_id === undefined
      ? null
      : String(record.plan_id),
  plan: record.plan ? nutritionPlan(record.plan) : null,
  error:
    record.error === null || record.error === undefined
      ? null
      : String(record.error),
  created_at: record.created_at,
  updated_at: record.updated_at,
});

const mealAnalysis = (record: Record<string, any>) => {
  const value = record.analysis ?? record;
  return {
    analysis_id: String(record._id ?? value.analysis_id ?? "") || null,
    meal_name_guess: String(value.meal_name_guess ?? "Meal analysis"),
    summary: String(value.summary ?? "Analysis completed."),
    estimated_calories: Number(value.estimated_calories ?? value.calories ?? 0),
    estimated_protein: Number(value.estimated_protein ?? value.protein ?? 0),
    estimated_carbs: Number(
      value.estimated_carbs ?? value.carbohydrates ?? value.carbs ?? 0,
    ),
    estimated_fat: Number(value.estimated_fat ?? value.fat ?? 0),
    confidence: String(value.confidence ?? "low"),
    notes: Array.isArray(value.notes)
      ? value.notes.map(String)
      : Array.isArray(value.suggestions)
        ? value.suggestions.map(String)
        : [],
    file_name: value.file_name ?? record.file_name ?? null,
    created_at: value.created_at ?? record.created_at ?? null,
  };
};

const strengthPlan = (record: Record<string, any>) => ({
  plan_id: String(record._id ?? record.plan_id ?? "") || null,
  summary: String(record.plan?.summary ?? record.summary ?? ""),
  days: record.plan?.days ?? record.days ?? [],
  progress: Array.isArray(record.progress) ? record.progress : [],
  created_at: record.created_at ?? null,
});

export default async function journalAiRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/journal/entries",
    { schema: { body: journalEntryBody } },
    async (request, reply) => {
      const user = await app.authenticate(request);
      const now = new Date();
      const document = {
        ...(request.body as object),
        user_id: String(user._id),
        created_at: now,
        updated_at: now,
      };
      const result = await app.mongo
        .collection("journal_entries")
        .insertOne(document);
      return reply
        .code(201)
        .send(journalEntry({ ...document, _id: result.insertedId }));
    },
  );
  app.get("/journal/entries", async (request) => {
    const user = await app.authenticate(request);
    const entries = await app.mongo
      .collection("journal_entries")
      .find({ user_id: String(user._id) })
      .sort({ created_at: -1 })
      .toArray();
    return { entries: entries.map(journalEntry) };
  });
  app.get("/journal/entries/:entryId", async (request) => {
    const user = await app.authenticate(request);
    const entry = await requiredDocument(
      app.mongo.collection("journal_entries"),
      (request.params as { entryId: string }).entryId,
      "Journal entry",
    );
    if (String(entry.user_id) !== String(user._id)) {
      throw new AppError(404, "Journal entry not found");
    }
    return journalEntry(entry);
  });
  app.patch(
    "/journal/entries/:entryId",
    { schema: { body: journalEntryBody } },
    async (request) => {
      const user = await app.authenticate(request);
      const result = await app.mongo
        .collection("journal_entries")
        .findOneAndUpdate(
          {
            ...idFilter((request.params as { entryId: string }).entryId),
            user_id: String(user._id),
          },
          { $set: { ...(request.body as object), updated_at: new Date() } },
          { returnDocument: "after" },
        );
      if (!result) throw new AppError(404, "Journal entry not found");
      return journalEntry(result);
    },
  );
  app.delete("/journal/entries/:entryId", async (request, reply) => {
    const user = await app.authenticate(request);
    const result = await app.mongo.collection("journal_entries").deleteOne({
      ...idFilter((request.params as { entryId: string }).entryId),
      user_id: String(user._id),
    });
    if (!result.deletedCount) {
      throw new AppError(404, "Journal entry not found");
    }
    return reply.code(204).send();
  });

  app.post(
    "/journal/analyze",
    { schema: { body: journalEntryBody } },
    async (request) => {
      const user = await app.authenticate(request);
      const body = request.body as Record<string, unknown>;
      const analysis = await generateText([
        {
          role: "system",
          content:
            "You are a supportive fitness journal coach. Give safe, concise, actionable reflection.",
        },
        { role: "user", content: JSON.stringify(body) },
      ]);
      return { analysis };
    },
  );
  app.post("/journal/analyze/latest", async (request) => {
    const user = await app.authenticate(request);
    const entry = await app.mongo
      .collection("journal_entries")
      .find({ user_id: String(user._id) })
      .sort({ created_at: -1 })
      .limit(1)
      .next();
    if (!entry) throw new AppError(404, "No journal entries found");
    const analysis = await generateText([
      {
        role: "system",
        content:
          "Analyze these recent fitness journal entries. Be concise, supportive, and actionable.",
      },
      {
        role: "user",
        content: JSON.stringify({ mood: entry.mood, content: entry.content }),
      },
    ]);
    return { entry: journalEntry(entry), analysis };
  });

  app.post(
    "/ai/coach-victor/chat",
    {
      schema: {
        body: Type.Object({
          message: Type.String({ minLength: 1, maxLength: 4_000 }),
        }),
      },
    },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "coach_victor",
        "Your current plan does not include Coach Victor access",
      );
      const message = String(
        (request.body as Record<string, unknown>).message ?? "",
      ).trim();
      if (!message) throw new AppError(400, "Message is required");
      const threads = app.mongo.collection("coach_victor_threads");
      const thread = await threads.findOne(
        { user_id: String(user._id) },
        { sort: { updated_at: -1 } },
      );
      const history = (await fullCoachMessages(app, thread)).slice(-12);
      const reply = await generateText([
        {
          role: "system",
          content:
            "You are Coach Victor, a supportive fitness and nutrition coach. Avoid medical diagnosis and unsafe advice.",
        },
        ...history.map((item: any) => ({
          role: item.role,
          content: String(item.content),
        })),
        { role: "user", content: message },
      ]);
      const now = new Date();
      const messages = [
        {
          id: new ObjectId().toHexString(),
          role: "user",
          content: message,
          created_at: now,
        },
        {
          id: new ObjectId().toHexString(),
          role: "assistant",
          content: reply,
          created_at: now,
        },
      ];
      const threadId = await saveCoachMessages(
        app,
        thread,
        String(user._id),
        messages,
        now,
      );
      await recordTrialEngagement(app, user, "coach_message");
      return { reply, thread_id: String(threadId) };
    },
  );
  app.get("/ai/coach-victor/history", async (request) => {
    const user = await app.requireFeature(
      request,
      "coach_victor",
      "Your current plan does not include Coach Victor access",
    );
    const thread = await app.mongo
      .collection("coach_victor_threads")
      .findOne({ user_id: String(user._id) }, { sort: { updated_at: -1 } });
    return {
      thread_id:
        thread?._id === null || thread?._id === undefined
          ? null
          : String(thread._id),
      messages: serialize(await fullCoachMessages(app, thread)),
    };
  });

  const fallbackPlan = (profile: Record<string, unknown>) => ({
    summary: "A balanced seven-day nutrition plan.",
    goal_label: String(profile.goal ?? "Balanced nutrition"),
    profile,
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => ({
      day,
      breakfast: {
        name: "Balanced breakfast",
        desc: "A balanced breakfast",
        kcal: 0,
        p: 0,
        c: 0,
        f: 0,
        ingredients: [],
        instructions: [],
      },
      lunch: {
        name: "Balanced lunch",
        desc: "A balanced lunch",
        kcal: 0,
        p: 0,
        c: 0,
        f: 0,
        ingredients: [],
        instructions: [],
      },
      dinner: {
        name: "Balanced dinner",
        desc: "A balanced dinner",
        kcal: 0,
        p: 0,
        c: 0,
        f: 0,
        ingredients: [],
        instructions: [],
      },
    })),
    shopping_list: [],
    meal_completions: {},
  });

  const createNutritionPlan = async (
    userId: string,
    body: Record<string, unknown>,
    progressive = false,
  ) => {
    const prompt = `Create a safe ${progressive ? "progressive " : ""}7-day nutrition plan as JSON using this profile: ${JSON.stringify(body)}. Include title, summary, daily calories, macros, and days with meals.`;
    const plan = await generateJson(prompt, fallbackPlan(body));
    const now = new Date();
    const document = {
      user_id: userId,
      plan,
      profile: body,
      progressive,
      created_at: now,
      updated_at: now,
    };
    const collection = app.mongo.collection(
      progressive ? "nutrition_progressive_plans" : "nutrition_plans",
    );
    const result = await collection.insertOne(document);
    return nutritionPlan({ ...document, _id: result.insertedId });
  };

  app.post(
    "/ai/nutrition/plan",
    { schema: { body: nutritionRequestSchema } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "mealPlan",
        "Your current plan does not include meal plan access",
      );
      const plan = await createNutritionPlan(
        String(user._id),
        request.body as Record<string, unknown>,
      );
      await recordTrialEngagement(app, user, "nutrition_plan");
      return { status: "success", plan };
    },
  );
  app.post(
    "/ai/nutrition/plan/jobs",
    { schema: { body: nutritionRequestSchema } },
    async (request, reply) => {
      const user = await app.requireFeature(
        request,
        "mealPlan",
        "Your current plan does not include meal plan access",
      );
      const now = new Date();
      const job = {
        user_id: String(user._id),
        payload: request.body,
        status: "queued",
        created_at: now,
        updated_at: now,
      };
      const result = await app.mongo
        .collection("nutrition_plan_jobs")
        .insertOne(job);
      return reply
        .code(202)
        .send(nutritionJob({ ...job, _id: result.insertedId }));
    },
  );
  app.get("/ai/nutrition/plan/jobs/:jobId", async (request) => {
    const user = await app.requireFeature(
      request,
      "mealPlan",
      "Your current plan does not include meal plan access",
    );
    const job = await requiredDocument(
      app.mongo.collection("nutrition_plan_jobs"),
      (request.params as { jobId: string }).jobId,
      "Nutrition job",
    );
    if (String(job.user_id) !== String(user._id)) {
      throw new AppError(404, "Nutrition job not found");
    }
    return nutritionJob(job);
  });
  app.get("/ai/nutrition/plan/latest", async (request) => {
    const user = await app.requireFeature(
      request,
      "mealPlan",
      "Your current plan does not include meal plan access",
    );
    const plan = await app.mongo
      .collection("nutrition_plans")
      .find({ user_id: String(user._id) })
      .sort({ created_at: -1 })
      .limit(1)
      .next();
    if (!plan) throw new AppError(404, "Nutrition plan not found");
    return nutritionPlan(plan);
  });
  app.patch(
    "/ai/nutrition/plan/latest/completions",
    { schema: { body: nutritionCompletionSchema } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "mealPlan",
        "Your current plan does not include meal plan access",
      );
      const latest = await app.mongo
        .collection("nutrition_plans")
        .find({ user_id: String(user._id) })
        .sort({ created_at: -1 })
        .limit(1)
        .next();
      if (!latest) throw new AppError(404, "Nutrition plan not found");
      const result = await app.mongo
        .collection("nutrition_plans")
        .findOneAndUpdate(
          { _id: latest._id },
          { $set: { completions: request.body, updated_at: new Date() } },
          { returnDocument: "after" },
        );
      return nutritionPlan(result);
    },
  );
  app.post(
    "/ai/nutrition/advice",
    { schema: { body: nutritionAdviceSchema } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "nutrition_tracker",
        "Your current plan does not include nutrition tracker access",
      );
      const advice = await generateText([
        {
          role: "system",
          content:
            "Give brief, safe nutrition suggestions. Do not diagnose or prescribe.",
        },
        { role: "user", content: JSON.stringify(request.body) },
      ]);
      return { reply: advice };
    },
  );

  app.post(
    "/ai/nutrition/plan/progressive/jobs",
    { schema: { body: nutritionRequestSchema } },
    async (request, reply) => {
      const user = await app.requireFeature(
        request,
        "mealPlan",
        "Your current plan does not include meal plan access",
      );
      const now = new Date();
      const job = {
        user_id: String(user._id),
        payload: request.body,
        status: "queued",
        progressive: true,
        created_at: now,
        updated_at: now,
      };
      const result = await app.mongo
        .collection("nutrition_progressive_plan_jobs")
        .insertOne(job);
      return reply
        .code(202)
        .send(nutritionJob({ ...job, _id: result.insertedId }));
    },
  );
  app.get("/ai/nutrition/plan/progressive/jobs/:jobId", async (request) => {
    const user = await app.requireFeature(
      request,
      "mealPlan",
      "Your current plan does not include meal plan access",
    );
    const job = await requiredDocument(
      app.mongo.collection("nutrition_progressive_plan_jobs"),
      (request.params as { jobId: string }).jobId,
      "Nutrition job",
    );
    if (String(job.user_id) !== String(user._id)) {
      throw new AppError(404, "Nutrition job not found");
    }
    return nutritionJob(job);
  });
  app.get("/ai/nutrition/plan/progressive/latest", async (request) => {
    const user = await app.requireFeature(
      request,
      "mealPlan",
      "Your current plan does not include meal plan access",
    );
    const plan = await app.mongo
      .collection("nutrition_progressive_plans")
      .find({ user_id: String(user._id) })
      .sort({ created_at: -1 })
      .limit(1)
      .next();
    if (!plan) throw new AppError(404, "Progressive nutrition plan not found");
    return nutritionPlan(plan);
  });
  app.patch(
    "/ai/nutrition/plan/progressive/latest/completions",
    { schema: { body: nutritionCompletionSchema } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "mealPlan",
        "Your current plan does not include meal plan access",
      );
      const latest = await app.mongo
        .collection("nutrition_progressive_plans")
        .find({ user_id: String(user._id) })
        .sort({ created_at: -1 })
        .limit(1)
        .next();
      if (!latest) {
        throw new AppError(404, "Progressive nutrition plan not found");
      }
      return nutritionPlan(
        await app.mongo
          .collection("nutrition_progressive_plans")
          .findOneAndUpdate(
            { _id: latest._id },
            { $set: { completions: request.body, updated_at: new Date() } },
            { returnDocument: "after" },
          ),
      );
    },
  );

  app.post(
    "/ai/meal-analysis",
    { schema: { body: mealAnalysisSchema } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "meal_analysis",
        "Your current plan does not include meal analysis access",
      );
      const body: unknown = request.body;
      const source = body as Record<string, unknown>;
      const imageBase64 = String(source.image_base64 ?? "");
      const documentBase64 = String(source.document_base64 ?? "");
      const textContent = String(source.text_content ?? "");
      if (!imageBase64 && !documentBase64 && !textContent && !source.image) {
        throw new AppError(
          422,
          "One of image_base64, document_base64, or text_content is required",
        );
      }
      if (imageBase64.length > 20_000_000) {
        throw new AppError(422, "image_base64 is too large");
      }
      if (documentBase64.length > 40_000_000) {
        throw new AppError(422, "document_base64 is too large");
      }
      if (textContent.length > 200_000) {
        throw new AppError(422, "text_content is too large");
      }
      const extractedText = textContent.trim()
        ? textContent.trim()
        : documentBase64
          ? await extractDocumentText(
              documentBase64,
              String(source.mime_type ?? "application/octet-stream"),
              String(source.file_name ?? ""),
            )
          : "";
      const analysisInput = imageBase64
        ? {
            image_base64: imageBase64,
            mime_type: source.mime_type,
            file_name: source.file_name,
          }
        : {
            text_content: extractedText,
            file_name: source.file_name,
          };
      const analysis = await generateJson(
        "Analyze this meal information and return JSON with meal_name_guess, summary, estimated_calories, estimated_protein, estimated_carbs, estimated_fat, confidence, and notes: " +
          JSON.stringify(analysisInput),
        {
          meal_name_guess: "Meal analysis",
          summary: "Analysis completed.",
          estimated_calories: 0,
          estimated_protein: 0,
          estimated_carbs: 0,
          estimated_fat: 0,
          confidence: "low",
          notes: [],
        },
      );
      const now = new Date();
      const document = {
        user_id: String(user._id),
        analysis: {
          ...(analysis as Record<string, unknown>),
          file_name: source.file_name ?? null,
          created_at: now,
        },
        created_at: now,
        updated_at: now,
      };
      const result = await app.mongo
        .collection("meal_analysis_entries")
        .insertOne(document);
      return mealAnalysis({ ...document, _id: result.insertedId });
    },
  );
  app.get("/ai/meal-analysis", async (request) => {
    const user = await app.requireFeature(
      request,
      "meal_analysis",
      "Your current plan does not include meal analysis access",
    );
    const records = await app.mongo
      .collection("meal_analysis_entries")
      .find({ user_id: String(user._id) })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
    return { analyses: records.map(mealAnalysis) };
  });

  app.post(
    "/ai/workout-plan/strength",
    { schema: { body: strengthRequestSchema } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "workoutplan",
        "Your current plan does not include workout plan access",
      );
      const body = request.body as Record<string, unknown>;
      const fallback = {
        title: "Personalized Strength Plan",
        weeks: Array.from({ length: 4 }, (_, week) => ({
          week: week + 1,
          days: Array.from({ length: 3 }, (_, day) => ({
            day: day + 1,
            exercises: [],
            completed: false,
          })),
        })),
      };
      const plan = await generateJson(
        `Create a safe progressive strength workout plan as JSON using: ${JSON.stringify(body)}`,
        fallback,
      );
      const now = new Date();
      const document = {
        user_id: String(user._id),
        input: body,
        plan,
        progress: [],
        created_at: now,
        updated_at: now,
      };
      const result = await app.mongo
        .collection("strength_workout_plans")
        .insertOne(document);
      return strengthPlan({ ...document, _id: result.insertedId });
    },
  );
  app.get("/ai/workout-plan/strength/latest", async (request) => {
    const user = await app.requireFeature(
      request,
      "workoutplan",
      "Your current plan does not include workout plan access",
    );
    const plan = await app.mongo
      .collection("strength_workout_plans")
      .find({ user_id: String(user._id) })
      .sort({ created_at: -1 })
      .limit(1)
      .next();
    if (!plan) throw new AppError(404, "Strength workout plan not found");
    return strengthPlan(plan);
  });
  app.get("/ai/workout-plan/strength", async (request) => {
    const user = await app.requireFeature(
      request,
      "workoutplan",
      "Your current plan does not include workout plan access",
    );
    const plans = await app.mongo
      .collection("strength_workout_plans")
      .find({ user_id: String(user._id) })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
    return { items: plans.map(strengthPlan) };
  });
  app.get("/ai/workout-plan/strength/:planId/report", async (request) => {
    const user = await app.requireFeature(
      request,
      "workoutplan",
      "Your current plan does not include workout plan access",
    );
    const plan = await requiredDocument(
      app.mongo.collection("strength_workout_plans"),
      (request.params as { planId: string }).planId,
      "Strength workout plan",
    );
    if (String(plan.user_id) !== String(user._id)) {
      throw new AppError(404, "Strength workout plan not found");
    }
    const days = Array.isArray(plan.plan?.days) ? plan.plan.days : [];
    const progress = Array.isArray(plan.progress) ? plan.progress : [];
    const progressByDay = new Map<string, any>(
      progress.map((item: any) => [String(item.day ?? ""), item]),
    );
    const requestedDay = String(
      (request.query as Record<string, unknown>).day ?? "",
    );
    const selectedDay =
      days.find((item: any) => String(item.day ?? "") === requestedDay) ??
      [...days]
        .reverse()
        .find((item: any) => progressByDay.get(String(item.day))?.completed) ??
      days[0];
    const completedDays = progress.filter((item: any) => item.completed).length;
    const totalDays = Math.max(days.length, 1);
    const totalExercises = days.reduce(
      (total: number, day: any) =>
        total +
        (Array.isArray(day.sections) ? day.sections : []).reduce(
          (sectionTotal: number, section: any) =>
            sectionTotal +
            (Array.isArray(section.exercises) ? section.exercises.length : 0),
          0,
        ),
      0,
    );
    const completedExercises = progress.reduce(
      (total: number, item: any) =>
        total +
        (Array.isArray(item.completed_exercise_ids)
          ? item.completed_exercise_ids.length
          : 0),
      0,
    );
    const fullPlanRequested =
      String(
        (request.query as Record<string, unknown>).full_plan ?? "false",
      ) === "true";
    const fullPlan =
      fullPlanRequested &&
      days.length > 0 &&
      days.every((day: any) => progressByDay.get(String(day.day))?.completed);
    const dayName = String(selectedDay?.title ?? "Strength workout");
    const member = String(user.name ?? "Victory Member") || "Victory Member";
    const png = buildReportPng({
      title: String(plan.plan?.summary ?? "Custom Strength Plan"),
      subtitle: fullPlan
        ? "CUSTOM STRENGTH PLAN COMPLETED"
        : "STRENGTH WORKOUT COMPLETED",
      member,
      metric: `PLAN DAYS ${completedDays}/${totalDays} EXERCISES ${completedExercises}/${Math.max(totalExercises, completedExercises || 1)}`,
      progress: completedDays / totalDays,
    }).toString("base64");
    return {
      file_name: "victory-fitness-strength-completion.png",
      mime_type: "image/png",
      image_base64: png,
      share_message: [
        "Victory Fitness",
        `${fullPlan ? "Custom strength plan" : dayName} completed by ${member}`,
        `Plan progress: ${completedDays}/${totalDays} days | Exercises: ${completedExercises}/${Math.max(totalExercises, completedExercises || 1)}`,
      ].join("\n"),
    };
  });
  app.patch(
    "/ai/workout-plan/strength/:planId/progress",
    {
      schema: {
        body: Type.Object({
          day: Type.String({ minLength: 1, maxLength: 40 }),
          section_id: Type.Optional(Type.String({ maxLength: 120 })),
          exercise_id: Type.Optional(Type.String({ maxLength: 120 })),
          started: Type.Optional(Type.Boolean()),
          completed: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "workoutplan",
        "Your current plan does not include workout plan access",
      );
      const plans = app.mongo.collection("strength_workout_plans");
      const filter = {
        ...idFilter((request.params as { planId: string }).planId),
        user_id: String(user._id),
      };
      const record = await plans.findOne(filter);
      if (!record?.plan || typeof record.plan !== "object") {
        throw new AppError(404, "Strength workout plan not found");
      }
      const body = request.body as Record<string, any>;
      const dayKey = String(body.day ?? "").trim();
      const planDays = Array.isArray(record.plan.days) ? record.plan.days : [];
      const selectedDay = planDays.find(
        (day: any) => String(day.day ?? "").trim() === dayKey,
      );
      if (!selectedDay) throw new AppError(400, "Workout day not found");
      const sections = Array.isArray(selectedDay.sections)
        ? selectedDay.sections
        : [];
      const validSectionIds: string[] = sections
        .map((section: any) => String(section.id ?? "").trim())
        .filter(Boolean);
      const sectionExercises = new Map<string, string[]>(
        sections.map((section: any) => [
          String(section.id ?? "").trim(),
          (Array.isArray(section.exercises) ? section.exercises : [])
            .map((exercise: any) => String(exercise.id ?? "").trim())
            .filter(Boolean),
        ]),
      );
      const validExerciseIds = [...sectionExercises.values()].flat();
      const progressMap = new Map<string, Record<string, any>>(
        (Array.isArray(record.progress) ? record.progress : []).map(
          (item: any) => [String(item.day ?? "").trim(), { ...item }],
        ),
      );
      const now = new Date();
      const dayProgress = progressMap.get(dayKey) ?? {
        day: dayKey,
        started: false,
        completed: false,
        completed_section_ids: [],
        completed_exercise_ids: [],
        started_at: null,
        completed_at: null,
      };
      let completedSections = new Set<string>(
        (dayProgress.completed_section_ids ?? []).filter((id: string) =>
          validSectionIds.includes(id),
        ),
      );
      let completedExercises = new Set<string>(
        (dayProgress.completed_exercise_ids ?? []).filter((id: string) =>
          validExerciseIds.includes(id),
        ),
      );
      const shouldComplete = body.completed === undefined || body.completed;
      if (body.section_id) {
        const sectionId = String(body.section_id).trim();
        if (!validSectionIds.includes(sectionId)) {
          throw new AppError(400, "Workout section not found");
        }
        const ids = sectionExercises.get(sectionId) ?? [];
        if (shouldComplete) ids.forEach((id) => completedExercises.add(id));
        else ids.forEach((id) => completedExercises.delete(id));
      } else if (body.exercise_id) {
        const exerciseId = String(body.exercise_id).trim();
        if (!validExerciseIds.includes(exerciseId)) {
          throw new AppError(400, "Workout exercise not found");
        }
        if (shouldComplete) completedExercises.add(exerciseId);
        else completedExercises.delete(exerciseId);
      } else if (body.completed !== undefined) {
        completedExercises = new Set(body.completed ? validExerciseIds : []);
      }
      completedSections = new Set(
        validSectionIds.filter((id) =>
          (sectionExercises.get(id) ?? []).every((exerciseId) =>
            completedExercises.has(exerciseId),
          ),
        ),
      );
      const completed = validSectionIds.length
        ? completedSections.size >= validSectionIds.length
        : validExerciseIds.length
          ? completedExercises.size >= validExerciseIds.length
          : Boolean(body.completed);
      const started =
        completed ||
        completedExercises.size > 0 ||
        completedSections.size > 0 ||
        Boolean(body.started ?? dayProgress.started);
      const updatedProgress = {
        ...dayProgress,
        started,
        completed,
        completed_section_ids: [...completedSections],
        completed_exercise_ids: [...completedExercises],
        started_at: started ? (dayProgress.started_at ?? now) : null,
        completed_at: completed ? now : null,
      };
      progressMap.set(dayKey, updatedProgress);
      const orderedProgress = planDays
        .map((day: any) => progressMap.get(String(day.day ?? "").trim()))
        .filter(Boolean);
      await plans.updateOne(filter, {
        $set: { progress: orderedProgress, updated_at: now },
      });
      return strengthPlan({
        ...record,
        progress: orderedProgress,
        updated_at: now,
      });
    },
  );
  app.delete("/ai/workout-plan/strength/latest", async (request) => {
    const user = await app.requireFeature(
      request,
      "workoutplan",
      "Your current plan does not include workout plan access",
    );
    const latest = await app.mongo
      .collection("strength_workout_plans")
      .find({ user_id: String(user._id) })
      .sort({ created_at: -1 })
      .limit(1)
      .next();
    if (!latest) throw new AppError(404, "Strength workout plan not found");
    await app.mongo
      .collection("strength_workout_plans")
      .deleteOne({ _id: latest._id });
    return { status: "success", message: "Strength workout plan deleted" };
  });
  app.delete("/ai/workout-plan/strength/:planId", async (request) => {
    const user = await app.requireFeature(
      request,
      "workoutplan",
      "Your current plan does not include workout plan access",
    );
    const result = await app.mongo
      .collection("strength_workout_plans")
      .deleteOne({
        ...idFilter((request.params as { planId: string }).planId),
        user_id: String(user._id),
      });
    if (!result.deletedCount) {
      throw new AppError(404, "Strength workout plan not found");
    }
    return { status: "success", message: "Strength workout plan deleted" };
  });
  app.post(
    "/ai/workout-plan/video",
    { schema: { body: videoPlanSchema } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "workoutplan",
        "Your current plan does not include workout plan access",
      );
      const query = request.body as Record<string, unknown>;
      const workouts = await app.mongo
        .collection("workouts")
        .find({ visibility: { $in: ["Published", "PUBLISHED", "published"] } })
        .limit(20)
        .toArray();
      return {
        user_id: String(user._id),
        input: query,
        workouts: serialize(workouts),
        created_at: new Date(),
      };
    },
  );
}
