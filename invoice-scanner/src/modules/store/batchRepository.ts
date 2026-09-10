import type { InvoiceBatch } from '../../core/types.js';

export interface BatchListItem {
  id: string;
  createdAt: string;
  completedAt: string;
  total: number;
  ok: number;
  needsReview: number;
  failed: number;
}

/**
 * Persistence seam for processed batches.
 *
 * The HTTP layer only ever sees this interface, so swapping the in-memory
 * implementation for Postgres/Mongo is a one-file change plus wiring in
 * `createServer` (see README, "Extending the application").
 */
export interface BatchRepository {
  save(batch: InvoiceBatch): Promise<void>;
  get(id: string): Promise<InvoiceBatch | null>;
  list(limit?: number): Promise<BatchListItem[]>;
  delete(id: string): Promise<boolean>;
}

interface StoredBatch {
  batch: InvoiceBatch;
  storedAt: number;
}

/** Default implementation: bounded, TTL-evicted, process-local. */
export class InMemoryBatchRepository implements BatchRepository {
  private readonly batches = new Map<string, StoredBatch>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  async save(batch: InvoiceBatch): Promise<void> {
    this.prune();
    this.batches.set(batch.id, { batch, storedAt: Date.now() });
    while (this.batches.size > this.maxEntries) {
      const oldest = this.batches.keys().next();
      if (oldest.done) break;
      this.batches.delete(oldest.value);
    }
  }

  async get(id: string): Promise<InvoiceBatch | null> {
    this.prune();
    return this.batches.get(id)?.batch ?? null;
  }

  async list(limit = 50): Promise<BatchListItem[]> {
    this.prune();
    return [...this.batches.values()]
      .sort((a, b) => b.storedAt - a.storedAt)
      .slice(0, limit)
      .map(({ batch }) => ({
        id: batch.id,
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
        total: batch.summary.total,
        ok: batch.summary.ok,
        needsReview: batch.summary.needsReview,
        failed: batch.summary.failed,
      }));
  }

  async delete(id: string): Promise<boolean> {
    return this.batches.delete(id);
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, entry] of this.batches) {
      if (entry.storedAt < cutoff) this.batches.delete(id);
    }
  }
}
