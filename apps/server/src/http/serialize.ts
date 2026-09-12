/**
 * Row-to-wire conversions shared by every service.
 *
 * Small, but worth centralising: four services had their own copy of `toIso`,
 * and the failure mode of a divergent one is silent. A timestamp serialized
 * inconsistently breaks the freshness comparisons in section 10.3, which are
 * the whole basis of a safe Apply.
 */

/**
 * Postgres timestamptz to the ISO-8601 string the contracts package expects.
 *
 * node-postgres returns `Date` for timestamptz, but a raw query or a JSON
 * column can yield a string, so both are accepted.
 */
export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Same, for a column that may be null. */
export function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}
