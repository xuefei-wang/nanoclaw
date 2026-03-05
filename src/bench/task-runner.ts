import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { runContainerAgent, ContainerOutput } from '../container-runner.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { RegisteredGroup } from '../types.js';

type RuntimeScope = 'task' | 'agent';

interface RuntimeConfig {
  session_scope?: RuntimeScope;
  wipe_workspace_per_task?: boolean;
}

interface WorkspaceSeed {
  instruction_md?: string;
  insights_md?: string;
  task_md?: string;
  repo_source_path?: string;
}

interface TaskPayload {
  id: string;
  repo?: string;
  prompt?: string;
  metadata?: Record<string, unknown>;
}

interface MemoryConfig {
  db_path?: string;
  mcp_server_dir?: string;
}

interface SwarmsPayload {
  generation: number;
  agent_id: string;
  task: TaskPayload;
  workspace_seed?: WorkspaceSeed;
  execution_prompt?: string;
  runtime?: RuntimeConfig;
  memory?: MemoryConfig;
}

interface SessionState {
  session_id: string;
}

function die(msg: string): never {
  throw new Error(msg);
}

function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

function shortHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 10);
}

function safeTaskDir(taskId: string): string {
  const cleaned = (taskId || 'task').replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || 'task';
}

function toGroupFolder(payload: SwarmsPayload, scope: RuntimeScope): string {
  if (scope === 'agent') {
    return payload.agent_id;
  }
  const task = payload.task?.id || 'task';
  const token = shortHash(`${payload.generation}:${payload.agent_id}:${task}`);
  return `${payload.agent_id}__t_${token}`;
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

function copyRepo(repoSourcePath: string, repoDst: string): void {
  if (!repoSourcePath) {
    ensureDir(repoDst);
    writeText(path.join(repoDst, '.keep'), '');
    return;
  }

  const src = path.resolve(repoSourcePath);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    ensureDir(repoDst);
    writeText(path.join(repoDst, '.keep'), '');
    return;
  }

  fs.cpSync(src, repoDst, { recursive: true });
}

function seedWorkspace(
  payload: SwarmsPayload,
  groupFolder: string,
  wipeWorkspacePerTask: boolean,
): void {
  const groupDir = resolveGroupFolderPath(groupFolder);
  ensureDir(groupDir);

  const workspaceRoot = path.join(groupDir, 'workspace');
  if (wipeWorkspacePerTask) {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
  ensureDir(workspaceRoot);

  const seed = payload.workspace_seed || {};
  const instruction = (seed.instruction_md || '').trim() + '\n';
  const insights = (seed.insights_md || '').trim() + '\n';
  const taskMd = (seed.task_md || '').trim() + '\n';

  writeText(path.join(workspaceRoot, 'INSTRUCTION.md'), instruction);
  writeText(path.join(workspaceRoot, 'INSIGHTS.md'), insights);
  const tasksRoot = path.join(workspaceRoot, 'tasks');
  ensureDir(tasksRoot);

  const taskFolder = safeTaskDir(payload.task?.id || 'task');
  const taskRoot = path.join(tasksRoot, taskFolder);
  if (wipeWorkspacePerTask) {
    fs.rmSync(taskRoot, { recursive: true, force: true });
  }
  ensureDir(taskRoot);
  writeText(path.join(taskRoot, 'TASK.md'), taskMd);

  const repoDst = path.join(taskRoot, 'repo');
  fs.rmSync(repoDst, { recursive: true, force: true });
  copyRepo(seed.repo_source_path || '', repoDst);
}

function sessionStateRoot(): string {
  const configured = (process.env.NANOCLAW_SESSION_STATE_ROOT || '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve('workspaces');
}

function sessionStatePath(agentId: string): string {
  return path.join(sessionStateRoot(), agentId, '.nanoclaw_session.json');
}

function loadSessionForAgent(agentId: string): string | undefined {
  const p = sessionStatePath(agentId);
  if (!fs.existsSync(p)) return undefined;
  try {
    const data = readJsonFile<SessionState>(p);
    return data.session_id || undefined;
  } catch {
    return undefined;
  }
}

function saveSessionForAgent(agentId: string, sessionId: string): void {
  const p = sessionStatePath(agentId);
  ensureDir(path.dirname(p));
  writeText(p, JSON.stringify({ session_id: sessionId }, null, 2) + '\n');
}

function cleanupGroup(groupFolder: string): void {
  const dirs = [
    path.join(GROUPS_DIR, groupFolder),
    path.join(DATA_DIR, 'sessions', groupFolder),
    path.join(DATA_DIR, 'ipc', groupFolder),
  ];
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  }
  return out;
}

function collectNativeSessionMemory(
  groupFolder: string,
  maxChars = 240000,
): string {
  const claudeRoot = path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  const files = listFilesRecursive(claudeRoot).filter(
    (p) => p.endsWith('.jsonl') || p.endsWith('.md') || p.endsWith('.txt'),
  );
  if (files.length === 0) return '';

  files.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });

  const blocks: string[] = [];
  let total = 0;
  for (const f of files.slice(0, 8)) {
    try {
      const raw = fs.readFileSync(f, 'utf-8');
      if (!raw.trim()) continue;
      const rel = path.relative(claudeRoot, f);
      let chunk = raw;
      if (chunk.length > 60000) {
        chunk = chunk.slice(-60000);
      }
      const wrapped = `# file: ${rel}\n${chunk}\n`;
      blocks.push(wrapped);
      total += wrapped.length;
      if (total >= maxChars) break;
    } catch {
      // best-effort only
    }
  }
  const merged = blocks.join('\n\n---\n\n').trim();
  if (!merged) return '';
  if (merged.length <= maxChars) return merged;
  return merged.slice(-maxChars);
}

function buildPrompt(payload: SwarmsPayload): string {
  const instruction = (payload.execution_prompt || '').trim();
  const taskFolder = safeTaskDir(payload.task?.id || 'task');
  const activeTaskDir = `/workspace/group/workspace/tasks/${taskFolder}`;
  const taskHint = [
    'Use this workspace:',
    '- Shared guidance:',
    '  - /workspace/group/workspace/INSTRUCTION.md',
    '  - /workspace/group/workspace/INSIGHTS.md',
    `- Active task workspace: ${activeTaskDir}`,
    `  - ${activeTaskDir}/TASK.md`,
    `  - ${activeTaskDir}/repo`,
    'Only edit files under the active task repo path.',
  ].join('\n');
  return `${instruction}\n\n${taskHint}\n`;
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    die('usage: tsx src/bench/task-runner.ts <payload.json>');
  }
  if (!fs.existsSync(payloadPath)) {
    die(`payload not found: ${payloadPath}`);
  }

  const payload = readJsonFile<SwarmsPayload>(payloadPath);
  const scope: RuntimeScope =
    payload.runtime?.session_scope === 'agent' ? 'agent' : 'task';
  const wipeWorkspacePerTask =
    payload.runtime?.wipe_workspace_per_task !== false;
  const groupFolder = toGroupFolder(payload, scope);

  seedWorkspace(payload, groupFolder, wipeWorkspacePerTask);

  let sessionId: string | undefined;
  if (scope === 'agent') {
    sessionId = loadSessionForAgent(payload.agent_id);
  }

  const group: RegisteredGroup = {
    name: `swarms-${payload.agent_id}`,
    folder: groupFolder,
    trigger: '@Swarms',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  };

  try {
    let lastOutput: ContainerOutput | undefined;
    let latestSessionId: string | undefined = sessionId;

    const result = await runContainerAgent(
      group,
      {
        prompt: buildPrompt(payload),
        sessionId,
        groupFolder,
        chatJid: `swarm-${payload.agent_id}`,
        isMain: false,
        isScheduledTask: true,
        assistantName: 'Swarms',
      },
      () => {},
      async (streamed) => {
        lastOutput = streamed;
        if (streamed.newSessionId) {
          latestSessionId = streamed.newSessionId;
        }
      },
    );

    if (!latestSessionId && result.newSessionId) {
      latestSessionId = result.newSessionId;
    }
    if (scope === 'agent' && latestSessionId) {
      saveSessionForAgent(payload.agent_id, latestSessionId);
    }

    // Prefer streaming output (lastOutput) over the final completion marker
    // which may have result: null when the real result was captured via onOutput.
    const effectiveOutput = lastOutput?.result != null ? lastOutput : result;

    const output = {
      result: effectiveOutput.result ?? effectiveOutput.error ?? '',
      tool_trace:
        (effectiveOutput as unknown as Record<string, unknown>).toolTrace ?? [],
      meta: {
        generation: payload.generation,
        agent_id: payload.agent_id,
        task_id: payload.task?.id || '',
        status: effectiveOutput.status,
        session_scope: scope,
        input_tokens: effectiveOutput.input_tokens ?? 0,
        output_tokens: effectiveOutput.output_tokens ?? 0,
        group_folder: groupFolder,
        session_id: latestSessionId || '',
        active_task_dir: `/workspace/group/workspace/tasks/${safeTaskDir(payload.task?.id || 'task')}`,
        memory_db_path: payload.memory?.db_path || '',
        model_requested: process.env.MODEL || '',
        native_session_memory: collectNativeSessionMemory(groupFolder),
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
  } finally {
    // Clean up ephemeral group folders in task scope; agent scope retains
    // the group folder for session persistence across tasks.
    if (scope === 'task' && wipeWorkspacePerTask) {
      cleanupGroup(groupFolder);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
