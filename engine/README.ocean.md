# 深蓝知 · 海洋知识星球内容源

本目录是完整 AIHOT 引擎与海洋配置，内容通过 stepx-push 模块进入现有 stepx 应用。会员、审核与阅读界面保留在 stepx。

2026-10-23 本轮已修复增量漏更新、撤回、逐页重试、并发、每日对账、全文再分发许可与配置状态问题。类型检查、web构建与29项模块测试通过；不代表公网端到端联调已完成。

文档与工具位于并列目录：

- [实际迭代证据与未完成事项](../ocean-pack/docs/ITERATION_2026-10-23.md)
- [部署与升级](../ocean-pack/docs/DEPLOY.md)
- [同步契约及真实 stepx 实现](../ocean-pack/docs/STEPX_INTEGRATION.md)
- 维护脚本：../tools/；可移植安装器：../ocean-pack/tools/install_ocean_pack.py

生产部署需满足 package.json 的 Node 版本要求及 Docker Compose 环境。已有 .env 保持并核对；新部署按部署手册初始化。不能把本地模拟或专项测试当作真实模型调用、会员权限或自动同步上线的证据。

当前应用全部免费，未来9.9元/月，未启用收费。剩余接续需要现有管理员登录与真实 AIHOT 公网部署。密钥不应进入源码或聊天。
