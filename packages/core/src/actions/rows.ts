/** The type id Postgres gives a bigint column. The driver returns it as text, because a JavaScript number cannot always hold it. */
const INT8 = 20;

/**
 * The rows of a read action with its bigint columns (ids, `count(*)`) as numbers, so an agent or a screen sees `1` and not `"1"`.
 * Only a value that is exact as a number is changed; anything larger stays text rather than lose digits. Other columns are never touched.
 */
export function numberBigints(rows: Record<string, unknown>[], fields: readonly { name: string; dataTypeID: number }[]): Record<string, unknown>[] {
  const bigints = fields.filter((field) => field.dataTypeID === INT8).map((field) => field.name);
  if (bigints.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const name of bigints) {
      const value = out[name];
      if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value)) continue;
      const number = Number(value);
      if (Number.isSafeInteger(number)) out[name] = number;
    }
    return out;
  });
}
