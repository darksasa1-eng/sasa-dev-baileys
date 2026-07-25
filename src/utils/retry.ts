export async function retry<T>(fn: () => Promise<T>, retries: number = 3, delayMs: number = 1000): Promise<T> {
  let lastError: Error;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (i < retries - 1) await new Promise(res => setTimeout(res, delayMs));
    }
  }
  throw lastError!;
}
