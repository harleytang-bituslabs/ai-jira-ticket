/**
 * Thin Anthropic wrapper for structured generation.
 *
 * Uses the SDK's structured outputs (messages.parse + zodOutputFormat) so the
 * API itself guarantees schema-shaped JSON — no fence-stripping or manual
 * repair parsing. The SDK also validates client-side against the full zod
 * schema and retries transport errors on its own (maxRetries below).
 *
 * The system prompt gets an ephemeral cache_control marker: callers keep it
 * byte-identical across calls (it embeds the spec cache verbatim), so
 * repeated drafts hit the Anthropic prompt cache.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { internal, invalid, upstream, type AppError } from "../core/errors.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw internal("anthropic_unconfigured", "AI 服务未配置，请联系管理员", {
        detail: "ANTHROPIC_API_KEY is not set — put it in .env",
      });
    }
    client = new Anthropic({ maxRetries: 4 });
  }
  return client;
}

/**
 * The SDK's APIError carries a top-level `status`. Letting it travel meant a
 * revoked API key surfaced to the browser as a 401, which the frontend reads as
 * "your session expired" — one dead key logged everybody out. Provenance is
 * recorded here, while we still know the 401 came from Anthropic.
 *
 * maxRetries has already been exhausted by the time anything escapes, so every
 * case below is terminal.
 */
function anthropicError(err: unknown): AppError {
  if (!(err instanceof Anthropic.APIError)) {
    const name = (err as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return upstream("upstream_timeout", "AI 服务未在超时时间内响应，请重试", { cause: err });
    }
    return upstream("anthropic_unavailable", "AI 服务暂时不可用，请稍后重试", {
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      cause: err,
    });
  }
  const detail = `HTTP ${String(err.status)} ${err.type ?? ""} ${err.message}`.trim();
  if (err.status === 401 || err.status === 403 || err.status === 402) {
    return upstream("anthropic_auth", "AI 服务认证失败，请联系管理员检查 API key", { detail, cause: err });
  }
  if (err.status === 429 || err.status === 529 || (typeof err.status === "number" && err.status >= 500)) {
    return upstream("anthropic_unavailable", "AI 服务繁忙或暂时不可用，请稍后重试", { detail, cause: err });
  }
  if (err.status === 400) {
    // Our request was malformed — a bug on our side, not the user's input.
    return internal("anthropic_bad_request", "AI 请求构造有误，请把排查码发给维护者", { detail, cause: err });
  }
  return upstream("anthropic_unavailable", "AI 服务返回了错误，请稍后重试", { detail, cause: err });
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface StructuredResult<T> {
  output: T;
  usage: TokenUsage;
}

export async function generateStructured<Schema extends z.ZodType>(opts: {
  model: string;
  system: string;
  messages: ChatMessage[];
  schema: Schema;
  maxTokens?: number;
}): Promise<StructuredResult<z.infer<Schema>>> {
  let response;
  try {
    response = await getClient().messages.parse({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 16_000,
      thinking: { type: "adaptive" },
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      output_config: { format: zodOutputFormat(opts.schema) },
      messages: opts.messages,
    });
  } catch (err) {
    throw anthropicError(err);
  }

  if (response.stop_reason === "refusal") {
    throw invalid("llm_refusal", "模型拒绝了这个请求，请换个说法重试", {
      detail: "stop_reason: refusal",
    });
  }
  if (response.stop_reason === "max_tokens") {
    throw invalid("llm_truncated", "内容过长，模型没写完就到上限了 —— 请缩短输入或减少拆票数量", {
      detail: "stop_reason: max_tokens",
    });
  }
  if (response.parsed_output == null) {
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .slice(0, 300);
    throw upstream("llm_schema", "模型输出不符合预期格式，请重试", {
      detail: `Model output failed schema validation. First 300 chars:\n${text}`,
    });
  }

  const u = response.usage;
  return {
    output: response.parsed_output as z.infer<Schema>,
    usage: {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}
