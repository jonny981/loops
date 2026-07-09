import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { promptBank } from '../src/api.ts';

describe('promptBank', () => {
  it('renders variables and reusable fragments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    writeFileSync(join(dir, 'task.md'), 'Build {{thing}}\n{{> footer}}\n');
    writeFileSync(join(dir, 'footer.md'), 'Ship {{thing}}.');

    expect(promptBank(dir).render('task', { thing: 'the adapter' })).toBe(
      'Build the adapter\nShip the adapter.',
    );
  });

  it('fails on unresolved and unused variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    writeFileSync(join(dir, 'task.md'), 'Build {{thing}}.');
    const bank = promptBank(dir);

    expect(() => bank.render('task')).toThrow(/unresolved placeholder/);
    expect(() => bank.render('task', { thing: 'x', extra: 'y' })).toThrow(/unused var/);
  });

  it('allows a fragment to be included twice but rejects cycles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    writeFileSync(join(dir, 'twice.md'), '{{> line}}\n{{> line}}');
    writeFileSync(join(dir, 'line.md'), 'Line {{name}}');
    writeFileSync(join(dir, 'a.md'), '{{> b}}');
    writeFileSync(join(dir, 'b.md'), '{{> a}}');

    expect(promptBank(dir).render('twice', { name: 'A' })).toBe('Line A\nLine A');
    expect(() => promptBank(dir).render('a')).toThrow(/include cycle/);
  });

  it('contains template names to the bank root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    writeFileSync(join(dir, 'task.md'), 'ok');

    expect(() => promptBank(dir).render('../package')).toThrow(/escapes prompt bank/);
    expect(() => promptBank(dir).render('/tmp/package')).toThrow(/must be relative/);
  });
});
