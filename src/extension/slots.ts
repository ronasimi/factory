export type SlotPriority = 'subagent' | 'compaction' | 'utility' | 'sim';

const PRIORITY_RANK: Record<SlotPriority, number> = {
  subagent: 0,
  compaction: 1,
  utility: 2,
  sim: 3,
};

interface Waiter {
  priority: SlotPriority;
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup?: () => void;
}

/**
 * Bounded concurrency pool for the 3 remote `Instance` (lfm-aa1) slots
 * so subagents, compaction, triage, and SIM reflection never starve the
 * 1 `Singleton` orchestrator slot or queue-overflow llama-server.
 */
export class InstanceSlotPool {
  readonly capacity: number;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(capacity = 3) {
    if (capacity < 1) throw new Error(`InstanceSlotPool capacity must be >= 1, got ${capacity}`);
    this.capacity = capacity;
  }

  get stats(): { capacity: number; active: number; queued: number } {
    return { capacity: this.capacity, active: this.active, queued: this.queue.length };
  }

  async acquire(priority: SlotPriority = 'utility', signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error('Aborted before acquiring Instance slot');
    }

    if (this.active < this.capacity) {
      this.active += 1;
      return this.createReleaser();
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { priority, resolve, reject };

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(waiter);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(new Error('Aborted while waiting for Instance slot'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }

      // Insert sorted by priority rank (FIFO within same priority)
      const rank = PRIORITY_RANK[priority];
      let insertAt = this.queue.length;
      for (let i = 0; i < this.queue.length; i += 1) {
        if (PRIORITY_RANK[this.queue[i].priority] > rank) {
          insertAt = i;
          break;
        }
      }
      this.queue.splice(insertAt, 0, waiter);
    });

    return this.createReleaser();
  }

  async run<T>(priority: SlotPriority, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(priority, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createReleaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.cleanup?.();
        next.resolve();
      } else {
        this.active = Math.max(0, this.active - 1);
      }
    };
  }
}
