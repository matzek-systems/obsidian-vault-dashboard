import esbuild from "esbuild";
import process from "process";
import path from "path";

const VAULT_PLUGIN_DIR = path.join(
  "C:", "All Vault", ".obsidian", "plugins", "vault-dashboard"
);

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian", "electron",
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands",
    "@codemirror/language", "@codemirror/lint", "@codemirror/search",
    "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr"
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: "inline",
  treeShaking: true,
  outfile: path.join(VAULT_PLUGIN_DIR, "main.js"),
}).catch(() => process.exit(1));
