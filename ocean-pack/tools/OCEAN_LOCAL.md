# Windows 本机内容源启动工具

`ocean_local.mjs` 为已经安装依赖、构建完成的海洋内容引擎创建独立运行目录。不使用 Docker，不改引擎原有 `.env`，不读取测试数据库，不导入示范文章。

需要 Node **24.22.1 或以上**、现有海洋引擎目录，以及 PostgreSQL **17** 的 `bin` 目录（至少含 `postgres.exe`、`pg_ctl.exe`、`initdb.exe`，并保留它们依赖的相邻文件）。Codex 本机打包的 Node 已符合要求；全局 `node` 可能仍是旧版本，应使用符合要求的 `node.exe` 完整路径。

首次启动示例（替换前三个路径；运行目录应为新建专用目录，且在引擎和 PostgreSQL 二进制目录之外）：

```powershell
$oceanNode = 'C:\path\to\node.exe'
$oceanTool = 'D:\GALGAME\ocean-pack\tools\ocean_local.mjs'
$oceanPgBin = 'C:\path\to\PostgreSQL\17\bin'
& $oceanNode $oceanTool start --root 'D:\GALGAME\oceanhot' --runtime 'D:\GALGAME\ocean-runtime' --pg-bin $oceanPgBin
```

之后的操作只需给运行目录：

```powershell
& $oceanNode $oceanTool status --runtime 'D:\GALGAME\ocean-runtime'
& $oceanNode $oceanTool stop --runtime 'D:\GALGAME\ocean-runtime'
& $oceanNode $oceanTool start --runtime 'D:\GALGAME\ocean-runtime'
& $oceanNode $oceanTool backup --runtime 'D:\GALGAME\ocean-runtime'
```

默认网页地址为 `http://127.0.0.1:3130`，API 为 `http://127.0.0.1:3131`，独立数据库为 `127.0.0.1:55433/ocean_local`。首次可用 `--web-port`、`--api-port`、`--pg-port` 选择其他端口；端口占用会报错，不会停止占用者。状态报告会列出进程和健康启动结果，不显示密钥。

首次 `start` 会生成私有凭据、创建独立 PostgreSQL 集群、执行引擎及模块迁移、种下真实信源配置，再启动 API、worker 和网页。现有有效的管理员密码、同步令牌优先沿用原 `.env`；缺少的会话、图片签名等密钥仅保存在运行目录 `private/`，该目录由 Windows ACL 限制为当前用户和系统可读。网页进程只收到必要配置及后台同步服务端令牌，不收到数据库或模型密钥。

本版本固定关闭采集、模型调用、飞书推送、IndexNow、正文再分发和 stepx 自动推送。空库可以核验本机服务和鉴权，但**不能证明已经向 stepx 推送成功**：现有推送逻辑遇到零条内容不会发 HTTP 请求。真实联调和后续启用由独立步骤处理，不向公开库塞入假文章。

进程在后台隐藏运行，不会自动开机启动。电脑关机、休眠或服务异常退出后，需要检查 `status` 并重新 `start`；本版本没有自动重启守护策略。`stop` 经本机私有控制通道通知 worker 排空任务，再停止网页、API 和本工具核对过的 PostgreSQL 集群；不会按端口或任意 PID 强制结束进程。正在排空任务时可能需要等待数分钟。启动失败仅回收本次启动的进程，原来就运行的数据库保留。

`backup` 会先停止本运行环境，再做**停库冷备**，完成后仍保持停止，需再次 `start`。备份在运行目录 `backups/` 中，包含 PostgreSQL 数据、上传文件和私有凭据，因此应当像密码一样保管，不放入公开交付压缩包。它不会删除旧备份。升级引擎代码和执行新迁移前先备份。冷备恢复需要相同的 PostgreSQL 17 环境及匹配的私有配置，应先在另一个目录验证恢复。

日志在运行目录 `logs/`；日志尽量遮蔽凭据，不要直接公开整个运行目录。启动锁或陈旧的 PostgreSQL PID 文件会导致拒绝启动：先核对状态和日志，不要直接删除文件、改迁移账本或结束不认识的进程。
