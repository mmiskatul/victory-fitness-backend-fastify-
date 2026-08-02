import { describe, expect, it } from "vitest";
import { trialEngagementUpdate } from "../src/services/trial-engagement.js";

describe("trial engagement parity", () => {
  const now = new Date("2026-08-01T12:00:00.000Z");

  it("records a Coach Victor message during trial days zero through five", () => {
    expect(
      trialEngagementUpdate(
        { subscription_started_at: new Date("2026-07-30T13:00:00.000Z") },
        "coach_message",
        now,
      ),
    ).toEqual({
      $addToSet: { "trial_engagement.days": 1 },
      $inc: { "trial_engagement.coach_messages": 1 },
    });
  });

  it("records nutrition creation and ignores activity outside the trial", () => {
    expect(
      trialEngagementUpdate(
        { subscription_started_at: "2026-08-01T00:00:00.000Z" },
        "nutrition_plan",
        now,
      ),
    ).toEqual({
      $addToSet: { "trial_engagement.days": 0 },
      $set: { "trial_engagement.nutrition_plan_created_at": now },
    });
    expect(
      trialEngagementUpdate(
        { subscription_started_at: new Date("2026-07-20T00:00:00.000Z") },
        "coach_message",
        now,
      ),
    ).toBeNull();
    expect(trialEngagementUpdate({}, "coach_message", now)).toBeNull();
  });
});
