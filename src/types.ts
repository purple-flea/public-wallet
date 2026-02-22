import type * as schema from "./db/schema.js";

export type AppEnv = {
  Variables: {
    agentId: string;
    agent: typeof schema.agents.$inferSelect;
  };
};
