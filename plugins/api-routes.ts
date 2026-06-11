import type { Plugin } from "esbuild";
import { readdirSync } from "fs";
import { join } from "path";

function findApiRoutes(dir: string): Array<{ file: string; routePath: string }> {
  function walk(current: string): Array<{ file: string; routePath: string }> {
    return readdirSync(current, { withFileTypes: true }).flatMap((e) => {
      const full = join(current, e.name);
      if (e.isDirectory()) return walk(full);
      if (!e.name.endsWith(".ts")) return [];
      const rel = full.slice(dir.length + 1).replace(/\\/g, "/");
      return [{ file: full.replace(/\\/g, "/"), routePath: "/" + rel.replace(/\.ts$/, "") }];
    });
  }
  try { return walk(dir); } catch { return []; }
}

export const apiRoutesPlugin: Plugin = {
  name: "api-routes",
  setup(build) {
    build.onResolve({ filter: /^virtual:api-routes$/ }, (args) => ({
      path: args.path,
      namespace: "virtual",
    }));
    build.onLoad({ filter: /.*/, namespace: "virtual" }, () => {
      const routes = findApiRoutes("api");
      const imports = routes.map((r, i) => `import * as r${i} from "./${r.file}";`);
      const entries = routes.map((r, i) => `{ routePath: ${JSON.stringify(r.routePath)}, mod: r${i} }`);
      return {
        contents: [...imports, `export const routes = [${entries.join(", ")}];`].join("\n"),
        loader: "ts",
        resolveDir: ".",
        // Re-enumerate when files are added to/removed from api/ in watch mode;
        // without this the route list is cached and new routes need a restart.
        watchDirs: ["api", "api/agent", "api/agent/files", "api/agent/jobs"],
      };
    });
  },
};
