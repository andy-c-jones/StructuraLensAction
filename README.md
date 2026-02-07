# StructuraLens GitHub Action

Analyze C# solutions and post maintainability diffs on pull requests.

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

- `base-report-json`
- `head-report-json`
- `diff-report-json`
- `diff-report-html`

## Example

```yaml
name: StructuraLens
on:
  pull_request:
    branches: [ main ]

permissions:
  contents: read
  pull-requests: write

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ./.github/actions/structuralens-action
        with:
          solution: MySolution.sln
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Notes

- On PRs, the action analyzes both base and head commits and generates a diff.
- On non-PR events, it generates a single snapshot report.
