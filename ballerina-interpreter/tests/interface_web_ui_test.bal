// Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com).
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

import ballerina/test;

type InputOutput record {
    string input;
    string expected;
};

function escapeHtmlDataProvider() returns InputOutput[][] =>
    [
        [{input: "A & B", expected: "A &amp; B"}],
        [{input: "5 < 10", expected: "5 &lt; 10"}],
        [{input: "10 > 5", expected: "10 &gt; 5"}],
        [{input: "Say \"hello\"", expected: "Say &quot;hello&quot;"}],
        [{input: "It's a test", expected: "It&#x27;s a test"}],
        [{input: "<script>alert('XSS & \"injection\"')</script>", expected: "&lt;script&gt;alert(&#x27;XSS &amp; &quot;injection&quot;&#x27;)&lt;/script&gt;"}],
        [{input: "", expected: ""}],
        [{input: "Hello World 123", expected: "Hello World 123"}],
        [{input: "&<>\"'", expected: "&amp;&lt;&gt;&quot;&#x27;"}],
        [{input: "&&<<>>", expected: "&amp;&amp;&lt;&lt;&gt;&gt;"}],
        [{input: "Hello 世界 & <tag>", expected: "Hello 世界 &amp; &lt;tag&gt;"}]
    ];

@test:Config { dataProvider: escapeHtmlDataProvider }
function testEscapeHtml(InputOutput tc) {
    string result = escapeHtml(tc.input);
    test:assertEquals(result, tc.expected);
}

function escapeForJavaScriptDataProvider() returns InputOutput[][] =>
    [
        [{input: "C:\\path\\to\\file", expected: "C:\\\\path\\\\to\\\\file"}],
        [{input: "It's a test", expected: "It\\'s a test"}],
        [{input: "Say \"hello\"", expected: "Say \\\"hello\\\""}],
        [{input: "Line1\nLine2", expected: "Line1\\nLine2"}],
        [{input: "Line1\rLine2", expected: "Line1\\rLine2"}],
        [{input: "<script>", expected: "\\x3cscript\\x3e"}],
        [{input: "</script>", expected: "\\x3c/script\\x3e"}],
        [{input: "alert('XSS')\n<script>", expected: "alert(\\'XSS\\')\\n\\x3cscript\\x3e"}],
        [{input: "", expected: ""}],
        [{input: "Hello World 123", expected: "Hello World 123"}],
        [{input: "\\'\"\n\r<>", expected: "\\\\\\'\\\"\\n\\r\\x3c\\x3e"}],
        [{input: "C:\\Users\\John\\Documents\\file.txt", expected: "C:\\\\Users\\\\John\\\\Documents\\\\file.txt"}],
        [{input: "{\"key\": \"value\"}", expected: "{\\\"key\\\": \\\"value\\\"}"}],
        [{input: "<script>alert('XSS')</script>", expected: "\\x3cscript\\x3ealert(\\'XSS\\')\\x3c/script\\x3e"}],
        [{input: "Hello 世界\n<tag>", expected: "Hello 世界\\n\\x3ctag\\x3e"}]
    ];

@test:Config { dataProvider: escapeForJavaScriptDataProvider }
function testEscapeForJavaScript(InputOutput tc) {
    string result = escapeForJavaScript(tc.input);
    test:assertEquals(result, tc.expected);
}
