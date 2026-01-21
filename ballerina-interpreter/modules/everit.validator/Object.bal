import ballerina/jballerina.java;

# Ballerina class mapping for the Java `java.lang.Object` class.
@java:Binding {'class: "java.lang.Object"}
public isolated distinct class Object {

    *java:JObject;

    # The `handle` field that stores the reference to the `java.lang.Object` object.
    public final handle jObj;

    # The init function of the Ballerina class mapping the `java.lang.Object` Java class.
    #
    # + obj - The `handle` value containing the Java reference of the object.
    public isolated function init(handle obj) {
        self.jObj = obj;
    }

    # The function to retrieve the string representation of the Ballerina class mapping the `java.lang.Object` Java class.
    #
    # + return - The `string` form of the Java object instance.
    isolated function toString() returns string {
        return java:toString(self.jObj) ?: "";
    }
}
