# AIHOT 的工作方法与海洋版代码地图

这里说明的是仓库中可读到的实现。参考上游 [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT)，其参考提交为 [b3998dc6](https://github.com/KKKKhazix/AIHOT/commit/b3998dc6fc138eb9659f33f55eb38c1c716f0d57)。本仓库 engine/ 继承了既有海洋修改与同步修复，并非该提交的原样镜像。

## 一条资料如何变成读者看到的内容

| 步骤 | 实际做什么 | 本仓库主要位置 |
| --- | --- | --- |
| 信源与采集 | RSS、网页列表、JSON接口、X、公众号或外部推送；记录原文与来源时间 | engine/industry/sources.json；engine/packages/backend/src/sources/collect.ts、rss.ts、json-list.ts；engine/packages/backend/src/ingest/ |
| 提取与判重 | 提取可用材料、识别重复记录；只有标题或摘要时按需补取文章页面 | engine/packages/backend/src/content/extract.ts、materials.ts；engine/packages/backend/src/jobs/content.ts |
| 预筛 | 宽松判断是否属于本行业；只有 BLOCK 会拦下，UNKNOWN 不等于低质量已被确认 | engine/packages/backend/src/editorial/analyze.ts；engine/industry/prompts/prefilter.md |
| 两次独立评分 | 对同一份原始材料分别打0—100分；两次之和达到2倍分级门槛才成为精选候选 | engine/packages/backend/src/editorial/analyze.ts；engine/industry/prompts/selection-score.md；engine/industry/selection.ts |
| 结构抽取 | 提取类别、标签、主体和这篇报道所说的新闻事实 | engine/packages/backend/src/editorial/vocabulary.ts；engine/industry/taxonomy.ts；engine/industry/prompts/structure.md |
| 中文写作 | 为入选及接近门槛的材料写标题、摘要和理由；其他材料走较便宜的标题/摘要处理；检查措辞和无依据身份词 | engine/packages/backend/src/editorial/writing.ts、wording.ts；engine/industry/prompts/understand.md、summarize-article.md、mend-wording.md |
| 事件归组 | 判断同一件事、后续进展或不同事件；有复核步骤，人工改过的归属有保护 | engine/packages/backend/src/events/group.ts、consolidate.ts、corrections.ts；engine/industry/prompts/group-*.md |
| 形成精选 | 结合分数、新闻身份、新增价值和公开范围选代表稿；高分不等于自动出现 | engine/packages/backend/src/publication/publish.ts、rules.ts、representative.ts |
| 计算热点 | 在48小时窗口按独立参与来源计算，24小时半衰期；不是点击量，也不是一家媒体重复发稿的篇数 | engine/packages/backend/src/events/hot.ts；engine/packages/backend/src/publication/hot.ts |
| 日报、周报、月报 | 日报按规则编排已有合格内容，不再临时让模型编新闻；周/月报汇编，模型负责总述和栏目导读 | engine/packages/backend/src/reports/compose.ts、edition.ts；engine/site/site.ts 的 EDITION_TIMES |
| 网站与其他出口 | 网页、RSS、公开API、MCP等共用公开读取层，避免各处出现不同版本 | engine/apps/api/；engine/apps/web/；engine/packages/backend/src/publication/ |
| 持续运行与诊断 | worker执行任务，数据库保存进度，后台显示来源、预算、回执和运行记录 | engine/apps/worker/src/main.ts、schedules.ts；engine/packages/backend/src/providers/receipts.ts；engine/database/migrations/ |

“两次独立”是两次独立调用，不代表必须买两家不同模型。模型路由可以按步骤设置，见 engine/site/models.ts 与 engine/packages/backend/src/editorial/models.ts。读者打开网页不会触发模型重新写作；付费模型请求应经过回执和预算约束。

热点、精选、日报是不同问题：重要的单篇论文可能入选却没有多个独立来源参与；很多人在讨论也不自动说明结论可靠。归组同样不能代替科学事实审核。

## 海洋版已经改了哪里

| 海洋定制 | 文件与状态 |
| --- | --- |
| 31个信源配置 | engine/industry/sources.json：17 RSS、9 JSON/Crossref、5中文 external；配置不证明当前均在线，external不是自动RSS |
| 8个领域类别 | engine/industry/taxonomy.ts：physical、climate、biology、chemistry、policy、engineering、deepsea、fisheries |
| 29份提示词 | engine/industry/prompts/：预筛、选稿、内容理解、标题摘要、归组、事件综述、翻译和安全规则 |
| 专题与机构词表 | engine/industry/topics.json、taxonomy.ts 等行业文件 |
| 海洋站点文案与模型路由 | engine/site/；模型服务的真实密钥通过私密环境配置提供 |
| stepx适配 | engine/modules/stepx-push/：可选的快照/增量推送与接收契约，不是新阅读站的运行前提 |

现有门槛为 T1=58、T1_5=64、T2=74，接近门槛的深入写作起点为48。这些是 engine/industry/selection.ts 当前参数，**尚未完成海洋领域金标校准**，不能称为有效性结论。按 ocean-pack/docs/CALIBRATION.md 的120条开发集与30条独立随机留出集验证；不要拿调过阈值的开发数据当最终表现。

## 轻量版用了哪些方法

轻量更新器读取 config/sources.json，接收 RSS/Atom 与 Crossref 数据，做链接去重、规则相关性判断及8类的初步分类，再写 site/data.json。采集过程不调用外部模型 API，不计算上面那套精选分数、不做语义事件归组、不生成完整引擎的热点或刊物。

本轮另由聊天中的 AI 助手实际执行 prompts/chinese-reader.md，为已有资料生成中文标题与一段概括，结果保存在 config/chinese-editorial.json。scripts/chinese_editorial.py 核对原题与240字来源短摘要的输入指纹，只将匹配的结果写入阅读数据。当前222条有效资料均有中文结果；论文摘要44条、来源节选67条、仅有标题111条。英文原题和来源摘要继续保留。

这是已经执行过的翻译与概括步骤，不是未来每次抓取都会自动运行的模型服务。新资料或输入变化会进入待整理队列，默认中文页及RSS暂不纳入；已有结果不可套给变更后的内容。流程和提示词见 [中文整理说明](CHINESE_READING.md)。

因此，轻量版是一个可独立用的入口；完整编辑能力仍在 engine/。两者可以长期并存，或以后让阅读站消费完整引擎的公开出口，不能把“页面长得像”写成“完整AI流程已经运行”。

## 代码开源与原站不是同一份资料

上游 README 说明：开源包带18个公开的海外AI示例来源，不含原站真实信源名单和运营数据。这里的31项来自海洋定制。原站用户、历史文章、点击数据、私有运营功能、部署密钥不会因为复制源码而出现。

上游所展示的线上性能、用户规模和结果不是本海洋项目的测试成绩。实际运行、模型质量、来源覆盖和校准结果必须分别留证据。

