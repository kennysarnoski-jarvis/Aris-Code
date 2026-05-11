/**
 * ArisTextGeneration – Text generation layer using ArisLLM's lightweight
 * `/v1/text/generate` endpoint.
 *
 * Implements the same `TextGenerationShape` contract as the Codex/Claude
 * layers, but talks to ArisLLM over HTTP rather than spawning a CLI. The
 * Aris endpoint deliberately bypasses the agentic chat machinery (no
 * persona, no memory inventory, no tools, no agentic loop) — it's a pure
 * prompt-in / JSON-out path tailored for short structured generations
 * like commit messages and PR titles.
 *
 * The endpoint accepts a JSON-schema object describing the desired
 * response shape. We convert each prompt's Effect `Schema.Struct` to a
 * JSON-schema dict via `toJsonSchemaObject` (the same helper Codex/Claude
 * use), send it alongside the prompt, then validate the parsed response
 * back against the original Effect schema for type safety.
 *
 * @module ArisTextGeneration
 */
import { Effect, Layer, Option, Schema } from "effect";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { TextGenerationError } from "@t3tools/contracts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const ARIS_TEXT_TIMEOUT_MS = 120_000;

type ArisOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const makeArisTextGeneration = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;

  /**
   * Call ArisLLM's `/v1/text/generate` endpoint with a schema-constrained
   * output spec, validate the JSON response back against the same
   * Effect schema, and return the typed result.
   */
  const runArisJson = Effect.fn("runArisJson")(function* <S extends Schema.Top>({
    operation,
    prompt,
    outputSchema,
  }: {
    operation: ArisOperation;
    prompt: string;
    outputSchema: S;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const arisSettings = yield* serverSettings.getSettings.pipe(
      Effect.map((s) => s.providers.aris),
      Effect.mapError(
        () =>
          new TextGenerationError({
            operation,
            detail: "Failed to load Aris provider settings.",
          }),
      ),
    );

    if (!arisSettings.baseUrl) {
      return yield* new TextGenerationError({
        operation,
        detail: "Aris base URL is not configured.",
      });
    }
    if (!arisSettings.apiKey || arisSettings.apiKey.length === 0) {
      return yield* new TextGenerationError({
        operation,
        detail: "Aris is not signed in. Sign in from Aris Code settings.",
      });
    }

    const url = `${arisSettings.baseUrl.replace(/\/+$/, "")}/v1/text/generate`;
    const body = JSON.stringify({
      prompt,
      output_schema: toJsonSchemaObject(outputSchema),
    });
    const apiKeyHeader = arisSettings.apiKey;

    const rawResponse = yield* Effect.tryPromise({
      try: async (signal: AbortSignal): Promise<unknown> => {
        const resp = await fetch(url, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            "X-Aris-Key": apiKeyHeader,
          },
          body,
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => resp.statusText);
          throw new Error(`Aris text generation ${resp.status}: ${detail.slice(0, 500)}`);
        }
        return await resp.json();
      },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail:
            cause instanceof Error
              ? `Aris text generation failed: ${cause.message}`
              : `Aris text generation failed: ${String(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.timeoutOption(ARIS_TEXT_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Aris text generation request timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    return yield* Schema.decodeEffect(outputSchema)(rawResponse).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Aris returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGenerationShape methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ArisTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "aris") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runArisJson({
      operation: "generateCommitMessage",
      prompt,
      outputSchema,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "ArisTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "aris") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runArisJson({
      operation: "generatePrContent",
      prompt,
      outputSchema,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "ArisTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "aris") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runArisJson({
      operation: "generateBranchName",
      prompt,
      outputSchema,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "ArisTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "aris") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runArisJson({
      operation: "generateThreadTitle",
      prompt,
      outputSchema,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const ArisTextGenerationLive = Layer.effect(TextGeneration, makeArisTextGeneration);
