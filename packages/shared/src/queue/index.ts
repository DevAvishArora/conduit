import type { Redis } from "../redis.js";
import {
  type NodeCompletedMessage,
  type NodeExecutionTask,
  type RunStartCommand,
} from "../types.js";
import { GROUPS, STREAMS } from "./names.js";
import { StreamQueue } from "./streams.js";

export * from "./names.js";
export * from "./streams.js";
export * from "./delayed.js";
export * from "./lease.js";

/** Typed queue handles for each stream, bound to a Redis connection. */
export function queues(r: Redis) {
  return {
    runStart: new StreamQueue<RunStartCommand>(r, STREAMS.runStart, GROUPS.dispatcher),
    nodeTasks: new StreamQueue<NodeExecutionTask>(r, STREAMS.nodeTasks, GROUPS.workers),
    nodeCompleted: new StreamQueue<NodeCompletedMessage>(
      r,
      STREAMS.nodeCompleted,
      GROUPS.dispatcher,
    ),
  };
}

export type Queues = ReturnType<typeof queues>;
