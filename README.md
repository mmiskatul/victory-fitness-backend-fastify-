# Victory Fitness Fastify Backend

Independent Fastify 5 and TypeScript rewrite of `victory-fitness-backend`. The Python service is not modified. The service reads and writes the existing MongoDB database and preserves the existing collection names and JWT/cookie names.

## Run locally

```powershell
cd C:\Miskat\victora\backend
Copy-Item .env.example .env
# Add the same secrets used by victory-fitness-backend/.env
npm install
npm run dev
```

The API listens on `http://localhost:8000`. Swagger is available at `/docs`.

## Verification

```powershell
npm run check
npm audit --omit=dev
```

`npm run check` includes the repeatable FastAPI/Fastify structural parity audit. See [AUDIT.md](./AUDIT.md) for the current results and remaining production-validation work.

## Implemented domains

- Fastify lifecycle, CORS, rate limiting, cookies, multipart, Swagger and WebSockets
- MongoDB connection lifecycle, existing collection names, indexes and admin seed
- Registration, email verification, login, refresh, logout and password recovery
- Google and Firebase identity-token verification
- User/admin profiles, onboarding, subscriptions, notifications and body metrics
- S3 images and presigned uploads
- Content, FAQs, subscription plans and homepage quotes
- Workouts and Vimeo synchronization
- Community posts, multipart images, comments, reactions, broadcasts and moderation views
- Challenges, membership, progress, reports, chat, reactions and live WebSocket updates
- Journal entries and AI analysis
- Coach Victor, nutrition plans/jobs/advice, meal analysis and strength plans
- Longevity dashboard, habits, weekly plans, masterclasses and circles
- Applications, support messages and user administration
- Wearable connection state, native health ingestion, sync jobs and health-data queries
- Trial/win-back jobs, challenge reminders, admin notifications and dashboard analytics
- Docker and Vercel entry points

## Cutover warning

The structural audit now matches all 208 FastAPI HTTP/WebSocket method-path pairs, all 95 source environment variables, and all 30 MongoDB collection names. This still must not replace production solely on structural parity. Before cutover, add recorded contract tests against a staging MongoDB clone for every mobile and dashboard workflow. The main remaining implementation gap is the provider-specific wearable remote-sync/token-refresh scheduler and Garmin webhook verification; exact Pydantic response/error and AI-output parity also require differential testing.

Run both services side by side and switch clients domain-by-domain after their contract tests pass.
