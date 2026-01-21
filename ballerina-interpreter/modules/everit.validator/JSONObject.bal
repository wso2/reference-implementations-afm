import ballerina/jballerina.java;

# Ballerina class mapping for the Java `org.json.JSONObject` class.
@java:Binding {'class: "org.json.JSONObject"}
public isolated distinct class JSONObject {

    *java:JObject;
    *Object;

    # The `handle` field that stores the reference to the `org.json.JSONObject` object.
    public final handle jObj;

    # The init function of the Ballerina class mapping the `org.json.JSONObject` Java class.
    #
    # + obj - The `handle` value containing the Java reference of the object.
    public isolated function init(handle obj) {
        self.jObj = obj;
    }

    # The function to retrieve the string representation of the Ballerina class mapping the `org.json.JSONObject` Java class.
    #
    # + return - The `string` form of the Java object instance.
    isolated function toString() returns string {
        return java:toString(self.jObj) ?: "";
    }
}

# The constructor function to generate an object of `org.json.JSONObject`.
#
# + arg0 - The `string` value required to map with the Java constructor parameter.
# + return - The new `JSONObject` class generated.
public isolated function newJSONObject7(string arg0) returns JSONObject {
    handle externalObj = org_json_JSONObject_newJSONObject7(java:fromString(arg0));
    JSONObject newObj = new (externalObj);
    return newObj;
}

isolated function org_json_JSONObject_newJSONObject7(handle arg0) returns handle = @java:Constructor {
    'class: "org.json.JSONObject",
    paramTypes: ["java.lang.String"]
} external;
