import { describe, it, expect } from 'vitest';
import { extractAssistantText, extractStructuredForumText } from './extract.js';

/** Helper to wrap text in the SDK assistant message shape. */
function assistantMsg(text: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
}

describe('extractAssistantText', () => {
  it('extracts text from assistant message', () => {
    expect(extractAssistantText(assistantMsg('hello world'))).toBe('hello world');
  });

  it('joins multiple text blocks', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'a ' }, { type: 'text', text: 'b' }] },
    };
    expect(extractAssistantText(msg)).toBe('a b');
  });

  it('skips non-text blocks', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash' },
          { type: 'text', text: 'result' },
        ],
      },
    };
    expect(extractAssistantText(msg)).toBe('result');
  });

  it('returns null for empty content', () => {
    expect(extractAssistantText(assistantMsg(''))).toBeNull();
  });

  it('returns null for non-array content', () => {
    expect(extractAssistantText({ message: { content: 'plain' } })).toBeNull();
  });

  it('returns null for missing message', () => {
    expect(extractAssistantText({})).toBeNull();
  });
});

describe('extractStructuredForumText', () => {
  it('extracts INSIGHT block from clean output', () => {
    const text = [
      'INSIGHT',
      'insight_id: ins-001',
      'scope: task',
      'evidence_task_ids: task-1',
      'text: always validate input',
    ].join('\n');
    const result = extractStructuredForumText(assistantMsg(text));
    expect(result).toContain('INSIGHT');
    expect(result).toContain('insight_id: ins-001');
    expect(result).toContain('text: always validate input');
  });

  it('extracts COMMENT block from clean output', () => {
    const text = [
      'COMMENT',
      'target_insight_id: ins-001',
      'stance: support',
      'text: agreed, this is important',
    ].join('\n');
    const result = extractStructuredForumText(assistantMsg(text));
    expect(result).toContain('COMMENT');
    expect(result).toContain('target_insight_id: ins-001');
  });

  it('extracts structured block after leading prose', () => {
    const text = [
      'I analyzed the tasks and found some patterns.',
      '',
      'INSIGHT',
      'scope: meta',
      'text: check edge cases first',
    ].join('\n');
    const result = extractStructuredForumText(assistantMsg(text));
    expect(result).not.toBeNull();
    expect(result!.startsWith('INSIGHT')).toBe(true);
    expect(result).not.toContain('I analyzed');
  });

  it('captures everything from first block to end', () => {
    const text = [
      'INSIGHT',
      'scope: task',
      'text: first insight',
      '',
      'INSIGHT',
      'scope: meta',
      'text: second insight',
    ].join('\n');
    const result = extractStructuredForumText(assistantMsg(text));
    expect(result).toContain('first insight');
    expect(result).toContain('second insight');
  });

  it('returns null when no structured block present', () => {
    const text = 'I applied the patch to fix the bug in parser.py';
    expect(extractStructuredForumText(assistantMsg(text))).toBeNull();
  });

  it('returns null for empty message', () => {
    expect(extractStructuredForumText(assistantMsg(''))).toBeNull();
  });

  it('does not match INSIGHTFUL or COMMENTARY (partial keywords)', () => {
    const text = 'INSIGHTFUL analysis of the code\nCOMMENTARY on the design';
    expect(extractStructuredForumText(assistantMsg(text))).toBeNull();
  });

  it('matches with leading whitespace on the INSIGHT line', () => {
    const text = [
      '  INSIGHT',
      'scope: task',
      'text: works with indent',
    ].join('\n');
    const result = extractStructuredForumText(assistantMsg(text));
    expect(result).toContain('INSIGHT');
    expect(result).toContain('works with indent');
  });

  it('does not match INSIGHT embedded mid-line', () => {
    const text = 'My INSIGHT is that the code is buggy';
    expect(extractStructuredForumText(assistantMsg(text))).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(extractStructuredForumText(null)).toBeNull();
    expect(extractStructuredForumText(undefined)).toBeNull();
  });
});
