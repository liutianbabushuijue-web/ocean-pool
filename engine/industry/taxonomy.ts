// 海洋领域分类体系：类别、标签词表、机构名录、身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 类别 key 会出现在网址里（/all?category=…）和 RSS 地址里，上线后就不要再改；标签和名录可以随时增减。
//
// 与 AIHOT 原版的关系：字段结构、`as const satisfies` 的类型约束、commentary / section 语义都保持不变，
// 只把行业内容换成海洋。类别 key 用英文短词，避免网址里出现中文字符。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉结构抽取模型这一类收什么、
 * 和相邻类别的边界在哪（总的归类原则写在 prompts/structure.md 里）。
 * commentary 标出评论类（观点、综述）：日报写过的事又有评论类的后续报道，只占一行快讯（报道它的信源够多时除外）。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 * tagColor 是飞书推送卡片里跟在标题后面的这一类小标签的颜色（飞书 text_tag 的颜色名）。
 * feedLabel 是分类 RSS 标题里的名字（不写就用 label）。
 */
export const CATEGORIES = [
  {
    key: "physical",
    tagColor: "indigo",
    label: "物理海洋",
    feedLabel: "物理海洋",
    section: "物理海洋与观测",
    guide: "按核心学科分类，跨学科标签另标。优先关注可改变认识或预测能力的结果，但不得仅凭论文自称突破添加“科研突破”。海洋环流、水团、中尺度与亚中尺度过程、内波、混合、海气通量、潮汐与海平面、海冰动力，以及为这些认识服务的新观测手段与航次结果。新的模式版本归“工程与技术”，只有模式对比结论落在机制认识上时才归这里。",
  },
  {
    key: "climate",
    tagColor: "orange",
    label: "海洋与气候",
    feedLabel: "海洋与气候",
    section: "海洋与气候",
    guide: "ENSO、AMOC、PDO 等气候模态，海洋热浪、酸化、脱氧、海平面上升、极地冰盖与海冰变化，以及气候预测、归因和 IPCC 相关评估。政策文本归“政策与治理”，只有气候机制与预测本身归这里。",
  },
  {
    key: "biology",
    tagColor: "green",
    label: "海洋生物与生态",
    feedLabel: "海洋生物与生态",
    section: "海洋生物与生态",
    guide: "保护成效、生态修复、生物多样性与沿海生计的实证变化归此；有真实生态对象的公众参与也可归此。浮游生物、珊瑚、鱼类与渔业资源、深海生物、生态系统结构与功能、生物多样性、赤潮与外来种。养殖技术与渔业管理政策分别归“渔业与蓝色经济”和“政策与治理”，只有生态机制与资源状态归这里。",
  },
  {
    key: "chemistry",
    tagColor: "turquoise",
    label: "海洋化学",
    feedLabel: "海洋化学",
    section: "海洋化学与碳循环",
    guide: "营养盐、溶解氧、碳循环与碳汇、海洋酸化化学、痕量金属、有机质、污染物与新污染物、同位素示踪。碳汇的政策计量归“政策与治理”，化学过程与观测归这里。",
  },
  {
    key: "policy",
    tagColor: "purple",
    label: "海洋政策与治理",
    feedLabel: "海洋政策与治理",
    section: "海洋政策与治理",
    guide: "中国海洋发展按实质事项分类，以“中国海洋发展”标签跨类聚合，不单因中国机构署名贴标签。BBNJ、UNCLOS、IMO 规则、区域渔业组织决定、海洋保护区与海洋空间规划、蓝色金融、IUU 渔业、深海采矿治理、国家海洋战略与涉海机构调整。协定文本、谈判进展与约束性决定归这里；单纯的科研资助公告归“工程与技术”。",
  },
  {
    key: "engineering",
    tagColor: "amber",
    label: "海洋工程与技术",
    feedLabel: "海洋工程与技术",
    section: "海洋工程与技术",
    guide: "关注成果从实验室走向海试、示范与实际应用的阶段、成本、可靠性和获取途径，不将原型当成量产。海洋模式与同化系统、卫星与遥感、浮标与潜标、ROV/AUV/滑翔机、海底观测网、海洋能、港口与航运技术、海洋信息与数据平台、观测装备与传感器。以新方法为主的论文与处理链归这里；纯科学结论归对应学科。",
  },
  {
    key: "deepsea",
    tagColor: "violet",
    label: "深海与极地",
    feedLabel: "深海与极地",
    section: "深海与极地",
    guide: "深海与深渊的探测、热液与冷泉、深海生物与矿产、极地海冰与冰盖、极地科考与站区、南大洋动力。深海采矿的政策与许可归“政策与治理”，探测发现与装备作业归这里。",
  },
  {
    key: "fisheries",
    tagColor: "crimson",
    label: "渔业与蓝色经济",
    feedLabel: "渔业与蓝色经济",
    section: "渔业与蓝色经济",
    guide: "渔业资源评估、配额与休渔实践、养殖技术、水产种业、海洋牧场、海洋能源与海上风电、蓝色债券与海洋产业投资。渔业资源的生态机制归“海洋生物与生态”，配额与管理的法律决定归“政策与治理”，产业侧的实践与经营归这里。",
  },
] as const satisfies ReadonlyArray<{ key: string; tagColor: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;

/**
 * 这个行业最受关注的一类发布。海洋领域没有“新模型”那种单一发布类型：新数据产品、新卫星、新论文的
 * 重要性分散在多个类别里，所以设为 null，日报报头不显示这个数。
 * 想统计“新数据集”时再填，例如 { category: "engineering", tag: "数据/产品更新", unit: "个新数据集" }。
 */
export const RELEASE: { category: string; tag: string; unit: string } | null = null;

/** 周报月报的总述可以直接写、不必在报道里找到出处的行业通用词（小写）。站名会自动算进去。 */
export const PLAIN_TERMS: readonly string[] = ["enso", "amoc", "sst", "noaa", "ioc", "unclos", "bbnj", "imo", "ipcc", "argo", "glodap", "socat", "mpa", "eez", "doi"];

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 * 海洋场景沿用同一组 key（引擎按 key 取权重），语义映射见两份提示词的开头。
 */
export const ITEM_TYPES = ["model_release", "product_launch", "tool_or_prompt", "research_paper", "industry_event", "opinion_analysis", "tutorial_explainer"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "论文/研究", "数据/产品更新", "模式/装备发布", "观测/航次", "政策/法规", "政策/治理动态",
  "评估/检验", "数据/代码", "教程/方法", "专家观点", "现象/趋势", "产业/商业", "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "ENSO", "AMOC", "海温", "环流", "内波", "海气通量", "海平面", "海冰", "酸化", "脱氧", "碳汇",
  "营养盐", "初级生产力", "珊瑚", "浮游生物", "渔业资源", "深海", "热液", "极地", "遥感", "数值模式",
  "再分析", "数据同化", "海洋能", "海岸带", "海洋保护", "蓝色金融",
  "科研突破", "中国海洋发展", "成果应用", "公众服务", "海洋教育", "生态修复",
] as const;

/** 可选的实体标签（机构、实验室、平台）。 */
export const ENTITY_TAGS = [
  "NOAA", "NASA", "IOC-UNESCO", "WMO", "ICES", "IPCC", "自然资源部", "中国科学院", "中国海洋大学",
  "中国极地研究中心", "Woods Hole", "Scripps", "MBARI", "NOC", "AWI", "JAMSTEC", "KIOST", "CSIRO", "Nature", "Science",
] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  "研究论文": "论文/研究", 论文: "论文/研究", 研究: "论文/研究", paper: "论文/研究", papers: "论文/研究",
  "数据发布": "数据/产品更新", 数据集: "数据/产品更新", 产品: "数据/产品更新", 数据: "数据/产品更新", 更新: "数据/产品更新",
  模式: "模式/装备发布", 模型: "模式/装备发布", 卫星: "模式/装备发布", 装备: "模式/装备发布", 发布: "模式/装备发布",
  航次: "观测/航次", 观测: "观测/航次", 科考: "观测/航次", 潜标: "观测/航次", 浮标: "观测/航次",
  政策: "政策/法规", 法规: "政策/法规", 监管: "政策/法规", 协定: "政策/法规", 条约: "政策/法规", 治理: "政策/治理动态",
  评估: "评估/检验", 校验: "评估/检验", 基准: "评估/检验", 对比: "评估/检验", benchmark: "评估/检验",
  代码: "数据/代码", 开源: "数据/代码", 仓库: "数据/代码", repo: "数据/代码", 工具: "数据/代码",
  教程: "教程/方法", 方法: "教程/方法", 指南: "教程/方法", 实践: "教程/方法", 流程: "教程/方法",
  观点: "专家观点", 评论: "专家观点", 访谈: "专家观点",
  趋势: "现象/趋势", 现象: "现象/趋势",
  商业: "产业/商业", 产业: "产业/商业", 融资: "产业/商业", 投资: "产业/商业", 并购: "产业/商业", 公司: "产业/商业",
  海洋: "其他", 资讯: "其他", 综合: "其他",
  enso: "ENSO", amoc: "AMOC", pdo: "现象/趋势", sst: "海温", 海水温度: "海温", 温度: "海温",
  洋流: "环流", 海流: "环流", ocean: "环流", circulation: "环流",
  珊瑚礁: "珊瑚", coral: "珊瑚", 浮游植物: "浮游生物", 浮游动物: "浮游生物", plankton: "浮游生物",
  渔业: "渔业资源", 鱼类: "渔业资源", 水产: "渔业资源",
  极区: "极地", 北极: "极地", 南极: "极地", polar: "极地",
  热液喷口: "热液", 冷泉: "深海", hydrothermal: "热液",
  海岸: "海岸带", 河口: "海岸带", 滨海: "海岸带",
  保护区: "海洋保护", 保护区网络: "海洋保护", mpa: "海洋保护",
  蓝色经济: "蓝色金融", 蓝色债券: "蓝色金融",
};

// ── 机构与主体 ──────────────────────────────────────────────────────────────────────────

/**
 * 机构主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 * aliases 给结构抽取模型看；orgNames 是这家机构发消息时开头用的组织名，
 * 在它自己的主题页上读者知道说的是谁，可以省去；otherNames 是机构的其他称呼（账号名、子品牌、旧称）。
 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; orgNames?: string[]; otherNames?: string[] }> = {
  noaa: { name: "NOAA", displayTag: "NOAA", aliases: ["NOAA", "National Oceanic and Atmospheric Administration", "美国国家海洋和大气管理局"], orgNames: ["NOAA", "NOAA Research", "NOAA Ocean Service", "NOAA Fisheries", "National Ocean Service"], otherNames: ["NOAA NOS", "NOAA PMEL", "NOAA AOML", "NOAA GFDL"] },
  nasa: { name: "NASA", displayTag: "NASA", aliases: ["NASA", "美国航空航天局"], orgNames: ["NASA", "NASA Earth Science", "NASA JPL", "Jet Propulsion Laboratory"], otherNames: ["NASA Earth Observatory", "NASA Climate"] },
  "ioc-unesco": { name: "IOC-UNESCO", displayTag: "IOC-UNESCO", aliases: ["IOC-UNESCO", "IOC", "Intergovernmental Oceanographic Commission", "教科文组织政府间海洋学委员会", "海委会"], orgNames: ["IOC-UNESCO", "IOC", "UNESCO"], otherNames: ["GOOS", "Ocean Decade", "海洋十年"] },
  wmo: { name: "WMO", displayTag: "WMO", aliases: ["WMO", "World Meteorological Organization", "世界气象组织"], orgNames: ["WMO", "世界气象组织"] },
  ices: { name: "ICES", displayTag: null, aliases: ["ICES", "International Council for the Exploration of the Sea", "国际海洋开发理事会"], orgNames: ["ICES"] },
  ipcc: { name: "IPCC", displayTag: null, aliases: ["IPCC", "Intergovernmental Panel on Climate Change", "政府间气候变化专门委员会"], orgNames: ["IPCC"] },
  mnr: { name: "自然资源部", displayTag: "自然资源部", aliases: ["自然资源部", "Ministry of Natural Resources", "MNR"], orgNames: ["自然资源部", "自然资源部海洋预警监测司", "国家海洋局"], otherNames: ["中国自然资源报", "i自然"] },
  cas: { name: "中国科学院", displayTag: "中国科学院", aliases: ["中国科学院", "中科院", "Chinese Academy of Sciences", "CAS"], orgNames: ["中国科学院", "中科院", "中国科学院海洋研究所", "中科院海洋所", "中国科学院南海海洋研究所", "中国科学院深海科学与工程研究所"], otherNames: ["海洋大科学研究中心", "IOCAS", "SCSIO", "IDSSE"] },
  ouc: { name: "中国海洋大学", displayTag: "中国海洋大学", aliases: ["中国海洋大学", "海大", "Ocean University of China", "OUC"], orgNames: ["中国海洋大学", "中国海洋大学海洋与大气学院", "海大"], otherNames: ["OUC"] },
  pric: { name: "中国极地研究中心", displayTag: null, aliases: ["中国极地研究中心", "极地中心", "Polar Research Institute of China", "PRIC"], orgNames: ["中国极地研究中心", "极地中心"], otherNames: ["雪龙", "雪龙2"] },
  whoi: { name: "Woods Hole", displayTag: "Woods Hole", aliases: ["Woods Hole Oceanographic Institution", "WHOI", "伍兹霍尔海洋研究所"], orgNames: ["Woods Hole Oceanographic Institution", "WHOI"] },
  scripps: { name: "Scripps", displayTag: "Scripps", aliases: ["Scripps Institution of Oceanography", "Scripps", "斯克里普斯海洋研究所"], orgNames: ["Scripps Institution of Oceanography", "Scripps"] },
  mbari: { name: "MBARI", displayTag: null, aliases: ["MBARI", "Monterey Bay Aquarium Research Institute", "蒙特雷湾水族馆研究所"], orgNames: ["MBARI"] },
  noc: { name: "NOC", displayTag: null, aliases: ["National Oceanography Centre", "NOC", "英国国家海洋中心"], orgNames: ["National Oceanography Centre", "NOC"] },
  awi: { name: "AWI", displayTag: null, aliases: ["Alfred Wegener Institute", "AWI", "阿尔弗雷德·魏格纳研究所"], orgNames: ["Alfred Wegener Institute", "AWI"] },
  jamstec: { name: "JAMSTEC", displayTag: null, aliases: ["JAMSTEC", "Japan Agency for Marine-Earth Science and Technology", "日本海洋研究开发机构"], orgNames: ["JAMSTEC"] },
  kiost: { name: "KIOST", displayTag: null, aliases: ["KIOST", "Korea Institute of Ocean Science and Technology", "韩国海洋科学技术院"], orgNames: ["KIOST"] },
  csiro: { name: "CSIRO", displayTag: null, aliases: ["CSIRO", "澳大利亚联邦科学与工业研究组织"], orgNames: ["CSIRO"] },
  natgeo: { name: "National Geographic", displayTag: null, aliases: ["National Geographic", "国家地理"], orgNames: ["National Geographic", "National Geographic Society"] },
  nature: { name: "Nature", displayTag: "Nature", aliases: ["Nature", "Nature Portfolio", "自然"], orgNames: ["Nature", "Nature Portfolio"], otherNames: ["Nature Climate Change", "Nature Geoscience", "Nature Communications"] },
  science: { name: "Science", displayTag: "Science", aliases: ["Science", "Science Magazine", "AAAS", "科学"], orgNames: ["Science", "AAAS"], otherNames: ["Science News"] },
};

/**
 * 身份词典：摘要和标题里出现的机构，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 海洋领域机构名极易混淆（NOAA 与 NASA、IOC 与 IOC 奥林匹克、CAS 与 casually），这里只放最容易被误写的。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "noaa", name: "NOAA", patterns: [/\bnoaa\b|national oceanic and atmospheric|美国国家海洋和大气管理局/i] },
  { id: "nasa", name: "NASA", patterns: [/\bnasa\b|jet propulsion laboratory|\bjpl\b/i] },
  { id: "ioc-unesco", name: "IOC-UNESCO", patterns: [/\bioc[-\s]?unesco\b|intergovernmental oceanographic commission|\bgoos\b|ocean decade|海洋十年/i] },
  { id: "wmo", name: "WMO", patterns: [/\bwmo\b|world meteorological organization|世界气象组织/i] },
  { id: "ices", name: "ICES", patterns: [/\bices\b|international council for the exploration of the sea/i] },
  { id: "ipcc", name: "IPCC", patterns: [/\bipcc\b|intergovernmental panel on climate change/i] },
  { id: "mnr", name: "自然资源部", patterns: [/自然资源部|国家海洋局|\bmnr\b/i] },
  { id: "cas", name: "中国科学院", patterns: [/中国科学院|中科院|\bcas\b|\biocas\b|\bscsio\b|\bidss\b|idssc/i] },
  { id: "ouc", name: "中国海洋大学", patterns: [/中国海洋大学|海大|\bouc\b/i] },
  { id: "pric", name: "中国极地研究中心", patterns: [/中国极地研究中心|极地中心|\bpric\b|雪龙/i] },
  { id: "whoi", name: "Woods Hole", patterns: [/woods hole|\bwhoi\b/i] },
  { id: "scripps", name: "Scripps", patterns: [/scripps/i] },
  { id: "mbari", name: "MBARI", patterns: [/\bmbari\b|monterey bay aquarium/i] },
  { id: "noc", name: "NOC", patterns: [/national oceanography centre|\bnoc\b/i] },
  { id: "awi", name: "AWI", patterns: [/alfred wegener|\bawi\b/i] },
  { id: "jamstec", name: "JAMSTEC", patterns: [/jamstec|japan agency for marine-earth/i] },
  { id: "kiost", name: "KIOST", patterns: [/kiost|korea institute of ocean/i] },
  { id: "csiro", name: "CSIRO", patterns: [/\bcsiro\b/i] },
  { id: "nature", name: "Nature", patterns: [/nature (?:climate change|geoscience|communications|sustainability|ecology|water)|\bnature\b/i] },
  { id: "science", name: "Science", patterns: [/\bscience\b|\baaas\b/i] },
];

/** 这些域名上的文章，发布方就是对应的机构（托管平台如 Crossref、arXiv 不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "noaa", domains: ["noaa.gov", "oceanservice.noaa.gov", "fisheries.noaa.gov", "nesdis.noaa.gov"] },
  { entityId: "nasa", domains: ["nasa.gov", "earthobservatory.nasa.gov", "jpl.nasa.gov"] },
  { entityId: "ioc-unesco", domains: ["unesco.org", "ioc.unesco.org", "oceandecade.org"] },
  { entityId: "wmo", domains: ["wmo.int"] },
  { entityId: "mnr", domains: ["mnr.gov.cn", "nmdis.org.cn"] },
  { entityId: "cas", domains: ["cas.cn", "qdio.cas.cn", "scsio.cas.cn", "idsse.cas.cn"] },
  { entityId: "ouc", domains: ["ouc.edu.cn", "news.ouc.edu.cn"] },
  { entityId: "pric", domains: ["pric.org.cn"] },
  { entityId: "whoi", domains: ["whoi.edu"] },
  { entityId: "scripps", domains: ["scripps.ucsd.edu", "ucsd.edu"] },
  { entityId: "mbari", domains: ["mbari.org"] },
  { entityId: "nature", domains: ["nature.com"] },
  { entityId: "science", domains: ["science.org"] },
];

/** 原文里的这些写法也算提到了对应机构。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "ioc-unesco", pattern: /@IOC_UNESCO\b/i },
  { entityId: "noaa", pattern: /@NOAA\b/i },
  { entityId: "cas", pattern: /@中科院之声\b/ },
  { entityId: "ouc", pattern: /@中国海洋大学\b/ },
];
