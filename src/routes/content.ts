import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { AppError } from "../lib/errors.js";

const textContentSchema = Type.Object({
  title: Type.String(),
  html_content: Type.String(),
});
const faqSchema = Type.Object({
  question: Type.String(),
  answer: Type.String(),
});
const subscriptionPlanSchema = Type.Object({
  tier: Type.String(),
  description: Type.String(),
  priceMonthly: Type.Optional(Type.Integer()),
  priceYearly: Type.Optional(Type.Integer()),
  features: Type.Optional(Type.Array(Type.String())),
  iconType: Type.Optional(Type.String()),
  isMostPopular: Type.Optional(Type.Boolean()),
  isApplicationOnly: Type.Optional(Type.Boolean()),
  discountPercentage: Type.Optional(Type.Integer()),
  discountStartDate: Type.Optional(Type.String()),
  discountEndDate: Type.Optional(Type.String()),
});
const homepageQuoteSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  author: Type.String(),
  active: Type.Optional(Type.Boolean()),
});
const textDefaults = {
  privacy_policy: {
    title: "Privacy Policy",
    html_content:
      "<p>Last Updated: May 13, 2026</p><h2>1. Introduction</h2><p>Welcome to Victory Fitness. We are committed to protecting your personal information and your right to privacy.</p><h2>2. Information We Collect</h2><p>We collect information you provide directly to us, including account details and fitness-related profile information.</p><h2>3. How We Use Your Information</h2><p>We use your information to operate the app, personalize coaching, improve recommendations, and support your account.</p><h2>4. Data Security</h2><p>We use reasonable technical and organizational measures to protect your information, but no system can be guaranteed fully secure.</p><h2>5. Your Rights</h2><p>Depending on your location, you may have rights to access, correct, delete, or restrict the use of your personal information.</p><h2>6. Contact</h2><p>If you have questions about this policy, contact Victory Fitness support.</p>",
  },
  terms_condition: {
    title: "Terms & Conditions",
    html_content:
      "<p>Last Updated: May 13, 2026</p><h2>1. Agreement</h2><p>By using Victory Fitness, you agree to these Terms & Conditions and our related policies.</p><h2>2. Use of the Service</h2><p>You agree to use the app lawfully and only for its intended fitness, wellness, and account-management purposes.</p><h2>3. Accounts</h2><p>You are responsible for maintaining the confidentiality of your account credentials and for activities under your account.</p><h2>4. Health Disclaimer</h2><p>Victory Fitness provides educational and informational content only and does not replace professional medical advice.</p><h2>5. Termination</h2><p>We may suspend or terminate access if these terms are violated or if the service is misused.</p><h2>6. Contact</h2><p>If you have questions about these terms, contact Victory Fitness support.</p>",
  },
  about_us: {
    title: "About Us",
    html_content:
      "<h2>About Victory Fitness</h2><p>Victory Fitness is built to help people train with more structure, eat with more clarity, and stay consistent for the long term.</p><h2>Our Mission</h2><p>We combine coaching, personalized planning, and practical fitness tools so users can build healthier routines that fit real life.</p><h2>What We Offer</h2><p>Victory Fitness brings together workout support, nutrition guidance, journaling, accountability, and progress tracking in one place.</p><h2>Our Focus</h2><p>We focus on practical, sustainable progress instead of extreme plans, helping users improve strength, energy, recovery, and confidence.</p>",
  },
};
const defaultFaqs = [
  {
    id: "faq-reset-password",
    question: "How do I reset my password?",
    answer:
      "Use the forgot password flow on the sign-in page and enter the verification code sent to your email.",
  },
  {
    id: "faq-update-billing",
    question: "How can I update my billing information?",
    answer:
      "Open the billing or subscription area in your account and follow the update prompts provided there.",
  },
  {
    id: "faq-refund-policy",
    question: "What is the refund policy?",
    answer:
      "Contact support with your order details and the team will review the request based on your plan and billing status.",
  },
];
const defaultOnboarding = [
  {
    id: "performance-first",
    badge: "PERFORMANCE FIRST",
    title_lines: ["UNLEASH YOUR", "POTENTIAL"],
    title_accent_index: 1,
    description:
      "Elite discipline meets data-driven precision. Track every rep, optimize your recovery, and transcend your limits with our high-octane performance ecosystem.",
    show_skip: false,
    button_label: "NEXT",
    button_arrow: "->",
    has_secondary: false,
    secondary_label: "",
    has_footer: false,
    footer_text: "",
  },
  {
    id: "precision-tracking",
    badge: "",
    title_lines: ["PRECISION", "TRACKING"],
    title_accent_index: null,
    description:
      "Experience real-time analytics fueled by proprietary algorithms. Every rep, breath, and heartbeat becomes actionable data.",
    show_skip: false,
    button_label: "NEXT",
    button_arrow: "->",
    has_secondary: false,
    secondary_label: "",
    has_footer: false,
    footer_text: "",
  },
  {
    id: "stronger-together",
    badge: "",
    title_lines: ["STRONGER", "TOGETHER"],
    title_accent_index: null,
    description:
      "Unlock your full potential by training with a global network of elite athletes. Share data, compete in challenges, and never train alone.",
    show_skip: false,
    button_label: "GET STARTED",
    button_arrow: ">",
    has_secondary: false,
    secondary_label: "",
    has_footer: true,
    footer_text: "VICTORY FITNESS OS V2.0",
  },
];
const defaultQuotes = [
  {
    id: "quote-wisdom-listens",
    text: "WISDOM LISTENS BEFORE IT LEADS.",
    author: "Victor Akko",
    active: true,
  },
  {
    id: "quote-only-limit",
    text: "YOUR ONLY LIMIT IS YOUR MIND.",
    author: "Focus",
    active: true,
  },
  {
    id: "quote-victory-persevering",
    text: "VICTORY BELONGS TO THE MOST PERSEVERING.",
    author: "Napoleon",
    active: true,
  },
  {
    id: "quote-strength-winning",
    text: "STRENGTH DOES NOT COME FROM WINNING.",
    author: "Arnold",
    active: true,
  },
];
const defaultPlans = [
  {
    id: "plan-silver",
    tier: "VICTORY SILVER",
    description: "Good start, but not enough for full transformation.",
    priceMonthly: 19,
    priceYearly: 199,
    discountPercentage: null,
    discountStartDate: null,
    discountEndDate: null,
    isApplicationOnly: false,
    isMostPopular: false,
    iconType: "silver_medal",
    features: [
      "Full Workout Library (120+)",
      "Basic Programs",
      "Limited Challenges",
    ],
  },
  {
    id: "plan-gold",
    tier: "VICTORY GOLD",
    description:
      "This is where real consistency starts. Structure and accountability.",
    priceMonthly: 29,
    priceYearly: 299,
    discountPercentage: null,
    discountStartDate: null,
    discountEndDate: null,
    isApplicationOnly: false,
    isMostPopular: true,
    iconType: "gold_medal",
    features: [
      "All Silver features",
      "Accountability System (Tracking, Reminders)",
      "Community Challenges and Nutrition",
      "Basic wearable data (sleep and activity)",
    ],
  },
  {
    id: "plan-platinum",
    tier: "VICTORY PLATINUM",
    description: "For those who want more precision and faster results.",
    priceMonthly: 39,
    priceYearly: 399,
    discountPercentage: null,
    discountStartDate: null,
    discountEndDate: null,
    isApplicationOnly: false,
    isMostPopular: false,
    iconType: "diamond",
    features: [
      "All Gold features",
      "Personalized Plans",
      "Feedback System and Priority Support",
      "Full wearable syncing and AI adjustments",
    ],
  },
  {
    id: "plan-inner-circle",
    tier: "VICTORY INNER CIRCLE",
    description:
      "For those who are ready to commit. Direct coaching with Victor.",
    priceMonthly: null,
    priceYearly: null,
    discountPercentage: null,
    discountStartDate: null,
    discountEndDate: null,
    isApplicationOnly: true,
    isMostPopular: false,
    iconType: "circle",
    features: [
      "Direct Coaching with Victor",
      "Personal Structure and Plan",
      "Accountability Check-Ins and Adjustments",
      "Advanced AI health insights and trends",
    ],
  },
];

const adminPlan = (item: Record<string, any>) => ({
  id: String(item.id ?? randomUUID()),
  tier: String(item.tier ?? "").trim(),
  description: String(item.description ?? "").trim(),
  priceMonthly: item.isApplicationOnly ? null : (item.priceMonthly ?? null),
  priceYearly: item.isApplicationOnly ? null : (item.priceYearly ?? null),
  discountPercentage: item.discountPercentage ?? null,
  discountStartDate: item.discountStartDate ?? null,
  discountEndDate: item.discountEndDate ?? null,
  isApplicationOnly: Boolean(item.isApplicationOnly),
  isMostPopular: Boolean(item.isMostPopular),
  iconType: String(item.iconType ?? ""),
  features: Array.isArray(item.features) ? item.features.map(String) : [],
});

const appPlan = (item: Record<string, any>) => {
  const plan = adminPlan(item);
  const now = Date.now();
  const start = plan.discountStartDate
    ? new Date(plan.discountStartDate).getTime()
    : -Infinity;
  const end = plan.discountEndDate
    ? new Date(plan.discountEndDate).getTime()
    : Infinity;
  const active =
    Number(plan.discountPercentage ?? 0) > 0 && now >= start && now <= end;
  const discounted = (price: unknown) =>
    price === null || price === undefined
      ? null
      : active
        ? Math.round(
            Number(price) * (1 - Number(plan.discountPercentage) / 100),
          )
        : Number(price);
  return {
    id: plan.id,
    subscriptionTier: plan.tier
      .toUpperCase()
      .replace(/^VICTORY\s+/, "")
      .replace(/\s+/g, "_"),
    title: plan.tier,
    description: plan.description,
    priceMonthly: plan.priceMonthly,
    priceYearly: plan.priceYearly,
    discountedPriceMonthly: discounted(plan.priceMonthly),
    discountedPriceYearly: discounted(plan.priceYearly),
    discountPercentage: plan.discountPercentage,
    discountStartDate: plan.discountStartDate,
    discountEndDate: plan.discountEndDate,
    isDiscountActive: active,
    isApplicationOnly: plan.isApplicationOnly,
    isMostPopular: plan.isMostPopular,
    iconType: plan.iconType,
    features: plan.features,
  };
};

const plainText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const textRecord = async (
  app: FastifyInstance,
  key: keyof typeof textDefaults,
) => {
  const aliases = [key, key.replace(/_/g, "-")];
  const existing = await app.mongo
    .collection("app_content")
    .findOne({ key: { $in: aliases } });
  const fallback = textDefaults[key];
  const value = (existing?.value ??
    existing?.content ??
    existing ??
    {}) as Record<string, any>;
  const html = String(
    value.html_content ?? value.content ?? fallback.html_content,
  );
  const updatedAt = value.updated_at ?? existing?.updated_at ?? new Date();
  if (!existing) {
    await app.mongo.collection("app_content").insertOne({
      key,
      ...fallback,
      created_at: updatedAt,
      updated_at: updatedAt,
    });
  }
  return {
    key,
    title: String(value.title ?? fallback.title),
    html_content: html,
    plain_text: plainText(html),
    updated_at: updatedAt,
  };
};

const itemsRecord = async <T>(
  app: FastifyInstance,
  key: string,
  fallback: T[],
): Promise<T[]> => {
  const record = await app.mongo.collection("app_content").findOne({ key });
  const items = record?.items ?? record?.value;
  if (Array.isArray(items)) return items as T[];
  await app.mongo.collection("app_content").updateOne(
    { key },
    {
      $setOnInsert: {
        key,
        items: fallback,
        created_at: new Date(),
        updated_at: new Date(),
      },
    },
    { upsert: true },
  );
  return fallback;
};

const replaceItems = async (
  app: FastifyInstance,
  key: string,
  items: unknown[],
) => {
  await app.mongo.collection("app_content").updateOne(
    { key },
    {
      $set: { key, items, updated_at: new Date() },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true },
  );
  return items;
};

export default async function contentRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/content/privacy-policy", async () =>
    textRecord(app, "privacy_policy"),
  );
  app.get("/content/about-us", async () => textRecord(app, "about_us"));
  app.get("/content/onboarding", async () => ({
    slides: await itemsRecord(app, "dashboard_onboarding", defaultOnboarding),
  }));
  app.get("/content/homepage/quote", async () => {
    const record = await app.mongo
      .collection("app_content")
      .findOne({ key: "homepage_quotes" });
    let quotes = record?.items ?? record?.value;
    if (!Array.isArray(quotes)) {
      try {
        quotes = JSON.parse(String(record?.html_content ?? "[]"));
      } catch {
        quotes = [];
      }
    }
    if (!Array.isArray(quotes) || !quotes.length) {
      quotes = defaultQuotes;
      await app.mongo.collection("app_content").updateOne(
        { key: "homepage_quotes" },
        {
          $set: {
            key: "homepage_quotes",
            title: "Homepage quotes",
            html_content: JSON.stringify(quotes),
            updated_at: new Date(),
          },
          $setOnInsert: { created_at: new Date() },
        },
        { upsert: true },
      );
    }
    const active = quotes.filter((item: any) => item?.active !== false);
    if (!active.length) return null;
    return active[Math.floor(Date.now() / 86_400_000) % active.length];
  });

  for (const [path, key] of [
    ["/admin/content/privacy-policy", "privacy_policy"],
    ["/admin/content/terms-condition", "terms_condition"],
    ["/admin/content/about-us", "about_us"],
  ] as const) {
    app.get(path, async (request) => {
      await app.requireAdmin(request);
      return textRecord(app, key);
    });
    app.put(path, { schema: { body: textContentSchema } }, async (request) => {
      const admin = await app.requireAdmin(request);
      const body = request.body as Record<string, unknown>;
      const current = await textRecord(app, key);
      const title = String(body.title ?? current.title).trim();
      const html = String(
        body.html_content ?? body.content ?? current.html_content,
      );
      if (!title || !html.trim()) {
        throw new AppError(422, "title and html_content are required");
      }
      const updatedAt = new Date();
      await app.mongo.collection("app_content").updateOne(
        { key },
        {
          $set: {
            key,
            title,
            html_content: html,
            updated_at: updatedAt,
            updated_by: String(admin._id),
          },
          $setOnInsert: { created_at: updatedAt },
        },
        { upsert: true },
      );
      return {
        key,
        title,
        html_content: html,
        plain_text: plainText(html),
        updated_at: updatedAt,
      };
    });
  }

  app.get("/admin/homepage/quotes", async (request) => {
    await app.requireAdmin(request);
    const record = await app.mongo
      .collection("app_content")
      .findOne({ key: "homepage_quotes" });
    let items: unknown = record?.items ?? record?.value;
    if (!Array.isArray(items)) {
      try {
        items = JSON.parse(String(record?.html_content ?? "[]"));
      } catch {
        items = [];
      }
    }
    return {
      items: Array.isArray(items) && items.length ? items : defaultQuotes,
    };
  });
  for (const method of ["POST", "PUT"] as const) {
    app.route({
      method,
      url: "/admin/homepage/quotes",
      schema: {
        body:
          method === "POST"
            ? Type.Object({
                text: Type.String(),
                author: Type.String(),
                active: Type.Optional(Type.Boolean()),
              })
            : Type.Object({
                items: Type.Optional(Type.Array(homepageQuoteSchema)),
              }),
      },
      handler: async (request) => {
        const admin = await app.requireAdmin(request);
        const body = request.body as { items?: unknown[] };
        let current: any[] = [];
        const record = await app.mongo
          .collection("app_content")
          .findOne({ key: "homepage_quotes" });
        try {
          current = Array.isArray(record?.items)
            ? record.items
            : JSON.parse(String(record?.html_content ?? "[]"));
        } catch {
          current = [];
        }
        const items =
          method === "POST"
            ? [
                ...(current.length ? current : defaultQuotes),
                {
                  id: randomUUID(),
                  text: String((request.body as any).text ?? "").trim(),
                  author: String((request.body as any).author ?? "").trim(),
                  active: (request.body as any).active !== false,
                },
              ]
            : Array.isArray(body.items)
              ? body.items
              : [];
        await app.mongo.collection("app_content").updateOne(
          { key: "homepage_quotes" },
          {
            $set: {
              key: "homepage_quotes",
              title: "Homepage quotes",
              html_content: JSON.stringify(items),
              updated_at: new Date(),
              updated_by: String(admin._id),
            },
            $setOnInsert: { created_at: new Date() },
          },
          { upsert: true },
        );
        return { items };
      },
    });
  }

  app.get("/admin/faqs", async (request) => {
    await app.requireAdmin(request);
    return {
      items: await itemsRecord(app, "dashboard_faqs", defaultFaqs),
    };
  });
  app.post(
    "/admin/faqs",
    { schema: { body: faqSchema } },
    async (request, reply) => {
      await app.requireAdmin(request);
      const body = request.body as Record<string, unknown>;
      const item = {
        id: randomUUID().replace(/-/g, ""),
        question: String(body.question ?? "").trim(),
        answer: String(body.answer ?? "").trim(),
      };
      const items = await itemsRecord(app, "dashboard_faqs", defaultFaqs);
      await replaceItems(app, "dashboard_faqs", [...items, item]);
      return reply.code(201).send(item);
    },
  );
  app.patch(
    "/admin/faqs/:faqId",
    { schema: { body: faqSchema } },
    async (request) => {
      await app.requireAdmin(request);
      const { faqId } = request.params as { faqId: string };
      const items = await itemsRecord(app, "dashboard_faqs", defaultFaqs);
      const index = items.findIndex((item: any) => String(item.id) === faqId);
      if (index < 0) throw new AppError(404, "FAQ not found");
      const current = items[index]!;
      const body = request.body as Record<string, unknown>;
      const updated = {
        ...current,
        id: faqId,
        question: String(body.question ?? current.question).trim(),
        answer: String(body.answer ?? current.answer).trim(),
      };
      items[index] = updated;
      await replaceItems(app, "dashboard_faqs", items);
      return updated;
    },
  );
  app.delete("/admin/faqs/:faqId", async (request) => {
    await app.requireAdmin(request);
    const id = (request.params as { faqId: string }).faqId;
    const items = await itemsRecord(app, "dashboard_faqs", defaultFaqs);
    const next = items.filter((item: any) => String(item.id) !== id);
    if (next.length === items.length) throw new AppError(404, "FAQ not found");
    await replaceItems(app, "dashboard_faqs", next);
    return { status: "success", message: "FAQ deleted" };
  });

  app.get("/subscription-plans", async () => {
    const items = await itemsRecord(
      app,
      "dashboard_subscription_plans",
      defaultPlans,
    );
    return { items: items.map((item) => appPlan(item)) };
  });
  app.get("/admin/subscription-plans", async (request) => {
    await app.requireAdmin(request);
    const items = await itemsRecord(
      app,
      "dashboard_subscription_plans",
      defaultPlans,
    );
    return { items: items.map((item) => adminPlan(item)) };
  });
  app.post(
    "/admin/subscription-plans",
    { schema: { body: subscriptionPlanSchema } },
    async (request, reply) => {
      await app.requireAdmin(request);
      const item = adminPlan({
        ...(request.body as object),
        id: randomUUID().replace(/-/g, ""),
      });
      const items = await itemsRecord(
        app,
        "dashboard_subscription_plans",
        defaultPlans,
      );
      await replaceItems(app, "dashboard_subscription_plans", [...items, item]);
      return reply.code(201).send(item);
    },
  );
  app.patch(
    "/admin/subscription-plans/:planId",
    { schema: { body: subscriptionPlanSchema } },
    async (request) => {
      await app.requireAdmin(request);
      const id = (request.params as { planId: string }).planId;
      const items = await itemsRecord(
        app,
        "dashboard_subscription_plans",
        defaultPlans,
      );
      const index = items.findIndex((item: any) => String(item.id) === id);
      if (index < 0) throw new AppError(404, "Subscription plan not found");
      const updated = adminPlan({
        ...items[index],
        ...(request.body as object),
        id,
      });
      items[index] = updated;
      await replaceItems(app, "dashboard_subscription_plans", items);
      return updated;
    },
  );
  app.delete("/admin/subscription-plans/:planId", async (request) => {
    await app.requireAdmin(request);
    const id = (request.params as { planId: string }).planId;
    const items = await itemsRecord(
      app,
      "dashboard_subscription_plans",
      defaultPlans,
    );
    const next = items.filter((item: any) => String(item.id) !== id);
    if (next.length === items.length) {
      throw new AppError(404, "Subscription plan not found");
    }
    await replaceItems(app, "dashboard_subscription_plans", next);
    return { status: "success", message: "Subscription plan deleted" };
  });
}
