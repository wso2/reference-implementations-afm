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

import ballerina/ai;
import ballerina/file;
import ballerina/io;
import ballerina/log;

const SKILL_FILE = "SKILL.md";
const REFERENCES_DIR = "references";
const ASSETS_DIR = "assets";

function extractSkillCatalog(AgentMetadata metadata, string afmFileDir) returns [string, SkillsToolKit]|error? {
    SkillSource[]? skillSources = metadata?.skills;
    if skillSources is () || skillSources.length() == 0 {
        return ();
    }
    map<SkillInfo> skills = check discoverSkills(skillSources, afmFileDir);
    log:printDebug(string `Loaded ${skills.length()} skill(s): ${string:'join(", ", ...skills.keys())}`);
    string? skillCatalog = buildSkillCatalog(skills);
    if skillCatalog is () {
        return (); // No catalog if no skills, even if skill sources were defined
    }
    return [skillCatalog, new SkillsToolKit(skills)];
}

type SkillFrontmatter record {
    string name;
    string description;
};

function discoverSkills(SkillSource[] sources, string afmFileDir) returns map<SkillInfo>|error {
    map<SkillInfo> skills = {};

    foreach SkillSource 'source in sources {
        string resolvedPath = check file:joinPath(afmFileDir, 'source.path);
        map<SkillInfo> localSkills = check discoverLocalSkills(resolvedPath);
        foreach [string, SkillInfo] [name, info] in localSkills.entries() {
            if skills.hasKey(name) {
                log:printWarn(string `Skill '${name}' already discovered, skipping duplicate from ${'source.path}`);
                continue;
            }
            skills[name] = info;
        }
    }

    return skills;
}

function discoverLocalSkills(string path) returns map<SkillInfo>|error {
    string absPath = check file:getAbsolutePath(path);

    string skillMdPath = check file:joinPath(absPath, SKILL_FILE);
    if check file:test(skillMdPath, file:EXISTS) {
        SkillInfo info = check parseSkillMd(skillMdPath, absPath);
        return {[info.name]: info};
    }

    map<SkillInfo> skills = {};
    file:MetaData[] entries = check file:readDir(absPath);
    foreach file:MetaData entry in entries {
        if !entry.dir {
            continue;
        }
        string subSkillMd = check file:joinPath(entry.absPath, SKILL_FILE);
        if !check file:test(subSkillMd, file:EXISTS) {
            continue;
        }

        SkillInfo|error info = parseSkillMd(subSkillMd, entry.absPath);
        if info is error {
            log:printError(string `Failed to parse skill at ${entry.absPath}`, 'error = info);
            continue;
        }
        if skills.hasKey(info.name) {
            log:printWarn(string `Skill '${info.name}' already discovered, skipping duplicate at ${entry.absPath}`);
            continue;
        }
        skills[info.name] = info;
    }

    return skills;
}

function parseSkillMd(string skillMdPath, string basePath) returns SkillInfo|error {
    string content = check io:fileReadString(skillMdPath);
    return parseSkillMdContent(content, basePath, listLocalResources(basePath));
}

function parseSkillMdContent(string content, string basePath, string[] resources) returns SkillInfo|error {
    [map<json>, string] [frontmatterMap, body] = check extractFrontmatter(content);
    SkillFrontmatter frontmatter = check frontmatterMap.fromJsonWithType();

    if frontmatter.name.trim() == "" {
        return error("SKILL.md 'name' field is required and must not be empty");
    }
    if frontmatter.description.trim() == "" {
        return error("SKILL.md 'description' field is required and must not be empty");
    }

    return {
        name: frontmatter.name,
        description: frontmatter.description,
        body: body.trim(),
        basePath,
        resources
    };
}

function listLocalResources(string basePath) returns string[] {
    string[] resources = [];
    foreach string dir in [REFERENCES_DIR, ASSETS_DIR] {
        do {
            string dirPath = check file:joinPath(basePath, dir);
            file:MetaData[] entries = check file:readDir(dirPath);
            foreach file:MetaData entry in entries {
                if !entry.dir {
                    resources.push(check file:joinPath(dir, check file:basename(entry.absPath)));
                }
            }
        } on fail error e {
            log:printDebug(string `Failed to read directory ${dir}`, 'error = e);
        }
    }
    return resources;
}

function buildSkillCatalog(map<SkillInfo> skills) returns string? {
    if skills.length() == 0 {
        return ();
    }

    return string `
## Available Skills

The following skills provide specialized instructions for specific tasks.
When a task matches a skill's description, call the activate_skill tool
with the skill's name to load its full instructions.

${xml `<available_skills>
${from SkillInfo skill in skills select xml `
    <skill>
        <name>${skill.name}</name>
        <description>${skill.description}</description>
    </skill>
`}
</available_skills>`.toString()}
`;
}

isolated class SkillsToolKit {
    *ai:BaseToolKit;

    private final map<SkillInfo> & readonly skills;

    isolated function init(map<SkillInfo> skills) {
        self.skills = skills.cloneReadOnly();
    }

    # Activates a skill by name and returns its full instructions along with available resources.
    # Call this when a task matches one of the available skills' descriptions.
    #
    # + name - the name of the skill to activate (must match a name from the available skills catalog)
    # + return - the skill's full instructions and list of available resource files
    @ai:AgentTool
    isolated function activate_skill(string name) returns string|error {
        if !self.skills.hasKey(name) {
            return error(string `Skill '${name}' not found. Available skills: ${
                string:'join(", ", ...self.skills.keys())}`);
        }

        SkillInfo info = self.skills.get(name);
        // Using string templates instead of XML literals to avoid escaping skill body content
        // (e.g., angle brackets in code examples would be escaped to &lt;/&gt; by XML)
        string resourcesSection = info.resources.length() > 0 ?
            string `
<skill_resources>
${string:'join("\n", ...from string res in info.resources select string `<file>${res}</file>`)}
</skill_resources>
Use the read_skill_resource tool to read any of these files if needed.
` : "";
        return string `
<skill_content name="${info.name}">
${info.body}
${resourcesSection}
</skill_content>
`;
    }

    # Reads a resource file from a skill's references/ or assets/ directory.
    # Only files listed in skill_resources after activating a skill can be read.
    #
    # + skillName - the name of the skill that owns the resource
    # + resourcePath - relative path to the resource file (e.g., "references/REFERENCE.md" or "assets/template.json")
    # + return - the content of the resource file
    @ai:AgentTool
    isolated function read_skill_resource(string skillName, string resourcePath) returns string|error {
        if !self.skills.hasKey(skillName) {
            return error(string `Skill '${skillName}' not found`);
        }

        string[] segments = check file:splitPath(resourcePath);
        if segments.length() < 2 || (segments[0] != REFERENCES_DIR && segments[0] != ASSETS_DIR) {
            return error(string `Resource path must start with '${REFERENCES_DIR}/' or '${ASSETS_DIR}/'`);
        }

        if segments.indexOf("..") != () {
            return error("Path traversal is not allowed in resource paths");
        }

        SkillInfo info = self.skills.get(skillName);
        if info.resources.indexOf(resourcePath) is () {
            return error(string `Resource '${resourcePath}' not found in skill '${
                skillName}'. Available: ${string:'join(", ", ...info.resources)}`);
        }

        string fullPath = check file:joinPath(info.basePath, resourcePath);
        return io:fileReadString(fullPath);
    }

    public isolated function getTools() returns ai:ToolConfig[] =>
        ai:getToolConfigs([self.activate_skill, self.read_skill_resource]);
}
