const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");

const buildConfigs = [
  {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    sourcemap: true,
    minify,
  },
  {
    entryPoints: ["src/server.ts"],
    bundle: true,
    outfile: "dist/server.js",
    format: "cjs",
    platform: "node",
    sourcemap: true,
    minify,
  }
];

async function main() {
  for (const config of buildConfigs) {
    if (watch) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
      console.log(`watching ${config.entryPoints[0]}...`);
    } else {
      await esbuild.build(config);
      console.log(`built ${config.entryPoints[0]}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
