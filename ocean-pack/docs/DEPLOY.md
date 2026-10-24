# 部署手册：把“深蓝知”接入 stepx

本文给出可复核的部署步骤。代码、历史构建报告和接口 self-test 不能代替目标服务器上的真实运行；没有执行的项目保持“待验收”。

## 0. 确认交付目录

本地目录：

```text
D:/GALGAME/
  oceanhot/       完整站点，含 package.json、Dockerfile、docker-compose.yml
  ocean-pack/     海洋配置、同步模块和本文档
  tools/          install_ocean_pack.py、cn_collector.py、
                  verify_sources.py、stepx_contract_check.py 等
```

ocean-pack 内现已附带 tools/install_ocean_pack.py 和 tools/stepx_contract_check.py，但它仍是扩展包，不是独立运行站点。中文采集等其余脚本位于同级 tools/。演示文件 ocean-pack/demo-entries.json 当前有 54 条，仅用于结构演示，不代表线上已审核内容。信源配置为 31 条：17 RSS、9 Crossref JSON、5 中文 external；31 条配置不等于每天 31 个源都健康。

Linux 示例统一使用 `/srv/ocean-bundle/{oceanhot,ocean-pack,tools}`。将这三个目录一起上传；只克隆 AIHOT 上游不会包含海洋包及外部脚本。不要上传 node_modules；已有服务器配置和数据先备份，密钥通过受保护的渠道配置。

## 1. 准备

- Docker 与 Docker Compose，以及用于配置和维护脚本的 Node.js 24、Python 3。
- 足够的服务器资源、磁盘和备份位置；按实际负载监测后扩容。
- 真实模型服务地址、模型名和 Key。以供应商当前可用配置为准，不将历史模型名视为保证。
- 面向用户的域名与 HTTPS；运营主体、联系方式和适用的备案、收费规则由运营者按实际部署地区确认。

镜像下载和 npm 安装失败时，先检查网络与官方文档，避免直接覆盖已有 Docker daemon 配置或使用无法确认来源的镜像。本文不把第三方镜像地址视为长期可用依赖。

## 2. 安装与启动

### 2.1 安装海洋包

```bash
cd /srv/ocean-bundle
python3 tools/install_ocean_pack.py --target ./oceanhot --pack ./ocean-pack --dry-run
```

先核对将覆盖的 industry、site、模块注册和备份位置。安装器会为三个模块注册数组追加 stepx 模块并保留已有模块；不认识的动态注册格式会在写入前停止，需先人工合并。确认安装目标后：

```bash
python3 tools/install_ocean_pack.py --target ./oceanhot --pack ./ocean-pack
cd oceanhot
npm install
```

安装器的默认 pack 路径按其脚本所在目录推导，因此示例显式提供 --pack。它会备份所有被覆盖文件（含 Compose、Dockerfile、site/package.json 与已有 .env），但仍应单独保存整个既有配置与数据库；不能把这个备份目录当成完整回滚方案。

### 2.2 环境变量

新部署可运行：

```bash
node scripts/init-env.ts --llm-key <你的模型Key>
```

已有 .env 时保留并逐项核对，不重复初始化。确认 SITE_URL、数据库配置、管理员凭据、模型接口和模型名正确。安全开关按实际准备程度启用，初次接 UI 时可关闭采集与模型调用。

同步相关配置：

| 项 | 用途 |
|---|---|
| STEPX_TOKEN | stepx 拉取与 outbox 签名，至少 16 位随机密钥 |
| INGEST_TOKEN | 中文采集器调用 ingest |
| ADMIN_SYNC_TOKEN | 同步管理接口及 web 服务器转发使用 |
| STEPX_WEBHOOK_URL | 主动推送目标，生产使用 HTTPS |
| STEPX_WEBHOOK_SECRET | webhook 专用签名密钥，两端一致 |
| STEPX_PUSH_CRON | 推送周期，默认每 30 分钟 |
| STEPX_INCLUDE_BODY | 默认关闭；启用后还需来源再分发许可、条目 syndicate 许可与 body_mode=full |

安装器会补齐缺失的 STEPX_TOKEN、INGEST_TOKEN、ADMIN_SYNC_TOKEN，保留已有值且不打印密钥；dry-run 不生成密钥。生产 webhook 地址与专用签名密钥仍需按真实接收端配置，保存在服务器环境。

Docker 的 api 与 worker 使用 env_file。本轮 Compose 已为 web.environment 加入 ADMIN_SYNC_TOKEN 透传；升级时核对配置包含：

```yaml
services:
  web:
    environment:
      ADMIN_SYNC_TOKEN: ${ADMIN_SYNC_TOKEN:-}
```

这是现有 environment 下新增的一项，不能用该片段替换整个 web 服务。只透传管理页确实需要的密钥，不把模型或数据库凭据发送给浏览器。

### 2.3 启动与配置变更

```bash
docker compose up -d --build
docker compose ps -a
docker compose logs --tail 80 setup api worker web
```

正常状态是 db、api、worker、web 四个常驻服务运行，setup 一次性初始化成功并以 0 退出；不是“五个容器都一直健康运行”。HTTPS profile 还会增加 caddy。

修改 .env 后，重建相关容器以重新加载环境：

```bash
docker compose up -d --force-recreate api worker web
```

`docker compose restart worker` 不会重新读取 Compose env_file。/admin/sync 临时保存表单及 admin/config 写接口已移除；配置统一持久写入 .env 后重建相关容器。

迁移 0091–0095 添加主同步与独立对账游标，并丢弃旧 timeline_at/article_id 推送进度。升级后会重发首次快照，接收端须幂等；迁移不删除内容、审核或会员数据。升级前备份，并观察初始化、快照重放及后续增量。

## 3. 中文信源

以下命令在 oceanhot 根目录运行，脚本位于同级 tools。通过受保护的运行环境提供 AIHOT_BASE 和 INGEST_TOKEN：

```bash
export AIHOT_BASE=http://localhost:3000
# INGEST_TOKEN 由安全的服务器环境注入
python3 ../tools/cn_collector.py --source all --dry-run --limit 3
python3 ../tools/cn_collector.py --source all
```

dry-run 逐源检查列表条数、发布日期、正文和标题；正式推送后还需在后台验证 ingest 成功与后续内容处理。历史网页解析成功不等于今天仍然稳定。

采集器默认状态文件是交付根目录的 `.data/cn-collector-state.json`，由脚本位置推导；也可显式使用 --state 指定受备份保护的位置。失败请求不会标记为已推送。

无人值守采集由服务器计划任务或服务管理器每两小时运行，使用绝对脚本路径、明确工作目录和受保护的环境变量文件。不要依赖当前终端的 export 或管理员网页登录会话。至少观察一次计划任务自然触发并成功 ingest，不能只验证手动命令。

## 4. 域名与 HTTPS

在 .env 中先设置真实 SITE_URL；使用现有 Caddy profile 时设置 SITE_DOMAIN，确认 DNS、端口和证书条件：

```bash
docker compose --profile https up -d --build
```

部署后核对页面、RSS 链接、分享地址、API 描述与 MCP Host 行为。没有目标服务器实测前，不能根据容器启动推断这些外网入口全部可用。

## 5. stepx 对接与验收

先按 [STEPX_INTEGRATION.md](STEPX_INTEGRATION.md) 对齐真实表、externalId 唯一约束、审核状态和会员权限。建议先手动拉取少量真实条目，确认后再开自动推送。

首次拉取是快照，完成后用 nextSince 继续账本增量；nextSince 是不透明 ax1 游标，hasMore=false 仍要保存。旧游标 409 snapshot_required 必须重新快照对账，不得当作同步成功。

主动 push 在 24 小时对账周期到期后用独立 reconcile_cursor 重扫精选，每轮先追增量，再用剩余页数预算对账，不覆盖 sync_cursor。拉模式需接收端自己安排周期完整对账。正文默认关闭；对账还需实测来源许可撤销后会清空接收端旧正文。

接口基础检查：

```bash
cd /srv/ocean-bundle
# STEPX_TOKEN 由受保护的环境注入
python3 tools/stepx_contract_check.py --base https://你的域名 --token "$STEPX_TOKEN"
```

检查器 self-test 只验证本地假服务；真实地址 PASS 也只证明脚本覆盖的基础接口契约。以下业务验收不可省略：

| 检查 | 通过标准 |
|---|---|
| 服务与后台 | setup 成功退出，其余服务运行，/admin 可登录 |
| 信源 | 配置数量核对，启用源逐个预览；标题、日期、正文解析正确 |
| 内容与公开出口 | /、/feed.xml、/llms.txt、/sitemap.xml、/agent 实测可用 |
| 管理页 | /admin/sync 显示状态、试拉；空站无内容时明确原因 |
| 首次同步 | 完整快照入库，重放不重复，新条目 pending 且 App 不可见 |
| 第二轮同步 | 新增、标题/摘要更正、撤回与代表稿变化均可续传 |
| 真实撤回 | 已同步老条目撤回后，在约定的自动同步时限内 App 不可见 |
| webhook | 原始字节验签，持久落库或可靠入队后才返回 2xx |
| 故障恢复 | 网络失败、超时重投、进程重启与 409 重建均无漏条 |
| 权限 | 访客、非会员、会员、管理员读取范围与产品约定一致 |
| 周期对账 | push 独立对账不覆盖主游标，拉侧有周期任务；扩展字段可重核，许可撤销会清空旧正文 |

## 6. 运维与备份

每天看来源失败、worker 错误、内容质量、最后同步成功时间，以及发送成功数与接收端持久入库数是否一致。没有新增时累计推送数不会增长，不能把“不增长”直接判成故障；需结合自然触发记录与接收端对账。

在 oceanhot 根目录备份：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > backup-$(date +%F).sql.gz
docker compose cp api:/data ./backup-data-$(date +%F)
```

保护数据库导出与数据目录，复制到另一台机器或对象存储；另外安全备份 .env、凭据、定时任务配置和中文采集状态。Compose 实际项目名影响卷名，所以不硬编码 oceanhot_data 卷。

正式推广前，在隔离环境做一次恢复演练并核对内容与同步状态。升级前备份，按实际改动重新构建并做受影响的验收；不要在未知现有模块的站点上盲目重跑覆盖安装。

## 7. 成本与质量

以前文档的 100–150 元/月仅作假设预算，没有真实账单支持。成本取决于模型当前价格、正文长度、重试、信源新增量、服务器和存储；首周用真实回执与账单重新估算。设置请求上限并观察熔断，读者打开页面不应触发模型调用。

评分门槛仍未校准。按 [CALIBRATION.md](CALIBRATION.md) 建开发集与独立随机留出集；上线初期保留人工审核，不以模型分数替代内容核对。

## 8. 常见故障

| 现象 | 检查与处理 |
|---|---|
| setup 失败，服务未起 | 查看 setup 日志，核对数据库、迁移与磁盘；setup 成功退出本身正常 |
| 管理页 403 | api 与 web 的 ADMIN_SYNC_TOKEN 是否一致且均被容器加载 |
| 配置后仍不推 | 配置是否持久写入，worker 是否重建，定时任务是否实际注册与触发 |
| 签名失败 | 两端有效密钥、时间、原始字节是否一致；禁止重序列化后验签 |
| 接口 409 | 根据 snapshot_required 重建快照，不丢人工审核记录 |
| 来源或中文采集为零 | 对真实网页 dry-run，检查列表规律、正文容器、日期和站点改版 |
| 发方 2xx 但 App 无变化 | 查接收端持久入库、队列失败、审核状态及会员读取权限 |
| 只扩展字段没更新 | 查 push 独立对账进度与分页积压，或拉侧完整对账任务；接收端同版本刷新及 null 清空规则是否正确 |

上线记录要保存实际环境、版本、命令结果、时间及证据；未测试的能力明确写待验证。

## 同步恢复与分页预算

推送每轮分页预算最少 2 页（默认 5），避免空增量占满预算后全量核对无法运行。游标失效时后台提供「重建同步快照」，它保留内容与投递统计；恢复后须在 stepx 做完整来源对账，处理旧记录中已被撤回的内容。空轮询不会伪造新的 webhook 送达成功时间。
