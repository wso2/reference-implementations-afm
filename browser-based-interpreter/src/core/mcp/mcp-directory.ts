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

type Row = [
  id: string,
  title: string,
  category: DirectoryCategory,
  url: string,
  publisher: string,
  docsUrl: string,
  auth: "none" | "oauth2" | ["oauth2", string[]] | ["bearer", string],
  description: string,
];

const ROWS: Row[] = [
  ["airtable", "Airtable", "data", "https://mcp.airtable.com/mcp", "airtable.com", "https://support.airtable.com/docs/using-the-airtable-mcp-server", "oauth2",
    "Read and edit records in your bases."],
  ["amplitude", "Amplitude (US)", "data", "https://mcp.amplitude.com/mcp", "amplitude.com", "https://amplitude.com/docs/amplitude-ai/amplitude-mcp", ["oauth2", ["mcp:read", "mcp:write"]],
    "Ask questions of your product analytics data, US data region."],
  ["apify", "Apify", "search", "https://mcp.apify.com", "apify.com", "https://docs.apify.com/platform/integrations/mcp", "oauth2",
    "Run Actors to scrape and extract web data."],
  ["atlassian", "Atlassian", "work", "https://mcp.atlassian.com/v2/mcp", "atlassian.com", "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/", ["oauth2", ["read:me", "read:account", "offline_access", "email", "read:jira:agent-interface", "write:jira:agent-interface", "search:jira:agent-interface", "delete:jira:agent-interface", "manage:jira:agent-interface", "read:confluence:agent-interface", "write:confluence:agent-interface", "search:confluence:agent-interface", "search:rovo:agent-interface", "search:code:agent-interface", "read:all:twg", "write:all:twg", "read:goals:agent-interface", "write:goals:agent-interface", "read:projects:agent-interface", "write:projects:agent-interface", "read:bitbucket:agent-interface", "write:bitbucket:agent-interface", "read:loom:agent-interface", "write:loom:agent-interface", "read:talent:agent-interface", "write:talent:agent-interface", "read:jira-align:agent-interface", "write:jira-align:agent-interface", "read:teams:agent-interface", "write:teams:agent-interface", "read:artifacts:agent-interface", "write:artifacts:agent-interface", "read:capacity-planning:agent-interface", "write:capacity-planning:agent-interface", "read:focus:agent-interface", "write:focus:agent-interface", "read:assets:agent-interface", "write:assets:agent-interface"]],
    "Work with Jira issues and Confluence pages."],
  ["attio", "Attio", "business", "https://mcp.attio.com/mcp", "attio.com", "https://docs.attio.com/mcp/overview", "oauth2",
    "Search and update people, companies, deals and notes."],
  ["aws-knowledge", "AWS Knowledge", "docs", "https://knowledge-mcp.global.api.aws", "aws.amazon.com", "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server", "none",
    "Search AWS documentation, blog posts and regional availability."],
  ["braze", "Braze", "business", "https://mcp.braze.com/mcp", "braze.com", "https://www.braze.com/docs/user_guide/brazeai/mcp_server", "oauth2",
    "Explore campaigns, Canvases and segments."],
  ["buildkite", "Buildkite", "dev", "https://mcp.buildkite.com/mcp", "buildkite.com", "https://buildkite.com/docs/apis/mcp-server/remote/configuring-ai-tools", "oauth2",
    "Inspect pipelines, builds and jobs."],
  ["calendly", "Calendly", "work", "https://mcp.calendly.com", "calendly.com", "https://developer.calendly.com/calendly-mcp-server", ["oauth2", ["mcp:scheduling:read", "mcp:scheduling:write"]],
    "Check availability and manage events and scheduling links."],
  ["canva", "Canva", "design", "https://mcp.canva.com/mcp", "canva.com", "https://www.canva.dev/docs/mcp/", "oauth2",
    "Create, edit and export designs, and manage folders, assets and comments."],
  ["clickup", "ClickUp", "work", "https://mcp.clickup.com/mcp", "clickup.com", "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server", "oauth2",
    "Manage tasks, docs and comments in your workspace."],
  ["close", "Close", "business", "https://mcp.close.com/mcp", "close.com", "https://help.close.com/docs/mcp-server", "oauth2",
    "Work with leads, contacts and activities."],
  ["cloudflare-api", "Cloudflare API", "dev", "https://mcp.cloudflare.com/mcp", "cloudflare.com", "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/", "oauth2",
    "Use the whole Cloudflare API from your account."],
  ["cloudflare-docs", "Cloudflare Docs", "docs", "https://docs.mcp.cloudflare.com/mcp", "cloudflare.com", "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/", "none",
    "Search the Cloudflare documentation."],
  ["cloudflare-bindings", "Cloudflare Workers Bindings", "dev", "https://bindings.mcp.cloudflare.com/mcp", "cloudflare.com", "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/", "oauth2",
    "Build Workers with storage, AI and compute bindings."],
  ["cloudinary", "Cloudinary", "design", "https://asset-management.mcp.cloudinary.com/mcp", "cloudinary.com", "https://cloudinary.com/documentation/cloudinary_llm_mcp", "oauth2",
    "Search, upload and transform images and video."],
  ["context7", "Context7", "docs", "https://mcp.context7.com/mcp", "context7.com", "https://github.com/upstash/context7", "none",
    "Up-to-date documentation and code examples for libraries."],
  ["deepwiki", "DeepWiki", "docs", "https://mcp.deepwiki.com/mcp", "deepwiki.com", "https://docs.devin.ai/work-with-devin/deepwiki-mcp", "none",
    "Ask questions about public GitHub repositories and read their wikis."],
  ["exa", "Exa", "search", "https://mcp.exa.ai/mcp", "exa.ai", "https://docs.exa.ai/reference/exa-mcp", "none",
    "Search the web and fetch page contents."],
  ["fireflies", "Fireflies", "work", "https://api.fireflies.ai/mcp", "fireflies.ai", "https://docs.fireflies.ai/getting-started/mcp-configuration", "oauth2",
    "Search and read meeting transcripts and notes."],
  ["github", "GitHub", "dev", "https://api.githubcopilot.com/mcp/", "github.com", "https://github.com/github/github-mcp-server", ["bearer", "A GitHub personal access token."],
    "Work with repositories, issues, pull requests and code."],
  ["gitlab", "GitLab", "dev", "https://gitlab.com/api/v4/mcp", "gitlab.com", "https://docs.gitlab.com/user/model_context_protocol/mcp_server/", "oauth2",
    "Work with issues, merge requests and pipelines on GitLab.com."],
  ["grafana", "Grafana", "dev", "https://mcp.grafana.com/mcp", "grafana.com", "https://grafana.com/docs/grafana-cloud/ai-tools/mcp-servers/cloud-mcp/", "oauth2",
    "Work with dashboards, data sources and alerts in Grafana Cloud."],
  ["granola", "Granola", "work", "https://mcp.granola.ai/mcp", "granola.ai", "https://docs.granola.ai/help-center/sharing/integrations/mcp", "oauth2",
    "Search your meeting notes and pull out action items."],
  ["heroku", "Heroku", "dev", "https://mcp.heroku.com/mcp", "heroku.com", "https://devcenter.heroku.com/articles/heroku-remote-mcp-server", "oauth2",
    "Create and manage Heroku apps and add-ons."],
  ["honeycomb", "Honeycomb (US)", "dev", "https://mcp.honeycomb.io/mcp", "honeycomb.io", "https://docs.honeycomb.io/integrations/mcp/configuration-guide/", "oauth2",
    "Query traces, logs and metrics, US data region."],
  ["hugging-face", "Hugging Face", "dev", "https://huggingface.co/mcp", "huggingface.co", "https://huggingface.co/docs/hub/hf-mcp-server", "none",
    "Search models, datasets and Spaces on the Hugging Face Hub."],
  ["intercom", "Intercom", "business", "https://mcp.intercom.com/mcp", "intercom.com", "https://developers.intercom.com/docs/guides/mcp", "oauth2",
    "Search conversations and contacts."],
  ["klaviyo", "Klaviyo", "business", "https://mcp.klaviyo.com/mcp", "klaviyo.com", "https://www.klaviyo.com/solutions/ai/klaviyo-mcp-server", "oauth2",
    "Query campaigns, flows, profiles and reports."],
  ["launchdarkly", "LaunchDarkly", "dev", "https://mcp.launchdarkly.com/mcp/launchdarkly", "launchdarkly.com", "https://launchdarkly.com/docs/home/getting-started/mcp-hosted", "oauth2",
    "Manage feature flags and configs."],
  ["linear", "Linear", "work", "https://mcp.linear.app/mcp", "linear.app", "https://linear.app/docs/mcp", "oauth2",
    "Find, create and update issues, projects and comments."],
  ["make", "Make", "work", "https://mcp.make.com", "make.com", "https://developers.make.com/mcp-server/connect-using-oauth", "oauth2",
    "Run Make scenarios and manage your account."],
  ["mapbox", "Mapbox", "data", "https://mcp.mapbox.com/mcp", "mapbox.com", "https://docs.mapbox.com/api/guides/mcp-server/", "oauth2",
    "Geocode, route and work with maps and styles."],
  ["microsoft-learn", "Microsoft Learn", "docs", "https://learn.microsoft.com/api/mcp", "microsoft.com", "https://learn.microsoft.com/en-us/training/support/mcp", "none",
    "Search Microsoft's official documentation and code samples."],
  ["miro", "Miro", "work", "https://mcp.miro.com", "miro.com", "https://developers.miro.com/docs/connecting-to-miro-mcp", "oauth2",
    "Read and write boards and their content."],
  ["mixpanel", "Mixpanel (US)", "data", "https://mcp.mixpanel.com/mcp", "mixpanel.com", "https://docs.mixpanel.com/docs/mcp", "oauth2",
    "Ask questions of your product analytics data, US data region."],
  ["monday", "monday.com", "work", "https://mcp.monday.com/mcp", "monday.com", "https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp", "oauth2",
    "Read and update boards, items and updates."],
  ["neon", "Neon", "data", "https://mcp.neon.tech/mcp", "neon.com", "https://neon.com/docs/ai/neon-mcp-server", "oauth2",
    "Manage Postgres projects and branches, and run SQL."],
  ["netlify", "Netlify", "dev", "https://netlify-mcp.netlify.app/mcp", "netlify.com", "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/", "oauth2",
    "Create, deploy and manage sites."],
  ["notion", "Notion", "work", "https://mcp.notion.com/mcp", "notion.com", "https://developers.notion.com/guides/mcp/get-started-with-mcp", "oauth2",
    "Search, read and edit pages and databases in your workspace."],
  ["perplexity", "Perplexity", "search", "https://api.perplexity.ai/mcp", "perplexity.ai", "https://docs.perplexity.ai/guides/mcp-server", "oauth2",
    "Search the web and get answers with sources."],
  ["planetscale", "PlanetScale", "data", "https://mcp.pscale.dev/mcp/planetscale", "planetscale.com", "https://planetscale.com/docs/connect/mcp", "oauth2",
    "Query and manage databases and branches."],
  ["posthog", "PostHog", "data", "https://mcp.posthog.com/mcp", "posthog.com", "https://posthog.com/docs/model-context-protocol", ["oauth2", ["openid", "profile", "email", "introspection", "action:read", "action:write", "access_control:read", "access_control:write", "account:read", "account:write", "activity_log:read", "alert:read", "alert:write", "annotation:read", "annotation:write", "approvals:read", "approvals:write", "autoresearch:read", "autoresearch:write", "batch_export:read", "batch_export:write", "billing:read", "business_knowledge:read", "business_knowledge:write", "canvas:read", "canvas:write", "cohort:read", "cohort:write", "comment:read", "comment:write", "conversation:read", "cross_project_dashboard:read", "customer_analytics:read", "customer_analytics:write", "customer_task:read", "customer_task:write", "data_catalog:read", "data_catalog:write", "data_catalog_approval:write", "dashboard:read", "dashboard:write", "dashboard_template:read", "dataset:read", "dataset:write", "early_access_feature:read", "early_access_feature:write", "endpoint:read", "endpoint:write", "engineering_analytics:read", "error_tracking:read", "error_tracking:write", "evaluation:read", "evaluation:write", "element:read", "event_definition:read", "event_definition:write", "experiment:read", "experiment:write", "experiment_holdout:read", "experiment_holdout:write", "experiment_saved_metric:read", "experiment_saved_metric:write", "external_data_source:read", "external_data_source:write", "feature_flag:read", "feature_flag:write", "group:read", "health_issue:read", "heatmap:read", "heatmap:write", "hog_flow:read", "hog_flow:write", "hog_function:read", "hog_function:write", "insight:read", "insight:write", "insight_variable:write", "integration:read", "integration:write", "llm_analytics:read", "llm_analytics:write", "ai_observability_clusters:read", "ai_observability_clusters:write", "llm_prompt:read", "llm_prompt:write", "llm_provider_key:read", "llm_skill:read", "llm_skill:write", "logs:read", "logs:write", "loop:read", "loop:write", "marketing_analytics:read", "marketing_analytics:write", "mcp_analytics:read", "mcp_analytics:write", "mcp_registry:read", "metrics:read", "notebook:read", "notebook:write", "offline_evaluation_ingestion:write", "organization:read", "organization:write", "organization_member:read", "person:read", "person:write", "product_enablement:write", "project:read", "project:write", "property_definition:read", "property_definition:write", "query:read", "replay_scanner:read", "replay_scanner:write", "review_hog:read", "review_hog:write", "session_recording:read", "session_recording:write", "session_recording_playlist:read", "session_recording_playlist:write", "signal_scout:read", "signal_scout:write", "stamphog:read", "stamphog:write", "streamlit_app:read", "streamlit_app:write", "subscription:read", "subscription:write", "survey:read", "survey:write", "tagger:read", "tagger:write", "ticket:read", "ticket:write", "task:read", "task:write", "today:read", "tracing:read", "field_note:read", "field_note:write", "uploaded_media:read", "uploaded_media:write", "usage_metric:read", "usage_metric:write", "user:read", "user:write", "vision_alert:read", "vision_alert:write", "visual_review:read", "visual_review:write", "warehouse_table:read", "warehouse_table:write", "warehouse_view:read", "warehouse_view:write", "web_analytics:read", "web_analytics:write"]],
    "Query product analytics, feature flags and experiments."],
  ["postman", "Postman", "dev", "https://mcp.postman.com/minimal", "postman.com", "https://learning.postman.com/latest-v-12/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server", "oauth2",
    "Work with collections, workspaces and environments."],
  ["prisma", "Prisma", "data", "https://mcp.prisma.io/mcp", "prisma.io", "https://www.prisma.io/docs/postgres/integrations/mcp-server", "oauth2",
    "Manage Prisma Postgres databases and your workspace."],
  ["pulumi", "Pulumi", "dev", "https://mcp.ai.pulumi.com/mcp", "pulumi.com", "https://www.pulumi.com/docs/iac/guides/ai-integration/mcp-server/", "oauth2",
    "Work with Pulumi stacks, resources and the registry."],
  ["railway", "Railway", "dev", "https://mcp.railway.com", "railway.com", "https://docs.railway.com/ai/remote-mcp-server", "oauth2",
    "Deploy and manage projects, services and databases."],
  ["render", "Render", "dev", "https://mcp.render.com/mcp", "render.com", "https://render.com/docs/mcp-server", ["bearer", "A Render API key."],
    "Create and manage services, databases and deploys."],
  ["resend", "Resend", "business", "https://mcp.resend.com/mcp", "resend.com", "https://resend.com/changelog/remote-mcp-server", "oauth2",
    "Send email and manage domains, contacts and broadcasts."],
  ["sanity", "Sanity", "design", "https://mcp.sanity.io", "sanity.io", "https://www.sanity.io/docs/compute-and-ai/mcp-server", "oauth2",
    "Read and edit content in your Sanity projects."],
  ["semrush", "Semrush", "business", "https://mcp.semrush.com/v2/mcp", "semrush.com", "https://developer.semrush.com/api/basics/semrush-mcp/", "oauth2",
    "Research keywords, domains and rankings with Semrush data."],
  ["sentry", "Sentry", "dev", "https://mcp.sentry.dev/mcp", "sentry.io", "https://docs.sentry.io/product/sentry-mcp/", "oauth2",
    "Look up errors, issues and releases in your Sentry projects."],
  ["shortcut", "Shortcut", "work", "https://mcp.shortcut.com/mcp", "shortcut.com", "https://www.shortcut.com/help/integrations/mcp-server", ["oauth2", ["openid"]],
    "Work with stories, epics, iterations and docs."],
  ["stripe", "Stripe", "business", "https://mcp.stripe.com", "stripe.com", "https://docs.stripe.com/mcp", "oauth2",
    "Manage customers, payments and subscriptions, and search Stripe's docs."],
  ["supabase", "Supabase", "data", "https://mcp.supabase.com/mcp", "supabase.com", "https://supabase.com/docs/guides/getting-started/mcp", "oauth2",
    "Manage projects, query databases and run migrations."],
  ["tavily", "Tavily", "search", "https://mcp.tavily.com/mcp", "tavily.com", "https://docs.tavily.com/documentation/mcp", "oauth2",
    "Search the web and extract page content."],
  ["todoist", "Todoist", "work", "https://ai.todoist.net/mcp", "todoist.com", "https://developer.todoist.com/api/v1/", "oauth2",
    "Add, find and update tasks and projects."],
  ["vercel", "Vercel", "dev", "https://mcp.vercel.com", "vercel.com", "https://vercel.com/docs/mcp/vercel-mcp", "oauth2",
    "Manage projects and deployments, and search Vercel's docs."],
  ["webflow", "Webflow", "design", "https://mcp.webflow.com/mcp", "webflow.com", "https://developers.webflow.com/mcp/reference/getting-started", "oauth2",
    "Manage sites, CMS collections and pages."],
  ["wix", "Wix", "design", "https://mcp.wix.com/mcp", "wix.com", "https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/about-the-wix-mcp", "oauth2",
    "Manage Wix sites and apps."],
  ["zapier", "Zapier", "work", "https://mcp.zapier.com/api/v1/connect", "zapier.com", "https://docs.zapier.com/mcp/overview/how-connections-work", "oauth2",
    "Run Zapier actions across the apps you have connected."],
];

function authOf(auth: Row[6]): DirectoryAuth {
  if (typeof auth === "string") return { type: auth };
  return auth[0] === "bearer" ? { type: "bearer", description: auth[1] } : { type: "oauth2", scopes: auth[1] };
}

export const DIRECTORY_ENTRIES: readonly DirectoryEntry[] = ROWS.map(([id, title, category, url, publisher, docsUrl, auth, description]) => ({
  id,
  title,
  description,
  category,
  url,
  publisher,
  docsUrl,
  auth: authOf(auth),
}));

// A server counts as vetted only when its address is exactly one the directory lists.
export function isDirectoryAddress(address: string): boolean {
  return DIRECTORY_ENTRIES.some((entry) => entry.url === address);
}
