// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

import type { Founder } from "@aihot/contracts/site-config";

/**
 * 日报、周报、月报什么时候出（北京时间，HH:mm）：日报收这个时间之前的 24 小时，周报在每个自然周之后的周一出，
 * 月报在每月 1 日出。排程、成刊时间窗口、缺期告警和所有提到时间的文案都读它（public/ 里的文件写占位
 * {{dailyTime}}、{{weeklyTime}}、{{monthlyTime}}）；排程每半小时检查一次，所以写整点或半点。
 * 海洋领域：早上 07:30 出日报，赶在通勤和早课之前。
 */
export const EDITION_TIMES = { daily: "07:30", weekly: "09:00", monthly: "09:30" };

/** “每天 07:30”“每周一 09:00”“每月 1 日 09:30”：写进句子里的出刊时间。 */
export const EDITION_WHEN = {
  daily: `每天 ${EDITION_TIMES.daily}`,
  weekly: `每周一 ${EDITION_TIMES.weekly}`,
  monthly: `每月 1 日 ${EDITION_TIMES.monthly}`,
};

export const SITE = {
  /** 站名：导航、页面标题、分享图、RSS、MCP、后台都用它。 */
  name: "海洋知识星球",
  /** 行业词：拼进默认说法里，比如“海洋日报”“全部海洋动态”。 */
  subject: "海洋",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "海洋知识星球 — 科研突破、生态与中国海洋发展 · 热点与日报",
  /** 主题目录页（/topics）的标题。 */
  topicsTitle: "海洋主题：科研突破、中国发展、生态保护与公众生活",
  /** 反馈表单输入框里的示例。 */
  feedbackExample: "例如：某条深海采矿的条目把海区写错了，原文是 CCZ，摘要写成了南海……",
  /** 反馈页标题下面的一句话。 */
  feedbackLead: "发现内容错误、希望补充的信源，或想分享海洋实践，都可以告诉我们。",
  /** 反馈表单邮箱框里的提示。 */
  feedbackEmailHint: "留下邮箱，我们可以回信联系你",
  /** 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。 */
  description: `追踪海洋科研突破、生态变化、中国海洋发展与实际应用，说明新发现与公众生活的联系；同一事件合并阅读，${EDITION_WHEN.daily} 出一份日报。`,
  /** llms.txt 里一句话介绍下面的一段详细介绍（选填）。 */
  llmsIntro: "海洋知识星球面向关心海洋的公众、学生、科研人员与从业者。精选关注证据、影响与可用性，热点反映独立来源的讨论，不代表科学结论更可靠。每条保留来源、原文日期和原文链接。",
  /** 一行小字：分享图、海报下方。 */
  tagline: "看见海洋的变化，找到与自己的联系",
  /** 搜索引擎读到的关键词（首页结构化数据）。 */
  keywords: ["海洋资讯", "海洋科学", "海洋政策", "海洋热浪", "深海", "海洋日报", "中国海洋发展", "海洋生态", "海洋应用", "海洋科普", "Ocean News"] as string[],
  /** 网站开始收录的年份（结构化数据的时间范围，选填）。 */
  since: "2026",
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /** 默认域名，只在没设置 SITE_URL 时使用。 */
  defaultUrl: "http://localhost:3000",
  /** 标准图标以外也放在网站根目录的图标，site/brand/ 里的文件名（选填）。 */
  rootIcons: [] as string[],
  /** MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 oceanhot_get_latest、oceanhot_search…… */
  mcpPrefix: "oceanhot",
  /** 公开接口（MCP、OpenAPI、llms.txt）的版本号，只升不降。 */
  interfaceVersion: "1.0.0",
  /** 对外联系邮箱（选填）：llms.txt 和给 Agent 的使用说明里会写。 */
  contactEmail: null as string | null,
  /** 关于页底部的一行小字（选填）。 */
  footerNote: "基于 AIHOT 开源框架搭建",
  /** 中国大陆网站的 ICP 备案号（选填）。 */
  icp: null as string | null,
  /** 中国大陆网站的公安备案信息（选填）。 */
  psb: null as string | null,
  /** 源码的 GitHub 仓库地址（选填）。 */
  github: "https://github.com/liutianbabushuijue-web/ocean-pool" as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "海洋知识星球",
    /** 创始人（选填）。 */
    founder: null as Founder | null,
  },
  /** 抓取信源时报上的名字和版本（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "DeepBlueBot/1.0",
} as const;

/** 使用规则和隐私说明两页（正文在 pages/ 里）。 */
export const POLICY = {
  terms: {
    /** 页面名：导航、页脚、页面标题都用它。 */
    name: "使用规则",
    description: "本站网页、RSS、公开 API 与 MCP 的使用规则。",
    /** llms.txt 里对这一页的一句说明（选填）。 */
    covers: null as string | null,
    /** Agent 接入页的 RSS、API 两栏各自提醒的使用规则（选填）。 */
    notes: {
      rss: "免费订阅摘要与原文链接；引用请保留来源，原文与数据的使用以权利方许可为准。",
      api: "按缓存时间轮询；遇到 429 遵守 Retry-After，批量同步请注明 User-Agent。",
    },
    /** 讲清哪些用途要先取得授权的话（选填）。 */
    license: {
      llms: "本站条目是对原文的摘要与索引，原文版权归各来源。转售本站汇编内容、或把它作为付费产品的主体数据，需要事先取得书面许可。",
      agent: "本站摘要与索引可以引用，请保留来源名称和原文链接；整站导出、原样转载需要事先取得许可。",
    },
    /** 公开接口、RSS 和 OpenAPI 文件声明使用规则的响应头（选填）。 */
    headers: null as null | Record<string, string>,
  },
  privacy: {
    description: "本站如何处理浏览器本地数据、反馈资料与访问日志。",
    /** llms.txt 里对这一页的一句说明（选填）。 */
    covers: null as string | null,
  },
  /** X 帖子本身的文字和图片算不算全文：算的话，只在这篇允许站内全文时显示。 */
  xPostIsFullText: true,
} as const;

/** 导航（电脑侧栏、手机底栏、“我的”页）。 */
export const NAV = {
  /** 不放进导航的引擎入口，目前只支持热点榜（"/hot"）和主题（"/topics"）。 */
  hidden: [] as Array<"/hot" | "/topics">,
};

/** 条目卡片和详情页上的几处说法和显示。 */
export const ITEM_COPY = {
  /** 模型写的那句理由叫什么：卡片、详情页、Markdown 导出、给 Agent 的回答和群推送都用它。 */
  reasonLabel: "与我们有什么关系",
  /** 读者在网页和分享图上看不看得到 AI 评分。只管显示：公开 API 和 MCP 的数据照样带 score。 */
  showScore: false,
};

/** 关于页的一张二维码卡片。 */
interface ContactCard {
  kind: string;
  title: string;
  note: string;
  /** 站外链接过的根目录文件名（选填），比如 qr-wechat.jpg：这个地址总是跳到现在的二维码。 */
  alias?: string;
}

/** 关于页的文案。数字（信源数、收录数、精选数、日报期数）来自站内实时统计，不用写在这里。 */
export const ABOUT = {
  kicker: `关于 ${SITE.name}`,
  /** 页面描述（搜索结果、分享卡片）。 */
  description: `关于 ${SITE.name}：${SITE.description}`,
  /** 大标题：第一行正常颜色，第二行强调色。 */
  headline: ["海洋不只在远方，", "它也关系我们的生活与未来。"] as [string, string],
  /** 标题下面的一段话。{sources} 会换成实时的信源数。 */
  lead: `${SITE.name} 替你盯着{sources}个信源：海洋机构与期刊、中国科研和政策发布、生态与应用报道；用证据筛选、按事件归并，既追重要变化，也关注普通人能理解和参与的事，${EDITION_WHEN.daily} 出一份日报。免费，不用注册。`,
  sourcesFallback: "二十多个",
  /** 信源河动画下面的四个环节。 */
  steps: {
    collect: "追踪国际海洋机构、期刊与公开媒体，并单独补充中国海洋科研和政策一手发布；外部推送来源只有接好采集器才会更新，来源名单不等于已经采集成功。",
    store: "同一事件的多篇报道归在一起；热点依据独立来源的讨论计算，不伪造点击量，也不以热度替代科研价值。",
    select: `先判断海洋相关性，再独立评分两次。科研突破、生态、中国发展、实用技术和公众服务都可入选；标题通俗具体，说明证据和适用范围，压住宣传、重复转发和夸大突破。`,
    publish: `${EDITION_WHEN.daily} 出日报，${EDITION_WHEN.weekly} 出周报，${EDITION_WHEN.monthly} 出月报。`,
  },
  /** 作者块（选填），null 就不显示。 */
  maker: null as null | {
    name: string;
    avatarSourceId?: string | null;
    greeting: string[];
    wechat?: ContactCard;
    feishu?: ContactCard;
  },
  /** 页面底部的版权与下架说明，中间接“反馈页”的链接。 */
  copyright: [`${SITE.name} 是聚合摘要和阅读索引，原文版权归各来源所有。如果你是来源方，希望更正、下架或调整展示方式，可以通过`, "联系我们。"] as [string, string],
  /** 页面底部“使用规则”链接的锚点 id（选填）。 */
  termsAnchor: null as string | null,
} as const;

/** 后台页面上给管理员的提示（选填）。 */
export const ADMIN = {
  /** “反馈”页标题下的一行。 */
  feedbackNote: null as string | null,
  /** 确认框里补的一句本站规定：封禁反馈来源时。 */
  banNote: null as string | null,
  /** 确认框里补的一句本站规定：调整付费服务的请求上限时。 */
  budgetNote: null as string | null,
};

/** Agent 接入页的示例。 */
export const AGENT = {
  /** MCP 工具表里“搜索”一行：能搜什么、可以怎么问。 */
  search: { scope: "按机构、海区、计划或主题搜最近 7 天", ask: "南海最近有什么新的热浪观测？" },
};

/** 日报、周报、月报版面上的说法。 */
export const REPORTS = {
  /** 报头下面的出版者一行。 */
  imprint: SITE.name.toUpperCase(),
  /** 报头旁边的一个词。 */
  motto: SITE.subject as string,
  /** 每种报告页面的描述（搜索结果、分享卡片），不带句号。 */
  descriptions: {
    daily: `${SITE.name} ${subjectAfter(`${EDITION_WHEN.daily}（北京时间）发布的`, "行业精编日报")}`,
    weekly: subjectAfter("每周", "行业综合回顾"),
    monthly: subjectAfter("每月", "行业盘点"),
  },
  /** 一期里的一条怎么称呼（“4 件大事”）。 */
  entry: { measure: "件", noun: "大事" },
  /** 报头上其余几个数字后面的说法。 */
  metricUnits: { sourcesCount: "个来源", firstPartyEvents: "件一手发布", selectedCount: "条精选", reportsCovered: "期日报" },
  /** 报告分享图上“共几条”的说法。 */
  shareUnit: "件大事",
  /** 日报时段内有资料经过评判、但没有新大事时的标题与导语。 */
  quiet: { title: "今日安静，没有需要跟进的大事", paragraph: `${subjectAfter("北京时间 {start} 至 {end}，没有新的", "大事")}。` },
};

/** 运维告警（只发给站长）里随部署而变的几处说法。 */
export const ALERTS = {
  /** 多少分钟没有收录新文章就告警“网站停止收录新内容”（最多一天）；环境变量 ALERT_QUIET_MINUTES 优先。 */
  quietMinutes: 360,
  /** 同一条告警里，“没有”后面补一句平时的收录量；null 就不写。 */
  usualFlow: null as string | null,
  /** worker 停了的告警里，怎么看它的日志。 */
  workerLogs: "看 worker 的日志（docker compose logs worker）",
};

/** 后台新建信源时的默认设置。 */
export const SOURCE_DEFAULTS = {
  /** 站内展示全文；false 时只显示摘要和原文链接。 */
  siteFulltext: false,
};

/** 社区站的信源（填信源 id）：算热度时按发帖的账号计。 */
export const COMMUNITY_FEEDS: { dev: string[]; hn: string[] } = {
  dev: [],
  hn: [],
};

/** 各页分享图（/og/pages/*.png）上的文字。 */
export const CARDS: Record<string, { kicker: string; title: string; subtitle: string; accent?: "hot" | "amber" }> = {
  site: { kicker: subjectAfter("每日", "精选"), title: SITE.tagline, subtitle: SITE.description },
  all: { kicker: subjectAfter("全部", "动态"), title: "所有信源的最新动态，一站看完", subtitle: "按时间汇总各信源的最新动态，可按类别与标签筛选。" },
  hot: { kicker: "热点榜", title: "过去 48 小时，哪些海洋事件被共同关注", subtitle: "按独立来源讨论计算，热度不等于点击量或科研质量。", accent: "hot" },
  daily: { kicker: withSubject("日报"), title: subjectAfter(`每天 ${spokenTime(EDITION_TIMES.daily)}，一份读得完的`, "日报"), subtitle: `${subjectAfter("前一天值得关注的", "动态")}。` },
  weekly: { kicker: withSubject("周报"), title: `一周${REPORTS.entry.noun}，一次看清`, subtitle: "本周的主线、重要发布与值得回看的讨论。" },
  monthly: { kicker: withSubject("月报"), title: "一个月的变化", subtitle: "月度主线与关键事件回顾。" },
  about: { kicker: "关于", title: `关于 ${SITE.name}`, subtitle: SITE.description },
  terms: { kicker: "使用规则", title: `${SITE.name} 使用规则`, subtitle: "网页、API、RSS 与 MCP 的使用范围。" },
  privacy: { kicker: "隐私说明", title: `${SITE.name} 隐私说明`, subtitle: "访问日志、浏览器本地数据与反馈资料的处理方式。" },
  changelog: { kicker: "更新日志", title: `${SITE.name} 更新日志`, subtitle: "功能更新、优化、公告与下线记录。" },
  feedback: { kicker: "反馈", title: "告诉我们哪里可以更好", subtitle: "内容、功能、接入，或来源方的更正与下架请求。" },
  agent: { kicker: "Agent 接入", title: `把 ${SITE.name} 接进你的 Agent`, subtitle: "MCP、RSS、API 三种方式，匿名只读，无需 API Key。" },
};

/** 公开接口的访问约定里随部署而变的几处。 */
export const ACCESS = {
  /** 同一 IP 每分钟大约能请求多少次（选填，由反向代理限流）；null 表示不限流。 */
  ratePerMinute: null as number | null,
  /** 请写程序同步数据的人报上的 User-Agent（选填）。 */
  userAgent: "OceanSync/1.0 (+联系方式)",
};

/** 这个部署自己的几处安排（选填）。 */
export const DEPLOYMENT = {
  /** 凭据分组文件默认放在哪个目录（选填）。 */
  credentialsDir: null as string | null,
  /** 凭据分组的文件名（选填）。 */
  credentialFiles: {} as Partial<Record<string, string>>,
  /** 这个部署额外要求的凭据（[分组, 环境变量名]）；生产 API 启动时检查。 */
  requiredSecrets: [["integrations", "STEPX_TOKEN"]] as const,
  /** 线上 api 收到的 Host（CDN 回源用的域名，选填）。 */
  originHost: null as string | null,
  /** 反向代理把没登录的后台访问转去登录时，用哪个请求头带上原来的地址（选填）。 */
  loginReturnHeader: null as string | null,
  /** 图片代理从原站取图的流量上限（选填）。 */
  imageUpstreamBudget: null as null | { mbPerMinute: number; gbPerDay: number },
  /** 已实测应由服务器直接连接的域名（选填）。 */
  directFetchHosts: [] as string[],
  /** 精选评测不带参数时用的金标集（选填）。 */
  selectionGold: { file: ".data/gold.jsonl", sample: 150, split: "calibration", sweep: [45, 85] } as null | { file: string; sample: number; split: string; sweep: [number, number] },
};

/** RSS 订阅源的说明里随站点而变的说法。 */
export const FEED_COPY = {
  /** “全部动态”源的说明里补充的不含内容（选填）。 */
  allLeavesOut: [] as string[],
};

/** 公开接口（API、RSS、MCP）里和网页不同的类别（选填）。上线后不要改。 */
export const PUBLIC_CATEGORIES = {
  merge: { deepsea: "engineering" },
  feedLabels: { engineering: "工程与深海" },
} as const;

/** “海洋日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}

/** “按主题看海洋”“往期海洋日报”这类说法。 */
export function subjectAfter(text: string, noun?: string): string {
  const gap = /^[A-Za-z0-9]/.test(SITE.subject) ? " " : "";
  return `${text}${gap}${noun ? withSubject(noun) : SITE.subject}`;
}

/** “7 点 30 分”“9 点”：口语里的 HH:mm。 */
function spokenTime(time: string): string {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  return `${hour} 点${minute ? ` ${minute} 分` : ""}`;
}
