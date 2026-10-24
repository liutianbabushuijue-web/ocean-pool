# 深蓝知 · 海洋知识库（AIHOT 海洋行业版）

这份海洋包把 AIHOT 的采集、筛选、中文摘要与日报能力接到 stepx。AIHOT 负责内容，stepx 负责审核、会员和阅读界面。已有界面与模块代码不等于生产服务完成；真实部署、内容更新、撤回和会员权限都要按验收清单验证。

引擎基于 [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT)（MIT）。本包主要包含 `industry/`、`site/` 和独立模块 `modules/stepx-push/`。

## 交付内容

| 内容 | 位置 |
|---|---|
| 31 个信源配置：17 RSS、9 Crossref JSON、5 中文 external | `industry/sources.json` |
| 历史信源探测报告；不代表当前完整采集链路成功 | `sources-report.json` |
| 8 个海洋类别与主题配置 | `industry/taxonomy.ts`、`industry/topics.json` |
| 29 份海洋提示词；门槛仍需领域标注校准 | `industry/prompts/`、`industry/selection.ts` |
| 54 条接口结构演示数据；不代表线上同步、审核或权利已核验 | `demo-entries.json` |
| stepx 拉取、主动推送与管理页模块 | `modules/stepx-push/` |
| Windows 独立本机环境启动、停止、状态与停库冷备 | `tools/ocean_local.mjs`、`tools/OCEAN_LOCAL.md` |
| 部署、运营、校准、对接、复盘与产品计划 | `docs/` |

## 目录与运行位置

当前本地交付布局为：

```text
D:/GALGAME/
  oceanhot/                 完整 AIHOT 站点，npm / Docker 命令在这里运行
  ocean-pack/               本 README 所在的可移植包（含 tools/ 下的安装器与契约检查器）
    industry/
    site/
    modules/stepx-push/
    docs/
  tools/                    安装、中文采集、信源体检与契约检查脚本
```

Linux 部署建议整体保存为 `/srv/ocean-bundle/{oceanhot,ocean-pack,tools}`。只克隆 AIHOT 上游不会得到本交付的 tools 和 ocean-pack。按 [部署手册](docs/DEPLOY.md) 安装，Docker 与 npm 命令在完整 oceanhot/ 里运行。本包自带 tools/install_ocean_pack.py 与 tools/stepx_contract_check.py；中文采集与信源维护脚本仍在交付根目录 tools/。

```bash
cd /srv/ocean-bundle
python3 tools/install_ocean_pack.py --target ./oceanhot --pack ./ocean-pack --dry-run
# 核对预览和备份策略，再去掉 --dry-run 安装
cd oceanhot
npm install
node scripts/init-env.ts --llm-key <你的模型Key>
docker compose up -d --build
```

已有 .env 时先保留并核对，不重复初始化。以上命令是部署步骤，不是已在目标服务器执行成功的记录。

## stepx 同步约定

`GET /api/stepx/v1/items` 首次提供精选快照，后续使用内置变更账本。保存服务器返回的不透明 `ax1` nextSince 游标；hasMore=false 时也要保存。旧时间游标返回 409 snapshot_required，需要重建快照对账。

主动推送由 AIHOT worker 定时发起；接收端事务提交或可靠持久入队后才返回 2xx，发送端每页确认后提交游标。主要变化通过账本同步；push 另用独立游标在 24 小时对账周期到期后补全量快照，拉模式需接收端自己周期对账。对账受分页预算和积压影响，不承诺所有字段即时更新。正文默认关闭，启用还需来源再分发许可与条目全文发布条件。

`/admin/sync` 可查看状态、试拉与手动推送；临时配置保存入口已移除，正式配置统一写入服务器 .env 并重建相关服务。完整协议、原始字节验签、真实字段映射与业务验收见 [STEPX_INTEGRATION.md](docs/STEPX_INTEGRATION.md)。

## 验证状态

本轮已实际执行类型检查、web 构建、真实隔离 PostgreSQL 的同步专项测试、检查器模拟自测和安装器临时目录检查。精确结果与限制见 docs/ITERATION_2026-10-23.md。信源报告保留历史抓取记录，不能证明今天仍可采集。

无需 Docker 的 Windows 本机运行基础已完成实际验收：健康检查、站点 smoke、重复启动、停止、重启数据保持和私有停库冷备创建均通过；70 项迁移、31 个信源配置、0 篇文章、0 付费调用。验收后保持停止，运行器固定关闭采集、模型和推送，未做备份恢复演练。

当前仍需真实模型与内容处理、150 条领域校准、AIHOT 与 stepx 的真实端到端联调、普通会员权限与故障恢复。推模式不要求 AIHOT 开放公网 API，见 [本机主动推送路线](docs/LOCAL_PUSH.md)。stepx 预览已完成三轮改造，新增、更正、撤回等主要行为已在本地真实数据库验证。升级迁移会重置旧推送进度并重发首次快照，不删除内容、审核或会员；接收端须按 externalId 幂等处理。接口检查器通过也只能证明其覆盖的基础契约，不能代替这些业务验收。

## 文档

- [部署、环境变量、备份与上线验收](docs/DEPLOY.md)
- [运营、来源核对、更正与撤回](docs/OPERATIONS.md)
- [标注、无偏留出集与门槛校准](docs/CALIBRATION.md)
- [stepx 接口、验签、持久确认与联调](docs/STEPX_INTEGRATION.md)
- [方案缺口与实际证据边界](docs/ANALYSIS.md)
- [产品价值与冷启动假设](docs/PLAYBOOK.md)
- [2026-10-23 本轮修订记录](docs/ITERATION_2026-10-23.md)
- [Windows 本机运行工具与限制](tools/OCEAN_LOCAL.md)
- [本机主动推送路线](docs/LOCAL_PUSH.md)

## 许可与来源

引擎为 MIT，保留原项目许可证与署名要求；站点品牌使用“深蓝知”，不使用 AIHOT 名字和 Logo。来源内容版权归原作者，本包默认提供摘要与原文链接。上线前填写实际运营主体、联系方式和适用条款。
