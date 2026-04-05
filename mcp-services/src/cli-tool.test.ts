import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { CliToolDef } from './cli-tool.js';

// Mock child_process before importing
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock MCP SDK — must be a real class (vi.fn can't be used with `new`)
const mockTool = vi.fn();
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: class {
      tool = mockTool;
    },
  };
});

import { registerCliTools } from './cli-tool.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerCliTools', () => {
  const testTools: CliToolDef[] = [
    {
      name: 'test_search',
      description: 'Search for things',
      schema: {
        query: z.string(),
        limit: z.number().default(10),
      },
      buildCommand: (args) => ['search', args.query as string, '--limit', String(args.limit)],
    },
    {
      name: 'test_list',
      description: 'List all things',
      schema: {},
      buildCommand: () => ['list', '--json'],
    },
  ];

  it('registers each tool definition on the MCP server', () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerCliTools(server, '/usr/bin/test-cli', testTools);

    expect(mockTool).toHaveBeenCalledTimes(2);
    expect(mockTool).toHaveBeenNthCalledWith(
      1,
      'test_search',
      'Search for things',
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockTool).toHaveBeenNthCalledWith(
      2,
      'test_list',
      'List all things',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('tool handler calls execFile with correct binary and args', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerCliTools(server, '/usr/bin/test-cli', testTools);

    // Get the handler registered for test_search
    const handler = mockTool.mock.calls[0][3];

    // Mock execFile to succeed
    mockExecFile.mockImplementation(
      (_binary: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, '{"results": []}', '');
      },
    );

    const result = await handler({ query: 'hello', limit: 5 });

    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/test-cli',
      ['search', 'hello', '--limit', '5'],
      expect.objectContaining({ timeout: 30000 }),
      expect.any(Function),
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"results": []}' }],
    });
  });

  it('tool handler returns error on CLI failure', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerCliTools(server, '/usr/bin/test-cli', testTools);

    const handler = mockTool.mock.calls[0][3];

    mockExecFile.mockImplementation(
      (_binary: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(new Error('exit code 1'), '', 'something went wrong');
      },
    );

    const result = await handler({ query: 'fail', limit: 10 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error:');
    expect(result.content[0].text).toContain('something went wrong');
  });

  it('applies parseOutput transform when provided', async () => {
    const toolWithParser: CliToolDef[] = [
      {
        name: 'parsed_tool',
        description: 'Parsed output',
        schema: {},
        buildCommand: () => ['data'],
        parseOutput: (stdout) => `PARSED: ${stdout.trim()}`,
      },
    ];

    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerCliTools(server, '/usr/bin/test-cli', toolWithParser);

    const handler = mockTool.mock.calls[0][3];

    mockExecFile.mockImplementation(
      (_binary: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, '  raw output  \n', '');
      },
    );

    const result = await handler({});

    expect(result.content[0].text).toBe('PARSED: raw output');
  });

  it('tool handler for no-args tool works', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerCliTools(server, '/usr/bin/test-cli', testTools);

    // test_list is the second registered tool
    const handler = mockTool.mock.calls[1][3];

    mockExecFile.mockImplementation(
      (_binary: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, '["item1", "item2"]', '');
      },
    );

    const result = await handler({});

    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/test-cli',
      ['list', '--json'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(result.content[0].text).toBe('["item1", "item2"]');
  });
});
