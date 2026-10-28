// Redis for integration tests (docker-compose.yml). The dev Redis is shared, so tests keep their keys under test:.
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export const testRedis = () => new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");

/** Throttle keys of their own for one test run (RunnerOptions.politeness.keyPrefix). */
export const testThrottlePrefix = () => `test:throttle:${randomUUID()}:`;
