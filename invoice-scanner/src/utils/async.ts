/**
 * Runs `worker` over `items` with a bounded number of concurrent executions,
 * preserving input order in the result array.
 */
export async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  worker: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<TOut>(items.length);
  let cursor = 0;

  async function runner(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as TIn, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async operation with exponential backoff.
 * `shouldRetry` decides whether a given error is transient.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { retries: number; baseDelayMs?: number; shouldRetry?: (error: unknown) => boolean },
): Promise<T> {
  const { retries, baseDelayMs = 500, shouldRetry = () => true } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error)) break;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}
