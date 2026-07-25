export function throttle<T extends (...args: any[]) => any>(fn: T, limit: number): T {
  let lastCall = 0;
  return ((...args: any[]) => {
    const now = Date.now();
    if (now - lastCall < limit) return;
    lastCall = now;
    return fn(...args);
  }) as unknown as T;
}
