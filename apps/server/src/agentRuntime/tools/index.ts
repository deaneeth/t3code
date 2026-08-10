/**
 * Tool registry — canonical tool implementations for the agent runtime.
 *
 * All tools are provider-independent. The transport layer translates
 * these into provider-specific schemas.
 *
 * @module agentRuntime/tools
 */
import type { AgentTool } from "../AgentTool.ts";
import { filesystemTools } from "./filesystem.ts";
import { searchTools } from "./search.ts";
import { shellTools } from "./shell.ts";
import { gitTools } from "./git.ts";
import { agentTools } from "./agent.ts";

/**
 * All canonical tools provided by the T3 agent runtime.
 */
export const canonicalTools: ReadonlyArray<AgentTool> = [
  ...filesystemTools,
  ...searchTools,
  ...shellTools,
  ...gitTools,
  ...agentTools,
];

export { filesystemTools } from "./filesystem.ts";
export { searchTools } from "./search.ts";
export { shellTools } from "./shell.ts";
export { gitTools } from "./git.ts";
export { agentTools } from "./agent.ts";
