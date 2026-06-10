import * as esbuild from "esbuild";
import { spawn, type ChildProcess } from "child_process";
import { apiRoutesPlugin } from "./plugins/api-routes.ts";

const outfile = "dist/index.js";
let server: ChildProcess | null = null;

function restartServer() {
  // A crashed server has already closed; waiting for its "close" event would
  // wedge the watcher (every rebuild piles a listener on a dead process).
  if (server && server.exitCode === null && !server.killed) {
    server.kill();
    server.once("close", launchServer);
  } else {
    launchServer();
  }
}

function launchServer() {
  server = spawn("node", [outfile], { stdio: "inherit" });
  server.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[build] server exited with code ${code}`);
  });
}

const ctx = await esbuild.context({
  entryPoints: ["index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  packages: "external",
  plugins: [
    apiRoutesPlugin,
    {
      name: "on-rebuild",
      setup(build) {
        build.onEnd(({ errors }) => {
          if (errors.length) return;
          console.log("[build] rebuilt — restarting");
          restartServer();
        });
      },
    },
  ],
});

await ctx.watch();
console.log("[build] watching index.ts + api/**");
