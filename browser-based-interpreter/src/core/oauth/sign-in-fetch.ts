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

interface SignInTokens {
  token(): Promise<string>;
  renew(rejectedToken: string): Promise<boolean>;
}

export function withSignIn(send: typeof fetch, { token, renew }: SignInTokens): typeof fetch {
  async function attempt(input: Parameters<typeof fetch>[0], init: RequestInit | undefined) {
    const current = await token();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${current}`);
    return { current, response: await send(input, { ...init, headers }) };
  }
  return async (input, init) => {
    const first = await attempt(input, init);
    if (first.response.status !== 401 || !(await renew(first.current))) return first.response;
    return (await attempt(input, init)).response;
  };
}
