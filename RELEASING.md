# Release Flow

This repository uses GitHub Actions workflows to release each implementation.
Releases are triggered manually via `workflow_dispatch`.

## Workflows

| File | Purpose |
|------|---------|
| `release-python.yml` | Release Python packages (LangChain backend, core libraries) to PyPI + Docker |
| `release-ballerina.yml` | Release Ballerina interpreter to Docker |
| `release-docker.yml` | Shared: build, push, and scan Docker images |
| `release-finalize.yml` | Shared: create tag, release branch, and GitHub Release |

---

## LangChain / Python Packages

The Python interpreter workspace contains independently versioned packages
released via `release-python.yml`:

| Package | What it releases | Docker image |
|---------|-----------------|--------------|
| `afm-core` | `afm-core` + `afm-cli` to PyPI | — |
| `afm-langchain` | `afm-langchain` to PyPI | `ghcr.io/wso2/afm-langchain-interpreter` |

### Workflow Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `package` | choice | yes | — | `afm-core` or `afm-langchain` |
| `branch` | string | no | `main` | Branch to release from |

### Release Steps

**Trigger:** Run `release-python.yml` → select `package` and `branch`.

What happens:

1. Reads version from `python-interpreter/packages/<package>/pyproject.toml`
2. Validates tag and release branch don't already exist
3. Runs tests (`pytest packages/afm-core/tests/ packages/afm-langchain/tests/`)
4. Builds and publishes to PyPI:
   - `afm-core` → publishes `afm-core` then `afm-cli`
   - `afm-langchain` → publishes `afm-langchain`
5. If `afm-langchain`: builds and pushes Docker image to
   `ghcr.io/wso2/afm-langchain-interpreter:v<version>`
6. Creates tag `<package>-v<version>` (e.g., `afm-core-v0.1.0`)
7. Creates release branch and GitHub Release
8. Bumps package version to next patch:
   - `afm-core` → bumps both `afm-core` and `afm-cli`
   - `afm-langchain` → bumps only `afm-langchain`

> **Note:** The `:latest` Docker tag is only updated when releasing from `main` or `dev`.

---

## Ballerina

Released via `release-ballerina.yml`.

- **Docker:** `ghcr.io/wso2/afm-ballerina-interpreter`

### Workflow Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `branch` | string | no | `main` | Branch to release from |

### Normal Release

**Example:** releasing `0.1.0` from `main`.

**Before:** `Ballerina.toml` version = `0.1.0`

**Trigger:** Run `release-ballerina.yml` → select `branch`.

What happens:

1. Reads version from `Ballerina.toml`
2. Validates tag and release branch don't already exist
3. Runs `bal build` and `bal test`
4. Builds and pushes Docker image to
   `ghcr.io/wso2/afm-ballerina-interpreter:v0.1.0` and `:latest`
5. Creates tag `ballerina-interpreter-v0.1.0`
6. Creates release branch and GitHub Release
7. Bumps `Ballerina.toml` version to `0.1.1`

> **Note:** The `:latest` Docker tag is only updated when releasing from `main` or `dev`.

**After:**
- `main` branch: `Ballerina.toml` version = `0.1.1`
- Branch: `release-ballerina-interpreter-0.1.0`
- Tag: `ballerina-interpreter-v0.1.0`
- Docker: `ghcr.io/wso2/afm-ballerina-interpreter:v0.1.0`

### Patch Release

**Scenario:** `main` is at `0.2.1`, need to patch `0.1.x`.

**Manual prep:**

```bash
git checkout -b ballerina-interpreter-v0.1.x ballerina-interpreter-v0.1.0
# Ballerina.toml version = 0.1.0 (from tag)
# Edit Ballerina.toml version to 0.1.1
sed -i 's/^version = ".*"/version = "0.1.1"/' ballerina-interpreter/Ballerina.toml
git add .
git commit -m "Bump version"
git push origin ballerina-interpreter-v0.1.x
```

**Trigger:** Run `release-ballerina.yml` workflow with:
- branch: `ballerina-interpreter-v0.1.x`

**What happens:**
1. Creates branch `release-ballerina-interpreter-0.1.1`
2. Builds, tags `ballerina-interpreter-v0.1.1`
3. On `ballerina-interpreter-v0.1.x`: bumps to `0.1.2`

---

## Summary

| Action | Workflow | Publishes to | Docker image | Bumps version |
|--------|----------|-------------|--------------|---------------|
| Release `afm-core` | `release-python.yml` | PyPI (`afm-core` + `afm-cli`) | — | Yes |
| Release `afm-langchain` | `release-python.yml` | PyPI (`afm-langchain`) | `afm-langchain-interpreter` | Yes |
| Release Ballerina | `release-ballerina.yml` | — | `afm-ballerina-interpreter` | Yes |
| Patch release | Same as above (from patch branch) | Same as above | Same as above | Yes |
