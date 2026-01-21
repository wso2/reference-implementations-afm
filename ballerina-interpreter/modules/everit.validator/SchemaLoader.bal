import ballerina/jballerina.java;

# Ballerina class mapping for the Java `org.everit.json.schema.loader.SchemaLoader` class.
@java:Binding {'class: "org.everit.json.schema.loader.SchemaLoader"}
public isolated distinct class SchemaLoader {

    *java:JObject;
    *Object;

    # The `handle` field that stores the reference to the `org.everit.json.schema.loader.SchemaLoader` object.
    public final handle jObj;

    # The init function of the Ballerina class mapping the `org.everit.json.schema.loader.SchemaLoader` Java class.
    #
    # + obj - The `handle` value containing the Java reference of the object.
    public isolated function init(handle obj) {
        self.jObj = obj;
    }

    # The function to retrieve the string representation of the Ballerina class mapping the `org.everit.json.schema.loader.SchemaLoader` Java class.
    #
    # + return - The `string` form of the Java object instance.
    isolated function toString() returns string {
        return java:toString(self.jObj) ?: "";
    }

    # The function that maps to the `load` method of `org.everit.json.schema.loader.SchemaLoader`.
    #
    # + return - The `Builder` value returning from the Java mapping.
    public isolated function load() returns Builder {
        handle externalObj = org_everit_json_schema_loader_SchemaLoader_load(self.jObj);
        Builder newObj = new (externalObj);
        return newObj;
    }
}

isolated function org_everit_json_schema_loader_SchemaLoader_load(handle receiver) returns handle = @java:Method {
    name: "load",
    'class: "org.everit.json.schema.loader.SchemaLoader",
    paramTypes: []
} external;
