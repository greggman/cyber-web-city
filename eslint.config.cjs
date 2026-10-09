const gts = require('gts');
module.exports = [
  {ignores: ['dist/', 'out/', 'node_modules/']},
  ...gts,
  {
    // node:test's test() returns a promise the runner tracks itself.
    files: ['test/**/*.ts'],
    rules: {'@typescript-eslint/no-floating-promises': 'off'},
  },
];
