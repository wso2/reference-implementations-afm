// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import ballerina/file;
import ballerina/test;

// ============================================
// parseSkillMdContent — pure function tests
// ============================================

@test:Config
function testParseSkillMdContentValid() returns error? {
    string content = string `---
name: lint-fix
description: Auto-fix linting errors across the project
---

Run the configured linter and apply safe auto-fixes.`;
    SkillInfo info = check parseSkillMdContent(content, "/base/path", ["references/doc.md"]);
    test:assertEquals(info.name, "lint-fix");
    test:assertEquals(info.description, "Auto-fix linting errors across the project");
    test:assertEquals(info.body, "Run the configured linter and apply safe auto-fixes.");
    test:assertEquals(info.basePath, "/base/path");
    test:assertEquals(info.resources, ["references/doc.md"]);
}

@test:Config
function testParseSkillMdContentMissingFrontmatterOpener() {
    string content = "No frontmatter here\nJust text.";
    SkillInfo|error result = parseSkillMdContent(content, "/base", []);
    if result is SkillInfo {
        test:assertFail("Expected error for missing frontmatter");
    }
    test:assertTrue(result.message().includes("must start with YAML frontmatter"));
}

@test:Config
function testParseSkillMdContentUnclosedFrontmatter() {
    string content = string `---
name: deploy-check
description: Validate deployment readiness`;
    SkillInfo|error result = parseSkillMdContent(content, "/base", []);
    if result is SkillInfo {
        test:assertFail("Expected error for unclosed frontmatter");
    }
    test:assertTrue(result.message().includes("not closed"));
}

@test:Config
function testParseSkillMdContentEmptyName() {
    string content = string `---
name: ""
description: Scaffold REST endpoints from OpenAPI specs
---

Body.`;
    SkillInfo|error result = parseSkillMdContent(content, "/base", []);
    if result is SkillInfo {
        test:assertFail("Expected error for empty name");
    }
    test:assertTrue(result.message().includes("'name' field is required"));
}

@test:Config
function testParseSkillMdContentEmptyDescription() {
    string content = string `---
name: api-scaffold
description: ""
---

Body.`;
    SkillInfo|error result = parseSkillMdContent(content, "/base", []);
    if result is SkillInfo {
        test:assertFail("Expected error for empty description");
    }
    test:assertTrue(result.message().includes("'description' field is required"));
}

@test:Config
function testParseSkillMdContentBodyWithResources() returns error? {
    string content = string `---
name: db-migrate
description: Generate and validate database migration scripts
---

Read the schema diff and produce migration SQL.`;
    string[] resources = ["references/README.md", "assets/config.json"];
    SkillInfo info = check parseSkillMdContent(content, "/skills/db-migrate", resources);
    test:assertEquals(info.resources, resources);
    test:assertEquals(info.body, "Read the schema diff and produce migration SQL.");
}

// ============================================
// buildSkillCatalog — pure function tests
// ============================================

@test:Config
function testBuildSkillCatalogEmpty() {
    map<SkillInfo> skills = {};
    string? catalog = buildSkillCatalog(skills);
    test:assertTrue(catalog is ());
}

@test:Config
function testBuildSkillCatalogSingleSkill() {
    map<SkillInfo> skills = {
        "commit-msg": {
            name: "commit-msg",
            description: "Draft conventional commit messages from staged diffs",
            body: "",
            basePath: "",
            resources: []
        }
    };
    string? catalog = buildSkillCatalog(skills);
    if catalog is () {
        test:assertFail("Expected non-nil catalog");
    }
    test:assertTrue(catalog.includes("commit-msg"));
    test:assertTrue(catalog.includes("Draft conventional commit messages from staged diffs"));
    test:assertTrue(catalog.includes("Available Skills"));
}

@test:Config
function testBuildSkillCatalogMultipleSkills() {
    map<SkillInfo> skills = {
        "changelog": {
            name: "changelog",
            description: "Generate changelog entries from merged PRs",
            body: "",
            basePath: "",
            resources: []
        },
        "dep-audit": {
            name: "dep-audit",
            description: "Audit dependencies for known vulnerabilities",
            body: "",
            basePath: "",
            resources: []
        }
    };
    string? catalog = buildSkillCatalog(skills);
    if catalog is () {
        test:assertFail("Expected non-nil catalog");
    }
    test:assertTrue(catalog.includes("changelog"));
    test:assertTrue(catalog.includes("dep-audit"));
    test:assertTrue(catalog.includes("Generate changelog entries from merged PRs"));
    test:assertTrue(catalog.includes("Audit dependencies for known vulnerabilities"));
}

// ============================================
// SkillsToolKit class tests
// ============================================

@test:Config
function testActivateSkillFound() returns error? {
    map<SkillInfo> skills = {
        "doc-gen": {
            name: "doc-gen",
            description: "Generate API documentation from source annotations",
            body: "Scan exported symbols and produce Markdown API docs.",
            basePath: "/skills/doc-gen",
            resources: []
        }
    };
    SkillsToolKit toolkit = new (skills);
    string result = check toolkit.activateSkill("doc-gen");
    test:assertTrue(result.includes("Scan exported symbols and produce Markdown API docs."));
    test:assertTrue(result.includes("doc-gen"));
}

@test:Config
function testActivateSkillFoundWithResources() returns error? {
    map<SkillInfo> skills = {
        "perf-profile": {
            name: "perf-profile",
            description: "Profile hot paths and suggest optimizations",
            body: "Instrument the critical path and collect flame-graph data.",
            basePath: "/skills/perf-profile",
            resources: ["references/guide.md", "assets/schema.json"]
        }
    };
    SkillsToolKit toolkit = new (skills);
    string result = check toolkit.activateSkill("perf-profile");
    test:assertTrue(result.includes("Instrument the critical path and collect flame-graph data."));
    test:assertTrue(result.includes("skill_resources"));
    test:assertTrue(result.includes("references/guide.md"));
    test:assertTrue(result.includes("assets/schema.json"));
    test:assertTrue(result.includes("readSkillResource"));
}

@test:Config
function testActivateSkillNotFound() {
    map<SkillInfo> skills = {
        "format-sql": {
            name: "format-sql",
            description: "Format SQL queries to follow team style guide",
            body: "Parse and reformat SQL using the project conventions.",
            basePath: "/skills/format-sql",
            resources: []
        }
    };
    SkillsToolKit toolkit = new (skills);
    string|error result = toolkit.activateSkill("nonexistent");
    if result is string {
        test:assertFail("Expected error for nonexistent skill");
    }
    test:assertTrue(result.message().includes("not found"));
    test:assertTrue(result.message().includes("format-sql"));
}

@test:Config
function testReadSkillResourceInvalidSkillName() {
    map<SkillInfo> skills = {};
    SkillsToolKit toolkit = new (skills);
    string|error result = toolkit.readSkillResource("unknown", "references/file.md");
    if result is string {
        test:assertFail("Expected error for unknown skill");
    }
    test:assertTrue(result.message().includes("not found"));
}

@test:Config
function testReadSkillResourceInvalidPathPrefix() {
    map<SkillInfo> skills = {
        "env-check": {
            name: "env-check",
            description: "Validate environment variables before deploy",
            body: "Check required env vars.",
            basePath: "/skills/env-check",
            resources: ["references/env-spec.md"]
        }
    };
    SkillsToolKit toolkit = new (skills);
    string|error result = toolkit.readSkillResource("env-check", "other/file.txt");
    if result is string {
        test:assertFail("Expected error for invalid path prefix");
    }
    test:assertTrue(result.message().includes("must start with"));
}

@test:Config
function testReadSkillResourcePathTraversal() {
    map<SkillInfo> skills = {
        "env-check": {
            name: "env-check",
            description: "Validate environment variables before deploy",
            body: "Check required env vars.",
            basePath: "/skills/env-check",
            resources: ["references/env-spec.md"]
        }
    };
    SkillsToolKit toolkit = new (skills);
    string|error result = toolkit.readSkillResource("env-check", "references/../../../etc/passwd");
    if result is string {
        test:assertFail("Expected error for path traversal");
    }
    test:assertTrue(result.message().includes("traversal"));
}

@test:Config
function testReadSkillResourceNotListed() {
    map<SkillInfo> skills = {
        "env-check": {
            name: "env-check",
            description: "Validate environment variables before deploy",
            body: "Check required env vars.",
            basePath: "/skills/env-check",
            resources: ["references/env-spec.md"]
        }
    };
    SkillsToolKit toolkit = new (skills);
    string|error result = toolkit.readSkillResource("env-check", "references/other.md");
    if result is string {
        test:assertFail("Expected error for unlisted resource");
    }
    test:assertTrue(result.message().includes("not found in skill"));
}

// ============================================
// Filesystem-dependent tests (using fixtures)
// ============================================

@test:Config
function testDiscoverLocalSkillsSingleSkillDir() returns error? {
    string absPath = check file:getAbsolutePath("tests/skills/single_skill");
    map<SkillInfo> skills = check discoverLocalSkills(absPath);
    test:assertEquals(skills.length(), 1);
    test:assertTrue(skills.hasKey("test-gen"));
    SkillInfo info = skills.get("test-gen");
    test:assertEquals(info.description, "Generate and run unit tests for code changes");
    test:assertTrue(info.body.includes("body of the test skill"));
}

@test:Config
function testDiscoverLocalSkillsMultiSkillDir() returns error? {
    string absPath = check file:getAbsolutePath("tests/skills/multi_skills");
    map<SkillInfo> skills = check discoverLocalSkills(absPath);
    test:assertEquals(skills.length(), 2);
    test:assertTrue(skills.hasKey("pr-summary"));
    test:assertTrue(skills.hasKey("security-review"));
}

@test:Config
function testDiscoverLocalSkillsInvalidSkill() returns error? {
    string absPath = check file:getAbsolutePath("tests/skills/invalid_skill");
    map<SkillInfo>|error result = discoverLocalSkills(absPath);
    // The skill has empty name, so parseSkillMdContent returns error.
    // Since it's a direct SKILL.md (not subdirectory), the error propagates.
    test:assertTrue(result is error);
}

@test:Config
function testDiscoverSkillsAbsolutePathAccepted() returns error? {
    string absPath = check file:getAbsolutePath("tests/skills/single_skill");
    SkillSource[] sources = [{path: absPath}];
    map<SkillInfo> skills = check discoverSkills(sources, "some/other/dir");
    test:assertEquals(skills.length(), 1);
    test:assertTrue(skills.hasKey("test-gen"));
}

@test:Config
function testDiscoverSkillsMultipleSources() returns error? {
    string testDir = check file:getAbsolutePath("tests/skills");
    SkillSource[] sources = [
        {path: "single_skill"},
        {path: "multi_skills"}
    ];
    map<SkillInfo> skills = check discoverSkills(sources, testDir);
    test:assertEquals(skills.length(), 3);
    test:assertTrue(skills.hasKey("test-gen"));
    test:assertTrue(skills.hasKey("pr-summary"));
    test:assertTrue(skills.hasKey("security-review"));
}

@test:Config
function testParseSkillMdValidFile() returns error? {
    string absPath = check file:getAbsolutePath("tests/skills/single_skill");
    string skillMdPath = check file:joinPath(absPath, "SKILL.md");
    SkillInfo info = check parseSkillMd(skillMdPath, absPath);
    test:assertEquals(info.name, "test-gen");
    test:assertEquals(info.description, "Generate and run unit tests for code changes");
    test:assertTrue(info.body.includes("body of the test skill"));
}

@test:Config
function testListLocalResourcesWithReferencesAndAssets() returns error? {
    string absPath = check file:getAbsolutePath("tests/skills/multi_skills/security_review");
    string[] resources = listLocalResources(absPath);
    test:assertEquals(resources.length(), 2);
    // Check that both references and assets are found
    boolean hasReference = false;
    boolean hasAsset = false;
    foreach string res in resources {
        if res.includes("references/") && res.includes("REFERENCE.md") {
            hasReference = true;
        }
        if res.includes("assets/") && res.includes("template.json") {
            hasAsset = true;
        }
    }
    test:assertTrue(hasReference, "Should find references/REFERENCE.md");
    test:assertTrue(hasAsset, "Should find assets/template.json");
}

@test:Config
function testListLocalResourcesNoResources() returns error? {
    string absPath = check file:getAbsolutePath("tests/skills/single_skill");
    string[] resources = listLocalResources(absPath);
    test:assertEquals(resources.length(), 0);
}

@test:Config
function testExtractSkillCatalogNullSkills() returns error? {
    AgentMetadata metadata = {};
    string|[string, SkillsToolKit]|error? result = extractSkillCatalog(metadata, ".");
    test:assertTrue(result is ());
}

@test:Config
function testExtractSkillCatalogEmptySkillsArray() returns error? {
    AgentMetadata metadata = {skills: []};
    string|[string, SkillsToolKit]|error? result = extractSkillCatalog(metadata, ".");
    test:assertTrue(result is ());
}

// ============================================
// Progressive disclosure E2E test
// ============================================
// Walks the full chain using real fixtures:
//   discover → catalog (names only) → activate (body revealed) → read resource (content revealed)

@test:Config
function testProgressiveDisclosureEndToEnd() returns error? {
    string testDir = check file:getAbsolutePath("tests/skills");

    // Step 1: Discover skills from multi_skills fixture (has resources on security_review)
    map<SkillInfo> skills = check discoverLocalSkills(
            check file:joinPath(testDir, "multi_skills"));
    test:assertEquals(skills.length(), 2);

    // Step 2: Build catalog — should contain ONLY names and descriptions, NOT bodies
    string? catalog = buildSkillCatalog(skills);
    if catalog is () {
        test:assertFail("Catalog should be non-nil for discovered skills");
    }

    // Catalog MUST include names and descriptions
    test:assertTrue(catalog.includes("pr-summary"));
    test:assertTrue(catalog.includes("Summarize pull requests"));
    test:assertTrue(catalog.includes("security-review"));
    test:assertTrue(catalog.includes("Review code for security vulnerabilities"));

    // Catalog MUST NOT include skill bodies (progressive disclosure)
    test:assertFalse(catalog.includes("Summarize each merged pull request"),
            "Catalog must not leak pr-summary body");
    test:assertFalse(catalog.includes("Perform a security-focused code review"),
            "Catalog must not leak security-review body");

    // Step 3: Activate skill — body is now revealed
    SkillsToolKit toolkit = new (skills);
    string activateResult = check toolkit.activateSkill("security-review");

    // Activation MUST include the full body
    test:assertTrue(activateResult.includes("Perform a security-focused code review"),
            "activateSkill must return the skill body");

    // Activation MUST list available resources
    test:assertTrue(activateResult.includes("skill_resources"),
            "activateSkill must include skill_resources section");
    test:assertTrue(activateResult.includes("references/REFERENCE.md"));
    test:assertTrue(activateResult.includes("assets/template.json"));

    // Step 4: Read a resource — file content is now revealed
    string refContent = check toolkit.readSkillResource("security-review", "references/REFERENCE.md");
    test:assertTrue(refContent.includes("OWASP Top 10 Quick Reference"),
            "readSkillResource must return actual file content");
    test:assertTrue(refContent.includes("reference file for security-review"));

    string assetContent = check toolkit.readSkillResource("security-review", "assets/template.json");
    test:assertTrue(assetContent.includes("security-review"),
            "readSkillResource must return asset file content");

    // Step 5: Verify non-resource skill has no resources disclosed
    string alphaResult = check toolkit.activateSkill("pr-summary");
    test:assertTrue(alphaResult.includes("Summarize each merged pull request"));
    test:assertFalse(alphaResult.includes("skill_resources"),
            "pr-summary has no resources, so no skill_resources section");
}

@test:Config
function testProgressiveDisclosureViaExtractSkillCatalog() returns error? {
    string testDir = check file:getAbsolutePath("tests/skills");
    AgentMetadata metadata = {
        skills: [
            {path: "single_skill"},
            {path: "multi_skills"}
        ]
    };

    // extractSkillCatalog returns [catalog, toolkit] — same entry point used by createAgent
    var result = check extractSkillCatalog(metadata, testDir);
    if result is () {
        test:assertFail("Should return catalog and toolkit for valid skills");
    }
    var [catalogStr, toolkit] = result;

    // Catalog has all 3 skills' names
    test:assertTrue(catalogStr.includes("test-gen"));
    test:assertTrue(catalogStr.includes("pr-summary"));
    test:assertTrue(catalogStr.includes("security-review"));

    // Catalog does NOT have any body content
    test:assertFalse(catalogStr.includes("body of the test skill"),
            "Catalog must not contain test-gen body");
    test:assertFalse(catalogStr.includes("Summarize each merged pull request"),
            "Catalog must not contain pr-summary body");
    test:assertFalse(catalogStr.includes("Perform a security-focused code review"),
            "Catalog must not contain security-review body");

    // Activating reveals the body
    string body = check toolkit.activateSkill("test-gen");
    test:assertTrue(body.includes("body of the test skill"),
            "activateSkill must reveal the full body");
}

// ============================================
// Duplicate detection tests
// ============================================

@test:Config
function testDiscoverLocalSkillsDuplicateSubdirectories() returns error? {
    // Test that duplicate skill names in subdirectories are detected
    // First occurrence is kept, second is logged and skipped
    string absPath = check file:getAbsolutePath("tests/skills/duplicate_names");
    map<SkillInfo> skills = check discoverLocalSkills(absPath);

    // Only one skill should be discovered despite two subdirectories with same name
    test:assertEquals(skills.length(), 1);
    test:assertTrue(skills.hasKey("duplicate-skill"));

    // First occurrence (error_translator) should be kept
    SkillInfo info = skills.get("duplicate-skill");
    test:assertEquals(info.description, "Translate error messages to user-friendly language");
    test:assertTrue(info.body.includes("first occurrence"));
}

@test:Config
function testDiscoverSkillsDuplicateFromMultipleSources() returns error? {
    // Test that duplicate skill names across multiple sources are detected
    // First source's skill is kept, subsequent duplicates are skipped (covers lines 54-55)
    string testDir = check file:getAbsolutePath("tests/skills");
    SkillSource[] sources = [
        {path: "source1"}, // has "same-skill" 
        {path: "source2"} // also has "same-skill" (should be skipped)
    ];

    map<SkillInfo> skills = check discoverSkills(sources, testDir);

    // Should have only one skill (first source wins)
    test:assertEquals(skills.length(), 1);
    test:assertTrue(skills.hasKey("same-skill"));

    // Verify it's from source1 (first occurrence)
    SkillInfo info = skills.get("same-skill");
    test:assertEquals(info.description, "Draft release notes from recent commits");
    test:assertTrue(info.body.includes("source1"));
}

// ============================================
// Error handling in subdirectory discovery
// ============================================

@test:Config
function testDiscoverLocalSkillsSkipsInvalidSubdir() returns error? {
    // Test that invalid skills in subdirectories are skipped with error logging
    // Valid skills in other subdirectories are still discovered
    string absPath = check file:getAbsolutePath("tests/skills/partial_invalid");
    map<SkillInfo> skills = check discoverLocalSkills(absPath);

    // Should discover only the valid skill
    test:assertEquals(skills.length(), 1);
    test:assertTrue(skills.hasKey("valid-skill"));
    test:assertFalse(skills.hasKey("")); // Invalid skill has empty name

    SkillInfo validInfo = skills.get("valid-skill");
    test:assertEquals(validInfo.description, "Convert JSON payloads to Markdown tables");
}

// ============================================
// SkillsToolKit getTools test
// ============================================

@test:Config
function testSkillsToolKitGetTools() returns error? {
    // Test that getTools() returns the correct tool configuration
    map<SkillInfo> skills = {
        "refactor": {
            name: "refactor",
            description: "Extract repeated logic into reusable functions",
            body: "Identify duplication and extract helper functions.",
            basePath: "/skills/refactor",
            resources: []
        }
    };

    SkillsToolKit toolkit = new (skills);
    var tools = toolkit.getTools();

    // Should return 2 tools: activateSkill and readSkillResource
    test:assertEquals(tools.length(), 2);
}

// ============================================
// Empty skills directory test (line 36)
// ============================================

@test:Config
function testExtractSkillCatalogEmptyDirectory() returns error? {
    AgentMetadata metadata = {
        skills: [
            {path: "tests/skills/empty_dir"}
        ]
    };

    [string, SkillsToolKit]|error? result = extractSkillCatalog(metadata, ".");

    // When no valid skills are found, should return ()
    test:assertTrue(result is (), "Should return () when no skills are found");
}
