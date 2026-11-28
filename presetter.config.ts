import esm from '@presetter/preset-esm';
import node from '@presetter/preset-node';
import strict from '@presetter/preset-strict';
import { asset, preset } from 'presetter';

import { name } from './package.json' with { type: 'json' };

export default preset(name, {
  extends: [esm, node, strict],
  variables: {
    // the brief and .gitignore expect build output in dist
    output: 'dist',
  },
  override: {
    scripts: {
      // husky writes core.hooksPath into the git config shared with sibling
      // jj workspaces/worktrees; skip it so `prepare` never touches git config
      'setup:husky': 'echo "husky disabled: skipped to keep git config untouched"',
    },
    assets: {
      // tagged-template HTML is rendered output: formatting it would change bytes
      '.prettierrc.json': { embeddedLanguageFormatting: 'off' },
      '.husky/pre-commit': null,
      '.husky/pre-push': null,
      '.gitignore': asset<string[]>((current) => [
        ...(current ?? []),
        '',
        '*.sqlite',
        '*.sqlite-journal',
        '*.sqlite-shm',
        '*.sqlite-wal',
      ]),
    },
  },
});
