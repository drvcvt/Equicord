/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { FormSwitch } from "@components/FormSwitch";
import {
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalProps,
    ModalRoot,
    ModalSize,
    openModal
} from "@utils/modal";
import definePlugin, { IconComponent, OptionType, PluginNative } from "@utils/types";
import { Button, Forms, Text, TextInput, useEffect, useState } from "@webpack/common";

const Native = (IS_DISCORD_DESKTOP || IS_EQUIBOP || IS_VESKTOP)
    ? (globalThis as any).VencordNative?.pluginHelpers?.DiscordPurge as PluginNative<typeof import("./native")>
    : null;

const RELEASES_URL = "https://github.com/drvcvt/discord-purge/releases/latest";

const settings = definePluginSettings({
    daemonPort: {
        type: OptionType.NUMBER,
        description: "Port of the local discord-purge daemon.",
        default: 48654
    },
    defaultDryRun: {
        type: OptionType.BOOLEAN,
        description: "Default the modal to dry-run (safer).",
        default: true
    }
});

function daemonBase(): string {
    const port = settings.store.daemonPort || 48654;
    return `http://127.0.0.1:${port}`;
}

async function pingDaemon(timeoutMs = 700): Promise<boolean> {
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        const res = await fetch(`${daemonBase()}/ping`, { signal: ac.signal });
        clearTimeout(timer);
        return res.ok;
    } catch {
        return false;
    }
}

interface PurgeBody {
    channel_id: string;
    guild_id?: string;
    channel_name?: string;
    dry_run?: boolean;
    match?: string;
    before?: string;
    after?: string;
    type?: string;
}

async function callDaemon(body: PurgeBody): Promise<{ ok: boolean; message: string; }> {
    try {
        const res = await fetch(`${daemonBase()}/purge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({ ok: false, message: "invalid response" }));
        return data;
    } catch (err: any) {
        return {
            ok: false,
            message: `cannot reach daemon at ${daemonBase()} — ${err?.message ?? err}`
        };
    }
}

const PurgeIcon: IconComponent = ({ width = 20, height = 20 }) => (
    <svg
        width={width}
        height={height}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ scale: "1.1" }}
    >
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
);

function SetupModal({ modalProps, onReady }: { modalProps: ModalProps; onReady: () => void; }) {
    const [phase, setPhase] = useState<"idle" | "downloading" | "installing" | "waiting" | "pinging" | "error">("idle");
    const [errMsg, setErrMsg] = useState("");
    const [progress, setProgress] = useState(0);

    async function pollDaemon(maxSeconds = 30): Promise<boolean> {
        const steps = maxSeconds * 2; // 500ms intervals
        for (let i = 0; i < steps; i++) {
            setProgress(Math.round((i / steps) * 100));
            await new Promise(r => setTimeout(r, 500));
            if (await pingDaemon(800)) {
                setProgress(100);
                return true;
            }
        }
        return false;
    }

    async function autoInstall() {
        setErrMsg("");
        setProgress(0);
        if (!Native) {
            setErrMsg("Auto-install requires Discord desktop. Use the manual link below.");
            setPhase("error");
            return;
        }
        setPhase("downloading");
        const dl = await Native.downloadSetup();
        if (!dl.ok || !dl.path) {
            setErrMsg(`Download failed: ${dl.error ?? "unknown"}. Make sure a release exists at ${RELEASES_URL}.`);
            setPhase("error");
            return;
        }
        setPhase("installing");
        const run = await Native.runSilentInstaller(dl.path);
        if (!run.ok) {
            setErrMsg(`Installer failed: ${run.error ?? `exit code ${run.code}`}`);
            setPhase("error");
            return;
        }
        setPhase("waiting");
        // NSIS silent install + VBS-launched daemon: takes a few seconds to be reachable.
        if (await pollDaemon(30)) {
            showNotification({ title: "discord-purge", body: "Daemon installed and running." });
            modalProps.onClose();
            onReady();
            return;
        }
        setErrMsg("Installer completed but daemon isn't responding after 30s. Use 'Retry ping' below, or reboot.");
        setPhase("error");
    }

    async function retryPing() {
        setErrMsg("");
        setProgress(0);
        setPhase("pinging");
        if (await pollDaemon(15)) {
            showNotification({ title: "discord-purge", body: "Daemon detected." });
            modalProps.onClose();
            onReady();
            return;
        }
        setErrMsg("Still no response. Try rebooting, or run '%LOCALAPPDATA%\\discord-purge\\daemon.vbs' manually.");
        setPhase("error");
    }

    const busy = phase === "downloading" || phase === "installing" || phase === "waiting" || phase === "pinging";

    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalHeader>
                <Text variant="heading-lg/semibold">discord-purge setup required</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <Forms.FormText>
                    The background daemon isn't running on <code>{daemonBase()}</code>.
                    Install it once and it'll start automatically with Windows. Terminals
                    only appear during actual delete runs — the daemon itself is invisible.
                </Forms.FormText>

                {phase === "downloading" && <Forms.FormText style={{ marginTop: 12, opacity: 0.7 }}>Downloading installer…</Forms.FormText>}
                {phase === "installing" && <Forms.FormText style={{ marginTop: 12, opacity: 0.7 }}>Running silent install…</Forms.FormText>}
                {phase === "waiting" && (
                    <Forms.FormText style={{ marginTop: 12, opacity: 0.7 }}>
                        Waiting for daemon to come online… {progress}%
                    </Forms.FormText>
                )}
                {phase === "pinging" && (
                    <Forms.FormText style={{ marginTop: 12, opacity: 0.7 }}>
                        Pinging daemon… {progress}%
                    </Forms.FormText>
                )}
                {phase === "error" && (
                    <Forms.FormText style={{ marginTop: 12, color: "var(--text-danger)" }}>
                        {errMsg}
                    </Forms.FormText>
                )}
            </ModalContent>
            <ModalFooter>
                <Button color={Button.Colors.BRAND} onClick={autoInstall} disabled={busy}>
                    {busy ? "Working…" : phase === "error" ? "Retry install" : "Install automatically"}
                </Button>
                {phase === "error" && (
                    <Button color={Button.Colors.PRIMARY} onClick={retryPing} disabled={busy}>
                        Retry ping
                    </Button>
                )}
                <Button
                    look={Button.Looks.LINK}
                    color={Button.Colors.PRIMARY}
                    onClick={() => window.open(RELEASES_URL, "_blank")}
                >
                    Download manually
                </Button>
                <Button
                    look={Button.Looks.LINK}
                    color={Button.Colors.PRIMARY}
                    onClick={modalProps.onClose}
                    disabled={busy}
                >
                    Dismiss
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

function PurgeModal({ modalProps, channel }: { modalProps: ModalProps; channel: any; }) {
    const [dryRun, setDryRun] = useState(!!settings.store.defaultDryRun);
    const [match, setMatch] = useState("");
    const [before, setBefore] = useState("");
    const [after, setAfter] = useState("");
    const [type, setType] = useState("all");
    const [busy, setBusy] = useState(false);

    const channelName: string = channel?.name || (channel?.recipients?.length ? "DM" : String(channel?.id ?? "unknown"));
    const guildID: string | undefined = channel?.guild_id || undefined;

    async function submit() {
        setBusy(true);
        const body: PurgeBody = {
            channel_id: channel.id,
            guild_id: guildID,
            channel_name: channelName,
            dry_run: dryRun,
            match,
            before,
            after,
            type
        };
        const res = await callDaemon(body);
        setBusy(false);
        if (res.ok) {
            showNotification({
                title: "discord-purge",
                body: `${dryRun ? "Dry-run" : "Delete"} started for #${channelName}`
            });
            modalProps.onClose();
        } else {
            showNotification({ title: "discord-purge — error", body: res.message });
        }
    }

    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalHeader>
                <Text variant="heading-lg/semibold">
                    Purge {guildID ? `#${channelName}` : `DM (${channelName})`}
                </Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <div style={{ marginBottom: 12 }}>
                    <FormSwitch
                        title="Dry run"
                        description="Preview only — don't actually delete."
                        value={dryRun}
                        onChange={setDryRun}
                    />
                </div>
                <div style={{ marginBottom: 12 }}>
                    <Forms.FormTitle>Keyword / regex</Forms.FormTitle>
                    <TextInput value={match} onChange={setMatch} placeholder={"e.g. screenshot  or  regex:^gg$"} />
                </div>
                <div style={{ marginBottom: 12 }}>
                    <Forms.FormTitle>Before</Forms.FormTitle>
                    <TextInput value={before} onChange={setBefore} placeholder="YYYY-MM-DD or 30d / 2w / 6m / 1y" />
                </div>
                <div style={{ marginBottom: 12 }}>
                    <Forms.FormTitle>After</Forms.FormTitle>
                    <TextInput value={after} onChange={setAfter} placeholder="YYYY-MM-DD or 7d" />
                </div>
                <div style={{ marginBottom: 12 }}>
                    <Forms.FormTitle>Type</Forms.FormTitle>
                    <select
                        value={type}
                        onChange={e => setType(e.currentTarget.value)}
                        style={{
                            width: "100%",
                            padding: "8px",
                            background: "var(--input-background)",
                            color: "var(--text-normal)",
                            border: "1px solid var(--background-tertiary)",
                            borderRadius: 4
                        }}
                    >
                        <option value="all">all</option>
                        <option value="attachments">attachments</option>
                        <option value="links">links</option>
                        <option value="embeds">embeds</option>
                        <option value="text">text</option>
                    </select>
                </div>
                <Forms.FormText style={{ marginTop: 12, opacity: 0.65 }}>
                    Channel ID: <code>{channel.id}</code>
                    {guildID ? <> · Guild: <code>{guildID}</code></> : <> · DM</>}
                </Forms.FormText>
            </ModalContent>

            <ModalFooter>
                <Button color={dryRun ? Button.Colors.BRAND : Button.Colors.RED} onClick={submit} disabled={busy}>
                    {busy ? "Starting…" : dryRun ? "Start dry-run" : "Delete messages"}
                </Button>
                <Button look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={modalProps.onClose} disabled={busy}>
                    Cancel
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

let daemonOk = false;
async function refreshDaemonStatus() {
    daemonOk = await pingDaemon();
}

function handleClick(channel: any) {
    if (daemonOk) {
        openModal(props => <PurgeModal modalProps={props} channel={channel} />);
        return;
    }
    // Re-check in case the daemon just came up, then decide.
    pingDaemon().then(ok => {
        daemonOk = ok;
        if (ok) {
            openModal(props => <PurgeModal modalProps={props} channel={channel} />);
        } else {
            openModal(props => (
                <SetupModal
                    modalProps={props}
                    onReady={() => openModal(p => <PurgeModal modalProps={p} channel={channel} />)}
                />
            ));
        }
    });
}

const PurgeChatBarButton: ChatBarButtonFactory = ({ channel, type }) => {
    const validChat = ["normal", "sidebar"].some(x => type.analyticsName === x);
    if (!validChat || !channel) return null;

    // Passive refresh so the next click has a fresh answer.
    useEffect(() => { refreshDaemonStatus(); }, [channel?.id]);

    return (
        <ChatBarButton
            tooltip={daemonOk ? "Purge this channel" : "Purge this channel (daemon offline — click to install)"}
            onClick={() => handleClick(channel)}
        >
            <PurgeIcon />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "DiscordPurge",
    description: "Adds a purge button to every channel. Talks to the local discord-purge daemon to spawn a TUI window for the current channel.",
    authors: [{ name: "dracut", id: 382979773460119572n }],
    settings,

    chatBarButton: {
        icon: PurgeIcon,
        render: PurgeChatBarButton
    },

    async start() {
        daemonOk = await pingDaemon();
    }
});
