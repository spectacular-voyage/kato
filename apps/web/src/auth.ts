import type { WebConfig } from "@kato/shared";
import { getCookies, setCookie } from "@std/http/cookie";
import {
  hashWebPassword,
  resolveDefaultWebConfigPath,
  WebConfigFileStore,
} from "../../runtime/src/config/web_config.ts";

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const CSRF_CONTEXT = "csrf-v1";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    decodeBase64(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signSessionPayload(
  payload: string,
  secret: string,
): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return bytesToHex(new Uint8Array(signature));
}

function getSessionCookieValue(
  request: Request,
  config: WebConfig,
): string | undefined {
  return getCookies(request.headers)[config.auth.cookieName];
}

export async function loadWebConfig(): Promise<WebConfig | undefined> {
  const store = new WebConfigFileStore(resolveDefaultWebConfigPath());
  try {
    return await store.load();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
}

export async function loadWebConfigState(): Promise<{
  config?: WebConfig;
  error?: string;
}> {
  const store = new WebConfigFileStore(resolveDefaultWebConfigPath());
  try {
    return { config: await store.load() };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function verifyPassword(
  config: WebConfig,
  username: string,
  password: string,
): Promise<boolean> {
  if (username !== config.auth.username) {
    return false;
  }
  const actual = await hashWebPassword(password, config.auth.passwordSalt);
  return actual === config.auth.passwordHash;
}

export async function createSessionCookieValue(
  config: WebConfig,
): Promise<string> {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = `${expiresAt}`;
  const signature = await signSessionPayload(
    payload,
    config.auth.sessionSecret,
  );
  return `${payload}.${signature}`;
}

export async function isAuthenticatedRequest(
  request: Request,
  config: WebConfig | undefined,
): Promise<boolean> {
  if (!config) {
    return false;
  }
  const cookieValue = getSessionCookieValue(request, config);
  if (!cookieValue) {
    return false;
  }
  const [payload, signature] = cookieValue.split(".", 2);
  if (!payload || !signature) {
    return false;
  }
  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return false;
  }
  const key = await importHmacKey(config.auth.sessionSecret);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    hexToBytes(signature) as BufferSource,
    new TextEncoder().encode(payload),
  );
}

export function isSameOriginRequest(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === url.origin;
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }
  return false;
}

export async function createCsrfToken(
  request: Request,
  config: WebConfig,
): Promise<string | undefined> {
  const sessionCookie = getSessionCookieValue(request, config);
  if (!sessionCookie) {
    return undefined;
  }
  const payload = `${CSRF_CONTEXT}:${sessionCookie}`;
  const signature = await signSessionPayload(
    payload,
    config.auth.sessionSecret,
  );
  return `${payload}.${signature}`;
}

export async function verifyCsrfToken(
  request: Request,
  config: WebConfig,
  token: string | undefined,
): Promise<boolean> {
  if (!token) {
    return false;
  }
  const expected = await createCsrfToken(request, config);
  return expected !== undefined && token === expected;
}

export async function readCsrfTokenFromRequest(
  request: Request,
): Promise<string | undefined> {
  const header = request.headers.get("x-kato-csrf");
  if (header && header.trim().length > 0) {
    return header.trim();
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const clone = request.clone();
    const form = await clone.formData();
    const token = form.get("csrfToken");
    if (typeof token === "string" && token.trim().length > 0) {
      return token.trim();
    }
  }
  return undefined;
}

export async function setSessionCookie(
  headers: Headers,
  config: WebConfig,
): Promise<void> {
  setCookie(headers, {
    name: config.auth.cookieName,
    value: await createSessionCookieValue(config),
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(headers: Headers, config: WebConfig): void {
  setCookie(headers, {
    name: config.auth.cookieName,
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    maxAge: 0,
  });
}
