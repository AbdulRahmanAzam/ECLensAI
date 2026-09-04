/**
 * The single boundary between ECLens and the Gemini API.
 *
 * Everything above this file speaks `GeminiClient`, a small interface with two
 * methods. That seam is what lets the test suite run a deterministic fake model
 * instead of the network, and it is also what keeps `@google/genai` out of the
 * rest of the codebase: no other module imports it, so a future SDK change or a
 * provider swap touches one file.
 *
 * The SDK is loaded lazily and defensively. If it cannot be required, the client
 * reports itself unconfigured rather than throwing at import time — a broken AI
 * dependency must never stop the ledger, the engine or the REST API from
 * starting.
 */
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { aiRateLimited, aiTimeout, aiUnavailable, isTransientAiFailure } from './aiErrors';

// ---------------------------------------------------------------------------
// Provider-neutral request/response shapes
// ---------------------------------------------------------------------------

export type AiRole = 'user' | 'model';

export interface AiTextPart {
  text: string;
}

export interface AiFunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> };
}

export type AiPart = AiTextPart | AiFunctionResponsePart;

export interface AiContent {
  role: AiRole;
  parts: AiPart[];
}

export type AiSchemaType = 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY' | 'OBJECT';

/** A plain JSON Schema subset. Gemini accepts this shape for structured output. */
export interface AiJsonSchema {
  type: AiSchemaType;
  description?: string;
  enum?: string[];
  nullable?: boolean;
  items?: AiJsonSchema;
  properties?: Record<string, AiJsonSchema>;
  required?: string[];
  propertyOrdering?: string[];
}

export interface AiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: AiJsonSchema;
}

export interface GeminiGenerateRequest {
  model: string;
  contents: AiContent[];
  systemInstruction?: string;
  /** Present only during the evidence-gathering phase. */
  functionDeclarations?: AiFunctionDeclaration[];
  /** `ANY` forces a tool call; `NONE` forbids one. */
  toolChoice?: 'AUTO' | 'ANY' | 'NONE';
  /** When set, the response is constrained JSON rather than prose. */
  responseSchema?: AiJsonSchema;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
}

export interface GeminiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  thoughtsTokens: number;
}

export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiGenerateResult {
  text: string | null;
  functionCalls: GeminiFunctionCall[];
  finishReason: string | null;
  usage: GeminiUsage;
  modelVersion: string | null;
  /** True when a safety filter stopped generation before any content. */
  blocked: boolean;
  blockReason: string | null;
  attempts: number;
}

export interface GeminiEmbedRequest {
  model: string;
  texts: string[];
  timeoutMs: number;
}

export interface GeminiClient {
  /** False when there is no usable API key, so callers can degrade honestly. */
  readonly configured: boolean;
  generate(request: GeminiGenerateRequest): Promise<GeminiGenerateResult>;
  embed(request: GeminiEmbedRequest): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Retry with bounded exponential backoff
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries only transient failures — throttling, timeouts, upstream 5xx.
 * A schema violation or a blocked prompt is not transient: retrying it burns
 * quota and returns the same wrong answer.
 */
export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<{ value: T; attempts: number }> {
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return { value: await run(attempt), attempts: attempt };
    } catch (error) {
      if (attempt > options.maxRetries || !isTransientAiFailure(error)) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) + Math.floor(Math.random() * 150);
      logger.warn(
        { label: options.label ?? 'ai', attempt, nextAttemptInMs: delay, reason: (error as Error)?.message },
        'Transient AI failure, retrying',
      );
      await sleep(delay);
    }
  }
}

/**
 * Runs `fn` unless the deadline fires first, in which case it rejects with an
 * `AI_TIMEOUT`. The SDK accepts an `AbortSignal`, but not every transport
 * honours it promptly, so the race is the guarantee and the signal the hint.
 */
async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(aiTimeout(timeoutMs)), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Real adapter
// ---------------------------------------------------------------------------

type GenAiModule = typeof import('@google/genai');
type GenAiInstance = InstanceType<GenAiModule['GoogleGenAI']>;

let genAiModule: GenAiModule | null = null;
let genAiModuleFailed = false;

function loadGenAi(): GenAiModule | null {
  if (genAiModule) return genAiModule;
  if (genAiModuleFailed) return null;
  try {
    // Renamed in typescript-eslint v8; list both so this holds across the upgrade.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    genAiModule = require('@google/genai') as GenAiModule;
    return genAiModule;
  } catch (error) {
    genAiModuleFailed = true;
    logger.error({ reason: (error as Error)?.message }, 'Failed to load @google/genai; AI features are disabled');
    return null;
  }
}

export class RealGeminiClient implements GeminiClient {
  private readonly apiKey: string | undefined;
  private sdk: GenAiInstance | null = null;

  constructor(apiKey: string | undefined = env.GEMINI_API_KEY) {
    this.apiKey = apiKey?.trim() ? apiKey.trim() : undefined;
  }

  get configured(): boolean {
    return Boolean(this.apiKey) && env.AI_ENABLED && loadGenAi() !== null;
  }

  private client(): GenAiInstance {
    const mod = loadGenAi();
    if (!mod || !this.apiKey) throw aiUnavailable();
    if (!this.sdk) this.sdk = new mod.GoogleGenAI({ apiKey: this.apiKey });
    return this.sdk;
  }

  async generate(request: GeminiGenerateRequest): Promise<GeminiGenerateResult> {
    const ai = this.client();

    // `config` is assembled as a record because it is shaped by which optional
    // request fields are present. The SDK's own types are string enums whose
    // members are exactly the literals used here, so the values are compatible;
    // the cast is confined to this one boundary call.
    const config: Record<string, unknown> = {
      temperature: request.temperature ?? 0.2,
      maxOutputTokens: request.maxOutputTokens ?? env.AI_MAX_OUTPUT_TOKENS,
    };
    if (request.systemInstruction) config.systemInstruction = request.systemInstruction;
    if (request.responseSchema) {
      config.responseMimeType = 'application/json';
      config.responseSchema = request.responseSchema;
    }
    if (request.functionDeclarations?.length) {
      config.tools = [{ functionDeclarations: request.functionDeclarations }];
      const mode = request.toolChoice === 'ANY' ? 'ANY' : request.toolChoice === 'NONE' ? 'NONE' : 'AUTO';
      config.toolConfig = { functionCallingConfig: { mode } };
    }

    const { value, attempts } = await withRetry(
      () =>
        withTimeout(request.timeoutMs, (signal) => {
          config.abortSignal = signal;
          return ai.models.generateContent({
            model: request.model,
            contents: request.contents,
            config,
          } as never);
        }),
      { maxRetries: env.AI_MAX_RETRIES, label: 'generate' },
    );

    const usage = value.usageMetadata;
    const blockReason = value.promptFeedback?.blockReason ?? null;
    return {
      text: value.text ?? null,
      functionCalls: (value.functionCalls ?? []).map((call) => ({
        name: call.name ?? '',
        args: (call.args ?? {}) as Record<string, unknown>,
      })),
      finishReason: value.candidates?.[0]?.finishReason ?? null,
      usage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
        thoughtsTokens: usage?.thoughtsTokenCount ?? 0,
      },
      modelVersion: value.modelVersion ?? null,
      blocked: Boolean(blockReason),
      blockReason: blockReason ?? null,
      attempts,
    };
  }

  async embed(request: GeminiEmbedRequest): Promise<number[][]> {
    const ai = this.client();

    const { value } = await withRetry(
      () =>
        withTimeout(request.timeoutMs, (signal) =>
          ai.models.embedContent({
            model: request.model,
            contents: request.texts,
            config: { abortSignal: signal },
          } as never),
        ),
      { maxRetries: env.AI_MAX_RETRIES, label: 'embed' },
    );

    const embeddings = value.embeddings ?? [];
    // A short or reordered batch would silently misalign vectors to chunks, so
    // it is treated as a failure rather than partially applied.
    if (embeddings.length !== request.texts.length) {
      throw aiRateLimited();
    }
    return embeddings.map((embedding) => embedding.values ?? []);
  }
}

// ---------------------------------------------------------------------------
// Ambient instance
// ---------------------------------------------------------------------------

let ambientClient: GeminiClient = new RealGeminiClient();

export function geminiClient(): GeminiClient {
  return ambientClient;
}

/** Test seam: install a deterministic fake model, or `null` to restore the real one. */
export function setGeminiClient(client: GeminiClient | null): void {
  ambientClient = client ?? new RealGeminiClient();
}
