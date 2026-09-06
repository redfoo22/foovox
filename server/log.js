import { appendFileSync } from 'node:fs';

/**
 * Append-only event log.
 *
 * `DeviceStore` expects something with `.append(event, fields)` and uses it for
 * every pairing, redemption, failure and revocation. Those are the events you
 * need after the fact to answer "who paired a device, and when" — so they go
 * to a file rather than to a console nobody is reading.
 */
export class Log {
  constructor(path) { this.path = path; }

  append(event, fields = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields });
    try { appendFileSync(this.path, `${line}\n`, { mode: 0o600 }); } catch {}
    if (process.env.FOOVOX_VERBOSE) console.log(`[log] ${line}`);
  }
}
