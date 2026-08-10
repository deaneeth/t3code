import { TextGenerationError, type ApiProviderSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { normalizeApiProviderSettings } from "../provider/apiProviderProfiles.ts";
import { readApiProviderText } from "../provider/apiProviderTransport.ts";
import { requestPlan } from "../provider/Layers/ApiProviderAdapter.ts";
import * as TextGeneration from "./TextGeneration.ts";

export const makeApiProviderTextGeneration = Effect.fn("makeApiProviderTextGeneration")(function* (
  settings: ApiProviderSettings,
  apiKey: string,
  httpClient: HttpClient.HttpClient,
) {
  const normalizedSettings = normalizeApiProviderSettings(settings);
  const call = (prompt: string, model: string) =>
    Effect.gen(function* () {
      const plan = requestPlan({
        settings: normalizedSettings,
        apiKey,
        model,
        text: prompt,
        history: [],
        includeTools: false,
        stream: false,
      });
      if (!plan?.body)
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "Unknown API provider profile.",
        });
      const payload = yield* HttpClientRequest.post(plan.url).pipe(
        HttpClientRequest.setHeaders(plan.headers),
        HttpClientRequest.bodyJsonUnsafe(plan.body),
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "API provider text generation failed.",
              cause,
            }),
        ),
      );
      return readApiProviderText(payload, normalizedSettings.protocol).trim();
    });
  const generate = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    prompt: string,
    model: string,
  ) =>
    call(prompt, model).pipe(
      Effect.mapError(
        (error) => new TextGenerationError({ operation, detail: error.detail, cause: error.cause }),
      ),
    );
  const modelFor = (selection: { readonly model?: string }) =>
    selection.model ?? settings.customModels[0] ?? "";
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: (input) =>
      generate(
        "generateCommitMessage",
        `Write a concise commit message for this patch. Return subject on the first line and body after a blank line.\n${input.stagedSummary}\n${input.stagedPatch}`,
        modelFor(input.modelSelection),
      ).pipe(
        Effect.map((text) => {
          const [subject = "Update project", ...body] = text.split(/\r?\n/);
          return {
            subject,
            body: body.join("\n").trim(),
            ...(input.includeBranch
              ? {
                  branch: subject
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, ""),
                }
              : {}),
          };
        }),
      ),
    generatePrContent: (input) =>
      generate(
        "generatePrContent",
        `Write a pull request title and description. Put the title on the first line and the description after a blank line.\n${input.commitSummary}\n${input.diffSummary}\n${input.diffPatch}`,
        modelFor(input.modelSelection),
      ).pipe(
        Effect.map((text) => {
          const [title = "Update project", ...body] = text.split(/\r?\n/);
          return { title, body: body.join("\n").trim() };
        }),
      ),
    generateBranchName: (input) =>
      generate(
        "generateBranchName",
        `Return only a short kebab-case branch name for this request: ${input.message}`,
        modelFor(input.modelSelection),
      ).pipe(Effect.map((branch) => ({ branch: branch.split(/\s+/u)[0] ?? "feature/update" }))),
    generateThreadTitle: (input) =>
      generate(
        "generateThreadTitle",
        `Return only a concise title for this coding request: ${input.message}`,
        modelFor(input.modelSelection),
      ).pipe(Effect.map((title) => ({ title: title.split(/\r?\n/u)[0] ?? "Coding task" }))),
  });
});
