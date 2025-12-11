// Copyright (c) 2024, WSO2 LLC. (https://www.wso2.com).
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

import ballerina/ai;
import ballerina/http;
import ballerina/log;
import ballerina/websub;

function attachWebhookService(websub:Listener websubListener, ai:Agent agent, WebhookInterface webhookInterface, 
                              HTTPExposure httpExposure) returns error? {
    Subscription subscription = webhookInterface.subscription;
    log:printInfo(string `Webhook subscription configured: ${subscription.protocol} protocol`);

    // Doesn't work due to a bug.
    // Subscription {hub, topic, callback, secret, authentication} = subscription;

    // Can't specify inline due to a bug.
    http:ClientAuthConfig? auth = check mapToHttpClientAuth(subscription.authentication);

    websub:SubscriberService webhookService =
        @websub:SubscriberServiceConfig {
            target: [subscription.hub, subscription.topic],
            secret: subscription.secret,
            httpConfig: {
                auth
            },
            callback: subscription.callback
        }
        isolated service object {
            remote function onEventNotification(readonly & websub:ContentDistributionMessage msg)
                    returns websub:Acknowledgement|error {
                // TODO: revisit the result handling
                json result = check runAgent(agent, msg.content.toJson());
                log:printInfo("Webhook payload handled: " + result.toJsonString());
                return websub:ACKNOWLEDGEMENT;
            }
        };

    return websubListener.attach(webhookService, httpExposure.path);
}
