import esbuild from "esbuild";
import process from "process";
import path from "path";
import { copyFileSync } from "fs";

const VAULT_PATH = process.env.VAULT_PATH || path.join("C:", "All Vault");
const VAULT_PLUGIN_DIR = path.join(VAULT_PATH, ".obsidian", "plugins", "vault-dashboard");

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
  copyFileSync("manifest.json", path.join(VAULT_PLUGIN_DIR, "manifest.json"));
  copyFileSync("styles.css", path.join(VAULT_PLUGIN_DIR, "styles.css"));
  console.log("Copied manifest.json + styles.css to plugin dir");
}).catch(() => process.exit(1));
