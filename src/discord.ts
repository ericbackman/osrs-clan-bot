// Discord interaction verification, REST helpers, and shared constants.
// Mirrors picks-worker/src/discord.ts: WebCrypto Ed25519, zero npm deps.

export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string; // secret: wrangler secret put DISCORD_TOKEN
  DISCORD_APPLICATION_ID: string; // var
  DISCORD_PUBLIC_KEY: string; // var
  GUILD_ID: string; // var — single-server bot
  SEED_PLAYERS?: string; // var — declarative roster, reconciled into D1 (see store.ts)
  ANTHROPIC_API_KEY?: string; // secret, phase 3 (/ask)
}

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

export const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
} as const;

export const EPHEMERAL = 64; // message flag: only the invoking user sees it
export const EMBED_COLOR = 0x21c065; // groovy green — consistent across Eric's bots

const DISCORD_API = "https://discord.com/api/v10";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Verify an incoming interaction really came from Discord. Discord signs every
 * request with Ed25519 over (timestamp + raw body); we verify against our app's
 * public key. A failed/missing signature must be rejected with HTTP 401.
 */
export async function verifyDiscordRequest(
  publicKeyHex: string,
  signature: string | null,
  timestamp: string | null,
  body: string,
): Promise<boolean> {
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

async function rest(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Replace the deferred ("thinking…") message once slow work completes. */
export async function editOriginalResponse(
  env: Env,
  interactionToken: string,
  payload: object,
): Promise<void> {
  await rest(
    env,
    "PATCH",
    `/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`,
    payload,
  );
}

/** Post a standalone message to a channel (used by the daily cron auto-post). */
export async function postToChannel(
  env: Env,
  channelId: string,
  payload: object,
): Promise<void> {
  await rest(env, "POST", `/channels/${channelId}/messages`, payload);
}

// ── interaction field helpers (interaction shape is loosely typed `any`, as in
//    picks-worker — the payloads are large and we only read a few fields) ──────

export function displayName(interaction: any): string {
  const member = interaction.member ?? {};
  const user = member.user ?? interaction.user ?? {};
  return member.nick ?? user.global_name ?? user.username ?? "someone";
}

export function userId(interaction: any): string {
  return String(interaction.member?.user?.id ?? interaction.user?.id ?? "0");
}

export function option(interaction: any, name: string): any {
  return interaction.data?.options?.find((o: any) => o.name === name)?.value;
}

export function subcommand(interaction: any): string | undefined {
  const opt = interaction.data?.options?.[0];
  return opt?.type === 1 ? opt.name : undefined; // type 1 = SUB_COMMAND
}

export function subOption(interaction: any, name: string): any {
  const sub = interaction.data?.options?.[0];
  return sub?.options?.find((o: any) => o.name === name)?.value;
}
