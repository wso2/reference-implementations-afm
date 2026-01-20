# Release Flow

## Normal Release (e.g., 0.3.0 from main)

**Before:**
- `main` branch: VERSION = `0.3.0-SNAPSHOT`

**Trigger:** Run `release.yml` workflow with:
- implementation: `ballerina-interpreter`
- branch: `main`

**What happens:**
1. Validates VERSION is in `X.Y.Z-SNAPSHOT` format
2. Checks tag and release branch don't already exist
3. Runs `bal build` and `bal test`
4. Creates branch `release-ballerina-interpreter-0.3.0` from main
5. Sets VERSION = `0.3.0`, commits "Release ballerina-interpreter v0.3.0"
6. Builds and pushes Docker image to `ghcr.io/{owner}/afm-ballerina-interpreter:v0.3.0` and `:latest`
7. Creates tag `ballerina-interpreter-v0.3.0`
8. Pushes release branch and tag
9. On `main`: bumps VERSION to `0.3.1-SNAPSHOT`, commits, pushes
10. Creates GitHub Release with auto-generated notes

**Note:** `:latest` Docker tag is only updated when releasing from `main` branch (not for patch releases).

**After:**
- `main` branch: VERSION = `0.3.1-SNAPSHOT`
- `release-ballerina-interpreter-0.3.0` branch: VERSION = `0.3.0`
- Tag: `ballerina-interpreter-v0.3.0`
- Docker: `ghcr.io/{owner}/afm-ballerina-interpreter:v0.3.0`

---

## Patch Release (e.g., 0.3.1 after 0.4.0 exists)

**Scenario:** main is at `0.4.1-SNAPSHOT`, need to patch 0.3.x

**Manual prep:**
```bash
git checkout -b ballerina-interpreter-v0.3.x ballerina-interpreter-v0.3.0
# VERSION = 0.3.0 (from tag)
# Edit VERSION to 0.3.1-SNAPSHOT
echo "0.3.1-SNAPSHOT" > ballerina-interpreter/VERSION
git add .
git commit -m "Bump version"
git push origin ballerina-interpreter-v0.3.x
```

**Trigger:** Run `release.yml` workflow with:
- implementation: `ballerina-interpreter`
- branch: `ballerina-interpreter-v0.3.x`

**What happens:**
1. Creates branch `release-ballerina-interpreter-0.3.1`
2. Sets VERSION = `0.3.1`, commits, builds, tags
3. On `ballerina-interpreter-v0.3.x`: bumps to `0.3.2-SNAPSHOT`

---

## Re-release (e.g., redo 0.3.0)

**Restricted to:** Users listed in `.github/CODEOWNERS`

**Trigger:** Run `re-release.yml` workflow with:
- implementation: `ballerina-interpreter`
- version: `0.3.0`
- branch: `main` (or whichever branch has the fix)
- confirm: `RE-RELEASE`

**What happens:**
1. Verifies user is in CODEOWNERS
2. Validates version format (`X.Y.Z`)
3. Deletes existing tag, release branch, and GitHub Release
4. Runs `bal build` and `bal test`
5. Creates new release branch `release-ballerina-interpreter-0.3.0`
6. Sets VERSION = `0.3.0`, commits, builds, pushes Docker (overwrites)
7. Creates new tag and GitHub Release
8. Does NOT bump version on source branch (already bumped from original release)

**Note:** `:latest` Docker tag is only updated when re-releasing from `main` branch.

---

## Summary

| Action | Workflow | Who | Bumps Version? |
|--------|----------|-----|----------------|
| New release | `release.yml` | Anyone | Yes |
| Patch release | `release.yml` (from patch branch) | Anyone | Yes |
| Re-release | `re-release.yml` | CODEOWNERS only | No |
