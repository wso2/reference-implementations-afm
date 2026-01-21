import ballerina/jballerina.java;

# Ballerina class mapping for the Java `org.everit.json.schema.Schema` class.
@java:Binding {'class: "org.everit.json.schema.Schema"}
public isolated distinct class Schema {

    *java:JObject;
    *Object;

    # The `handle` field that stores the reference to the `org.everit.json.schema.Schema` object.
    public final handle jObj;

    # The init function of the Ballerina class mapping the `org.everit.json.schema.Schema` Java class.
    #
    # + obj - The `handle` value containing the Java reference of the object.
    public isolated function init(handle obj) {
        self.jObj = obj;
    }

    # The function to retrieve the string representation of the Ballerina class mapping the `org.everit.json.schema.Schema` Java class.
    #
    # + return - The `string` form of the Java object instance.
    isolated function toString() returns string {
        return java:toString(self.jObj) ?: "";
    }

    # The function that maps to the `validate` method of `org.everit.json.schema.Schema`.
    #
    # + arg0 - The `Object` value required to map with the Java method parameter.
    public isolated function validate(Object arg0) {
        org_everit_json_schema_Schema_validate(self.jObj, arg0.jObj);
    }
}

isolated function org_everit_json_schema_Schema_validate(handle receiver, handle arg0) = @java:Method {
    name: "validate",
    'class: "org.everit.json.schema.Schema",
    paramTypes: ["java.lang.Object"]
} external;
