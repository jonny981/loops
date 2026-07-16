import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('loads fragments from a configured subdirectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    mkdirSync(join(dir, 'fragments'));
    writeFileSync(join(dir, 'task.md'), 'Build {{thing}}\n{{> footer}}');
    writeFileSync(join(dir, 'fragments', 'footer.md'), 'Ship {{thing}}.');

    expect(
      promptBank(dir, { fragmentsDir: 'fragments' }).render('task', {
        thing: 'the adapter',
      }),
    ).toBe('Build the adapter\nShip the adapter.');
  });

  it('resolves nested includes from the configured fragments directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    mkdirSync(join(dir, 'fragments'));
    writeFileSync(join(dir, 'task.md'), '{{> footer}}');
    writeFileSync(join(dir, 'fragments', 'footer.md'), 'Ship it.\n{{> legal}}');
    writeFileSync(join(dir, 'fragments', 'legal.md'), 'Terms apply.');

    expect(promptBank(dir, { fragmentsDir: 'fragments' }).render('task')).toBe(
      'Ship it.\nTerms apply.',
    );
  });

  it('distinguishes a root template from a same-named fragment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    mkdirSync(join(dir, 'fragments'));
    writeFileSync(join(dir, 'task.md'), 'Root\n{{> task}}');
    writeFileSync(join(dir, 'fragments', 'task.md'), 'Fragment');

    expect(promptBank(dir, { fragmentsDir: 'fragments' }).render('task')).toBe(
      'Root\nFragment',
    );
  });

  it('reports cycles within a configured fragments directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    mkdirSync(join(dir, 'fragments'));
    writeFileSync(join(dir, 'task.md'), '{{> a}}');
    writeFileSync(join(dir, 'fragments', 'a.md'), '{{> b}}');
    writeFileSync(join(dir, 'fragments', 'b.md'), '{{> a}}');

    expect(() => promptBank(dir, { fragmentsDir: 'fragments' }).render('task')).toThrow(
      /prompt include cycle: task -> a -> b -> a/,
    );
  });

  it('rejects an absolute or escaping fragments directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));

    expect(() => promptBank(dir, { fragmentsDir: '../fragments' })).toThrow(
      /fragments directory escapes prompt bank/,
    );
    expect(() => promptBank(dir, { fragmentsDir: join(dir, 'fragments') })).toThrow(
      /fragments directory must be relative/,
    );
  });

  it('rejects a configured fragments directory symlink that resolves outside the bank', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    const outside = mkdtempSync(join(tmpdir(), 'loops-prompts-outside-'));
    symlinkSync(outside, join(dir, 'fragments'), 'dir');

    expect(() => promptBank(dir, { fragmentsDir: 'fragments' })).toThrow(
      /fragments directory resolves outside prompt bank/,
    );
  });

  it('rejects a nested fragment symlink that resolves outside the fragments directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    const outside = mkdtempSync(join(tmpdir(), 'loops-prompts-outside-'));
    mkdirSync(join(dir, 'fragments'));
    writeFileSync(join(dir, 'task.md'), '{{> wrapper}}');
    writeFileSync(join(dir, 'fragments', 'wrapper.md'), '{{> footer}}');
    writeFileSync(join(outside, 'footer.md'), 'escaped');
    symlinkSync(join(outside, 'footer.md'), join(dir, 'fragments', 'footer.md'));

    expect(() => promptBank(dir, { fragmentsDir: 'fragments' }).render('task')).toThrow(
      /fragment resolves outside configured fragments directory: footer/,
    );
  });

  it('retains root template symlink behavior with a configured fragments directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    const outside = mkdtempSync(join(tmpdir(), 'loops-prompts-outside-'));
    mkdirSync(join(dir, 'fragments'));
    writeFileSync(join(outside, 'task.md'), 'Root\n{{> footer}}');
    writeFileSync(join(dir, 'fragments', 'footer.md'), 'Fragment');
    symlinkSync(join(outside, 'task.md'), join(dir, 'task.md'));

    expect(promptBank(dir, { fragmentsDir: 'fragments' }).render('task')).toBe(
      'Root\nFragment',
    );
  });

  it('retains default fragment symlink behavior', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-prompts-'));
    const outside = mkdtempSync(join(tmpdir(), 'loops-prompts-outside-'));
    writeFileSync(join(dir, 'task.md'), '{{> footer}}');
    writeFileSync(join(outside, 'footer.md'), 'legacy');
    symlinkSync(join(outside, 'footer.md'), join(dir, 'footer.md'));

    expect(promptBank(dir).render('task')).toBe('legacy');
  });
});
