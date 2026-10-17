import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';

export interface McpRegistration { command: string; args: string[]; env: Record<string, string> }
export interface RegistrationState { status: 'missing' | 'registered' | 'conflict' | 'error'; message: string }
const location = (value: string) => path.normalize(value).toLowerCase();
export function registrationState(text: string, expected: McpRegistration): RegistrationState {
  try {
    const data = parse(text) as { mcp_servers?: Record<string, { command?: string; args?: unknown; env?: Record<string, unknown>; enabled?: boolean; tool_timeout_sec?: number }> };
    const server = data.mcp_servers?.['codex-dsh-bridge'];
    if (!server) return { status: 'missing', message: '尚未注册 MCP' };
    const matches = server.enabled !== false && typeof server.command === 'string' && location(server.command) === location(expected.command)
      && Array.isArray(server.args) && server.args.length === expected.args.length && server.args.every((arg, index) => typeof arg === 'string' && location(arg) === location(expected.args[index]!))
      && Object.entries(expected.env).every(([key, value]) => server.env?.[key] === value)
      && (server.tool_timeout_sec ?? 60) >= 660;
    return matches ? { status: 'registered', message: 'MCP 已注册 · 等待 Codex 调用' }
      : { status: 'conflict', message: '同名 MCP 配置与当前安装不一致，请核对路径、启用状态和超时' };
  } catch { return { status: 'error', message: '无法解析 Codex 配置，请检查 config.toml' }; }
}
export async function readRegistration(file: string, expected: McpRegistration): Promise<RegistrationState> {
  try { return registrationState(await readFile(file, 'utf8'), expected); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing', message: '尚未注册 MCP' } : { status: 'error', message: '无法读取 Codex 配置' }; }
}
