import { describe, expect, it } from 'vitest';

import { buildSystemPromptAppend, summarizeToolInput } from './prompt-utils.js';

describe('buildSystemPromptAppend', () => {
  it('returns undefined when there is no global or seed context', () => {
    expect(buildSystemPromptAppend(undefined, '   ')).toBeUndefined();
  });

  it('combines global memory and ephemeral seed context', () => {
    const out = buildSystemPromptAppend('# Global', 'seed payload');
    expect(out).toContain('# Global');
    expect(out).toContain('# Ephemeral Seed Context');
    expect(out).toContain('seed payload');
  });
});

describe('summarizeToolInput', () => {
  it('extracts read file path for Read tool calls', () => {
    expect(
      summarizeToolInput('Read', { file_path: '/workspace/group/workspace/MEMORY.md' }),
    ).toEqual({
      file_path: '/workspace/group/workspace/MEMORY.md',
      read_file_path: '/workspace/group/workspace/MEMORY.md',
    });
  });

  it('extracts common path metadata for file tools', () => {
    expect(
      summarizeToolInput('Edit', {
        old_path: 'a.txt',
        new_path: 'b.txt',
        pattern: 'foo',
      }),
    ).toEqual({
      old_path: 'a.txt',
      new_path: 'b.txt',
      pattern: 'foo',
    });
  });
});
