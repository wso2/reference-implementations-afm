# Release Flow

## Normal Release (e.g., 0.1.0 from main)

**Before:**
- `main` branch: `Ballerina.toml` version = `0.1.0`

**Trigger:** Run `release.yml` workflow with:
- implementation: `ballerina-interpreter`
- branch: `main`

**What happens:**
1. Validates version in `Ballerina.toml` is in `X.Y.Z` format
2. Checks tag and release branch don't already exist
3. Runs `bal build` and `bal test`
4. Creates branch `release-ballerina-interpreter-0.1.0` from main
5. Builds and pushes Docker image to `ghcr.io/{owner}/afm-ballerina-interpreter:v0.1.0` and `:latest`
6. Creates tag `ballerina-interpreter-v0.1.0`
7. Pushes release branch and tag
8. On `main`: bumps `Ballerina.toml` version to `0.1.1`, commits, pushes
9. Creates GitHub Release with auto-generated notes

**Note:** `:latest` Docker tag is only updated when releasing from `main` or `dev` branch.

**After:**
- `main` branch: `Ballerina.toml` version = `0.1.1`
- `release-ballerina-interpreter-0.1.0` branch exists
- Tag: `ballerina-interpreter-v0.1.0`
- Docker: `ghcr.io/{owner}/afm-ballerina-interpreter:v0.1.0`

---

## Patch Release (e.g., 0.1.1 after 0.2.0 exists)

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

## Summary

| Action | Workflow | Who | Bumps Version? |
|--------|----------|-----|----------------|
| New release | `release.yml` | Anyone | Yes |
| Patch release | `release.yml` (from patch branch) | Anyone | Yes |
| Re-release | `re-release.yml` | CODEOWNERS only | No |
