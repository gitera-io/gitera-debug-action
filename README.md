# gitera-io/gitera-debug-action

Pause a failed GitHub Actions job for up to 15 minutes and debug it from a terminal in the Gitera dashboard.

## Usage

```yaml
permissions:
  contents: read
  id-token: write # lets the runner prove its repo, run and branch to Gitera

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test

      # Pause on failure, or when armed from Gitera / `/gitera debug`
      - uses: gitera-io/gitera-debug-action@v1
        if: ${{ !cancelled() && (failure() || github.run_attempt > 1) }}
        with:
          mode: ${{ job.status == 'failure' && 'failure' || 'armed' }}
          secrets: ${{ toJSON(secrets) }}
```

## How it works

- The runner only makes outbound HTTPS calls to Gitera. No ports, no third-party tunnel.
- It identifies itself with the job's GitHub OIDC token. No Gitera secret is stored in the repo.
- Gitera checks the org's `block-interactive-debug` policy. Sessions on `main`, `master`, `release/*` and `release/**` are refused by default.
- Only repo write collaborators and the PR author can join, after signing in to Gitera.
- Output and fix diffs are masked for every value passed in `secrets`, including base64 and URL-encoded forms.
- **Generate Fix Diff** returns `git diff HEAD` plus untracked files. Nothing is committed or pushed.
- The step always exits 0, so it never changes the job result.

## Requirements

- Linux or macOS runner with `node`, `git` and `python3` (all preinstalled on GitHub-hosted runners). `python3` runs the terminal and lets it follow your browser window size.
- macOS needs `python3`. On Linux without `python3`, util-linux `script` is used instead, at a fixed terminal size.
- Windows runners are skipped.
