import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export const TOKEN_HEADER = "x-pf-token";
export const TOKEN_COOKIE = "pf_token";

/** Origins of the Tauri webview (Windows/Linux and macOS spellings). */
const TAURI_ORIGINS = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];

/** Origins of the Vite dev server, allowed only when explicitly enabled for development. */
export const DEV_ORIGINS = ["http://127.0.0.1:1420", "http://localhost:1420"];

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/**
 * Rejects requests whose Host header is not our own loopback address. This blocks DNS-rebinding
 * attacks, where a malicious website points its own hostname at 127.0.0.1 to reach this server.
 */
export function hostCheck(port: number): RequestHandler {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return (req, res, next) => {
    if (!allowed.has(req.headers.host ?? "")) {
      res.status(403).json({ error: "forbidden_host" });
      return;
    }
    next();
  };
}

/**
 * CORS for the Tauri webview (plus the Vite dev server when `allowDevOrigin` is set); answers
 * preflight requests itself. Any other cross-origin request is refused.
 */
export function cors(allowDevOrigin = false): RequestHandler {
  const allowed = new Set([...TAURI_ORIGINS, ...(allowDevOrigin ? DEV_ORIGINS : [])]);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const sameOrigin = origin === `http://${req.headers.host}`;
      if (!sameOrigin && !allowed.has(origin)) {
        res.status(403).json({ error: "forbidden_origin" });
        return;
      }
      if (!sameOrigin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", `${TOKEN_HEADER}, content-type`);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      }
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Requires the per-launch token (header from the Tauri webview, cookie from the browser tab). */
export function requireToken(token: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const presented = req.get(TOKEN_HEADER) ?? readCookie(req, TOKEN_COOKIE);
    if (!presented || !safeEqual(presented, token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

/**
 * Browser-tab entry point: opening `/?token=...` stores the token in an HttpOnly cookie and
 * redirects to a clean URL, so the token does not stay in the address bar or history.
 */
export function tokenBootstrap(token: string): RequestHandler {
  return (req, res, next) => {
    const presented = typeof req.query["token"] === "string" ? req.query["token"] : undefined;
    if (req.method !== "GET" || req.path !== "/" || !presented) {
      next();
      return;
    }
    if (!safeEqual(presented, token)) {
      res.status(401).send("Invalid token");
      return;
    }
    res.setHeader(
      "Set-Cookie",
      `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
    );
    res.redirect(302, "/");
  };
}
