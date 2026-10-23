import type { Estimate } from './api';

/**
 * Where a translation stands against the spending limit, decided before anything is sent.
 *
 * - `free`      nothing goes to the provider (everything is written by hand, or no request is needed)
 * - `pending`   the estimate is still being calculated
 * - `unlimited` the limit is 0: translation continues whatever it costs
 * - `unpriced`  a limit is set but the estimate has no price, so the core cannot enforce it and
 *               refuses with `cost_cap_unpriced` unless the person agrees to run without enforcement
 * - `over`      the upper estimate is above the limit; starting needs an explicit yes
 * - `within`    the upper estimate is under the limit
 */
export type CostSafetyKind = 'free' | 'pending' | 'unlimited' | 'unpriced' | 'over' | 'within';

export type CostSafetyInput = {
  manualOnly: boolean;
  estimate: Pick<Estimate, 'requests' | 'cost'> | null | undefined;
  loading: boolean;
  cap: number | undefined;
};

/** The error code the core answers with when a limit is set and the price is unknown. */
export const COST_CAP_UNPRICED = 'cost_cap_unpriced';

export function costSafety({ manualOnly, estimate, loading, cap }: CostSafetyInput): CostSafetyKind {
  const limit = cap ?? 0;
  if (manualOnly || estimate?.requests === 0) return 'free';
  if (!estimate) return loading ? 'pending' : limit > 0 ? 'within' : 'unlimited';
  if (limit <= 0) return 'unlimited';
  if (!estimate.cost) return 'unpriced';
  return estimate.cost.high > limit ? 'over' : 'within';
}

/** A first-run suggestion that keeps a mistake cheap; the person can still choose no limit. */
export const SUGGESTED_CAP_USD = 5;

/**
 * A rough duration for the pre-start summary. A request carries one batch of texts; this assumes
 * about ten seconds per request, spread over the parallel requests, so "about n min" is a ballpark
 * and never below a minute. Slow models, retries and rate limits make real runs longer.
 */
const SECONDS_PER_REQUEST = 10;

export function estimateMinutes(requests: number | undefined, concurrency: number | undefined): number | null {
  if (requests === undefined || !Number.isFinite(requests) || requests <= 0) return null;
  const parallel = Math.max(1, Math.floor(concurrency ?? 1));
  return Math.max(1, Math.ceil((requests / parallel) * SECONDS_PER_REQUEST / 60));
}
