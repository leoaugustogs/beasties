// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu({ ignores: ['bench/**'] }).append({
  files: ['**/test/**'],
  rules: {
    'no-console': 'off',
  },
}).append({
  rules: {
    'pnpm/yaml-enforce-settings': 'off',
  },
})
