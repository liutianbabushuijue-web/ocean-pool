# 门槛校准：用 150 条你亲自标的样本，决定「什么值得上首页」

`selection.ts` 里的 58 / 64 / 74 只是未校准起点。模型可以辅助整理材料，最终标签由有领域判断的人确认；不能让模型把自己打的分当作真实标签。

预计投入：**6–8 小时**（标注 150 条约 3 小时，跑评测和改提示词 3–5 小时），可以分两周做。

---

## 1. 先理解你在调什么

| 层 | 文件 | 调它会影响什么 |
|---|---|---|
| 判断标准 | `industry/prompts/selection-score.md` | 模型怎么理解「重要」。**先调这个**，再调数字 |
| 入选线 | `industry/selection.ts` | 同样的分数，多少分算过。调它只改通过率，不改排序 |
| 噪声例 | `industry/prompts/prefilter.md` | 什么根本不该进候选。旅游、招生、纯会议通知在这里拦 |
| 分类 | `industry/taxonomy.ts` 的 `CATEGORIES[].guide` | 条目归到哪一类；日报分节靠它 |

正确顺序：**标注 → 跑评测 → 看判错的 → 改评分提示词 → 再跑 → 最后才动门槛数字**。

---

## 2. 取样：150 条怎么选

将 150 条分成两组：120 条开发/校准集覆盖难例，另留 30 条真实时间窗口的随机留出集。前者用于找问题，后者用于最后验证；两者不能混成一个“线上精确率”。

| 层 | 条数 | 从哪来 | 标注要点 |
|---|---|---|---|
| T1 官方/期刊 | 40 | NOAA、Nature、Crossref 期刊、部委 | 论文类问「结论会不会改变读者判断」 |
| T1_5 准官方/学会 | 24 | MBARI、Scripps、Frontiers、Hakai | 「机构宣传稿」和「真发现」要分清 |
| T2 媒体 | 32 | ScienceDaily、Mongabay、Carbon Brief | 二次转述，通常该 reject，除非比原文多信息 |
| 中文一手 | 24 | 自然资源部、中科院海洋所、海大 | 覆盖政策/航次/成果 |

中文一手单独分层，避免同时重复计入 T1。以上配比只针对 120 条开发集，不声称是站点实际来稿比例。

开发集主动补充明显该选、边缘和明显不该选的难例，记录采样理由，不强制标签比例。另从预先固定的一段完整候选流中随机取 30 条 holdout：包含系统已选、未选和被预筛拒绝的材料，不按模型分数或预计标签挑选，不与开发集或同一事件重复。保存抽样时间、方法、随机种子和候选总量。30 条仅适合初步检查，结果不稳时扩大新的留出集。

取样时间：站点跑满 2 周后。太早取，候选池里全是冷启动的存量。

---

## 3. 标注：一条 40 秒

从后台或受控导出流程取完整候选材料，包括已选、未选、预筛拒绝与处理失败的条目；不能只导 publications 中未选的记录，否则缺少已选样本，无法评估线上精确率。预筛拒绝的材料不一定有 publication，应按文章与处理记录核对导出范围。标注时隐藏模型分数、模型决定和是否入选，按原文与来源独立判断。每条写成一行 JSONL：

```json
{"caseId":"ocean-001","material":{"title":"原文标题","originalTitle":null,"publishedAt":"2026-10-20T09:00:00+08:00","sourceName":"NOAA NOS","bodyZh":null,"bodyOriginal":"正文……"},"sourceFacts":{"sourceKind":"rss","sourceTier":"T1","firstParty":true,"language":"en"},"samplingContext":{"benchmarkSplit":"calibration","samplingStratum":"policy"},"gold":{"decision":"select"}}
```

| 字段 | 说明 |
|---|---|
| `material.title` / `bodyOriginal` | 原文标题与正文（截 4000 字够用） |
| `sourceFacts.sourceTier` | `T1` / `T1_5` / `T2`，必须和后台信源设置一致 |
| `samplingContext.benchmarkSplit` | 120 条开发样本写 `calibration`，30 条独立随机留出样本写 `holdout`；两组都需人工标注，开发时不得查看 holdout 结果 |
| `samplingContext.samplingStratum` | 你自己的分组：`paper` / `policy` / `voyage` / `data` / `media` / `noise` |
| `gold.decision` | `select` 该上首页 / `reject` 不该 / `either` 两可（不计分） |

### 标注口径（写下来，贴在手边）

- **select**：一个关注海洋的研究生或从业者，今天看到它不会觉得浪费时间。
  - 新观测/新机制/新约束，且结论会改变判断
  - 有约束力的政策节点（批准、生效、配额、许可）
  - 新数据产品/模式版本，改变可获得性或精度
  - 极端事件（热浪、缺氧、白化、风暴潮）有明确观测或影响范围
- **reject**：
  - 机构宣传稿、签约通稿、会议报名、招生、招聘
  - 旅游、海鲜餐饮、海景房产
  - 换海区复算的常规论文、只提升一个指标的方法改进
  - 二次转述且没有新增信息
- **either**：拿不准就标它。**不要为了凑比例硬选。**

标完记录 select/reject/either 的实际占比及分层计数，不为凑比例修改标签。选中率偏高或偏低可能来自材料分布、采样方法或编辑方针，不能仅凭占比判定标签对错。

---

## 4. 跑评测

```bash
node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl --split calibration --n 120 --label "海洋 v1"
```

命令在完整站点 oceanhot 根目录运行，需要数据库与真实模型凭据，可能产生调用费用。保存实际运行输出，不把本文目标当作已达到的结果。

看以下指标；目标是待验证的编辑门槛，不能靠人为挑样本达标：

| 指标 | 含义 | 目标 |
|---|---|---|
| 准确率 | 判对的占比 | > 80% |
| 精确率（precision） | 选进来的里有多少真的该选 | **> 75%**（首页不能水） |
| 召回率（recall） | 该选的里选进来多少 | > 60%（漏几条可以接受） |
| 门槛扫描 | 不同门槛下的 precision/recall 曲线 | 选拐点 |

同时检查 coverage（有效输出覆盖率）、completeAcc 和调用错误；不能只看成功返回样本的准确率。开发集指标受主动选难例影响，不代表线上表现。最后分别报告随机 holdout 的样本量、混淆矩阵、P/R、either 数与失败数；样本很少时不能把一个百分比当成稳定结论。

---

## 5. 看判错的样本

```bash
node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl --split calibration --n 120
```

当前脚本没有 `--show-errors` 选项。运行结束会打印 report 文件路径；打开 `.data/eval/selection-calibration-*.json`，查看各模型的 `mistakes`、`cases` 和 `error`。把错误分四类，对应改法不同：

| 错误类型 | 例子 | 改哪 |
|---|---|---|
| 假阳性：噪声进了 | 某研究所的「签约仪式」被选 | `selection-score.md` 的「必须压住的噪声」加一条 |
| 假阳性：把旧事当新闻 | 卷期 2027 的论文 | `structure.md` 的事实抽取 + 评分里的阶段判断 |
| 假阴性：好论文没进 | 一篇 Nature 海洋热浪被拒 | 看是不是正文太短/摘要缺失；`understandFloor` 可以降 |
| 假阴性：政策没进 | BBNJ 批准方达 100 个 | `selection-score.md` 的「必须正常评价的价值」里政策条目要加强 |

**每次只改一处，重跑，记录指标。** 一次改五处，你永远不知道是哪处起了作用。

---

## 6. 定门槛

拿到曲线后：

1. 选一个 precision ≥ 75% 且 recall ≥ 60% 的点。
2. 分别检查 T1、T1_5、T2 的错误与样本量；某一层样本不足时先保留未校准标记，不能预设层间一定相差多少分。
3. 由真实结果与编辑方针决定各层门槛，记录选择理由。
4. 把数字写进 `industry/selection.ts`，**并在注释里写日期和样本量**：

```ts
// 待填写：校准日期、开发/留出样本量、真实 P/R、coverage 与对应报告路径。
// thresholds 的数值以实际评测为准；此处不提供伪造的校准结果。
```

5. 冻结提示词与门槛后才运行 holdout，作初步独立验证：

```bash
node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl --split holdout --n 30
```

---

如果看过 holdout 后继续修改提示词或门槛，这组材料就已参与开发，不再是独立验证集。下一次需重新留出新样本；不要反复调到旧 holdout 通过。

## 7. 每季度复校

- 季节性：ENSO 事件期间内容分布可能变化，先抽样检查误判与通过率，再决定是否调整门槛；不凭季节预设降分。
- 信源变化：新加 5 个源后，噪声分布会变。
- 每次复校都新建一个 `gold-2027Q1.jsonl`，**不要覆盖旧的**；指标下降时能回溯是哪次改动导致的。

---

## 8. 一句提醒

校准不是「让模型更像你」，是「让模型像你**希望读者看到的那个编辑**」。你自己刷手机时点开的标题，和你希望首页出现的条目，往往不是一回事。标 `select` 时想的应该是后者。
