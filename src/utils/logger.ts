export class Logger {
  private level: string;
  constructor(opts: { level: string }) {
    this.level = opts.level || 'info';
  }
  info(...args: any[]) { console.log('[INFO]', ...args); }
  error(...args: any[]) { console.error('[ERROR]', ...args); }
  warn(...args: any[]) { console.warn('[WARN]', ...args); }
  debug(...args: any[]) { console.debug('[DEBUG]', ...args); }
}
