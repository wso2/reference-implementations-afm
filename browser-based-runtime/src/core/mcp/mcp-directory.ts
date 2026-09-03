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
    id: "airtable",
    title: "Airtable",
    description: "Read and edit records in your bases.",
    category: "data",
    url: "https://mcp.airtable.com/mcp",
    publisher: "airtable.com",
    docsUrl: "https://support.airtable.com/docs/using-the-airtable-mcp-server",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://airtable.com/oauth2/v1/authorize",
      tokenUrl: "https://airtable.com/oauth2/v1/token",
      registrationUrl: "https://airtable.com/oauth2/v1/register",
      clientIdMetadata: true,
      scopes: [
        "data.records:read",
        "data.records:write",
        "schema.bases:read",
        "schema.bases:write",
        "data.recordComments:read",
        "data.recordComments:write",
        "workspacesAndBases:read",
      ],
    },
  },
  {
    id: "amplitude",
    title: "Amplitude (US)",
    description: "Ask questions of your product analytics data, US data region.",
    category: "data",
    url: "https://mcp.amplitude.com/mcp",
    publisher: "amplitude.com",
    docsUrl: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://mcp.amplitude.com/authorize",
      tokenUrl: "https://mcp.amplitude.com/token",
      registrationUrl: "https://mcp.amplitude.com/register",
      scopes: ["mcp:read", "mcp:write"],
    },
  },
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
    id: "atlassian",
    title: "Atlassian",
    description: "Work with Jira issues and Confluence pages.",
    category: "work",
    url: "https://mcp.atlassian.com/v2/mcp",
    publisher: "atlassian.com",
    docsUrl:
      "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      registrationUrl: "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register",
      clientIdMetadata: true,
      scopes: [
        "read:me",
        "read:account",
        "offline_access",
        "email",
        "read:jira:agent-interface",
        "write:jira:agent-interface",
        "search:jira:agent-interface",
        "delete:jira:agent-interface",
        "manage:jira:agent-interface",
        "read:confluence:agent-interface",
        "write:confluence:agent-interface",
        "search:confluence:agent-interface",
        "search:rovo:agent-interface",
        "search:code:agent-interface",
        "read:all:twg",
        "write:all:twg",
        "read:goals:agent-interface",
        "write:goals:agent-interface",
        "read:projects:agent-interface",
        "write:projects:agent-interface",
        "read:bitbucket:agent-interface",
        "write:bitbucket:agent-interface",
        "read:loom:agent-interface",
        "write:loom:agent-interface",
        "read:talent:agent-interface",
        "write:talent:agent-interface",
        "read:jira-align:agent-interface",
        "write:jira-align:agent-interface",
        "read:teams:agent-interface",
        "write:teams:agent-interface",
        "read:artifacts:agent-interface",
        "write:artifacts:agent-interface",
        "read:capacity-planning:agent-interface",
        "write:capacity-planning:agent-interface",
        "read:focus:agent-interface",
        "write:focus:agent-interface",
        "read:assets:agent-interface",
        "write:assets:agent-interface",
      ],
    },
  },
  {
    id: "attio",
    title: "Attio",
    description: "Search and update people, companies, deals and notes.",
    category: "business",
    url: "https://mcp.attio.com/mcp",
    publisher: "attio.com",
    docsUrl: "https://docs.attio.com/mcp/overview",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://app.attio.com/oidc/authorize",
      tokenUrl: "https://app.attio.com/oidc/token",
      registrationUrl: "https://app.attio.com/oauth/register",
      scopes: ["openid", "offline_access", "mcp"],
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
    id: "braze",
    title: "Braze",
    description: "Explore campaigns, Canvases and segments.",
    category: "business",
    url: "https://mcp.braze.com/mcp",
    publisher: "braze.com",
    docsUrl: "https://www.braze.com/docs/user_guide/brazeai/mcp_server",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://dashboard.braze.com/oauth/authorize",
      tokenUrl: "https://rest.iad-01.braze.com/oauth/token",
      registrationUrl: "https://rest.iad-01.braze.com/oauth/register",
      scopes: ["mcp:tools", "mcp:resources", "mcp:operator"],
    },
  },
  {
    id: "buildkite",
    title: "Buildkite",
    description: "Inspect pipelines, builds and jobs.",
    category: "dev",
    url: "https://mcp.buildkite.com/mcp",
    publisher: "buildkite.com",
    docsUrl: "https://buildkite.com/docs/apis/mcp-server/remote/configuring-ai-tools",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://mcp.buildkite.com/oauth/authorize",
      tokenUrl: "https://mcp.buildkite.com/oauth/token",
      registrationUrl: "https://mcp.buildkite.com/oauth/register",
    },
  },
  {
    id: "calendly",
    title: "Calendly",
    description: "Check availability and manage events and scheduling links.",
    category: "work",
    url: "https://mcp.calendly.com",
    publisher: "calendly.com",
    docsUrl: "https://developer.calendly.com/calendly-mcp-server",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://calendly.com/oauth/authorize",
      tokenUrl: "https://calendly.com/oauth/token",
      registrationUrl: "https://calendly.com/oauth/register",
      scopes: ["mcp:scheduling:read", "mcp:scheduling:write"],
    },
  },
  {
    id: "canva",
    title: "Canva",
    description: "Create, edit and export designs, and manage folders, assets and comments.",
    category: "design",
    url: "https://mcp.canva.com/mcp",
    publisher: "canva.com",
    docsUrl: "https://www.canva.dev/docs/mcp/",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://mcp.canva.com/authorize",
      tokenUrl: "https://mcp.canva.com/token",
      registrationUrl: "https://mcp.canva.com/register",
      clientIdMetadata: true,
      scopes: [
        "profile:read",
        "design:meta:read",
        "design:content:write",
        "design:content:read",
        "folder:read",
        "folder:write",
        "brandtemplate:content:read",
        "brandtemplate:meta:read",
        "brandtemplate:content:write",
        "comment:write",
        "comment:read",
        "asset:read",
        "asset:write",
        "brandkit:read",
        "help:answers:read",
        "help:answers:write",
      ],
    },
  },
  {
    id: "clickup",
    title: "ClickUp",
    description: "Manage tasks, docs and comments in your workspace.",
    category: "work",
    url: "https://mcp.clickup.com/mcp",
    publisher: "clickup.com",
    docsUrl: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://mcp.clickup.com/oauth/authorize",
      tokenUrl: "https://mcp.clickup.com/oauth/token",
      registrationUrl: "https://mcp.clickup.com/oauth/register",
      scopes: ["read", "write"],
    },
  },
  {
    id: "close",
    title: "Close",
    description: "Work with leads, contacts and activities.",
    category: "business",
    url: "https://mcp.close.com/mcp",
    publisher: "close.com",
    docsUrl: "https://help.close.com/docs/mcp-server",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://app.close.com/oauth2/authorize/",
      tokenUrl: "https://api.close.com/oauth2/token/",
      registrationUrl: "https://api.close.com/oauth2/register/",
      scopes: ["mcp.read", "mcp.write_destructive", "mcp.write_safe", "offline_access"],
    },
  },
  {
    id: "cloudflare-api",
    title: "Cloudflare API",
    description: "Use the whole Cloudflare API from your account.",
    category: "dev",
    url: "https://mcp.cloudflare.com/mcp",
    publisher: "cloudflare.com",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://mcp.cloudflare.com/authorize",
      tokenUrl: "https://mcp.cloudflare.com/token",
      registrationUrl: "https://mcp.cloudflare.com/register",
      clientIdMetadata: true,
      scopes: ["user:read", "account:read"],
    },
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
    id: "cloudflare-bindings",
    title: "Cloudflare Workers Bindings",
    description: "Build Workers with storage, AI and compute bindings.",
    category: "dev",
    url: "https://bindings.mcp.cloudflare.com/mcp",
    publisher: "cloudflare.com",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://bindings.mcp.cloudflare.com/oauth/authorize",
      tokenUrl: "https://bindings.mcp.cloudflare.com/token",
      registrationUrl: "https://bindings.mcp.cloudflare.com/register",
    },
  },
  {
    id: "cloudinary",
    title: "Cloudinary",
    description: "Search, upload and transform images and video.",
    category: "design",
    url: "https://asset-management.mcp.cloudinary.com/mcp",
    publisher: "cloudinary.com",
    docsUrl: "https://cloudinary.com/documentation/cloudinary_llm_mcp",
    auth: {
      type: "oauth2",
      authorizeUrl: "https://asset-management.mcp.cloudinary.com/authorize",
      tokenUrl: "https://asset-management.mcp.cloudinary.com/token",
      registrationUrl: "https://asset-management.mcp.cloudinary.com/register",
      scopes: ["openid", "profile", "email", "offline_access", "asset_management", "upload", "media_generation"],
    },
  },
];
