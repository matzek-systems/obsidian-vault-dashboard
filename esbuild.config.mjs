import esbuild from "esbuild";
import process from "process";
import path from "path";
import { copyFileSync, mkdirSync, readdirSync } from "fs";

const VAULT_PATH = process.env.VAULT_PATH || path.join("C:", "All Vault");
const VAULT_PLUGIN_DIR = path.join(VAULT_PATH, ".obsidian", "plugins", "vault-dashboard");

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian", "electron", "child_process", "fs", "os", "http", "crypto",
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
  // The phone app's server ships inside the plugin (DL-689): copy remote-server/ source files
  // next to main.js. Runtime files (serve.pid, logs, shots/) live only in the installed copy.
  const srcDir = "remote-server", dstDir = path.join(VAULT_PLUGIN_DIR, "remote-server");
  mkdirSync(dstDir, { recursive: true });
  let n = 0;
  for (const f of readdirSync(srcDir)) {
    if (/\.(py|png|md)$/.test(f)) { copyFileSync(path.join(srcDir, f), path.join(dstDir, f)); n++; }
  }
  console.log(`Copied manifest.json + styles.css + remote-server/ (${n} files) to plugin dir`);
}).catch(() => process.exit(1));
