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

  it('构建产物 CSS 给聊天区独立滚动约束：长聊天在自身区域滚动，不把 extras（轨迹）区挤出视口', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'mini-dsh-build-'))
    try {
      await build({
        configFile: join(appRoot, 'vite.config.ts'),
        root: appRoot,
        build: { outDir, emptyOutDir: true },
        logLevel: 'error',
      })
      const files = (await readdir(outDir, { recursive: true })) as string[]
      const cssFiles = files.filter((file) => file.endsWith('.css'))
      expect(cssFiles.length).toBeGreaterThan(0)
      const css = await readFile(join(outDir, cssFiles[0]!), 'utf8')

      // 高度链三段缺一不可（jsdom 无布局引擎，用构建产物声明做回归守护）：
      // 1) 网格项可低于内容高度（否则 1fr 行被长聊天撑破 100vh，整个页面滚动）
      expect(/\.dsh-area\s*\{[^}]*min-height:\s*0[^}]*\}/.exec(css)).toBeTruthy()
      // 2) 对话区填满并允许收缩（高度链的第二环）
      expect(/\.dsh-conversation\s*\{[^}]*min-height:\s*0[^}]*\}/.exec(css)).toBeTruthy()
      expect(/\.dsh-conversation\s*\{[^}]*flex:\s*1[^}]*\}/.exec(css)).toBeTruthy()
      // 3) 消息流自己滚动（scroll bar 出现在聊天区内部）
      expect(/\.dsh-messages\s*\{[^}]*overflow-y:\s*auto[^}]*\}/.exec(css)).toBeTruthy()
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }, 120000)
})
