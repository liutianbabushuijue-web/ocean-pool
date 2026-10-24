// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";
import stepxPush from "@aihot/stepx-push/web";

export const WEB_MODULES: readonly WebModule[] = [stepxPush];
