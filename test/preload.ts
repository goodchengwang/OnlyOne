// Runs before every test file: point the onlyone at a throwaway home/data dir so no test can touch a real ~/.onlyone.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const W = mkdtempSync(join(tmpdir(), "onlyone-test-"));
process.env.ONLYONE_HOME = join(W, "home");
process.env.ONLYONE_DATA_DIR = join(W, "data");
process.env.ONLYONE_SYNC = "local";
