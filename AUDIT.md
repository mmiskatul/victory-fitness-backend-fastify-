# FastAPI to Fastify parity audit

Audit date: 2026-08-01

Source: `../victory-fitness-backend`

Target: this Fastify 5 and TypeScript project

## Verified structural parity

Run `npm run audit:parity` to repeat the source scan and application inspection.

| Surface                                         | FastAPI | Fastify | Result                                                                |
| ----------------------------------------------- | ------: | ------: | --------------------------------------------------------------------- |
| Normalized HTTP and WebSocket method/path pairs |     208 |     208 | No missing or extra routes                                            |
| Source environment variables                    |      95 |      97 | All 95 supported; `HOST` and `PORT` are Fastify-only runtime settings |
| MongoDB collection names                        |      30 |      30 | Exact match                                                           |

The FastAPI source contains 69 raw `create_index` calls. The Fastify database setup contains 68 normalized index specifications because Python declares the `users.email` unique index twice, once sparse and once non-sparse. Recreating both definitions would conflict in MongoDB. All distinct intended index surfaces are represented, and Fastify startup collapses duplicate health snapshots before enforcing their unique indexes.

## Third-audit updates

- Added `npm run audit:contracts`, which loads the live FastAPI OpenAPI document and compares all 207 HTTP method/path pairs with Fastify. It checks documented parameters, request bodies, response status codes, and authentication metadata separately from route existence.
- Corrected wearable connection envelopes, native Apple Health/Health Connect ingestion, provider aliases, QR/file imports, health filters, current-metric backfill, disconnect responses, deduplication, and webhook response bodies.
- Corrected community image/video upload handling and limits, S3 cleanup, post/comment serialization, like toggling, list envelopes, permissions, and cascade deletion behavior.
- Corrected challenge enrollment idempotency and rejoin behavior, join chat events, progress field names, and admin challenge list envelopes.
- Corrected public workout-library access and response shape, admin workout serialization, Vimeo field mapping, publish-state preservation, sync summaries, and sync debug responses.
- Corrected Longevity OS dashboard, habits, heal-category, and generated weekly-plan response contracts, including profile defaults and wearable status projection.
- Corrected journal validation and serialization, latest-entry analysis, Coach Victor threads/messages, nutrition plan/job envelopes, meal-analysis flattening, strength-plan list/detail/delete contracts, and completion-report response shape.
- Corrected admin user/subscriber/management summaries, coaching/support/masterclass envelopes, push-token validation, and subscription activation semantics.
- Added regression tests for wearable normalization/deduplication and FastAPI-compatible community media limits.

## Fourth-audit updates

- Restored Python-compatible Fernet encryption for migrated wearable OAuth tokens, while retaining read compatibility for tokens written by the earlier Fastify AES-GCM implementation.
- Added the missing wearable worker, retries/backoff, scheduled sync queueing, Fitbit/Google Fit/Garmin pulls and token refresh, Garmin raw-body HMAC validation, and startup health-current backfill.
- Corrected worker/dashboard queries to use Python's physical `user_provider_connections` collection; `wearable_connections` is only a Python code alias.
- Restored the exact Longevity wearable response and made its sync endpoint actively pull selected or connected providers.
- Corrected migrated `app_content` keys and single-document formats for policies, FAQs, notifications, plans, masterclasses, onboarding, and homepage quotes.
- Corrected coaching-application and support-message status/storage/serialization and restored Python's default content.
- Added MongoDB and S3 Coach Victor history archival and rehydration. Legacy `messages` threads migrate without losing old turns; model context matches Python's latest 12 messages.
- Restored Vimeo project/showcase discovery, module tags, standalone-video deduplication, provider visibility, and module/video counts.
- Restored stateful strength-plan progress at day, section, and exercise level.
- Replaced the static strength image and incorrect challenge JSON report with personalized PNG completion reports and compatible share text.
- Added TXT/Markdown/CSV/JSON/XML/YAML/log, RTF, PDF, and DOCX extraction for meal analysis, including Python's explicit legacy `.doc` error.

## Fifth-audit updates

- Extended `audit:contracts` to recursively compare request object fields, required/optional markers, nested arrays/objects, primitive types, and enums. The initial deep pass found 65 request-schema differences; all are now resolved.
- Ported exact wearable, journal/AI, user/admin, content, notification, coaching/support, community, challenge, masterclass, workout, and presigned-upload request contracts.
- Restored community audio uploads and cleanup with Python-compatible MIME types and the 25 MB limit.
- Restored workout video/thumbnail base64 uploads, provider URL normalization, duplicate-video rejection, direct-upload restrictions, and S3 cleanup on replacement or deletion.
- Restored masterclass video/audio uploads, URL normalization, ordering, clear-audio behavior, and S3 cleanup.
- Corrected challenge overview/detail/chat envelopes, membership enforcement for HTTP and WebSocket chat, message-to-challenge scoping, soft deletion, reaction validation, participant/unread/progress data, and WebSocket event names.
- Aligned generated OpenAPI parameter names and types, optional body metadata, authentication declarations, and success/validation statuses with FastAPI.

## Sixth-audit updates

- Rechecked all route, environment-variable, collection, request-schema, status, and security inventories; structural parity remains exact.
- Restored active-user analytics from unique workout, nutrition-plan, and Coach Victor activity in the current and previous reporting periods.
- Added the missing day-zero-through-five trial engagement writes for Coach Victor messages and nutrition-plan creation, with regression coverage.
- Restored challenge availability, chat-participant, challenge-start, milestone, Coach Victor reply, and workout-publication notifications.
- Restored challenge `@coach` AI replies, active-challenge chat rules, completed-member chat access, progress chat events, response serialization, and admin deletion metadata.
- Corrected the full admin challenge-chat thread response, including participants, author hydration, reactions, progress defaults, and the 200-message history limit.
- Corrected admin community search, 200-comment post payloads, reaction-user details, contributor rankings, hashtag trends, flagged-post responses, and shortcut metadata.
- Corrected runtime-only dynamic responses that OpenAPI cannot describe precisely: root/health, wearable backfill, admin user deletion, and admin audit logs.
- Aligned invalid admin challenge, user, and workout identifiers with FastAPI's `400` responses.

## Contract audit interpretation

The strict OpenAPI comparison now reports zero differences across all 207 comparable HTTP operations. It compares parameter location/name/required/type metadata, request-body required/content metadata, recursive request schemas, documented response statuses, and authentication declarations. The 208th parity route is the challenge WebSocket, which is covered by the route parity audit but is not represented as a normal OpenAPI operation.

The OpenAPI transformation publishes FastAPI-compatible snake-case path parameter names, cookie/header/query metadata, optional-body declarations, security metadata, and `422` responses. Runtime validation and authentication remain implemented by Fastify route schemas and handlers.

## Verification completed

- `npm run typecheck`
- `npm run lint`
- `npm test` - 4 files, 16 tests passed
- `npm run build`
- `npm run audit:parity` - 208/208 routes, 95/95 source environment variables, 30/30 collections
- `npm run audit:contracts` - all 207 HTTP routes compared; zero parameter, body, request-schema, response-status, or security differences
- `npm audit --omit=dev` - 0 vulnerabilities

The original backend's built-in `unittest` suite was also run: 28 of 29 tests passed. Its `test_admin_delete_community_post_cleans_up_media` currently receives `401` instead of its expected `204` in the original FastAPI application. Fastify's admin-delete implementation does perform comment/reaction and image/video cleanup; the failing source test was not hidden or counted as a Fastify failure.

## Remaining production-validation work

Structural parity does not establish identical runtime behavior. Do not switch all production traffic until these areas have differential tests against both services:

- Generated SDK consumers should still be exercised against a staging deployment even though the audited OpenAPI surfaces now match.
- Health normalization, Coach archives, and migrated content have compatibility handling, but a staging database clone is still required to validate the project's real historical documents and provider edge cases.
- AI prompts are functionally equivalent, but non-deterministic provider output cannot be byte-for-byte identical to Python.
- Push/email/provider flows need staging credentials and failure/retry tests. Unit tests do not exercise real MongoDB, OAuth providers, SMTP, Expo, Firebase, OpenAI, Anthropic, S3, or Vimeo.
- WebSocket fan-out, concurrent progress updates, cron overlap, idempotency, and legacy MongoDB document shapes require load and integration testing.

Recommended cutover: run both backends against a staging database clone, replay mobile/dashboard workflows, compare status/body/database side effects, and move traffic domain by domain.
