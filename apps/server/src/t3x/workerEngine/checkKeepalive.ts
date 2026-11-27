// @effect-diagnostics globalDate:off globalTimers:off
/**
 * CLI `--wait` keepalive emitter for `t3 worker check --wait`.
 *
 * Adapted from `stablyai/orca` (`src/cli/orchestration/messages/check-keepalive.ts`,
 * release v1.4.270, commit 22ad3bbe244a0f61bc403d83aae03b68f58c1264).
 *
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { WORKER_CHECK_KEEPALIVE_MS } from "@t3tools/contracts";

export interface KeepalivePayload {
  readonly _keepalive: true;
  readonly _heartbeat: true;
  readonly elapsedMs: number;
  readonly deadlineMs: number | null;
}

export function resolveWorkerKeepaliveIntervalMs(overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) {
    return Math.floor(overrideMs);
  }
  const raw = process.env.T3_WORKER_KEEPALIVE_INTERVAL_MS ?? process.env.ORCA_KEEPALIVE_INTERVAL_MS;
  if (!raw) {
    return WORKER_CHECK_KEEPALIVE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return WORKER_CHECK_KEEPALIVE_MS;
  }
  return Math.floor(parsed);
}

/**
 * Periodically writes single-line JSON keepalive frames to stderr while a CLI
 * `check --wait` call is blocking, keeping stdout completely clean for the
 * final JSON result envelope.
 */
export function startWorkerCheckKeepalive(options?: {
  readonly deadlineMs?: number | undefined;
  readonly intervalMs?: number | undefined;
  readonly writeLine?: ((line: string) => void) | undefined;
}): () => void {
  const startedAt = Date.now();
  const deadlineMs = options?.deadlineMs ?? null;
  const writeLine = options?.writeLine ?? ((line: string) => process.stderr.write(line));
  const interval = setInterval(() => {
    const payload: KeepalivePayload = {
      _keepalive: true,
      _heartbeat: true,
      elapsedMs: Date.now() - startedAt,
      deadlineMs,
    };
    writeLine(`${JSON.stringify(payload)}\n`);
  }, resolveWorkerKeepaliveIntervalMs(options?.intervalMs));

  if (typeof interval.unref === "function") {
    interval.unref();
  }
  return () => clearInterval(interval);
}
