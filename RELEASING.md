# Release Flow

This repository has two separate release workflows:

- **`release-python.yml`** — for the `python-interpreter` (Python, multi-package)
- **`release.yml`** — for the `ballerina-interpreter` (and future non-Python implementations)

Both workflows call `release-finalize.yml` to create tags, release branches, and GitHub Releases.

---

## Langchain Interpreter (Python)

The python-interpreter workspace contains independently versioned packages:
- **`afm-core`** — released together with `afm-cli`
- **`afm-langchain`** — released independently

### Normal Release

**Trigger:** Run `release-python.yml` with:
- package: `afm-core` or `afm-langchain`
- branch: `main`

**What happens:**
1. Reads version from `python-interpreter/packages/<package>/pyproject.toml`
2. Validates tag and release branch don't exist
3. Runs tests (`pytest packages/afm-core/tests/ packages/afm-langchain/tests/`)
4. Builds and publishes to PyPI:
   - `afm-core`: publishes `afm-core` then `afm-cli`
   - `afm-langchain`: publishes `afm-langchain`
5. If `afm-langchain`: builds/pushes Docker image to `ghcr.io/{owner}/afm-langchain-interpreter:v<version>`
6. Creates tag `<package>-v<version>` (e.g., `afm-core-v0.1.0`)
7. Creates release branch and GitHub Release
8. Bumps package version to next patch:
   - `afm-core`: bumps both `afm-core` and `afm-cli`
   - `afm-langchain`: bumps only `afm-langchain`

**Note:** `:latest` Docker tag is only updated when releasing from `main` or `dev`.

---

## Ballerina Interpreter

### Normal Release (e.g., 0.1.0 from main)

**Before:**
- `main` branch: `Ballerina.toml` version = `0.1.0`

**Trigger:** Run `release.yml` workflow with:
- implementation: `ballerina-interpreter`
- branch: `main`

**What happens:**
1. Reads version from `Ballerina.toml`
2. Validates tag and release branch don't exist
3. Runs `bal build` and `bal test`
4. Builds and pushes Docker image to `ghcr.io/{owner}/afm-ballerina-interpreter:v0.1.0` and `:latest`
5. Creates tag `ballerina-interpreter-v0.1.0`
6. Creates release branch and GitHub Release
7. Bumps `Ballerina.toml` version to `0.1.1`

**Note:** `:latest` Docker tag is only updated when releasing from `main` or `dev`.

**After:**
- `main` branch: `Ballerina.toml` version = `0.1.1`
- `release-ballerina-interpreter-0.1.0` branch exists
- Tag: `ballerina-interpreter-v0.1.0`
- Docker: `ghcr.io/{owner}/afm-ballerina-interpreter:v0.1.0`

---

### Patch Release (e.g., 0.1.1 after 0.2.0 exists)

**Scenario:** main is at `0.2.1`, need to patch 0.1.x

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

**Trigger:** Run `release.yml` workflow with:
- implementation: `ballerina-interpreter`
- branch: `ballerina-interpreter-v0.1.x`

**What happens:**
1. Creates branch `release-ballerina-interpreter-0.1.1`
2. Builds, tags `ballerina-interpreter-v0.1.1`
3. On `ballerina-interpreter-v0.1.x`: bumps to `0.1.2`

---

## Re-release (e.g., redo 0.1.0)

**Restricted to:** Users listed in `.github/CODEOWNERS`

**Trigger:** Run `re-release.yml` workflow with:
- implementation: `ballerina-interpreter`
- version: `0.1.0`
- branch: `main` (or whichever branch has the fix)
- confirm: `RE-RELEASE`

**What happens:**
1. Verifies user is in CODEOWNERS
2. Validates version format (`X.Y.Z`)
3. Deletes existing tag, release branch, and GitHub Release
4. Runs `bal build` and `bal test`
5. Creates new release branch `release-ballerina-interpreter-0.1.0`
6. Builds and pushes Docker (overwrites)
7. Creates new tag and GitHub Release
8. Does NOT bump version on source branch (already bumped from original release)

**Note:** `:latest` Docker tag is only updated when re-releasing from `main` or `dev` branch.

---

## Workflow Files

| File | Purpose |
|------|---------|
| `release-python.yml` | Dispatch: python-interpreter releases (PyPI + Docker + tag) |
| `release-common.yml` | Dispatch: ballerina-interpreter releases (Docker + tag) |
| `release-finalize.yml` | Shared: create tag, release branch, and GitHub Release |
| `re-release.yml` | Dispatch: re-release an existing version (CODEOWNERS only) |

## Summary

| Action | Workflow | Implementations | Bumps Version? |
|--------|----------|-----------------|----------------|
| New release (Python) | `release-python.yml` | python-interpreter | Yes |
| New release (generic) | `release-common.yml` | ballerina-interpreter | Yes |
| Patch release | Same as above (from patch branch) | Any | Yes |
| Re-release | `re-release.yml` | Any | No |
