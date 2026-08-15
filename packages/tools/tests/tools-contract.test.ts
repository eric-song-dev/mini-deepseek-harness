import { describe } from 'vitest'
import { createToolRegistry } from '@mini-dsh/tools'
import { runToolsContract } from './contracts/tools-contract'

/** 默认注册表实现跑契约套件（SQLite 后端同款模式：实现换一套，契约一份）。 */
describe('createToolRegistry（默认 Tools seam 实现）', () => {
  runToolsContract({ make: () => createToolRegistry() })
})
