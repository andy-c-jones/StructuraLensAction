import * as core from "@actions/core";
import * as github from "@actions/github";
import artifact from "@actions/artifact";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const COMMENT_CHAR_LIMIT = 65536;
const COMMENT_CHAR_BUFFER = 1024;
const SAFE_COMMENT_CHAR_LIMIT = COMMENT_CHAR_LIMIT - COMMENT_CHAR_BUFFER;
const SUMMARY_CHAR_LIMIT = 900000;
const DIAGNOSTICS_PER_SEVERITY_LIMIT = 5;
const STRUCTURALENS_COMMENT_MARKER = "<!-- structuralens-analysis-comment -->";
const STRUCTURALENS_COMMENT_HEADING = "## 📊 StructuraLens Analysis";

function startTimer(label) {
  const startedAt = Date.now();
  core.info(`Starting ${label}`);
  return () => {
    const elapsedMs = Date.now() - startedAt;
    core.info(`Finished ${label} in ${elapsedMs}ms`);
    return elapsedMs;
  };
}

async function retryAsync(
  fn,
  { retries = 3, delayMs = 1000, backoff = 2 } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt > retries) throw err;
      const wait = delayMs * Math.pow(backoff, attempt - 1);
      core.warning(
        `Attempt ${attempt}/${retries + 1} failed: ${err.message}. Retrying in ${wait}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
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

async function downloadCli(version, token) {
  const repo = { owner: "andy-c-jones", repo: "StructuraLens" };
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

function isMarkdownTableSeparator(line) {
  return /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}

function extractFirstMarkdownTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    const headerLine = lines[i];
    const separatorLine = lines[i + 1];
    if (!headerLine.includes("|") || !isMarkdownTableSeparator(separatorLine)) {
      continue;
    }
    let end = i + 2;
    while (end < lines.length && lines[end].includes("|")) {
      end += 1;
    }
    return lines.slice(i, end).join("\n");
  }
  return null;
}

function buildCompactComment(
  markdown,
  artifactName,
  artifactUploaded,
  htmlArtifactUrl,
) {
  let header = "";
  if (htmlArtifactUrl) {
    header = `## 📊 StructuraLens Analysis\n\n**[View Interactive HTML Report →](${htmlArtifactUrl})**\n\n`;
  }

  const banner = artifactUploaded
    ? `**StructuraLens report too large for PR comment.** Full markdown uploaded as artifact: \`${artifactName}\`.`
    : "**StructuraLens report too large for PR comment.** Full markdown could not be uploaded as an artifact.";
  const table = extractFirstMarkdownTable(markdown);
  if (!table) {
    return `${header}${banner}`;
  }
  return `${header}${banner}\n\n${table}`;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function truncateList(items, maxItems = 5) {
  const list = toArray(items);
  if (list.length <= maxItems) {
    return list.map((item) => `\`${String(item).replaceAll("`", "\\`")}\``).join(", ");
  }

  const displayed = list
    .slice(0, maxItems)
    .map((item) => `\`${String(item).replaceAll("`", "\\`")}\``)
    .join(", ");
  return `${displayed}, +${list.length - maxItems} more`;
}

function escapeCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function severityRank(severity) {
  const normalized = String(severity ?? "").toLowerCase();
  if (normalized === "error") return 0;
  if (normalized === "warning") return 1;
  if (normalized === "info") return 2;
  if (normalized === "hidden") return 3;
  return 4;
}

function normalizeSeverity(severity) {
  const normalized = String(severity ?? "").toLowerCase();
  if (normalized === "error") return "error";
  if (normalized === "warning") return "warning";
  if (normalized === "info") return "info";
  if (normalized === "hidden") return "hidden";
  return "other";
}

function severityLabel(severity) {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  if (severity === "info") return "Info";
  if (severity === "hidden") return "Hidden";
  return "Other";
}

function collectDependencyChanges(diffJson) {
  const projects = toArray(diffJson?.projects);
  const dependencyLines = [];
  let projectRefAdds = 0;
  let projectRefRemoves = 0;
  let bclAdds = 0;
  let bclRemoves = 0;
  let packageAdds = 0;
  let packageRemoves = 0;

  for (const project of projects) {
    const projectName = escapeCell(project?.name ?? "UnknownProject");
    const addedRefs = toArray(project?.addedProjectReferences);
    const removedRefs = toArray(project?.removedProjectReferences);
    const addedBcl = toArray(project?.addedBclDependencies);
    const removedBcl = toArray(project?.removedBclDependencies);
    const addedPackages = toArray(project?.addedPackageDependencies);
    const removedPackages = toArray(project?.removedPackageDependencies);
    const hasChanges =
      addedRefs.length > 0 ||
      removedRefs.length > 0 ||
      addedBcl.length > 0 ||
      removedBcl.length > 0 ||
      addedPackages.length > 0 ||
      removedPackages.length > 0;

    if (!hasChanges) {
      continue;
    }

    dependencyLines.push(`- \`${projectName}\``);
    if (addedRefs.length > 0) {
      dependencyLines.push(`  - + Project refs: ${truncateList(addedRefs)}`);
      projectRefAdds += addedRefs.length;
    }
    if (removedRefs.length > 0) {
      dependencyLines.push(`  - - Project refs: ${truncateList(removedRefs)}`);
      projectRefRemoves += removedRefs.length;
    }
    if (addedBcl.length > 0) {
      dependencyLines.push(`  - + BCL dependencies: ${truncateList(addedBcl)}`);
      bclAdds += addedBcl.length;
    }
    if (removedBcl.length > 0) {
      dependencyLines.push(`  - - BCL dependencies: ${truncateList(removedBcl)}`);
      bclRemoves += removedBcl.length;
    }
    if (addedPackages.length > 0) {
      dependencyLines.push(
        `  - + Package dependencies: ${truncateList(addedPackages)}`,
      );
      packageAdds += addedPackages.length;
    }
    if (removedPackages.length > 0) {
      dependencyLines.push(
        `  - - Package dependencies: ${truncateList(removedPackages)}`,
      );
      packageRemoves += removedPackages.length;
    }
  }

  return {
    dependencyLines,
    counts: {
      projectRefAdds,
      projectRefRemoves,
      bclAdds,
      bclRemoves,
      packageAdds,
      packageRemoves,
    },
  };
}

function buildActionableComment(diffJson, htmlArtifactUrl, workflowRunUrl) {
  const diagnostics = toArray(diffJson?.diagnostics?.addedDiagnostics)
    .sort((left, right) => {
      const severityDelta =
        severityRank(left?.severity) - severityRank(right?.severity);
      if (severityDelta !== 0) return severityDelta;
      return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
    });
  const diagnosticsTotal = diagnostics.length;
  const groupedDiagnostics = {
    error: [],
    warning: [],
    info: [],
    hidden: [],
    other: [],
  };
  for (const diagnostic of diagnostics) {
    groupedDiagnostics[normalizeSeverity(diagnostic?.severity)].push(diagnostic);
  }
  const diagnosticsRows = [];
  const truncatedBySeverity = [];
  for (const severity of ["error", "warning", "info", "hidden", "other"]) {
    const items = groupedDiagnostics[severity];
    if (items.length === 0) continue;
    diagnosticsRows.push(...items.slice(0, DIAGNOSTICS_PER_SEVERITY_LIMIT));
    if (items.length > DIAGNOSTICS_PER_SEVERITY_LIMIT) {
      truncatedBySeverity.push({
        severity,
        shown: DIAGNOSTICS_PER_SEVERITY_LIMIT,
        total: items.length,
      });
    }
  }
  const { dependencyLines, counts } = collectDependencyChanges(diffJson);
  const hasActionable = diagnosticsTotal > 0 || dependencyLines.length > 0;

  if (!hasActionable) {
    return { hasActionable: false, body: "" };
  }

  const parts = [STRUCTURALENS_COMMENT_HEADING, ""];
  if (htmlArtifactUrl) {
    parts.push(`**[View Interactive HTML Report →](${htmlArtifactUrl})**`, "");
  }
  if (workflowRunUrl) {
    parts.push(`**[View job summary in workflow run →](${workflowRunUrl})**`, "");
  }

  parts.push(
    "Action required: review dependency changes and newly introduced diagnostics.",
    "",
  );

  if (dependencyLines.length > 0) {
    parts.push(
      "### Dependency changes to review",
      "",
      `Project refs (+${counts.projectRefAdds}/-${counts.projectRefRemoves}), BCL (+${counts.bclAdds}/-${counts.bclRemoves}), packages (+${counts.packageAdds}/-${counts.packageRemoves}).`,
      "",
      ...dependencyLines,
      "",
    );
  }

  if (diagnosticsTotal > 0) {
    parts.push(
      "### Added diagnostics",
      "",
      "| Severity | Code | Description | Location | File |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const item of diagnosticsRows) {
      parts.push(
        `| ${escapeCell(item?.severity)} | ${escapeCell(item?.id)} | ${escapeCell(item?.message)} | ${item?.line ?? 0}:${item?.column ?? 0} | ${escapeCell(item?.file)} |`,
      );
    }
    if (truncatedBySeverity.length > 0) {
      parts.push(
        "",
        "_Truncated diagnostics in PR comment (5 per severity):_",
      );
      for (const truncation of truncatedBySeverity) {
        const remaining = truncation.total - truncation.shown;
        parts.push(
          `- ${severityLabel(truncation.severity)}: showing ${truncation.shown} of ${truncation.total} (${remaining} more).${workflowRunUrl ? ` See [job summary](${workflowRunUrl}).` : ""}`,
        );
      }
    }
    parts.push("");
  }

  return { hasActionable: true, body: parts.join("\n") };
}

function appendStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    core.warning("GITHUB_STEP_SUMMARY is not available; skipping job summary.");
    return;
  }

  let summary = markdown;
  if (summary.length > SUMMARY_CHAR_LIMIT) {
    summary =
      `${summary.slice(0, SUMMARY_CHAR_LIMIT)}\n\n` +
      "_Summary truncated due to GitHub job summary size limits._";
  }

  fs.appendFileSync(summaryPath, `${summary}\n`);
  core.info(`Wrote ${summary.length} chars to GITHUB_STEP_SUMMARY.`);
}

async function uploadMarkdownArtifact(filePath, artifactName) {
  const rootDirectory = path.dirname(filePath);
  const response = await artifact.uploadArtifact(
    artifactName,
    [filePath],
    rootDirectory,
  );
  return response;
}

async function uploadHtmlArtifact(filePath, artifactName) {
  const rootDirectory = path.dirname(filePath);
  const response = await artifact.uploadArtifact(
    artifactName,
    [filePath],
    rootDirectory,
  );
  return response;
}

function buildHtmlArtifactUrl(runId) {
  const { owner, repo } = github.context.repo;
  // GitHub doesn't provide direct artifact URLs, so we construct a link to the workflow run
  // Users can download the artifact from the run's artifacts section
  return `https://github.com/${owner}/${repo}/actions/runs/${runId}#artifacts`;
}

function buildWorkflowRunUrl(runId) {
  const { owner, repo } = github.context.repo;
  return `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
}

function buildManagedCommentBody(body) {
  return `${STRUCTURALENS_COMMENT_MARKER}\n${body}`;
}

function isStructuraLensComment(commentBody) {
  if (!commentBody) return false;
  return (
    commentBody.includes(STRUCTURALENS_COMMENT_MARKER) ||
    commentBody.includes(STRUCTURALENS_COMMENT_HEADING)
  );
}

async function listStructuraLensComments(client, owner, repo, issueNumber) {
  const comments = [];
  let page = 1;

  while (true) {
    const response = await client.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    });

    for (const comment of response.data) {
      if (isStructuraLensComment(comment.body)) {
        comments.push(comment);
      }
    }

    if (response.data.length < 100) {
      break;
    }
    page += 1;
  }

  return comments;
}

async function upsertStructuraLensComment(
  client,
  owner,
  repo,
  issueNumber,
  commentBody,
) {
  const matchingComments = await listStructuraLensComments(
    client,
    owner,
    repo,
    issueNumber,
  );

  if (matchingComments.length > 0) {
    const latestComment = matchingComments.reduce((latest, current) =>
      current.id > latest.id ? current : latest,
    );
    await client.rest.issues.updateComment({
      owner,
      repo,
      comment_id: latestComment.id,
      body: commentBody,
    });

    let removedDuplicates = 0;
    for (const comment of matchingComments) {
      if (comment.id === latestComment.id) continue;
      try {
        await client.rest.issues.deleteComment({
          owner,
          repo,
          comment_id: comment.id,
        });
        removedDuplicates += 1;
      } catch (deleteError) {
        core.warning(
          `Failed to delete old StructuraLens comment ${comment.id}: ${deleteError.message}`,
        );
      }
    }

    return {
      action: "updated",
      commentId: latestComment.id,
      removedDuplicates,
    };
  }

  const response = await client.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: commentBody,
  });

  return {
    action: "created",
    commentId: response.data && response.data.id ? response.data.id : "n/a",
    status: response.status,
    removedDuplicates: 0,
  };
}

async function deleteStructuraLensComments(client, owner, repo, issueNumber) {
  const matchingComments = await listStructuraLensComments(
    client,
    owner,
    repo,
    issueNumber,
  );
  let deleted = 0;
  for (const comment of matchingComments) {
    try {
      await client.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: comment.id,
      });
      deleted += 1;
    } catch (deleteError) {
      core.warning(
        `Failed to delete StructuraLens comment ${comment.id}: ${deleteError.message}`,
      );
    }
  }
  return deleted;
}

async function analyzeWithRefs(
  cliPath,
  solution,
  analysisMode,
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
    [
      "analyze",
      solution,
      "--format",
      "json",
      "--analysis-mode",
      analysisMode,
      "--out",
      baseReport,
    ],
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
    [
      "analyze",
      solution,
      "--format",
      "json",
      "--analysis-mode",
      analysisMode,
      "--out",
      headReport,
    ],
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

function resolvePrDiffBaseSha(repoRoot, baseSha, headSha) {
  const runMergeBase = () =>
    execFileSync("git", ["merge-base", baseSha, headSha], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

  try {
    const mergeBaseSha = runMergeBase();
    core.info(
      `Resolved PR merge-base ${mergeBaseSha} from base=${baseSha} and head=${headSha}`,
    );
    return mergeBaseSha;
  } catch (mergeBaseError) {
    const isShallowRepo =
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim() === "true";

    if (!isShallowRepo) {
      throw mergeBaseError;
    }

    core.warning(
      "Failed to resolve merge-base in shallow clone; fetching full history and retrying.",
    );
    execFileSync("git", ["fetch", "--no-tags", "--prune", "--unshallow"], {
      cwd: repoRoot,
      stdio: "inherit",
    });

    const mergeBaseSha = runMergeBase();
    core.info(
      `Resolved PR merge-base ${mergeBaseSha} after unshallowing repository.`,
    );
    return mergeBaseSha;
  }
}

async function main() {
  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const originalRef = getCurrentRef(repoRoot);
  const finishAction = startTimer("StructuraLens action");
  try {
    const solution = core.getInput("solution", { required: true });
    const githubToken =
      core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
    const runDiff = core.getInput("run-diff") !== "false";
    const postComment = core.getInput("post-comment") !== "false";
    const reportHtml = core.getInput("report-html") !== "false";
    const reportJson = core.getInput("report-json") !== "false";
    const maxProjects = parseInt(core.getInput("max-projects") || "10", 10);
    const version = core.getInput("version") || "latest";
    const analysisMode = core.getInput("analysis-mode") || "Full";
    const failOnRaw = (core.getInput("fail-on") || "none").trim().toLowerCase();
    const validFailOnValues = ["none", "error", "warning"];
    const failOn = validFailOnValues.includes(failOnRaw) ? failOnRaw : (() => {
      core.warning(`Invalid fail-on value "${failOnRaw}". Valid values are: none, error, warning. Defaulting to "none".`);
      return "none";
    })();
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const workingDirectory = core.getInput("working-directory") || ".";
    const workdir = path.resolve(workspace, workingDirectory);

    core.info(
      `Inputs: solution=${solution}, runDiff=${runDiff}, postComment=${postComment}, reportHtml=${reportHtml}, reportJson=${reportJson}, maxProjects=${maxProjects}, version=${version}, analysisMode=${analysisMode}, failOn=${failOn}, workdir=${workdir}`,
    );

    const finishDownload = startTimer("StructuraLens CLI download");
    const cliPath = await downloadCli(version, githubToken);
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
      const diffBaseSha = resolvePrDiffBaseSha(repoRoot, baseSha, headSha);

      const { baseReport, headReport } = await analyzeWithRefs(
        cliPath,
        solution,
        analysisMode,
        diffBaseSha,
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

      let htmlArtifactUrl = null;
      const workflowRunUrl = buildWorkflowRunUrl(github.context.runId);
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

        try {
          const htmlArtifactName = "structuralens-diff-report.html";
          const upload = await uploadHtmlArtifact(diffHtmlPath, htmlArtifactName);
          core.info(
            `Uploaded HTML artifact ${htmlArtifactName} (${upload.size} bytes).`,
          );
          htmlArtifactUrl = buildHtmlArtifactUrl(github.context.runId);
        } catch (uploadError) {
          core.warning(`Failed to upload HTML artifact: ${uploadError.message}`);
        }
      }

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

      const fullDiffMarkdown = fs.readFileSync(markdownPath, "utf8");
      const summaryParts = ["## 📊 StructuraLens Analysis", ""];
      if (htmlArtifactUrl) {
        summaryParts.push(`**[View Interactive HTML Report →](${htmlArtifactUrl})**`, "");
      }
      summaryParts.push(fullDiffMarkdown);
      appendStepSummary(summaryParts.join("\n"));

      let diffJson = null;
      try {
        diffJson = JSON.parse(fs.readFileSync(diffReportPath, "utf8"));
      } catch (parseError) {
        core.warning(`Failed to parse diff JSON for actionable PR comment: ${parseError.message}`);
      }

      if (postComment) {
        let commentPosted = false;
        const actionable = buildActionableComment(
          diffJson,
          htmlArtifactUrl,
          workflowRunUrl,
        );
        if (!githubToken) {
          core.warning("GitHub token not provided. Skipping PR comment.");
        } else {
          const client = github.getOctokit(githubToken);
          if (!actionable.hasActionable) {
            const deleted = await retryAsync(
              () =>
                deleteStructuraLensComments(
                  client,
                  github.context.repo.owner,
                  github.context.repo.repo,
                  pr.number,
                ),
              { retries: 3, delayMs: 1000, backoff: 2 },
            );
            core.info(
              deleted > 0
                ? `No actionable items; removed ${deleted} prior StructuraLens comment(s).`
                : "No actionable items; no StructuraLens PR comment posted.",
            );
          } else {
            let commentBody = actionable.body;
            let actionableCommentPath = path.join(
              workdir,
              ".structuralens",
              "actionable-comment.md",
            );
            fs.writeFileSync(actionableCommentPath, commentBody, "utf8");

            if (commentBody.length > SAFE_COMMENT_CHAR_LIMIT) {
              core.warning(
                `Actionable comment exceeds ${SAFE_COMMENT_CHAR_LIMIT} chars; posting compact summary instead.`,
              );
              const artifactName = "structuralens-actionable-comment.md";
              let artifactUploaded = false;
              try {
                const upload = await uploadMarkdownArtifact(
                  actionableCommentPath,
                  artifactName,
                );
                core.info(
                  `Uploaded markdown artifact ${artifactName} (${upload.size} bytes).`,
                );
                artifactUploaded = true;
              } catch (uploadError) {
                core.warning(
                  `Failed to upload markdown artifact: ${uploadError.message}`,
                );
              }
              commentBody = buildCompactComment(
                commentBody,
                artifactName,
                artifactUploaded,
                htmlArtifactUrl,
              );
            }

            commentBody = buildManagedCommentBody(commentBody);
            const finishComment = startTimer("PR comment post");
            try {
              const result = await retryAsync(
                () =>
                  upsertStructuraLensComment(
                    client,
                    github.context.repo.owner,
                    github.context.repo.repo,
                    pr.number,
                    commentBody,
                  ),
                { retries: 3, delayMs: 1000, backoff: 2 },
              );
              if (result) {
                core.info(
                  result.action === "created"
                    ? `PR comment posted (status ${result.status}, id ${result.commentId}).`
                    : `PR comment updated (id ${result.commentId}).`,
                );
                if (result.removedDuplicates > 0) {
                  core.info(
                    `Removed ${result.removedDuplicates} older StructuraLens comment(s).`,
                  );
                }
                commentPosted = true;
              }
            } catch (commentError) {
              core.warning(
                `Failed to post PR comment after retries: ${commentError.message}`,
              );
            }
            finishComment();

            if (!commentPosted) {
              try {
                const upload = await uploadMarkdownArtifact(
                  actionableCommentPath,
                  "structuralens-pr-comment.md",
                );
                core.info(
                  `PR comment not posted; uploaded as artifact structuralens-pr-comment.md (${upload.size} bytes).`,
                );
              } catch (uploadError) {
                core.warning(
                  `Failed to upload PR comment as artifact: ${uploadError.message}`,
                );
              }
            }
          }
        }
      }

      // Fail the check if new diagnostics were introduced (checked after comment so feedback is always visible)
      if (failOn !== "none") {
        if (!diffReportPath || !fs.existsSync(diffReportPath)) {
          core.warning(
            `fail-on is set to "${failOn}" but diff report JSON was not found; skipping gate.`,
          );
        } else {
          try {
            const diffJson = JSON.parse(fs.readFileSync(diffReportPath, "utf8"));
            const newErrors = diffJson.diagnostics?.newErrors ?? 0;
            const newWarnings = diffJson.diagnostics?.newWarnings ?? 0;

            if (failOn === "error" && newErrors > 0) {
              core.setFailed(
                `StructuraLens: ${newErrors} new error(s) introduced. Fix the errors or set fail-on to "none" to suppress.`,
              );
            } else if (failOn === "warning" && (newErrors > 0 || newWarnings > 0)) {
              const parts = [];
              if (newErrors > 0) parts.push(`${newErrors} error(s)`);
              if (newWarnings > 0) parts.push(`${newWarnings} warning(s)`);
              core.setFailed(
                `StructuraLens: new diagnostics introduced: ${parts.join(", ")}. Fix the diagnostics or set fail-on to "none" to suppress.`,
              );
            }
          } catch (parseError) {
            core.warning(
              `fail-on is set to "${failOn}" but diff report JSON could not be parsed: ${parseError.message}`,
            );
          }
        }
      }

      finishDiffFlow();
    } else {
      const finishAnalyzeFlow = startTimer("non-PR analyze flow");
      const summaryPath = path.join(workdir, "structuralens-summary.md");
      if (reportJson) {
        const jsonPath = path.join(workdir, "structuralens-report.json");
        const finishJsonReport = startTimer("JSON report");
        runCli(
          cliPath,
          [
            "analyze",
            solution,
            "--format",
            "json",
            "--analysis-mode",
            analysisMode,
            "--out",
            jsonPath,
          ],
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
          [
            "analyze",
            solution,
            "--format",
            "html",
            "--analysis-mode",
            analysisMode,
            "--out",
            htmlPath,
          ],
          workdir,
        );
        finishHtmlReport();
        diffHtmlPath = htmlPath;
      }

      const finishSummaryReport = startTimer("Summary report");
      runCli(
        cliPath,
        [
          "analyze",
          solution,
          "--format",
          "summary",
          "--analysis-mode",
          analysisMode,
          "--out",
          summaryPath,
        ],
        workdir,
      );
      finishSummaryReport();

      let htmlArtifactUrl = null;
      if (diffHtmlPath) {
        try {
          const htmlArtifactName = "structuralens-report.html";
          const upload = await uploadHtmlArtifact(diffHtmlPath, htmlArtifactName);
          core.info(
            `Uploaded HTML artifact ${htmlArtifactName} (${upload.size} bytes).`,
          );
          htmlArtifactUrl = buildHtmlArtifactUrl(github.context.runId);
        } catch (uploadError) {
          core.warning(`Failed to upload HTML artifact: ${uploadError.message}`);
        }
      }

      const summaryBody = fs.existsSync(summaryPath)
        ? fs.readFileSync(summaryPath, "utf8")
        : "StructuraLens summary output was not generated.";
      const summaryParts = ["## 📊 StructuraLens Analysis", ""];
      if (htmlArtifactUrl) {
        summaryParts.push(`**[View Interactive HTML Report →](${htmlArtifactUrl})**`, "");
      }
      summaryParts.push(summaryBody);
      appendStepSummary(summaryParts.join("\n"));

      finishAnalyzeFlow();
      if (failOn !== "none") {
        core.warning(
          `fail-on is set to "${failOn}" but this is not a pull request diff run; skipping gate.`,
        );
      }
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
