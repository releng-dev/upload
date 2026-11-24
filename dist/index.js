// --- shared: identical in every action, checked by test/actions.test.mjs ---
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const env = process.env;

class Fail extends Error {}
const fail = (message) => {
  throw new Fail(message);
};
const escapeCommand = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

// GitHub passes input "keep-days" as INPUT_KEEP-DAYS: upper-cased, dashes kept.
const input = (name, fallback = "") => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim() || fallback;

const setOutput = (name, value) => {
  const text = String(value);
  if (!env.GITHUB_OUTPUT) {
    console.log(`output ${name}=${text}`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
};

// Hosted Releng.dev. A team that runs its own server names it with RELENG_URL or the server input.
const HOSTED_URL = "https://api.releng.dev";

const serverUrl = () => (env.RELENG_URL || input("server") || HOSTED_URL).replace(/\/+$/, "");

// The job's OIDC token, audience "releng". Never printed; masked in the log.
const getToken = async () => {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    fail("This job can't get an OIDC token. Add `permissions: id-token: write` to the job (or the workflow).");
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", "releng");
  const res = await fetch(url, { headers: { authorization: `Bearer ${requestToken}` } });
  if (!res.ok) fail(`GitHub would not give an OIDC token (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const { value } = await res.json();
  if (!value) fail("GitHub answered the OIDC request without a token.");
  console.log(`::add-mask::${value}`);
  return value;
};

// Calls Releng.dev's runner API. Fails on any status not in `allow`.
const call = async (method, path, { json, body, query, allow = [] } = {}) => {
  const base = serverUrl();
  const token = await getToken();
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v) url.searchParams.set(k, v);
  const headers = { authorization: `Bearer ${token}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(url, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  } catch (e) {
    fail(`Could not reach Releng.dev at ${base}: ${e.cause?.message ?? e.message}`);
  }
  if (res.ok || allow.includes(res.status)) return res;
  const text = (await res.text()).slice(0, 500);
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = parsed.error ?? parsed.message ?? text;
  } catch {}
  fail(`Releng.dev answered ${res.status} on ${method} ${path}: ${message || res.statusText}`);
};

const run = (main) =>
  main().catch((e) => {
    console.log(`::error::${escapeCommand(e instanceof Fail ? e.message : `Unexpected failure: ${e.stack ?? e}`)}`);
    process.exit(1);
  });
// --- end shared ---

import { createHash } from "node:crypto";
import { createReadStream, existsSync, openAsBlob, readFileSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const sha256Of = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

const isDir = (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

// A path, a directory (everything under it) or a glob; several may be separated by new lines.
const expand = async (patterns) => {
  const found = new Set();
  for (const pattern of patterns) {
    const matches = [];
    for await (const match of glob(isDir(pattern) ? `${pattern.replace(/\/+$/, "")}/**` : pattern)) matches.push(match);
    for (const match of matches) if (statSync(match).isFile()) found.add(match);
  }
  return [...found].sort();
};

const defaultVersion = () => {
  try {
    if (existsSync("package.json")) {
      const { version } = JSON.parse(readFileSync("package.json", "utf8"));
      if (typeof version === "string" && version) return version;
    }
  } catch {}
  return (env.GITHUB_SHA ?? "").slice(0, 7) || fail("No version: pass `version`, add one to package.json, or run in GitHub Actions.");
};

// Hosted Releng.dev keeps builds on R2: it gives a link to PUT each file it doesn't have yet, then
// keeps the build by each file's sha256. A server of the team's own takes them in one multipart
// POST instead; it answers 404 to the links, without the hosted header.
const HOSTED = "x-releng-hosted";

const putFile = async (file, url) => {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: "PUT", body: await openAsBlob(file) });
    } catch (e) {
      if (attempt < 3) continue;
      fail(`Could not upload ${file}: ${e.cause?.message ?? e.message}`);
    }
    if (res.ok) return;
    if (res.status >= 500 && attempt < 3) continue;
    fail(`Uploading ${file} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
};

// A few at once: R2 takes many uploads in parallel, and a runner has bandwidth to spare.
const each = async (items, n, fn) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
};

run(async () => {
  const patterns = input("files")
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (patterns.length === 0) fail("`files` is empty. Say which files to keep.");
  const files = await expand(patterns);
  if (files.length === 0) fail(`No files match ${patterns.join(", ")} (looked from ${process.cwd()}).`);

  const fields = {
    version: input("version") || defaultVersion(),
    platform: input("platform"),
    "keep-days": input("keep-days", "90"),
    "shared-with": input("shared-with"),
    role: input("role"),
    preview: input("preview", "false"),
    job: env.GITHUB_JOB ?? "",
  };
  if (fields.role && fields.role !== "sbom") fail(`\`role\` is sbom or left out, not "${fields.role}".`);

  const local = new Map();
  const sent = [];
  for (const file of files) {
    const name = relative(process.cwd(), file).split(sep).join("/");
    if (name.startsWith("..") || isAbsolute(name)) fail(`${file} is outside the workspace. Releng.dev keeps files by their path in the workspace.`);
    const sha256 = await sha256Of(file);
    local.set(name, sha256);
    sent.push({ file, name, sha256, size: statSync(file).size });
  }

  console.log(`Keeping ${files.length} file${files.length === 1 ? "" : "s"} as version ${fields.version}.`);
  const listed = sent.map(({ name, sha256, size }) => ({ name, sha256, size }));
  const links = await call("POST", "/runner/v1/uploads", { json: { ...fields, files: listed }, allow: [404] });
  let res;
  if (links.status === 404 && !links.headers.has(HOSTED)) {
    // A server of the team's own: the files go in the request.
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v || k === "preview" || k === "job" || k === "keep-days") form.append(k, v);
    for (const f of sent) form.append("file", await openAsBlob(f.file), f.name);
    res = await call("POST", "/runner/v1/builds", { body: form });
  } else {
    if (!links.ok) {
      const { error } = await links.json().catch(() => ({}));
      fail(`Releng.dev answered ${links.status} on POST /runner/v1/uploads: ${error ?? links.statusText}`);
    }
    const given = (await links.json()).files ?? [];
    const todo = given.filter((g) => g.url);
    if (todo.length < sent.length) console.log(`${sent.length - todo.length} of them Releng.dev already keeps.`);
    await each(todo, 4, async (g) => {
      const f = sent.find((x) => x.name === g.name && x.sha256 === g.sha256);
      if (!f) fail(`Releng.dev gave a link for ${g.name}, which wasn't sent.`);
      await putFile(f.file, g.url);
    });
    const files = sent.map(({ name, sha256, size }) => ({ name, sha256, size, upload: given.find((g) => g.name === name)?.upload }));
    res = await call("POST", "/runner/v1/builds", { json: { ...fields, files } });
  }
  const answer = await res.json();

  const lines = [];
  for (const f of answer.files ?? []) {
    const mine = local.get(f.name);
    if (mine && mine !== f.sha256) fail(`Releng.dev stored ${f.name} with sha256 ${f.sha256}, but it was sent as ${mine}.`);
    lines.push(`${f.sha256}  ${f.name}`);
  }
  if (lines.length !== local.size) fail(`Sent ${local.size} files, Releng.dev kept ${lines.length}.`);

  console.log(`Kept build ${answer.build} of ${answer.version}:`);
  for (const line of lines) console.log(`  ${line}`);
  setOutput("version", answer.version);
  setOutput("build", answer.build);
  setOutput("checksums", lines.join("\n"));
});
