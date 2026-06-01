import type { Redis } from "../redis.js";
import { logger } from "../logger.js";

export interface StreamMessage<T> {
  /** Redis stream entry id, used to ACK. */
  id: string;
  body: T;
}

/**
 * Reliable work queue on a Redis Stream + consumer group.
 *
 * Replaces the doc's BRPOPLPUSH "reliable queue" (review fix #10): with a
 * consumer group, a crashed consumer's un-ACKed entries sit in the group's
 * Pending Entries List and are recovered with XAUTOCLAIM — no per-element TTL
 * hacks, no O(N) sweeper scan, no racy leased_at stamping.
 */
export class StreamQueue<T> {
  constructor(
    private readonly r: Redis,
    readonly stream: string,
    readonly group: string,
  ) {}

  /** Idempotently create the consumer group (and the stream via MKSTREAM). */
  async ensureGroup(): Promise<void> {
    try {
      await this.r.xgroup("CREATE", this.stream, this.group, "$", "MKSTREAM");
    } catch (err) {
      // BUSYGROUP = already exists; anything else is real.
      if (!(err instanceof Error) || !err.message.includes("BUSYGROUP")) throw err;
    }
  }

  async publish(body: T): Promise<string> {
    return this.r.xadd(this.stream, "*", "d", JSON.stringify(body)) as Promise<string>;
  }

  /** Block up to blockMs for new entries delivered to this consumer. */
  async consume(
    consumer: string,
    opts: { count?: number; blockMs?: number } = {},
  ): Promise<StreamMessage<T>[]> {
    const res = (await this.r.xreadgroup(
      "GROUP",
      this.group,
      consumer,
      "COUNT",
      String(opts.count ?? 10),
      "BLOCK",
      String(opts.blockMs ?? 5000),
      "STREAMS",
      this.stream,
      ">",
    )) as [string, [string, string[]][]][] | null;
    if (!res) return [];
    return this.parseEntries(res[0]?.[1] ?? []);
  }

  /**
   * Reclaim entries pending (delivered but un-ACKed) longer than minIdleMs from
   * dead/slow consumers. Run periodically by every consumer.
   */
  async claimStale(consumer: string, minIdleMs: number, count = 20): Promise<StreamMessage<T>[]> {
    // XAUTOCLAIM <key> <group> <consumer> <min-idle> <start> COUNT <n>
    const res = (await this.r.xautoclaim(
      this.stream,
      this.group,
      consumer,
      minIdleMs,
      "0",
      "COUNT",
      count,
    )) as [string, [string, string[]][], string[]];
    return this.parseEntries(res?.[1] ?? []);
  }

  async ack(id: string): Promise<void> {
    await this.r.xack(this.stream, this.group, id);
    // Trim the entry; we don't replay the raw stream (Postgres is the log).
    await this.r.xdel(this.stream, id);
  }

  /** Current group lag (approx queue depth) for metrics/HPA. */
  async depth(): Promise<number> {
    try {
      const info = (await this.r.xinfo("GROUPS", this.stream)) as unknown[];
      for (const g of info as Record<string, unknown>[][]) {
        // ioredis returns flat [k,v,k,v]; find ours
        const obj = arrToObj(g as unknown as string[]);
        if (obj["name"] === this.group) return Number(obj["lag"] ?? 0);
      }
    } catch {
      /* stream may not exist yet */
    }
    return 0;
  }

  private parseEntries(entries: [string, string[]][]): StreamMessage<T>[] {
    const out: StreamMessage<T>[] = [];
    for (const [id, fields] of entries) {
      if (!fields) {
        // tombstone (entry was XDELed); ack to drop from PEL
        void this.r.xack(this.stream, this.group, id);
        continue;
      }
      const obj = arrToObj(fields);
      try {
        out.push({ id, body: JSON.parse(obj["d"] ?? "null") as T });
      } catch (err) {
        logger.error({ err, id, stream: this.stream }, "undeserialisable stream entry");
        void this.ack(id);
      }
    }
    return out;
  }
}

function arrToObj(flat: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]!] = flat[i + 1]!;
  return o;
}
