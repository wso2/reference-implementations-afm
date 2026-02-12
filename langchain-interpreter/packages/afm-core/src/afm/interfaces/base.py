# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

from ..exceptions import InterfaceNotFoundError
from ..models import (
    AFMRecord,
    ConsoleChatInterface,
    Interface,
    InterfaceType,
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


def get_http_path(interface: WebChatInterface | WebhookInterface) -> str:
    if interface.exposure and interface.exposure.http:
        return interface.exposure.http.path

    # Defaults per spec
    if isinstance(interface, WebChatInterface):
        return "/chat"
    return "/webhook"
