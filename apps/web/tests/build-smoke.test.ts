import { describe, expect, it } from 'vitest'
import { build } from 'vite'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const appRoot = resolve(here, '..')

describe('apps/web 构建冒烟（M4：Vite entry 壳产出可部署产物）', () => {
  it('vite build 成功：dist 含 index.html（带 #root 挂载点）与打包后的 JS 入口', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'mini-dsh-build-'))
    try {
      await build({
        configFile: join(appRoot, 'vite.config.ts'),
        root: appRoot,
        build: { outDir, emptyOutDir: true },
        logLevel: 'error',
      })
      const files = (await readdir(outDir, { recursive: true })) as string[]
      expect(files).toContain('index.html')
      const index = await readFile(join(outDir, 'index.html'), 'utf8')
      expect(index).toContain('id="root"')
      expect(files.some((file) => file.endsWith('.js'))).toBe(true)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }, 120000)
})
