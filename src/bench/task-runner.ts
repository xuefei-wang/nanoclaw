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
  memory_md?: string;
  task_md?: string;
  tools_md?: string;
  task_files?: Record<string, string>;
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
  enable_specialty_query?: boolean;
  snapshot_path?: string;
  enable_arc_tools?: boolean;
}

interface SwarmsPayload {
  generation: number;
  agent_id: string;
  task: TaskPayload;
  workspace_seed?: WorkspaceSeed;
  execution_prompt?: string;
  runtime?: RuntimeConfig;
  experiment_name?: string;
  memory?: {
    db_path: string;
    mcp_server_dir: string;
    enable_specialty_query?: boolean;
    snapshot_path?: string;
    enable_arc_tools?: boolean;
  };
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

function removeFileIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // best-effort cleanup only
  }
}

export function buildWorkspaceMemoryMd(seedMemoryMd: string): string {
  if (!seedMemoryMd.trim()) {
    return '';
  }
  return [
    '# MEMORY',
    '',
    'Seed context is already loaded into the system prompt for this run.',
    'This file is only a pointer/debug aid.',
    '',
    'Use task-local files and MCP memory tools for detailed retrieval.',
  ].join('\n');
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
  const seedContextPath = path.join(groupDir, '.seed_context');
  // Guardrail: keep transient seed context explicitly run-scoped and avoid
  // leaking stale seed text into later executions when folders are reused.
  removeFileIfExists(seedContextPath);

  const workspaceRoot = path.join(groupDir, 'workspace');
  if (wipeWorkspacePerTask) {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
  ensureDir(workspaceRoot);

  const seed = payload.workspace_seed || {};
  const instruction = (seed.instruction_md || '').trim() + '\n';
  const seedMemory = (seed.memory_md || '').trim();
  const memory = buildWorkspaceMemoryMd(seedMemory).trim() + '\n';
  const taskMd = (seed.task_md || '').trim() + '\n';
  const taskFiles = seed.task_files || {};

  if (seedMemory) {
    writeText(seedContextPath, seedMemory + '\n');
  }

  writeText(path.join(workspaceRoot, 'INSTRUCTION.md'), instruction);
  writeText(path.join(workspaceRoot, 'MEMORY.md'), memory);

  const tools = (seed.tools_md || '').trim();
  if (tools) {
    writeText(path.join(workspaceRoot, 'TOOLS.md'), tools + '\n');
  }
  const tasksRoot = path.join(workspaceRoot, 'tasks');
  ensureDir(tasksRoot);

  const taskFolder = safeTaskDir(payload.task?.id || 'task');
  const taskRoot = path.join(tasksRoot, taskFolder);
  if (wipeWorkspacePerTask) {
    fs.rmSync(taskRoot, { recursive: true, force: true });
  }
  ensureDir(taskRoot);
  writeText(path.join(taskRoot, 'TASK.md'), taskMd);
  for (const [name, content] of Object.entries(taskFiles)) {
    const fileName = path.basename(String(name || '').trim());
    if (!fileName || fileName === 'TASK.md') continue;
    writeText(path.join(taskRoot, fileName), (content || '').trim() + '\n');
  }

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

function envInt(name: string, defaultValue: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return parsed;
}

function walkFiles(
  root: string,
  filter: (absPath: string) => boolean,
): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(current, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile() && filter(abs)) {
        out.push(abs);
      }
    }
  }
  return out;
}

function collectNativeSessionMemory(groupFolder: string): string {
  if (!groupFolder) return '';
  const maxChars = envInt('SWARMS_NATIVE_MEMORY_MAX_CHARS', 240_000);
  const maxFiles = envInt('SWARMS_NATIVE_MEMORY_MAX_FILES', 8);
  const maxCharsPerFile = envInt(
    'SWARMS_NATIVE_MEMORY_MAX_CHARS_PER_FILE',
    60_000,
  );
  if (maxChars <= 0) return '';

  const claudeRoot = path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  const files = walkFiles(claudeRoot, (p) =>
    ['.jsonl', '.md', '.txt'].includes(path.extname(p).toLowerCase()),
  );
  if (files.length === 0) return '';
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  const selected = maxFiles > 0 ? files.slice(0, maxFiles) : files;
  const blocks: string[] = [];
  let total = 0;
  for (const file of selected) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (!raw.trim()) continue;
    const chunk =
      maxCharsPerFile > 0 && raw.length > maxCharsPerFile
        ? raw.slice(-maxCharsPerFile)
        : raw;
    const rel = path.relative(claudeRoot, file);
    const wrapped = `# file: ${rel}\n${chunk}\n`;
    blocks.push(wrapped);
    total += wrapped.length + (blocks.length > 1 ? '\n\n---\n\n'.length : 0);
    if (total >= maxChars) break;
  }

  let merged = blocks.join('\n\n---\n\n').trim();
  if (merged.length > maxChars) {
    merged = merged.slice(-maxChars);
  }
  return merged;
}

function collectConversationArchives(
  groupFolder: string,
): Array<{ path: string; content: string }> {
  if (!groupFolder) return [];
  const maxFiles = envInt('SWARMS_ARCHIVE_MAX_FILES', 8);
  const maxCharsPerFile = envInt('SWARMS_ARCHIVE_MAX_CHARS_PER_FILE', 30_000);
  if (maxFiles <= 0) return [];

  const convRoot = path.join(GROUPS_DIR, groupFolder, 'conversations');
  const files = walkFiles(
    convRoot,
    (p) => path.extname(p).toLowerCase() === '.md',
  );
  if (files.length === 0) return [];
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  const out: Array<{ path: string; content: string }> = [];
  for (const file of files.slice(0, maxFiles)) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (maxCharsPerFile > 0 && content.length > maxCharsPerFile) {
      content = content.slice(-maxCharsPerFile);
    }
    out.push({ path: path.relative(convRoot, file), content });
  }
  return out;
}

export function buildPrompt(payload: SwarmsPayload): string {
  const instruction = (payload.execution_prompt || '').trim();
  const taskFolder = safeTaskDir(payload.task?.id || 'task');
  const activeTaskDir = `/workspace/group/workspace/tasks/${taskFolder}`;
  const taskHint = [
    'Use this workspace:',
    '- Only edit files under the active task repo path.',
    '- Shared guidance:',
    '  - /workspace/group/workspace/INSTRUCTION.md',
    '  - Seed context is already loaded into the system prompt when present.',
    '  - /workspace/group/workspace/MEMORY.md (pointer/debug summary only)',
    '  - /workspace/group/workspace/TOOLS.md (available tools and when to use them)',
    `- Active task workspace: ${activeTaskDir}`,
    `  - ${activeTaskDir}/TASK.md`,
    `  - ${activeTaskDir}/repo`,
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

  // Set up memory mounts if memory DB path is configured
  const memoryDbPath = payload.memory?.db_path || '';
  const mcpServerDir = payload.memory?.mcp_server_dir || '';
  const memorySnapshotPath = payload.memory?.snapshot_path || '';
  const taskSource = String(
    (payload.task?.metadata || {}).task_source || '',
  ).toLowerCase();
  const forumWritesNeeded =
    taskSource === 'forum_debate' || taskSource === 'forum_self';

  const additionalMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];
  if (memoryDbPath) {
    // Mount the directory containing the SQLite DB (SQLite needs WAL/SHM files too)
    const dbDir = path.dirname(path.resolve(memoryDbPath));
    if (fs.existsSync(dbDir)) {
      additionalMounts.push({
        hostPath: dbDir,
        containerPath: '/app/memory-db',
        readonly: !forumWritesNeeded,
      });
      // Set the container-side path so findMemoryDb() picks the correct file
      // when multiple .sqlite files exist in the same directory.
      const dbFilename = path.basename(path.resolve(memoryDbPath));
      process.env.MEMORY_DB_PATH = `/app/memory-db/${dbFilename}`;
    }
  }
  if (mcpServerDir && fs.existsSync(mcpServerDir)) {
    additionalMounts.push({
      hostPath: path.resolve(mcpServerDir),
      containerPath: '/app/memory',
      readonly: true,
    });
  }
  const resolvedSnapshotPath = memorySnapshotPath ? path.resolve(memorySnapshotPath) : '';
  if (resolvedSnapshotPath) {
    if (fs.existsSync(resolvedSnapshotPath)) {
      additionalMounts.push({
        hostPath: path.dirname(resolvedSnapshotPath),
        containerPath: '/app/memory-snapshot',
        readonly: true,
      });
    } else {
      process.stderr.write(
        `Warning: Memory snapshot file does not exist: ${resolvedSnapshotPath} — snapshot-backed memory MCP will not be available\n`,
      );
    }
  }

  // Disable agent teams in bench mode to prevent token-consuming sub-agents
  process.env.NANOCLAW_DISABLE_AGENT_TEAMS = '1';

  const group: RegisteredGroup = {
    name: `swarms-${payload.agent_id}`,
    folder: groupFolder,
    trigger: '@Swarms',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    containerConfig:
      additionalMounts.length > 0 ? { additionalMounts } : undefined,
  };

  try {
    let lastOutput: ContainerOutput | undefined;
    let latestSessionId: string | undefined = sessionId;

    // Build memory MCP config from payload if present.
    const taskMeta = (payload.task?.metadata ?? {}) as Record<string, unknown>;
    const memoryMcp = payload.memory
      ? {
          dbPath: payload.memory.db_path,
          serverDir: payload.memory.mcp_server_dir,
          enableSpecialtyQuery: Boolean(payload.memory.enable_specialty_query),
          enableArcTools: payload.memory.enable_arc_tools !== false,
          snapshotPath: payload.memory.snapshot_path,
          taskId: payload.task?.id || '',
          taskSource: String(taskMeta.task_source ?? ''),
          forumGeneration: taskMeta.forum_generation as number | undefined,
          forumRound: taskMeta.forum_round as number | undefined,
          forumAgentId: taskMeta.forum_agent_id as string | undefined,
          forumExpectedAgents: taskMeta.forum_expected_agents as
            | number
            | undefined,
          forumTaskIds: Array.isArray(taskMeta.forum_task_ids)
            ? taskMeta.forum_task_ids
                .map((x) => String(x || '').trim())
                .filter(Boolean)
            : [],
          experiment: payload.experiment_name,
        }
      : undefined;

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
        memoryMcp,
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

    const rawTrace = ((effectiveOutput as unknown as Record<string, unknown>)
      .toolTrace ?? []) as Array<Record<string, unknown>>;

    // Build tool call summary from trace entries for easy querying.
    const toolCallCounts: Record<string, number> = {};
    for (const entry of rawTrace) {
      if (entry.type === 'tool_call' && typeof entry.tool_name === 'string') {
        const name = entry.tool_name;
        toolCallCounts[name] = (toolCallCounts[name] || 0) + 1;
      }
    }
    const memoryToolCallCounts: Record<string, number> = {};
    const arcToolCallCounts: Record<string, number> = {};
    const forumToolCallCounts: Record<string, number> = {};
    for (const [name, count] of Object.entries(toolCallCounts)) {
      if (name.startsWith('mcp__memory__')) {
        memoryToolCallCounts[name] = count;
      }
      if (name.startsWith('mcp__arc__arc_')) {
        arcToolCallCounts[name] = count;
      }
      if (name.startsWith('mcp__memory__forum_')) {
        forumToolCallCounts[name] = count;
      }
    }

    // Capture native artifacts before potential task-scope cleanup.
    const nativeSessionMemory = collectNativeSessionMemory(groupFolder);
    const conversationArchives = collectConversationArchives(groupFolder);

    const output = {
      result: effectiveOutput.result ?? effectiveOutput.error ?? '',
      tool_trace: rawTrace,
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
        native_session_memory: nativeSessionMemory,
        conversation_archives: conversationArchives,
        tool_call_counts: toolCallCounts,
        memory_tool_call_counts: memoryToolCallCounts,
        arc_tool_call_counts: arcToolCallCounts,
        forum_tool_call_counts: forumToolCallCounts,
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

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (import.meta.url === `file://${entryPath}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
