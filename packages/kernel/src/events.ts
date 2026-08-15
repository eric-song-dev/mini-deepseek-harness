import 'cordis'

// M0 的 app 生命周期事件词汇（用 cordis 模块增强声明类型；M1 起 session 词汇也走同一机制）。
declare module 'cordis' {
  interface Events {
    /** profile 全部插件装载完成后发出：系统"启动完成"的信号。 */
    'app/ready'(): void
    /** 停止前发出：插件可借此做收尾前的最后一件事。 */
    'app/stop'(): void
  }
}
