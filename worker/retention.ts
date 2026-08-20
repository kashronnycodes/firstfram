export interface ExpirableBatch {
  id: string
  expires_at: string
}

export function expiredBatchIds(
  batches: ExpirableBatch[],
  now = Date.now(),
): string[] {
  return batches
    .filter((batch) => new Date(batch.expires_at).getTime() <= now)
    .map((batch) => batch.id)
}
