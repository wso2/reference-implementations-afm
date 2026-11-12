// Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com).
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
import ballerina/io;

const RESOURCES_DIR = "tests/resources";

function resourcesDirectory() returns string|error =>
    file:normalizePath(check file:getAbsolutePath(RESOURCES_DIR), file:CLEAN);

function readResourceFile(string name) returns map<json>|error {
    json document = check io:fileReadJson(string `${RESOURCES_DIR}/${name}`);
    map<json> result = check document.ensureType();
    return result;
}
