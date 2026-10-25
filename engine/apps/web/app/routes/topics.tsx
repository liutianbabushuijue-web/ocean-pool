import { useLoaderData } from "react-router";
import { SITE, subjectAfter, withSubject } from "@aihot/site";
import type { Route } from "./+types/topics";
import type { TopicSummary, TopicsResponse } from "@aihot/contracts/site";
import { apiGet, cachedPage } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, pageMeta, siteUrl } from "../lib/seo";
import { IconChevronRight } from "../components/icons";
import { IntentLink } from "../components/ui/IntentLink";
import { BrandMark } from "../components/BrandMark";
import { PhoneBar } from "../components/shell/PhoneBar";
import { navUp } from "../components/shell/nav";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { home: navUp("/topics").tab, name: "主题" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: { request: Request }) {
  return cachedPage(300, await apiGet<TopicsResponse>("/api/site/topics", { signal: request.signal }));
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return pageMeta({ title: SITE.topicsTitle, path: "/topics", image: "/og/pages/topics.png" });
  const { groups, topics } = loaderData;
  const by = groups.map((g) => g.name).join("、");
  const indexed = topics.filter((t) => t.indexable);
  const named = indexed.slice(0, 6).map((t) => t.name.split(" / ")[0]).join("、");
  const base = siteUrl();
  return pageMeta({
    title: SITE.topicsTitle,
    description: `按${by}${subjectAfter("追踪", "最新动态")}：${named ? `${named}等 ` : ""}${topics.length} 个主题，浏览最新精选与重要进展，持续更新。`,
    path: "/topics",
    image: "/og/pages/topics.png",
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "@id": `${base}/topics#collection`,
        url: `${base}/topics`,
        name: withSubject("主题"),
        inLanguage: SITE.locale,
        isPartOf: { "@id": `${base}/#website` },
        mainEntity: {
          "@type": "ItemList",
          numberOfItems: indexed.length,
          itemListElement: indexed.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, url: `${base}/topics/${t.slug}` })),
        },
      },
      breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "主题", path: "/topics" }]),
    ],
  });
}

/** A directory of names: descriptions belong to the content, not under every link. */
function TopicCard({ t }: { t: TopicSummary }) {
  return (
    <IntentLink
      viewTransition
      to={`/topics/${t.slug}`}
      className="group flex min-h-[76px] items-center gap-3 rounded-card px-4 py-5 transition-colors hover:bg-surface active:bg-bg-sunk lg:min-h-[92px] lg:px-5 lg:py-6"
    >
      {t.brand && (
        <span className="flex shrink-0">
          <BrandMark brand={t.brand} size={26} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] font-medium leading-snug tracking-[-0.02em] text-ink transition-colors group-hover:text-accent lg:text-[20px]">
          {t.name}
        </span>
      </span>
      <IconChevronRight size={16} className="shrink-0 text-ink-4 transition-colors group-hover:text-accent" />
    </IntentLink>
  );
}

export default function TopicsPage() {
  const { groups, topics } = useLoaderData<typeof loader>();
  return (
    <div className="mx-auto max-w-[1120px] pb-20">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="主题" />
      <header className="pb-5 pt-6 lg:pb-8 lg:pt-10">
        <h1 data-page-title="" className="text-[34px] font-semibold leading-[1.15] tracking-[-0.035em] text-ink lg:text-[48px]">海洋主题</h1>
      </header>
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-10 lg:pt-12">
          <div className="border-b border-line pb-4">
            <h2 id={`topics-${g.key}`} className="text-[21px] font-semibold tracking-[-0.02em] text-ink lg:text-[24px]">
              {g.name}
            </h2>
          </div>
          <ul className="-mx-4 mt-3 grid grid-cols-1 gap-x-3 sm:grid-cols-2 lg:-mx-5 lg:mt-4 xl:grid-cols-3">
            {topics
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <TopicCard t={t} />
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
