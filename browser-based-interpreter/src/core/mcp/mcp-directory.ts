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

export interface OAuthSignIn {
  type: "oauth2";
  authorizeUrl: string;
  tokenUrl: string;
  registrationUrl?: string;
  clientIdMetadata?: boolean;
  scopes?: string[];
}

export type DirectoryAuth = { type: "none" } | { type: "bearer"; description: string } | OAuthSignIn;

export const DIRECTORY_CATEGORIES = [
  { id: "docs", label: "Docs" },
  { id: "search", label: "Search" },
  { id: "dev", label: "Dev" },
  { id: "data", label: "Data" },
  { id: "work", label: "Work" },
  { id: "business", label: "Business" },
  { id: "design", label: "Design" },
] as const;

export type DirectoryCategory = (typeof DIRECTORY_CATEGORIES)[number]["id"];

export interface DirectoryEntry {
  id: string;
  title: string;
  description: string;
  category: DirectoryCategory;
  url: string;
  publisher: string;
  docsUrl: string;
  auth: DirectoryAuth;
}

export const DIRECTORY_ENTRIES: readonly DirectoryEntry[] = [
  {
    id: "apify",
    title: "Apify",
    description: "Run Actors to scrape and extract web data.",
    category: "search",
    url: "https://mcp.apify.com",
    publisher: "apify.com",
    docsUrl: "https://docs.apify.com/platform/integrations/mcp",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://console.apify.com/authorize/oauth",
      tokenUrl: "https://console-backend.apify.com/oauth/apps/token",
      registrationUrl: "https://console-backend.apify.com/oauth/apps",
      clientIdMetadata: true,
      scopes: ["full_api_access"],
    },
  },
  {
    id: "aws-knowledge",
    title: "AWS Knowledge",
    description: "Search AWS documentation, blog posts and regional availability.",
    category: "docs",
    url: "https://knowledge-mcp.global.api.aws",
    publisher: "aws.amazon.com",
    docsUrl: "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server",
    auth: { type: "none" },
  },
  {
    id: "cloudflare-docs",
    title: "Cloudflare Docs",
    description: "Search the Cloudflare documentation.",
    category: "docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
    publisher: "cloudflare.com",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    auth: { type: "none" },
  },
  {
    id: "context7",
    title: "Context7",
    description: "Up-to-date documentation and code examples for libraries.",
    category: "docs",
    url: "https://mcp.context7.com/mcp",
    publisher: "context7.com",
    docsUrl: "https://github.com/upstash/context7",
    auth: { type: "none" },
  },
  {
    id: "deepwiki",
    title: "DeepWiki",
    description: "Ask questions about public GitHub repositories and read their wikis.",
    category: "docs",
    url: "https://mcp.deepwiki.com/mcp",
    publisher: "deepwiki.com",
    docsUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    auth: { type: "none" },
  },
  {
    id: "exa",
    title: "Exa",
    description: "Search the web and fetch page contents.",
    category: "search",
    url: "https://mcp.exa.ai/mcp",
    publisher: "exa.ai",
    docsUrl: "https://docs.exa.ai/reference/exa-mcp",
    auth: { type: "none" },
  },
  {
    id: "microsoft-learn",
    title: "Microsoft Learn",
    description: "Search Microsoft's official documentation and code samples.",
    category: "docs",
    url: "https://learn.microsoft.com/api/mcp",
    publisher: "microsoft.com",
    docsUrl: "https://learn.microsoft.com/en-us/training/support/mcp",
    auth: { type: "none" },
  },
  {
    id: "perplexity",
    title: "Perplexity",
    description: "Search the web and get answers with sources.",
    category: "search",
    url: "https://api.perplexity.ai/mcp",
    publisher: "perplexity.ai",
    docsUrl: "https://docs.perplexity.ai/guides/mcp-server",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://api.perplexity.ai/oauth/authorize",
      tokenUrl: "https://api.perplexity.ai/oauth/token",
      registrationUrl: "https://api.perplexity.ai/oauth/register",
      clientIdMetadata: true,
      scopes: ["perplexity_api"],
    },
  },
  {
    id: "tavily",
    title: "Tavily",
    description: "Search the web and extract page content.",
    category: "search",
    url: "https://mcp.tavily.com/mcp",
    publisher: "tavily.com",
    docsUrl: "https://docs.tavily.com/documentation/mcp",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://mcp.tavily.com/authorize",
      tokenUrl: "https://mcp.tavily.com/token",
      registrationUrl: "https://mcp.tavily.com/register",
      clientIdMetadata: true,
      scopes: ["openid", "offline_access"],
    },
  },
];
