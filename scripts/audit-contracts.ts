import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { buildApp } from "../src/app.js";

type OpenApi = {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};
type Schema = Record<string, any>;
type Operation = {
  parameters?: Array<Record<string, any>>;
  requestBody?: Record<string, any>;
  responses?: Record<string, Record<string, any>>;
  security?: Array<Record<string, string[]>>;
};

const projectRoot = resolve(import.meta.dirname, "..");
const pythonRoot = resolve(projectRoot, "..", "victory-fitness-backend");
const python = resolve(pythonRoot, ".venv", "Scripts", "python.exe");
const methods = new Set(["get", "post", "put", "patch", "delete"]);
const canonicalPath = (path: string): string =>
  path.replace(/\{[^}]+\}/g, "{}").replace(/\/$/, "") || "/";
const routeKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${canonicalPath(path)}`;

const generated = spawnSync(
  python,
  [
    "-c",
    "import json; from app.main import app; print(json.dumps(app.openapi()))",
  ],
  { cwd: pythonRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (generated.status !== 0) {
  throw new Error(generated.stderr || "Unable to generate FastAPI OpenAPI");
}
const oldApi = JSON.parse(generated.stdout) as OpenApi;
const app = await buildApp({ logger: false });
await app.ready();
const newApi = app.swagger() as OpenApi;

function resolveSchema(api: OpenApi, schema: Schema | undefined): Schema {
  if (!schema) return {};
  if (schema.$ref) {
    const name = String(schema.$ref).split("/").at(-1) ?? "";
    return resolveSchema(api, api.components?.schemas?.[name]);
  }
  return schema;
}

function schemaType(api: OpenApi, raw: Schema): string {
  const schema = resolveSchema(api, raw);
  if (schema.type) return String(schema.type);
  if (schema.properties) return "object";
  if (schema.anyOf) {
    return schema.anyOf
      .map((item: Schema) => schemaType(api, item))
      .filter((type: string) => type !== "null")
      .sort()
      .join("|");
  }
  return "unknown";
}

function schemaSignature(
  api: OpenApi,
  raw: Schema | undefined,
  prefix = "$",
  seen = new Set<string>(),
): string[] {
  if (!raw) return [];
  if (raw.$ref) {
    const name = String(raw.$ref).split("/").at(-1) ?? "";
    if (seen.has(name)) return [`${prefix}:recursive:${name}`];
    return schemaSignature(
      api,
      resolveSchema(api, raw),
      prefix,
      new Set([...seen, name]),
    );
  }
  const schema = resolveSchema(api, raw);
  if (schema.anyOf) {
    const alternatives = schema.anyOf.filter(
      (item: Schema) => schemaType(api, item) !== "null",
    );
    if (alternatives.length === 1) {
      return schemaSignature(api, alternatives[0], prefix, seen);
    }
    const alternativeTypes = [
      ...new Set(alternatives.map((item: Schema) => schemaType(api, item))),
    ];
    if (
      alternativeTypes.length === 1 &&
      alternatives.every(
        (item: Schema) =>
          resolveSchema(api, item).const !== undefined ||
          Array.isArray(resolveSchema(api, item).enum),
      )
    ) {
      const values = alternatives
        .flatMap((item: Schema) => {
          const resolved = resolveSchema(api, item);
          return resolved.const !== undefined
            ? [resolved.const]
            : resolved.enum;
        })
        .map(String)
        .sort();
      return [`${prefix}:${alternativeTypes[0]}:${values.join("|")}`];
    }
  }
  const type = schemaType(api, schema);
  const enumValues = Array.isArray(schema.enum)
    ? `:${schema.enum.map(String).sort().join("|")}`
    : schema.const !== undefined
      ? `:${String(schema.const)}`
      : "";
  const result = [`${prefix}:${type}${enumValues}`];
  if (type === "object") {
    const required = new Set<string>(schema.required ?? []);
    for (const [name, property] of Object.entries(schema.properties ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const child = `${prefix}.${name}${required.has(name) ? "!" : "?"}`;
      result.push(...schemaSignature(api, property as Schema, child, seen));
    }
  } else if (type === "array") {
    result.push(...schemaSignature(api, schema.items, `${prefix}[]`, seen));
  }
  return result;
}

function requestSchema(operation: Operation): Schema | undefined {
  const content = operation.requestBody?.content ?? {};
  return (
    content["application/json"]?.schema ??
    content["multipart/form-data"]?.schema ??
    Object.values(content)[0]?.schema
  );
}

function operations(api: OpenApi) {
  const result = new Map<
    string,
    { path: string; method: string; operation: Operation }
  >();
  for (const [path, pathItem] of Object.entries(api.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (methods.has(method)) {
        result.set(routeKey(method, path), { path, method, operation });
      }
    }
  }
  return result;
}

function parameterSignature(operation: Operation): string[] {
  return (operation.parameters ?? [])
    .map((parameter) => {
      const schema = parameter.schema ?? {};
      const type = schema.type ?? (schema.anyOf ? "union" : "unknown");
      return `${parameter.in}:${parameter.name}:${parameter.required ? "required" : "optional"}:${type}`;
    })
    .sort();
}

function requestSignature(operation: Operation): {
  required: boolean;
  content: string[];
} | null {
  if (!operation.requestBody) return null;
  return {
    required: Boolean(operation.requestBody.required),
    content: Object.keys(operation.requestBody.content ?? {}).sort(),
  };
}

function responseSignature(operation: Operation): string[] {
  return Object.keys(operation.responses ?? {}).sort();
}

const oldOperations = operations(oldApi);
const newOperations = operations(newApi);
const mismatches: Array<Record<string, unknown>> = [];
const counters = {
  checked: 0,
  parameters: 0,
  requestBody: 0,
  requestSchema: 0,
  responses: 0,
  security: 0,
};
for (const [key, oldRoute] of oldOperations) {
  const newRoute = newOperations.get(key);
  if (!newRoute) continue;
  counters.checked += 1;
  const differences: Record<string, unknown> = {};
  const oldParameters = parameterSignature(oldRoute.operation);
  const newParameters = parameterSignature(newRoute.operation);
  if (JSON.stringify(oldParameters) !== JSON.stringify(newParameters)) {
    counters.parameters += 1;
    differences.parameters = { fastapi: oldParameters, fastify: newParameters };
  }
  const oldRequest = requestSignature(oldRoute.operation);
  const newRequest = requestSignature(newRoute.operation);
  if (JSON.stringify(oldRequest) !== JSON.stringify(newRequest)) {
    counters.requestBody += 1;
    differences.requestBody = { fastapi: oldRequest, fastify: newRequest };
  }
  const oldRequestSchema = schemaSignature(
    oldApi,
    requestSchema(oldRoute.operation),
  );
  const newRequestSchema = schemaSignature(
    newApi,
    requestSchema(newRoute.operation),
  );
  if (JSON.stringify(oldRequestSchema) !== JSON.stringify(newRequestSchema)) {
    counters.requestSchema += 1;
    differences.requestSchema = {
      fastapi: oldRequestSchema,
      fastify: newRequestSchema,
    };
  }
  const oldResponses = responseSignature(oldRoute.operation);
  const newResponses = responseSignature(newRoute.operation);
  if (JSON.stringify(oldResponses) !== JSON.stringify(newResponses)) {
    counters.responses += 1;
    differences.responses = { fastapi: oldResponses, fastify: newResponses };
  }
  const oldSecurity = Boolean(oldRoute.operation.security?.length);
  const newSecurity = Boolean(newRoute.operation.security?.length);
  if (oldSecurity !== newSecurity) {
    counters.security += 1;
    differences.security = { fastapi: oldSecurity, fastify: newSecurity };
  }
  if (Object.keys(differences).length) {
    mismatches.push({ route: key, ...differences });
  }
}

const summary = {
  ...counters,
  routesWithDocumentedContractDifferences: mismatches.length,
};
console.log(
  JSON.stringify(
    process.argv.includes("--summary") ? { summary } : { summary, mismatches },
    null,
    2,
  ),
);
await app.close();
