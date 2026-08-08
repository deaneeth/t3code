import { describe, expect, it } from "@effect/vitest";

import {
  commandCodeModelsFromSettings,
  parseCommandCodeAuth,
  parseCommandCodeModels,
} from "./CommandCodeProvider.ts";

describe("parseCommandCodeModels", () => {
  it("parses grouped model output, default markers, and provider slugs", () => {
    const models = parseCommandCodeModels(`
      Available models  ·  4 models

      Open Source
      deepseek/deepseek-v4-flash  fast (default)
      google/gemini-3.6-flash    fast

      Anthropic
      claude-sonnet-4-6          fast
      gpt-5.5                    general
    `);

    expect(models.map(({ slug }) => slug)).toEqual([
      "deepseek/deepseek-v4-flash",
      "google/gemini-3.6-flash",
      "claude-sonnet-4-6",
      "gpt-5.5",
    ]);
    expect(models[0]).toMatchObject({
      name: "Deepseek V4 Flash",
      subProvider: "deepseek",
      isDefault: true,
      isCustom: false,
    });
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "effort",
      currentValue: "high",
    });
    const deepseekEffort = models[0]?.capabilities?.optionDescriptors?.[0];
    expect(deepseekEffort?.type).toBe("select");
    if (deepseekEffort?.type === "select") {
      expect(deepseekEffort.options.map(({ id }) => id)).toEqual(["high", "max"]);
    }
    expect(models[2]?.name).toBe("Claude Sonnet 4 6");
    expect(models[2]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      currentValue: "low",
    });
  });

  it("ignores headings, prose, malformed slugs, and duplicates", () => {
    const models = parseCommandCodeModels(`
      Available models · 2 models
      Pass the model id with --model
      Open Source
      not a model
      ../outside
      deepseek/model
      deepseek/model
      claude-sonnet-4-6
    `);

    expect(models.map(({ slug }) => slug)).toEqual(["deepseek/model", "claude-sonnet-4-6"]);
  });
});

describe("parseCommandCodeAuth", () => {
  it.each([
    [
      '{"authenticated":true,"provider":"command-code"}',
      { status: "authenticated", label: "Command Code" },
    ],
    [
      '{"authenticated":true,"user":"personal-account"}',
      { status: "authenticated", label: "personal-account" },
    ],
    ["Authentication required", { status: "unauthenticated" }],
    ["status unavailable", { status: "unknown" }],
  ] as const)("parses %s", (output, expected) => {
    expect(parseCommandCodeAuth(output)).toEqual(expected);
  });
});

describe("commandCodeModelsFromSettings", () => {
  it("deduplicates custom models and guarantees a default when discovery is empty", () => {
    const models = commandCodeModelsFromSettings([], [" custom/model ", "custom/model"]);

    expect(models.map(({ slug }) => slug)).toEqual(["custom/model"]);
    expect(models[0]).toMatchObject({ isCustom: true, isDefault: true });
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([]);
  });
});
