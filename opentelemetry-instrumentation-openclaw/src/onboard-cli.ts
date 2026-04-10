#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import { Command } from "commander";
import inquirer from "inquirer";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PLUGIN_VERSION } from "./version.js";

const PLUGIN_NAME = "openclaw-cms-plugin";
const PACKAGE_PATH = "@openclaw/cms-plugin";

function getOpenClawDir(): string {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

function getConfigPath(): string {
  return path.join(getOpenClawDir(), "openclaw.json");
}

function getExtensionsDir(): string {
  return path.join(getOpenClawDir(), "extensions");
}

async function readConfig(): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    return JSON.parse(raw);
  } catch (error: any) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeConfig(config: Record<string, any>): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function getPlatformCommand(command: string): string {
  if (
    process.platform === "win32" &&
    (command === "openclaw" || command === "npm")
  ) {
    return `${command}.cmd`;
  }
  return command;
}

function runCommand(command: string): void {
  execSync(command, { stdio: "inherit" });
}

function runCommandQuiet(command: string): string {
  return execSync(command, { encoding: "utf8" }).trim();
}

interface ArmsPluginConfig {
  endpoint: string;
  headers: {
    "x-arms-license-key"?: string;
    "x-arms-project"?: string;
    "x-cms-workspace"?: string;
  };
  serviceName: string;
}

async function collectPluginConfig(): Promise<ArmsPluginConfig> {
  const config = await readConfig();
  const existingEntry = config.plugins?.entries?.[PLUGIN_NAME];
  const existingConfig = existingEntry?.config || {};

  const answers = await inquirer.prompt([
    {
      name: "endpoint",
      type: "input",
      message:
        "请输入 ARMS OTLP Endpoint URL\n(例: https://proj-xtrace-xxx.log.aliyuncs.com/apm/trace/opentelemetry):",
      default: existingConfig.endpoint || undefined,
      validate: (input: string) => {
        if (input?.trim()) return true;
        return "Endpoint 不能为空";
      },
    },
    {
      name: "licenseKey",
      type: "password",
      message:
        "请输入 ARMS License Key (x-arms-license-key)\n(可在 CMS2.0 控制台 → 接入中心获取，可选):",
      mask: "*",
    },
    {
      name: "armsProject",
      type: "input",
      message: "请输入 ARMS Project (x-arms-project，可选):",
      default: existingConfig.headers?.["x-arms-project"] || undefined,
    },
    {
      name: "cmsWorkspace",
      type: "input",
      message: "请输入 CMS Workspace (x-cms-workspace，可选):",
      default: existingConfig.headers?.["x-cms-workspace"] || undefined,
    },
    {
      name: "serviceName",
      type: "input",
      message: "请输入服务名称 (serviceName):",
      default: existingConfig.serviceName || "openclaw-agent",
    },
  ]);

  const endpoint = answers.endpoint.trim();
  const licenseKey =
    answers.licenseKey?.trim() ||
    existingConfig.headers?.["x-arms-license-key"] ||
    "";
  const armsProject =
    answers.armsProject?.trim() ||
    existingConfig.headers?.["x-arms-project"] ||
    "";
  const cmsWorkspace =
    answers.cmsWorkspace?.trim() ||
    existingConfig.headers?.["x-cms-workspace"] ||
    "";
  const serviceName = answers.serviceName?.trim() || "openclaw-agent";

  if (!endpoint) {
    throw new Error("缺少必要配置: endpoint");
  }

  const headers: ArmsPluginConfig["headers"] = {};
  if (licenseKey) headers["x-arms-license-key"] = licenseKey;
  if (armsProject) headers["x-arms-project"] = armsProject;
  if (cmsWorkspace) headers["x-cms-workspace"] = cmsWorkspace;

  return {
    endpoint,
    headers,
    serviceName,
  };
}

async function updateOpenClawConfig(
  pluginConfig: ArmsPluginConfig,
): Promise<void> {
  const config = await readConfig();
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.allow) config.plugins.allow = [];
  if (!config.plugins.allow.includes(PLUGIN_NAME)) {
    config.plugins.allow.push(PLUGIN_NAME);
  }
  if (!config.plugins.entries) config.plugins.entries = {};
  if (!config.plugins.entries[PLUGIN_NAME]) {
    config.plugins.entries[PLUGIN_NAME] = { enabled: true };
  }

  const entry = config.plugins.entries[PLUGIN_NAME];
  entry.enabled = true;
  const existing =
    entry.config && typeof entry.config === "object" ? entry.config : {};
  entry.config = {
    ...existing,
    endpoint: pluginConfig.endpoint,
    headers: pluginConfig.headers,
    serviceName: pluginConfig.serviceName,
  };

  await writeConfig(config);
}

async function clearPluginConfig(): Promise<void> {
  const config = await readConfig();
  if (!config.plugins) return;
  if (config.plugins.entries?.[PLUGIN_NAME]) {
    delete config.plugins.entries[PLUGIN_NAME];
  }
  if (config.plugins.allow) {
    config.plugins.allow = config.plugins.allow.filter(
      (name: string) => name !== PLUGIN_NAME,
    );
  }
  await writeConfig(config);
}

async function clearInstalledPlugin(): Promise<void> {
  const config = await readConfig();
  const installPath = config.installs?.[PLUGIN_NAME]?.installPath;
  if (installPath) {
    await fs.rm(installPath, { recursive: true, force: true });
    return;
  }
  const fallbackPath = path.join(getExtensionsDir(), PLUGIN_NAME);
  await fs.rm(fallbackPath, { recursive: true, force: true });
}

function resolveLocalPluginDir(): string {
  // When running via `node dist/onboard-cli.js`, __dirname points to dist/
  const distDir = new URL(".", import.meta.url).pathname;
  return path.resolve(distDir, "..");
}

async function installPlugin(): Promise<void> {
  const openclawCmd = getPlatformCommand("openclaw");
  try {
    runCommandQuiet(`${openclawCmd} --version`);
  } catch {
    throw new Error("未检测到 OpenClaw CLI，请先安装 openclaw");
  }

  // Try npm registry first; fall back to local symlink if the package is not published
  try {
    runCommand(`${openclawCmd} plugins install ${PACKAGE_PATH}`);
  } catch {
    console.log("npm 包未发布，使用本地安装模式...");
    await installPluginLocal();
  }
}

async function installPluginLocal(): Promise<void> {
  const localDir = resolveLocalPluginDir();
  const config = await readConfig();

  // Register via plugins.load.paths so OpenClaw discovers the plugin
  // from its original directory (avoids symlink issues with Dirent.isDirectory)
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.load) config.plugins.load = {};
  if (!Array.isArray(config.plugins.load.paths)) config.plugins.load.paths = [];

  if (!config.plugins.load.paths.includes(localDir)) {
    config.plugins.load.paths.push(localDir);
  }
  await writeConfig(config);
  console.log(`已注册本地插件路径: ${localDir}`);
}

async function restartGateway(): Promise<void> {
  const openclawCmd = getPlatformCommand("openclaw");
  try {
    runCommand(`${openclawCmd} gateway restart`);
  } catch {
    console.log("网关重启失败，可稍后手动执行 openclaw gateway restart");
  }
}

async function handleInstall(): Promise<void> {
  console.log("\n🔧 OpenClaw CMS Plugin 插件安装向导\n");
  const pluginConfig = await collectPluginConfig();
  await clearPluginConfig();
  await clearInstalledPlugin();
  await installPlugin();
  await updateOpenClawConfig(pluginConfig);
  await restartGateway();
  console.log("\n✅ 安装完成，openclaw-cms-plugin 已启用");
  console.log(
    `   Endpoint: ${pluginConfig.endpoint}`,
  );
  console.log(
    `   Service:  ${pluginConfig.serviceName}`,
  );
}

async function handleConfigOnly(): Promise<void> {
  console.log("\n🔧 OpenClaw CMS Plugin 配置更新\n");
  const pluginConfig = await collectPluginConfig();
  await updateOpenClawConfig(pluginConfig);
  console.log("\n✅ 配置已更新");
  console.log("   如需生效请执行: openclaw gateway restart");
}

const program = new Command();
program
  .name("openclaw-cms-plugin-onboard-cli")
  .version(PLUGIN_VERSION)
  .description("一键安装 / 配置 OpenClaw CMS Trace 插件");

program
  .command("install", { isDefault: true })
  .description("一键安装 openclaw-cms-plugin 插件并配置 CMS 连接")
  .action(async () => {
    try {
      await handleInstall();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`\n❌ 安装失败: ${message}`);
      process.exit(1);
    }
  });

program
  .command("config")
  .description("仅更新 CMS 配置（不重新安装插件）")
  .action(async () => {
    try {
      await handleConfigOnly();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`\n❌ 配置失败: ${message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
