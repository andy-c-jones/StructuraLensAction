const core = require("@actions/core");
const github = require("@actions/github");
const io = require("@actions/io");
const tc = require("@actions/tool-cache");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function getPlatformAsset(version) {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "linux") {
    if (arch === "arm64") return `structuralens-linux-arm64-${version}.tar.gz`;
    return `structuralens-linux-x64-${version}.tar.gz`;
  }

  if (platform === "darwin") {
    if (arch === "arm64") return `structuralens-macos-arm64-${version}.tar.gz`;
    throw new Error(`Unsupported macOS architecture: ${arch}`);
  }

  if (platform === "win32") {
    return `structuralens-windows-x64-${version}.zip`;
  }

  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

async function downloadCli(version) {
  const repo = { owner: "andy-c-jones", repo: "StructuraLens" };
  const token = core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
  const client = github.getOctokit(token);

  let resolvedVersion = version;
  if (version === "latest") {
    const latest = await client.rest.repos.getLatestRelease(repo);
    resolvedVersion = latest.data.tag_name.replace(/^v/, "");
  }

  const assetName = getPlatformAsset(resolvedVersion);
  core.info(`Downloading StructuraLens v${resolvedVersion} asset ${assetName}`);
  const release = await client.rest.repos.getReleaseByTag({
    ...repo,
    tag: `v${resolvedVersion}`,
  });

  const asset = release.data.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`Release asset not found: ${assetName}`);
  }

  const response = await client.rest.repos.getReleaseAsset({
    ...repo,
    asset_id: asset.id,
    headers: {
      accept: "application/octet-stream",
    },
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "structuralens-"));
  const archivePath = path.join(tempDir, assetName);
  const data = response.data;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeFileSync(archivePath, buffer);

  let extractedPath;
  if (assetName.endsWith(".zip")) {
    extractedPath = await tc.extractZip(archivePath);
  } else {
    extractedPath = await tc.extractTar(archivePath);
  }

  const cliName =
    os.platform() === "win32" ? "StructuraLens.Cli.exe" : "StructuraLens.Cli";
  const cliPath = path.join(extractedPath, cliName);
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI not found after extraction: ${cliPath}`);
  }

  return cliPath;
}

function runCli(cliPath, args, cwd) {
  core.info(`Running: ${cliPath} ${args.join(" ")}`);
  execFileSync(cliPath, args, { stdio: "inherit", cwd });
}

async function analyzeWithRefs(
  cliPath,
  solution,
  baseSha,
  headSha,
  workspace,
  repoRoot,
) {
  const baseDir = path.join(workspace, ".structuralens", "base");
  const headDir = path.join(workspace, ".structuralens", "head");

  await io.mkdirP(baseDir);
  await io.mkdirP(headDir);

  core.info(`Checking out base ref ${baseSha}`);
  execFileSync("git", ["checkout", "--force", baseSha], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  const baseReport = path.join(baseDir, "report-base.json");
  runCli(
    cliPath,
    ["analyze", solution, "--format", "json", "--out", baseReport],
    workspace,
  );

  core.info(`Checking out head ref ${headSha}`);
  execFileSync("git", ["checkout", "--force", headSha], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  const headReport = path.join(headDir, "report-head.json");
  runCli(
    cliPath,
    ["analyze", solution, "--format", "json", "--out", headReport],
    workspace,
  );

  return { baseReport, headReport };
}

function getCurrentRef(repoRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

async function main() {
  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const originalRef = getCurrentRef(repoRoot);
  try {
    const solution = core.getInput("solution", { required: true });
    const runDiff = core.getInput("run-diff") !== "false";
    const postComment = core.getInput("post-comment") !== "false";
    const reportHtml = core.getInput("report-html") !== "false";
    const reportJson = core.getInput("report-json") !== "false";
    const maxProjects = parseInt(core.getInput("max-projects") || "10", 10);
    const version = core.getInput("version") || "latest";
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const workingDirectory = core.getInput("working-directory") || ".";
    const workdir = path.resolve(workspace, workingDirectory);

    const cliPath = await downloadCli(version);
    if (os.platform() !== "win32") {
      fs.chmodSync(cliPath, 0o755);
    }

    const eventName = github.context.eventName;
    const isPullRequest =
      eventName === "pull_request" || eventName === "pull_request_target";

    let baseReportPath = null;
    let headReportPath = null;
    let diffReportPath = null;
    let diffHtmlPath = null;

    if (isPullRequest && runDiff) {
      const pr = github.context.payload.pull_request;
      if (!pr) {
        throw new Error("Pull request payload not found.");
      }

      const baseSha = pr.base.sha;
      const headSha = pr.head.sha;

      const { baseReport, headReport } = await analyzeWithRefs(
        cliPath,
        solution,
        baseSha,
        headSha,
        workdir,
        repoRoot,
      );
      baseReportPath = baseReport;
      headReportPath = headReport;

      diffReportPath = path.join(workdir, ".structuralens", "diff.json");
      runCli(
        cliPath,
        [
          "diff",
          "--base",
          baseReportPath,
          "--head",
          headReportPath,
          "--format",
          "json",
          "--out",
          diffReportPath,
        ],
        workdir,
      );

      if (reportHtml) {
        diffHtmlPath = path.join(workdir, ".structuralens", "diff.html");
        runCli(
          cliPath,
          [
            "diff",
            "--base",
            baseReportPath,
            "--head",
            headReportPath,
            "--format",
            "html",
            "--out",
            diffHtmlPath,
          ],
          workdir,
        );
      }

      if (postComment) {
        const markdownPath = path.join(workdir, ".structuralens", "diff.md");
        runCli(
          cliPath,
          [
            "diff",
            "--base",
            baseReportPath,
            "--head",
            headReportPath,
            "--format",
            "markdown",
            "--out",
            markdownPath,
            "--max-projects",
            String(maxProjects),
          ],
          workdir,
        );

        const body = fs.readFileSync(markdownPath, "utf8");
        const token =
          core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
        if (!token) {
          core.warning("GitHub token not provided. Skipping PR comment.");
        } else {
          const client = github.getOctokit(token);
          await client.rest.issues.createComment({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: pr.number,
            body,
          });
        }
      }
    } else {
      if (reportJson) {
        const jsonPath = path.join(workdir, "structuralens-report.json");
        runCli(
          cliPath,
          ["analyze", solution, "--format", "json", "--out", jsonPath],
          workdir,
        );
        headReportPath = jsonPath;
      }
      if (reportHtml) {
        const htmlPath = path.join(workdir, "structuralens-report.html");
        runCli(
          cliPath,
          ["analyze", solution, "--format", "html", "--out", htmlPath],
          workdir,
        );
        diffHtmlPath = htmlPath;
      }
    }

    if (baseReportPath) core.setOutput("base-report-json", baseReportPath);
    if (headReportPath) core.setOutput("head-report-json", headReportPath);
    if (diffReportPath) core.setOutput("diff-report-json", diffReportPath);
    if (diffHtmlPath) core.setOutput("diff-report-html", diffHtmlPath);
  } catch (error) {
    core.setFailed(error.message);
  } finally {
    try {
      execFileSync("git", ["checkout", "--force", originalRef], {
        stdio: "inherit",
        cwd: repoRoot,
      });
    } catch (restoreError) {
      core.warning(`Failed to restore original ref: ${restoreError.message}`);
    }
  }
}

main();
