/**
 * Generic CLI-to-MCP wrapper framework.
 *
 * Declare tools as data (name, schema, buildCommand) and this module
 * registers them as MCP tools that shell out to a CLI binary.
 * Adding a new capability is just another CliToolDef — no transport code.
 */

import { execFile } from 'child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Describes a single MCP tool backed by a CLI command. */
export interface CliToolDef {
  /** MCP tool name (e.g., "gmail_search"). */
  name: string;

  /** Human-readable description shown to the agent. */
  description: string;

  /** Zod schema for the tool's input parameters. */
  schema: Record<string, z.ZodTypeAny>;

  /** Build the CLI arg list from validated input. */
  buildCommand: (args: Record<string, unknown>) => string[];

  /** Optional: transform CLI stdout before returning to the agent. */
  parseOutput?: (stdout: string) => string;
}

/** Maximum CLI execution time in ms. */
const CLI_TIMEOUT_MS = 30_000;

/**
 * Register an array of CLI tool definitions on an MCP server.
 * Each tool shells out to `binary` with the args from `buildCommand`.
 */
export function registerCliTools(
  server: McpServer,
  binary: string,
  tools: CliToolDef[],
): void {
  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (args) => {
        const cliArgs = tool.buildCommand(args as Record<string, unknown>);

        try {
          const stdout = await execCli(binary, cliArgs);
          const output = tool.parseOutput ? tool.parseOutput(stdout) : stdout;
          return {
            content: [{ type: 'text' as const, text: output }],
          };
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: 'text' as const, text: `Error: ${message}` },
            ],
            isError: true,
          };
        }
      },
    );
  }
}

/** Run a CLI binary and return stdout. Rejects on non-zero exit. */
function execCli(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: CLI_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        // Include stderr in error for diagnostics
        const detail = stderr?.trim() ? `\n${stderr.trim()}` : '';
        reject(new Error(`${binary} ${args.join(' ')} failed: ${err.message}${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// Re-export for testing
export { execCli as _execCli };
