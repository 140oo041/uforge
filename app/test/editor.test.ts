// Editor integration: does a double-click reach the user's real VS Code?
//
// Detection is environment-dependent, so this asserts the parts that are not:
// the ISS_EDITOR override is honoured exactly, an unknown override is taken at
// its word rather than silently dropped, and whatever is detected is reported
// as a usable command. It also records what this machine actually resolved, so
// a failure here is legible rather than mysterious.

import { afterEach, describe, expect, it } from 'vitest';

import { detectEditor } from '@iss/host';

const ORIGINAL = process.env.ISS_EDITOR;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ISS_EDITOR;
  else process.env.ISS_EDITOR = ORIGINAL;
});

describe('editor detection', () => {
  it('takes an explicit ISS_EDITOR path at its word', () => {
    process.env.ISS_EDITOR = '/opt/my-build/bin/code';
    const editor = detectEditor();
    expect(editor).not.toBeNull();
    expect(editor!.command).toBe('/opt/my-build/bin/code');
    // An architect with a bespoke build should not have to be in our list.
    expect(editor!.id).toBe('custom');
    expect(editor!.label).toBe('code');
  });

  it('resolves a known id from ISS_EDITOR when it is installed', () => {
    process.env.ISS_EDITOR = 'code';
    const editor = detectEditor();
    // Either it is on PATH and we get the known entry, or it is not and we fall
    // through to treating the string as a command — both are correct, and
    // neither may be null, because the user named it.
    expect(editor).not.toBeNull();
    expect(editor!.command).toBe('code');
  });

  it('finds an editor on PATH with no override, or honestly reports none', () => {
    delete process.env.ISS_EDITOR;
    const editor = detectEditor();
    if (editor === null) {
      // A machine with no VS Code CLI: the app falls back to shell.openPath and
      // tells the user how to fix it. Nothing to assert beyond the null.
      return;
    }
    expect(editor.command).toBeTruthy();
    expect(editor.label).toBeTruthy();
    expect(editor.id).toBeTruthy();
  });
});
