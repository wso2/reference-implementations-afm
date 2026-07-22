# Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com).
#
# WSO2 LLC. licenses this file to you under the Apache License,
# Version 2.0 (the "License"); you may not use this file except
# in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

from __future__ import annotations

from ..exceptions import InterfaceNotFoundError
from ..models import (
    AFMRecord,
    ConsoleChatInterface,
    Interface,
    InterfaceType,
    PlatformChatInterface,
    PlatformChatMode,
    WebChatInterface,
    WebhookInterface,
)


def get_interfaces(afm: AFMRecord) -> list[Interface]:
    if afm.metadata.interfaces:
        return list(afm.metadata.interfaces)
    # Default to consolechat if no interfaces specified
    return [ConsoleChatInterface()]


def get_interface_by_type(
    afm: AFMRecord,
    interface_type: InterfaceType,
) -> Interface:
    interfaces = get_interfaces(afm)

    for interface in interfaces:
        if interface.type == interface_type.value:
            return interface

    available = [iface.type for iface in interfaces]
    raise InterfaceNotFoundError(interface_type.value, available)


def get_webchat_interface(afm: AFMRecord) -> WebChatInterface:
    interface = get_interface_by_type(afm, InterfaceType.WEB_CHAT)
    assert isinstance(interface, WebChatInterface)
    return interface


def get_webhook_interface(afm: AFMRecord) -> WebhookInterface:
    interface = get_interface_by_type(afm, InterfaceType.WEBHOOK)
    assert isinstance(interface, WebhookInterface)
    return interface


def get_platform_chat_interface(afm: AFMRecord) -> PlatformChatInterface:
    interface = get_interface_by_type(afm, InterfaceType.PLATFORM_CHAT)
    assert isinstance(interface, PlatformChatInterface)
    return interface


def get_http_path(
    interface: WebChatInterface | WebhookInterface | PlatformChatInterface,
) -> str:
    if isinstance(interface, PlatformChatInterface):
        if interface.mode == PlatformChatMode.POLLING:
            raise ValueError(
                f"PlatformChatInterface in polling mode has no inbound "
                f"HTTP path (platform={interface.platform!r})."
            )
        if interface.exposure is None:
            return f"/{interface.platform}"
        return interface.exposure.http.path
    return interface.exposure.http.path
