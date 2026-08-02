import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildApp } from "../src/app.js";
import { collectionNames } from "../src/db.js";

type Route = { method: string; path: string; source: string };

const projectRoot = resolve(import.meta.dirname, "..");
const pythonRoot = resolve(projectRoot, "..", "victory-fitness-backend", "app");

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? filesBelow(path)
        : Promise.resolve(/\.(py|ts)$/.test(path) ? [path] : []);
    }),
  );
  return nested.flat();
}

const canonicalPath = (path: string): string =>
  path
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{}")
    .replace(/\/$/, "") || "/";

const keyOf = (method: string, path: string): string =>
  `${method.toUpperCase()} ${canonicalPath(path)}`;

async function fastApiRoutes(): Promise<Route[]> {
  const routes: Route[] = [];
  for (const file of await filesBelow(pythonRoot)) {
    const source = await readFile(file, "utf8");
    const pattern =
      /@(app|router)\.(get|post|put|patch|delete|websocket)\(\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      routes.push({
        method: match[2] === "websocket" ? "WS" : match[2]!.toUpperCase(),
        path: match[3]!,
        source: file,
      });
    }
  }
  return routes;
}

async function fastifyRoutes(): Promise<Route[]> {
  const app = await buildApp({ logger: false });
  await app.ready();
  const openapi = app.swagger() as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const routes: Route[] = [];
  for (const [path, operations] of Object.entries(openapi.paths ?? {})) {
    for (const method of Object.keys(operations)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) {
        routes.push({ method: method.toUpperCase(), path, source: "openapi" });
      }
    }
  }
  for (const file of await filesBelow(resolve(projectRoot, "src", "routes"))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(
      /app\.get\(\s*["']([^"']+)["']\s*,\s*\{\s*websocket:\s*true/g,
    )) {
      routes.push({ method: "WS", path: match[1]!, source: file });
    }
  }
  await app.close();
  return routes;
}

const oldRoutes = await fastApiRoutes();
const newRoutes = await fastifyRoutes();
const oldMap = new Map(
  oldRoutes.map((route) => [keyOf(route.method, route.path), route]),
);
const newMap = new Map(
  newRoutes.map((route) => [keyOf(route.method, route.path), route]),
);

const missing = [...oldMap]
  .filter(([key]) => !newMap.has(key))
  .map(([, route]) => route);
const extra = [...newMap]
  .filter(([key]) => !oldMap.has(key))
  .map(([, route]) => route);

const pythonConfig = await readFile(resolve(pythonRoot, "config.py"), "utf8");
const fastifyConfig = await readFile(
  resolve(projectRoot, "src", "config.ts"),
  "utf8",
);
const namesFrom = (source: string, pattern: RegExp): Set<string> =>
  new Set([...source.matchAll(pattern)].map((match) => match[1]!));
const oldEnvironment = namesFrom(
  pythonConfig,
  /(?:_get_str|_get_secret|_get_bool|_get_int|_get_csv_list|os\.getenv)\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
);
const newEnvironment = namesFrom(
  fastifyConfig,
  /(?:value|bool|integer|csv)\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
);
for (const match of fastifyConfig.matchAll(
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
)) {
  newEnvironment.add(match[1]!);
}
const missingEnvironment = [...oldEnvironment].filter(
  (name) => !newEnvironment.has(name),
);
const extraEnvironment = [...newEnvironment].filter(
  (name) => !oldEnvironment.has(name),
);

const pythonDatabase = await readFile(
  resolve(pythonRoot, "database.py"),
  "utf8",
);
const oldCollections = namesFrom(
  pythonDatabase,
  /db\[\s*["']([^"']+)["']\s*\]/g,
);
const newCollections = new Set<string>(collectionNames);
const missingCollections = [...oldCollections].filter(
  (name) => !newCollections.has(name),
);
const extraCollections = [...newCollections].filter(
  (name) => !oldCollections.has(name),
);

console.log(
  JSON.stringify(
    {
      summary: {
        fastapi: oldMap.size,
        fastify: newMap.size,
        covered: oldMap.size - missing.length,
        missing: missing.length,
        extra: extra.length,
        coveragePercent: Number(
          (((oldMap.size - missing.length) / oldMap.size) * 100).toFixed(1),
        ),
      },
      environment: {
        fastapi: oldEnvironment.size,
        fastify: newEnvironment.size,
        covered: oldEnvironment.size - missingEnvironment.length,
        missing: missingEnvironment,
        fastifyOnly: extraEnvironment,
      },
      collections: {
        fastapi: oldCollections.size,
        fastify: newCollections.size,
        missing: missingCollections,
        extra: extraCollections,
      },
      missing: missing.map(({ method, path }) => ({ method, path })),
      extra: extra.map(({ method, path }) => ({ method, path })),
    },
    null,
    2,
  ),
);

if (
  missing.length ||
  extra.length ||
  missingEnvironment.length ||
  missingCollections.length ||
  extraCollections.length
) {
  process.exitCode = 1;
}
