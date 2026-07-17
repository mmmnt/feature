// Feat VS Code extension: spawns `feat watch --json` per workspace folder with a
// feat.config.json and paints its NDJSON run events as diagnostics IN THE SPEC —
// a failing prediction squiggles the `scenario "<name>"` line of the .feat file,
// not the generated test. Zero configuration: the local @mmmnt/feature install
// is resolved from the project; nothing else to set up.

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

interface RunEvent {
  event: string;
  exitCode?: number;
  suites?: { spec: string; output: string }[];
  cases?: { suite: string; name: string; state: string; message?: string }[];
  message?: string;
  reason?: string;
}

let child: ChildProcess | null = null;
let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;

function findScenarioRange(specPath: string, caseName: string): vscode.Range {
  try {
    const lines = readFileSync(specPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*scenario(\s+outline)?\s+"/.test(line) && line.includes(`"${caseName.split(" [")[0]}"`)) {
        return new vscode.Range(i, 0, i, line.length);
      }
    }
  } catch {
    // fall through to file-level anchor
  }
  return new vscode.Range(0, 0, 0, 1);
}

function handleEvent(root: string, ev: RunEvent) {
  if (ev.event !== "run" || !ev.suites) return;
  const failing = (ev.cases ?? []).filter((c) => c.state === "failed");
  for (const suite of ev.suites) {
    const specAbs = path.resolve(root, suite.spec);
    const uri = vscode.Uri.file(specAbs);
    const specDiags: vscode.Diagnostic[] = [];
    for (const c of failing) {
      const range = findScenarioRange(specAbs, c.name);
      const message = c.message
        ? c.message.split("\n").slice(0, 6).join("\n")
        : `prediction violated in "${c.name}"`;
      const d = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
      d.source = "feat";
      specDiags.push(d);
    }
    diagnostics.set(uri, specDiags);
  }
  const failed = failing.length;
  status.text = failed === 0 ? "$(check) feat: green" : `$(error) feat: ${failed} violation${failed === 1 ? "" : "s"}`;
  status.backgroundColor = failed === 0 ? undefined : new vscode.ThemeColor("statusBarItem.errorBackground");
}

function start(root: string, output: vscode.OutputChannel) {
  if (child) return;
  status.text = "$(sync~spin) feat: starting";
  status.show();
  child = spawn("npx", ["feat", "watch", "--json"], { cwd: root, env: process.env });
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("{")) continue;
      try {
        handleEvent(root, JSON.parse(line) as RunEvent);
      } catch {
        output.appendLine(`unparseable event: ${line.slice(0, 200)}`);
      }
    }
  });
  child.stderr!.on("data", (c: Buffer) => output.append(c.toString()));
  child.on("exit", (code) => {
    output.appendLine(`feat watch exited (${code})`);
    status.text = "$(circle-slash) feat: stopped";
    child = null;
  });
}

function stop() {
  child?.kill();
  child = null;
  diagnostics.clear();
  status.text = "$(circle-slash) feat: stopped";
}

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection("feat");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "feat.watch.start";
  const output = vscode.window.createOutputChannel("Feat");
  context.subscriptions.push(diagnostics, status, output);

  const root = (vscode.workspace.workspaceFolders ?? [])
    .map((f) => f.uri.fsPath)
    .find((p) => existsSync(path.join(p, "feat.config.json")));

  context.subscriptions.push(
    vscode.commands.registerCommand("feat.watch.start", () => root && start(root, output)),
    vscode.commands.registerCommand("feat.watch.stop", () => stop()),
    { dispose: stop },
  );

  const autoStart = vscode.workspace.getConfiguration("feat").get<boolean>("watch.autoStart", true);
  if (root && autoStart) start(root, output);
}

export function deactivate() {
  stop();
}
