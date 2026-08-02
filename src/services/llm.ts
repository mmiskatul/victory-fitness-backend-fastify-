import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

type Message = { role: "system" | "user" | "assistant"; content: string };

export async function generateText(
  messages: Message[],
  model = config.openaiModel,
): Promise<string> {
  if (config.openaiApiKey) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new AppError(
        502,
        `OpenAI request failed with status ${response.status}`,
      );
    }
    const payload = (await response.json()) as any;
    return String(payload.choices?.[0]?.message?.content ?? "").trim();
  }
  if (config.anthropicApiKey) {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    const normalized = messages.filter((message) => message.role !== "system");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 4096,
        system,
        messages: normalized,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new AppError(
        502,
        `Anthropic request failed with status ${response.status}`,
      );
    }
    const payload = (await response.json()) as any;
    return String(payload.content?.[0]?.text ?? "").trim();
  }
  throw new AppError(503, "AI provider is not configured");
}

export async function generateJson<T>(prompt: string, fallback: T): Promise<T> {
  try {
    const text = await generateText([
      {
        role: "system",
        content: "Return valid JSON only. Do not use markdown fences.",
      },
      { role: "user", content: prompt },
    ]);
    const normalized = text
      .replace(/^\s*```(?:json)?/i, "")
      .replace(/```\s*$/, "")
      .trim();
    return JSON.parse(normalized) as T;
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 503) return fallback;
    throw error;
  }
}
