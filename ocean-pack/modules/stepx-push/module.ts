// 这个模块的地址：接口（api 进程）与一个后台页面（web 进程）。
// 接口都以 /api/stepx/ 开头，由 server.ts 与 admin.ts 注册；apps/api/src/app.ts 在引擎自己的路由之后、
// v1 fallback 之前调用它们，所以不会被通配路由吃掉。
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "stepx-push",
  apiPaths: [/^\/api\/stepx\//],
  adminPages: [{ path: "admin/sync", file: "web/admin-sync.tsx", id: "admin-sync" }],
});
