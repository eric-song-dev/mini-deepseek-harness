# 召回探针（recall batteries）

针对 [分类学](../SKILL.md#分类学) 的探针。每个命中都需要语义判断——探针按设计会过度匹配，也按本性会漏匹配：每轮清洗都发现探针漏掉的情况，所以要把它们与"无模式地读范围内最密的文字"配对。

## 调用规则

- 加 `--hidden --glob '!.git/**'` 让 `.agents/` 被搜到；ripgrep 默认跳过点目录，漏检的最大风险就在 notes。
- 排除放在最后，防止后面的 include 把它们重新纳入：`--glob '!node_modules/**' --glob '!.git/**' --glob '!.agents/notes/archived/**' --glob '!.agents/skills/trim-cot-leakage/**'`（本技能自己的文件引用泄漏措辞作校准），外加范围内的录制快照目录（如 `shots/`）。
- 自然语言行加 `-i`，让句首大写命中（"本 PR 新增……"、"大概没问题……"）；第一行匹配代码模式，保持大小写敏感。
- 零命中模式在看到它命中过之前证明不了任何事：先拿一个已知阳性字符串试它。

## 英文电池

```sh
rg -n --hidden '\(decision \d|\(audit [A-Z]\d|design §|plan §|design ledger|\(B ruling|\bP-I\b|\bW\d\b|\bT\d\b' ...
rg -n --hidden -i 'this PR|this branch|this stack|later PR|previous commit|this commit' ...
rg -n --hidden -i 'used to |no longer|previously|the old |was renamed|was moved' ...
rg -n --hidden -i '\bv1\b|this cut|\bcut \d|\btoday\b|\bfor now\b|roadmap' ...
rg -n --hidden -i 'rejected in review|review round|reviewer|as of v\d' ...
rg -n --hidden -i 'probably |should be enough|should suffice|it simply|is safe —|is safe --' ...
rg -n --hidden '§\d' ...
```

## 中文电池

```sh
rg -n --hidden '设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有|这一版|决策 \d+|审计 [A-Z]\d+' ...
rg -n --hidden '这一版|今天改|目前大概|应该够' ...
```

## 已知误报家族

判断后保留，下次还会遇到：

- **工具性的 "used to"**——"the key used to sign requests"（用于签名的密钥）是工具性的，不是时间性的。时间性的形式在它前面有主语状态（"colors used to come from…"）。
- **运行时新旧**——"the old connection drains before the new one accepts" 命名的是交接中的活对象，不是仓库状态。
- **流程文档里的 "PR"**——关于 PR 工作流本身的文档（"PR 描述应该……"、模板、本仓库的流程笔记）合法地说 "PR"；禁令针对的是文档以某个 PR 的视角谈论代码。
- **`v1` 作为协议或路径段**——`/v1/chat` 端点与 wire 格式名是标识符，不是版本戳。
- **`§N` 有已提交拥有者**——外部标准（RFC 9110 §10.1.5）与拥有自己 §-编号的已提交文档可以按章节引用。
- **对比性的 "actually" 与名词 "wait"**——普通英文，不是迟疑；没有已提交行探测它们，只有把电池扩展到更宽的迟疑模式才会浮出来。
- **生成时间戳与 CLI 输出样例里的 "Today"**——录制输出保留自己的口吻。
- **中文"本版本"**——版本化工件语境里对 "this release" 的合法翻译；被禁的索引戳是"本版"这种镜像 "this cut" 的裸戳。
- **"备选方案"小节**——note 体裁槽位里的"被拒"是被认可的家，不是审查编排。
