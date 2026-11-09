// Deploys the server. Migrations run before the new code, so a request never meets a schema
// older than the code expects. Deploying by hand without a "database_id", the database doesn't
// exist before the first deploy: `wrangler deploy` creates it (in the jurisdiction set in
// wrangler.jsonc), then the migrations run. With the Deploy to Cloudflare button the database
// already exists: the button creates it, or you pick one you created (docs/setup.md).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const wrangler = (args, options = {}) => execFileSync("npx", ["wrangler", ...args], { stdio: "inherit", ...options });
const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const name = /"database_name"\s*:\s*"([^"]+)"/.exec(config)?.[1];
if (!name) throw new Error("wrangler.jsonc: d1_databases needs a database_name");

const databases = JSON.parse(execFileSync("npx", ["wrangler", "d1", "list", "--json"], { encoding: "utf8" }));
const exists = Array.isArray(databases) && databases.some((db) => db.name === name);

if (exists) wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
else console.log(`The database "${name}" doesn't exist yet: this deploy creates it.`);
wrangler(["deploy"]);
if (!exists) wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
