import type { FastifyInstance } from "fastify";
import type { Document } from "mongodb";
import { normalizedTier, subscriptionAccess } from "../plugins/auth.js";
import { toId } from "../lib/serialize.js";

const ranks: Array<[string, number]> = [
  ["Noob", 0],
  ["Bronze", 500],
  ["Silver", 1600],
  ["Gold", 3500],
  ["Platinum", 5000],
  ["Diamond", 10_000],
  ["Master", 20_000],
  ["Champion", 35_000],
  ["Titan", 50_000],
  ["Legend", 75_000],
  ["Immortal", 100_000],
];

const rankProgress = (points: number) => {
  let index = 0;
  ranks.forEach(([, floor], current) => {
    if (points >= floor) index = current;
  });
  const [rank, floor] = ranks[index]!;
  const next = ranks[index + 1];
  return {
    rank,
    next_rank: next?.[0] ?? rank,
    points_to_next_rank: next ? Math.max(next[1] - points, 0) : 0,
    rank_progress_fraction: next
      ? Math.min(Math.max((points - floor) / (next[1] - floor), 0), 1)
      : 1,
  };
};

export const subscriptionSummary = (user: Document) => {
  const tier = normalizedTier(user.subscription_tier ?? user.subscription_role);
  return {
    tier,
    role: normalizedTier(user.subscription_role ?? tier),
    status: String(user.subscription_status ?? "NONE").toUpperCase(),
    started_at: user.subscription_started_at ?? null,
    confirmed_at: user.subscription_confirmed_at ?? null,
    billing_cycle: String(user.subscription_billing_cycle ?? "yearly"),
    is_purchased: Boolean(user.subscription_is_purchased),
    purchase_source: String(user.subscription_purchase_source ?? ""),
    access: [...(subscriptionAccess[tier] ?? [])],
  };
};

export async function serializeMe(_app: FastifyInstance, user: Document) {
  const points = Math.max(Number(user.points ?? 0), 0);
  const completed = Math.max(Number(user.workouts_completed ?? 0), 0);
  const total = Math.max(Number(user.workouts_total ?? completed), completed);
  const streak = Math.max(Number(user.streak_days ?? 0), 0);
  const subscription = subscriptionSummary(user);
  return {
    id: toId(user._id),
    created_at: user.created_at ?? null,
    name: String(user.name ?? ""),
    email: String(user.email ?? ""),
    is_verified: Boolean(user.is_verified),
    role: String(user.role ?? (user.is_admin ? "admin" : "user")),
    is_admin: Boolean(user.is_admin),
    country: String(user.country ?? ""),
    profileImage: String(user.profile_image ?? ""),
    onboarding_completed: Boolean(user.onboarding_completed),
    points,
    workouts_completed: completed,
    workouts_total: total,
    streak_days: streak,
    ...rankProgress(points),
    subscription_tier: subscription.tier,
    subscription_role: subscription.role,
    subscription_status: subscription.status,
    subscription_started_at: subscription.started_at,
    subscription_confirmed_at: subscription.confirmed_at,
    subscription_billing_cycle: subscription.billing_cycle,
    subscription_is_purchased: subscription.is_purchased,
    subscription_purchase_source: subscription.purchase_source,
    subscription_access: subscription.access,
    subscription,
    marketing_consent: Boolean(user.marketing_consent),
  };
}
