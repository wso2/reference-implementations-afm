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

import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function findTsconfigs(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "dist") continue;
    const child = join(dir, entry.name);
    if (existsSync(join(child, "tsconfig.json"))) found.push(child);
    else found.push(...findTsconfigs(child));
  }
  return found;
}

const packages = findTsconfigs(join(root, "packages")).sort();
if (packages.length === 0) {
  console.error("No packages with a tsconfig.json were found.");
  process.exit(1);
}

const failed = [];
for (const pkg of packages) {
  const name = relative(root, pkg);
  const result = spawnSync("npx", ["tsc", "--noEmit", "-p", join(pkg, "tsconfig.json")], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status === 0) {
    console.log(`  ok  ${name}`);
  } else {
    console.log(`FAIL  ${name}`);
    failed.push(name);
  }
}

console.log(`\n${packages.length - failed.length}/${packages.length} packages typecheck cleanly.`);
if (failed.length > 0) {
  console.error(`Failed: ${failed.join(", ")}`);
  process.exit(1);
}
