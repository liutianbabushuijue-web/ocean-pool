# 海洋包改动说明

由 `tools/build_ocean_pack.py` 生成。人工整份改写的文件标 **重写**，其余为结构保持的行业替换。

- `prompts/content-understanding.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/group-batch.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/group-definitions.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/group-method.md` — 行业替换 1 处：产品 → 数据产品
- `prompts/group-pair.md` — 原样保留（不含行业词）
- `prompts/group-signal.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/identity-context.md` — 行业替换 2 处：模型 → 模式；上下文 → 背景
- `prompts/mend-wording.md` — 行业替换 1 处：公司名 → 机构名
- `prompts/prefilter.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/report-period-no-sections.md` — 原样保留（不含行业词）
- `prompts/report-period-sections.md` — 原样保留（不含行业词）
- `prompts/report-period.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/rules-answer-first-summary.md` — 行业替换 2 处：产品 → 数据产品；裸 AI → 海洋
- `prompts/rules-anti-hallucination.md` — 行业替换 2 处：产品名 → 数据/产品名；产品 → 数据产品
- `prompts/rules-domain.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/rules-self-contained-title.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/safety.md` — 原样保留（不含行业词）
- `prompts/selection-score.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/story-digest.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/structure.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/summarize-article-empty.md` — 原样保留（不含行业词）
- `prompts/summarize-article.md` — 行业替换 5 处：模型/产品名 + 版本号、参数规模、benchmark 分数、速度倍数、价格、上下文长度、可用性（开源/闭源/API） → 模式/卫星/数据集名 + 版本号、分辨率与覆盖范围、精度指标、时间跨度、DOI 或数据获取方式；AI 内容 → 海洋内容；产品 → 数据产品；[file] 你是一个资深科技编辑 → 你是一个资深海洋科技编辑；[file] 保留 GPT / Claude / LLaMA 等专有名词原文 → 保留 NOAA / IOC-UNESCO / ENSP 等机构与缩写原文
- `prompts/summarize-long-post-quoted.md` — 行业替换 1 处：上下文 → 背景
- `prompts/summarize-long-post.md` — **重写**（行业判断整份替换，结构与输出契约不变）
- `prompts/summarize-short-post-quoted.md` — 行业替换 1 处：上下文 → 背景
- `prompts/summarize-short-post.md` — 原样保留（不含行业词）
- `prompts/translate-body.md` — 行业替换 2 处：模型 → 模式；产品 → 数据产品
- `prompts/translate-post.md` — 行业替换 2 处：产品名 → 数据/产品名；产品 → 数据产品
- `prompts/understand.md` — 原样保留（不含行业词）
