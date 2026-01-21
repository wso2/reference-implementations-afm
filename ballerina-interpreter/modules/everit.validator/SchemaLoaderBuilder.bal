import ballerina/jballerina.java;

# Ballerina class mapping for the Java `org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder` class.
@java:Binding {'class: "org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder"}
public isolated distinct class SchemaLoaderBuilder {

    *java:JObject;
    *Object;

    # The `handle` field that stores the reference to the `org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder` object.
    public final handle jObj;

    # The init function of the Ballerina class mapping the `org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder` Java class.
    #
    # + obj - The `handle` value containing the Java reference of the object.
    public isolated function init(handle obj) {
        self.jObj = obj;
    }

    # The function to retrieve the string representation of the Ballerina class mapping the `org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder` Java class.
    #
    # + return - The `string` form of the Java object instance.
    isolated function toString() returns string {
        return java:toString(self.jObj) ?: "";
    }

    # The function that maps to the `build` method of `org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder`.
    #
    # + return - The `SchemaLoader` value returning from the Java mapping.
    public isolated function build() returns SchemaLoader {
        handle externalObj = org_everit_json_schema_loader_SchemaLoader_SchemaLoaderBuilder_build(self.jObj);
        SchemaLoader newObj = new (externalObj);
        return newObj;
    }

    # The function that maps to the `schemaJson` method of `org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder`.
    #
    # + arg0 - The `JSONObject` value required to map with the Java method parameter.
    # + return - The `SchemaLoaderBuilder` value returning from the Java mapping.
    public isolated function schemaJson(JSONObject arg0) returns SchemaLoaderBuilder {
        handle externalObj = org_everit_json_schema_loader_SchemaLoader_SchemaLoaderBuilder_schemaJson(self.jObj, arg0.jObj);
        SchemaLoaderBuilder newObj = new (externalObj);
        return newObj;
    }
}

# The constructor function to generate an object of `org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder`.
#
# + return - The new `SchemaLoaderBuilder` class generated.
public isolated function newSchemaLoaderBuilder1() returns SchemaLoaderBuilder {
    handle externalObj = org_everit_json_schema_loader_SchemaLoader_SchemaLoaderBuilder_newSchemaLoaderBuilder1();
    SchemaLoaderBuilder newObj = new (externalObj);
    return newObj;
}

isolated function org_everit_json_schema_loader_SchemaLoader_SchemaLoaderBuilder_build(handle receiver) returns handle = @java:Method {
    name: "build",
    'class: "org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder",
    paramTypes: []
} external;

isolated function org_everit_json_schema_loader_SchemaLoader_SchemaLoaderBuilder_schemaJson(handle receiver, handle arg0) returns handle = @java:Method {
    name: "schemaJson",
    'class: "org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder",
    paramTypes: ["org.json.JSONObject"]
} external;

isolated function org_everit_json_schema_loader_SchemaLoader_SchemaLoaderBuilder_newSchemaLoaderBuilder1() returns handle = @java:Constructor {
    'class: "org.everit.json.schema.loader.SchemaLoader$SchemaLoaderBuilder",
    paramTypes: []
} external;
