import esbuild from "esbuild";
import process from "process";
import path from "path";
import { copyFileSync } from "fs";

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
}).then(() => {
  copyFileSync("styles.css", path.join(VAULT_PLUGIN_DIR, "styles.css"));
  console.log("Copied styles.css to plugin dir");
  copyFileSync("manifest.json", path.join(VAULT_PLUGIN_DIR, "manifest.json"));
  console.log("Copied manifest.json to plugin dir");
}).catch(() => process.exit(1));
