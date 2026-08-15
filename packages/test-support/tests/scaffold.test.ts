import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'

describe('test-support 脚手架', () => {
  it('暴露 createTestContext，能创建并关闭一个 cordis ctx', async () => {
    expect(typeof createTestContext).toBe('function')
    const { ctx, dispose } = await createTestContext()
    expect(ctx).toBeDefined()
    await dispose()
  })
})
