# GitHub：保存项目和更新资料

本说明介绍仓库的常规采集与可选发布流程。首轮采集已实际运行成功，后续仍需满足平台权限与设置；本地存在流程文件本身不代表某次远端任务已经运行。

## 本次仓库

你已提供独立仓库 [liutianbabushuijue-web/ocean-pool](https://github.com/liutianbabushuijue-web/ocean-pool)，并在最新回复中选择“公开就行”。仓库已核对为 **Public**；代码和公开来源资料可以按本次授权上传，真实密钥、本机数据库和个人备份不进入仓库。

完整项目已经上传，首轮 [Refresh ocean sources](https://github.com/liutianbabushuijue-web/ocean-pool/actions/runs/40107030865) 已实际通过离线检查、公开来源采集和资料写回。无需再新建仓库，也无需提供密码或 token。本机文件夹仍名为 ocean-knowledge-hub，远端仓库名为 ocean-pool，两者不必相同。

本次授权是保存到公开代码仓库。阅读入口仍在本机，**ENABLE_PAGES 保持未设置**，不启用 Pages。公开仓库和已发布网站是两个独立状态。

中文资料已经可以通过 [公开 RSS 地址](https://raw.githubusercontent.com/liutianbabushuijue-web/ocean-pool/main/site/feed.xml) 订阅；把该链接加入自己的 RSS 阅读器即可。这个入口读取仓库中的原始XML文件，不需要开启 Pages；GitHub 的文件预览页不能代替这个订阅地址。

## 手动更新一次

1. 确认完整项目已上传到 [ocean-pool](https://github.com/liutianbabushuijue-web/ocean-pool)，流程文件位于默认分支。
2. 打开 Actions，选择 **Refresh ocean sources**，点击 **Run workflow**，选择默认分支后运行。
3. 看这次运行的结果。绿色说明本次流程通过；红色请查看 Refresh 或 Commit 的错误。
4. 回到 Code 查看 site/data.json 的更新时间与 bot 提交。只看提交时间不够，还要看资料中的上次成功时间和来源状态。

更新器不需要模型密钥或 stepx token。写回使用当前仓库的 GITHUB_TOKEN，不要求额外个人访问令牌。若组织规则禁止写入或分支要求必须走PR，提交会失败；应按仓库规则调整，不能用强制推送绕过。

Actions 只负责采集及应用已有中文结果，不会自动调用 AI 翻译。本轮222条有效资料已有中文整理；以后新增或输入变化的资料进入待整理队列，需要 AI 助手按 [中文整理说明](CHINESE_READING.md) 继续处理。成功抓到资料和完成中文整理是两个独立状态。

每次只提交 site/data.json、site/feed.xml 与两个OPML生成文件。提交者固定为官方 github-actions[bot]，不额外接入第三方提交机器人。

默认分支首次上传，以及后续修改采集脚本、信源配置、测试或更新流程本身时，也会触发一次更新。只写回生成资料不会再次触发这条更新流程，不会形成循环。

GitHub 上的新资料不会自动复制到已解压的本机文件夹。“打开海洋阅读.cmd”立即打开已有资料；在本机收取新资料请另双击“更新订阅.cmd”，结束后刷新阅读页。若要取 GitHub 已更新的完整副本，可在 Code → Download ZIP 下载并解压到新的文件夹，再打开其中的阅读入口。

## 定时刷新是什么时间

默认计划为UTC每天00:27、06:27、12:27、18:27，北京时间约08:27、14:27、20:27和次日02:27。手动运行不需要等到下个时段。

GitHub计划任务只使用默认分支；繁忙时会延迟，极端情况下排队任务可能被丢弃。公开仓库连续60天没有活动时，计划工作流可能自动停用，需要重新启用。[官方事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

不要为了保持计划任务活跃而制造无意义提交。平时检查Actions和来源状态，有需要再手动运行。这个流程不提供分钟级或持续在线服务保证。

## 以后需要分享网页时，再考虑 Pages

这一节是后续可选方案，本次不执行。GitHub Free 支持公开仓库的 Pages，私有仓库 Pages 取决于账户套餐；网页的访问范围仍需单独确认。[Pages 可用范围](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

Pages 默认受仓库变量 ENABLE_PAGES 控制；未设或不是 true 时，发布任务跳过。

1. 确认 site/ 中的内容可以公开；不要上传私人备份或密钥。
2. 在仓库 Settings → Pages，将发布来源设置为 **GitHub Actions**。如果账户不支持当前仓库类型的Pages，先保留本机使用或选择你明确接受的仓库可见性。
3. 在 Settings → Secrets and variables → Actions → Variables 添加仓库变量 **ENABLE_PAGES=true**。
4. 在 Actions 手动运行 **Publish reader to Pages**。成功后，以实际部署记录里的网址为准。
5. 需要使用新站点地址时，将实际网址保存为仓库变量 **OCEAN_SITE_URL**。中文RSS目前继续使用已配置的公开原始文件地址；若也要迁移订阅入口，再将 config/sources.json 的 feedUrl 改为新站点的 feed.xml 地址。

开启以后，每次 Refresh ocean sources 成功结束会触发Pages流程；手动修改site/后也可以手动发布。不需要再添加个人token。GitHub内置token写回的push通常不会触发另一个push工作流，所以这里使用更新完成事件接力。[GitHub令牌触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)

发布工作流只上传 site/，不会把 engine/、配置目录和运维资料一并作为网页发布。需要停止发布时，先将 ENABLE_PAGES 设为 false；如果需要撤下已发布网站，还要在Pages设置中取消发布，单纯停止任务不会删除现有网页。[配置发布来源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 常见情况

| 看到的现象 | 先看哪里 |
| --- | --- |
| 页面没变，但Actions绿色 | Pages是否开启；这次是否有新资料；浏览器是否仍在缓存旧文件 |
| Actions红色 | 来源全部失败，还是写回权限/分支规则失败；它们是不同问题 |
| 一部分来源失败 | 旧资料是否保留、stale是否显示；不要把全部资料清空 |
| 长时间没有运行记录 | 流程是否在默认分支、是否停用、是否遇到平台排队 |
| RSS网址不正确 | 使用公开 raw XML 地址，核对 feedUrl；不要复制 GitHub 文件预览页 |
| 有私人资料要保存 | 不要提交到本次公开仓库；保留在本机私密目录，或另建私有仓库 |
| 新资料还没有中文 | 在“也看待整理原文”中查看；让 AI 助手按仓库提示词处理待整理队列 |
| 想要AI选稿、事件热点和日报 | 启动并验收 engine/；已有中文概括不等于完成两次选稿评分 |

以上GitHub规则核对于2026-10-24，具体账户能力和后续平台变化以链接中的官方说明为准。

