# 本机内容工作站 → stepx：不开放公网 API 的启动路线

现有 push.ts 在 AIHOT worker 里读取本地数据库，再主动 HTTPS POST 到 stepx webhook。因此推模式不要求 stepx 能访问 AIHOT，不需要先购买公网服务器或建立反向隧道。这是现有实现支持的运行方式，不是另造一套采集系统。

## 必要条件

- 本机满足 DEPLOY.md 的 Node/Docker/PostgreSQL运行要求，启动 api、worker、web 与数据库。
- 电脑保持运行且能连外网；关机、睡眠或 worker 停止期间不会自动更新。
- 使用现有应用管理员登录 stepx 后台，配置 webhook 专用密钥，并在本机 AIHOT 的环境变量中配置同一值。
- 按实际采集与写作需要配置模型服务；没有 Key 时不宣称模型处理已跑通。采集与模型调用安全阀按部署手册逐步启用。

已新增无需 Docker 的 Windows 本机启动工具，说明见 [OCEAN_LOCAL.md](../tools/OCEAN_LOCAL.md)。专用运行目录为 D:/GALGAME/ocean-runtime，与测试库完全独立。实际启动已通过 API/网页健康检查、站点 smoke、重复启动、停止和重启数据保持检查；70 项迁移、31 个信源配置已入库，尚无文章。已成功创建私有停库冷备，未演练恢复。

验收后环境保持停止。该启动工具当前固定关闭采集、模型、通知和 stepx 推送；修改引擎原 .env 的开关也不会启用。它证明本机运行基础可用，不代表已有真实内容或已联通 stepx。

## 连接

AIHOT .env 的目标：

```dotenv
STEPX_WEBHOOK_URL=https://br-blush-ling-89556b2c.supabase.aidap-global.cn-shanghai.volces.com/functions/v1/a7282b6bcf38-ocean-webhook
STEPX_WEBHOOK_SECRET=<与stepx后台一致的专用密钥>
STEPX_PUSH_CRON=*/30 * * * *
STEPX_INCLUDE_BODY=false
```

模板不含真实密钥。配置完成后重建 api、worker、web，先手动推送少量内容，确认 stepx 待审核入库、重复不增加、撤回下架，再验证 worker 自然触发。具体命令与恢复步骤见 [DEPLOY.md](DEPLOY.md) 和 [STEPX_INTEGRATION.md](STEPX_INTEGRATION.md)。

## 与拉模式的区别

stepx 的「试拉」和手动拉取需要它能访问 AIHOT 地址。纯本机私有运行时，这条路径不适用；直接验证本机主动 push 即可，不能因为后台试拉失败就把整个推送链判定为失败。

本机管理员可在本地 AIHOT 后台管理采集与推送，stepx 管理员在云端审核与展示。不要为了联调把管理接口或数据库直接暴露到公网。

## 当前未闭环

用户报告同一手机号在 Edge 可进入后台，内置浏览器则拒绝；两端会话与管理员逻辑需要在 Edge 接通后核对。两端专用密钥配对、模型与真实内容源处理，以及真实签名推送/撤回验收尚未完成。公网 AIHOT 是后续升级选项，适合电脑无法常开或需要稳定持续运行的阶段；它不是采用主动推送时的必备前提。
