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

interface ArcConfig {
  mcp_server_dir?: string;
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
  };
  arc?: {
    mcp_server_dir: string;
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
  const memory = (seed.memory_md || '').trim() + '\n';
  const taskMd = (seed.task_md || '').trim() + '\n';

  writeText(path.join(workspaceRoot, 'INSTRUCTION.md'), instruction);
  writeText(path.join(workspaceRoot, 'MEMORY.md'), memory);
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

function buildPrompt(payload: SwarmsPayload): string {
  const instruction = (payload.execution_prompt || '').trim();
  const taskFolder = safeTaskDir(payload.task?.id || 'task');
  const activeTaskDir = `/workspace/group/workspace/tasks/${taskFolder}`;
  const taskHint = [
    'Use this workspace:',
    '- Only edit files under the active task repo path.',
    '- Shared guidance:',
    '  - /workspace/group/workspace/INSTRUCTION.md',
    '  - /workspace/group/workspace/MEMORY.md (pointers to collective memory)',
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
  const arcMcpServerDir = payload.arc?.mcp_server_dir || '';

  const additionalMounts: Array<{hostPath: string; containerPath: string; readonly: boolean}> = [];
  if (memoryDbPath) {
    // Mount the directory containing the SQLite DB (SQLite needs WAL/SHM files too)
    const dbDir = path.dirname(path.resolve(memoryDbPath));
    if (fs.existsSync(dbDir)) {
      additionalMounts.push({
        hostPath: dbDir,
        containerPath: '/app/memory-db',
        readonly: false,  // Forum debate needs write access
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

  // Disable agent teams in bench mode to prevent token-consuming sub-agents
  process.env.NANOCLAW_DISABLE_AGENT_TEAMS = '1';

  const group: RegisteredGroup = {
    name: `swarms-${payload.agent_id}`,
    folder: groupFolder,
    trigger: '@Swarms',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    containerConfig: additionalMounts.length > 0 ? { additionalMounts } : undefined,
  };

  try {
    let lastOutput: ContainerOutput | undefined;
    let latestSessionId: string | undefined = sessionId;

    // Build memory MCP config from payload if present.
    const memoryMcp = payload.memory ? {
      dbPath: payload.memory.db_path,
      serverDir: payload.memory.mcp_server_dir,
      forumGeneration: ((payload.task?.metadata ?? {}) as Record<string, unknown>).forum_generation as number | undefined,
      forumAgentId: ((payload.task?.metadata ?? {}) as Record<string, unknown>).forum_agent_id as string | undefined,
      forumExpectedAgents: ((payload.task?.metadata ?? {}) as Record<string, unknown>).forum_expected_agents as number | undefined,
      experiment: payload.experiment_name,
    } : undefined;

    const taskMeta = (payload.task?.metadata ?? {}) as Record<string, unknown>;
    const taskSource = String(taskMeta.task_source || '').trim().toLowerCase();
    const taskFolder = safeTaskDir(payload.task?.id || 'task');
    const activeTaskDir = `/workspace/group/workspace/tasks/${taskFolder}`;
    const arcMcp = (taskSource === 'arc' && arcMcpServerDir) ? {
      serverDir: path.resolve(arcMcpServerDir),
      taskId: payload.task?.id || '',
      trainJson: JSON.stringify(taskMeta.arc_train ?? []),
      testInputsJson: JSON.stringify(taskMeta.arc_test_inputs ?? []),
      expectedOutputsJson: JSON.stringify(taskMeta.arc_expected_outputs ?? []),
      maxTrials: Number(taskMeta.arc_max_trials ?? 2),
      stateJsonPath: `${activeTaskDir}/arc_state.json`,
    } : undefined;

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
        arcMcp,
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

    const rawTrace =
      ((effectiveOutput as unknown as Record<string, unknown>).toolTrace ?? []) as Array<Record<string, unknown>>;

    // Build tool call summary from trace entries for easy querying.
    const toolCallCounts: Record<string, number> = {};
    for (const entry of rawTrace) {
      if (entry.type === 'tool_call' && typeof entry.tool_name === 'string') {
        toolCallCounts[entry.tool_name] = (toolCallCounts[entry.tool_name] || 0) + 1;
      }
    }

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
        native_session_memory: '',
        tool_call_counts: toolCallCounts,
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
