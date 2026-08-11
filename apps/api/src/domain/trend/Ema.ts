export function ema(values: readonly number[], period: number): number[] {
  if (period <= 0) {
    throw new Error("EMA period must be greater than zero");
  }
  if (values.length === 0) {
    return [];
  }

  const multiplier = 2 / (period + 1);
  const result: number[] = [values[0] ?? 0];

  for (let i = 1; i < values.length; i += 1) {
    const previous = result[i - 1];
    const value = values[i];
    if (previous === undefined || value === undefined) {
      throw new Error("Unexpected missing EMA input");
    }
    result.push((value - previous) * multiplier + previous);
  }

  return result;
}
