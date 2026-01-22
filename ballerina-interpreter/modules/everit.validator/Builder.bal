import ballerina/jballerina.java;

# Ballerina class mapping for the Java `org.everit.json.schema.Schema$Builder` class.
@java:Binding {'class: "org.everit.json.schema.Schema$Builder"}
public isolated distinct class Builder {

    *java:JObject;
    *Object;

    # The `handle` field that stores the reference to the `org.everit.json.schema.Schema$Builder` object.
    public final handle jObj;

    # The init function of the Ballerina class mapping the `org.everit.json.schema.Schema$Builder` Java class.
    #
    # + obj - The `handle` value containing the Java reference of the object.
    public isolated function init(handle obj) {
        self.jObj = obj;
    }

    # The function to retrieve the string representation of the Ballerina class mapping the `org.everit.json.schema.Schema$Builder` Java class.
    #
    # + return - The `string` form of the Java object instance.
    isolated function toString() returns string {
        return java:toString(self.jObj) ?: "";
    }

    # The function that maps to the `build` method of `org.everit.json.schema.Schema$Builder`.
    #
    # + return - The `Schema` value returning from the Java mapping.
    public isolated function build() returns Schema {
        handle externalObj = org_everit_json_schema_Schema_Builder_build(self.jObj);
        Schema newObj = new (externalObj);
        return newObj;
    }
}

isolated function org_everit_json_schema_Schema_Builder_build(handle receiver) returns handle = @java:Method {
    name: "build",
    'class: "org.everit.json.schema.Schema$Builder",
    paramTypes: []
} external;
