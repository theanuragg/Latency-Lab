#!/usr/bin/env tsx
// packages/cli/src/index.ts
// chaosctl — the operator interface for the chaos platform
//
// Design: chaosctl reads config from ~/.chaosctl/config.yaml (API endpoint + token)
// and provides a UX similar to kubectl — YAML-first, with shorthand commands for
// common operations.
//
// Example usage:
//   chaosctl apply -f experiment.yaml     # Create/update experiment
//   chaosctl get experiments              # List all
//   chaosctl get experiment my-exp        # Describe one
//   chaosctl kill-switch engage           # Engage global kill switch
//   chaosctl dry-run -f experiment.yaml   # What would this do?
//   chaosctl logs my-exp                  # Stream experiment events

import { Command } from "commander";
import * as yaml from "js-yaml";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import type { ExperimentConfig, Experiment } from "@chaos/shared-types";

// ─── Config ───────────────────────────────────────────────────────────────────

interface CliConfig {
  endpoint: string;
  token: string;
  defaultNamespace?: string;
}

function loadConfig(): CliConfig {
  const configPath = path.join(os.homedir(), ".chaosctl", "config.yaml");

  if (!fs.existsSync(configPath)) {
    // Check env vars as fallback
    if (process.env.CHAOS_ENDPOINT && process.env.CHAOS_TOKEN) {
      return {
        endpoint: process.env.CHAOS_ENDPOINT,
        token: process.env.CHAOS_TOKEN,
      };
    }
    console.error(chalk.red("No chaosctl config found. Run: chaosctl login --endpoint <url> --token <token>"));
    process.exit(1);
  }

  return yaml.load(fs.readFileSync(configPath, "utf8")) as CliConfig;
}

class ChaosClient {
  constructor(private readonly config: CliConfig) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.endpoint}/api/v1${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(`API error ${response.status}: ${JSON.stringify(error)}`);
    }

    return response.json();
  }
}

// ─── CLI definition ────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("chaosctl")
  .description("Chaos Engineering Platform CLI")
  .version("1.0.0");

// chaosctl login
program
  .command("login")
  .description("Configure chaosctl credentials")
  .requiredOption("--endpoint <url>", "Control plane URL")
  .requiredOption("--token <token>", "JWT token")
  .action(async (opts) => {
    const configDir = path.join(os.homedir(), ".chaosctl");
    fs.mkdirSync(configDir, { recursive: true });

    const config: CliConfig = { endpoint: opts.endpoint, token: opts.token };
    fs.writeFileSync(
      path.join(configDir, "config.yaml"),
      yaml.dump(config),
      { mode: 0o600 } // restrict to owner only
    );

    console.log(chalk.green("✓ Credentials saved"));

    // Test connectivity
    const client = new ChaosClient(config);
    try {
      await client.request("GET", "/health");
      console.log(chalk.green("✓ Connection successful"));
    } catch (err: any) {
      console.log(chalk.yellow(`⚠ Could not verify connection: ${err.message}`));
    }
  });

// chaosctl apply -f experiment.yaml
program
  .command("apply")
  .description("Create or update an experiment from a YAML file")
  .requiredOption("-f, --file <path>", "Path to experiment YAML")
  .option("--dry-run", "Simulate without executing")
  .action(async (opts) => {
    const config = loadConfig();
    const client = new ChaosClient(config);

    const fileContent = fs.readFileSync(opts.file, "utf8");
    const expConfig = yaml.load(fileContent) as { experiment: ExperimentConfig };

    if (!expConfig.experiment) {
      console.error(chalk.red("Invalid experiment file: must have 'experiment' key at root"));
      process.exit(1);
    }

    const spinner = ora(`${opts.dryRun ? "Simulating" : "Creating"} experiment...`).start();

    try {
      if (opts.dryRun) {
        const report = await client.request<any>("POST", "/dry-run", expConfig.experiment);
        spinner.succeed("Dry run complete");
        printDryRunReport(report);
      } else {
        const result = await client.request<any>("POST", "/experiment", expConfig.experiment);
        spinner.succeed(`Experiment created: ${result.experimentId}`);

        if (result.warnings?.length > 0) {
          for (const warning of result.warnings) {
            console.log(chalk.yellow(`⚠ ${warning}`));
          }
        }

        console.log(chalk.cyan(`\nTrack with: chaosctl get experiment ${result.experimentId}`));
      }
    } catch (err: any) {
      spinner.fail(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

// chaosctl get experiments
program
  .command("get <resource> [id]")
  .description("Get experiments or experiment details")
  .option("-n, --namespace <ns>", "Filter by namespace")
  .option("-s, --status <status>", "Filter by status")
  .option("-o, --output <format>", "Output format: table (default), json, yaml")
  .action(async (resource, id, opts) => {
    const config = loadConfig();
    const client = new ChaosClient(config);

    if (resource !== "experiments" && resource !== "experiment") {
      console.error(chalk.red(`Unknown resource: ${resource}. Try: experiments, experiment`));
      process.exit(1);
    }

    try {
      if (id) {
        const experiment = await client.request<Experiment>("GET", `/experiment/${id}`);
        printExperimentDetail(experiment, opts.output);
      } else {
        const params = new URLSearchParams();
        if (opts.namespace) params.set("namespace", opts.namespace);
        if (opts.status) params.set("status", opts.status);

        const { experiments } = await client.request<{ experiments: Experiment[] }>(
          "GET",
          `/experiments?${params}`
        );
        printExperimentTable(experiments, opts.output);
      }
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

// chaosctl kill-switch
program
  .command("kill-switch <action>")
  .description("Manage the global kill switch (engage/disengage/status)")
  .option("--reason <reason>", "Reason for engaging kill switch")
  .option("--namespace <ns>", "Scope to specific namespace")
  .action(async (action, opts) => {
    const config = loadConfig();
    const client = new ChaosClient(config);

    if (action === "status") {
      const health = await client.request<any>("GET", "/health");
      if (health.globalKillSwitchEngaged) {
        console.log(chalk.red("🔴 Global kill switch: ENGAGED"));
      } else {
        console.log(chalk.green("🟢 Global kill switch: DISENGAGED"));
      }
      console.log(`Active experiments: ${health.activeExperiments}`);
      return;
    }

    if (action !== "engage" && action !== "disengage") {
      console.error(chalk.red("Use: kill-switch engage|disengage|status"));
      process.exit(1);
    }

    if (action === "engage") {
      if (!opts.reason) {
        console.error(chalk.red("--reason is required when engaging kill switch"));
        process.exit(1);
      }

      // Confirm before engaging global kill switch
      const { confirm } = await import("@inquirer/confirm");
      const confirmed = await confirm({
        message: chalk.red(`Engage GLOBAL kill switch? This will stop ALL experiments immediately.`),
        default: false,
      });

      if (!confirmed) {
        console.log("Aborted");
        return;
      }
    }

    const spinner = ora(`${action === "engage" ? "Engaging" : "Disengaging"} kill switch...`).start();

    try {
      await client.request("POST", "/kill-switch", {
        scope: opts.namespace ? "namespace" : "global",
        namespace: opts.namespace,
        reason: opts.reason ?? "Manually disengaged",
        action,
      });

      spinner.succeed(
        action === "engage"
          ? chalk.red("Kill switch ENGAGED — all chaos halted")
          : chalk.green("Kill switch disengaged")
      );
    } catch (err: any) {
      spinner.fail(err.message);
      process.exit(1);
    }
  });

// chaosctl dry-run -f experiment.yaml
program
  .command("dry-run")
  .description("Simulate experiment execution without running it")
  .requiredOption("-f, --file <path>", "Path to experiment YAML")
  .action(async (opts) => {
    program.commands.find(c => c.name() === "apply")!.parseAsync(
      ["apply", "-f", opts.file, "--dry-run"],
      { from: "user" }
    );
  });

// chaosctl score
program
  .command("score [namespace]")
  .description("Show resilience score for a namespace")
  .action(async (namespace) => {
    const config = loadConfig();
    const client = new ChaosClient(config);

    const ns = namespace ?? config.defaultNamespace ?? "default";
    const params = new URLSearchParams({ namespace: ns, status: "completed", limit: "20" });
    const { experiments } = await client.request<{ experiments: Experiment[] }>(
      "GET", `/experiments?${params}`
    );

    if (experiments.length === 0) {
      console.log(chalk.yellow("No completed experiments found. Run some experiments first!"));
      return;
    }

    const scores = experiments
      .filter((e) => e.metrics?.chaosScore !== undefined)
      .map((e) => e.metrics!.chaosScore!);

    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const trend = scores.slice(-5);

    console.log(chalk.bold(`\nResilience Score — ${ns}`));
    console.log(`Average: ${colorScore(avgScore)} (${scores.length} experiments)`);
    console.log(`Recent trend: ${trend.map(colorScore).join(" → ")}`);
  });

// ─── Formatting helpers ────────────────────────────────────────────────────────

function printExperimentTable(experiments: Experiment[], format?: string) {
  if (format === "json") {
    console.log(JSON.stringify(experiments, null, 2));
    return;
  }

  if (format === "yaml") {
    const { dump } = require("js-yaml");
    console.log(dump(experiments));
    return;
  }

  const table = new Table({
    head: ["ID", "Name", "Type", "Status", "Score", "Started", "Duration"],
    colWidths: [38, 25, 18, 12, 8, 22, 12],
    style: { head: ["cyan"] },
  });

  for (const exp of experiments) {
    const duration =
      exp.startedAt && exp.completedAt
        ? `${Math.round((new Date(exp.completedAt).getTime() - new Date(exp.startedAt).getTime()) / 1000)}s`
        : "-";

    table.push([
      exp.id.slice(0, 36),
      exp.config.name,
      exp.config.type,
      colorStatus(exp.status),
      exp.metrics?.chaosScore !== undefined ? colorScore(exp.metrics.chaosScore) : "-",
      exp.startedAt ? new Date(exp.startedAt).toLocaleString() : "-",
      duration,
    ]);
  }

  console.log(table.toString());
}

function printExperimentDetail(exp: Experiment, format?: string) {
  if (format === "json") {
    console.log(JSON.stringify(exp, null, 2));
    return;
  }

  console.log(chalk.bold(`\nExperiment: ${exp.config.name}`));
  console.log(`  ID:      ${exp.id}`);
  console.log(`  Type:    ${exp.config.type}`);
  console.log(`  Status:  ${colorStatus(exp.status)}`);
  console.log(`  Created: ${new Date(exp.createdAt).toLocaleString()}`);

  if (exp.metrics) {
    console.log(chalk.bold("\nMetrics:"));
    console.log(`  Chaos Score:   ${colorScore(exp.metrics.chaosScore ?? 0)}/100`);
    console.log(`  Error Rate:    ${(exp.metrics.errorRateBefore! * 100).toFixed(2)}% → ${(exp.metrics.errorRateAfter! * 100).toFixed(2)}%`);
    console.log(`  p99 Latency:   ${exp.metrics.p99LatencyMsBefore}ms → ${exp.metrics.p99LatencyMsDuring}ms`);
    console.log(`  MTTR:          ${exp.metrics.mttrSeconds}s`);
  }

  if (exp.events.length > 0) {
    console.log(chalk.bold("\nEvents:"));
    for (const event of exp.events.slice(-10)) {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const icon = { info: "ℹ", warn: "⚠", error: "✗" }[event.level];
      const color = { info: chalk.blue, warn: chalk.yellow, error: chalk.red }[event.level];
      console.log(`  ${time} [${event.phase}] ${color(icon + " " + event.message)}`);
    }
  }
}

function printDryRunReport(report: any) {
  console.log(chalk.bold("\nDry Run Report"));
  console.log(`  Would target: ${report.wouldTarget.length} resource(s)`);
  console.log(`  Blast radius: ${report.wouldBlastRadius}`);
  console.log(`  Estimated impact: ${report.estimatedImpact}`);

  if (report.policyViolations.length > 0) {
    const blocks = report.policyViolations.filter((v: any) => v.severity === "block");
    const warns = report.policyViolations.filter((v: any) => v.severity === "warn");

    if (blocks.length > 0) {
      console.log(chalk.red("\n🚫 Policy blocks (experiment would be REJECTED):"));
      for (const v of blocks) {
        console.log(chalk.red(`  • ${v.rule}: ${v.reason}`));
      }
    }

    if (warns.length > 0) {
      console.log(chalk.yellow("\n⚠ Warnings:"));
      for (const v of warns) {
        console.log(chalk.yellow(`  • ${v.rule}: ${v.reason}`));
      }
    }
  } else {
    console.log(chalk.green("\n✓ All policy checks passed"));
  }

  if (report.wouldTarget.length > 0) {
    console.log(chalk.bold("\nTargets:"));
    for (const t of report.wouldTarget) {
      console.log(`  • ${t.kind}/${t.namespace ? t.namespace + "/" : ""}${t.name}`);
    }
  }
}

function colorStatus(status: string): string {
  const colors: Record<string, (s: string) => string> = {
    running: chalk.green,
    completed: chalk.cyan,
    failed: chalk.red,
    "rolled-back": chalk.yellow,
    killed: chalk.red,
    pending: chalk.gray,
  };
  return (colors[status] ?? chalk.white)(status);
}

function colorScore(score: number): string {
  if (score >= 80) return chalk.green(score.toString());
  if (score >= 60) return chalk.yellow(score.toString());
  return chalk.red(score.toString());
}

program.parse();
