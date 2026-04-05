/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { Button, ChannelStore, Forms, GuildStore, Menu, PermissionsBits, SelectedChannelStore, TextInput, useEffect, UserStore, useState, VoiceStateStore } from "@webpack/common";

// Types

interface CommandConfig {
    ban: string;
    unban: string;
    kick: string;
    transfer: string;
    lock: string;
    unlock: string;
    claim: string;
    limit: string;
    rename: string;
}

interface ServerOverride extends Partial<CommandConfig> {
    guildName?: string;
}

interface PermissionOverwriteLike {
    id: string;
    type: number;
    allow: bigint;
    deny: bigint;
}

const COMMAND_LABELS: Record<keyof CommandConfig, string> = {
    ban: "Voice Ban",
    unban: "Voice Unban",
    kick: "Voice Kick",
    transfer: "Voice Transfer",
    lock: "Voice Lock",
    unlock: "Voice Unlock",
    claim: "Voice Claim",
    limit: "Voice Limit",
    rename: "Voice Rename",
};

const DATASTORE_KEY = "VoiceCommands_serverOverrides";

// Server override storage

let serverOverrides: Record<string, ServerOverride> = {};

async function loadOverrides() {
    serverOverrides = await DataStore.get<Record<string, ServerOverride>>(DATASTORE_KEY) ?? {};
}

async function saveOverrides() {
    await DataStore.set(DATASTORE_KEY, serverOverrides);
}

function getCommand(guildId: string, key: keyof CommandConfig): string {
    return serverOverrides[guildId]?.[key] ?? settings.store[`cmd_${key}` as keyof typeof settings.store] as string;
}

// Auto-claim state

let autoClaimTimer: ReturnType<typeof setTimeout> | null = null;
let trackedOwnerId: string | null = null;
let trackedChannelId: string | null = null;

function clearAutoClaimTimer() {
    if (autoClaimTimer) {
        clearTimeout(autoClaimTimer);
        autoClaimTimer = null;
    }
    trackedOwnerId = null;
    trackedChannelId = null;
}

function findChannelOwner(channel: { permissionOverwrites?: Record<string, PermissionOverwriteLike>; } | null | undefined): string | null {
    if (!channel?.permissionOverwrites) return null;
    for (const overwrite of Object.values(channel.permissionOverwrites)) {
        if (overwrite.type === 1 && (overwrite.allow & PermissionsBits.MANAGE_CHANNELS)) {
            return overwrite.id;
        }
    }
    return null;
}

// Helpers

function getMyVoiceChannel(guildId?: string) {
    const myVoiceChannelId = SelectedChannelStore.getVoiceChannelId();
    if (!myVoiceChannelId) return null;

    const voiceChannel = ChannelStore.getChannel(myVoiceChannelId);
    if (!voiceChannel) return null;
    if (guildId && voiceChannel.guild_id !== guildId) return null;

    return voiceChannel;
}

function sendVoiceCommand(channelId: string, command: string, label: string) {
    sendMessage(channelId, { content: command });
    showNotification({
        title: "Voice Commands",
        body: `${label} sent`,
        noPersist: true,
    });
}

// Modals

function TextInputModal({ modalProps, title, placeholder, onSubmit }: {
    modalProps: ModalProps;
    title: string;
    placeholder: string;
    onSubmit: (value: string) => void;
}) {
    const [value, setValue] = useState("");

    const submit = () => {
        const trimmed = value.trim();
        if (trimmed) {
            onSubmit(trimmed);
            modalProps.onClose();
        }
    };

    return (
        <ModalRoot {...modalProps}>
            <ModalHeader>
                <span style={{ color: "var(--header-primary)", fontSize: "20px", fontWeight: 600, flexGrow: 1 }}>
                    {title}
                </span>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <div style={{ padding: "16px 0" }}>
                    <TextInput
                        value={value}
                        onChange={setValue}
                        placeholder={placeholder}
                        autoFocus
                        onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && submit()}
                    />
                </div>
            </ModalContent>
            <ModalFooter>
                <Button onClick={submit}>Confirm</Button>
                <Button onClick={modalProps.onClose} color={Button.Colors.TRANSPARENT} look={Button.Looks.LINK}>
                    Cancel
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

// Settings UI

function ServerOverridesPanel() {
    const [overrides, setOverrides] = useState<Record<string, ServerOverride>>({});
    const [newGuildId, setNewGuildId] = useState("");

    useEffect(() => {
        loadOverrides().then(() => setOverrides({ ...serverOverrides }));
    }, []);

    const save = async (updated: Record<string, ServerOverride>) => {
        serverOverrides = updated;
        await saveOverrides();
        setOverrides({ ...updated });
    };

    const addServer = () => {
        const id = newGuildId.trim();
        if (!id || overrides[id]) return;
        const guild = GuildStore.getGuild(id);
        save({
            ...overrides,
            [id]: { guildName: guild?.name ?? id },
        });
        setNewGuildId("");
    };

    const removeServer = (guildId: string) => {
        const copy = { ...overrides };
        delete copy[guildId];
        save(copy);
    };

    const updateCommand = (guildId: string, key: keyof CommandConfig, value: string) => {
        const copy = { ...overrides };
        copy[guildId] = { ...copy[guildId], [key]: value || undefined };
        save(copy);
    };

    return (
        <div>
            <Forms.FormTitle tag="h3" style={{ marginTop: 16 }}>Per-Server Command Overrides</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 12 }}>
                Override commands for specific servers. Leave a field empty to use the default.
                Right-click a server icon and copy the ID, then paste it below.
            </Forms.FormText>

            {Object.entries(overrides).map(([guildId, override]) => {
                const guild = GuildStore.getGuild(guildId);
                const displayName = guild?.name ?? override.guildName ?? guildId;

                return (
                    <div key={guildId} style={{
                        background: "var(--background-secondary)",
                        borderRadius: 8,
                        padding: 12,
                        marginBottom: 12,
                    }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                            <Forms.FormTitle tag="h4" style={{ margin: 0 }}>
                                {displayName} <span style={{ color: "var(--text-muted)", fontSize: 12 }}>({guildId})</span>
                            </Forms.FormTitle>
                            <Button
                                size={Button.Sizes.SMALL}
                                color={Button.Colors.RED}
                                onClick={() => removeServer(guildId)}
                            >
                                Remove
                            </Button>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            {(Object.keys(COMMAND_LABELS) as (keyof CommandConfig)[]).map(key => (
                                <TextInput
                                    key={key}
                                    value={override[key] ?? ""}
                                    onChange={(v: string) => updateCommand(guildId, key, v)}
                                    placeholder={`${COMMAND_LABELS[key]} (default: ${settings.store[`cmd_${key}` as keyof typeof settings.store]})`}
                                />
                            ))}
                        </div>
                    </div>
                );
            })}

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <TextInput
                    value={newGuildId}
                    onChange={setNewGuildId}
                    placeholder="Server ID"
                    style={{ flex: 1 }}
                />
                <Button onClick={addServer} size={Button.Sizes.SMALL}>
                    Add Server
                </Button>
            </div>
        </div>
    );
}

// Settings definition

const settings = definePluginSettings({
    autoClaim: {
        type: OptionType.BOOLEAN,
        description: "Auto-claim VC when detected owner leaves",
        default: true,
    },
    autoClaimDelay: {
        type: OptionType.SLIDER,
        description: "Auto-claim delay (seconds)",
        default: 60,
        markers: [10, 20, 30, 45, 60, 90, 120],
        stickToMarkers: false,
    },
    cmd_ban: {
        type: OptionType.STRING,
        description: "Ban command",
        default: "!voice-ban",
    },
    cmd_unban: {
        type: OptionType.STRING,
        description: "Unban command",
        default: "!voice-unban",
    },
    cmd_kick: {
        type: OptionType.STRING,
        description: "Kick command",
        default: "!voice-kick",
    },
    cmd_transfer: {
        type: OptionType.STRING,
        description: "Transfer command",
        default: "!voice-transfer",
    },
    cmd_lock: {
        type: OptionType.STRING,
        description: "Lock command",
        default: "!voice-lock",
    },
    cmd_unlock: {
        type: OptionType.STRING,
        description: "Unlock command",
        default: "!voice-unlock",
    },
    cmd_claim: {
        type: OptionType.STRING,
        description: "Claim command",
        default: "!voice-claim",
    },
    cmd_limit: {
        type: OptionType.STRING,
        description: "Limit command",
        default: "!voice-limit",
    },
    cmd_rename: {
        type: OptionType.STRING,
        description: "Rename command",
        default: "!voice-rename",
    },
    serverOverrides: {
        type: OptionType.COMPONENT,
        description: "Per-server command overrides",
        component: ServerOverridesPanel,
    },
});

// User context menu (right-click on a user)

const userContextMenuPatch: NavContextMenuPatchCallback = (children, props: { user?: { id: string; }; guildId?: string; }) => {
    const { user, guildId } = props;
    if (!user || !guildId) return;

    const currentUser = UserStore.getCurrentUser();
    if (!currentUser || user.id === currentUser.id) return;

    const voiceChannel = getMyVoiceChannel(guildId);
    if (!voiceChannel) return;

    const voiceStates = VoiceStateStore.getVoiceStatesForChannel(voiceChannel.id) as Record<string, unknown> | undefined;
    const isInVC = !!voiceStates?.[user.id];

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuGroup id="vc-voice-commands">
            {isInVC && (
                <>
                    <Menu.MenuItem
                        id="vc-voice-ban"
                        label="Voice Ban"
                        color="danger"
                        action={() => sendVoiceCommand(voiceChannel.id, `${getCommand(guildId, "ban")} <@${user.id}>`, "Voice Ban")}
                    />
                    <Menu.MenuItem
                        id="vc-voice-kick"
                        label="Voice Kick"
                        color="danger"
                        action={() => sendVoiceCommand(voiceChannel.id, `${getCommand(guildId, "kick")} <@${user.id}>`, "Voice Kick")}
                    />
                    <Menu.MenuItem
                        id="vc-voice-transfer"
                        label="Voice Transfer"
                        action={() => sendVoiceCommand(voiceChannel.id, `${getCommand(guildId, "transfer")} <@${user.id}>`, "Voice Transfer")}
                    />
                </>
            )}
            <Menu.MenuItem
                id="vc-voice-unban"
                label="Voice Unban"
                action={() => sendVoiceCommand(voiceChannel.id, `${getCommand(guildId, "unban")} <@${user.id}>`, "Voice Unban")}
            />
        </Menu.MenuGroup>
    );
};

// Channel context menu (right-click on your current voice channel)

const channelContextMenuPatch: NavContextMenuPatchCallback = (children, props: { channel?: { id: string; guild_id: string; }; }) => {
    const { channel } = props;
    if (!channel) return;

    const myVoiceChannelId = SelectedChannelStore.getVoiceChannelId();
    if (!myVoiceChannelId || channel.id !== myVoiceChannelId) return;

    const guildId = channel.guild_id;
    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;

    group.push(
        <Menu.MenuSeparator />,
        <Menu.MenuGroup id="vc-voice-channel-commands">
            <Menu.MenuItem
                id="vc-voice-lock"
                label="Voice Lock"
                action={() => sendVoiceCommand(channel.id, getCommand(guildId, "lock"), "Voice Lock")}
            />
            <Menu.MenuItem
                id="vc-voice-unlock"
                label="Voice Unlock"
                action={() => sendVoiceCommand(channel.id, getCommand(guildId, "unlock"), "Voice Unlock")}
            />
            <Menu.MenuItem
                id="vc-voice-claim"
                label="Voice Claim"
                action={() => sendVoiceCommand(channel.id, getCommand(guildId, "claim"), "Voice Claim")}
            />
            <Menu.MenuItem
                id="vc-voice-limit"
                label="Voice Limit..."
                action={() => {
                    openModal(modalProps => (
                        <TextInputModal
                            modalProps={modalProps}
                            title="Voice Limit"
                            placeholder="User limit (e.g. 5)"
                            onSubmit={val => {
                                const num = parseInt(val, 10);
                                if (!isNaN(num) && num > 0) {
                                    sendVoiceCommand(channel.id, `${getCommand(guildId, "limit")} ${num}`, "Voice Limit");
                                }
                            }}
                        />
                    ));
                }}
            />
            <Menu.MenuItem
                id="vc-voice-rename"
                label="Voice Rename..."
                action={() => {
                    openModal(modalProps => (
                        <TextInputModal
                            modalProps={modalProps}
                            title="Voice Rename"
                            placeholder="New channel name"
                            onSubmit={val => sendVoiceCommand(channel.id, `${getCommand(guildId, "rename")} ${val}`, "Voice Rename")}
                        />
                    ));
                }}
            />
        </Menu.MenuGroup>
    );
};

// Keybinds

function onKeyDown(e: KeyboardEvent) {
    if (!e.ctrlKey || !e.shiftKey) return;

    const voiceChannel = getMyVoiceChannel();
    if (!voiceChannel) return;

    switch (e.code) {
        case "KeyL":
            e.preventDefault();
            sendVoiceCommand(voiceChannel.id, getCommand(voiceChannel.guild_id, "lock"), "Voice Lock Toggle");
            break;
    }
}

// Plugin definition

export default definePlugin({
    name: "VoiceCommands",
    description: "Right-click context menus and keybinds for temp VC bot commands with per-server config and auto-claim",
    authors: [EquicordDevs.Matti],

    settings,

    contextMenus: {
        "user-context": userContextMenuPatch,
        "channel-context": channelContextMenuPatch,
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: { userId: string; channelId?: string; oldChannelId?: string; }[]; }) {
            if (!settings.store.autoClaim) return;

            const myId = UserStore.getCurrentUser()?.id;
            if (!myId) return;

            const myVoiceChannelId = SelectedChannelStore.getVoiceChannelId();
            if (!myVoiceChannelId) return;

            const myChannel = ChannelStore.getChannel(myVoiceChannelId);
            if (!myChannel) return;

            const ownerId = findChannelOwner(myChannel);

            for (const state of voiceStates) {
                if (state.userId === myId) continue;

                // Owner left our channel
                if (
                    ownerId &&
                    state.userId === ownerId &&
                    state.oldChannelId === myVoiceChannelId &&
                    state.channelId !== myVoiceChannelId
                ) {
                    clearAutoClaimTimer();
                    trackedOwnerId = ownerId;
                    trackedChannelId = myVoiceChannelId;

                    const delay = (settings.store.autoClaimDelay ?? 60) * 1000;
                    const guildId = myChannel.guild_id;

                    autoClaimTimer = setTimeout(() => {
                        if (trackedChannelId) {
                            sendVoiceCommand(trackedChannelId, getCommand(guildId, "claim"), "Auto-Claim");
                        }
                        clearAutoClaimTimer();
                    }, delay);

                    showNotification({
                        title: "Voice Commands",
                        body: `Owner left - auto-claim in ${settings.store.autoClaimDelay ?? 60}s`,
                        noPersist: true,
                    });
                }

                // Owner came back to our channel
                if (
                    trackedOwnerId &&
                    state.userId === trackedOwnerId &&
                    state.channelId === trackedChannelId
                ) {
                    clearAutoClaimTimer();
                    showNotification({
                        title: "Voice Commands",
                        body: "Owner rejoined - auto-claim cancelled",
                        noPersist: true,
                    });
                }
            }
        },
    },

    async start() {
        await loadOverrides();
        document.addEventListener("keydown", onKeyDown);
    },

    stop() {
        document.removeEventListener("keydown", onKeyDown);
        clearAutoClaimTimer();
    },
});
