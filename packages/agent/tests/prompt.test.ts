import { describe, expect, it } from 'vitest'
import { datedSystemPrompt } from '@mini-dsh/agent'

/**
 * datedSystemPrompt（post-MVP 增补）：给 system prompt 注入当前时间。
 * 动机：demo:real 实测时模型把 2026 年答成 2025 年（训练知识截止，且它没有主动
 * 调 bash date）——把当前时间放进 system prompt，是零成本、确定性的兜底。
 */
describe('datedSystemPrompt（把当前时间注入 system prompt）', () => {
  it('在基础 prompt 后追加一行"当前时间（UTC）：ISO 时间戳"，且是"那一刻"的时间', () => {
    const before = Date.now()
    const prompt = datedSystemPrompt('你是教学助手')
    const after = Date.now()

    expect(prompt.startsWith('你是教学助手\n')).toBe(true)
    const match = /当前时间（UTC）：(\S+)$/.exec(prompt)
    expect(match).not.toBeNull()
    const ts = new Date(match![1]!).getTime()
    expect(Number.isFinite(ts)).toBe(true)
    expect(ts).toBeGreaterThanOrEqual(before - 1000)
    expect(ts).toBeLessThanOrEqual(after + 1000)
  })
})
