import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "stdio-test", version: "0.0.0" });
const answer = (text) => ({ content: [{ type: "text", text }] });
server.registerTool("from_file", { description: "The AFM_TEST_VALUE this server was started with." }, async () => answer(process.env.AFM_TEST_VALUE ?? "unset"));
server.registerTool("from_parent", { description: "A variable of the parent process." }, async () => answer(process.env.AFM_PARENT_SECRET ?? "unset"));
server.registerTool("hidden", { description: "A tool the file may hide." }, async () => answer("hidden"));
await server.connect(new StdioServerTransport());
