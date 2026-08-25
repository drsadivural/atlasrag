import { baseConfig, reactRules, toolingOverrides, ignores } from './packages/config/eslint.config.js';

export default [
  { ignores },
  ...baseConfig,
  reactRules,
  toolingOverrides,
];
