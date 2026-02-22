import { Context, Next } from "hono";
import { createHash } from "crypto";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../types.js";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({
      error: "unauthorized",
      message: "Missing or invalid Authorization header. Use: Bearer {api_key}",
      suggestion: "Register at POST /v1/auth/register to get an API key",
    }, 401);
  }

  const apiKey = authHeader.slice(7);
  const keyHash = hashApiKey(apiKey);

  const agent = db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.apiKeyHash, keyHash))
    .get();

  if (!agent) {
    return c.json({
      error: "unauthorized",
      message: "Invalid API key",
      suggestion: "Register at POST /v1/auth/register to get an API key",
    }, 401);
  }

  db.update(schema.agents)
    .set({ lastActive: Math.floor(Date.now() / 1000) })
    .where(eq(schema.agents.id, agent.id))
    .run();

  c.set("agentId", agent.id);
  c.set("agent", agent);

  await next();
}
