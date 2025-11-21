import afm_ballerina.everit.validator;

import ballerina/ai;
import ballerina/data.yaml;
import ballerina/http;
import ballerina/io;
import ballerina/log;
import ballerina/lang.runtime;
import ballerina/os;

const FRONTMATTER_DELIMITER = "---";

type InputError distinct error;
type AgentError distinct error;

public function main(string filePath, string? input = ()) returns error? {
    string content = check io:fileReadString(filePath);
    
    AFMRecord afm = check parseAfm(content);
    
    AgentMetadata metadata = afm.metadata;

    Interface interface = metadata.interface;

    if interface is FunctionInterface {
        if input is () {
            return error("Expected input for function");
        }
        return createAndRunAgent(afm, input);
    }

    Exposure exposure = interface.exposure;
    
    if exposure.a2a is A2AExposure {
        log:printWarn("A2A not yet supported");
    }

    HTTPExposure? httpExposure = exposure.http;
    if httpExposure is () {
        panic error("No HTTP exposure defined for service agent");
    }

    http:Listener ln = check new (8085);
    http:Service httpService = check new HttpService(afm);
    check ln.attach(httpService, httpExposure.path);
    check ln.start();
    runtime:registerListener(ln);
    log:printInfo("HTTP service started at path: " + httpExposure.path);
}

type AgentConfiguration record {|
    readonly map<json> inputSchema;
    readonly map<json> outputSchema;
    ai:Agent agent;
|};

function createAndRunAgent(AFMRecord afmRecord, string input) returns error? {
    AgentConfiguration {inputSchema, outputSchema, agent} = check extractAgentConfiguration(afmRecord);
    // TODO: Ignore result?
    json result = check runAgent(agent, inputSchema, outputSchema, check input.fromJsonString());
    io:println(result);
}

service class HttpService {
    *http:Service;

    private final readonly & map<json> inputSchema;
    private final readonly & map<json> outputSchema;
    private final ai:Agent agent;

    function init(AFMRecord afmRecord) returns error? {
        AgentConfiguration {inputSchema, outputSchema, agent} = check extractAgentConfiguration(afmRecord);
        self.inputSchema = inputSchema;
        self.outputSchema = outputSchema;
        self.agent = agent;
    }

    resource function post .(@http:Payload json payload) returns json|http:BadRequest|http:InternalServerError {
        json|InputError|AgentError runAgentResult = runAgent(self.agent, self.inputSchema, self.outputSchema, payload);
        if runAgentResult is json {
            return runAgentResult;
        }

        if runAgentResult is InputError {
            return <http:BadRequest> {body: runAgentResult.message()};
        }
        return <http:InternalServerError> {body: runAgentResult.message()};
    }
}

function parseAfm(string content) returns AFMRecord|error {
    string[] lines = splitLines(content);
    int length = lines.length();
    
    AgentMetadata? metadata = ();
    int bodyStart = 0;
    
    // Extract and parse YAML frontmatter
    if length > 0 && lines[0].trim() == FRONTMATTER_DELIMITER {
        int i = 1;
        while i < length && lines[i].trim() != FRONTMATTER_DELIMITER {
            i += 1;
        }
        
        if i < length {
            string[] fmLines = [];
            foreach int j in 1 ..< i {
                fmLines.push(lines[j]);
            }
            string yamlContent = string:'join("\n", ...fmLines);
            metadata = check yaml:parseString(yamlContent, t = AgentMetadata);
            bodyStart = i + 1;
        }
    }
    
    // Extract Role and Instructions sections
    string role = "";
    string instructions = "";
    boolean inRole = false;
    boolean inInstructions = false;
    
    foreach int k in bodyStart ..< length {
        string line = lines[k];
        string trimmed = line.trim();
        
        if trimmed.startsWith("# ") {
            string heading = trimmed.substring(2).toLowerAscii();
            inRole = heading.startsWith("role");
            inInstructions = heading.startsWith("instructions");
            continue;
        }
        
        if inRole {
            role = role == "" ? line : role + "\n" + line;
        } else if inInstructions {
            instructions = instructions == "" ? line : instructions + "\n" + line;
        }
    }
    
    return {
        metadata: check metadata.ensureType(),
        role: role.trim(),
        instructions: instructions.trim()
    };
}

function splitLines(string content) returns string[] {
    string[] result = [];
    string remaining = content;
    
    while true {
        int? idx = remaining.indexOf("\n");
        if idx is int {
            result.push(remaining.substring(0, idx));
            remaining = remaining.substring(idx + 1);
        } else {
            if remaining.length() > 0 {
                result.push(remaining);
            }
            break;
        }
    }
    
    return result;
}

function extractAgentConfiguration(AFMRecord afmRecord) returns AgentConfiguration|error {
    AFMRecord {metadata, role, instructions} = afmRecord;
    Signature signature = check metadata?.interface?.signature.ensureType();
    map<json> & readonly inputSchema = transformToJsonObjectSchema(signature.input);
    map<json> & readonly outputSchema = transformToJsonObjectSchema(signature.output);

    ai:McpToolKit[] mcpToolkits = [];
    MCPConnections? mcpConnections = metadata?.tools?.mcp;
    if mcpConnections is MCPConnections {
        foreach MCPServer mcpConn in mcpConnections.servers {
            Transport transport = mcpConn.transport;
            if transport !is HttpTransport || transport.'type != STREAMABLE_HTTP {
                log:printWarn("Only streamable_http transport is supported for MCP connections");
                continue;
            }
            mcpToolkits.push(check new ai:McpToolKit(
                transport.url,
                // TODO: handle deny list
                permittedTools = mcpConn.tool_filter?.allow
            ));
        }
    }

    ai:Agent agent = check new ({
        systemPrompt: {
            role, 
            instructions
        },
        tools: mcpToolkits,
        model: check new ai:Wso2ModelProvider(
            "https://dev-tools.wso2.com/ballerina-copilot/v2.0",
            // accessToken)
            os:getEnv("TEST_ACCESS_TOKEN"))
    });
    return {inputSchema, outputSchema, agent};
}

function transformToJsonObjectSchema(Parameter[] params) returns map<json> & readonly {
    map<json> properties = {};
    string[] requiredFields = [];
    
    foreach Parameter param in params {
        map<json> paramSchema = {};
        paramSchema["type"] = param.'type;
        if param.description is string {
            paramSchema["description"] = param.description;
        }
        string paramName = param.name;
        properties[paramName] = paramSchema;
        
        boolean isRequired = let boolean? required = param.required in
            required is boolean ? required : false;
        if isRequired {
            requiredFields.push(paramName);
        }
    }
    
    map<json> schema = {
        "type": "object",
        "properties": properties.cloneReadOnly()
    };
    
    if requiredFields.length() > 0 {
        schema["required"] = requiredFields.cloneReadOnly();
    }
    
    return schema.cloneReadOnly();
}

function runAgent(ai:Agent agent, map<json> inputSchema, map<json> outputSchema, json payload) returns json|InputError|AgentError {
    error? validateJsonSchemaResult = validateJsonSchema(inputSchema, payload);
    if validateJsonSchemaResult is error {
        log:printError("Invalid input payload", 'error = validateJsonSchemaResult);
        return error InputError("Invalid input payload");
    }
    
    string|ai:Error run = agent.run(
        string `${payload.toJsonString()}
        
        The final response MUST conform to the following JSON schema:
        ${outputSchema.toJsonString()}

        Respond only with the value enclosed between ${"```json"} and ${"```"}.
        `);

    if run is ai:Error {
        log:printError("Agent run failed", 'error = run);
        return error AgentError("Agent run failed", run);
    }

    string responseJsonStr = run;
    if run.startsWith("```json") && run.endsWith("```") {
        responseJsonStr = run.substring(7, run.length() - 3);
    }

    json|error responseJson = responseJsonStr.fromJsonString();

    if responseJson is error {
        log:printError("Failed to parse agent response JSON", 'error = responseJson);
        return error AgentError("Failed to parse agent response JSON");
    }

    error? validateOutputSchemaResult = validateJsonSchema(outputSchema, responseJson);
    if validateOutputSchemaResult is error {
        log:printError("Agent response does not conform to output schema", 'error = validateOutputSchemaResult);
        return error AgentError("Agent response does not conform to output schema", validateOutputSchemaResult);
    }
    return responseJson;
}

isolated function validateJsonSchema(map<json> jsonSchemaVal, json sampleJson) returns error? {
    // Create JSONObject from schema
    validator:JSONObject schemaObject = validator:newJSONObject7(jsonSchemaVal.toJsonString());
    
    // Build the schema using SchemaLoader
    validator:SchemaLoaderBuilder builder = validator:newSchemaLoaderBuilder1();
    validator:SchemaLoader schemaLoader = builder.schemaJson(schemaObject).build();
    validator:Schema schema = schemaLoader.load().build();
    
    // Create JSONObject from the JSON to validate
    validator:JSONObject jsonObject = validator:newJSONObject7(sampleJson.toJsonString());
    
    // Validate - throws ValidationException if invalid
    error? validationResult = trap schema.validate(jsonObject);
    
    if validationResult is error {
        return error("JSON validation failed: " + validationResult.message());
    }
    
    return ();
}
