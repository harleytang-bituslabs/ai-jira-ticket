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

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not configured — set it in .env");
    }
    client = new Anthropic({ maxRetries: 4 });
  }
  return client;
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
  const response = await getClient().messages.parse({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16_000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    output_config: { format: zodOutputFormat(opts.schema) },
    messages: opts.messages,
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined this request (stop_reason: refusal). Rephrase the input and try again.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Model output hit the token limit before completing — shorten the input or raise maxTokens.");
  }
  if (response.parsed_output == null) {
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .slice(0, 300);
    throw new Error(`Model output failed schema validation. First 300 chars:\n${text}`);
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
