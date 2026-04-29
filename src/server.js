import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import { WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

const LOG_FILE = path.join(STATE_DIR, "server.log");
const LOG_RING_BUFFER_MAX = 1000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024;
const logRingBuffer = [];
const sseClients = new Set();

function writeLog(level, category, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] [${category}] ${message}`;

  const consoleFn =
    level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;
  consoleFn(line);

  logRingBuffer.push(line);
  if (logRingBuffer.length > LOG_RING_BUFFER_MAX) {
    logRingBuffer.shift();
  }

  for (const client of sseClients) {
    try {
      client.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_FILE_SIZE) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      const lines = content.split("\n");
      fs.writeFileSync(LOG_FILE, lines.slice(Math.floor(lines.length / 2)).join("\n"));
    }
  } catch {}
}

const log = {
  info: (category, message) => writeLog("INFO", category, message),
  warn: (category, message) => writeLog("WARN", category, message),
  error: (category, message) => writeLog("ERROR", category, message),
};

function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    log.warn("gateway-token", `could not read existing token: ${err.code || err.message}`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    log.warn("gateway-token", `could not persist token: ${err.code || err.message}`);
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

let cachedOpenclawVersion = null;
let cachedChannelsHelp = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const [version, channelsHelp] = await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
    ]);
    cachedOpenclawVersion = version.output.trim();
    cachedChannelsHelp = channelsHelp.output;
  }
  return { version: cachedOpenclawVersion, channelsHelp: cachedChannelsHelp };
}

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);
const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);
const RADIUS_SKILLS_DIR =
  process.env.RADIUS_SKILLS_DIR?.trim() ||
  path.join(STATE_DIR, "external-skills", "radius-skills");
const RADIUS_REQUIRED_SKILLS = ["radius-wallet", "a2a-comms", "registering-agent"];
const RADIUS_SKILL_EXTRA_DIRS_KEY = "skills.load.extraDirs";
const RADIUS_PLUGIN_LOAD_PATHS_KEY = "plugins.load.paths";
const RADIUS_PLUGIN_ENABLED_KEY = "plugins.entries.radius-wallet.enabled";
const RADIUS_PLUGIN_ID = "radius-wallet";
const RADIUS_READ_TOOL_NAMES = [
  "radius_wallet_address",
  "radius_balance",
  "radius_tx_status",
];
const RADIUS_OPENCLAW_ADAPTER_DIR = path.join(RADIUS_SKILLS_DIR, "adapters", "openclaw");
const RADIUS_OPENCLAW_PLUGIN_MANIFEST = path.join(
  RADIUS_OPENCLAW_ADAPTER_DIR,
  "openclaw.plugin.json",
);
const RADIUS_OPENCLAW_LEGACY_PLUGIN_MANIFEST = path.join(
  RADIUS_OPENCLAW_ADAPTER_DIR,
  "plugin.json",
);
const RADIUS_OPENCLAW_RUNTIME_DIR = path.join(RADIUS_OPENCLAW_ADAPTER_DIR, "runtime", "python");
const RADIUS_RUNTIME_SOURCE_DIR = path.join(RADIUS_SKILLS_DIR, "runtime", "python");
const RADIUS_RUNTIME_SOURCE_MODULE = path.join(RADIUS_RUNTIME_SOURCE_DIR, "radius_wallet_runtime.py");
const RADIUS_RUNTIME_SOURCE_CLI = path.join(RADIUS_RUNTIME_SOURCE_DIR, "radius_wallet_cli.py");
const RADIUS_OPENCLAW_RUNTIME_MODULE = path.join(
  RADIUS_OPENCLAW_RUNTIME_DIR,
  "radius_wallet_runtime.py",
);
const RADIUS_OPENCLAW_RUNTIME_CLI = path.join(
  RADIUS_OPENCLAW_RUNTIME_DIR,
  "radius_wallet_cli.py",
);
const RADIUS_OPENCLAW_ENTRY_CANDIDATES = [
  path.join(RADIUS_OPENCLAW_ADAPTER_DIR, "dist", "index.js"),
  path.join(RADIUS_OPENCLAW_ADAPTER_DIR, "index.js"),
  path.join(RADIUS_OPENCLAW_ADAPTER_DIR, "src", "index.ts"),
  path.join(RADIUS_OPENCLAW_ADAPTER_DIR, "src", "radius-wallet.ts"),
];
const RADIUS_PLUGIN_DOCS_URL = "https://docs.openclaw.ai/tools/plugin";
const RADIUS_BUILDING_PLUGIN_DOCS_URL = "https://docs.openclaw.ai/plugins/building-plugins";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

function discoverRadiusSkills(rootDir = RADIUS_SKILLS_DIR) {
  const discovered = [];

  function walk(dirPath) {
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const skillFile = path.join(fullPath, "SKILL.md");
        if (fs.existsSync(skillFile)) {
          discovered.push({
            name: path.basename(fullPath),
            path: fullPath,
            published: (() => {
              try {
                return fs.readFileSync(skillFile, "utf8").includes("published: true");
              } catch {
                return false;
              }
            })(),
          });
        }
        walk(fullPath);
      }
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }

  return discovered;
}

function parseConfiguredStringArray(configText = "", key = "") {
  if (!configText || typeof configText !== "string" || !key) return [];

  const marker = `${key}:`;
  const idx = configText.indexOf(marker);
  if (idx === -1) return [];

  const after = configText.slice(idx + marker.length);
  const firstLine = (after.split("\n")[0] || "").trim();
  if (!firstLine) return [];

  if (firstLine.startsWith("[")) {
    const inside = firstLine.slice(
      1,
      firstLine.lastIndexOf("]") >= 0 ? firstLine.lastIndexOf("]") : undefined,
    );
    return [
      ...new Set(
        inside
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean),
      ),
    ];
  }

  return [firstLine.replace(/^['"]|['"]$/g, "")].filter(Boolean);
}

function parseConfiguredExtraDirs(configText = "") {
  return parseConfiguredStringArray(configText, RADIUS_SKILL_EXTRA_DIRS_KEY);
}

function parseConfiguredPluginLoadPaths(configText = "") {
  return parseConfiguredStringArray(configText, RADIUS_PLUGIN_LOAD_PATHS_KEY);
}

function pickRadiusPluginManifestPath() {
  if (fs.existsSync(RADIUS_OPENCLAW_PLUGIN_MANIFEST)) {
    return RADIUS_OPENCLAW_PLUGIN_MANIFEST;
  }
  if (fs.existsSync(RADIUS_OPENCLAW_LEGACY_PLUGIN_MANIFEST)) {
    return RADIUS_OPENCLAW_LEGACY_PLUGIN_MANIFEST;
  }
  return null;
}

function pickRadiusPluginEntryCandidate() {
  for (const candidate of RADIUS_OPENCLAW_ENTRY_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function tryParseTrailingJson(text = "") {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function escapeShellArg(value = "") {
  const text = String(value ?? "");
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function collectRadiusRuntimeReadiness() {
  const runtime = {
    runtimeDir: RADIUS_OPENCLAW_RUNTIME_DIR,
    runtimeDirExists: fs.existsSync(RADIUS_OPENCLAW_RUNTIME_DIR),
    runtimeModulePath: RADIUS_OPENCLAW_RUNTIME_MODULE,
    runtimeModuleExists: fs.existsSync(RADIUS_OPENCLAW_RUNTIME_MODULE),
    runtimeCliPath: RADIUS_OPENCLAW_RUNTIME_CLI,
    runtimeCliExists: fs.existsSync(RADIUS_OPENCLAW_RUNTIME_CLI),
    pythonPath: null,
    pythonAvailable: false,
    cliReadOpsProbe: {
      ok: false,
      code: null,
      tools: [],
      missing: [],
      output: "",
      error: null,
    },
  };

  if (!runtime.runtimeModuleExists || !runtime.runtimeCliExists) {
    runtime.cliReadOpsProbe.error =
      "runtime python module or CLI missing under adapters/openclaw/runtime/python";
    return runtime;
  }

  const pythonCandidates = [
    String(process.env.RADIUS_PYTHON_BIN || "").trim(),
    String(process.env.PYTHON_BIN || "").trim(),
    "python3",
    "python",
  ].filter(Boolean);

  for (const candidate of pythonCandidates) {
    const resolved = childProcess.spawnSync("sh", ["-lc", `command -v ${escapeShellArg(candidate)}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    if (resolved.status === 0) {
      runtime.pythonPath = (resolved.stdout || "").trim() || candidate;
      runtime.pythonAvailable = true;
      break;
    }
  }

  if (!runtime.pythonAvailable || !runtime.pythonPath) {
    runtime.cliReadOpsProbe.error =
      "python runtime unavailable (set RADIUS_PYTHON_BIN or install python3)";
    return runtime;
  }

  const probeScript = [
    "import argparse, json, os, runpy, sys",
    `sys.path.insert(0, ${JSON.stringify(RADIUS_OPENCLAW_RUNTIME_DIR)})`,
    `module = runpy.run_path(${JSON.stringify(RADIUS_OPENCLAW_RUNTIME_CLI)})`,
    "parser = module['build_parser']()",
    "subparsers_action = next((a for a in parser._actions if isinstance(a, argparse._SubParsersAction)), None)",
    "commands = sorted(subparsers_action.choices.keys()) if subparsers_action else []",
    "print(json.dumps({'commands': commands}))",
  ].join("\n");

  const probe = childProcess.spawnSync(runtime.pythonPath, ["-c", probeScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  const rawOutput = `${probe.stdout || ""}${probe.stderr || ""}`.trim();
  runtime.cliReadOpsProbe.code = typeof probe.status === "number" ? probe.status : 1;
  runtime.cliReadOpsProbe.output = rawOutput;

  if (probe.status !== 0) {
    runtime.cliReadOpsProbe.error = rawOutput || "read-op probe failed";
    return runtime;
  }

  const parsed = tryParseTrailingJson(rawOutput);
  const tools = Array.isArray(parsed?.commands) ? parsed.commands : [];
  const readOnlyOps = ["wallet-address", "balance", "tx-status"];
  const missing = readOnlyOps.filter((name) => !tools.includes(name));

  runtime.cliReadOpsProbe.tools = tools;
  runtime.cliReadOpsProbe.missing = missing;
  runtime.cliReadOpsProbe.ok = missing.length === 0;
  return runtime;
}

function ensureRadiusOpenClawAdapterContract() {
  const actions = [];

  if (!fs.existsSync(RADIUS_OPENCLAW_ADAPTER_DIR)) {
    return {
      ok: false,
      adapterDir: RADIUS_OPENCLAW_ADAPTER_DIR,
      actions,
      error: "adapter directory missing",
    };
  }

  fs.mkdirSync(path.join(RADIUS_OPENCLAW_ADAPTER_DIR, "src"), { recursive: true });
  fs.mkdirSync(RADIUS_OPENCLAW_RUNTIME_DIR, { recursive: true });

  const copyRuntimeIfMissing = (sourcePath, targetPath, label) => {
    if (fs.existsSync(targetPath)) return;
    if (!fs.existsSync(sourcePath)) return;
    fs.copyFileSync(sourcePath, targetPath);
    actions.push(`copied ${label} into adapter runtime/python`);
  };

  copyRuntimeIfMissing(
    RADIUS_RUNTIME_SOURCE_MODULE,
    RADIUS_OPENCLAW_RUNTIME_MODULE,
    "radius_wallet_runtime.py",
  );
  copyRuntimeIfMissing(
    RADIUS_RUNTIME_SOURCE_CLI,
    RADIUS_OPENCLAW_RUNTIME_CLI,
    "radius_wallet_cli.py",
  );

  const legacyManifestPath = fs.existsSync(RADIUS_OPENCLAW_LEGACY_PLUGIN_MANIFEST)
    ? RADIUS_OPENCLAW_LEGACY_PLUGIN_MANIFEST
    : null;

  let legacyManifest = null;
  if (legacyManifestPath) {
    try {
      legacyManifest = JSON.parse(fs.readFileSync(legacyManifestPath, "utf8"));
    } catch {}
  }

  const normalizedName =
    typeof legacyManifest?.name === "string" && legacyManifest.name.trim()
      ? legacyManifest.name.trim()
      : RADIUS_PLUGIN_ID;

  const desiredManifest = {
    id: RADIUS_PLUGIN_ID,
    name: normalizedName,
    description:
      typeof legacyManifest?.description === "string" && legacyManifest.description.trim()
        ? legacyManifest.description.trim()
        : "Radius wallet adapter for OpenClaw",
    configSchema: {
      type: "object",
      additionalProperties: true,
    },
    activation: {
      onStartup: true,
      onCapabilities: ["tool"],
    },
    contracts: {
      tools: RADIUS_READ_TOOL_NAMES,
    },
  };

  let existingManifest = null;
  if (fs.existsSync(RADIUS_OPENCLAW_PLUGIN_MANIFEST)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(RADIUS_OPENCLAW_PLUGIN_MANIFEST, "utf8"));
    } catch {
      existingManifest = null;
    }
  }

  const shouldWriteManifest =
    !existingManifest || JSON.stringify(existingManifest) !== JSON.stringify(desiredManifest);
  if (shouldWriteManifest) {
    fs.writeFileSync(
      RADIUS_OPENCLAW_PLUGIN_MANIFEST,
      `${JSON.stringify(desiredManifest, null, 2)}\n`,
      "utf8",
    );
    actions.push(
      existingManifest
        ? "normalized openclaw.plugin.json for deterministic Radius read tool contract"
        : "created openclaw.plugin.json for deterministic Radius read tool contract",
    );
  }

  const adapterEntryPath = path.join(RADIUS_OPENCLAW_ADAPTER_DIR, "src", "index.ts");
  const desiredEntrySource = `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RadiusWalletRuntime } from "../runtime/python/radius_wallet_runtime.py";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtime = new RadiusWalletRuntime();
const runtimeConfiguredPath = path.resolve(__dirname, "../runtime/python");

function mapError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message, runtimePath: runtimeConfiguredPath },
    isError: true,
  };
}

export default definePluginEntry({
  id: "radius-wallet",
  name: "Radius Wallet",
  description: "Deterministic Radius wallet read operations via shared runtime",
  register(api) {
    api.registerTool({
      name: "radius_wallet_address",
      description: "Return this agent's Radius wallet address for the selected provider.",
      parameters: Type.Object({
        provider: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("para")])),
      }),
      async execute(_id, params) {
        try {
          const result = runtime.wallet_address(params?.provider ?? "local");
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (err) {
          return mapError(err);
        }
      },
    });

    api.registerTool({
      name: "radius_balance",
      description: "Get Radius Testnet RUSD and SBC balances for an address or the selected provider wallet.",
      parameters: Type.Object({
        address: Type.Optional(Type.String()),
        provider: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("para")])),
      }),
      async execute(_id, params) {
        try {
          const result = runtime.balance(
            params?.provider ?? "local",
            params?.address,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (err) {
          return mapError(err);
        }
      },
    });

    api.registerTool({
      name: "radius_tx_status",
      description: "Fetch a Radius transaction receipt by hash.",
      parameters: Type.Object({
        tx_hash: Type.String(),
      }),
      async execute(_id, params) {
        try {
          const result = runtime.tx_status(params.tx_hash);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (err) {
          return mapError(err);
        }
      },
    });
  },
});
`;

  let existingEntrySource = "";
  try {
    existingEntrySource = fs.readFileSync(adapterEntryPath, "utf8");
  } catch {
    existingEntrySource = "";
  }

  if (existingEntrySource !== desiredEntrySource) {
    fs.writeFileSync(adapterEntryPath, desiredEntrySource, "utf8");
    actions.push(
      existingEntrySource
        ? "updated src/index.ts with deterministic Radius read tools"
        : "created src/index.ts with deterministic Radius read tools",
    );
  }

  const adapterPackagePath = path.join(RADIUS_OPENCLAW_ADAPTER_DIR, "package.json");
  let packageJson = {};
  if (fs.existsSync(adapterPackagePath)) {
    try {
      packageJson = JSON.parse(fs.readFileSync(adapterPackagePath, "utf8"));
    } catch {
      packageJson = {};
    }
  }

  const previousPackage = JSON.stringify(packageJson);
  packageJson.name = packageJson.name || `@radiustechsystems/openclaw-${RADIUS_PLUGIN_ID}`;
  packageJson.version = packageJson.version || "0.0.0";
  packageJson.type = packageJson.type || "module";
  packageJson.openclaw = packageJson.openclaw || {};

  const ext = Array.isArray(packageJson.openclaw.extensions)
    ? packageJson.openclaw.extensions
    : [];
  if (!ext.includes("./src/index.ts")) {
    packageJson.openclaw.extensions = [...new Set([...ext, "./src/index.ts"])
    ];
  }

  const runtimeExt = Array.isArray(packageJson.openclaw.runtimeExtensions)
    ? packageJson.openclaw.runtimeExtensions
    : [];
  if (!runtimeExt.includes("./dist/index.js")) {
    packageJson.openclaw.runtimeExtensions = [
      ...new Set([...runtimeExt, "./dist/index.js"]),
    ];
  }

  if (JSON.stringify(packageJson) !== previousPackage) {
    fs.writeFileSync(adapterPackagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    actions.push("updated adapter package.json with openclaw extension metadata");
  }

  return {
    ok: true,
    adapterDir: RADIUS_OPENCLAW_ADAPTER_DIR,
    actions,
    legacyManifestPath,
    openclawManifestPath: RADIUS_OPENCLAW_PLUGIN_MANIFEST,
    adapterEntryPath,
    adapterPackagePath,
    runtimeDir: RADIUS_OPENCLAW_RUNTIME_DIR,
    runtimeModulePath: RADIUS_OPENCLAW_RUNTIME_MODULE,
    runtimeCliPath: RADIUS_OPENCLAW_RUNTIME_CLI,
  };
}

async function collectRadiusPluginState(configText = "") {
  const adapterDirExists = fs.existsSync(RADIUS_OPENCLAW_ADAPTER_DIR);
  const manifestPath = pickRadiusPluginManifestPath();
  const manifestFormat = manifestPath?.endsWith("openclaw.plugin.json")
    ? "openclaw.plugin.json"
    : manifestPath?.endsWith("plugin.json")
      ? "plugin.json"
      : null;

  let manifest = null;
  const manifestIssues = [];

  if (!adapterDirExists) {
    manifestIssues.push("adapter directory missing");
  }

  if (!manifestPath) {
    manifestIssues.push("missing plugin manifest (expected openclaw.plugin.json)");
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!manifest?.name) {
        manifestIssues.push("manifest missing name");
      }
      if (manifestFormat === "plugin.json") {
        manifestIssues.push("legacy plugin.json present; docs indicate openclaw.plugin.json for native plugins");
      }
    } catch {
      manifestIssues.push("manifest is not valid JSON");
    }
  }

  const entryCandidate = pickRadiusPluginEntryCandidate();
  if (!entryCandidate) {
    manifestIssues.push("no runtime entry candidate found (dist/index.js, index.js, src/index.ts, src/radius-wallet.ts)");
  }

  const configuredPluginLoadPaths = parseConfiguredPluginLoadPaths(configText);
  const adapterPathConfigured = configuredPluginLoadPaths.includes(RADIUS_OPENCLAW_ADAPTER_DIR);

  const runtimeReadiness = collectRadiusRuntimeReadiness();

  const pluginsListResult = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list", "--json"]));
  const pluginsListJson = tryParseTrailingJson(pluginsListResult.output || "");

  const pluginListSummary = {
    commandExitCode: pluginsListResult.code,
    parsedJson: Boolean(pluginsListJson),
    includesRadiusPluginId: false,
    enabled: false,
  };

  if (pluginsListJson) {
    const pluginRows = Array.isArray(pluginsListJson)
      ? pluginsListJson
      : Array.isArray(pluginsListJson.plugins)
        ? pluginsListJson.plugins
        : [];

    const radiusRow = pluginRows.find(
      (p) => p?.id === RADIUS_PLUGIN_ID || p?.name === RADIUS_PLUGIN_ID,
    );

    if (radiusRow) {
      pluginListSummary.includesRadiusPluginId = true;
      pluginListSummary.enabled = radiusRow.enabled === true;
    }
  }

  return {
    docsReference: {
      pluginInstall: RADIUS_PLUGIN_DOCS_URL,
      pluginAuthoring: RADIUS_BUILDING_PLUGIN_DOCS_URL,
    },
    expectedPluginId: RADIUS_PLUGIN_ID,
    expectedReadTools: RADIUS_READ_TOOL_NAMES,
    adapterDir: RADIUS_OPENCLAW_ADAPTER_DIR,
    adapterDirExists,
    manifestPath,
    manifestFormat,
    manifest,
    manifestIssues,
    entryCandidate,
    configuredPluginLoadPaths,
    adapterPathConfigured,
    pluginList: pluginListSummary,
    runtime: runtimeReadiness,
  };
}

async function collectRadiusSkillsState() {
  const discovered = discoverRadiusSkills(RADIUS_SKILLS_DIR);
  const discoveredNames = [...new Set(discovered.map((x) => x.name))];

  const getConfig = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get"]));
  const configText = getConfig.output || "";
  const configuredExtraDirs = parseConfiguredExtraDirs(configText);

  const missingRequired = RADIUS_REQUIRED_SKILLS.filter(
    (name) => !discoveredNames.includes(name),
  );

  const pluginProbe = await collectRadiusPluginState(configText);

  return {
    radiusSkillsDir: RADIUS_SKILLS_DIR,
    discoveredSkills: discovered,
    discoveredSkillNames: discoveredNames,
    discoveredSkillCount: discovered.length,
    configuredExtraDirs,
    missingRequired,
    plugin: pluginProbe,
  };
}

async function applyRadiusSkillsConfig() {
  const adapterHardening = ensureRadiusOpenClawAdapterContract();

  const state = await collectRadiusSkillsState();
  const targetExtraDirs = [...new Set([...(state.configuredExtraDirs || []), RADIUS_SKILLS_DIR])];
  const pluginLoadPathsBefore = state.plugin?.configuredPluginLoadPaths || [];
  const targetPluginLoadPaths = [...new Set([...pluginLoadPathsBefore, RADIUS_OPENCLAW_ADAPTER_DIR])];

  const setSkillsDirs = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      RADIUS_SKILL_EXTRA_DIRS_KEY,
      JSON.stringify(targetExtraDirs),
    ]),
  );

  const setPluginLoadPaths = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      RADIUS_PLUGIN_LOAD_PATHS_KEY,
      JSON.stringify(targetPluginLoadPaths),
    ]),
  );

  const enableRadiusPlugin = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      RADIUS_PLUGIN_ENABLED_KEY,
      "true",
    ]),
  );

  const pluginAfter = await collectRadiusPluginState(
    `${RADIUS_PLUGIN_LOAD_PATHS_KEY}: ${JSON.stringify(targetPluginLoadPaths)}\n${RADIUS_PLUGIN_ENABLED_KEY}: true`,
  );

  const pluginReadOpsReady =
    pluginAfter?.runtime?.cliReadOpsProbe?.ok === true &&
    pluginAfter?.pluginList?.enabled === true &&
    pluginAfter?.adapterPathConfigured === true;

  return {
    ...state,
    configuredExtraDirsBefore: state.configuredExtraDirs,
    configuredExtraDirsAfter: targetExtraDirs,
    plugin: {
      ...state.plugin,
      configuredPluginLoadPathsBefore: pluginLoadPathsBefore,
      configuredPluginLoadPathsAfter: targetPluginLoadPaths,
      adapterPathConfiguredAfter: targetPluginLoadPaths.includes(RADIUS_OPENCLAW_ADAPTER_DIR),
      pluginListAfterConfig: pluginAfter.pluginList,
      runtimeAfterConfig: pluginAfter.runtime,
      readOpsReadyAfterConfig: pluginReadOpsReady,
      adapterHardening,
    },
    configApplyResults: [
      {
        key: RADIUS_SKILL_EXTRA_DIRS_KEY,
        code: setSkillsDirs.code,
        output: setSkillsDirs.output || "",
      },
      {
        key: RADIUS_PLUGIN_LOAD_PATHS_KEY,
        code: setPluginLoadPaths.code,
        output: setPluginLoadPaths.output || "",
      },
      {
        key: RADIUS_PLUGIN_ENABLED_KEY,
        code: enableRadiusPlugin.code,
        output: enableRadiusPlugin.output || "",
      }
    ],
  };
}

async function ensureRadiusSkillsConfigured() {
  return applyRadiusSkillsConfig();
}

async function syncAllowedOrigins() {
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!publicDomain) return;

  const origin = `https://${publicDomain}`;
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "gateway.controlUi.allowedOrigins",
      JSON.stringify([origin]),
    ]),
  );
  if (result.code === 0) {
    log.info("gateway", `set allowedOrigins to [${origin}]`);
  } else {
    log.warn("gateway", `failed to set allowedOrigins (exit=${result.code})`);
  }
}

let gatewayProc = null;
let gatewayStarting = null;
let shuttingDown = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];

  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, {
          method: "GET",
        });
        if (res) {
          log.info("gateway", `ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
          const msg = err.code || err.message;
          if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
            log.warn("gateway", `health check error: ${msg}`);
          }
        }
      }
    }
    await sleep(250);
  }
  log.error("gateway", `failed to become ready after ${timeoutMs / 1000} seconds`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const radiusBootstrap = await ensureRadiusSkillsConfigured();
  log.info(
    "radius-bootstrap",
    `skills=${radiusBootstrap.discoveredSkillCount} missing=${radiusBootstrap.missingRequired.join(",") || "none"} pluginPathConfigured=${radiusBootstrap.plugin?.adapterPathConfiguredAfter === true} pluginEnabled=${radiusBootstrap.plugin?.pluginListAfterConfig?.enabled === true} readOpsReady=${radiusBootstrap.plugin?.readOpsReadyAfterConfig === true} readOpsMissing=${(radiusBootstrap.plugin?.runtimeAfterConfig?.cliReadOpsProbe?.missing || []).join(",") || "none"}`,
  );

  const stopResult = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
  log.info("gateway", `stop existing gateway exit=${stopResult.code}`);

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  const safeArgs = args.map((arg, i) =>
    args[i - 1] === "--token" ? "[REDACTED]" : arg
  );
  log.info("gateway", `starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`);
  log.info("gateway", `STATE_DIR: ${STATE_DIR}`);
  log.info("gateway", `WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  log.info("gateway", `config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    log.error("gateway", `spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    log.error("gateway", `exited code=${code} signal=${signal}`);
    gatewayProc = null;
    if (!shuttingDown && isConfigured()) {
      log.info("gateway", "scheduling auto-restart in 2s...");
      setTimeout(() => {
        if (!shuttingDown && !gatewayProc && isConfigured()) {
          ensureGatewayRunning().catch((err) => {
            log.error("gateway", `auto-restart failed: ${err.message}`);
          });
        }
      }, 2000);
    }
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await syncAllowedOrigins();
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

function isGatewayStarting() {
  return gatewayStarting !== null;
}

function isGatewayReady() {
  return gatewayProc !== null && gatewayStarting === null;
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      log.warn("gateway", `kill error: ${err.message}`);
    }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

  isRateLimited(ip) {
    const now = Date.now();
    const data = this.attempts.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.attempts.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxAttempts;
  },
};

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res.status(429).type("text/plain").send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!isValid) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/styles.css", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
});

app.get("/healthz", async (_req, res) => {
  let gateway = "unconfigured";
  if (isConfigured()) {
    gateway = isGatewayReady() ? "ready" : "starting";
  }
  res.json({ ok: true, gateway });
});

app.get("/setup/healthz", async (_req, res) => {
  const configured = isConfigured();
  const gatewayRunning = isGatewayReady();
  const starting = isGatewayStarting();
  let gatewayReachable = false;

  if (gatewayRunning) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const r = await fetch(`${GATEWAY_TARGET}/`, { signal: controller.signal });
      clearTimeout(timeout);
      gatewayReachable = r !== null;
    } catch {}
  }

  res.json({
    ok: true,
    wrapper: true,
    configured,
    gatewayRunning,
    gatewayStarting: starting,
    gatewayReachable,
  });
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version, channelsHelp } = await getOpenclawInfo();
  const radiusSkills = await collectRadiusSkillsState();

  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "API key",
      options: [
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "API key",
      options: [
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "API key",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    channelsAddHelp: channelsHelp,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
    radiusSkills,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

const VALID_AUTH_CHOICES = [
  "openai-api-key",
  "apiKey",
  "gemini-api-key",
  "openrouter-api-key",
  "ai-gateway-api-key",
  "moonshot-api-key",
  "kimi-code-api-key",
  "zai-api-key",
  "minimax-api",
  "minimax-api-lightning",
  "qwen-portal",
  "github-copilot",
  "copilot-proxy",
  "synthetic-api-key",
  "opencode-zen",
];

function validatePayload(payload) {
if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) {
    return `Invalid authChoice: ${payload.authChoice}`;
  }
  const stringFields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "model",
  ];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return `Invalid ${field}: must be a string`;
    }
  }
  return null;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const adapterHardening = ensureRadiusOpenClawAdapterContract();

    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) {
      return res.status(400).json({ ok: false, output: validationError });
    }
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    extra += `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`;

    if (adapterHardening.ok) {
      for (const action of adapterHardening.actions || []) {
        extra += `[radius-plugin] ${action}\n`;
      }
    } else {
      extra += `[radius-plugin] adapter hardening skipped: ${adapterHardening.error || "unknown error"}\n`;
    }

    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      extra += "\n[setup] Configuring gateway settings...\n";

      const radiusSkills = await ensureRadiusSkillsConfigured();
      extra += `[radius-skills] source=${radiusSkills.radiusSkillsDir}\n`;
      extra += `[radius-skills] discovered=${radiusSkills.discoveredSkillCount}\n`;
      if (radiusSkills.missingRequired.length > 0) {
        extra += `[radius-skills] missing required: ${radiusSkills.missingRequired.join(", ")}\n`;
      }
      if (radiusSkills?.plugin?.manifestIssues?.length > 0) {
        extra += `[radius-plugin] manifest issues: ${radiusSkills.plugin.manifestIssues.join("; ")}\n`;
      }
      const runtimeProbe = radiusSkills?.plugin?.runtimeAfterConfig?.cliReadOpsProbe;
      if (runtimeProbe) {
        extra += `[radius-plugin] read-op probe ok=${runtimeProbe.ok === true} exit=${runtimeProbe.code}\n`;
        if (runtimeProbe.missing?.length > 0) {
          extra += `[radius-plugin] read-op probe missing: ${runtimeProbe.missing.join(", ")}\n`;
        }
        if (runtimeProbe.error) {
          extra += `[radius-plugin] read-op probe error: ${runtimeProbe.error}\n`;
        }
      }
      for (const apply of radiusSkills.configApplyResults) {
        extra += `[radius-skills] config set ${apply.key} exit=${apply.code}\n`;
      }

      const allowInsecureResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.controlUi.allowInsecureAuth",
          "true",
        ]),
      );
      extra += `[config] gateway.controlUi.allowInsecureAuth=true exit=${allowInsecureResult.code}\n`;

      const tokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );
      extra += `[config] gateway.auth.token exit=${tokenResult.code}\n`;

      const proxiesResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          '["127.0.0.1"]',
        ]),
      );
      extra += `[config] gateway.trustedProxies exit=${proxiesResult.code}\n`;

      if (payload.model?.trim()) {
        extra += `[setup] Setting model to ${payload.model.trim()}...\n`;
        const modelResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["models", "set", payload.model.trim()]),
        );
        extra += `[models set] exit=${modelResult.code}\n${modelResult.output || ""}`;
      }

      async function configureChannel(name, cfgObj) {
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            `channels.${name}`,
            JSON.stringify(cfgObj),
          ]),
        );
        const get = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "get", `channels.${name}`]),
        );
        return (
          `\n[${name} config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
          `\n[${name} verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`
        );
      }

      if (payload.telegramToken?.trim()) {
        extra += await configureChannel("telegram", {
          enabled: true,
          dmPolicy: "pairing",
          botToken: payload.telegramToken.trim(),
          groupPolicy: "open",
          streamMode: "partial",
        });
      }

      if (payload.discordToken?.trim()) {
        extra += await configureChannel("discord", {
          enabled: true,
          token: payload.discordToken.trim(),
          groupPolicy: "open",
          dm: { policy: "pairing" },
        });
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureChannel("slack", {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        });
      }

      extra += "\n[setup] Starting gateway...\n";
      await restartGateway();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    log.error("setup", `run error: ${String(err)}`);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  const radiusSkills = await collectRadiusSkillsState();
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
    radiusSkills,
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const args = ["doctor", "--non-interactive", "--repair"];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    output: result.output,
  });
});

app.get("/setup/api/devices", requireSetupAuth, async (_req, res) => {
  const args = ["devices", "list", "--json", "--token", OPENCLAW_GATEWAY_TOKEN];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  log.info("devices", `list exit=${result.code} output=${result.output}`);
  try {
    const jsonMatch = result.output.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
    if (!jsonMatch) {
      log.warn("devices", "no JSON found in output");
      return res.json({ ok: result.code === 0, raw: result.output });
    }
    const data = JSON.parse(jsonMatch[1]);
    log.info("devices", `parsed keys=${Object.keys(data)} pending=${JSON.stringify(data.pending)} paired=${JSON.stringify(data.paired)}`);
    return res.json({ ok: true, data, raw: result.output });
  } catch (parseErr) {
    log.warn("devices", `JSON parse failed: ${parseErr.message}`);
    return res.json({ ok: result.code === 0, raw: result.output });
  }
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  const args = ["devices", "approve"];
  if (requestId) {
    args.push(String(requestId));
  } else {
    args.push("--latest");
  }
  args.push("--token", OPENCLAW_GATEWAY_TOKEN);
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

app.post("/setup/api/devices/reject", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ ok: false, error: "Missing requestId" });
  }
  const args = [
    "devices", "reject", String(requestId),
    "--token", OPENCLAW_GATEWAY_TOKEN,
  ];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

app.get("/setup/api/export", requireSetupAuth, async (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const zipName = `openclaw-export-${timestamp}.zip`;
  const tmpZip = path.join(os.tmpdir(), zipName);

  try {
    const dirsToExport = [];
    if (fs.existsSync(STATE_DIR)) dirsToExport.push(STATE_DIR);
    if (fs.existsSync(WORKSPACE_DIR)) dirsToExport.push(WORKSPACE_DIR);

    if (dirsToExport.length === 0) {
      return res.status(404).json({ ok: false, error: "No data directories found to export." });
    }

    const zipArgs = ["-r", "-P", SETUP_PASSWORD, tmpZip, ...dirsToExport];
    const result = await runCmd("zip", zipArgs);

    if (result.code !== 0 || !fs.existsSync(tmpZip)) {
      return res.status(500).json({ ok: false, error: "Failed to create export archive.", output: result.output });
    }

    const stat = fs.statSync(tmpZip);
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
      "Content-Length": String(stat.size),
    });

    const stream = fs.createReadStream(tmpZip);
    stream.pipe(res);
    stream.on("end", () => {
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
    });
    stream.on("error", (err) => {
      log.error("export", `stream error: ${err.message}`);
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Stream error during export." });
      }
    });
  } catch (err) {
    try { fs.rmSync(tmpZip, { force: true }); } catch {}
    log.error("export", `error: ${err.message}`);
    return res.status(500).json({ ok: false, error: `Export failed: ${err.message}` });
  }
});

app.get("/logs", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "logs.html"));
});

app.get("/setup/api/logs", requireSetupAuth, async (_req, res) => {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const limit = Math.min(Number.parseInt(_req.query.lines ?? "500", 10), 5000);
    return res.json({ ok: true, lines: lines.slice(-limit) });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.json({ ok: true, lines: [] });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/setup/api/logs/stream", requireSetupAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const line of logRingBuffer) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

let activeTuiSession = null;

function verifyTuiAuth(req) {
  if (!SETUP_PASSWORD) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  return crypto.timingSafeEqual(passwordHash, expectedHash);
}

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    log.info("tui", `session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      log.info("tui", `spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);

      maxSessionTimer = setTimeout(() => {
        log.info("tui", "max session duration reached");
        ws.close(4002, "Max session duration");
      }, TUI_MAX_SESSION_MS);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        log.info("tui", `PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        log.warn("tui", `invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      log.info("tui", "session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      log.error("tui", `WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  changeOrigin: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
});

proxy.on("error", (err, _req, res) => {
  log.error("proxy", String(err));
  if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
    res.writeHead(503, { "Content-Type": "text/html" });
    try {
      const html = fs.readFileSync(
        path.join(process.cwd(), "src", "public", "loading.html"),
        "utf8",
      );
      res.end(html);
    } catch {
      res.end("Gateway unavailable. Retrying...");
    }
  }
});

const PROXY_ORIGIN = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : GATEWAY_TARGET;

proxy.on("proxyReq", (proxyReq, req, res) => {
  if (!req.url?.startsWith("/hooks/")) {
    proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

app.use(async (req, res) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    if (!isGatewayReady()) {
      try {
        await ensureGatewayRunning();
      } catch {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }

      if (!isGatewayReady()) {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
    }
  }

  if (req.path === "/openclaw" && !req.query.token) {
    return res.redirect(`/openclaw?token=${OPENCLAW_GATEWAY_TOKEN}`);
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, () => {
  log.info("wrapper", `listening on port ${PORT}`);
  log.info("wrapper", `setup wizard: http://localhost:${PORT}/setup`);
  log.info("wrapper", `web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  log.info("wrapper", `configured: ${isConfigured()}`);

  if (isConfigured()) {
    (async () => {
      try {
        log.info("wrapper", "running openclaw doctor --fix...");
        const dr = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
        log.info("wrapper", `doctor --fix exit=${dr.code}`);
        if (dr.output) log.info("wrapper", dr.output);
      } catch (err) {
        log.warn("wrapper", `doctor --fix failed: ${err.message}`);
      }
      await ensureGatewayRunning();
    })().catch((err) => {
      log.error("wrapper", `failed to start gateway at boot: ${err.message}`);
    });
  }
});

const tuiWss = createTuiWebSocketServer(server);

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyTuiAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenClaw TUI\"\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch (err) {
    log.warn("websocket", `gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

async function gracefulShutdown(signal) {
  log.info("wrapper", `received ${signal}, shutting down`);
  shuttingDown = true;

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }

  if (activeTuiSession) {
    try {
      activeTuiSession.ws.close(1001, "Server shutting down");
      activeTuiSession.pty.kill();
    } catch {}
    activeTuiSession = null;
  }

  server.close();

  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gatewayProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gatewayProc && !gatewayProc.killed) {
        gatewayProc.kill("SIGKILL");
      }
    } catch (err) {
      log.warn("wrapper", `error killing gateway: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
