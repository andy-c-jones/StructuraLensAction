const core = require("@actions/core");
const github = require("@actions/github");
const io = require("@actions/io");
const tc = require("@actions/tool-cache");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function startTimer(label) {
  const startedAt = Date.now();
  core.info(`Starting ${label}`);
  return () => {
    const elapsedMs = Date.now() - startedAt;
    core.info(`Finished ${label} in ${elapsedMs}ms`);
    return elapsedMs;
  };
}

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
    core.info("Resolving latest StructuraLens release");
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
    core.info("Extracting ZIP asset");
    extractedPath = await tc.extractZip(archivePath);
  } else {
    core.info("Extracting TAR asset");
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
  const finishAnalyze = startTimer("base/head analysis");
  const baseDir = path.join(workspace, ".structuralens", "base");
  const headDir = path.join(workspace, ".structuralens", "head");

  core.info("Preparing analysis directories");
  await io.mkdirP(baseDir);
  await io.mkdirP(headDir);

  core.info(`Checking out base ref ${baseSha}`);
  execFileSync("git", ["checkout", "--force", baseSha], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  const baseReport = path.join(baseDir, "report-base.json");
  const finishBaseAnalyze = startTimer("base ref analyze");
  runCli(
    cliPath,
    ["analyze", solution, "--format", "json", "--out", baseReport],
    workspace,
  );
  finishBaseAnalyze();

  core.info(`Checking out head ref ${headSha}`);
  execFileSync("git", ["checkout", "--force", headSha], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  const headReport = path.join(headDir, "report-head.json");
  const finishHeadAnalyze = startTimer("head ref analyze");
  runCli(
    cliPath,
    ["analyze", solution, "--format", "json", "--out", headReport],
    workspace,
  );
  finishHeadAnalyze();

  finishAnalyze();
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
  const finishAction = startTimer("StructuraLens action");
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

    core.info(
      `Inputs: solution=${solution}, runDiff=${runDiff}, postComment=${postComment}, reportHtml=${reportHtml}, reportJson=${reportJson}, maxProjects=${maxProjects}, version=${version}, workdir=${workdir}`,
    );

    const finishDownload = startTimer("StructuraLens CLI download");
    const cliPath = await downloadCli(version);
    finishDownload();
    if (os.platform() !== "win32") {
      fs.chmodSync(cliPath, 0o755);
    }
    core.info(`CLI ready at ${cliPath}`);

    const eventName = github.context.eventName;
    const isPullRequest =
      eventName === "pull_request" || eventName === "pull_request_target";

    let baseReportPath = null;
    let headReportPath = null;
    let diffReportPath = null;
    let diffHtmlPath = null;

    if (isPullRequest && runDiff) {
      const finishDiffFlow = startTimer("pull request diff flow");
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
      const finishJsonDiff = startTimer("JSON diff report");
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
      finishJsonDiff();

      if (reportHtml) {
        diffHtmlPath = path.join(workdir, ".structuralens", "diff.html");
        const finishHtmlDiff = startTimer("HTML diff report");
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
        finishHtmlDiff();
      }

      if (postComment) {
        const markdownPath = path.join(workdir, ".structuralens", "diff.md");
        const finishMarkdownDiff = startTimer("Markdown diff report");
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
        finishMarkdownDiff();

        const body = fs.readFileSync(markdownPath, "utf8");
        const token =
          core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
        if (!token) {
          core.warning("GitHub token not provided. Skipping PR comment.");
        } else {
          const finishComment = startTimer("PR comment post");
          const client = github.getOctokit(token);
          await client.rest.issues.createComment({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: pr.number,
            body,
          });
          finishComment();
        }
      }
      finishDiffFlow();
    } else {
      const finishAnalyzeFlow = startTimer("non-PR analyze flow");
      if (reportJson) {
        const jsonPath = path.join(workdir, "structuralens-report.json");
        const finishJsonReport = startTimer("JSON report");
        runCli(
          cliPath,
          ["analyze", solution, "--format", "json", "--out", jsonPath],
          workdir,
        );
        finishJsonReport();
        headReportPath = jsonPath;
      }
      if (reportHtml) {
        const htmlPath = path.join(workdir, "structuralens-report.html");
        const finishHtmlReport = startTimer("HTML report");
        runCli(
          cliPath,
          ["analyze", solution, "--format", "html", "--out", htmlPath],
          workdir,
        );
        finishHtmlReport();
        diffHtmlPath = htmlPath;
      }
      finishAnalyzeFlow();
    }

    const finishOutputs = startTimer("set outputs");
    if (baseReportPath) core.setOutput("base-report-json", baseReportPath);
    if (headReportPath) core.setOutput("head-report-json", headReportPath);
    if (diffReportPath) core.setOutput("diff-report-json", diffReportPath);
    if (diffHtmlPath) core.setOutput("diff-report-html", diffHtmlPath);
    finishOutputs();
    finishAction();
  } catch (error) {
    core.setFailed(error.message);
  } finally {
    try {
      const finishRestore = startTimer(`restore original ref ${originalRef}`);
      execFileSync("git", ["checkout", "--force", originalRef], {
        stdio: "inherit",
        cwd: repoRoot,
      });
      finishRestore();
    } catch (restoreError) {
      core.warning(`Failed to restore original ref: ${restoreError.message}`);
    }
  }
}

main();
