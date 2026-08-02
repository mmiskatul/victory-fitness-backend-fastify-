import "dotenv/config";
import { readFileSync } from "node:fs";

const value = (name: string, fallback = ""): string => {
  const current = process.env[name]?.trim();
  if (!current || current.includes("<") || current.includes(">")) {
    return fallback;
  }
  return current;
};

const bool = (name: string, fallback: boolean): boolean => {
  const current = process.env[name]?.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(current ?? "")) return true;
  if (["0", "false", "no", "off"].includes(current ?? "")) return false;
  return fallback;
};

const integer = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(value(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const csv = (name: string, fallback = ""): string[] =>
  value(name, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const environment = value("ENVIRONMENT", "development").toLowerCase();
const isVercel = Boolean(process.env.VERCEL);
const firebaseServiceAccount = (() => {
  const inline = value("FIREBASE_SERVICE_ACCOUNT_JSON");
  const path = value("FIREBASE_SERVICE_ACCOUNT_JSON_PATH");
  try {
    const parsed = JSON.parse(
      inline || (path ? readFileSync(path, "utf8") : "{}"),
    ) as Record<string, unknown>;
    return parsed;
  } catch {
    return {} as Record<string, unknown>;
  }
})();

export const config = {
  appName: value("APP_NAME", "Victory Fitness API"),
  environment,
  nodeEnv: value("NODE_ENV", environment),
  isVercel,
  host: value("HOST", "0.0.0.0"),
  port: integer("PORT", 8000),
  startupJobsEnabled: bool("STARTUP_JOBS_ENABLED", !isVercel),
  slowRequestThresholdMs: integer("SLOW_REQUEST_THRESHOLD_MS", 800),
  mongodbUri: value("MONGODB_URI"),
  databaseUrl: value("DATABASE_URL", value("MONGODB_URI")),
  mongodbDb: value("MONGODB_DB", "victory_fitness"),
  mongodbMaxPoolSize: integer("MONGODB_MAX_POOL_SIZE", 50),
  mongodbMinPoolSize: integer("MONGODB_MIN_POOL_SIZE", 1),
  jwtSecretKey: value("JWT_SECRET_KEY", "change-this-to-a-long-random-secret"),
  jwtSecret: value(
    "JWT_SECRET",
    value("JWT_SECRET_KEY", "change-this-to-a-long-random-secret"),
  ),
  sessionSecret: value(
    "SESSION_SECRET",
    value("JWT_SECRET_KEY", "change-this-to-a-long-random-secret"),
  ),
  jwtAlgorithm: value("JWT_ALGORITHM", "HS256"),
  accessTokenExpireMinutes: integer("ACCESS_TOKEN_EXPIRE_MINUTES", 10),
  sessionTokenExpireDays: integer("SESSION_TOKEN_EXPIRE_DAYS", 30),
  corsOrigin: value("CORS_ORIGIN", value("CORS_ORIGINS", "*")),
  corsAllowAll: bool("CORS_ALLOW_ALL", false),
  corsOriginRegex: value("CORS_ORIGIN_REGEX"),
  cookieSecure: bool("COOKIE_SECURE", environment === "production"),
  cookieSameSite: value(
    "COOKIE_SAMESITE",
    environment === "production" ? "none" : "lax",
  ) as "lax" | "strict" | "none",
  smtp: {
    host: value("SMTP_HOST"),
    port: integer("SMTP_PORT", 587),
    username: value("SMTP_USERNAME"),
    password: value("SMTP_PASSWORD"),
    fromEmail: value("SMTP_FROM_EMAIL", value("SMTP_USERNAME")),
    fromName: value("SMTP_FROM_NAME", "Victory Fitness"),
    useTls: bool("SMTP_USE_TLS", true),
  },
  openaiApiKey: value("OPENAI_API_KEY"),
  openaiModel: value("OPENAI_MODEL", "gpt-5.5"),
  openaiMealAnalysisModel: value("OPENAI_MEAL_ANALYSIS_MODEL", "gpt-4o-mini"),
  anthropicApiKey: value("ANTHROPIC_API_KEY"),
  anthropicModel: value("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
  vimeoAccessToken: value("VIMEO_ACCESS_TOKEN"),
  coachRecentMessageLimit: integer("COACH_RECENT_MESSAGE_LIMIT", 40),
  coachArchiveBatchSize: integer("COACH_ARCHIVE_BATCH_SIZE", 20),
  aws: {
    region: value("AWS_REGION"),
    accessKeyId: value("AWS_ACCESS_KEY_ID"),
    secretAccessKey: value("AWS_SECRET_ACCESS_KEY"),
    bucket: value("AWS_S3_BUCKET"),
    prefix: value("AWS_S3_PREFIX", "coach-archives").replace(/^\/+|\/+$/g, ""),
  },
  admin: {
    seedEnabled: bool("ADMIN_SEED_ENABLED", true),
    name: value("ADMIN_NAME", "Victory Admin"),
    email: value("ADMIN_EMAIL", "admin@victoryfitness.com").toLowerCase(),
    password: value("ADMIN_PASSWORD"),
    seedSyncPassword: bool("ADMIN_SEED_SYNC_PASSWORD", true),
  },
  googleClientId: value("GOOGLE_CLIENT_ID"),
  googleClientSecret: value("GOOGLE_CLIENT_SECRET"),
  googleProjectId: value("GOOGLE_PROJECT_ID"),
  firebaseProjectId: value("FIREBASE_PROJECT_ID", value("GOOGLE_PROJECT_ID")),
  firebaseClientEmail: value(
    "FIREBASE_CLIENT_EMAIL",
    String(firebaseServiceAccount.client_email ?? ""),
  ),
  firebasePrivateKey: value(
    "FIREBASE_PRIVATE_KEY",
    String(firebaseServiceAccount.private_key ?? ""),
  ).replace(/\\n/g, "\n"),
  firebaseCertUrl: value(
    "FIREBASE_AUTH_PROVIDER_CERT_URL",
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com",
  ),
  googleCertUrl: value(
    "GOOGLE_AUTH_PROVIDER_CERT_URL",
    "https://www.googleapis.com/oauth2/v1/certs",
  ),
  cronSecret: value("CRON_SECRET"),
  webhookSigningSecret: value("WEBHOOK_SIGNING_SECRET"),
  healthNativeUploadSecret: value("HEALTH_NATIVE_UPLOAD_SECRET"),
  wearableTokenEncryptionKey: value("WEARABLE_TOKEN_ENCRYPTION_KEY"),
  encryptionKey: value(
    "ENCRYPTION_KEY",
    value("WEARABLE_TOKEN_ENCRYPTION_KEY"),
  ),
  wearableSchedulerEnabled: bool("WEARABLE_SCHEDULER_ENABLED", true),
  wearableSchedulerIntervalMinutes: integer(
    "WEARABLE_SCHEDULER_INTERVAL_MINUTES",
    30,
  ),
  wearableSchedulerLookbackDays: integer("WEARABLE_SCHEDULER_LOOKBACK_DAYS", 1),
  syncQueueConcurrency: integer("SYNC_QUEUE_CONCURRENCY", 5),
  syncRetryAttempts: integer("SYNC_RETRY_ATTEMPTS", 3),
  syncRetryBackoffMs: integer("SYNC_RETRY_BACKOFF_MS", 5000),
  rateLimitTtl: integer("RATE_LIMIT_TTL", 60),
  rateLimitMax: integer("RATE_LIMIT_MAX", 100),
  fitbit: {
    clientId: value("FITBIT_CLIENT_ID"),
    clientSecret: value("FITBIT_CLIENT_SECRET"),
    redirectUri: value("FITBIT_REDIRECT_URI"),
    authUrl: value(
      "FITBIT_AUTH_URL",
      "https://www.fitbit.com/oauth2/authorize",
    ),
    tokenUrl: value("FITBIT_TOKEN_URL", "https://api.fitbit.com/oauth2/token"),
    apiBaseUrl: value("FITBIT_API_BASE_URL", "https://api.fitbit.com").replace(
      /\/$/,
      "",
    ),
    scopes: csv("FITBIT_SCOPES", "activity,heartrate,sleep,profile"),
  },
  garmin: {
    enabled: bool("GARMIN_ENABLED", false),
    clientId: value("GARMIN_CLIENT_ID"),
    clientSecret: value("GARMIN_CLIENT_SECRET"),
    consumerKey: value("GARMIN_CONSUMER_KEY"),
    consumerSecret: value("GARMIN_CONSUMER_SECRET"),
    redirectUri: value("GARMIN_REDIRECT_URI"),
    authorizeUrl: value("GARMIN_AUTHORIZE_URL"),
    tokenUrl: value("GARMIN_TOKEN_URL"),
    apiBaseUrl: value("GARMIN_API_BASE_URL").replace(/\/$/, ""),
    dailySummaryPath: value(
      "GARMIN_DAILY_SUMMARY_PATH",
      "/wellness-api/rest/dailies",
    ),
    scopes: csv("GARMIN_SCOPES"),
    webhookSecret: value("GARMIN_WEBHOOK_SECRET"),
  },
  googleFit: {
    authUri: value(
      "GOOGLE_AUTH_URI",
      "https://accounts.google.com/o/oauth2/auth",
    ),
    tokenUri: value("GOOGLE_TOKEN_URI", "https://oauth2.googleapis.com/token"),
    redirectUri: value("GOOGLE_FIT_REDIRECT_URI"),
    apiBaseUrl: value(
      "GOOGLE_FIT_API_BASE_URL",
      "https://www.googleapis.com/fitness/v1",
    ),
    scopes: csv(
      "GOOGLE_FIT_SCOPES",
      "https://www.googleapis.com/auth/fitness.activity.read,https://www.googleapis.com/auth/fitness.location.read,https://www.googleapis.com/auth/fitness.heart_rate.read",
    ),
  },
} as const;

export const defaultCorsOrigins = [
  "https://victory-fitness-dashboard.vercel.app",
  "https://victory-fitness-app.vercel.app",
  "https://victora-web-app.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8081",
];

export const defaultCorsOriginPattern =
  /^https:\/\/(victory-fitness-dashboard|victory-fitness-app|victora-web-app|victory-fitness-backend)(?:-[a-z0-9-]+)?-miskatul-masabis-projects\.vercel\.app$/;
