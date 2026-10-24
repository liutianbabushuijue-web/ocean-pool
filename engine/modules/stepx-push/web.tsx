// stepx 同步模块的网页部分：后台导航里的「海洋同步」。
import type { WebModule } from "@aihot/web/modules";

export default {
  name: "stepx-push",
  admin: {
    groups: [{ group: "海洋", items: [{ to: "/admin/sync", label: "海洋同步" }] }],
  },
} satisfies WebModule;
