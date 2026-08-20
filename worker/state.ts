import type { JobStatus } from "../shared/contracts.js";

const ALLOWED_TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  uploading: new Set(["queued", "cancelled"]),
  queued: new Set(["processing", "cancelled"]),
  processing: new Set(["ready", "failed", "cancelled"]),
  ready: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid frame job transition: ${from} -> ${to}`);
}
