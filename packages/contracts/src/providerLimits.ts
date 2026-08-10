import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderLimitStatus = Schema.Literals(["allowed", "warning", "rejected"]);
export type ProviderLimitStatus = typeof ProviderLimitStatus.Type;

export const ProviderLimitWindow = Schema.Struct({
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number,
  resetsAtMs: Schema.NullOr(NonNegativeInt),
  limit: Schema.optional(NonNegativeInt),
  remaining: Schema.optional(NonNegativeInt),
});
export type ProviderLimitWindow = typeof ProviderLimitWindow.Type;

export const ProviderLimitCredits = Schema.Struct({
  balance: Schema.NullOr(TrimmedNonEmptyString),
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
});
export type ProviderLimitCredits = typeof ProviderLimitCredits.Type;

export const ProviderLimitSpendControl = Schema.Struct({
  limit: TrimmedNonEmptyString,
  used: TrimmedNonEmptyString,
  remainingPercent: Schema.Number,
  resetsAtMs: NonNegativeInt,
});
export type ProviderLimitSpendControl = typeof ProviderLimitSpendControl.Type;

/** Latest quota telemetry reported by one configured provider instance. */
export const ProviderLimitSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  windows: Schema.Array(ProviderLimitWindow),
  credits: Schema.NullOr(ProviderLimitCredits),
  spendControl: Schema.NullOr(ProviderLimitSpendControl),
  planType: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.NullOr(ProviderLimitStatus),
  updatedAt: IsoDateTime,
  source: Schema.Literals(["provider-activity", "provider-api"]),
  quality: Schema.optional(Schema.Literals(["provider-reported", "local-observation"])),
});
export type ProviderLimitSnapshot = typeof ProviderLimitSnapshot.Type;

export const ProviderLimitsResponse = Schema.Struct({
  readAt: IsoDateTime,
  snapshots: Schema.Array(ProviderLimitSnapshot),
});
export type ProviderLimitsResponse = typeof ProviderLimitsResponse.Type;
