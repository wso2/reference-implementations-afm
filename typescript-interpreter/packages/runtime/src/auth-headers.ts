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


import type { ClientAuthentication } from "@afm/engine";

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function utf8Base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function required(value: string | undefined, type: string, field: string): string {
  if (value === undefined || value === "") throw new Error(`${type} authentication requires a '${field}' field`);
  if (CONTROL.test(value)) throw new Error(`the '${field}' of ${type} authentication must not contain control characters`);
  return value;
}

export function authHeaders(auth: ClientAuthentication): Record<string, string> {
  const type = auth.type.toLowerCase();
  if (type === "bearer") {
    const token = required(auth.token, type, "token");
    if (/\s/.test(token)) throw new Error("the 'token' of bearer authentication must not contain whitespace");
    return { Authorization: `Bearer ${token}` };
  }
  if (type === "basic") {
    const username = required(auth.username, type, "username");
    const password = required(auth.password, type, "password");
    if (username.includes(":")) throw new Error("the 'username' of basic authentication must not contain a colon");
    return { Authorization: `Basic ${utf8Base64(`${username}:${password}`)}` };
  }
  if (type === "api-key") {
    const name = auth.header_name ?? "Authorization";
    if (!HEADER_NAME.test(name)) throw new Error(`'${name}' is not a valid header name for api-key authentication`);
    return { [name]: required(auth.api_key, type, "api_key") };
  }
  throw new Error(`'${auth.type}' authentication is not yet supported by this interpreter`);
}
