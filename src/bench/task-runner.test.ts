import { describe, expect, it } from 'vitest';

import { buildPrompt, buildWorkspaceMemoryMd } from './task-runner.js';

describe('buildWorkspaceMemoryMd', () => {
  it('returns empty string when there is no seed context', () => {
    expect(buildWorkspaceMemoryMd('   ')).toBe('');
  });

  it('demotes MEMORY.md to a pointer when seed context exists', () => {
    const md = buildWorkspaceMemoryMd('seeded forum insight');
    expect(md).toContain('Seed context is already loaded into the system prompt');
    expect(md).toContain('pointer/debug aid');
    expect(md).not.toContain('seeded forum insight');
  });
});

describe('buildPrompt', () => {
  it('tells the agent seed context is already in the system prompt', () => {
    const prompt = buildPrompt({
      generation: 1,
      agent_id: 'agent-0',
      task: { id: 'task-1' },
      execution_prompt: 'Do the task.',
    });
    expect(prompt).toContain('Seed context is already loaded into the system prompt');
    expect(prompt).toContain('/workspace/group/workspace/MEMORY.md (pointer/debug summary only)');
    expect(prompt).toContain('/workspace/group/workspace/tasks/task-1/TASK.md');
  });
});
