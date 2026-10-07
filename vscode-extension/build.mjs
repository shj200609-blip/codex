import { build, context } from "esbuild";
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: true,
};
if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching Codex Changes Review");
} else {
  await build(options);
}
