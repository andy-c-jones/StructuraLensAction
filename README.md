# StructuraLens GitHub Action

> [!CAUTION]
> Use of this Action constitutes agreement to the **[Proprietary EULA](./DISCLAIMER.md)**.

Analyze C# solutions with StructuraLens and post maintainability diffs on pull requests.

This action downloads the StructuraLens CLI release from `andy-c-jones/StructuraLens`, runs analysis, and optionally comments on PRs.

## ⚖️ Licensing & Terms of Use

This project follows a hybrid licensing model.

| Component | License | Description |
| :--- | :--- | :--- |
| **GitHub Action Code** | [Apache 2.0](./LICENSE) | The YAML and scripts in this repo. You are free to fork and modify. |
| **StructuraLens Binary** | **Proprietary** | The core engine used by this Action. Use requires acceptance of a EULA to can find a copy of [in the disclaimer](./DISCLAIMER.md). |

### Important Information
* **Automatic Download:** This Action automatically fetches the latest version of the StructuraLens binary during execution.
* **Prohibitions:** You may not extract, redistribute, or reverse-engineer the CLI binary fetched by this Action.

## Inputs

- `solution` (required): Path to solution (.sln/.slnx) or project (.csproj)
- `working-directory`: Working directory for analysis (default: `.`)
- `github-token`: Token for PR comments (default: `GITHUB_TOKEN`)
- `run-diff`: Run base vs head diff on PRs (default: `true`)
- `report-html`: Generate HTML report (default: `true`)
- `report-json`: Generate JSON report (default: `true`)
- `post-comment`: Post PR comment with tables (default: `true`)
- `max-projects`: Max projects in comment table (default: `10`)
- `version`: StructuraLens release version or `latest` (default: `latest`)

## Outputs

- `base-report-json`: Path to base JSON report (PRs only)
- `head-report-json`: Path to head JSON report
- `diff-report-json`: Path to diff JSON report (PRs only)
- `diff-report-html`: Path to diff HTML report (PRs only)

## Example (Pull Requests)

```yaml
name: StructuraLens
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: andy-c-jones/StructuraLensAction@v1
        with:
          solution: StructuraLens.sln
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Example (Single Snapshot)

```yaml
name: StructuraLens Snapshot
on:
  workflow_dispatch:

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: andy-c-jones/StructuraLensAction@v1
        with:
          solution: StructuraLens.sln
          report-html: true
          report-json: true
```

## Notes

- For PR diffs, `actions/checkout` must use `fetch-depth: 0` so the base/head commits are available locally.
- On PRs, the action analyzes both base and head commits and generates a diff.
- On non-PR events, it generates a single snapshot report.
- If the PR markdown diff is too large for a GitHub comment, the action posts a compact summary and uploads the full markdown as artifact `structuralens-diff.md`.
- Posting PR comments requires `issues: write` because comments use the GitHub Issues API.
