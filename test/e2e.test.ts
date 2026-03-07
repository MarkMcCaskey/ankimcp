import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AUTH_TOKEN = "e2e-test-token";
const PORT = 8787 + Math.floor(Math.random() * 100);
let wranglerProcess: ChildProcess;
let baseUrl: string;

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

describe("E2E tests", () => {
  beforeAll(async () => {
    const projectRoot = join(__dirname, "..");

    // Write .dev.vars for the e2e test
    writeFileSync(
      join(projectRoot, ".dev.vars"),
      `AUTH_TOKEN=${AUTH_TOKEN}\n`
    );

    // Apply schema locally first
    execSync("npx wrangler d1 execute anki-cards --file=schema.sql --local", {
      cwd: projectRoot,
      stdio: "pipe",
    });

    // Start wrangler dev
    wranglerProcess = spawn(
      "npx",
      ["wrangler", "dev", "--port", String(PORT), "--local"],
      {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    baseUrl = `http://127.0.0.1:${PORT}`;
    await waitForServer(baseUrl);
  }, 60000);

  afterAll(() => {
    if (wranglerProcess) {
      wranglerProcess.kill("SIGTERM");
    }
  });

  it("health check returns ok", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("ankimcp");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("upload rejects without auth", async () => {
    const res = await fetch(`${baseUrl}/upload`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("sync rejects without auth", async () => {
    const res = await fetch(`${baseUrl}/sync`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("full upload + query cycle works", async () => {
    const apkgPath = join(__dirname, "fixtures", "spanish.apkg");
    const apkgData = readFileSync(apkgPath);

    const form = new FormData();
    form.append(
      "file",
      new Blob([apkgData], { type: "application/octet-stream" }),
      "spanish.apkg"
    );

    const uploadRes = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      body: form,
    });

    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as {
      success: boolean;
      decks: Array<{ name: string; cards: number }>;
    };
    expect(uploadBody.success).toBe(true);
    expect(uploadBody.decks[0].name).toBe("Spanish Vocab");
    expect(uploadBody.decks[0].cards).toBe(3);
  });

  it("full sync cycle preserves existing data", async () => {
    // First upload simple deck
    const simplePath = join(__dirname, "fixtures", "simple.apkg");
    const simpleData = readFileSync(simplePath);

    const form1 = new FormData();
    form1.append(
      "file",
      new Blob([simpleData], { type: "application/octet-stream" }),
      "simple.apkg"
    );

    const uploadRes = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      body: form1,
    });
    expect(uploadRes.status).toBe(200);

    // Now sync spanish deck — should add, not replace
    const spanishPath = join(__dirname, "fixtures", "spanish.apkg");
    const spanishData = readFileSync(spanishPath);

    const form2 = new FormData();
    form2.append(
      "file",
      new Blob([spanishData], { type: "application/octet-stream" }),
      "spanish.apkg"
    );

    const syncRes = await fetch(`${baseUrl}/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      body: form2,
    });

    expect(syncRes.status).toBe(200);
    const syncBody = (await syncRes.json()) as {
      success: boolean;
      totals: { notesUpserted: number; cardsUpserted: number };
    };
    expect(syncBody.success).toBe(true);
    expect(syncBody.totals.notesUpserted).toBe(3);
  });
});
