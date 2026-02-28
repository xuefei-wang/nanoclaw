/**
 * Swarms bench task runner — single-shot NanoClaw executor.
 *
 * Usage:
 *   npx tsx src/bench/task-runner.ts <payload.json>
 *   npm run bench:task -- <payload.json>
 *
 * Input (payload.json):
 *   {
 *     "generation": int,
 *     "agent_id": string,
 *     "task": { "id": str, "repo": str, "prompt": str, "metadata": {} },
 *     "workspace_seed": {
 *       "instruction_md": str,
 *       "insights_md":   str,
 *       "memory_md":     str,
 *       "task_md":       str,
 *       "repo_source_path": str   // optional host path to copy
 *     },
 *     "execution_prompt": str,
 *     "runtime": {
 *       "session_scope": "task" | "agent",
 *       "wipe_workspace_per_task": bool
 *     }
 *   }
 *
 * Output (stdout, single JSON line):
 *   { "result": str, "tool_trace": [...], "meta": {} }
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { runContainerAgent, ContainerOutput } from '../container-runner.js';
import { GROUPS_DIR, DATA_DIR } from '../config.js';
import { RegisteredGroup } from '../types.js';

// ── Payload types ────────────────────────────────────────────────────────────

interface TaskPayload {
  generation: number;
  agent_id: string;
  task: {
    id: string;
    repo: string;
    prompt: string;
    metadata: Record<string, unknown>;
  };
  workspace_seed: {
    instruction_md: string;
    insights_md: string;
    memory_md: string;
    task_md: string;
    repo_source_path?: string;
  };
  execution_prompt: string;
  runtime: {
    session_scope: 'task' | 'agent';
    wipe_workspace_per_task: boolean;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
}

function writeWorkspace(
  groupFolder: string,
  seed: TaskPayload['workspace_seed'],
): void {
  const workspaceDir = path.join(GROUPS_DIR, groupFolder, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const writeIfNotEmpty = (filename: string, content: string): void => {
    if (content && content.trim()) {
      fs.writeFileSync(path.join(workspaceDir, filename), content, 'utf-8');
    }
  };

  writeIfNotEmpty('TASK.md', seed.task_md);
  writeIfNotEmpty('INSTRUCTION.md', seed.instruction_md);
  writeIfNotEmpty('MEMORY.md', seed.memory_md);
  writeIfNotEmpty('INSIGHTS.md', seed.insights_md);

  // Copy repo source if provided
  const repoSrcPath = seed.repo_source_path;
  if (repoSrcPath && fs.existsSync(repoSrcPath)) {
    const repoDestDir = path.join(workspaceDir, 'repo');
    fs.rmSync(repoDestDir, { recursive: true, force: true });
    const stat = fs.statSync(repoSrcPath);
    if (stat.isDirectory()) {
      fs.cpSync(repoSrcPath, repoDestDir, { recursive: true });
    } else {
      fs.mkdirSync(repoDestDir, { recursive: true });
      fs.copyFileSync(
        repoSrcPath,
        path.join(repoDestDir, path.basename(repoSrcPath)),
      );
    }
  } else {
    // Write a placeholder so /workspace/group/workspace/repo exists
    const repoDestDir = path.join(workspaceDir, 'repo');
    fs.mkdirSync(repoDestDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDestDir, 'README.md'),
      `# ${seed.task_md.match(/task_id:\s*(\S+)/)?.[1] ?? 'task'}\nNo repo source path provided.\n`,
      'utf-8',
    );
  }
}

function cleanupGroup(groupFolder: string): void {
  try {
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    fs.rmSync(groupDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  try {
    const sessionDir = path.join(DATA_DIR, 'sessions', groupFolder);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  try {
    const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder);
    fs.rmSync(ipcDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    process.stderr.write('usage: task-runner.ts <payload.json>\n');
    process.exit(2);
  }

  let payload: TaskPayload;
  try {
    const raw = fs.readFileSync(payloadPath, 'utf-8');
    payload = JSON.parse(raw) as TaskPayload;
  } catch (err) {
    process.stderr.write(`Failed to read payload: ${err}\n`);
    process.exit(2);
  }

  const {
    generation,
    agent_id,
    task,
    workspace_seed,
    execution_prompt,
    runtime,
  } = payload;

  // Unique folder per task execution (prevents cross-contamination)
  const uid = randomUUID().slice(0, 8);
  const groupFolder = `bench-${safeSlug(agent_id)}-${safeSlug(task.id)}-${uid}`;
  const chatJid = `bench-task@swarms.local`;

  try {
    // 1. Write workspace seed files
    writeWorkspace(groupFolder, workspace_seed);

    // 2. Build group and container input
    const group: RegisteredGroup = {
      name: `bench/${agent_id}/${task.id}`,
      folder: groupFolder,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };

    const secrets: Record<string, string> = {};
    if (process.env.ANTHROPIC_API_KEY)
      secrets.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
      secrets.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (process.env.LLM_API_KEY && !secrets.ANTHROPIC_API_KEY)
      secrets.ANTHROPIC_API_KEY = process.env.LLM_API_KEY;

    // 3. Run the container agent (single-shot via isScheduledTask)
    // Pass onOutput so the streaming parser catches OUTPUT markers in
    // real-time.  Without it, the container-runner skips marker parsing
    // and relies on the legacy parser, which only runs on clean exit.
    // If the SDK's query() generator hangs after the result, the
    // container times out and the output is lost.
    let lastOutput: ContainerOutput | undefined;
    const containerOutput = await runContainerAgent(
      group,
      {
        prompt: execution_prompt,
        groupFolder,
        chatJid,
        isMain: false,
        isScheduledTask: true,
        secrets,
      },
      (_proc, _name) => {
        /* no-op process callback */
      },
      async (output) => {
        lastOutput = output;
      },
    );

    // 4. Emit result JSON to stdout
    // In streaming mode, runContainerAgent returns a completion marker
    // { status: 'success', result: null }.  The actual result text was
    // captured by the onOutput callback in lastOutput.  Prefer it.
    const effectiveOutput =
      lastOutput?.result != null ? lastOutput : containerOutput;
    const output = {
      result: effectiveOutput.result ?? effectiveOutput.error ?? '',
      tool_trace:
        (effectiveOutput as unknown as Record<string, unknown>).toolTrace ?? [],
      meta: {
        generation,
        agent_id,
        task_id: task.id,
        status: effectiveOutput.status,
        session_scope: runtime.session_scope,
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
  } finally {
    // 5. Always clean up the ephemeral group folder
    if (runtime.wipe_workspace_per_task) {
      cleanupGroup(groupFolder);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`task-runner fatal error: ${err}\n`);
  process.exit(1);
});
